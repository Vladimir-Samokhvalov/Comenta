import type { FeedbackIssueLink, FeedbackPayload, FeedbackReply, FeedbackReplyLink } from '../types';
import type { GitHubClient } from './client';
import { GitHubError } from './errors';
import { attachmentCaption, neutralize, type UploadedAttachment } from './issue';
import { uploadAttachments, type GitHubTarget, type SyncFile } from './sync';

/*
 * Two-way sync of a Comenta thread with its GitHub issue.
 *
 *   GitHub → Comenta: issue state (open / closed + reason) and issue comments, read by polling
 *   with ETags (a `304 Not Modified` answer does not count against the rate limit).
 *   Comenta → GitHub: replies become issue comments signed with the author's name.
 *
 * Everything here is stateless: the caller keeps the ETags, the cursor and the queue
 * (see demo/github.mjs for a reference engine). A webhook handler can feed the same
 * `issueStateOf` / `mergeIssueComments` with `issues` / `issue_comment` event payloads.
 */

/** An issue comment as the REST API returns it (the fields Comenta reads). */
export interface GitHubIssueComment {
  id: number;
  body?: string | null;
  html_url: string;
  /** `https://api.github.com/repos/o/r/issues/12` — present in repository-wide listings. */
  issue_url?: string;
  created_at: string;
  updated_at: string;
  user?: { login: string; avatar_url?: string; html_url?: string; type?: string } | null;
}

/** The part of an issue Comenta mirrors. */
export interface GitHubIssueState {
  number: number;
  state: 'open' | 'closed';
  stateReason: string | null;
  closedAt?: string;
  updatedAt: string;
  /** `owner/name` the issue lives in now (differs from the link after a transfer). */
  repo?: string;
}

interface IssueJson {
  number: number;
  state: string;
  state_reason?: string | null;
  closed_at?: string | null;
  updated_at: string;
  repository_url?: string;
  pull_request?: unknown;
}

const repoPath = (t: Pick<GitHubTarget, 'owner' | 'repo'>) => `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;

/** Hidden marker in a comment Comenta posted: echo protection and idempotent retries. */
export const replyMarker = (replyId: string) => `<!-- comenta:reply=${replyId} -->`;

/** The Comenta reply id a comment was posted for, or null for comments written on GitHub. */
export function replyIdOf(body: string | null | undefined): string | null {
  return /<!-- comenta:reply=([\w-]+) -->/.exec(body ?? '')?.[1] ?? null;
}

/** `{ owner, repo }` of a link's `owner/name`. */
export function targetOf(issue: Pick<FeedbackIssueLink, 'repo'>): { owner: string; repo: string } {
  const [owner = '', repo = ''] = issue.repo.split('/');
  return { owner, repo };
}

export function issueStateOf(json: IssueJson): GitHubIssueState {
  const out: GitHubIssueState = {
    number: json.number,
    state: json.state === 'closed' ? 'closed' : 'open',
    stateReason: json.state === 'closed' ? json.state_reason ?? null : null,
    updatedAt: json.updated_at,
  };
  if (json.state === 'closed' && json.closed_at) out.closedAt = json.closed_at;
  const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(json.repository_url ?? '');
  if (m) out.repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  return out;
}

/** Copy a fresh state onto the link. Returns true when something the widget shows changed. */
export function applyIssueState(link: FeedbackIssueLink, s: GitHubIssueState | { unavailable: NonNullable<FeedbackIssueLink['unavailable']> }): boolean {
  const before = JSON.stringify([link.state, link.stateReason, link.closedAt, link.unavailable]);
  if ('unavailable' in s) {
    link.unavailable = s.unavailable;
  } else if (s.repo && s.repo.toLowerCase() !== link.repo.toLowerCase()) {
    link.unavailable = 'transferred'; // the old link still redirects on GitHub
  } else {
    delete link.unavailable;
    link.state = s.state;
    link.stateReason = s.stateReason;
    if (s.closedAt) link.closedAt = s.closedAt;
    else delete link.closedAt;
  }
  return before !== JSON.stringify([link.state, link.stateReason, link.closedAt, link.unavailable]);
}

export type IssueFetch =
  | { kind: 'unchanged' }
  | { kind: 'ok'; issue: GitHubIssueState; etag?: string }
  | { kind: 'unavailable'; reason: NonNullable<FeedbackIssueLink['unavailable']> };

/**
 * Current state of one issue. Pass the ETag of the previous answer: an unchanged issue
 * costs a `304` and no rate limit. 410 → deleted, 404 → deleted or no access any more,
 * a different repository in the answer → transferred.
 */
export async function fetchIssue(client: GitHubClient, issue: Pick<FeedbackIssueLink, 'repo' | 'number'>, etag?: string): Promise<IssueFetch> {
  const res = await client.request<IssueJson | null>('GET', `${repoPath(targetOf(issue))}/issues/${issue.number}`, {
    allow: [304, 404, 410],
    headers: etag ? { 'If-None-Match': etag } : undefined,
  });
  if (res.status === 304) return { kind: 'unchanged' };
  if (res.status === 410) return { kind: 'unavailable', reason: 'deleted' };
  if (res.status === 404 || !res.data) return { kind: 'unavailable', reason: 'no_access' };
  const state = issueStateOf(res.data);
  if (state.repo && state.repo.toLowerCase() !== issue.repo.toLowerCase()) return { kind: 'unavailable', reason: 'transferred' };
  return { kind: 'ok', issue: state, etag: res.headers.get('etag') ?? undefined };
}

export type CommentsFetch = { kind: 'unchanged' } | { kind: 'ok'; comments: GitHubIssueComment[]; etag?: string; complete: boolean };

/**
 * All comments of one issue (up to `maxPages` × 100). The ETag is that of the first page:
 * on `304` nothing on it changed. `complete` is false when there were more pages than read,
 * so deletions can't be told apart from unread comments.
 */
export async function fetchIssueComments(client: GitHubClient, issue: Pick<FeedbackIssueLink, 'repo' | 'number'>, etag?: string, maxPages = 10): Promise<CommentsFetch> {
  let next: string | null = `${repoPath(targetOf(issue))}/issues/${issue.number}/comments?per_page=100`;
  const comments: GitHubIssueComment[] = [];
  let first: string | undefined;
  for (let page = 0; next && page < maxPages; page++) {
    const res = await client.request<GitHubIssueComment[] | null>('GET', next, {
      allow: page === 0 ? [304, 404, 410] : [404, 410],
      headers: page === 0 && etag ? { 'If-None-Match': etag } : undefined,
    });
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status === 404 || res.status === 410) throw new GitHubError('not_found', 'Issue не найден.', { status: res.status });
    if (page === 0) first = res.headers.get('etag') ?? undefined;
    if (Array.isArray(res.data)) comments.push(...res.data);
    next = nextLink(res.headers.get('link'));
  }
  return { kind: 'ok', comments, etag: first, complete: !next };
}

export interface RepoCursor {
  /** `since` for the issue listing: the newest issue `updated_at` seen. */
  issues: string;
  /** `since` for the comment listing: the newest comment `updated_at` seen. */
  comments: string;
  /** ETags of the first pages of the last answers. */
  etags?: { issues?: string; comments?: string };
}

export interface RepoActivity {
  /** Issues updated since the cursor (pull requests left out); null when unchanged (304). */
  issues: GitHubIssueState[] | null;
  /** Comments created or edited since the cursor, oldest first; null when unchanged (304). */
  comments: Array<GitHubIssueComment & { issueNumber: number }> | null;
  /** Pass it back next time. */
  cursor: RepoCursor;
}

/**
 * Everything that changed in a repository since the cursor, in two requests (plus pages):
 * `GET /repos/{o}/{r}/issues?state=all&since=` and `GET /repos/{o}/{r}/issues/comments?since=`.
 * When nothing changed, the URLs and answers are the same as last time and both are `304`s,
 * which cost no rate limit. Deleted comments don't show up here; `fetchIssueComments` finds them.
 * Pass a date string to start from it.
 */
export async function fetchRepoActivity(client: GitHubClient, target: Pick<GitHubTarget, 'owner' | 'repo'>, from: RepoCursor | string, maxPages = 10): Promise<RepoActivity> {
  const cur: RepoCursor = typeof from === 'string' ? { issues: from, comments: from } : from;
  const base = repoPath(target);
  const q = (since: string) => `state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`;
  const read = async <T extends { updated_at: string }>(path: string, etag: string | undefined, since: string): Promise<{ items: T[] | null; etag?: string; since: string }> => {
    let next: string | null = path;
    const items: T[] = [];
    let first: string | undefined;
    for (let page = 0; next && page < maxPages; page++) {
      const res = await client.request<T[] | null>('GET', next, { allow: page === 0 ? [304] : [], headers: page === 0 && etag ? { 'If-None-Match': etag } : undefined });
      if (res.status === 304) return { items: null, etag, since };
      if (page === 0) first = res.headers.get('etag') ?? undefined;
      if (Array.isArray(res.data)) items.push(...res.data);
      next = nextLink(res.headers.get('link'));
    }
    // oldest first, so the newest item read is a safe cursor even when pages were left unread
    const newest = items.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), since);
    // the cursor moved: the next URL differs, so the old ETag is useless
    return { items, etag: newest === since ? first : undefined, since: newest };
  };
  const iss = await read<IssueJson>(`${base}/issues?${q(cur.issues)}`, cur.etags?.issues, cur.issues);
  const com = await read<GitHubIssueComment>(`${base}/issues/comments?${q(cur.comments)}`, cur.etags?.comments, cur.comments);
  const issues = iss.items ? iss.items.filter((i) => !i.pull_request).map(issueStateOf) : null;
  const comments = com.items
    ? com.items.map((c) => ({ ...c, issueNumber: Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? '')?.[1] ?? 0) })).filter((c) => c.issueNumber > 0)
    : null;
  return { issues, comments, cursor: { issues: iss.since, comments: com.since, etags: { issues: iss.etag, comments: com.etag } } };
}

/** Comment text for a Comenta reply: `**Имя Фамилия:** текст`, recordings, hidden marker. */
export function replyCommentBody(reply: FeedbackReply, uploads: UploadedAttachment[] = [], guest = 'Гость'): string {
  const name = neutralize(reply.author?.name?.trim() || guest).replace(/[*_`]/g, '\\$&').replace(/\s*\n\s*/g, ' ');
  const text = neutralize(reply.text.trim());
  const lines = [text ? `**${name}:** ${text}` : `**${name}:**`];
  const notUploaded = (reply.attachments ?? []).filter((a) => !uploads.some((u) => u.attachment.id === a.id));
  if (uploads.length || notUploaded.length) {
    lines.push('');
    for (const u of uploads) lines.push(u.attachment.mimeType.startsWith('image/') ? `![${u.attachment.name}](${u.rawUrl ?? `${u.htmlUrl}?raw=true`})` : `- [${attachmentCaption(u.attachment)}](${u.htmlUrl})`);
    for (const a of notUploaded) lines.push(`- ${attachmentCaption(a)} (файл не загружен)`);
  }
  lines.push('', replyMarker(reply.id));
  return lines.join('\n');
}

/** The comment Comenta already posted for this reply (found by its marker), or null. */
export async function findReplyComment(client: GitHubClient, issue: Pick<FeedbackIssueLink, 'repo' | 'number'>, replyId: string): Promise<GitHubIssueComment | null> {
  const res = await fetchIssueComments(client, issue);
  return res.kind === 'ok' ? res.comments.find((c) => replyIdOf(c.body) === replyId) ?? null : null;
}

export interface PostReplyOptions {
  /** Look for a comment with this reply's marker first (set on retries). Default false. */
  checkExisting?: boolean;
  /** Where recordings go (default: the issue's repository, `comenta-attachments` branch). */
  target?: Partial<GitHubTarget>;
  guestName?: string;
}

/**
 * Post a Comenta reply as an issue comment. The POST itself is never retried blindly:
 * retry with `checkExisting: true`, which finds the comment an earlier attempt created.
 */
export async function postReply(client: GitHubClient, issue: Pick<FeedbackIssueLink, 'repo' | 'number'>, reply: FeedbackReply, files: SyncFile[] = [], opts: PostReplyOptions = {}): Promise<FeedbackReplyLink & { existed: boolean }> {
  if (opts.checkExisting) {
    const found = await findReplyComment(client, issue, reply.id);
    if (found) return { provider: 'github', id: found.id, url: found.html_url, existed: true };
  }
  const target: GitHubTarget = { ...targetOf(issue), ...opts.target };
  const uploads = files.length ? await uploadAttachments(client, target, `${reply.commentId}/${reply.id}`, files) : [];
  const res = await client.request<GitHubIssueComment>('POST', `${repoPath(targetOf(issue))}/issues/${issue.number}/comments`, {
    body: { body: replyCommentBody(reply, uploads, opts.guestName) },
    retry: false,
  });
  return { provider: 'github', id: res.data.id, url: res.data.html_url, existed: false };
}

/** Rewrite the comment after the reply was edited in Comenta. Recordings links are kept from the old body. */
export async function updateReplyComment(client: GitHubClient, issue: Pick<FeedbackIssueLink, 'repo'>, link: Pick<FeedbackReplyLink, 'id'>, reply: FeedbackReply, guestName?: string): Promise<'updated' | 'gone'> {
  const path = `${repoPath(targetOf(issue))}/issues/comments/${link.id}`;
  let uploads: UploadedAttachment[] = [];
  if (reply.attachments?.length) {
    const old = await client.request<GitHubIssueComment | null>('GET', path, { allow: [404] });
    if (old.status === 404) return 'gone';
    uploads = keepUploadLinks(old.data?.body ?? '', reply);
  }
  const res = await client.request('PATCH', path, { body: { body: replyCommentBody(reply, uploads, guestName) }, allow: [404], retry: true });
  return res.status === 404 ? 'gone' : 'updated';
}

/** Delete the comment of a reply deleted in Comenta. A comment that is already gone is fine. */
export async function deleteReplyComment(client: GitHubClient, issue: Pick<FeedbackIssueLink, 'repo'>, link: Pick<FeedbackReplyLink, 'id'>): Promise<void> {
  await client.request('DELETE', `${repoPath(targetOf(issue))}/issues/comments/${link.id}`, { allow: [404] });
}

function keepUploadLinks(body: string, reply: FeedbackReply): UploadedAttachment[] {
  const out: UploadedAttachment[] = [];
  for (const a of reply.attachments ?? []) {
    const caption = attachmentCaption(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`\\[${caption}\\]\\(([^)\\s]+)\\)`).exec(body);
    if (m) out.push({ attachment: a, htmlUrl: m[1] });
  }
  return out;
}

/** A reply in the widget for a comment written on GitHub. */
export function replyFromComment(c: GitHubIssueComment, commentId: string): FeedbackReply {
  const login = c.user?.login ?? 'ghost';
  const reply: FeedbackReply = {
    id: `github-${c.id}`,
    commentId,
    text: (c.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim(),
    createdAt: c.created_at,
    author: { id: `github:${login.toLowerCase()}`, name: login, ...(c.user?.avatar_url ? { avatarUrl: c.user.avatar_url } : {}), ...(c.user?.html_url ? { url: c.user.html_url } : {}) },
    origin: 'github',
    link: { provider: 'github', id: c.id, url: c.html_url },
  };
  if (c.updated_at && c.updated_at !== c.created_at) reply.updatedAt = c.updated_at;
  return reply;
}

export interface MergeResult {
  /** The thread's replies after the merge (a new array when `changed`). */
  replies: FeedbackReply[];
  changed: boolean;
  /** Comenta replies whose GitHub comment was found by its marker (link was missing). */
  linked: string[];
}

/**
 * Bring GitHub comments into a thread:
 * - comments carrying a Comenta reply marker are our own replies: only their link is recorded (no echo);
 * - new comments become replies with `origin: 'github'`, edited ones are updated;
 * - `complete`: the list is every comment of the issue, so imported replies missing from it were deleted.
 */
export function mergeIssueComments(payload: Pick<FeedbackPayload, 'id' | 'replies'>, comments: GitHubIssueComment[], opts: { complete?: boolean } = {}): MergeResult {
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
        replies[i] = { ...replies[i], link: { provider: 'github', id: c.id, url: c.html_url } };
        linked.push(own);
        changed = true;
      }
      continue;
    }
    const fresh = replyFromComment(c, payload.id);
    const i = replies.findIndex((r) => r.origin === 'github' && String(r.link?.id) === String(c.id));
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
    out = replies.filter((r) => r.origin !== 'github' || seen.has(String(r.link?.id)));
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
 * What a viewer may see. GitHub discussions can be internal, so only the site owner and the
 * comment's own author get the issue state and the replies written on GitHub.
 * Call it on your server for every list answer. `true` / `false` is shorthand for owner / nobody.
 */
export function forViewer<T extends FeedbackPayload>(payload: T, viewer: Viewer | boolean): T {
  const v: Viewer = typeof viewer === 'boolean' ? { owner: viewer } : viewer;
  if (v.owner || (!!v.id && payload.author?.id === v.id)) return payload;
  const out = { ...payload };
  if (out.issue) {
    const { state: _s, stateReason: _r, closedAt: _c, unavailable: _u, ...link } = out.issue;
    out.issue = link;
  }
  if (out.replies?.some((r) => r.origin)) out.replies = out.replies.filter((r) => !r.origin);
  return out;
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}
