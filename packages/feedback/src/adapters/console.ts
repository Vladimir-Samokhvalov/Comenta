import type { FeedbackAdapter, FeedbackAttachment, FeedbackFile, FeedbackPayload, FeedbackSubmitResult } from '../types';
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

  /** Inline small recordings as data: URLs so they replay after a reload. */
  const inline = async (files: FeedbackFile[]) => {
    const urls: Record<string, string> = {};
    for (const f of files) {
      if (f.blob.size <= maxInline) urls[f.attachment.id] = await toDataUrl(f.blob);
    }
    return urls;
  };
  const withUrls = <T extends { attachments?: FeedbackAttachment[] }>(item: T, urls: Record<string, string>): T =>
    item.attachments ? { ...item, attachments: item.attachments.map((a) => (urls[a.id] ? { ...a, url: urls[a.id] } : a)) } : item;
  /** Write; on quota errors retry once without inline recordings (`fallback`). */
  const write = (all: FeedbackPayload[], fallback?: () => FeedbackPayload[]): boolean => {
    const storage = getStorage();
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify(all));
      return true;
    } catch (err) {
      console.warn('[feedback] could not persist recordings to storage', err);
      if (!fallback) return false;
      try {
        storage.setItem(key, JSON.stringify(fallback()));
      } catch {
        /* give up silently */
      }
      return false;
    }
  };
  const mutate = (commentId: string, fn: (p: FeedbackPayload) => FeedbackPayload) => {
    const all = read();
    const i = all.findIndex((p) => p.id === commentId);
    if (i === -1) throw new Error('комментарий не найден');
    all[i] = fn(all[i]);
    write(all);
  };

  return {
    async submit(payload, files: FeedbackFile[] = []): Promise<void | FeedbackSubmitResult> {
      if (log) console.info('[feedback]', payload, files.length ? files : '');
      if (!getStorage()) return;
      const urls = await inline(files);
      const all = read();
      all.push(withUrls(payload, urls));
      const ok = write(all, () => [...all.slice(0, -1), payload]);
      return ok && Object.keys(urls).length ? { attachmentUrls: urls } : undefined;
    },
    async list(pageUrl) {
      const url = normalizeUrl(pageUrl);
      return read().filter((p) => normalizeUrl(p.page.url) === url);
    },
    async listAll() {
      return read();
    },
    async reply(commentId, reply, files: FeedbackFile[] = []) {
      if (log) console.info('[feedback] reply', reply, files.length ? files : '');
      if (!getStorage()) return;
      const urls = await inline(files);
      const stored = withUrls(reply, urls);
      const all = read();
      const i = all.findIndex((p) => p.id === commentId);
      if (i === -1) throw new Error('комментарий не найден');
      const before = all[i];
      all[i] = { ...before, replies: [...(before.replies ?? []), stored] };
      const ok = write(all, () => {
        all[i] = { ...before, replies: [...(before.replies ?? []), reply] };
        return all;
      });
      return ok && Object.keys(urls).length ? { attachmentUrls: urls } : undefined;
    },
    async updateReply(commentId, replyId, patch) {
      mutate(commentId, (p) => ({ ...p, replies: (p.replies ?? []).map((r) => (r.id === replyId ? { ...r, ...patch } : r)) }));
    },
    async deleteReply(commentId, replyId) {
      mutate(commentId, (p) => ({ ...p, replies: (p.replies ?? []).filter((r) => r.id !== replyId) }));
    },
    async setStatus(commentId, change) {
      if (log) console.info('[feedback] status', commentId, change);
      mutate(commentId, (p) => {
        const next: FeedbackPayload = { ...p, status: change.status };
        if (change.status === 'resolved') {
          next.resolvedBy = change.by;
          next.resolvedAt = change.at;
        } else {
          delete next.resolvedBy;
          delete next.resolvedAt;
        }
        return next;
      });
    },
    subscribe(onChange) {
      // other tabs of the same site write to the same localStorage
      const win = typeof window !== 'undefined' ? window : null;
      if (!win || options.storage !== undefined) return () => {};
      const fn = (e: StorageEvent) => {
        if (e.key === key) onChange();
      };
      win.addEventListener('storage', fn);
      return () => win.removeEventListener('storage', fn);
    },
  };
}
