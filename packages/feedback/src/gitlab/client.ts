import { nextLink } from '../tracker/errors';
import { GitLabError, GL_MESSAGES, connectionError, rateLimitMessage } from './errors';

export interface GitLabClientOptions {
  /** Where GitLab lives: `https://gitlab.com` or your instance, e.g. `https://git.example.com` (a sub-path is fine). */
  baseUrl: string;
  /**
   * OAuth access token or personal access token. Lives on your server only.
   * A function is called before every request: OAuth tokens live two hours, so it can refresh them.
   */
  token: string | (() => string | Promise<string>);
  /** Attempts for safe requests on network errors, 5xx and short rate limits. Default 3. */
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

export interface GitLabRequestOptions {
  /** JSON body, or `FormData` for uploads. */
  body?: unknown;
  /** Retry on 5xx / network errors. Default: true for GET/PUT/DELETE, false for POST. */
  retry?: boolean;
  /** Return null instead of throwing for these statuses (e.g. `304`, `404`). */
  allow?: number[];
  headers?: Record<string, string>;
}

export interface GitLabResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Normalise what the owner typed as the GitLab address: `gitlab.example.com`, `https://git.example.com/gitlab/`,
 * `https://gitlab.com/api/v4` → `https://git.example.com/gitlab`. Only http(s); `http:` only for
 * localhost unless `allowHttp`. Throws `validation` with a readable message.
 */
export function normalizeBaseUrl(input: string, opts: { allowHttp?: boolean } = {}): string {
  let raw = String(input ?? '').trim();
  if (!raw) throw new GitLabError('validation', 'Укажите адрес GitLab, например https://gitlab.com.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GitLabError('validation', 'Это не похоже на адрес GitLab. Пример: https://gitlab.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new GitLabError('validation', 'Адрес GitLab должен начинаться с https://');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && !local && !opts.allowHttp) throw new GitLabError('validation', 'Нужен адрес с https://: по http токен уходил бы в открытом виде.');
  if (u.username || u.password) throw new GitLabError('validation', 'Уберите логин и пароль из адреса GitLab.');
  if (!u.hostname.includes('.') && !local) throw new GitLabError('validation', 'Это не похоже на адрес GitLab. Пример: https://gitlab.example.com');
  const path = u.pathname
    .replace(/\/+$/, '')
    .replace(/\/api\/v4$/, '')
    .replace(/\/(users\/sign_in|explore|dashboard.*|-\/.*)$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Minimal GitLab REST v4 client: auth header, JSON and multipart, retries with backoff,
 * and errors mapped to `GitLabError` codes (expired token, missing scopes, rate limits, TLS…).
 */
export class GitLabClient {
  readonly baseUrl: string;
  readonly apiUrl: string;
  private readonly opts: GitLabClientOptions;

  constructor(opts: GitLabClientOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiUrl = `${this.baseUrl}/api/v4`;
  }

  async request<T = unknown>(method: string, path: string, ro: GitLabRequestOptions = {}): Promise<GitLabResponse<T>> {
    const retries = Math.max(1, this.opts.retries ?? 3);
    const safe = ro.retry ?? method !== 'POST';
    const sleep = this.opts.sleep ?? defaultSleep;
    let delay = this.opts.retryDelayMs ?? 500;
    let last: GitLabError | null = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.once<T>(method, path, ro);
      } catch (err) {
        const e = err instanceof GitLabError ? err : new GitLabError('network', GL_MESSAGES.network);
        last = e;
        const shortWait = e.code === 'rate_limited' && e.retryAfterMs !== undefined && e.retryAfterMs <= (this.opts.maxRetryAfterMs ?? 10000);
        // a wrong address or certificate won't fix itself in a second
        const transient = e.code === 'network' && safe && e.message === GL_MESSAGES.network;
        if (attempt === retries || !(shortWait || transient)) throw e;
        await sleep(shortWait ? Math.max(e.retryAfterMs ?? 0, delay) : delay);
        delay *= 2;
      }
    }
    throw last ?? new GitLabError('network', GL_MESSAGES.network);
  }

  private async once<T>(method: string, path: string, ro: GitLabRequestOptions): Promise<GitLabResponse<T>> {
    const doFetch = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const url = /^https?:/.test(path) ? path : `${this.apiUrl}${path}`;
    const token = typeof this.opts.token === 'function' ? await this.opts.token() : this.opts.token;
    const form = typeof FormData !== 'undefined' && ro.body instanceof FormData;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20000) : undefined;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': this.opts.userAgent ?? 'comenta-feedback',
          ...(ro.body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
          ...ro.headers,
        },
        body: ro.body === undefined ? undefined : form ? (ro.body as FormData) : JSON.stringify(ro.body),
        signal: controller?.signal,
      });
    } catch (err) {
      throw connectionError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (ro.allow?.includes(res.status)) return { status: res.status, data: null as T, headers: res.headers };
    if (res.ok) {
      const text = res.status === 204 ? '' : await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // an HTML page with 200: a proxy or not GitLab at all
        throw new GitLabError('validation', 'По этому адресу отвечает не GitLab API. Проверьте адрес GitLab.', { status: res.status });
      }
      return { status: res.status, data: data as T, headers: res.headers };
    }
    throw await toError(res);
  }

  get<T = unknown>(path: string, ro?: GitLabRequestOptions) {
    return this.request<T>('GET', path, ro).then((r) => r.data);
  }

  /** GET every page (`Link: rel="next"`) up to `maxPages`. Returns the items and whether pages were left. */
  async paginate<T>(path: string, maxPages = 10): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < maxPages; i++) {
      const res: GitLabResponse<unknown> = await this.request<unknown>('GET', next);
      if (Array.isArray(res.data)) items.push(...(res.data as T[]));
      next = nextLink(res.headers.get('link'));
    }
    return { items, complete: !next };
  }
}

/** `/projects/:id` with a numeric id or an URL-encoded path (`group%2Fproject`). */
export const projectPath = (id: number | string) => `/projects/${encodeURIComponent(String(id))}`;

async function toError(res: Response): Promise<GitLabError> {
  let body: { message?: unknown; error?: string; error_description?: string; scope?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* empty or HTML body */
  }
  const msg = typeof body.message === 'string' ? body.message : body.message ? JSON.stringify(body.message) : body.error_description ?? body.error ?? '';
  const status = res.status;
  const h = res.headers;
  if (status === 401) return new GitLabError('unauthorized', GL_MESSAGES.unauthorized, { status });
  if (status === 429 || (status === 403 && /rate limit|throttl/i.test(msg))) {
    const retryAfter = Number(h.get('retry-after'));
    const reset = Number(h.get('ratelimit-reset'));
    const resetAt = reset ? reset * 1000 : retryAfter ? Date.now() + retryAfter * 1000 : undefined;
    return new GitLabError('rate_limited', rateLimitMessage(resetAt), { status, resetAt, retryAfterMs: retryAfter ? retryAfter * 1000 : undefined });
  }
  if (status === 403) {
    // OAuth / PAT without the needed scope: `{ error: "insufficient_scope", scope: "api" }` + WWW-Authenticate
    const www = h.get('www-authenticate') ?? '';
    if (body.error === 'insufficient_scope' || /insufficient_scope/.test(www)) {
      const scope = body.scope ?? /scope="([^"]+)"/.exec(www)?.[1] ?? 'api';
      const missing = scope.split(/[\s,]+/).filter(Boolean);
      return new GitLabError('forbidden', GL_MESSAGES.scopes(missing), { status, missingScopes: missing });
    }
    return new GitLabError('forbidden', GL_MESSAGES.forbidden, { status });
  }
  if (status === 404) return new GitLabError('not_found', GL_MESSAGES.notFound, { status });
  if (status === 400 || status === 422 || status === 409) return new GitLabError('validation', `${GL_MESSAGES.validation} ${msg}`.trim(), { status });
  return new GitLabError('network', GL_MESSAGES.network, { status });
}
