import { GitHubClient } from './client';
import { GitHubError, MESSAGES } from './errors';

/**
 * OAuth App scopes the integration asks for:
 * - `repo`: create issues and upload recordings, private repositories included
 *   (use `public_repo` via `scopes` if you only need public ones);
 * - `project`: list Projects v2 and add issues to them;
 * - `read:org`: see projects and repositories of the owner's organisations;
 * - `read:user`: show the account in the settings.
 */
export const DEFAULT_SCOPES = ['repo', 'project', 'read:org', 'read:user'];

export interface OAuthAppOptions {
  clientId: string;
  clientSecret: string;
  /** Default `https://github.com`. */
  webUrl?: string;
  /** Default `https://api.github.com`. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

/** Where to send the owner to sign in. `state` must be random and checked in the callback. */
export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; scopes?: string[]; webUrl?: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: (o.scopes ?? DEFAULT_SCOPES).join(' '),
    state: o.state,
    allow_signup: 'false',
  });
  return `${(o.webUrl ?? 'https://github.com').replace(/\/$/, '')}/login/oauth/authorize?${q}`;
}

export interface TokenResult {
  token: string;
  scopes: string[];
}

/** Exchange the `code` from the callback for an access token. Runs on your server: it needs the client secret. */
export async function exchangeCode(o: OAuthAppOptions & { code: string; redirectUri: string }): Promise<TokenResult> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(`${(o.webUrl ?? 'https://github.com').replace(/\/$/, '')}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'comenta-feedback' },
      body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, code: o.code, redirect_uri: o.redirectUri }),
    });
  } catch {
    throw new GitHubError('network', MESSAGES.network);
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    if (data.error === 'bad_verification_code') throw new GitHubError('unauthorized', 'Код входа устарел. Нажмите «Войти через GitHub» ещё раз.');
    throw new GitHubError('unauthorized', `Не удалось войти через GitHub${data.error_description ? `: ${data.error_description}` : '.'}`);
  }
  return { token: data.access_token, scopes: (data.scope ?? '').split(/[,\s]+/).filter(Boolean) };
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
  /** OAuth scopes of the token (empty for fine-grained tokens, which have no scopes). */
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
