import type { FeedbackAdapter, FeedbackFile, FeedbackPayload, FeedbackSubmitResult } from '../types';
import { normalizeUrl } from '../core/url';

export interface ConsoleAdapterOptions {
  /** localStorage key. Default `comenta:feedback` (falls back to the old `pinhelp:feedback` when empty). */
  storageKey?: string;
  /** Set to false to skip persistence. Default: `localStorage` when available. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | false;
  /** Log submitted payloads to the console. Default true. */
  log?: boolean;
  /**
   * Recordings up to this size are kept in localStorage as `data:` URLs (so they replay after a reload).
   * Bigger ones are not stored. Default 1.5 MB (localStorage is usually limited to ~5 MB).
   */
  maxInlineBytes?: number;
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Development adapter: logs the payload and keeps it in localStorage,
 * so pins survive a reload. No backend required.
 */
const LEGACY_KEY = 'pinhelp:feedback';

export function consoleAdapter(options: ConsoleAdapterOptions = {}): FeedbackAdapter {
  const key = options.storageKey ?? 'comenta:feedback';
  const log = options.log ?? true;
  const maxInline = options.maxInlineBytes ?? 1.5 * 1024 * 1024;
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
      const storage = getStorage();
      let raw = storage?.getItem(key);
      // Comenta used to be called PinHelp: pick up comments saved under the old default key.
      if (raw == null && !options.storageKey) raw = storage?.getItem(LEGACY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  return {
    async submit(payload, files: FeedbackFile[] = []): Promise<void | FeedbackSubmitResult> {
      if (log) console.info('[feedback]', payload, files.length ? files : '');
      const storage = getStorage();
      if (!storage) return;
      const attachmentUrls: Record<string, string> = {};
      for (const f of files) {
        if (f.blob.size <= maxInline) attachmentUrls[f.attachment.id] = await toDataUrl(f.blob);
      }
      const stored: FeedbackPayload = payload.attachments
        ? { ...payload, attachments: payload.attachments.map((a) => (attachmentUrls[a.id] ? { ...a, url: attachmentUrls[a.id] } : a)) }
        : payload;
      const all = read();
      all.push(stored);
      try {
        storage.setItem(key, JSON.stringify(all));
      } catch (err) {
        // quota: keep the comment, drop the inline recordings
        console.warn('[feedback] could not persist recordings to storage', err);
        all[all.length - 1] = payload;
        try {
          storage.setItem(key, JSON.stringify(all));
        } catch {
          /* give up silently */
        }
        return;
      }
      return Object.keys(attachmentUrls).length ? { attachmentUrls } : undefined;
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
