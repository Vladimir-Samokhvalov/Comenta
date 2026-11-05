// GitHub integration for the demo server — a reference implementation of the backend that
// <comenta-settings> and the GitHub sync expect. Plain Node, no dependencies besides dist/github.js.
//
// Env:
//   GITHUB_APP_SLUG / GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
//                                             GitHub App; callback URL: {PUBLIC_URL}/api/github/auth/callback.
//                                             Without them: GITHUB_APP_FILE (default demo/github-app.json),
//                                             written by `pnpm github-app:setup`
//   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (PEM text) or GITHUB_APP_PRIVATE_KEY_PATH
//                                             the app's private key: issues are created with installation tokens
//                                             and authored by <slug>[bot]. Without it: under the owner's user token.
//                                             github-app.json from `pnpm github-app:setup` already has both.
//   PUBLIC_URL                                 site origin for the callback (default: from the Host header)
//   COMENTA_GITHUB_PAT=0|1                     accept a personal access token (default 1 unless NODE_ENV=production)
//   COMENTA_GITHUB_OWNERS=login1,login2        who may connect (default: the first one to connect owns it)
//   GITHUB_API_URL / GITHUB_WEB_URL            GitHub Enterprise or the mock (see github-mock.mjs)
//   GITHUB_STORE                               where tokens and settings are kept (default demo/github.json, mode 600)
//
// Model: one site owner connects GitHub per space (site). The token stays here; the browser only
// gets an HttpOnly session cookie. Guests' comments become issues authored by the app's bot (installation
// token minted from the private key), so they keep arriving after the owner's sign-in expires; access ends
// when the owner removes the app or the repository from it on GitHub. Without a private key the owner's
// user token is used (same repositories, refreshed when it expires, issues authored by the owner).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitHubAppAuth,
  GitHubClient,
  GitHubError,
  authorizeUrl,
  checkRepo,
  countInstallations,
  exchangeCode,
  getAccount,
  installUrl,
  listInstallationRepos,
  listProjects,
  listRepos,
  refreshAccessToken,
  revokeGrant,
  syncComment,
} from '../dist/github.js';

const SESSION_COOKIE = 'comenta_sid';
const STATE_COOKIE = 'comenta_oauth';
const REQUIRED = { project: 'project', repo: 'repo' };

export function createGitHubIntegration({ root, persistComments, findComment, uploadsDir, log = console.log }) {
  const env = process.env;
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  const webUrl = env.GITHUB_WEB_URL ?? 'https://github.com';
  let appFile = {};
  try {
    appFile = JSON.parse(readFileSync(env.GITHUB_APP_FILE ?? join(root, 'demo', 'github-app.json'), 'utf8'));
  } catch {
    /* no app registered yet */
  }
  const clientId = env.GITHUB_CLIENT_ID ?? appFile.clientId ?? '';
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? appFile.clientSecret ?? '';
  const appSlug = env.GITHUB_APP_SLUG ?? appFile.slug ?? '';
  const oauth = !!(clientId && clientSecret && appSlug);
  const appId = env.GITHUB_APP_ID ?? appFile.id ?? '';
  let privateKey = env.GITHUB_APP_PRIVATE_KEY ?? appFile.privateKey ?? '';
  if (!privateKey && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
    } catch (err) {
      console.error(`[github] не удалось прочитать ${env.GITHUB_APP_PRIVATE_KEY_PATH}: ${err.message}`);
    }
  }
  /** Installation tokens for the bot; null → issues go under the owner's user token. */
  const appAuth = oauth && appId && privateKey ? new GitHubAppAuth({ appId, privateKey, apiUrl }) : null;
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
  const refreshing = new WeakMap(); // integ → Promise: refresh tokens are single-use, so one refresh at a time

  /** The owner's token, refreshed a minute before it expires. A dead refresh token throws `unauthorized`. */
  const accessToken = (integ) => {
    if (!integ.refreshToken || Date.now() < integ.tokenExpiresAt - 60_000) return integ.token;
    if (!refreshing.has(integ)) {
      const run = refreshAccessToken({ clientId, clientSecret, refreshToken: integ.refreshToken, webUrl })
        .then((t) => {
          Object.assign(integ, { token: t.token, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt });
          save();
          return t.token;
        })
        .finally(() => refreshing.delete(integ));
      refreshing.set(integ, run);
    }
    return refreshing.get(integ);
  };
  const retryDelayMs = Number(env.COMENTA_GITHUB_RETRY_MS ?? 500);
  const client = (integ) => new GitHubClient({ token: () => accessToken(integ), apiUrl, retries: 3, retryDelayMs });

  /** Installation that covers the chosen repository when issues are created by the bot. */
  const botInstallation = (integ) => (appAuth && integ?.tokenType === 'app' ? integ.config?.repo?.installationId ?? null : null);
  const botClient = (id) => new GitHubClient({ token: async () => (await appAuth.installationToken(id)).token, apiUrl, retries: 3, retryDelayMs });
  /** Comments can be synced: the bot needs only the saved settings, the user token must be alive. */
  const canSync = (integ) => !!integ?.config && !integ.disconnected && (!!botInstallation(integ) || (!!integ.token && !integ.expired));
  /** Which installation grants access to the chosen repository (it changes when the app is reinstalled). */
  async function resolveInstallation(integ, items) {
    if (!appAuth || integ.tokenType !== 'app' || !integ.config?.repo || !integ.token || integ.expired) return;
    const repos = items ?? (await listInstallationRepos(client(integ)));
    const id = repos.find((r) => r.fullName.toLowerCase() === integ.config.repo.fullName.toLowerCase())?.installationId;
    if (id) integ.config.repo.installationId = id;
    else delete integ.config.repo.installationId;
    save();
  }

  // ------------------------------------------------------------------ helpers

  const json = (res, status, data, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(data));
  const STATUS = { unauthorized: 401, forbidden: 403, not_found: 404, rate_limited: 429, validation: 422, issues_disabled: 409, not_configured: 409, uninstalled: 409, network: 502 };
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
    if (!integ.scopes?.length) return []; // GitHub App and fine-grained tokens have no scopes
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
      if (s && integ?.expired && canSync(integ)) out.syncing = true; // the bot keeps creating issues
      if (integ?.token && !s) out.owner = integ.account?.login;
      return out;
    }
    if (integ.expired) return { ...base, connected: false, reason: 'expired', ...(canSync(integ) ? { syncing: true } : {}) };
    const pending = Object.keys(integ.pending ?? {}).length;
    return {
      ...base,
      connected: true,
      app: integ.tokenType === 'app',
      bot: !!botInstallation(integ),
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
      if (acc.scopes.length) integ.scopes = acc.scopes;
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

  /** Store a fresh token for the space (GitHub App callback or PAT). */
  async function connect(space, { token, refreshToken, expiresAt }, tokenType) {
    const acc = await getAccount(client({ token, tokenType }));
    const login = acc.login.toLowerCase();
    if (owners.length && !owners.includes(login)) throw new GitHubError('forbidden', `Аккаунт @${acc.login} не может настраивать интеграцию на этом сайте.`);
    const prev = db.spaces[space];
    if (prev?.token && !prev.expired && prev.account && prev.account.login.toLowerCase() !== login) {
      throw new GitHubError('forbidden', `Интеграцию уже подключил @${prev.account.login}. Сначала он должен выйти.`);
    }
    const sameOwner = prev?.account?.login?.toLowerCase() === login;
    db.spaces[space] = {
      token,
      refreshToken,
      tokenExpiresAt: expiresAt,
      tokenType,
      scopes: acc.scopes,
      account: { login: acc.login, name: acc.name, avatarUrl: acc.avatarUrl, htmlUrl: acc.htmlUrl },
      checkedAt: Date.now(),
      // the same person signing in again keeps the chosen repository and queued comments
      config: sameOwner ? prev.config : undefined,
      pending: sameOwner ? prev.pending ?? {} : {},
    };
    repoCache.delete(space);
    save();
    log(`[github] подключён @${acc.login} (${tokenType}) в пространстве ${space}`);
    void resolveInstallation(db.spaces[space])
      .catch(() => {})
      .then(() => drain(space, true));
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
    if (!canSync(integ)) {
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
      if (!canSync(integ) || payload.issue) return payload.issue ?? null;
      const attempts = integ.pending?.[payload.id]?.attempts ?? 0;
      const { repo, project } = integ.config;
      const bot = botInstallation(integ);
      files ??= await filesFromDisk(payload);
      const run = (gh, checkExisting) => syncComment(gh, { owner: repo.owner, repo: repo.name, projectId: project?.id }, payload, files, { checkExisting });
      try {
        let res;
        if (!bot) res = await run(client(integ), attempts > 0);
        else {
          try {
            res = await run(botClient(bot), attempts > 0);
          } catch (err) {
            // a cached installation token can die early; the app may have been reinstalled under a new id
            if (!(err instanceof GitHubError) || !['unauthorized', 'uninstalled'].includes(err.code)) throw err;
            appAuth.forget(bot);
            if (err.code === 'uninstalled') await resolveInstallation(integ).catch(() => {});
            const next = botInstallation(integ);
            if (!next) throw err.code === 'uninstalled' ? err : new GitHubError('uninstalled', 'Приложение Comenta больше не установлено на этот репозиторий. Установите его снова в настройках.');
            res = await run(botClient(next), true);
          }
        }
        payload.issue = { provider: 'github', repo: res.repo, number: res.number, url: res.url, nodeId: res.nodeId, ...(res.projectId ? { projectId: res.projectId } : {}) };
        persistComments();
        if (integ.pending) delete integ.pending[payload.id];
        integ.lastError = res.projectError ? { code: 'project', message: `Issue создан, но не добавлен в проект: ${res.projectError}`, at: new Date().toISOString() } : undefined;
        save();
        log(`[github] ${payload.id.slice(0, 8)} → ${res.url}${res.existed ? ' (уже был)' : ''}${res.projectError ? ` (проект: ${res.projectError})` : ''}`);
        return payload.issue;
      } catch (err) {
        const e = err instanceof GitHubError ? err : new GitHubError('network', String(err?.message ?? err));
        if (e.code === 'unauthorized' && !bot) markExpired(integ);
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
    if (!integ?.pending || !canSync(integ)) return;
    for (const [id, p] of Object.entries(integ.pending)) {
      if (!force && p.nextAt > Date.now()) continue;
      const payload = findComment(space, id);
      if (!payload || payload.issue) {
        delete integ.pending[id];
        continue;
      }
      await syncOne(space, payload);
      if (!canSync(db.spaces[space])) break;
    }
    save();
  }
  const timer = setInterval(() => {
    for (const space of Object.keys(db.spaces)) void drain(space);
  }, Number(env.COMENTA_GITHUB_DRAIN_MS ?? 30_000));
  timer.unref?.();

  // ------------------------------------------------------------------ routes

  function redirectToInstall(res, space, back, ...setCookies) {
    const state = randomBytes(16).toString('base64url');
    oauthStates.set(state, { space, back, at: Date.now() });
    res.writeHead(302, { Location: installUrl({ slug: appSlug, state, webUrl }), 'Set-Cookie': [cookie(STATE_COOKIE, state, { maxAge: 600 }), ...setCookies] }).end();
  }

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
        const location = authorizeUrl({ clientId, redirectUri: `${origin(req)}/api/github/auth/callback`, state, webUrl });
        return void res.writeHead(302, { Location: location, 'Set-Cookie': cookie(STATE_COOKIE, state, { maxAge: 600 }) }).end();
      }

      if (path === '/auth/install' && req.method === 'GET') {
        const back = safeBack(url.searchParams.get('return'));
        if (!oauth) return void res.writeHead(302, { Location: withParam(back, 'comenta_error', 'Вход через GitHub не настроен на сервере.') }).end();
        repoCache.delete(space);
        return void redirectToInstall(res, space, back);
      }

      if (path === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') ?? '';
        const saved = oauthStates.get(state);
        oauthStates.delete(state);
        const back = saved?.back ?? '/demo/settings.html';
        const clear = cookie(STATE_COOKIE, '', { maxAge: 0 });
        const bail = (msg) => res.writeHead(302, { Location: withParam(back, 'comenta_error', msg), 'Set-Cookie': clear }).end();
        if (!saved || cookies(req)[STATE_COOKIE] !== state) return void bail('Вход не удался: ссылка устарела. Попробуйте ещё раз.');
        if (url.searchParams.get('setup_action') === 'request') return void bail('Установка приложения ждёт одобрения владельца организации на GitHub.');
        if (url.searchParams.get('error')) return void bail(url.searchParams.get('error') === 'access_denied' ? 'Вход отменён на GitHub.' : `GitHub: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`);
        try {
          const tokens = await exchangeCode({ clientId, clientSecret, code: url.searchParams.get('code') ?? '', redirectUri: `${origin(req)}/api/github/auth/callback`, webUrl, apiUrl });
          const login = await connect(saved.space, tokens, 'app');
          const sid = newSession(saved.space, login);
          save();
          const sessionCookie = cookie(SESSION_COOKIE, sid, { maxAge: 30 * 86400 });
          // signed in, but the app isn't installed anywhere yet: go straight on to choosing repositories
          if ((await countInstallations(client(db.spaces[saved.space]))) === 0) return void redirectToInstall(res, saved.space, back, sessionCookie);
          return void res.writeHead(302, { Location: back, 'Set-Cookie': [clear, sessionCookie] }).end();
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
          login = await connect(space, { token: token.trim() }, 'pat');
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
        if (integ.tokenType === 'app' && oauth && integ.token) await revokeGrant({ clientId, clientSecret, token: integ.token, apiUrl });
        log(`[github] @${integ.account?.login} вышел: токен удалён`);
        delete integ.token;
        delete integ.refreshToken;
        delete integ.tokenExpiresAt;
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
        const items = cached && Date.now() - cached.at < 60_000 ? cached.items : await guard(() => (integ.tokenType === 'app' ? listInstallationRepos(gh) : listRepos(gh)));
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
        let installationId;
        if (appAuth && integ.tokenType === 'app') {
          const listed = await guard(() => listInstallationRepos(gh));
          installationId = listed.find((r) => r.fullName === repo.fullName)?.installationId;
        }
        integ.config = {
          repo: { owner: repo.owner, name: repo.name, fullName: repo.fullName, htmlUrl: repo.htmlUrl, ...(installationId ? { installationId } : {}) },
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

  return { oauth, bot: !!appAuth, handle, onComment, drain, status: (space) => db.spaces[space], close: () => clearInterval(timer) };
}
