import type { FeedbackAdapter, FeedbackPayload } from '../types';

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

export function httpAdapter(options: HttpAdapterOptions): FeedbackAdapter {
  const { endpoint, credentials = 'same-origin', timeoutMs = 15000 } = options;
  return {
    async submit(payload: FeedbackPayload) {
      const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
      const extra = typeof options.headers === 'function' ? await options.headers() : options.headers;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extra },
          body: JSON.stringify(payload),
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
    },
  };
}
