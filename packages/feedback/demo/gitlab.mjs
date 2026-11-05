// GitLab integration for the demo server — a reference implementation of the backend that
// <comenta-settings provider="gitlab"> and the GitLab sync expect. Plain Node 18+, no dependencies
// besides dist/gitlab.js. gitlab.com and self-hosted GitLab both work.
//
// Env:
//   GITLAB_URL / GITLAB_CLIENT_ID / GITLAB_CLIENT_SECRET
//                                    one GitLab OAuth application (default URL https://gitlab.com).
//                                    Redirect URI: {PUBLIC_URL}/api/gitlab/auth/callback, scopes: api, read_user.
//   GITLAB_APPS_FILE                 more instances (default demo/gitlab-apps.json, gitignored):
//                                    [{ "url": "https://git.example.com", "clientId": "…", "clientSecret": "…" }, …]
//                                    Every GitLab has its own applications: gitlab.com credentials don't work elsewhere.
//   PUBLIC_URL                       site origin for the callback (default: from the Host header)
//   GITLAB_ALLOW_HTTP=1              accept http:// instance addresses besides localhost (not recommended)
//   COMENTA_GITLAB_PAT=0|1           accept a personal access token (default 1 unless NODE_ENV=production)
//   COMENTA_GITLAB_OWNERS=u1,u2      who may connect (default: the first one to connect owns it)
//   GITLAB_STORE                     where tokens and settings are kept (default demo/gitlab.json, mode 600)
//   COMENTA_GITLAB_POLL_MS / _REFRESH_MS / _DRAIN_MS / _BACKOFF_MS / _RETRY_MS   sync timing (see tracker-sync.mjs)
//   Self-signed certificate on your GitLab: start Node with NODE_EXTRA_CA_CERTS=/path/to/ca.pem.
//
// Model: one site owner connects GitLab per space (site). The token stays here (refreshed with the
// refresh token every two hours); the browser only gets an HttpOnly session cookie. There is no bot:
// issues, notes and close / reopen go under the owner's token. A site uses one tracker: GitHub or GitLab.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitLabClient,
  GitLabError,
  authorizeUrl,
  checkProject,
  deleteNote,
  exchangeCode,
  fetchIssue,
  fetchNotes,
  fetchProjectActivity,
  findReplyNote,
  forViewer,
  getAccount,
  listProjects,
  missingScopes,
  normalizeBaseUrl,
  postNote,
  probeInstance,
  refreshAccessToken,
  revokeToken,
  setIssueState,
  syncComment,
  tokenScopes,
  updateNote,
} from '../dist/gitlab.js';
import { createSyncEngine } from './tracker-sync.mjs';

const SESSION_COOKIE = 'comenta_gl_sid';
const STATE_COOKIE = 'comenta_gl_oauth';

export function createGitLabIntegration({ root, persistComments, findComment, listComments = () => [], uploadsDir, log = console.log, blockedBy = () => null }) {
  const env = process.env;
  const allowHttp = env.GITLAB_ALLOW_HTTP === '1';
  const norm = (u) => normalizeBaseUrl(u, { allowHttp });

  /** OAuth applications by instance URL. */
  const apps = new Map();
  const addApp = (a) => {
    if (!a?.url || !a.clientId || !a.clientSecret) return;
    try {
      apps.set(norm(a.url).toLowerCase(), { url: norm(a.url), clientId: a.clientId, clientSecret: a.clientSecret });
    } catch (err) {
      console.error(`[gitlab] неверный адрес приложения ${a.url}: ${err.message}`);
    }
  };
  try {
    const file = JSON.parse(readFileSync(env.GITLAB_APPS_FILE ?? join(root, 'demo', 'gitlab-apps.json'), 'utf8'));
    for (const a of Array.isArray(file) ? file : file.apps ?? [file]) addApp(a);
  } catch {
    /* no file */
  }
  const defaultUrl = (() => {
    try {
      return norm(env.GITLAB_URL ?? 'https://gitlab.com');
    } catch {
      return 'https://gitlab.com';
    }
  })();
  if (env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET) addApp({ url: defaultUrl, clientId: env.GITLAB_CLIENT_ID, clientSecret: env.GITLAB_CLIENT_SECRET });
  const appFor = (url) => apps.get(String(url ?? '').toLowerCase()) ?? null;

  const patAllowed = env.COMENTA_GITLAB_PAT ? env.COMENTA_GITLAB_PAT !== '0' : env.NODE_ENV !== 'production';
  const owners = (env.COMENTA_GITLAB_OWNERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const storeFile = env.GITLAB_STORE ?? join(root, 'demo', 'gitlab.json');
  const retryDelayMs = Number(env.COMENTA_GITLAB_RETRY_MS ?? 500);

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

  const oauthStates = new Map(); // state → { space, back, url, at }
  const repoCache = new Map(); // space → { at, items, complete }
  const refreshing = new WeakMap(); // integ → Promise: refresh tokens are single-use, so one refresh at a time

  /** The owner's token, refreshed a minute before it expires (GitLab tokens live two hours). */
  const accessToken = (integ) => {
    if (!integ.refreshToken || Date.now() < (integ.tokenExpiresAt ?? 0) - 60_000) return integ.token;
    const app = appFor(integ.baseUrl);
    if (!app) return integ.token;
    if (!refreshing.has(integ)) {
      const run = refreshAccessToken({ baseUrl: integ.baseUrl, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: integ.redirectUri, refreshToken: integ.refreshToken })
        .then((t) => {
          Object.assign(integ, { token: t.token, refreshToken: t.refreshToken ?? integ.refreshToken, tokenExpiresAt: t.expiresAt });
          if (t.scopes.length) integ.scopes = t.scopes;
          save();
          return t.token;
        })
        .finally(() => refreshing.delete(integ));
      refreshing.set(integ, run);
    }
    return refreshing.get(integ);
  };
  const client = (integ) => new GitLabClient({ baseUrl: integ.baseUrl, token: () => accessToken(integ), retries: 3, retryDelayMs });
  const canSync = (integ) => !!integ?.config && !integ.disconnected && !!integ.token && !integ.expired;
  const isActive = (integ) => !!integ && !integ.disconnected && !!(integ.token || integ.config);

  // ------------------------------------------------------------------ helpers

  const json = (res, status, data, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(data));
  const STATUS = { unauthorized: 401, forbidden: 403, not_found: 404, rate_limited: 429, validation: 422, issues_disabled: 409, not_configured: 409, network: 502, tls: 502 };
  const fail = (res, err) => {
    const e = err instanceof GitLabError ? err : new GitLabError('network', 'Внутренняя ошибка сервера.');
    if (!(err instanceof GitLabError)) console.error(err);
    json(res, STATUS[e.code] ?? 500, { error: e.toJSON() });
  };
  const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const cookie = (name, value, { maxAge, path = '/' } = {}) =>
    `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}${env.PUBLIC_URL?.startsWith('https:') ? '; Secure' : ''}`;
  const origin = (req) => env.PUBLIC_URL?.replace(/\/$/, '') ?? `http://${req.headers.host}`;
  const callbackUrl = (req) => `${origin(req)}/api/gitlab/auth/callback`;
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

  function status(space, req) {
    const integ = db.spaces[space];
    const other = isActive(integ) ? null : blockedBy(space);
    const base = {
      provider: 'gitlab',
      oauth: apps.size > 0,
      instances: [...apps.values()].map((a) => a.url),
      defaultUrl: integ?.baseUrl ?? (apps.size ? [...apps.values()][0].url : defaultUrl),
      pat: patAllowed,
      active: isActive(integ),
      ...(other ? { blockedBy: other } : {}),
    };
    const s = session(req, space);
    if (!integ?.token || !s) {
      const out = { ...base, connected: false };
      if (s && integ?.expired) out.reason = 'expired';
      if (integ?.token && !s) out.owner = integ.account?.login;
      return out;
    }
    if (integ.expired) return { ...base, connected: false, reason: 'expired' };
    const counts = sync.counts(integ);
    return {
      ...base,
      connected: true,
      instanceUrl: integ.baseUrl,
      account: integ.account,
      config: integ.config ?? null,
      missingScopes: missingScopes(integ.scopes),
      sync: { pending: counts.pending, replies: counts.replies, ...(integ.lastError ? { lastError: integ.lastError } : {}) },
    };
  }

  /** Re-check the token now and then: a revoked token shows "sign in again" in the settings. */
  async function verify(integ) {
    if (!integ?.token || integ.expired || Date.now() - (integ.checkedAt ?? 0) < 60_000) return;
    try {
      const gl = client(integ);
      const acc = await getAccount(gl);
      integ.account = { login: acc.login, name: acc.name, avatarUrl: acc.avatarUrl, htmlUrl: acc.htmlUrl };
      const scopes = await tokenScopes(gl).catch(() => null);
      if (scopes) integ.scopes = scopes;
      integ.checkedAt = Date.now();
    } catch (err) {
      if (err instanceof GitLabError && err.code === 'unauthorized') markExpired(integ);
    }
  }
  function markExpired(integ) {
    if (integ.expired) return;
    integ.expired = true;
    log(`[gitlab] токен ${integ.account?.login ?? '?'} больше не действует — нужен повторный вход`);
    save();
  }

  /** Store a fresh token for the space (OAuth callback or personal access token). */
  async function connect(space, baseUrl, { token, refreshToken, expiresAt, scopes }, tokenType, redirectUri) {
    const other = isActive(db.spaces[space]) ? null : blockedBy(space);
    if (other) throw new GitLabError('forbidden', `На этом сайте уже подключён ${other}. Сайт работает с одним трекером: сначала отключите ${other} в настройках.`);
    const gl = new GitLabClient({ baseUrl, token, retries: 2, retryDelayMs });
    const acc = await getAccount(gl);
    const login = acc.login.toLowerCase();
    if (owners.length && !owners.includes(login)) throw new GitLabError('forbidden', `Аккаунт @${acc.login} не может настраивать интеграцию на этом сайте.`);
    const prev = db.spaces[space];
    if (prev?.token && !prev.expired && prev.account && (prev.account.login.toLowerCase() !== login || prev.baseUrl !== baseUrl)) {
      throw new GitLabError('forbidden', `Интеграцию уже подключил @${prev.account.login}. Сначала он должен выйти.`);
    }
    const sameOwner = prev?.account?.login?.toLowerCase() === login && prev?.baseUrl === baseUrl;
    const granted = scopes?.length ? scopes : await tokenScopes(gl).catch(() => null);
    db.spaces[space] = {
      baseUrl,
      token,
      refreshToken,
      tokenExpiresAt: expiresAt,
      tokenType,
      redirectUri,
      scopes: granted ?? undefined,
      account: { login: acc.login, name: acc.name, avatarUrl: acc.avatarUrl, htmlUrl: acc.htmlUrl },
      checkedAt: Date.now(),
      // the same person signing in again keeps the chosen project, queued comments and sync cursors
      config: sameOwner ? prev.config : undefined,
      pending: sameOwner ? prev.pending ?? {} : {},
      threads: sameOwner ? prev.threads : undefined,
    };
    repoCache.delete(space);
    save();
    log(`[gitlab] подключён @${acc.login} (${tokenType}) на ${baseUrl} в пространстве ${space}`);
    void sync.drain(space, true).then(() => sync.drainReplies(space, true));
    return acc.login;
  }

  // ------------------------------------------------------------------ sync (driver for tracker-sync.mjs)

  const target = (integ) => ({ projectId: integ.config.repo.id, path: integ.config.repo.fullName, webUrl: integ.config.repo.htmlUrl });
  const driver = {
    name: 'gitlab',
    label: 'GitLab',
    canSync,
    withApi: (integ, fn) => fn(client(integ), false),
    authFailed: (integ) => markExpired(integ),
    tracks: (integ, issue) => (issue.repoId !== undefined ? String(issue.repoId) === String(integ.config.repo.id) : issue.repo.toLowerCase() === integ.config.repo.fullName.toLowerCase()),
    pollKey: (integ) => `${integ.baseUrl} ${integ.config.repo.id}`,
    async createIssue(gl, integ, payload, files, { checkExisting }) {
      const { existed, ...link } = await syncComment(gl, target(integ), payload, files, { checkExisting });
      return { link, existed };
    },
    fetchIssue: (gl, issue, etag) => fetchIssue(gl, issue, etag),
    async fetchComments(gl, issue) {
      const { comments, complete } = await fetchNotes(gl, issue);
      return { kind: 'ok', comments, complete };
    },
    async poll(gl, integ, cursor) {
      const act = await fetchProjectActivity(gl, integ.config.repo.id, cursor);
      // a new or edited note bumps its issue's updated_at: the engine re-reads those issues
      return { cursor: act.cursor, issues: act.issues, touched: act.issues.map((i) => ({ number: i.number, updatedAt: i.updatedAt })) };
    },
    setState: (gl, issue, state) => setIssueState(gl, issue, state),
    postReply: (gl, issue, reply, files, opts) => postNote(gl, issue, reply, files, opts),
    updateReply: (gl, issue, link, reply, guestName) => updateNote(gl, issue, link, reply, guestName),
    deleteReply: (gl, issue, link) => deleteNote(gl, issue, link),
    findReply: (gl, issue, replyId) => findReplyNote(gl, issue, replyId),
    toError: (err) => (err instanceof GitLabError ? err : new GitLabError('network', String(err?.message ?? err))),
    error: (code, message) => new GitLabError(code, message),
  };
  const sync = createSyncEngine({
    driver,
    db,
    save,
    persistComments,
    findComment,
    listComments,
    uploadsDir,
    log,
    timing: {
      backoffMs: Number(env.COMENTA_GITLAB_BACKOFF_MS ?? 60_000),
      drainMs: Number(env.COMENTA_GITLAB_DRAIN_MS ?? 30_000),
      pollMs: Number(env.COMENTA_GITLAB_POLL_MS ?? 45_000),
      refreshMs: Number(env.COMENTA_GITLAB_REFRESH_MS ?? 20_000),
    },
  });

  // ------------------------------------------------------------------ routes

  /** The instance the owner typed: normalised, with an OAuth application, and answering as GitLab. */
  async function instanceFor(input, { needApp }) {
    const baseUrl = norm(input || defaultUrl);
    const app = appFor(baseUrl);
    if (needApp && !app) {
      throw new GitLabError(
        'not_configured',
        `Для ${baseUrl} на сервере нет OAuth-приложения GitLab. Создайте его на этом GitLab и добавьте Application ID и Secret в настройки сервера (GITLAB_APPS_FILE), или подключитесь по токену.`,
      );
    }
    await probeInstance(baseUrl);
    return { baseUrl, app };
  }

  /** Handles /api/gitlab/*. */
  async function handle(req, res, url, space) {
    const path = url.pathname.slice('/api/gitlab'.length) || '/';
    try {
      if (req.method !== 'GET' && !sameOrigin(req)) return void json(res, 403, { error: { code: 'forbidden', message: 'Запрос с другого сайта отклонён.' } });

      if (path === '/status' && req.method === 'GET') {
        const s = session(req, space);
        if (s) await verify(s.integ);
        return void json(res, 200, status(space, req));
      }

      if (path === '/auth/login' && req.method === 'GET') {
        const back = safeBack(url.searchParams.get('return'));
        let inst;
        try {
          inst = await instanceFor(url.searchParams.get('url'), { needApp: true });
        } catch (err) {
          return void res.writeHead(302, { Location: withParam(withParam(back, 'comenta_provider', 'gitlab'), 'comenta_error', err instanceof GitLabError ? err.message : 'Вход через GitLab не удался.') }).end();
        }
        const other = isActive(db.spaces[space]) ? null : blockedBy(space);
        if (other) return void res.writeHead(302, { Location: withParam(back, 'comenta_error', `На этом сайте уже подключён ${other}. Сначала отключите его.`) }).end();
        const state = randomBytes(16).toString('base64url');
        oauthStates.set(state, { space, back, url: inst.baseUrl, at: Date.now() });
        for (const [k, v] of oauthStates) if (Date.now() - v.at > 600_000) oauthStates.delete(k);
        const location = authorizeUrl({ baseUrl: inst.baseUrl, clientId: inst.app.clientId, redirectUri: callbackUrl(req), state });
        return void res.writeHead(302, { Location: location, 'Set-Cookie': cookie(STATE_COOKIE, state, { maxAge: 600 }) }).end();
      }

      if (path === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') ?? '';
        const saved = oauthStates.get(state);
        oauthStates.delete(state);
        const back = withParam(saved?.back ?? '/demo/settings.html', 'comenta_provider', 'gitlab');
        const clear = cookie(STATE_COOKIE, '', { maxAge: 0 });
        const bail = (msg) => res.writeHead(302, { Location: withParam(back, 'comenta_error', msg), 'Set-Cookie': clear }).end();
        if (!saved || cookies(req)[STATE_COOKIE] !== state) return void bail('Вход не удался: ссылка устарела. Попробуйте ещё раз.');
        if (url.searchParams.get('error')) return void bail(url.searchParams.get('error') === 'access_denied' ? 'Вход отменён на GitLab.' : `GitLab: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`);
        const app = appFor(saved.url);
        try {
          if (!app) throw new GitLabError('not_configured', 'OAuth-приложение GitLab пропало из настроек сервера.');
          const tokens = await exchangeCode({ baseUrl: saved.url, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: callbackUrl(req), code: url.searchParams.get('code') ?? '' });
          const login = await connect(saved.space, saved.url, tokens, 'oauth', callbackUrl(req));
          const sid = newSession(saved.space, login);
          save();
          return void res.writeHead(302, { Location: saved.back, 'Set-Cookie': [clear, cookie(SESSION_COOKIE, sid, { maxAge: 30 * 86400 })] }).end();
        } catch (err) {
          return void bail(err instanceof GitLabError ? err.message : 'Вход через GitLab не удался.');
        }
      }

      if (path === '/auth/token' && req.method === 'POST') {
        if (!patAllowed) return void json(res, 403, { error: { code: 'forbidden', message: 'Подключение по токену выключено на сервере.' } });
        const body = await readJson(req);
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (token.length < 20) return void json(res, 422, { error: { code: 'validation', message: 'Это не похоже на токен GitLab (glpat-…).' } });
        const { baseUrl } = await instanceFor(body.url, { needApp: false });
        let login;
        try {
          login = await connect(space, baseUrl, { token }, 'pat');
        } catch (err) {
          if (err instanceof GitLabError && err.code === 'unauthorized') return void json(res, 401, { error: { code: 'invalid_token', message: 'GitLab не принял токен: он неверный, истёк или отозван.' } });
          throw err;
        }
        const sid = newSession(space, login);
        save();
        const fakeReq = { headers: { ...req.headers, cookie: `${SESSION_COOKIE}=${sid}` } };
        return void json(res, 200, status(space, fakeReq), { 'Set-Cookie': cookie(SESSION_COOKIE, sid, { maxAge: 30 * 86400 }) });
      }

      // everything below needs the owner's session
      const s = session(req, space);
      if (!s) return void json(res, 401, { error: { code: 'unauthorized', message: 'Войдите через GitLab, чтобы менять настройки.' } });
      const integ = s.integ;

      if (path === '/auth/logout' && req.method === 'POST') {
        const app = appFor(integ.baseUrl);
        if (integ.tokenType === 'oauth' && app && integ.token) await revokeToken({ baseUrl: integ.baseUrl, clientId: app.clientId, clientSecret: app.clientSecret, token: integ.token });
        log(`[gitlab] @${integ.account?.login} вышел: токен удалён`);
        delete integ.token;
        delete integ.refreshToken;
        delete integ.tokenExpiresAt;
        delete integ.expired;
        integ.disconnected = true; // comments stop going to GitLab until someone connects again
        delete integ.lastError;
        dropSessions(space);
        repoCache.delete(space);
        save();
        const out = status(space, { headers: {} });
        return void json(res, 200, out, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
      }

      if (integ.expired || !integ.token) return void json(res, 401, { error: { code: 'unauthorized', message: 'Доступ к GitLab истёк или был отозван. Войдите заново.' } });
      const gl = client(integ);
      const guard = async (fn) => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof GitLabError && err.code === 'unauthorized') markExpired(integ);
          throw err;
        }
      };

      if (path === '/repos' && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
        if (q) {
          const found = await guard(() => listProjects(gl, { search: q, maxPages: 1 }));
          return void json(res, 200, { items: found.items.map(repoItem), complete: found.complete, search: q });
        }
        const cached = repoCache.get(space);
        const list = cached && Date.now() - cached.at < 60_000 ? cached : await guard(() => listProjects(gl));
        if (list.items.length) repoCache.set(space, { at: Date.now(), ...list });
        return void json(res, 200, { items: list.items.map(repoItem), complete: list.complete });
      }

      if (path === '/config' && req.method === 'PUT') {
        const body = await readJson(req);
        const ref = body.id ?? body.repo;
        if (!ref || (typeof ref !== 'number' && !/^[\w.-]+(\/[\w.-]+)+$/.test(String(ref)))) return void json(res, 422, { error: { code: 'validation', message: 'Выберите проект.' } });
        const p = await guard(() => checkProject(gl, ref));
        integ.config = { repo: { id: p.id, owner: p.owner, name: p.name, fullName: p.fullName, title: p.title, htmlUrl: p.htmlUrl } };
        delete integ.lastError;
        save();
        log(`[gitlab] настройки: ${p.fullName} (${integ.baseUrl})`);
        void sync.drain(space, true).then(() => sync.drainReplies(space, true));
        return void json(res, 200, { config: integ.config });
      }

      json(res, 404, { error: { code: 'not_found', message: 'Нет такого адреса.' } });
    } catch (err) {
      if (err?.status === 413) return void json(res, 413, { error: { code: 'validation', message: 'Слишком большой запрос.' } });
      fail(res, err);
    }
  }

  /** The settings element's repository shape. */
  const repoItem = (p) => ({ id: p.id, fullName: p.fullName, owner: p.owner, name: p.name, title: p.title, private: p.private, hasIssues: p.hasIssues, ownerType: p.ownerType, htmlUrl: p.htmlUrl });

  return {
    provider: 'gitlab',
    label: 'GitLab',
    oauth: apps.size > 0,
    instances: [...apps.keys()],
    handle,
    onComment: sync.onComment,
    onReply: sync.onReply,
    onReplyEdit: sync.onReplyEdit,
    onReplyDelete: sync.onReplyDelete,
    onStatus: sync.onStatus,
    drain: sync.drain,
    drainReplies: sync.drainReplies,
    pollSpace: sync.pollSpace,
    refreshComments: sync.refreshComments,
    isOwner: (req, space) => !!session(req, space),
    active: (space) => isActive(db.spaces[space]),
    forViewer: (list, viewer) => list.map((c) => forViewer(c, viewer)),
    status: (space) => db.spaces[space],
    close: () => sync.close(),
  };
}
