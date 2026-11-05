import { GitLabClient } from './client';
import { GitLabError, GL_MESSAGES, connectionError } from './errors';

/**
 * GitLab OAuth application (User Settings → Applications, or Admin → Applications on your instance):
 * confidential, scopes `api` and `read_user`, redirect URI `{your site}/api/gitlab/auth/callback`.
 * Every GitLab instance has its own applications: gitlab.com credentials don't work on a self-hosted GitLab.
 */
export interface GitLabOAuthOptions {
  /** `https://gitlab.com` or your instance. */
  baseUrl: string;
  /** "Application ID". */
  clientId: string;
  /** "Secret". */
  clientSecret: string;
  /** The redirect URI registered with the application (GitLab checks it on refresh too). */
  redirectUri: string;
  fetch?: typeof fetch;
}

/** Scopes Comenta asks for: issues, notes and uploads need `api`; the account page needs `read_user`. */
export const GITLAB_SCOPES = ['api', 'read_user'] as const;

const base = (url: string) => url.replace(/\/+$/, '');

/** Where to send the owner to sign in. `state` must be random and checked in the callback. */
export function authorizeUrl(o: { baseUrl: string; clientId: string; redirectUri: string; state: string; scopes?: readonly string[] }): string {
  const q = new URLSearchParams({ client_id: o.clientId, redirect_uri: o.redirectUri, response_type: 'code', state: o.state, scope: (o.scopes ?? GITLAB_SCOPES).join(' ') });
  return `${base(o.baseUrl)}/oauth/authorize?${q}`;
}

export interface GitLabTokenResult {
  token: string;
  /** Single-use: every refresh returns a new one. */
  refreshToken?: string;
  /** When `token` expires, ms since epoch (GitLab: two hours after it was issued). */
  expiresAt?: number;
  scopes: string[];
}

async function requestToken(o: GitLabOAuthOptions, params: Record<string, string>): Promise<GitLabTokenResult> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(`${base(o.baseUrl)}/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'comenta-feedback' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, ...params }).toString(),
    });
  } catch (err) {
    throw connectionError(err);
  }
  // an outage must not look like a revoked token: the owner would be asked to sign in for nothing
  if (res.status >= 500 || res.status === 429) throw new GitLabError(res.status === 429 ? 'rate_limited' : 'network', GL_MESSAGES.network, { status: res.status });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; created_at?: number; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      throw new GitLabError('unauthorized', params.grant_type === 'refresh_token' ? GL_MESSAGES.unauthorized : 'Код входа устарел. Нажмите «Войти через GitLab» ещё раз.', { status: res.status });
    }
    if (data.error === 'invalid_client') throw new GitLabError('unauthorized', 'GitLab не узнал OAuth-приложение: проверьте Application ID и Secret на сервере.', { status: res.status });
    throw new GitLabError('unauthorized', `Не удалось войти через GitLab${data.error_description ? `: ${data.error_description}` : '.'}`, { status: res.status });
  }
  const issued = data.created_at ? data.created_at * 1000 : Date.now();
  return {
    token: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(data.expires_in ? { expiresAt: Math.min(issued, Date.now()) + data.expires_in * 1000 } : {}),
    scopes: (data.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

/** Exchange the `code` from the callback for tokens. Runs on your server: it needs the secret. */
export function exchangeCode(o: GitLabOAuthOptions & { code: string }): Promise<GitLabTokenResult> {
  return requestToken(o, { grant_type: 'authorization_code', code: o.code });
}

/**
 * New access token from a refresh token. Refresh tokens are single-use: store the returned one,
 * and never run two refreshes of one token at once. Throws `unauthorized` once it was revoked.
 */
export function refreshAccessToken(o: GitLabOAuthOptions & { refreshToken: string }): Promise<GitLabTokenResult> {
  return requestToken(o, { grant_type: 'refresh_token', refresh_token: o.refreshToken });
}

/** Revoke the token on logout. Best effort: resolves false when GitLab refused or was unreachable. */
export async function revokeToken(o: Omit<GitLabOAuthOptions, 'redirectUri'> & { token: string }): Promise<boolean> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`${base(o.baseUrl)}/oauth/revoke`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'comenta-feedback' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, token: o.token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface GitLabAccount {
  /** `username` */
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  id: number;
}

/** Who the token belongs to. Throws `unauthorized` for an expired or revoked token. */
export async function getAccount(client: GitLabClient): Promise<GitLabAccount> {
  const u = await client.get<{ id: number; username: string; name?: string | null; avatar_url?: string | null; web_url: string }>('/user');
  return { login: u.username, name: u.name ?? null, avatarUrl: u.avatar_url ?? '', htmlUrl: u.web_url, id: u.id };
}

/**
 * Scopes of the token (OAuth: `GET /oauth/token/info`; personal access token: `GET /personal_access_tokens/self`).
 * Null when GitLab didn't say (older versions).
 */
export async function tokenScopes(client: GitLabClient): Promise<string[] | null> {
  const info = await client.request<{ scope?: string[] | string; scopes?: string[] } | null>('GET', `${client.baseUrl}/oauth/token/info`, { allow: [401, 404] });
  if (info.status === 200 && info.data) {
    const s = info.data.scope ?? info.data.scopes;
    return Array.isArray(s) ? s : typeof s === 'string' ? s.split(/\s+/).filter(Boolean) : null;
  }
  const pat = await client.request<{ scopes?: string[] } | null>('GET', '/personal_access_tokens/self', { allow: [401, 403, 404] });
  return pat.status === 200 && Array.isArray(pat.data?.scopes) ? pat.data!.scopes! : null;
}

/** Scopes from `GITLAB_SCOPES` the token lacks (`api` alone is enough for everything). */
export function missingScopes(scopes: string[] | null | undefined): string[] {
  if (!scopes) return [];
  if (scopes.includes('api')) return [];
  return ['api'];
}

/**
 * Check that a GitLab answers at this address before sending the owner there.
 * `GET /api/v4/version` answers 200 (with a token) or 401 with JSON on every GitLab.
 * Throws `validation` (not GitLab), `tls`, or `network` (unknown host, refused, down).
 */
export async function probeInstance(baseUrl: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ version?: string }> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000) : undefined;
  let res: Response;
  try {
    res = await doFetch(`${base(baseUrl)}/api/v4/version`, { headers: { Accept: 'application/json', 'User-Agent': 'comenta-feedback' }, signal: controller?.signal, redirect: 'manual' });
  } catch (err) {
    throw connectionError(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status >= 500) throw new GitLabError('network', GL_MESSAGES.network, { status: res.status });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? ((await res.json().catch(() => null)) as { version?: string; message?: string } | null) : null;
  if ((res.status === 200 && data?.version) || (res.status === 401 && data)) return data?.version ? { version: data.version } : {};
  throw new GitLabError('validation', 'По этому адресу не отвечает GitLab. Проверьте адрес (например, https://gitlab.example.com).', { status: res.status });
}
