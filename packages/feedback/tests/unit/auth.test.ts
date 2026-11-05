import { describe, expect, it } from 'vitest';
import { codeChallenge, finishSignIn, googleProvider, isSiteOwner, jwtClaims, keycloakProvider, keycloakRoles, startSignIn, userFrom, yandexProvider } from '../../src/auth';

const google = googleProvider({ clientId: 'gid', clientSecret: 'gsecret' });
const yandex = yandexProvider({ clientId: 'yid', clientSecret: 'ysecret' });
const keycloak = keycloakProvider({ url: 'https://sso.example.com/', realm: 'acme', clientId: 'comenta', clientSecret: 'ksecret' });
const jwt = (claims: object) => `e30.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

describe('auth providers', () => {
  it('Keycloak endpoints come from the server URL and realm', () => {
    expect(keycloak.authorizeUrl).toBe('https://sso.example.com/realms/acme/protocol/openid-connect/auth');
    expect(keycloak.tokenUrl).toBe('https://sso.example.com/realms/acme/protocol/openid-connect/token');
    expect(keycloak.ownerRole).toBe('comenta-owner');
  });

  it('the sign-in URL carries state and an S256 PKCE challenge of the verifier', async () => {
    const s = await startSignIn(google, { redirectUri: 'https://site.example/api/auth/callback/google', loginHint: 'a@b.c' });
    const u = new URL(s.url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('state')).toBe(s.state);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(await codeChallenge(s.verifier));
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('login_hint')).toBe('a@b.c');
    expect(s.state.length).toBeGreaterThanOrEqual(20);
    expect(s.verifier.length).toBeGreaterThanOrEqual(43);
    const y = new URL((await startSignIn(yandex, { redirectUri: 'https://site.example/cb' })).url);
    expect(y.searchParams.has('scope')).toBe(false); // Yandex takes the app's permissions
  });

  it('PKCE challenge matches RFC 7636 appendix B', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('maps profiles of each provider', () => {
    expect(userFrom(google, { sub: '42', name: 'Анна', email: 'Anna@Example.com', email_verified: true, picture: 'https://lh3/x' })).toEqual({
      id: 'google:42', provider: 'google', subject: '42', name: 'Анна', email: 'anna@example.com', emailVerified: true, avatarUrl: 'https://lh3/x', roles: [],
    });
    expect(userFrom(yandex, { id: 7, login: 'ivan', real_name: 'Иван Петров', default_email: 'ivan@yandex.ru', is_avatar_empty: false, default_avatar_id: '1/2' })).toMatchObject({
      id: 'yandex:7', name: 'Иван Петров', email: 'ivan@yandex.ru', emailVerified: true, avatarUrl: 'https://avatars.yandex.net/get-yapic/1%2F2/islands-68',
    });
    const kc = userFrom(keycloak, { sub: 'k1', preferred_username: 'boss', email: 'boss@acme.ru', email_verified: false }, jwt({ realm_access: { roles: ['comenta-owner', 'x'] }, resource_access: { comenta: { roles: ['editor'] }, other: { roles: ['no'] } } }));
    expect(kc).toMatchObject({ id: 'keycloak:k1', name: 'boss', emailVerified: false, roles: ['comenta-owner', 'x', 'editor'] });
    // only https avatars
    expect(userFrom(google, { sub: '1', picture: 'javascript:alert(1)' }).avatarUrl).toBeUndefined();
  });

  it('owner: verified email from the list, or the Keycloak role', () => {
    const rules = { emails: ['Owner@Acme.ru'], providers: [google, keycloak] };
    const base = { provider: 'google', subject: '1', id: 'google:1', name: 'x', roles: [] as string[] };
    expect(isSiteOwner({ ...base, email: 'owner@acme.ru', emailVerified: true }, rules)).toBe(true);
    expect(isSiteOwner({ ...base, email: 'owner@acme.ru', emailVerified: false }, rules)).toBe(false); // unverified never counts
    expect(isSiteOwner({ ...base, email: 'other@acme.ru', emailVerified: true }, rules)).toBe(false);
    expect(isSiteOwner({ ...base, provider: 'keycloak', id: 'keycloak:1', emailVerified: false, roles: ['comenta-owner'] }, rules)).toBe(true);
    // the role means nothing for a provider without ownerRole
    expect(isSiteOwner({ ...base, emailVerified: false, roles: ['comenta-owner'] }, rules)).toBe(false);
  });

  it('jwt helpers tolerate junk', () => {
    expect(jwtClaims('not-a-jwt')).toEqual({});
    expect(jwtClaims(undefined)).toEqual({});
    expect(keycloakRoles({ realm_access: { roles: [1, 'a'] } }, 'c')).toEqual(['a']);
  });

  it('finishSignIn sends the verifier and the secret, and uses "OAuth" for Yandex', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === yandex.tokenUrl) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      return new Response(JSON.stringify({ id: '9', login: 'l', default_email: 'l@ya.ru' }), { status: 200 });
    }) as unknown as typeof fetch;
    const u = await finishSignIn(yandex, { code: 'c', verifier: 'v', redirectUri: 'https://s/cb', fetch: fake });
    expect(u.id).toBe('yandex:9');
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get('code_verifier')).toBe('v');
    expect(form.get('client_secret')).toBe('ysecret');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('OAuth tok');
  });

  it('a failed token exchange is an AuthError with the provider reason', async () => {
    const fake = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }), { status: 400 })) as unknown as typeof fetch;
    await expect(finishSignIn(google, { code: 'c', verifier: 'v', redirectUri: 'https://s/cb', fetch: fake })).rejects.toMatchObject({ code: 'exchange_failed', message: expect.stringContaining('bad code') });
  });
});
