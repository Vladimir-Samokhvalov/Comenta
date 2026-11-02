import type { FeedbackAdapter, FeedbackFile, FeedbackPayload, FeedbackSubmitResult } from '../types';

type HeadersInput = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export interface HttpAdapterOptions {
  /** Where to POST the payload as JSON. */
  endpoint: string;
  /** Extra headers, or a function returning them (e.g. to attach a fresh auth token). */
  headers?: HeadersInput;
  /** fetch credentials mode. Default `same-origin`. */
  credentials?: RequestCredentials;
  /** Abort the request after this many ms. Default 15000. */
  timeoutMs?: number;
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
 * Without files the payload is POSTed as JSON. With recordings it is sent as
 * `multipart/form-data`: field `payload` (JSON) plus one file field per attachment
 * named `file:<attachment id>`. If the server answers with JSON
 * `{ "attachments": { "<id>": "<url>" } }`, those URLs are used for playback.
 */
export function httpAdapter(options: HttpAdapterOptions): FeedbackAdapter {
  const { endpoint, credentials = 'same-origin', timeoutMs = 15000 } = options;
  return {
    async submit(payload: FeedbackPayload, files: FeedbackFile[] = []): Promise<void | FeedbackSubmitResult> {
      const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
      const extra = typeof options.headers === 'function' ? await options.headers() : options.headers;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      let res: Response;
      try {
        let body: BodyInit;
        const headers: Record<string, string> = { ...extra };
        if (files.length) {
          const form = new FormData();
          form.append('payload', JSON.stringify(payload));
          for (const f of files) form.append(`file:${f.attachment.id}`, f.blob, f.attachment.name);
          body = form; // the browser sets the multipart boundary
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(payload);
        }
        res = await doFetch(endpoint, {
          method: 'POST',
          headers,
          body,
          credentials,
          signal: controller?.signal,
        });
      } catch (err) {
        const aborted = (err as { name?: string })?.name === 'AbortError';
        throw new FeedbackHttpError(aborted ? 'сервер не ответил вовремя' : 'сервер недоступен');
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!res.ok) {
        throw new FeedbackHttpError(`сервер ответил ${res.status}`, res.status);
      }
      if (!files.length) return;
      try {
        const data = (await res.json()) as { attachments?: Record<string, string> };
        if (data && typeof data.attachments === 'object') return { attachmentUrls: data.attachments };
      } catch {
        /* no JSON body: fine */
      }
    },
  };
}
