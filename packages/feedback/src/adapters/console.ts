import type { FeedbackAdapter, FeedbackPayload } from '../types';
import { normalizeUrl } from '../core/url';

export interface ConsoleAdapterOptions {
  /** localStorage key. Default `pinhelp:feedback`. */
  storageKey?: string;
  /** Set to false to skip persistence. Default: `localStorage` when available. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | false;
  /** Log submitted payloads to the console. Default true. */
  log?: boolean;
}

/**
 * Development adapter: logs the payload and keeps it in localStorage,
 * so pins survive a reload. No backend required.
 */
export function consoleAdapter(options: ConsoleAdapterOptions = {}): FeedbackAdapter {
  const key = options.storageKey ?? 'pinhelp:feedback';
  const log = options.log ?? true;
  const getStorage = () => {
    if (options.storage === false) return null;
    if (options.storage) return options.storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  const read = (): FeedbackPayload[] => {
    try {
      const raw = getStorage()?.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  return {
    async submit(payload) {
      if (log) console.info('[feedback]', payload);
      const storage = getStorage();
      if (!storage) return;
      const all = read();
      all.push(payload);
      try {
        storage.setItem(key, JSON.stringify(all));
      } catch (err) {
        console.warn('[feedback] could not persist to storage', err);
      }
    },
    async list(pageUrl) {
      const url = normalizeUrl(pageUrl);
      return read().filter((p) => normalizeUrl(p.page.url) === url);
    },
    async listAll() {
      return read();
    },
  };
}
