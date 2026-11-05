import { nextLink } from '../tracker/errors';
import { GitHubError, MESSAGES, rateLimitMessage } from './errors';

export interface GitHubClientOptions {
  /**
   * GitHub App user access token or personal access token. Lives on your server only.
   * A function is called before every request: user tokens expire, so it can refresh them.
   */
  token: string | (() => string | Promise<string>);
  /** REST/GraphQL base. Default `https://api.github.com` (GitHub Enterprise: `https://host/api/v3`). */
  apiUrl?: string;
  /** GraphQL endpoint. Default `{apiUrl}/graphql` (Enterprise: `https://host/api/graphql`). */
  graphqlUrl?: string;
  /** Attempts for safe requests on network errors, 5xx and short secondary rate limits. Default 3. */
  retries?: number;
  /** First backoff delay, doubled each attempt. Default 500 ms. */
  retryDelayMs?: number;
  /** Longest `Retry-After` we are willing to sleep inside one request. Default 10 s. */
  maxRetryAfterMs?: number;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  /** Retry this request on 5xx / network errors. Default: true for GET/PUT/DELETE, false for POST/PATCH. */
  retry?: boolean;
  /** Return null instead of throwing for these statuses (e.g. `304` for conditional requests). */
  allow?: number[];
  /** Extra request headers, e.g. `If-None-Match` with a stored ETag. */
  headers?: Record<string, string>;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal GitHub REST + GraphQL client: auth header, JSON, retries with backoff,
 * and errors mapped to `GitHubError` codes (expired token, missing scopes, rate limits…).
 */
export class GitHubClient {
  readonly apiUrl: string;
  private readonly graphqlUrl: string;
  private readonly opts: GitHubClientOptions;

  constructor(opts: GitHubClientOptions) {
    this.opts = opts;
    this.apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.graphqlUrl = opts.graphqlUrl ?? `${this.apiUrl}/graphql`;
  }

  async request<T = unknown>(method: string, path: string, ro: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const retries = Math.max(1, this.opts.retries ?? 3);
    const safe = ro.retry ?? !['POST', 'PATCH'].includes(method);
    const sleep = this.opts.sleep ?? defaultSleep;
    let delay = this.opts.retryDelayMs ?? 500;
    let last: GitHubError | null = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.once<T>(method, path, ro);
      } catch (err) {
        const e = err instanceof GitHubError ? err : new GitHubError('network', MESSAGES.network);
        last = e;
        const secondary = e.code === 'rate_limited' && e.retryAfterMs !== undefined && e.retryAfterMs <= (this.opts.maxRetryAfterMs ?? 10000);
        const transient = e.code === 'network' && safe;
        if (attempt === retries || !(secondary || transient)) throw e;
        await sleep(secondary ? Math.max(e.retryAfterMs ?? 0, delay) : delay);
        delay *= 2;
      }
    }
    throw last ?? new GitHubError('network', MESSAGES.network);
  }

  private async once<T>(method: string, path: string, ro: RequestOptions): Promise<GitHubResponse<T>> {
    const doFetch = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const url = /^https?:/.test(path) ? path : `${this.apiUrl}${path}`;
    const token = typeof this.opts.token === 'function' ? await this.opts.token() : this.opts.token;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20000) : undefined;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.opts.userAgent ?? 'comenta-feedback',
          ...(ro.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...ro.headers,
        },
        body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
        signal: controller?.signal,
      });
    } catch {
      throw new GitHubError('network', MESSAGES.network);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (ro.allow?.includes(res.status)) return { status: res.status, data: null as T, headers: res.headers };
    if (res.ok) {
      const text = res.status === 204 ? '' : await res.text();
      return { status: res.status, data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
    }
    throw await toError(res);
  }

  get<T = unknown>(path: string, ro?: RequestOptions) {
    return this.request<T>('GET', path, ro).then((r) => r.data);
  }

  /** GET every page (Link: rel="next") up to `maxPages`. `key`: the list is wrapped, `{ [key]: [...] }`. */
  async paginate<T>(path: string, maxPages = 10, key?: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < maxPages; i++) {
      const res: GitHubResponse<unknown> = await this.request<unknown>('GET', next);
      const list = key ? (res.data as Record<string, unknown> | null)?.[key] : res.data;
      if (Array.isArray(list)) out.push(...(list as T[]));
      next = nextLink(res.headers.get('link'));
    }
    return out;
  }

  /** GraphQL query. GraphQL errors are mapped to the same codes as REST ones. */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}, ro: { retry?: boolean } = {}): Promise<T> {
    const res = await this.request<{ data?: T; errors?: Array<{ type?: string; message?: string }> }>('POST', this.graphqlUrl, {
      body: { query, variables },
      retry: ro.retry ?? !/^\s*mutation/.test(query),
    });
    const errors = res.data?.errors;
    if (errors?.length) {
      const e = errors[0];
      if (e.type === 'INSUFFICIENT_SCOPES') {
        const scopes = /requires one of the following scopes: \[([^\]]*)\]/.exec(e.message ?? '')?.[1];
        const missing = scopes ? scopes.split(',').map((s) => s.trim().replace(/['"]/g, '')) : undefined;
        throw new GitHubError('forbidden', scopeMessage(missing), { missingScopes: missing });
      }
      if (e.type === 'NOT_FOUND') throw new GitHubError('not_found', MESSAGES.notFound);
      if (e.type === 'FORBIDDEN') throw new GitHubError('forbidden', MESSAGES.forbidden);
      if (e.type === 'RATE_LIMITED') throw new GitHubError('rate_limited', rateLimitMessage());
      if (!res.data?.data) throw new GitHubError('validation', `${MESSAGES.validation} ${e.message ?? ''}`.trim());
    }
    return res.data?.data as T;
  }
}

export function scopeMessage(missing?: string[]): string {
  return missing?.length
    ? `У доступа к GitHub нет прав: ${missing.join(', ')}. Выйдите и войдите через GitHub снова, чтобы выдать их.`
    : MESSAGES.forbidden;
}

async function toError(res: Response): Promise<GitHubError> {
  let body: { message?: string } = {};
  try {
    body = (await res.json()) as { message?: string };
  } catch {
    /* empty body */
  }
  const msg = body?.message ?? '';
  const status = res.status;
  const h = res.headers;
  const retryAfter = h.get('retry-after');
  if (status === 401) return new GitHubError('unauthorized', MESSAGES.unauthorized, { status });
  if ((status === 403 || status === 429) && (retryAfter || h.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(msg))) {
    const reset = Number(h.get('x-ratelimit-reset'));
    const resetAt = reset ? reset * 1000 : undefined;
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    return new GitHubError('rate_limited', rateLimitMessage(resetAt ?? (retryAfterMs ? Date.now() + retryAfterMs : undefined)), { status, resetAt, retryAfterMs });
  }
  if (status === 403) {
    const accepted = (h.get('x-accepted-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const granted = new Set((h.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    // `repo` covers `public_repo`; `project` covers `read:project`
    const covered = (s: string) => granted.has(s) || (s === 'public_repo' && granted.has('repo')) || (s === 'read:project' && granted.has('project'));
    const missing = accepted.length && !accepted.some(covered) ? accepted : undefined;
    return new GitHubError('forbidden', missing ? scopeMessage(missing) : MESSAGES.forbidden, { status, missingScopes: missing });
  }
  if (status === 410 && /issues/i.test(msg)) return new GitHubError('issues_disabled', MESSAGES.issuesDisabled, { status });
  if (status === 404) return new GitHubError('not_found', MESSAGES.notFound, { status });
  if (status === 422) return new GitHubError('validation', `${MESSAGES.validation} ${msg}`.trim(), { status });
  return new GitHubError('network', MESSAGES.network, { status });
}
