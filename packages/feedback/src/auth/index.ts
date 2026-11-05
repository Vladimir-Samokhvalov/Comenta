/*
 * Sign-in of site visitors for your Comenta backend: Google, Yandex ID and Keycloak (or any OpenID Connect
 * provider). Server-only, no dependencies: plain `fetch` and WebCrypto (Node 18+, Deno, Bun, workers).
 *
 *   1. `startSignIn(provider, { redirectUri })` → redirect the browser to `url`; keep `state` and `verifier`
 *      on the server (tie them to a short-lived cookie).
 *   2. On `redirectUri` check `state`, then `finishSignIn(provider, { code, verifier, redirectUri })` → `AuthUser`.
 *   3. Keep the user in your own session (HttpOnly cookie). `isSiteOwner(user, rules)` tells the site owner.
 *
 * The comment author, the owner role and who may edit what come from this user on the server, never from the
 * browser. See demo/auth.mjs for a reference backend.
 */

export type AuthProviderKind = 'google' | 'yandex' | 'oidc';

export interface AuthProvider {
  /** Id in URLs and sessions: `google`, `yandex`, `keycloak`… */
  id: string;
  kind: AuthProviderKind;
  /** Button text: `Google`, `Яндекс`, `Keycloak`. */
  label: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string[];
  /** Keycloak: role (realm or client) that makes a user the site owner. */
  ownerRole?: string;
  /** Where to end the provider's own session on sign-out (Keycloak), if any. */
  logoutUrl?: string;
}

export interface AuthUser {
  /** `<provider>:<subject>`: stable, use it as the comment author id. */
  id: string;
  provider: string;
  subject: string;
  name: string;
  email?: string;
  /** The provider confirmed the email belongs to the user. Only verified emails count for `owners`. */
  emailVerified: boolean;
  avatarUrl?: string;
  /** Keycloak realm and client roles. */
  roles: string[];
}

export type AuthErrorCode = 'denied' | 'invalid_state' | 'exchange_failed' | 'userinfo_failed' | 'not_configured' | 'network';

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'AuthError';
  }
}

interface Endpoints {
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
}

/** Google: create an OAuth client "Web application" in Google Cloud Console, redirect URI `{site}/api/auth/callback/google`. */
export function googleProvider(o: { clientId: string; clientSecret: string; label?: string } & Endpoints): AuthProvider {
  return {
    id: 'google',
    kind: 'google',
    label: o.label ?? 'Google',
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    authorizeUrl: o.authorizeUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: o.tokenUrl ?? 'https://oauth2.googleapis.com/token',
    userinfoUrl: o.userinfoUrl ?? 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: ['openid', 'email', 'profile'],
  };
}

/**
 * Yandex ID: create an app at oauth.yandex.ru (platform "Web services"), redirect URI `{site}/api/auth/callback/yandex`,
 * permissions: login:info, login:email, login:avatar.
 */
export function yandexProvider(o: { clientId: string; clientSecret: string; label?: string } & Endpoints): AuthProvider {
  return {
    id: 'yandex',
    kind: 'yandex',
    label: o.label ?? 'Яндекс',
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    authorizeUrl: o.authorizeUrl ?? 'https://oauth.yandex.ru/authorize',
    tokenUrl: o.tokenUrl ?? 'https://oauth.yandex.ru/token',
    userinfoUrl: o.userinfoUrl ?? 'https://login.yandex.ru/info?format=json',
    scopes: ['login:info', 'login:email', 'login:avatar'],
  };
}

/**
 * Keycloak: a confidential OpenID Connect client (Client authentication on, Standard flow), valid redirect URI
 * `{site}/api/auth/callback/keycloak`. `url` is the server root (`https://sso.example.com`, older versions
 * `https://sso.example.com/auth`). Users with `ownerRole` (realm or client role, default `comenta-owner`) are site owners.
 */
export function keycloakProvider(o: { url: string; realm: string; clientId: string; clientSecret: string; ownerRole?: string; label?: string; id?: string }): AuthProvider {
  const base = `${o.url.replace(/\/+$/, '')}/realms/${encodeURIComponent(o.realm)}/protocol/openid-connect`;
  return {
    id: o.id ?? 'keycloak',
    kind: 'oidc',
    label: o.label ?? 'Keycloak',
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    authorizeUrl: `${base}/auth`,
    tokenUrl: `${base}/token`,
    userinfoUrl: `${base}/userinfo`,
    logoutUrl: `${base}/logout`,
    scopes: ['openid', 'email', 'profile'],
    ownerRole: o.ownerRole ?? 'comenta-owner',
  };
}

// ---------------------------------------------------------------- PKCE & state

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A random URL-safe string (`bytes` of entropy). */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** S256 code challenge of a PKCE verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export interface SignInStart {
  url: string;
  /** Compare with the `state` the provider sends back (and with your state cookie). */
  state: string;
  /** PKCE verifier: keep it server-side, pass it to `finishSignIn`. */
  verifier: string;
}

/** Where to send the browser to sign in. */
export async function startSignIn(p: AuthProvider, o: { redirectUri: string; loginHint?: string }): Promise<SignInStart> {
  const state = randomToken(16);
  const verifier = randomToken(32);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: o.redirectUri,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  if (p.kind === 'yandex') q.set('force_confirm', 'no');
  else q.set('scope', p.scopes.join(' '));
  if (p.kind === 'google') q.set('prompt', 'select_account');
  if (o.loginHint) q.set('login_hint', o.loginHint);
  const sep = p.authorizeUrl.includes('?') ? '&' : '?';
  return { url: `${p.authorizeUrl}${sep}${q}`, state, verifier };
}

type Fetch = typeof fetch;

async function request(doFetch: Fetch, url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch {
    throw new AuthError('network', 'Сервис входа не отвечает. Попробуйте ещё раз.');
  } finally {
    clearTimeout(timer);
  }
}

/** Decode a JWT payload without checking the signature (only for tokens received directly from the token endpoint). */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const part = token?.split('.')[1];
  if (!part) return {};
  try {
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Keycloak roles from an access token: realm roles and this client's roles. */
export function keycloakRoles(claims: Record<string, unknown>, clientId: string): string[] {
  const realm = (claims.realm_access as { roles?: unknown } | undefined)?.roles;
  const client = ((claims.resource_access as Record<string, { roles?: unknown }> | undefined)?.[clientId])?.roles;
  return [...new Set([...(Array.isArray(realm) ? realm : []), ...(Array.isArray(client) ? client : [])].filter((r): r is string => typeof r === 'string'))];
}

/** Exchange the code for tokens and read the user's profile. */
export async function finishSignIn(p: AuthProvider, o: { code: string; verifier: string; redirectUri: string; fetch?: Fetch }): Promise<AuthUser> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  if (!o.code) throw new AuthError('denied', 'Вход отменён.');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: o.code, redirect_uri: o.redirectUri, client_id: p.clientId, client_secret: p.clientSecret, code_verifier: o.verifier });
  const res = await request(doFetch, p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  const tokens = (await res.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tokens.access_token) throw new AuthError('exchange_failed', `Вход не удался: ${tokens.error_description ?? tokens.error ?? `ответ ${res.status}`}.`, res.status);

  const auth = p.kind === 'yandex' ? `OAuth ${tokens.access_token}` : `Bearer ${tokens.access_token}`;
  const info = await request(doFetch, p.userinfoUrl, { headers: { Authorization: auth, Accept: 'application/json' } });
  const u = (await info.json().catch(() => null)) as Record<string, unknown> | null;
  if (!info.ok || !u) throw new AuthError('userinfo_failed', 'Не удалось получить профиль пользователя.', info.status);
  return userFrom(p, u, tokens.access_token);
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Profile JSON of a provider → `AuthUser`. */
export function userFrom(p: AuthProvider, u: Record<string, unknown>, accessToken?: string): AuthUser {
  if (p.kind === 'yandex') {
    const subject = String(u.id ?? '');
    if (!subject) throw new AuthError('userinfo_failed', 'Яндекс не вернул id пользователя.');
    const avatar = !u.is_avatar_empty && str(u.default_avatar_id) ? `https://avatars.yandex.net/get-yapic/${encodeURIComponent(String(u.default_avatar_id))}/islands-68` : undefined;
    const email = str(u.default_email);
    return {
      id: `${p.id}:${subject}`,
      provider: p.id,
      subject,
      name: str(u.real_name) ?? str(u.display_name) ?? str(u.login) ?? 'Пользователь',
      ...(email ? { email: email.toLowerCase() } : {}),
      emailVerified: !!email, // Yandex only gives the account's confirmed address
      ...(avatar ? { avatarUrl: avatar } : {}),
      roles: [],
    };
  }
  const subject = str(u.sub);
  if (!subject) throw new AuthError('userinfo_failed', 'Сервис входа не вернул id пользователя.');
  const email = str(u.email);
  const picture = str(u.picture);
  return {
    id: `${p.id}:${subject}`,
    provider: p.id,
    subject,
    name: str(u.name) ?? ([str(u.given_name), str(u.family_name)].filter(Boolean).join(' ') || undefined) ?? str(u.preferred_username) ?? email ?? 'Пользователь',
    ...(email ? { email: email.toLowerCase() } : {}),
    emailVerified: u.email_verified === true || u.email_verified === 'true',
    ...(picture && /^https:\/\//.test(picture) ? { avatarUrl: picture } : {}),
    roles: p.kind === 'oidc' ? keycloakRoles(jwtClaims(accessToken), p.clientId) : [],
  };
}

export interface OwnerRules {
  /** Verified emails of site owners (any provider). */
  emails?: string[];
  /** Providers by id, for `ownerRole`. */
  providers?: AuthProvider[];
}

/** The site owner: a verified email from `emails`, or (Keycloak) the provider's `ownerRole`. */
export function isSiteOwner(user: AuthUser, rules: OwnerRules): boolean {
  const emails = (rules.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (user.email && user.emailVerified && emails.includes(user.email.toLowerCase())) return true;
  const role = rules.providers?.find((p) => p.id === user.provider)?.ownerRole;
  return !!role && user.roles.includes(role);
}
