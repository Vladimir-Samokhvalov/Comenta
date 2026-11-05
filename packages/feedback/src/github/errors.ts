/**
 * Errors of the GitHub integration. Every error has a stable `code` (for your logic and the
 * settings UI) and a Russian `message` that can be shown to the site owner as is.
 */
export type GitHubErrorCode =
  /** Token expired, revoked or never valid: the owner has to sign in again. */
  | 'unauthorized'
  /** The token lacks an OAuth scope (see `missingScopes`) or repo permission. */
  | 'forbidden'
  /** Issues are turned off in the repository. */
  | 'issues_disabled'
  /** Repository / project not found or not visible to the token. */
  | 'not_found'
  /** Primary or secondary rate limit; see `resetAt` / `retryAfterMs`. */
  | 'rate_limited'
  /** GitHub rejected the input (422). */
  | 'validation'
  /** No connection, timeout or 5xx after retries. */
  | 'network'
  /** The integration is not configured (no token or no repository). */
  | 'not_configured';

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly status?: number;
  /** For `rate_limited`: when the limit resets (ms since epoch). */
  readonly resetAt?: number;
  /** For `rate_limited`: how long GitHub asked to wait. */
  readonly retryAfterMs?: number;
  /** For `forbidden`: scopes the endpoint needs that the token does not have. */
  readonly missingScopes?: string[];

  constructor(
    code: GitHubErrorCode,
    message: string,
    extra: { status?: number; resetAt?: number; retryAfterMs?: number; missingScopes?: string[] } = {},
  ) {
    super(message);
    this.name = 'GitHubError';
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

export const MESSAGES = {
  unauthorized: 'Доступ к GitHub истёк или был отозван. Войдите через GitHub заново.',
  forbidden: 'У токена нет нужных прав в GitHub.',
  issuesDisabled: 'В этом репозитории выключены issues. Включите их в настройках репозитория.',
  notFound: 'Не найдено в GitHub (или нет доступа).',
  network: 'GitHub не отвечает. Попробуйте ещё раз чуть позже.',
  notConfigured: 'Интеграция с GitHub не настроена.',
  validation: 'GitHub отклонил запрос.',
} as const;

export function rateLimitMessage(resetAt?: number, now = Date.now()): string {
  if (!resetAt) return 'GitHub временно ограничил число запросов. Попробуйте через минуту.';
  const min = Math.max(1, Math.ceil((resetAt - now) / 60000));
  return `GitHub временно ограничил число запросов. Попробуйте через ${min} мин.`;
}
