import type { FeedbackAttachment, FeedbackIssueLink, FeedbackPayload } from '../types';
import { issueBody, issueTitle, marker, type UploadedAttachment } from '../tracker/format';
import { projectPath, type GitLabClient } from './client';

export interface GitLabTarget {
  /** Numeric project id (preferred: survives renames) or `group/project` path. */
  projectId: number | string;
  /** `group/project`, for the link shown in the thread. Default: read from the created issue. */
  path?: string;
  /** Project page, to make upload links absolute on old GitLab versions. */
  webUrl?: string;
}

export interface GitLabFile {
  attachment: FeedbackAttachment;
  data: Uint8Array | ArrayBuffer | Blob;
}

export interface GitLabSyncOptions {
  /** Look for an issue that already carries this comment's marker first. Default true. */
  checkExisting?: boolean;
  /** Link to the thread on your site (default: page URL + `#comenta=<id>`). */
  threadUrl?: string;
}

export interface GitLabSyncResult extends FeedbackIssueLink {
  /** Issue existed already (found by marker): nothing was created. */
  existed: boolean;
}

export interface GitLabIssueJson {
  id: number;
  iid: number;
  project_id: number;
  title?: string;
  description?: string | null;
  state: 'opened' | 'closed' | string;
  web_url: string;
  updated_at: string;
  closed_at?: string | null;
  closed_by?: { username: string; name?: string | null; avatar_url?: string | null; web_url?: string } | null;
  moved_to_id?: number | null;
  references?: { full?: string };
}

/** `group/project` of an issue: from `references.full` (`group/project#12`) or its URL. */
export function issueProjectPath(issue: Pick<GitLabIssueJson, 'references' | 'web_url'>): string {
  const full = issue.references?.full;
  if (full && full.includes('#')) return full.slice(0, full.lastIndexOf('#'));
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/\d+/.exec(issue.web_url);
  return m ? m[1] : '';
}

/** The link the widget shows, from a created or found issue. */
export function linkOf(issue: GitLabIssueJson, path?: string): FeedbackIssueLink {
  return { provider: 'gitlab', repo: path || issueProjectPath(issue), number: issue.iid, url: issue.web_url, nodeId: String(issue.id), repoId: issue.project_id };
}

/**
 * Turn a comment into a GitLab issue:
 * 1. if a previous attempt already created it (marker in the description), return that issue;
 * 2. upload recordings and screenshots with the project Uploads API;
 * 3. create the issue with the text, the embedded recordings, the element and the page.
 * The create itself is never retried blindly: retry with `checkExisting` (the default).
 */
export async function syncComment(client: GitLabClient, target: GitLabTarget, payload: FeedbackPayload, files: GitLabFile[] = [], opts: GitLabSyncOptions = {}): Promise<GitLabSyncResult> {
  if (opts.checkExisting !== false) {
    const found = await findIssue(client, target, payload.id);
    if (found) return { ...linkOf(found, target.path), existed: true };
  }
  const uploads = files.length ? await uploadFiles(client, target, files) : [];
  const res = await client.request<GitLabIssueJson>('POST', `${projectPath(target.projectId)}/issues`, {
    body: { title: issueTitle(payload, 255), description: issueBody(payload, uploads, { threadUrl: opts.threadUrl, embedMedia: true }) },
    retry: false,
  });
  return { ...linkOf(res.data, target.path), existed: false };
}

/** Issue with this comment's marker, or null. */
export async function findIssue(client: GitLabClient, target: Pick<GitLabTarget, 'projectId'>, commentId: string): Promise<GitLabIssueJson | null> {
  const q = new URLSearchParams({ search: commentId, in: 'description', scope: 'all', per_page: '20' });
  const list = await client.get<GitLabIssueJson[]>(`${projectPath(target.projectId)}/issues?${q}`);
  return (list ?? []).find((i) => (i.description ?? '').includes(marker(commentId))) ?? null;
}

interface UploadJson {
  url: string;
  full_path?: string;
  markdown?: string;
}

/** Upload files to the project (`POST /projects/:id/uploads`). Links are absolute, ready for Markdown anywhere. */
export async function uploadFiles(client: GitLabClient, target: GitLabTarget, files: GitLabFile[]): Promise<UploadedAttachment[]> {
  const out: UploadedAttachment[] = [];
  for (const f of files) {
    const name = f.attachment.name.replace(/[^\w.-]+/g, '_') || `${f.attachment.id}.bin`;
    const blob = f.data instanceof Blob ? f.data : new Blob([f.data instanceof Uint8Array ? (f.data.slice().buffer as ArrayBuffer) : f.data], { type: f.attachment.mimeType });
    const form = new FormData();
    form.append('file', blob, name);
    // a repeated upload only stores the file twice: safe to retry
    const res = await client.request<UploadJson>('POST', `${projectPath(target.projectId)}/uploads`, { body: form, retry: true });
    const url = res.data.full_path ? `${client.baseUrl}${res.data.full_path}` : `${(target.webUrl ?? `${client.baseUrl}/${target.path ?? ''}`).replace(/\/+$/, '')}${res.data.url}`;
    out.push({ attachment: f.attachment, htmlUrl: url, rawUrl: url });
  }
  return out;
}
