import type { FeedbackIssueLink, FeedbackPayload, FeedbackReply, FeedbackReplyLink } from '../types';
import type { UploadedAttachment } from '../tracker/format';
import { keepUploadLinks, mergeComments, replyCommentBody, replyIdOf, type MergeResult, type TrackerComment, type TrackerIssueState } from '../tracker/threads';
import { projectPath, type GitLabClient } from './client';
import { GitLabError } from './errors';
import { uploadFiles, type GitLabFile, type GitLabIssueJson } from './sync';

/*
 * Two-way sync of a Comenta thread with its GitLab issue.
 *
 *   GitLab → Comenta: issue state (opened / closed) and notes, read by polling.
 *   Comenta → GitLab: replies become notes signed with the author's name.
 *
 * Stateless like the GitHub part: the caller keeps cursors and the queue (see demo/gitlab.mjs).
 * System notes ("closed", "changed the description"…) and internal notes are never imported:
 * internal notes are for project members only, and comment authors may be guests.
 */

type IssueRef = Pick<FeedbackIssueLink, 'repo' | 'number' | 'repoId'> & { url?: string };

/** Project of a link: the stable numeric id when known, the path otherwise. */
export const projectOf = (issue: Pick<FeedbackIssueLink, 'repo' | 'repoId'>) => issue.repoId ?? issue.repo;
const issuePath = (issue: IssueRef) => `${projectPath(projectOf(issue))}/issues/${issue.number}`;

/** A note as the REST API returns it (the fields Comenta reads). */
export interface GitLabNote {
  id: number;
  body: string;
  system?: boolean;
  internal?: boolean;
  confidential?: boolean;
  created_at: string;
  updated_at?: string;
  author?: { username: string; name?: string | null; avatar_url?: string | null; web_url?: string } | null;
}

/**
 * The state Comenta mirrors. An issue moved to another project ("Move issue": the original is closed
 * with `moved_to_id`), or answering from another project than the link's, counts as transferred.
 */
export function issueStateOf(json: GitLabIssueJson, link?: Pick<FeedbackIssueLink, 'repoId'>): TrackerIssueState {
  const closed = json.state === 'closed';
  const out: TrackerIssueState = { number: json.iid, state: closed ? 'closed' : 'open', stateReason: null, updatedAt: json.updated_at };
  if (closed && json.closed_at) out.closedAt = json.closed_at;
  if (closed && json.closed_by?.username) {
    const b = json.closed_by;
    out.closedBy = { login: b.username, ...(b.name ? { name: b.name } : {}), ...(b.avatar_url ? { avatarUrl: b.avatar_url } : {}), ...(b.web_url ? { url: b.web_url } : {}) };
  }
  if (json.moved_to_id || (link?.repoId !== undefined && String(json.project_id) !== String(link.repoId))) out.moved = true;
  return out;
}

/** Close or reopen the issue (`state_event`). Throws `GitLabError`: the caller shows it and keeps the status. */
export async function setIssueState(client: GitLabClient, issue: IssueRef, state: 'open' | 'closed'): Promise<TrackerIssueState> {
  const res = await client.request<GitLabIssueJson>('PUT', issuePath(issue), { body: { state_event: state === 'closed' ? 'close' : 'reopen' }, retry: true });
  return issueStateOf(res.data, issue);
}

export type GitLabIssueFetch =
  | { kind: 'unchanged' }
  | { kind: 'ok'; issue: TrackerIssueState; etag?: string }
  | { kind: 'unavailable'; reason: NonNullable<FeedbackIssueLink['unavailable']> };

/**
 * Current state of one issue. GitLab answers 404 both for a deleted issue and for lost access;
 * a moved issue is reported as transferred. Pass the previous ETag: an unchanged issue may answer 304.
 */
export async function fetchIssue(client: GitLabClient, issue: IssueRef, etag?: string): Promise<GitLabIssueFetch> {
  const res = await client.request<GitLabIssueJson | null>('GET', issuePath(issue), { allow: [304, 404], headers: etag ? { 'If-None-Match': etag } : undefined });
  if (res.status === 304) return { kind: 'unchanged' };
  if (res.status === 404 || !res.data) return { kind: 'unavailable', reason: 'no_access' };
  const state = issueStateOf(res.data, issue);
  if (state.moved) return { kind: 'unavailable', reason: 'transferred' };
  return { kind: 'ok', issue: state, etag: res.headers.get('etag') ?? undefined };
}

/** The provider-neutral view of a note. */
export function commentOf(n: GitLabNote, issueUrl: string): TrackerComment {
  const a = n.author;
  return {
    id: n.id,
    body: n.body ?? '',
    url: `${issueUrl.split('#')[0]}#note_${n.id}`,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    author: a ? { login: a.username, ...(a.name ? { name: a.name } : {}), ...(a.avatar_url ? { avatarUrl: a.avatar_url } : {}), ...(a.web_url ? { url: a.web_url } : {}) } : null,
  };
}

/** A note people wrote (not a system note, not internal). */
export const isPublicNote = (n: GitLabNote) => !n.system && !n.internal && !n.confidential;

/**
 * Every public note of the issue, oldest first (up to `maxPages` × 100). `complete` is false when
 * pages were left unread, so deletions can't be told apart from unread notes.
 */
export async function fetchNotes(client: GitLabClient, issue: IssueRef & { url: string }, maxPages = 10): Promise<{ comments: TrackerComment[]; notes: GitLabNote[]; complete: boolean }> {
  const res = await client.request<GitLabNote[] | null>('GET', `${issuePath(issue)}/notes?sort=asc&order_by=created_at&per_page=100`, { allow: [404] });
  if (res.status === 404) throw new GitLabError('not_found', 'Issue не найден.', { status: 404 });
  const notes = [...(res.data ?? [])];
  let next = nextOf(res.headers);
  for (let page = 1; next && page < maxPages; page++) {
    const more = await client.request<GitLabNote[]>('GET', next);
    notes.push(...(more.data ?? []));
    next = nextOf(more.headers);
  }
  const shown = notes.filter(isPublicNote);
  return { comments: shown.map((n) => commentOf(n, issue.url)), notes, complete: !next };
}

const nextOf = (h: Headers) => /<([^>]+)>\s*;\s*rel="next"/.exec(h.get('link') ?? '')?.[1] ?? null;

export interface ProjectCursor {
  /** `updated_after` for the issue listing: the newest issue `updated_at` seen. */
  issues: string;
}

export interface ProjectActivity {
  /** Issues updated since the cursor, oldest first. */
  issues: Array<TrackerIssueState & { projectId: number }>;
  cursor: ProjectCursor;
}

/**
 * Issues of the project updated since the cursor, in one request (plus pages). A new or edited
 * note also bumps its issue's `updated_at`, so the caller re-reads the notes of the issues listed here.
 * GitLab has no project-wide notes listing.
 */
export async function fetchProjectActivity(client: GitLabClient, projectId: number | string, from: ProjectCursor | string, maxPages = 5): Promise<ProjectActivity> {
  const cur: ProjectCursor = typeof from === 'string' ? { issues: from } : from;
  const q = new URLSearchParams({ updated_after: cur.issues, order_by: 'updated_at', sort: 'asc', scope: 'all', state: 'all', per_page: '100' });
  const { items } = await client.paginate<GitLabIssueJson>(`${projectPath(projectId)}/issues?${q}`, maxPages);
  const newest = items.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), cur.issues);
  return { issues: items.map((i) => ({ ...issueStateOf(i), projectId: i.project_id })), cursor: { issues: newest } };
}

/**
 * Bring notes into a thread (see `mergeComments`): our own replies are only linked,
 * new notes become replies with `origin: 'gitlab'`, edits follow, and with `complete` deletions too.
 */
export function mergeNotes(payload: Pick<FeedbackPayload, 'id' | 'replies'>, comments: TrackerComment[], opts: { complete?: boolean } = {}): MergeResult {
  return mergeComments(payload, comments, { provider: 'gitlab', complete: opts.complete });
}

/** The note Comenta already posted for this reply (found by its marker), or null. */
export async function findReplyNote(client: GitLabClient, issue: IssueRef & { url: string }, replyId: string): Promise<{ id: number; url: string } | null> {
  const { notes } = await fetchNotes(client, issue);
  const n = notes.find((x) => replyIdOf(x.body) === replyId);
  return n ? { id: n.id, url: `${issue.url.split('#')[0]}#note_${n.id}` } : null;
}

export interface PostNoteOptions {
  /** Look for a note with this reply's marker first (set on retries). Default false. */
  checkExisting?: boolean;
  guestName?: string;
}

/**
 * Post a Comenta reply as a note, signed `**Имя Фамилия:** текст`, recordings embedded.
 * The POST is never retried blindly: retry with `checkExisting: true`.
 */
export async function postNote(client: GitLabClient, issue: IssueRef & { url: string }, reply: FeedbackReply, files: GitLabFile[] = [], opts: PostNoteOptions = {}): Promise<FeedbackReplyLink & { existed: boolean }> {
  if (opts.checkExisting) {
    const found = await findReplyNote(client, issue, reply.id);
    if (found) return { provider: 'gitlab', id: found.id, url: found.url, existed: true };
  }
  const uploads = files.length ? await uploadFiles(client, { projectId: projectOf(issue), path: issue.repo }, files) : [];
  const res = await client.request<GitLabNote>('POST', `${issuePath(issue)}/notes`, {
    body: { body: replyCommentBody(reply, uploads, { guestName: opts.guestName, embedMedia: true }) },
    retry: false,
  });
  return { provider: 'gitlab', id: res.data.id, url: `${issue.url.split('#')[0]}#note_${res.data.id}`, existed: false };
}

/** Rewrite the note after the reply was edited in Comenta. Recording links are kept from the old body. */
export async function updateNote(client: GitLabClient, issue: IssueRef, link: Pick<FeedbackReplyLink, 'id'>, reply: FeedbackReply, guestName?: string): Promise<'updated' | 'gone'> {
  const path = `${issuePath(issue)}/notes/${encodeURIComponent(String(link.id))}`;
  let uploads: UploadedAttachment[] = [];
  if (reply.attachments?.length) {
    const old = await client.request<GitLabNote | null>('GET', path, { allow: [404] });
    if (old.status === 404) return 'gone';
    uploads = keepUploadLinks(old.data?.body ?? '', reply.attachments);
  }
  const res = await client.request('PUT', path, { body: { body: replyCommentBody(reply, uploads, { guestName, embedMedia: true }) }, allow: [404], retry: true });
  return res.status === 404 ? 'gone' : 'updated';
}

/** Delete the note of a reply deleted in Comenta. A note that is already gone is fine. */
export async function deleteNote(client: GitLabClient, issue: IssueRef, link: Pick<FeedbackReplyLink, 'id'>): Promise<void> {
  await client.request('DELETE', `${issuePath(issue)}/notes/${encodeURIComponent(String(link.id))}`, { allow: [404] });
}
