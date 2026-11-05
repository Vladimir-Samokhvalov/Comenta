import { GitHubClient, type GitHubClientOptions } from './client';
import { GitHubError, MESSAGES } from './errors';

/**
 * GitHub App authentication (what Claude, Vercel, Netlify… use):
 * - the site owner signs in with the app (user access token, ~8 h, refreshed with a refresh token)
 *   and installs it on the repositories they choose;
 * - comments are turned into issues with a short-lived **installation token** that the server mints
 *   from the app's private key. Issues are authored by `<app>[bot]`, and access ends when the owner
 *   removes the app or a repository from it on GitHub.
 */
export interface GitHubAppCredentials {
  /** Numeric App ID from the app's settings page. */
  appId: string | number;
  /** Private key (.pem) generated on the app's settings page. PKCS#1 ("BEGIN RSA PRIVATE KEY") or PKCS#8. */
  privateKey: string;
  /** REST base. Default `https://api.github.com`. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------- JWT (RS256, WebCrypto)

const b64url = (input: Uint8Array | string) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToDer(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, pkcs1 };
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

/** Wrap a PKCS#1 RSA key (what GitHub hands out) into PKCS#8 (what WebCrypto imports). */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  const total = inner.length + pkcs1.length;
  const out = new Uint8Array(1 + derLength(total).length + total);
  out.set([0x30, ...derLength(total), ...inner]);
  out.set(pkcs1, out.length - pkcs1.length);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function importKey(pem: string): Promise<CryptoKey> {
  let k = keyCache.get(pem);
  if (!k) {
    const { der, pkcs1 } = pemToDer(pem);
    const pkcs8 = pkcs1 ? pkcs1ToPkcs8(der) : der;
    k = crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    k.catch(() => keyCache.delete(pem));
    keyCache.set(pem, k);
  }
  return k;
}

/** A 9-minute JWT that authenticates as the app itself (iat is backdated 60 s for clock drift). */
export async function createAppJwt(appId: string | number, privateKey: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
  let key: CryptoKey;
  try {
    key = await importKey(privateKey);
  } catch {
    throw new GitHubError('not_configured', 'Не удалось прочитать приватный ключ GitHub App (GITHUB_APP_PRIVATE_KEY).');
  }
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- installation tokens

export interface InstallationToken {
  token: string;
  /** ms since epoch */
  expiresAt: number;
}

/**
 * Mints and caches installation tokens (they live 1 h; a new one is minted 5 min before expiry).
 * `uninstalled` errors mean the owner removed the app on GitHub.
 */
export class GitHubAppAuth {
  private readonly creds: GitHubAppCredentials;
  private readonly cache = new Map<string, InstallationToken>();
  private readonly pending = new Map<string, Promise<InstallationToken>>();

  constructor(creds: GitHubAppCredentials) {
    this.creds = creds;
  }

  /** Client that authenticates as the app (JWT): `/app`, `/app/installations/...`. */
  async appClient(opts: Partial<GitHubClientOptions> = {}): Promise<GitHubClient> {
    return new GitHubClient({ token: await createAppJwt(this.creds.appId, this.creds.privateKey), apiUrl: this.creds.apiUrl, fetch: this.creds.fetch, ...opts });
  }

  async installationToken(installationId: string | number): Promise<InstallationToken> {
    const id = String(installationId);
    const hit = this.cache.get(id);
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      const client = await this.appClient();
      try {
        const res = await client.request<{ token: string; expires_at: string }>('POST', `/app/installations/${encodeURIComponent(id)}/access_tokens`, { retry: true });
        const t = { token: res.data.token, expiresAt: Date.parse(res.data.expires_at) || Date.now() + 3600_000 };
        this.cache.set(id, t);
        return t;
      } catch (err) {
        if (err instanceof GitHubError && (err.code === 'not_found' || err.code === 'forbidden')) {
          throw new GitHubError('uninstalled', MESSAGES.uninstalled, { status: err.status });
        }
        if (err instanceof GitHubError && err.code === 'unauthorized') {
          throw new GitHubError('not_configured', 'GitHub не принял ключ приложения: проверьте GITHUB_APP_ID и GITHUB_APP_PRIVATE_KEY.', { status: err.status });
        }
        throw err;
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, p);
    return p;
  }

  /** Client acting as the installation (issues, contents, projects of the installed repos). */
  async installationClient(installationId: string | number, opts: Partial<GitHubClientOptions> = {}): Promise<GitHubClient> {
    const { token } = await this.installationToken(installationId);
    return new GitHubClient({ token, apiUrl: this.creds.apiUrl, fetch: this.creds.fetch, ...opts });
  }

  /** Forget a cached token (e.g. after a 401). */
  forget(installationId: string | number) {
    this.cache.delete(String(installationId));
  }
}
