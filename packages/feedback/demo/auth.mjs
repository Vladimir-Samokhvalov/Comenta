// Sign-in of site visitors for the demo server — a reference implementation of what the widget's `auth`
// option and <comenta-settings> expect. Plain Node, no dependencies besides dist/auth.js.
//
// Routes:
//   GET  /api/auth/me                    → { user: { id, name, email?, avatarUrl?, role? } | null, providers: [{ id, label }] }
//   GET  /api/auth/login/:provider       ?return=/path&popup=1&login_hint=  → redirect to the provider (state + PKCE)
//   GET  /api/auth/callback/:provider    the provider comes back here: session cookie, then back (or closes the popup)
//   POST /api/auth/logout
//
// Env:
//   COMENTA_AUTH=google,yandex,keycloak   which providers to offer (default: every one that is configured)
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   YANDEX_CLIENT_ID / YANDEX_CLIENT_SECRET
//   KEYCLOAK_URL / KEYCLOAK_REALM / KEYCLOAK_CLIENT_ID / KEYCLOAK_CLIENT_SECRET / KEYCLOAK_OWNER_ROLE (default comenta-owner)
//   COMENTA_OWNERS=a@example.com,b@example.com   site owners by verified email (plus Keycloak's owner role)
//   PUBLIC_URL                            site origin for redirect URIs and the Secure cookie flag (default: from Host)
//   AUTH_STORE                            sessions file (default demo/auth.json, mode 600)
//   AUTH_MOCK=1                           fake Google, Yandex and Keycloak at /__auth (demo/auth-mock.mjs). Used
//                                         automatically when no provider is configured, except in NODE_ENV=production.
// Redirect URI to register with each provider: {PUBLIC_URL}/api/auth/callback/<google|yandex|keycloak>.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthError, finishSignIn, googleProvider, isSiteOwner, keycloakProvider, startSignIn, yandexProvider } from '../dist/auth.js';
import { MOCK_AUTH } from './auth-mock.mjs';

const SESSION_COOKIE = 'comenta_session';
const STATE_COOKIE = 'comenta_auth_state';
const SESSION_DAYS = 30;

export function createAuth({ root, mockBase, log = console.log }) {
  const env = process.env;
  const all = [];
  let mock = false;
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) all.push(googleProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }));
  if (env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET) all.push(yandexProvider({ clientId: env.YANDEX_CLIENT_ID, clientSecret: env.YANDEX_CLIENT_SECRET }));
  if (env.KEYCLOAK_URL && env.KEYCLOAK_REALM && env.KEYCLOAK_CLIENT_ID && env.KEYCLOAK_CLIENT_SECRET) {
    all.push(keycloakProvider({ url: env.KEYCLOAK_URL, realm: env.KEYCLOAK_REALM, clientId: env.KEYCLOAK_CLIENT_ID, clientSecret: env.KEYCLOAK_CLIENT_SECRET, ownerRole: env.KEYCLOAK_OWNER_ROLE }));
  }
  if (env.AUTH_MOCK === '1' || (!all.length && env.AUTH_MOCK !== '0' && env.NODE_ENV !== 'production')) {
    mock = true;
    all.length = 0;
    const m = (kind) => ({ clientId: MOCK_AUTH.clientId, clientSecret: MOCK_AUTH.clientSecret, authorizeUrl: `${mockBase}/${kind}/authorize`, tokenUrl: `${mockBase}/${kind}/token`, userinfoUrl: `${mockBase}/${kind}/userinfo` });
    all.push(googleProvider(m('google')), yandexProvider(m('yandex')), keycloakProvider({ url: `${mockBase}/keycloak`, realm: MOCK_AUTH.realm, clientId: MOCK_AUTH.clientId, clientSecret: MOCK_AUTH.clientSecret }));
  }
  const wanted = (env.COMENTA_AUTH ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const providers = wanted.length ? all.filter((p) => wanted.includes(p.id)) : all;
  if (!providers.length && env.NODE_ENV === 'production') throw new Error('Вход посетителей не настроен: задайте GOOGLE_*, YANDEX_* или KEYCLOAK_* (см. demo/auth.mjs).');
  const owners = (env.COMENTA_OWNERS ?? (mock ? MOCK_AUTH.ownerEmail : '')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const storeFile = env.AUTH_STORE ?? join(root, 'demo', 'auth.json');

  /** Sessions are stored by the SHA-256 of their id: a leaked store file does not give working cookies. */
  let db = { sessions: {} };
  try {
    db = { sessions: {}, ...JSON.parse(readFileSync(storeFile, 'utf8')) };
  } catch {
    /* first run */
  }
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(() => writeFile(storeFile, JSON.stringify(db, null, 2), { mode: 0o600 })).catch((e) => console.error(e));
  };
  const hash = (sid) => createHash('sha256').update(sid).digest('base64url');
  const pending = new Map(); // state → { provider, verifier, back, popup, at }

  const origin = (req) => env.PUBLIC_URL?.replace(/\/$/, '') ?? `http://${req.headers.host}`;
  const secure = () => env.PUBLIC_URL?.startsWith('https:');
  const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure() ? '; Secure' : ''}`;
  const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const json = (res, status, data, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(data));
  /** Only paths of this site: `/\evil.com` and `//evil.com` resolve to another origin and are refused. */
  const safeBack = (req, back) => {
    if (typeof back !== 'string' || !back.startsWith('/')) return '/';
    try {
      const u = new URL(back, origin(req));
      return u.origin === new URL(origin(req)).origin ? u.pathname + u.search + u.hash : '/';
    } catch {
      return '/';
    }
  };
  const callbackUrl = (req, p) => `${origin(req)}/api/auth/callback/${p.id}`;

  /** The signed-in user of this request, or null. */
  function user(req) {
    const sid = cookies(req)[SESSION_COOKIE];
    const s = sid && db.sessions[hash(sid)];
    if (!s) return null;
    if (Date.parse(s.expiresAt) < Date.now()) {
      delete db.sessions[hash(sid)];
      save();
      return null;
    }
    return s.user;
  }
  const owner = (u) => !!u && isSiteOwner(u, { emails: owners, providers: all });
  /** What the widget and the server use as the comment author. */
  const authorOf = (u) => ({ id: u.id, name: u.name, ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}), ...(owner(u) ? { role: 'owner' } : {}) });

  /** Small page for the popup: tells the widget in the opener and closes; without an opener goes back. */
  function popupPage(res, back, error) {
    const msg = JSON.stringify({ type: 'comenta:auth', ok: !error, ...(error ? { error } : {}) }).replace(/</g, '\\u003c');
    const body = `<!doctype html><meta charset="utf-8"><title>Comenta</title><body style="font:15px system-ui;padding:24px">
<p>${error ? 'Вход не удался.' : 'Вы вошли.'} Это окно можно закрыть.</p>
<script>(function(){var m=${msg};if(window.opener){window.opener.postMessage(m,location.origin);window.close();}else{location.replace(${JSON.stringify(back).replace(/</g, '\\u003c')});}})();</script>`;
    res.writeHead(error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': res.__cookies ?? [] }).end(body);
  }

  async function handle(req, res, url) {
    const path = url.pathname.slice('/api/auth'.length) || '/';
    if (path === '/me' && req.method === 'GET') {
      const u = user(req);
      return void json(res, 200, { user: u ? { ...authorOf(u), ...(u.email ? { email: u.email } : {}) } : null, providers: providers.map((p) => ({ id: p.id, label: p.label })), ...(mock ? { mock: true } : {}) });
    }

    let m = /^\/login\/([\w-]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const p = providers.find((x) => x.id === m[1]);
      if (!p) return void json(res, 404, { error: { code: 'not_found', message: 'Нет такого способа входа.' } });
      const start = await startSignIn(p, { redirectUri: callbackUrl(req, p), loginHint: url.searchParams.get('login_hint')?.slice(0, 200) || undefined });
      for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
      pending.set(start.state, { provider: p.id, verifier: start.verifier, back: safeBack(req, url.searchParams.get('return')), popup: url.searchParams.get('popup') === '1', at: Date.now() });
      return void res.writeHead(302, { Location: start.url, 'Set-Cookie': cookie(STATE_COOKIE, start.state, 600), 'Cache-Control': 'no-store' }).end();
    }

    m = /^\/callback\/([\w-]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      const saved = pending.get(state);
      pending.delete(state);
      res.__cookies = [cookie(STATE_COOKIE, '', 0)];
      const back = saved?.back ?? '/';
      const fail = (message) => {
        if (saved?.popup) return popupPage(res, back, message);
        const sep = back.includes('?') ? '&' : '?';
        res.writeHead(302, { Location: `${back}${sep}comenta_auth_error=${encodeURIComponent(message)}`, 'Set-Cookie': res.__cookies }).end();
      };
      if (!saved || saved.provider !== m[1] || cookies(req)[STATE_COOKIE] !== state || Date.now() - saved.at > 600_000) return void fail('Ссылка входа устарела. Попробуйте ещё раз.');
      if (url.searchParams.get('error')) return void fail(url.searchParams.get('error') === 'access_denied' ? 'Вход отменён.' : 'Сервис входа вернул ошибку.');
      const p = providers.find((x) => x.id === saved.provider);
      let u;
      try {
        u = await finishSignIn(p, { code: url.searchParams.get('code') ?? '', verifier: saved.verifier, redirectUri: callbackUrl(req, p) });
      } catch (err) {
        if (!(err instanceof AuthError)) console.error(err);
        return void fail(err instanceof AuthError ? err.message : 'Вход не удался.');
      }
      const sid = randomBytes(32).toString('base64url');
      db.sessions[hash(sid)] = { user: u, at: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString() };
      for (const [k, s] of Object.entries(db.sessions)) if (Date.parse(s.expiresAt) < Date.now()) delete db.sessions[k];
      save();
      log(`[auth] вошёл ${u.name} (${u.id}${owner(u) ? ', владелец' : ''})`);
      res.__cookies.push(cookie(SESSION_COOKIE, sid, SESSION_DAYS * 86400));
      if (saved.popup) return void popupPage(res, back);
      return void res.writeHead(302, { Location: back, 'Set-Cookie': res.__cookies }).end();
    }

    if (path === '/logout' && req.method === 'POST') {
      const o = req.headers.origin;
      if (o && o !== origin(req) && o !== `http://${req.headers.host}`) return void json(res, 403, { error: { code: 'forbidden', message: 'Запрос с другого сайта отклонён.' } });
      const sid = cookies(req)[SESSION_COOKIE];
      if (sid && db.sessions[hash(sid)]) {
        delete db.sessions[hash(sid)];
        save();
      }
      return void json(res, 200, { user: null }, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
    }
    json(res, 404, { error: { code: 'not_found', message: 'Нет такого адреса.' } });
  }

  return { providers, mock, owners, handle, user, isOwner: (req) => owner(user(req)), authorOf };
}
