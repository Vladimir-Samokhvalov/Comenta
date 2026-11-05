/**
 * Errors shared by the tracker integrations (GitHub, GitLab…). Every error has a stable `code`
 * (for your logic and the settings UI), the `provider` it came from, and a Russian `message`
 * that can be shown to the site owner as is.
 */
export type TrackerErrorCode =
  /** Token expired, revoked or never valid: the owner has to sign in again. */
  | 'unauthorized'
  /** The token lacks an OAuth scope (see `missingScopes`) or a permission in the repository / project. */
  | 'forbidden'
  /** Issues are turned off in the repository / project. */
  | 'issues_disabled'
  /** Repository / project / issue not found or not visible to the token. */
  | 'not_found'
  /** Rate limit; see `resetAt` / `retryAfterMs`. */
  | 'rate_limited'
  /** The tracker rejected the input (400 / 422), or the input (e.g. a server URL) is wrong. */
  | 'validation'
  /** No connection, timeout or 5xx after retries. */
  | 'network'
  /** The server's TLS certificate is not trusted (self-signed, expired, wrong host). */
  | 'tls'
  /** The integration is not configured (no token or no repository). */
  | 'not_configured'
  /** The GitHub App was removed from the account / repository (or suspended). */
  | 'uninstalled';

export interface TrackerErrorExtra {
  status?: number;
  resetAt?: number;
  retryAfterMs?: number;
  missingScopes?: string[];
}

export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  /** `github`, `gitlab`… */
  readonly provider: string;
  readonly status?: number;
  /** For `rate_limited`: when the limit resets (ms since epoch). */
  readonly resetAt?: number;
  /** For `rate_limited`: how long the tracker asked to wait. */
  readonly retryAfterMs?: number;
  /** For `forbidden`: scopes the endpoint needs that the token does not have. */
  readonly missingScopes?: string[];

  constructor(provider: string, code: TrackerErrorCode, message: string, extra: TrackerErrorExtra = {}) {
    super(message);
    this.name = 'TrackerError';
    this.provider = provider;
    this.code = code;
    Object.assign(this, extra);
  }

  /** Errors worth retrying later (the sync queue keeps the comment and tries again). */
  get retryable(): boolean {
    return this.code === 'network' || this.code === 'rate_limited';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.status ? { status: this.status } : {}),
      ...(this.resetAt ? { resetAt: new Date(this.resetAt).toISOString() } : {}),
      ...(this.missingScopes?.length ? { missingScopes: this.missingScopes } : {}),
    };
  }
}

/** `Попробуйте через 3 мин.` style wait message. */
export function waitMessage(name: string, resetAt?: number, now = Date.now()): string {
  if (!resetAt) return `${name} временно ограничил число запросов. Попробуйте через минуту.`;
  const min = Math.max(1, Math.ceil((resetAt - now) / 60000));
  return `${name} временно ограничил число запросов. Попробуйте через ${min} мин.`;
}

/** `rel="next"` of a `Link` header (GitHub and GitLab paginate the same way). */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}
