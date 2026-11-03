import type { FeedbackAuthor, FeedbackPayload } from '../types';
import { uuid } from './uuid';

const GUEST_KEY = 'comenta:guest';
const SEEN_KEY = 'comenta:seen';

function storage(win: Window): Storage | null {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson<T>(win: Window, key: string): T | null {
  try {
    const raw = storage(win)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(win: Window, key: string, value: unknown) {
  try {
    storage(win)?.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota: identity simply does not persist */
  }
}

/**
 * A visitor the site did not identify: a stable random id in localStorage
 * and, once they typed it, their name.
 */
export interface Guest {
  id: string;
  name?: string;
}

export function loadGuest(win: Window): Guest {
  const g = readJson<Guest>(win, GUEST_KEY);
  if (g && typeof g.id === 'string') return g;
  const fresh = { id: `guest-${uuid()}` };
  writeJson(win, GUEST_KEY, fresh);
  return fresh;
}

export function saveGuestName(win: Window, guest: Guest, name: string) {
  guest.name = name;
  writeJson(win, GUEST_KEY, guest);
}

/** Same person? Compares ids; falls back to names when neither side has an id. */
export function sameAuthor(a: FeedbackAuthor | undefined, b: FeedbackAuthor | undefined): boolean {
  if (!a || !b) return false;
  if (a.id || b.id) return !!a.id && a.id === b.id;
  return !!a.name && a.name === b.name;
}

/** Per-thread "last opened" times, so replies by others after that count as new. */
export class SeenStore {
  private seen: Record<string, string> = {};
  private key = SEEN_KEY;

  constructor(private readonly win: Window, userId: string) {
    this.setUser(userId);
  }

  /** Seen marks are per user (several people may share a browser, e.g. in the demo). */
  setUser(userId: string) {
    this.key = `${SEEN_KEY}:${userId}`;
    this.seen = readJson<Record<string, string>>(this.win, this.key) ?? {};
  }

  /** Re-read (another tab may have marked threads as seen). */
  reload() {
    this.seen = readJson<Record<string, string>>(this.win, this.key) ?? this.seen;
  }

  since(id: string): string | null {
    return this.seen[id] ?? null;
  }

  markSeen(p: FeedbackPayload) {
    this.seen[p.id] = latestActivity(p);
    writeJson(this.win, this.key, this.seen);
  }

  /**
   * A thread is unread when someone else wrote in it after the user last opened it.
   * Threads the user never opened count only if they take part (author, replied) or are the owner.
   */
  isUnread(p: FeedbackPayload, me: FeedbackAuthor): boolean {
    const since = this.seen[p.id];
    const mine = sameAuthor(p.author, me);
    const replies = p.replies ?? [];
    if (!since) {
      const involved = mine || me.role === 'owner' || replies.some((r) => sameAuthor(r.author, me));
      if (!involved) return false;
      // my own fresh comment with no answers is not "new" to me
      if (mine && !replies.some((r) => !sameAuthor(r.author, me))) return false;
      if (me.role === 'owner' && !mine) return true;
      return replies.some((r) => !sameAuthor(r.author, me));
    }
    return replies.some((r) => r.createdAt > since && !sameAuthor(r.author, me));
  }
}

export function latestActivity(p: FeedbackPayload): string {
  let t = p.createdAt;
  for (const r of p.replies ?? []) if (r.createdAt > t) t = r.createdAt;
  return t;
}
