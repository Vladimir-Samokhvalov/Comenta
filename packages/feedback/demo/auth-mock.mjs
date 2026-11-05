// Fake Google, Yandex ID and Keycloak at /__auth for the demo and the e2e tests: a page to pick a user,
// the token endpoint (checks the client secret and PKCE) and the profile endpoint of each provider.
// `login_hint=<user key>` on the authorize URL signs in right away (the tests use it).
//
//   /__auth/<google|yandex>/authorize | token | userinfo
//   /__auth/keycloak/realms/<realm>/protocol/openid-connect/auth | token | userinfo
import { createHash, randomBytes } from 'node:crypto';

export const MOCK_AUTH = { clientId: 'comenta-mock', clientSecret: 'mock-secret', realm: 'comenta', ownerEmail: 'vladimir@example.com' };

/** People you can sign in as. Владимир is the site owner (by email, and by Keycloak role). */
export const MOCK_USERS = {
  vladimir: { sub: 'u-vladimir', name: 'Владимир', email: 'vladimir@example.com', roles: ['comenta-owner'] },
  anna: { sub: 'u-anna', name: 'Анна', email: 'anna@example.com', roles: [] },
  boris: { sub: 'u-boris', name: 'Борис', email: 'boris@example.com', roles: [] },
};

const b64url = (s) => Buffer.from(s).toString('base64url');

export function createAuthMock(base) {
  const codes = new Map(); // code → { user, challenge, redirectUri, clientId }
  const tokens = new Map(); // access token → user key
  const html = (res, status, body) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
  const json = (res, status, data) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const readForm = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  };

  function issue(url, key) {
    const code = randomBytes(12).toString('base64url');
    codes.set(code, { user: key, challenge: url.searchParams.get('code_challenge'), redirectUri: url.searchParams.get('redirect_uri'), clientId: url.searchParams.get('client_id') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    return back.toString();
  }

  /** Returns true when the request was handled. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/__auth/')) return false;
    let rest = url.pathname.slice('/__auth/'.length);
    const kind = rest.split('/')[0];
    if (!['google', 'yandex', 'keycloak'].includes(kind)) return false;
    rest = rest.slice(kind.length + 1);
    if (kind === 'keycloak') {
      const m = /^realms\/[^/]+\/protocol\/openid-connect\/(auth|token|userinfo)$/.exec(rest);
      if (!m) return false;
      rest = m[1] === 'auth' ? 'authorize' : m[1];
    }

    if (rest === 'authorize' && req.method === 'GET') {
      if (url.searchParams.get('client_id') !== MOCK_AUTH.clientId) return void html(res, 400, 'unknown client'), true;
      if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) return void html(res, 400, 'PKCE required'), true;
      const hint = url.searchParams.get('login_hint');
      const pick = url.searchParams.get('pick');
      if (url.searchParams.get('deny')) {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        return void res.writeHead(302, { Location: back.toString() }).end(), true;
      }
      const key = (pick ?? hint ?? '').toLowerCase();
      if (MOCK_USERS[key]) return void res.writeHead(302, { Location: issue(url, key) }).end(), true;
      const link = (k) => {
        const u = new URL(url);
        u.searchParams.set('pick', k);
        return `${u.pathname}${u.search}`;
      };
      const deny = new URL(url);
      deny.searchParams.set('deny', '1');
      const title = { google: 'Google', yandex: 'Яндекс ID', keycloak: 'Keycloak' }[kind];
      html(res, 200, `<!doctype html><meta charset="utf-8"><title>Mock ${title}</title><body style="font:15px system-ui;padding:24px;max-width:420px">
<h1 style="font-size:20px">Тестовый вход: ${esc(title)}</h1><p>Выберите, кем войти на сайт.</p>
${Object.entries(MOCK_USERS).map(([k, u]) => `<p><a class="mock-user" data-user="${esc(k)}" href="${esc(link(k))}">${esc(u.name)}</a> <small>${esc(u.email)}${u.roles.length ? ' · владелец' : ''}</small></p>`).join('')}
<p><a id="deny" href="${esc(deny.pathname + deny.search)}">Отмена</a></p>`);
      return true;
    }

    if (rest === 'token' && req.method === 'POST') {
      const f = await readForm(req);
      const c = codes.get(f.code);
      codes.delete(f.code);
      if (f.client_id !== MOCK_AUTH.clientId || f.client_secret !== MOCK_AUTH.clientSecret) return void json(res, 401, { error: 'invalid_client' }), true;
      if (!c || c.redirectUri !== f.redirect_uri) return void json(res, 400, { error: 'invalid_grant', error_description: 'bad code' }), true;
      const challenge = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
      if (challenge !== c.challenge) return void json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }), true;
      const u = MOCK_USERS[c.user];
      // Keycloak's access token is a JWT with the roles in it
      const access = kind === 'keycloak'
        ? `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify({ sub: u.sub, realm_access: { roles: u.roles }, resource_access: {} }))}.mock`
        : `mock_${randomBytes(12).toString('base64url')}`;
      tokens.set(access, c.user);
      json(res, 200, { access_token: access, token_type: 'bearer', expires_in: 300 });
      return true;
    }

    if (rest === 'userinfo' && req.method === 'GET') {
      const header = req.headers.authorization ?? '';
      const expected = kind === 'yandex' ? 'OAuth ' : 'Bearer ';
      const key = header.startsWith(expected) ? tokens.get(header.slice(expected.length)) : undefined;
      if (!key) return void json(res, 401, { error: 'invalid_token' }), true;
      const u = MOCK_USERS[key];
      if (kind === 'yandex') json(res, 200, { id: u.sub, login: key, real_name: u.name, display_name: u.name, default_email: u.email, is_avatar_empty: true });
      else json(res, 200, { sub: u.sub, name: u.name, email: u.email, email_verified: true });
      return true;
    }
    return false;
  }

  return { handle, base };
}
