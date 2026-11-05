// GitHub integration for the demo server — a reference implementation of the backend that
// <comenta-settings> and the GitHub sync expect. Plain Node, no dependencies besides dist/github.js.
//
// Env:
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET   OAuth App (https://github.com/settings/developers);
//                                             callback URL: {PUBLIC_URL}/api/github/auth/callback
//   PUBLIC_URL                                 site origin for the callback (default: from the Host header)
//   COMENTA_GITHUB_PAT=0|1                     accept a personal access token (default 1 unless NODE_ENV=production)
//   COMENTA_GITHUB_OWNERS=login1,login2        who may connect (default: the first one to connect owns it)
//   GITHUB_API_URL / GITHUB_WEB_URL            GitHub Enterprise or the mock (see github-mock.mjs)
//   GITHUB_STORE                               where tokens and settings are kept (default demo/github.json, mode 600)
//
// Model: one site owner connects GitHub per space (site). The token stays here; the browser only
// gets an HttpOnly session cookie. Guests' comments become issues under the owner's token.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitHubClient,
  GitHubError,
  authorizeUrl,
  checkRepo,
  exchangeCode,
  getAccount,
  listProjects,
  listRepos,
  revokeGrant,
  syncComment,
  DEFAULT_SCOPES,
} from '../dist/github.js';

const SESSION_COOKIE = 'comenta_sid';
const STATE_COOKIE = 'comenta_oauth';
const REQUIRED = { project: 'project', repo: 'repo' };

export function createGitHubIntegration({ root, persistComments, findComment, uploadsDir, log = console.log }) {
  const env = process.env;
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  const webUrl = env.GITHUB_WEB_URL ?? 'https://github.com';
  const clientId = env.GITHUB_CLIENT_ID ?? '';
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? '';
  const oauth = !!(clientId && clientSecret);
  const patAllowed = env.COMENTA_GITHUB_PAT ? env.COMENTA_GITHUB_PAT !== '0' : env.NODE_ENV !== 'production';
  const owners = (env.COMENTA_GITHUB_OWNERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const storeFile = env.GITHUB_STORE ?? join(root, 'demo', 'github.json');
  // retry queue: first retry after backoffMs, then doubling up to 30×
  const backoffMs = Number(env.COMENTA_GITHUB_BACKOFF_MS ?? 60_000);

  /** { spaces: { [space]: Integration }, sessions: { [sid]: { space, login, at } } } */
  let db = { spaces: {}, sessions: {} };
  try {
    db = { spaces: {}, sessions: {}, ...JSON.parse(readFileSync(storeFile, 'utf8')) };
  } catch {
    /* first run */
  }
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(() => writeFile(storeFile, JSON.stringify(db, null, 2), { mode: 0o600 })).catch((e) => console.error(e));
  };

  const oauthStates = new Map(); // state → { space, back, at }
  const repoCache = new Map(); // space → { at, items }
  const inflight = new Map(); // `${space}:${id}` → Promise
  const client = (integ) => new GitHubClient({ token: integ.token, apiUrl, retries: 3, retryDelayMs: Number(env.COMENTA_GITHUB_RETRY_MS ?? 500) });

  // ------------------------------------------------------------------ helpers

  const json = (res, status, data, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(data));
  const STATUS = { unauthorized: 401, forbidden: 403, not_found: 404, rate_limited: 429, validation: 422, issues_disabled: 409, not_configured: 409, network: 502 };
  const fail = (res, err) => {
    const e = err instanceof GitHubError ? err : new GitHubError('network', 'Внутренняя ошибка сервера.');
    if (!(err instanceof GitHubError)) console.error(err);
    json(res, STATUS[e.code] ?? 500, { error: e.toJSON() });
  };
  const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const cookie = (name, value, { maxAge, path = '/' } = {}) =>
    `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}${env.PUBLIC_URL?.startsWith('https:') ? '; Secure' : ''}`;
  const origin = (req) => env.PUBLIC_URL?.replace(/\/$/, '') ?? `http://${req.headers.host}`;
  const readJson = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return {};
    }
  };
  /** Cookie-authenticated writes: refuse cross-site requests. */
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    return !o || o === origin(req) || o === `http://${req.headers.host}`;
  };
  const safeBack = (back) => (typeof back === 'string' && back.startsWith('/') && !back.startsWith('//') ? back : '/demo/settings.html');
  const withParam = (path, key, value) => `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;

  const session = (req, space) => {
    const sid = cookies(req)[SESSION_COOKIE];
    const s = sid && db.sessions[sid];
    if (!s || s.space !== space) return null;
    const integ = db.spaces[space];
    if (!integ?.account || integ.account.login !== s.login) return null;
    return { sid, ...s, integ };
  };
  const newSession = (space, login) => {
    const sid = randomBytes(24).toString('base64url');
    db.sessions[sid] = { space, login, at: new Date().toISOString() };
    return sid;
  };
  const dropSessions = (space) => {
    for (const [sid, s] of Object.entries(db.sessions)) if (s.space === space) delete db.sessions[sid];
  };
  const missingScopes = (integ) => {
    if (integ.tokenType === 'pat' && !integ.scopes?.length) return []; // fine-grained tokens have no scopes
    const have = new Set(integ.scopes ?? []);
    return Object.values(REQUIRED).filter((s) => !have.has(s));
  };

  function status(space, req) {
    const integ = db.spaces[space];
    const base = { oauth, pat: patAllowed };
    const s = session(req, space);
    if (!integ?.token || !s) {
      const out = { ...base, connected: false };
      if (s && integ?.expired) out.reason = 'expired';
      if (integ?.token && !s) out.owner = integ.account?.login;
      return out;
    }
    if (integ.expired) return { ...base, connected: false, reason: 'expired' };
    const pending = Object.keys(integ.pending ?? {}).length;
    return {
      ...base,
      connected: true,
      account: integ.account,
      config: integ.config ?? null,
      missingScopes: missingScopes(integ),
      sync: { pending, ...(integ.lastError ? { lastError: integ.lastError } : {}) },
    };
  }

  /** Re-check the token now and then: a revoked token shows "sign in again" in the settings. */
  async function verify(integ) {
    if (!integ?.token || integ.expired || Date.now() - (integ.checkedAt ?? 0) < 60_000) return;
    try {
      const acc = await getAccount(client(integ));
      integ.account = { login: acc.login, name: acc.name, avatarUrl: acc.avatarUrl, htmlUrl: acc.htmlUrl };
      if (acc.scopes.length || integ.tokenType === 'oauth') integ.scopes = acc.scopes;
      integ.checkedAt = Date.now();
    } catch (err) {
      if (err instanceof GitHubError && err.code === 'unauthorized') markExpired(integ);
    }
  }
  function markExpired(integ) {
    if (integ.expired) return;
    integ.expired = true;
    log(`[github] токен ${integ.account?.login ?? '?'} больше не действует — нужен повторный вход`);
    save();
  }

  /** Store a fresh token for the space (OAuth callback or PAT). */
  async function connect(space, token, tokenType, scopesFromExchange) {
    const integ0 = { token, tokenType };
    const acc = await getAccount(client(integ0));
    const login = acc.login.toLowerCase();
    if (owners.length && !owners.includes(login)) throw new GitHubError('forbidden', `Аккаунт @${acc.login} не может настраивать интеграцию на этом сайте.`);
    const prev = db.spaces[space];
    if (prev?.token && !prev.expired && prev.account && prev.account.login.toLowerCase() !== login) {
      throw new GitHubError('forbidden', `Интеграцию уже подключил @${prev.account.login}. Сначала он должен выйти.`);
    }
    const sameOwner = prev?.account?.login?.toLowerCase() === login;
    db.spaces[space] = {
      token,
      tokenType,
      scopes: scopesFromExchange?.length ? scopesFromExchange : acc.scopes,
      account: { login: acc.login, name: acc.name, avatarUrl: acc.avatarUrl, htmlUrl: acc.htmlUrl },
      checkedAt: Date.now(),
      // the same person signing in again keeps the chosen repository and queued comments
      config: sameOwner ? prev.config : undefined,
      pending: sameOwner ? prev.pending ?? {} : {},
    };
    repoCache.delete(space);
    save();
    log(`[github] подключён @${acc.login} (${tokenType}) в пространстве ${space}`);
    void drain(space, true);
    return acc.login;
  }

  // ------------------------------------------------------------------ sync

  /**
   * Turn a stored comment into an issue. Waits up to `waitMs`; if GitHub is slow the work goes on
   * in the background and the link shows up in the thread on the next refresh.
   */
  async function onComment(space, payload, files, waitMs = 8000) {
    if (payload.issue) return payload.issue;
    const integ = db.spaces[space];
    if (!integ?.config || integ.disconnected) return null;
    if (!integ.token || integ.expired) {
      queue(integ, payload.id, null);
      return null;
    }
    const p = syncOne(space, payload, files);
    const timeout = new Promise((r) => setTimeout(() => r(null), waitMs));
    return Promise.race([p, timeout]);
  }

  function queue(integ, id, err) {
    integ.pending ??= {};
    const prev = integ.pending[id] ?? { attempts: 0 };
    const attempts = prev.attempts + 1;
    let nextAt = Date.now() + Math.min(30, 2 ** (attempts - 1)) * backoffMs;
    if (err?.code === 'rate_limited' && err.resetAt) nextAt = Math.max(nextAt, err.resetAt);
    // permission / config problems wait for the owner (re-login, new settings)
    if (err && !err.retryable) nextAt = Number.MAX_SAFE_INTEGER;
    integ.pending[id] = { attempts, nextAt, ...(err ? { error: err.message } : {}) };
    save();
  }

  async function syncOne(space, payload, files) {
    const key = `${space}:${payload.id}`;
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      const integ = db.spaces[space];
      if (!integ?.config || !integ.token || integ.expired || payload.issue) return payload.issue ?? null;
      const attempts = integ.pending?.[payload.id]?.attempts ?? 0;
      const { repo, project } = integ.config;
      try {
        const res = await syncComment(
          client(integ),
          { owner: repo.owner, repo: repo.name, projectId: project?.id },
          payload,
          files ?? (await filesFromDisk(payload)),
          { checkExisting: attempts > 0 },
        );
        payload.issue = { provider: 'github', repo: res.repo, number: res.number, url: res.url, nodeId: res.nodeId, ...(res.projectId ? { projectId: res.projectId } : {}) };
        persistComments();
        if (integ.pending) delete integ.pending[payload.id];
        integ.lastError = res.projectError ? { code: 'project', message: `Issue создан, но не добавлен в проект: ${res.projectError}`, at: new Date().toISOString() } : undefined;
        save();
        log(`[github] ${payload.id.slice(0, 8)} → ${res.url}${res.existed ? ' (уже был)' : ''}${res.projectError ? ` (проект: ${res.projectError})` : ''}`);
        return payload.issue;
      } catch (err) {
        const e = err instanceof GitHubError ? err : new GitHubError('network', String(err?.message ?? err));
        if (e.code === 'unauthorized') markExpired(integ);
        integ.lastError = { code: e.code, message: e.message, at: new Date().toISOString() };
        queue(integ, payload.id, e);
        log(`[github] ${payload.id.slice(0, 8)}: ${e.code} — ${e.message} (повторим позже)`);
        return null;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  /** Recordings of a comment were saved by the feedback route; read them back for a retry. */
  async function filesFromDisk(payload) {
    const out = [];
    for (const a of payload.attachments ?? []) {
      if (!a.url?.startsWith('/uploads/')) continue;
      try {
        out.push({ attachment: a, data: new Uint8Array(await readFile(join(uploadsDir, a.url.slice('/uploads/'.length)))) });
      } catch {
        /* file gone: the issue lists it as "not uploaded" */
      }
    }
    return out;
  }

  /** Retry queued comments of a space (`force`: ignore backoff, e.g. after re-login or new settings). */
  async function drain(space, force = false) {
    const integ = db.spaces[space];
    if (!integ?.pending || !integ.config || !integ.token || integ.expired) return;
    for (const [id, p] of Object.entries(integ.pending)) {
      if (!force && p.nextAt > Date.now()) continue;
      const payload = findComment(space, id);
      if (!payload || payload.issue) {
        delete integ.pending[id];
        continue;
      }
      await syncOne(space, payload);
      if (db.spaces[space]?.expired) break;
    }
    save();
  }
  const timer = setInterval(() => {
    for (const space of Object.keys(db.spaces)) void drain(space);
  }, Number(env.COMENTA_GITHUB_DRAIN_MS ?? 30_000));
  timer.unref?.();

  // ------------------------------------------------------------------ routes

  /** Handles /api/github/*. Returns true when the request was handled. */
  async function handle(req, res, url, space) {
    const path = url.pathname.slice('/api/github'.length) || '/';
    try {
      if (req.method !== 'GET' && !sameOrigin(req)) return void json(res, 403, { error: { code: 'forbidden', message: 'Запрос с другого сайта отклонён.' } });

      if (path === '/status' && req.method === 'GET') {
        const s = session(req, space);
        if (s) await verify(s.integ);
        return void json(res, 200, status(space, req));
      }

      if (path === '/auth/login' && req.method === 'GET') {
        const back = safeBack(url.searchParams.get('return'));
        if (!oauth) return void res.writeHead(302, { Location: withParam(back, 'comenta_error', 'Вход через GitHub не настроен на сервере.') }).end();
        const state = randomBytes(16).toString('base64url');
        oauthStates.set(state, { space, back, at: Date.now() });
        for (const [k, v] of oauthStates) if (Date.now() - v.at > 600_000) oauthStates.delete(k);
        const location = authorizeUrl({ clientId, redirectUri: `${origin(req)}/api/github/auth/callback`, state, scopes: DEFAULT_SCOPES, webUrl });
        return void res.writeHead(302, { Location: location, 'Set-Cookie': cookie(STATE_COOKIE, state, { maxAge: 600 }) }).end();
      }

      if (path === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') ?? '';
        const saved = oauthStates.get(state);
        oauthStates.delete(state);
        const back = saved?.back ?? '/demo/settings.html';
        const clear = cookie(STATE_COOKIE, '', { maxAge: 0 });
        const bail = (msg) => res.writeHead(302, { Location: withParam(back, 'comenta_error', msg), 'Set-Cookie': clear }).end();
        if (!saved || cookies(req)[STATE_COOKIE] !== state) return void bail('Вход не удался: ссылка устарела. Попробуйте ещё раз.');
        if (url.searchParams.get('error')) return void bail(url.searchParams.get('error') === 'access_denied' ? 'Вход отменён на GitHub.' : `GitHub: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`);
        try {
          const { token, scopes } = await exchangeCode({ clientId, clientSecret, code: url.searchParams.get('code') ?? '', redirectUri: `${origin(req)}/api/github/auth/callback`, webUrl, apiUrl });
          const login = await connect(saved.space, token, 'oauth', scopes);
          const sid = newSession(saved.space, login);
          save();
          return void res.writeHead(302, { Location: back, 'Set-Cookie': [clear, cookie(SESSION_COOKIE, sid, { maxAge: 30 * 86400 })] }).end();
        } catch (err) {
          return void bail(err instanceof GitHubError ? err.message : 'Вход через GitHub не удался.');
        }
      }

      if (path === '/auth/token' && req.method === 'POST') {
        if (!patAllowed) return void json(res, 403, { error: { code: 'forbidden', message: 'Подключение по токену выключено на сервере.' } });
        const { token } = await readJson(req);
        if (typeof token !== 'string' || token.trim().length < 20) return void json(res, 422, { error: { code: 'validation', message: 'Это не похоже на токен GitHub.' } });
        let login;
        try {
          login = await connect(space, token.trim(), 'pat');
        } catch (err) {
          if (err instanceof GitHubError && err.code === 'unauthorized') return void json(res, 401, { error: { code: 'invalid_token', message: 'GitHub не принял токен: он неверный, истёк или отозван.' } });
          throw err;
        }
        const sid = newSession(space, login);
        save();
        const fakeReq = { headers: { ...req.headers, cookie: `${SESSION_COOKIE}=${sid}` } };
        return void json(res, 200, status(space, fakeReq), { 'Set-Cookie': cookie(SESSION_COOKIE, sid, { maxAge: 30 * 86400 }) });
      }

      // everything below needs the owner's session
      const s = session(req, space);
      if (!s) return void json(res, 401, { error: { code: 'unauthorized', message: 'Войдите через GitHub, чтобы менять настройки.' } });
      const integ = s.integ;

      if (path === '/auth/logout' && req.method === 'POST') {
        if (integ.tokenType === 'oauth' && oauth && integ.token) await revokeGrant({ clientId, clientSecret, token: integ.token, apiUrl });
        log(`[github] @${integ.account?.login} вышел: токен удалён`);
        delete integ.token;
        delete integ.expired;
        integ.disconnected = true; // comments stop going to GitHub until someone connects again
        delete integ.lastError;
        dropSessions(space);
        repoCache.delete(space);
        save();
        return void json(res, 200, { oauth, pat: patAllowed, connected: false }, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
      }

      if (integ.expired || !integ.token) return void json(res, 401, { error: { code: 'unauthorized', message: 'Доступ к GitHub истёк или был отозван. Войдите заново.' } });
      const gh = client(integ);
      const guard = async (fn) => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof GitHubError && err.code === 'unauthorized') markExpired(integ);
          throw err;
        }
      };

      if (path === '/repos' && req.method === 'GET') {
        const cached = repoCache.get(space);
        const items = cached && Date.now() - cached.at < 60_000 ? cached.items : await guard(() => listRepos(gh));
        if (items.length) repoCache.set(space, { at: Date.now(), items }); // an empty list is re-read next time
        return void json(res, 200, { items });
      }

      if (path === '/projects' && req.method === 'GET') {
        const owner = url.searchParams.get('owner') ?? '';
        if (!/^[\w.-]+$/.test(owner)) return void json(res, 422, { error: { code: 'validation', message: 'Неверный владелец.' } });
        const items = await guard(() => listProjects(gh, owner));
        return void json(res, 200, { items });
      }

      if (path === '/config' && req.method === 'PUT') {
        const body = await readJson(req);
        const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(body.repo ?? ''));
        if (!m) return void json(res, 422, { error: { code: 'validation', message: 'Выберите репозиторий.' } });
        const repo = await guard(() => checkRepo(gh, m[1], m[2]));
        let project = null;
        if (body.projectId) {
          const projects = await guard(() => listProjects(gh, repo.owner));
          project = projects.find((p) => p.id === body.projectId) ?? null;
          if (!project) return void json(res, 404, { error: { code: 'not_found', message: 'Проект не найден у владельца репозитория.' } });
        }
        integ.config = {
          repo: { owner: repo.owner, name: repo.name, fullName: repo.fullName, htmlUrl: repo.htmlUrl },
          project: project ? { id: project.id, title: project.title, number: project.number, url: project.url } : null,
        };
        delete integ.lastError;
        save();
        log(`[github] настройки: ${repo.fullName}${project ? ` → проект «${project.title}»` : ''}`);
        void drain(space, true);
        return void json(res, 200, { config: integ.config });
      }

      json(res, 404, { error: { code: 'not_found', message: 'Нет такого адреса.' } });
    } catch (err) {
      if (err?.status === 413) return void json(res, 413, { error: { code: 'validation', message: 'Слишком большой запрос.' } });
      fail(res, err);
    }
  }

  return { handle, onComment, drain, status: (space) => db.spaces[space], close: () => clearInterval(timer) };
}
