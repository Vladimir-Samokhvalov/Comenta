import { GitHubClient } from './client';
import { GitHubError, MESSAGES } from './errors';

export interface OAuthAppOptions {
  /** Client ID of the GitHub App (not its numeric App ID). */
  clientId: string;
  clientSecret: string;
  /** Default `https://github.com`. */
  webUrl?: string;
  /** Default `https://api.github.com`. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

const web = (url?: string) => (url ?? 'https://github.com').replace(/\/$/, '');

/**
 * Where to send the owner to sign in. `state` must be random and checked in the callback.
 * A GitHub App has no scopes: what the token can do comes from the app's permissions and the
 * repositories chosen when it was installed.
 */
export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; webUrl?: string }): string {
  const q = new URLSearchParams({ client_id: o.clientId, redirect_uri: o.redirectUri, state: o.state, allow_signup: 'false' });
  return `${web(o.webUrl)}/login/oauth/authorize?${q}`;
}

/**
 * Where the owner installs the app and picks repositories. GitHub sends them back to the callback URL
 * with `code` and this `state` when the app has "Request user authorization during installation" on.
 */
export function installUrl(o: { slug: string; state?: string; webUrl?: string }): string {
  return `${web(o.webUrl)}/apps/${encodeURIComponent(o.slug)}/installations/new${o.state ? `?state=${encodeURIComponent(o.state)}` : ''}`;
}

export interface TokenResult {
  token: string;
  /** Present when the app's user tokens expire (the default for GitHub Apps). */
  refreshToken?: string;
  /** When `token` expires, ms since epoch. */
  expiresAt?: number;
}

async function requestToken(o: OAuthAppOptions, params: Record<string, string>): Promise<TokenResult> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(`${web(o.webUrl)}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'comenta-feedback' },
      body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, ...params }),
    });
  } catch {
    throw new GitHubError('network', MESSAGES.network);
  }
  // a GitHub outage must not look like a revoked token: the owner would be asked to sign in for nothing
  if (res.status >= 500) throw new GitHubError('network', MESSAGES.network, { status: res.status });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    if (data.error === 'bad_verification_code') throw new GitHubError('unauthorized', 'Код входа устарел. Нажмите «Войти через GitHub» ещё раз.');
    throw new GitHubError('unauthorized', `Не удалось войти через GitHub${data.error_description ? `: ${data.error_description}` : '.'}`);
  }
  return {
    token: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(data.expires_in ? { expiresAt: Date.now() + data.expires_in * 1000 } : {}),
  };
}

/** Exchange the `code` from the callback for a user access token. Runs on your server: it needs the client secret. */
export function exchangeCode(o: OAuthAppOptions & { code: string; redirectUri: string }): Promise<TokenResult> {
  return requestToken(o, { code: o.code, redirect_uri: o.redirectUri });
}

/**
 * New user access token from a refresh token. Refresh tokens are single-use: store the returned one,
 * and never run two refreshes of one token at once. Throws `unauthorized` once it has expired (6 months).
 */
export function refreshAccessToken(o: OAuthAppOptions & { refreshToken: string }): Promise<TokenResult> {
  return requestToken(o, { grant_type: 'refresh_token', refresh_token: o.refreshToken });
}

/**
 * Revoke the OAuth grant on logout so the token stops working on GitHub's side too.
 * Best effort: resolves false when GitHub refused or was unreachable.
 */
export async function revokeGrant(o: OAuthAppOptions & { token: string }): Promise<boolean> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const basic = typeof btoa === 'function' ? btoa(`${o.clientId}:${o.clientSecret}`) : '';
  try {
    const res = await doFetch(`${(o.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')}/applications/${encodeURIComponent(o.clientId)}/grant`, {
      method: 'DELETE',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', 'User-Agent': 'comenta-feedback' },
      body: JSON.stringify({ access_token: o.token }),
    });
    return res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

export interface GitHubAccount {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  /** Scopes of a classic personal access token (empty for GitHub App and fine-grained tokens). */
  scopes: string[];
}

/** Who the token belongs to. Throws `unauthorized` for an expired or revoked token. */
export async function getAccount(client: GitHubClient): Promise<GitHubAccount> {
  const res = await client.request<{ login: string; name: string | null; avatar_url: string; html_url: string }>('GET', '/user');
  return {
    login: res.data.login,
    name: res.data.name,
    avatarUrl: res.data.avatar_url,
    htmlUrl: res.data.html_url,
    scopes: (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
