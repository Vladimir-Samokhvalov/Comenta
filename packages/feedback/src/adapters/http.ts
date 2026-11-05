import type { FeedbackAdapter, FeedbackFile, FeedbackIssueLink, FeedbackPayload, FeedbackSubmitResult } from '../types';

type HeadersInput = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export interface HttpAdapterOptions {
  /** Base URL. Comments are POSTed here; see `httpAdapter` for the other routes. */
  endpoint: string;
  /** Extra headers, or a function returning them (e.g. to attach a fresh auth token). */
  headers?: HeadersInput;
  /** fetch credentials mode. Default `same-origin`. */
  credentials?: RequestCredentials;
  /** Abort the request after this many ms. Default 15000. */
  timeoutMs?: number;
  /**
   * Read comments back from the server (`GET`), so pins, replies and statuses survive a reload
   * and other people's answers show up. Default true. `false` keeps the old send-only behaviour.
   */
  list?: boolean;
  /** Custom fetch implementation (tests, polyfills). */
  fetch?: typeof fetch;
}

export class FeedbackHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FeedbackHttpError';
  }
}

/**
 * REST adapter. Routes, relative to `endpoint`:
 *
 *   POST   {endpoint}                          new comment (JSON, or multipart with recordings)
 *   GET    {endpoint}?url=<page url>           comments of a page, with `replies` and `status`
 *   GET    {endpoint}                          all comments (the "All pages" tab)
 *   POST   {endpoint}/{id}/replies             new reply (JSON, or multipart with recordings)
 *   PATCH  {endpoint}/{id}/replies/{replyId}   `{ text, updatedAt }`
 *   DELETE {endpoint}/{id}/replies/{replyId}
 *   PATCH  {endpoint}/{id}                     `{ status, by, at }`
 *
 * Multipart bodies carry field `payload` (the JSON) plus one file per attachment named
 * `file:<attachment id>`. If the server answers with JSON `{ "attachments": { "<id>": "<url>" } }`,
 * those URLs are used for playback. A POST answer may carry `{ "issue": { provider, repo, number, url } }`
 * (the issue the backend created); the thread then links to it. GET may answer with an array or `{ "items": [...] }`.
 */
export function httpAdapter(options: HttpAdapterOptions): FeedbackAdapter {
  const { endpoint, credentials = 'same-origin', timeoutMs = 15000 } = options;
  const [base, query = ''] = endpoint.split('?');
  const url = (path = '', params: Record<string, string> = {}) => {
    const q = new URLSearchParams(query);
    for (const [k, v] of Object.entries(params)) q.set(k, v);
    const qs = q.toString();
    return `${base.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}` || endpoint;
  };
  const seg = encodeURIComponent;

  async function request(method: string, target: string, body?: { json?: unknown; payload?: unknown; files?: FeedbackFile[] }): Promise<Response> {
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const extra = typeof options.headers === 'function' ? await options.headers() : options.headers;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    let res: Response;
    try {
      const headers: Record<string, string> = { ...extra };
      let data: BodyInit | undefined;
      if (body?.files?.length) {
        const form = new FormData();
        form.append('payload', JSON.stringify(body.payload));
        for (const f of body.files) form.append(`file:${f.attachment.id}`, f.blob, f.attachment.name);
        data = form; // the browser sets the multipart boundary
      } else if (body) {
        headers['Content-Type'] = 'application/json';
        data = JSON.stringify(body.json ?? body.payload);
      }
      res = await doFetch(target, { method, headers, body: data, credentials, signal: controller?.signal });
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      throw new FeedbackHttpError(aborted ? 'сервер не ответил вовремя' : 'сервер недоступен');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new FeedbackHttpError(`сервер ответил ${res.status}`, res.status);
    return res;
  }

  /** `{ attachments: { id: url }, issue: {...} }` from the answer, when the server sent them. */
  async function fileUrls(res: Response, files: FeedbackFile[]): Promise<void | FeedbackSubmitResult> {
    try {
      const data = (await res.json()) as { attachments?: Record<string, string>; issue?: FeedbackIssueLink };
      const out: FeedbackSubmitResult = {};
      if (files.length && data && typeof data.attachments === 'object' && data.attachments) out.attachmentUrls = data.attachments;
      if (data?.issue && typeof data.issue.url === 'string') out.issue = data.issue;
      return out.attachmentUrls || out.issue ? out : undefined;
    } catch {
      /* no JSON body: fine */
    }
  }

  async function getList(params: Record<string, string>): Promise<FeedbackPayload[]> {
    const res = await request('GET', url('', params));
    const data = (await res.json()) as FeedbackPayload[] | { items?: FeedbackPayload[] };
    const items = Array.isArray(data) ? data : data?.items;
    return Array.isArray(items) ? items : [];
  }

  const adapter: FeedbackAdapter = {
    async submit(payload, files: FeedbackFile[] = []) {
      return fileUrls(await request('POST', url(), { payload, files }), files);
    },
    async reply(commentId, reply, files: FeedbackFile[] = []) {
      return fileUrls(await request('POST', url(`/${seg(commentId)}/replies`), { payload: reply, files }), files);
    },
    async updateReply(commentId, replyId, patch) {
      await request('PATCH', url(`/${seg(commentId)}/replies/${seg(replyId)}`), { json: patch });
    },
    async deleteReply(commentId, replyId) {
      await request('DELETE', url(`/${seg(commentId)}/replies/${seg(replyId)}`));
    },
    async setStatus(commentId, change) {
      await request('PATCH', url(`/${seg(commentId)}`), { json: change });
    },
  };
  if (options.list !== false) {
    adapter.list = (pageUrl) => getList({ url: pageUrl });
    adapter.listAll = () => getList({});
  }
  return adapter;
}
