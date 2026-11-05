import type { FeedbackAttachment, FeedbackIssueLink, FeedbackPayload, FeedbackReply } from '../types';
import { attachmentLines, attachmentCaption, neutralize, type UploadedAttachment } from './format';

/*
 * Provider-neutral part of the two-way thread ↔ issue sync. Each tracker (GitHub, GitLab…)
 * turns its own JSON into `TrackerIssueState` / `TrackerComment`; everything else — which
 * comments are ours, what changed, who may see what, the thread's single status — is here.
 */

/** Human name of a provider, for messages and the widget: `GitHub`, `GitLab`. */
export function providerName(provider: string | undefined): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'gitlab') return 'GitLab';
  return provider ?? '';
}

/** A comment on the issue, the same for every tracker. */
export interface TrackerComment {
  id: number | string;
  body: string;
  /** Link to the comment on the tracker. */
  url: string;
  createdAt: string;
  updatedAt?: string;
  author?: { login: string; name?: string | null; avatarUrl?: string; url?: string } | null;
}

/** The part of an issue Comenta mirrors. */
export interface TrackerIssueState {
  number: number;
  state: 'open' | 'closed';
  /** Why it was closed (GitHub's `state_reason`; GitLab has none: null). */
  stateReason: string | null;
  closedAt?: string;
  updatedAt: string;
  /** `owner/name` (GitHub) or the project path (GitLab) the issue lives in now. */
  repo?: string;
  /** The issue was moved to another project (GitLab "Move issue"). */
  moved?: boolean;
  /** Who closed it, when the answer says so. */
  closedBy?: { login: string; name?: string | null; avatarUrl?: string; url?: string };
}

/** Hidden marker in a comment Comenta posted: echo protection and idempotent retries. */
export const replyMarker = (replyId: string) => `<!-- comenta:reply=${replyId} -->`;

/** The Comenta reply id a comment was posted for, or null for comments written on the tracker. */
export function replyIdOf(body: string | null | undefined): string | null {
  return /<!-- comenta:reply=([\w-]+) -->/.exec(body ?? '')?.[1] ?? null;
}

/**
 * Copy a fresh state onto the link. Returns true when something the widget shows changed.
 * A snapshot older than the one applied last (`stateAt`) is ignored, so a poll that was already
 * on its way can't undo a close or reopen made a moment ago.
 */
export function applyIssueState(link: FeedbackIssueLink, s: TrackerIssueState | { unavailable: NonNullable<FeedbackIssueLink['unavailable']> }): boolean {
  const before = JSON.stringify([link.state, link.stateReason, link.closedAt, link.unavailable]);
  if ('unavailable' in s) {
    link.unavailable = s.unavailable;
  } else if (s.moved || (s.repo && s.repo.toLowerCase() !== link.repo.toLowerCase())) {
    link.unavailable = 'transferred'; // the old link still redirects on the tracker
  } else {
    delete link.unavailable;
    if (link.stateAt && s.updatedAt < link.stateAt) return false;
    link.state = s.state;
    link.stateReason = s.stateReason;
    link.stateAt = s.updatedAt;
    if (s.closedAt) link.closedAt = s.closedAt;
    else delete link.closedAt;
  }
  return before !== JSON.stringify([link.state, link.stateReason, link.closedAt, link.unavailable]);
}

/**
 * One status for the thread and its issue: make the thread's status follow the issue
 * (closed on the tracker → `resolved`, reopened → `open`). Call after `applyIssueState`.
 * Returns true when the thread changed. Does nothing for unavailable issues: their status lives in Comenta.
 */
export function applyIssueStatus(payload: FeedbackPayload, s?: Pick<TrackerIssueState, 'closedBy'>): boolean {
  const link = payload.issue;
  if (!link?.state || link.unavailable) return false;
  const via = link.provider;
  const before = JSON.stringify([payload.status, payload.resolvedBy, payload.resolvedAt, payload.resolvedVia]);
  if (link.state === 'closed') {
    const known = payload.status === 'resolved';
    const by = s?.closedBy;
    // closed in Comenta (we closed the issue ourselves) keeps its author; closed on the tracker names its user
    if (!known || (payload.resolvedVia === via && by)) {
      payload.status = 'resolved';
      payload.resolvedVia = via;
      payload.resolvedAt = link.closedAt ?? payload.resolvedAt ?? new Date().toISOString();
      if (by) payload.resolvedBy = { id: `${via}:${by.login.toLowerCase()}`, name: by.name || by.login, ...(by.avatarUrl ? { avatarUrl: by.avatarUrl } : {}), ...(by.url ? { url: by.url } : {}) };
      else if (!known) delete payload.resolvedBy;
    }
  } else if (payload.status === 'resolved') {
    payload.status = 'open';
    delete payload.resolvedBy;
    delete payload.resolvedAt;
    delete payload.resolvedVia;
  }
  return before !== JSON.stringify([payload.status, payload.resolvedBy, payload.resolvedAt, payload.resolvedVia]);
}

export interface ReplyBodyOptions {
  guestName?: string;
  /** See `BodyOptions.embedMedia`. */
  embedMedia?: boolean;
}

/** Comment text for a Comenta reply: `**Имя Фамилия:** текст`, recordings, hidden marker. */
export function replyCommentBody(reply: FeedbackReply, uploads: UploadedAttachment[] = [], opts: ReplyBodyOptions | string = {}): string {
  const o = typeof opts === 'string' ? { guestName: opts } : opts;
  const name = neutralize(reply.author?.name?.trim() || o.guestName || 'Гость').replace(/[*_`]/g, '\\$&').replace(/\s*\n\s*/g, ' ');
  const text = neutralize(reply.text.trim());
  const lines = [text ? `**${name}:** ${text}` : `**${name}:**`];
  const media = attachmentLines(reply.attachments, uploads, o.embedMedia);
  if (media.length) lines.push('', ...media);
  lines.push('', replyMarker(reply.id));
  return lines.join('\n');
}

/** Upload links of an earlier version of a reply's comment, so an edit keeps them. */
export function keepUploadLinks(body: string, attachments: FeedbackAttachment[] | undefined): UploadedAttachment[] {
  const out: UploadedAttachment[] = [];
  for (const a of attachments ?? []) {
    const caption = attachmentCaption(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`\\[${caption}\\]\\(([^)\\s]+)\\)`).exec(body);
    if (m) out.push({ attachment: a, htmlUrl: m[1], rawUrl: m[1] });
  }
  return out;
}

/** A reply in the widget for a comment written on the tracker. */
export function replyFromComment(c: TrackerComment, commentId: string, provider: string): FeedbackReply {
  const login = c.author?.login ?? 'ghost';
  const reply: FeedbackReply = {
    id: `${provider}-${c.id}`,
    commentId,
    text: (c.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim(),
    createdAt: c.createdAt,
    author: {
      id: `${provider}:${login.toLowerCase()}`,
      name: c.author?.name || login,
      ...(c.author?.avatarUrl ? { avatarUrl: c.author.avatarUrl } : {}),
      ...(c.author?.url ? { url: c.author.url } : {}),
    },
    origin: provider,
    link: { provider, id: c.id, url: c.url },
  };
  if (c.updatedAt && c.updatedAt !== c.createdAt) reply.updatedAt = c.updatedAt;
  return reply;
}

export interface MergeResult {
  /** The thread's replies after the merge (a new array when `changed`). */
  replies: FeedbackReply[];
  changed: boolean;
  /** Comenta replies whose tracker comment was found by its marker (link was missing). */
  linked: string[];
}

/**
 * Bring tracker comments into a thread:
 * - comments carrying a Comenta reply marker are our own replies: only their link is recorded (no echo);
 * - new comments become replies with `origin: <provider>`, edited ones are updated;
 * - `complete`: the list is every comment of the issue, so imported replies missing from it were deleted.
 * Idempotent: merging the same list twice changes nothing.
 */
export function mergeComments(payload: Pick<FeedbackPayload, 'id' | 'replies'>, comments: TrackerComment[], opts: { provider: string; complete?: boolean }): MergeResult {
  const { provider } = opts;
  const replies = [...(payload.replies ?? [])];
  let changed = false;
  const linked: string[] = [];
  const seen = new Set<string>();
  for (const c of comments) {
    seen.add(String(c.id));
    const own = replyIdOf(c.body);
    if (own) {
      const i = replies.findIndex((r) => r.id === own);
      if (i !== -1 && !replies[i].link) {
        replies[i] = { ...replies[i], link: { provider, id: c.id, url: c.url } };
        linked.push(own);
        changed = true;
      }
      continue;
    }
    const fresh = replyFromComment(c, payload.id, provider);
    const i = replies.findIndex((r) => r.origin === provider && String(r.link?.id) === String(c.id));
    if (i === -1) {
      replies.push(fresh);
      changed = true;
    } else if (JSON.stringify(replies[i]) !== JSON.stringify(fresh)) {
      replies[i] = fresh;
      changed = true;
    }
  }
  let out = replies;
  if (opts.complete) {
    out = replies.filter((r) => r.origin !== provider || seen.has(String(r.link?.id)));
    if (out.length !== replies.length) changed = true;
  }
  if (changed) out = out.map((r, i) => [r, i] as const).sort(([a, ai], [b, bi]) => a.createdAt.localeCompare(b.createdAt) || ai - bi).map(([r]) => r);
  return { replies: out, changed, linked };
}

/** Who is looking at the list: the site owner, or a visitor with their author id (site user or guest). */
export interface Viewer {
  owner?: boolean;
  /** `author.id` of the person, as the widget sends it in comments and replies. */
  id?: string;
}

/**
 * What a viewer may see. Tracker discussions can be internal, so only the site owner and the
 * comment's own author get the issue state and the replies written on the tracker.
 * Call it on your server for every list answer. `true` / `false` is shorthand for owner / nobody.
 */
export function forViewer<T extends FeedbackPayload>(payload: T, viewer: Viewer | boolean): T {
  const v: Viewer = typeof viewer === 'boolean' ? { owner: viewer } : viewer;
  if (v.owner || (!!v.id && payload.author?.id === v.id)) return payload;
  const out = { ...payload };
  if (out.issue) {
    const { state: _s, stateReason: _r, closedAt: _c, unavailable: _u, stateAt: _t, ...link } = out.issue;
    out.issue = link;
  }
  if (out.replies?.some((r) => r.origin)) out.replies = out.replies.filter((r) => !r.origin);
  // they see that the thread is closed, not who closed it on the tracker
  if (out.resolvedVia) {
    delete out.resolvedBy;
    delete out.resolvedVia;
  }
  return out;
}
