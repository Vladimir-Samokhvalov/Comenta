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
//
// Thread sync (see "thread sync" below): issue state and comments written on GitHub are polled
// (COMENTA_GITHUB_POLL_MS, default 45 s, plus a per-issue refresh when the owner opens the widget,
// throttled by COMENTA_GITHUB_REFRESH_MS) with ETags, and replies written in Comenta are posted to the
// issue as comments signed with the author's name. GitHub state and comments are shown to the site owner and
// to the author of each comment only.
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
  applyIssueState,
  applyIssueStatus,
  setIssueState,
  deleteReplyComment,
  fetchIssue,
  fetchIssueComments,
  fetchRepoActivity,
  findReplyComment,
  forViewer,
  mergeIssueComments,
  postReply,
  updateReplyComment,
} from '../dist/github.js';

const SESSION_COOKIE = 'comenta_sid';
const STATE_COOKIE = 'comenta_oauth';
const REQUIRED = { project: 'project', repo: 'repo' };

export function createGitHubIntegration({ root, persistComments, findComment, listComments = () => [], uploadsDir, log = console.log }) {
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
      sync: { pending, replies: Object.keys(integ.threads?.replies ?? {}).length, ...(integ.lastError ? { lastError: integ.lastError } : {}) },
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
      // sync cursors and queued replies survive a re-login of the same owner
      threads: sameOwner ? prev.threads : undefined,
    };
    repoCache.delete(space);
    save();
    log(`[github] подключён @${acc.login} (${tokenType}) в пространстве ${space}`);
    void resolveInstallation(db.spaces[space])
      .catch(() => {})
      .then(() => drain(space, true))
      .then(() => drainReplies(space, true));
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
        // replies written while the issue was being created go out now
        for (const r of payload.replies ?? []) if (!r.origin && !r.link) enqueueReply(space, payload.id, r.id, 'create');
        void drainReplies(space, true);
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
    for (const space of Object.keys(db.spaces)) void drain(space).then(() => drainReplies(space));
  }, Number(env.COMENTA_GITHUB_DRAIN_MS ?? 30_000));
  timer.unref?.();

  // ------------------------------------------------------------------ thread sync
  //
  // GitHub → Comenta: every POLL_MS one conditional request for issues and one for comments of the
  // chosen repository (both 304 when nothing changed); a per-issue refresh when the owner opens the
  // widget also catches deletions, deleted / transferred issues and backfills old cards.
  // Comenta → GitHub: a queue of reply operations (create / edit / delete) per space, retried with
  // backoff while GitHub or the token is unavailable. Comments Comenta posted carry a hidden marker,
  // so polling never imports them back. A webhook handler (`issues`, `issue_comment` events) can call
  // applyIssueState / mergeIssueComments the same way and make polling rarer.

  const pollMs = Number(env.COMENTA_GITHUB_POLL_MS ?? 45_000);
  const refreshMs = Number(env.COMENTA_GITHUB_REFRESH_MS ?? 20_000);
  const inflightIssue = new Map(); // `${space}:${repo}#${n}` → Promise
  const inflightReply = new Map(); // `${space}:${commentId}:${replyId}` → Promise

  /** { repo, cursor, issues: { [repo#n]: { etag, commentsEtag, at, full } }, replies: { [key]: op }, pausedUntil } */
  const threads = (integ) => {
    integ.threads ??= {};
    integ.threads.issues ??= {};
    integ.threads.replies ??= {};
    return integ.threads;
  };
  const issueKey = (i) => `${i.repo.toLowerCase()}#${i.number}`;
  const paused = (integ) => (integ.threads?.pausedUntil ?? 0) > Date.now();

  /** Run with the bot's installation token when there is one, otherwise with the owner's token. */
  async function withGitHub(integ, fn) {
    const bot = botInstallation(integ);
    if (!bot) return fn(client(integ));
    try {
      return await fn(botClient(bot));
    } catch (err) {
      if (!(err instanceof GitHubError) || !['unauthorized', 'uninstalled'].includes(err.code)) throw err;
      appAuth.forget(bot);
      if (err.code === 'uninstalled') await resolveInstallation(integ).catch(() => {});
      const next = botInstallation(integ);
      if (!next) throw err;
      return fn(botClient(next));
    }
  }

  /** A read failed: wait out rate limits, mark a dead owner token. */
  function readFailed(integ, err, what) {
    const e = err instanceof GitHubError ? err : new GitHubError('network', String(err?.message ?? err));
    if (e.code === 'rate_limited') threads(integ).pausedUntil = e.resetAt ?? Date.now() + 60_000;
    if (e.code === 'unauthorized' && !botInstallation(integ)) markExpired(integ);
    save();
    log(`[github] ${what}: ${e.code} — ${e.message}`);
  }

  /** Repository-wide poll: issue states and new / edited comments since the last cursor. */
  async function pollSpace(space) {
    const integ = db.spaces[space];
    if (!canSync(integ) || paused(integ)) return;
    const { owner, name, fullName } = integ.config.repo;
    const tracked = listComments(space).filter((c) => c.issue?.provider === 'github' && c.issue.repo.toLowerCase() === fullName.toLowerCase());
    if (!tracked.length) return;
    const t = threads(integ);
    if (t.repo !== fullName || !t.cursor) {
      // start from the oldest tracked comment; later polls only ask for what changed
      const from = tracked.reduce((m, c) => (c.createdAt < m ? c.createdAt : m), new Date().toISOString());
      t.repo = fullName;
      t.cursor = { issues: from, comments: from };
    }
    try {
      const act = await withGitHub(integ, (gh) => fetchRepoActivity(gh, { owner, repo: name }, t.cursor));
      t.cursor = act.cursor;
      const byNumber = new Map(tracked.map((c) => [c.issue.number, c]));
      let changed = false;
      for (const st of act.issues ?? []) {
        const c = byNumber.get(st.number);
        if (!c) continue;
        if (applyIssueState(c.issue, st)) changed = true;
        if (applyIssueStatus(c, st)) {
          changed = true;
          // listings don't say who closed it: one single-issue read does
          if (c.status === 'resolved') void refreshIssue(space, c, true);
        }
      }
      const groups = new Map();
      for (const gc of act.comments ?? []) {
        if (!groups.has(gc.issueNumber)) groups.set(gc.issueNumber, []);
        groups.get(gc.issueNumber).push(gc);
      }
      for (const [n, list] of groups) {
        const c = byNumber.get(n);
        if (!c) continue;
        const m = mergeIssueComments(c, list);
        if (m.changed) {
          c.replies = m.replies;
          changed = true;
        }
      }
      if (changed) persistComments();
      save();
    } catch (err) {
      readFailed(integ, err, `опрос ${fullName}`);
    }
  }

  /** One issue in full: state, every comment (finds deletions), 404/410/transfer. Throttled unless `force`. */
  function refreshIssue(space, c, force = false) {
    const integ = db.spaces[space];
    if (c.issue?.provider !== 'github' || !canSync(integ) || paused(integ)) return Promise.resolve(false);
    const t = threads(integ);
    const key = issueKey(c.issue);
    const rec = (t.issues[key] ??= {});
    if (!force && rec.at && Date.now() - rec.at < refreshMs) return Promise.resolve(false);
    const lock = `${space}:${key}`;
    if (inflightIssue.has(lock)) return inflightIssue.get(lock);
    const run = (async () => {
      rec.at = Date.now();
      try {
        let changed = false;
        const res = await withGitHub(integ, (gh) => fetchIssue(gh, c.issue, rec.etag));
        if (res.kind === 'unavailable') {
          delete rec.etag;
          delete rec.commentsEtag;
          changed = applyIssueState(c.issue, { unavailable: res.reason });
        } else {
          if (res.kind === 'ok') {
            rec.etag = res.etag;
            changed = applyIssueState(c.issue, res.issue);
            if (applyIssueStatus(c, res.issue)) changed = true;
          }
          const cs = await withGitHub(integ, (gh) => fetchIssueComments(gh, c.issue, rec.commentsEtag));
          if (cs.kind === 'ok') {
            rec.commentsEtag = cs.etag;
            const m = mergeIssueComments(c, cs.comments, { complete: cs.complete });
            if (m.changed) {
              c.replies = m.replies;
              changed = true;
            }
          }
          if (!rec.full) {
            // first full look at this card: replies written before the sync existed go to GitHub
            rec.full = true;
            for (const r of c.replies ?? []) if (!r.origin && !r.link) enqueueReply(space, c.id, r.id, 'create', { checkExisting: true });
            void drainReplies(space, true);
          }
        }
        if (changed) persistComments();
        save();
        return changed;
      } catch (err) {
        readFailed(integ, err, `issue ${c.issue.repo}#${c.issue.number}`);
        return false;
      }
    })().finally(() => inflightIssue.delete(lock));
    inflightIssue.set(lock, run);
    return run;
  }

  /**
   * The owner opened the widget (or it polled): refresh the shown cards' issues, newest first.
   * Waits up to `waitMs`, the rest finishes in the background and shows up on the next poll.
   */
  async function refreshComments(space, comments, waitMs = 1500) {
    const integ = db.spaces[space];
    if (!canSync(integ) || paused(integ)) return;
    const list = comments.filter((c) => c.issue?.provider === 'github').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
    if (!list.length) return;
    const all = (async () => {
      for (const c of list) await refreshIssue(space, c);
    })();
    await Promise.race([all, new Promise((r) => setTimeout(r, waitMs))]);
  }

  /** Remember what has to happen to a reply on GitHub. A newer operation replaces an older one. */
  function enqueueReply(space, commentId, replyId, op, extra = {}) {
    const integ = db.spaces[space];
    if (!integ?.config || integ.disconnected) return;
    const t = threads(integ);
    const key = `${commentId}:${replyId}`;
    const prev = t.replies[key];
    // a create that hasn't run yet already sends the latest text
    if (op === 'edit' && prev && prev.op === 'create') return;
    if (op === 'create' && prev) return;
    t.replies[key] = { commentId, replyId, op, attempts: 0, nextAt: 0, ...extra };
    save();
  }

  function processReply(space, key) {
    const lock = `${space}:${key}`;
    if (inflightReply.has(lock)) return inflightReply.get(lock);
    const run = (async () => {
      const integ = db.spaces[space];
      const op = integ?.threads?.replies?.[key];
      if (!op) return;
      const t = integ.threads;
      const c = findComment(space, op.commentId);
      const reply = c?.replies?.find((r) => r.id === op.replyId);
      const issue = c?.issue ?? op.issue;
      const done = () => {
        if (t.replies[key] === op) delete t.replies[key];
        save();
      };
      if (op.op !== 'delete' && (!reply || reply.origin)) return done(); // deleted meanwhile
      if (!issue) return; // waits for the issue to be created
      if (issue.unavailable) return done(); // nowhere to post
      if (!canSync(integ)) return;
      const guestName = 'Гость';
      try {
        await withGitHub(integ, async (gh) => {
          if (op.op === 'delete') {
            const link = op.link ?? (await findReplyComment(gh, issue, op.replyId));
            if (link) await deleteReplyComment(gh, issue, link);
          } else if (reply.link) {
            if (op.op === 'edit') await updateReplyComment(gh, issue, reply.link, reply, guestName);
          } else {
            const files = await filesFromDisk(reply);
            const link = await postReply(gh, issue, reply, files, { checkExisting: op.attempts > 0 || !!op.checkExisting, guestName });
            reply.link = { provider: 'github', id: link.id, url: link.url };
            persistComments();
          }
        });
        log(`[github] ответ ${op.replyId.slice(0, 8)}: ${op.op} → ${issue.repo}#${issue.number}`);
        done();
      } catch (err) {
        const e = err instanceof GitHubError ? err : new GitHubError('network', String(err?.message ?? err));
        if (e.code === 'unauthorized' && !botInstallation(integ)) markExpired(integ);
        if (t.replies[key] === op) {
          op.attempts++;
          op.nextAt = Date.now() + Math.min(30, 2 ** (op.attempts - 1)) * backoffMs;
          if (e.code === 'rate_limited' && e.resetAt) op.nextAt = Math.max(op.nextAt, e.resetAt);
          if (!e.retryable) op.nextAt = Number.MAX_SAFE_INTEGER; // waits for re-login / new settings
          op.error = e.message;
        }
        save();
        log(`[github] ответ ${op.replyId.slice(0, 8)}: ${e.code} — ${e.message} (повторим позже)`);
      }
    })()
      .catch((err) => console.error(err))
      .finally(() => inflightReply.delete(lock));
    inflightReply.set(lock, run);
    return run;
  }

  /** Send queued reply operations (`force`: ignore backoff). */
  async function drainReplies(space, force = false) {
    const integ = db.spaces[space];
    if (!integ?.threads?.replies || !canSync(integ)) return;
    for (const [key, op] of Object.entries(integ.threads.replies)) {
      if (!force && op.nextAt > Date.now()) continue;
      await processReply(space, key);
      if (!canSync(db.spaces[space])) break;
    }
  }

  /**
   * The thread was closed or reopened in Comenta: close or reopen its issue first. Throws a GitHubError
   * when GitHub can't be reached: the route then answers with the error and keeps the status.
   * Threads without a reachable issue change locally only.
   */
  async function onStatus(space, comment, status) {
    const integ = db.spaces[space];
    const issue = comment.issue;
    if (issue?.provider !== 'github' || issue.unavailable || !integ?.config || integ.disconnected) return;
    if (!canSync(integ)) throw new GitHubError('unauthorized', 'Нет доступа к GitHub, поэтому issue не изменить. Войдите заново на странице настроек GitHub.');
    // replies still queued for this thread go first, so "reply and close" reads in order on GitHub
    for (const key of Object.keys(integ.threads?.replies ?? {})) if (key.startsWith(`${comment.id}:`)) await processReply(space, key);
    try {
      const st = await withGitHub(integ, (gh) => setIssueState(gh, issue, status === 'resolved' ? 'closed' : 'open'));
      applyIssueState(issue, st);
      persistComments();
      log(`[github] ${issue.repo}#${issue.number}: ${st.state === 'closed' ? 'закрыт' : 'открыт'} из Comenta`);
    } catch (err) {
      // deleted or no access: the status lives in Comenta from now on
      if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) {
        applyIssueState(issue, { unavailable: err.status === 410 ? 'deleted' : 'no_access' });
        persistComments();
        return;
      }
      if (err instanceof GitHubError && err.code === 'unauthorized' && !botInstallation(integ)) markExpired(integ);
      throw err;
    }
  }

  // hooks for the feedback routes
  function onReply(space, comment, reply) {
    if (reply.origin) return;
    enqueueReply(space, comment.id, reply.id, 'create');
    void processReply(space, `${comment.id}:${reply.id}`);
  }
  function onReplyEdit(space, comment, reply) {
    if (reply.origin) return;
    enqueueReply(space, comment.id, reply.id, 'edit');
    void processReply(space, `${comment.id}:${reply.id}`);
  }
  function onReplyDelete(space, comment, reply) {
    if (reply.origin) return;
    enqueueReply(space, comment.id, reply.id, 'delete', { link: reply.link, issue: comment.issue });
    void processReply(space, `${comment.id}:${reply.id}`);
  }

  const pollTimer = setInterval(() => {
    for (const space of Object.keys(db.spaces)) void pollSpace(space);
  }, pollMs);
  pollTimer.unref?.();

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
        void drain(space, true).then(() => drainReplies(space, true));
        return void json(res, 200, { config: integ.config });
      }

      json(res, 404, { error: { code: 'not_found', message: 'Нет такого адреса.' } });
    } catch (err) {
      if (err?.status === 413) return void json(res, 413, { error: { code: 'validation', message: 'Слишком большой запрос.' } });
      fail(res, err);
    }
  }

  return {
    oauth,
    bot: !!appAuth,
    handle,
    onComment,
    onReply,
    onReplyEdit,
    onReplyDelete,
    onStatus,
    drain,
    drainReplies,
    pollSpace,
    refreshComments,
    /** The request comes from the signed-in site owner (GitHub session of this space). */
    isOwner: (req, space) => !!session(req, space),
    /** Strip GitHub state and comments for everyone but the owner and each comment's author. */
    forViewer: (list, viewer) => list.map((c) => forViewer(c, viewer)),
    status: (space) => db.spaces[space],
    close: () => (clearInterval(timer), clearInterval(pollTimer)),
  };
}
