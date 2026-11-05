import type { FeedbackAttachment, FeedbackIssueLink, FeedbackPayload } from '../types';
import type { GitHubClient } from './client';
import { GitHubError } from './errors';
import { issueBody, issueTitle, marker, type UploadedAttachment } from './issue';

export interface GitHubTarget {
  owner: string;
  repo: string;
  /** Projects v2 node id. Absent: the issue is not added to a project. */
  projectId?: string;
  /** Branch that keeps recordings. Default `comenta-attachments` (created as an orphan branch). */
  attachmentsBranch?: string;
  /** Folder on that branch; each comment gets `<folder>/<comment id>/`. Default `comenta`. */
  attachmentsDir?: string;
}

export interface SyncFile {
  attachment: FeedbackAttachment;
  data: Uint8Array | ArrayBuffer | Blob;
}

export interface SyncOptions {
  /**
   * Search the repository for an issue that already carries this comment's marker before creating one.
   * Default true. Pass false on the very first attempt to save a search request.
   */
  checkExisting?: boolean;
  /** Link to the thread on your site (default: page URL + `#comenta=<id>`). */
  threadUrl?: string;
}

export interface SyncResult extends FeedbackIssueLink {
  /** Issue existed already (found by marker): nothing was created. */
  existed: boolean;
  /** The issue was created but adding it to the project failed (message for the owner). */
  projectError?: string;
}

const repoPath = (t: GitHubTarget) => `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;

/**
 * Turn a comment into a GitHub issue:
 * 1. if a previous attempt already created it (marker in the body), return that issue;
 * 2. upload recordings to the attachments branch, one folder per comment (re-uploads are skipped);
 * 3. create the issue with the text, element, page and links to the recordings;
 * 4. add it to the Project v2, if one is configured (adding twice is harmless).
 */
export async function syncComment(client: GitHubClient, target: GitHubTarget, payload: FeedbackPayload, files: SyncFile[] = [], opts: SyncOptions = {}): Promise<SyncResult> {
  const fullName = `${target.owner}/${target.repo}`;
  let issue: { number: number; html_url: string; node_id: string } | null = null;
  let existed = false;

  if (opts.checkExisting !== false) {
    issue = await findIssue(client, target, payload.id);
    existed = !!issue;
  }

  if (!issue) {
    const uploads = files.length ? await uploadAttachments(client, target, payload.id, files) : [];
    const res = await client.request<{ number: number; html_url: string; node_id: string }>('POST', `${repoPath(target)}/issues`, {
      body: { title: issueTitle(payload), body: issueBody(payload, uploads, { threadUrl: opts.threadUrl }) },
      retry: false, // never repeat a create blindly: the caller retries with checkExisting
    });
    issue = res.data;
  }

  const result: SyncResult = { provider: 'github', repo: fullName, number: issue.number, url: issue.html_url, nodeId: issue.node_id, existed };
  if (target.projectId) {
    try {
      await addToProject(client, target.projectId, issue.node_id);
      result.projectId = target.projectId;
    } catch (err) {
      result.projectError = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

/** Issue with this comment's marker, or null. */
export async function findIssue(client: GitHubClient, target: GitHubTarget, commentId: string) {
  const q = `repo:${target.owner}/${target.repo} is:issue in:body "comenta:id=${commentId}"`;
  const res = await client.get<{ items?: Array<{ number: number; html_url: string; node_id: string; body?: string | null; pull_request?: unknown }> }>(
    `/search/issues?q=${encodeURIComponent(q)}&per_page=5`,
  );
  return res?.items?.find((i) => !i.pull_request && (i.body ?? '').includes(marker(commentId))) ?? null;
}

export async function addToProject(client: GitHubClient, projectId: string, contentId: string): Promise<string> {
  const data = await client.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    'mutation ComentaAddItem($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }',
    { p: projectId, c: contentId },
    { retry: true }, // idempotent: GitHub returns the existing item
  );
  return data.addProjectV2ItemById.item.id;
}

/** Upload recordings to `<branch>:<dir>/<comment id>/<file name>`. Files already there are reused. */
export async function uploadAttachments(client: GitHubClient, target: GitHubTarget, commentId: string, files: SyncFile[]): Promise<UploadedAttachment[]> {
  const dir = (target.attachmentsDir ?? 'comenta').replace(/^\/+|\/+$/g, '');
  const branch = await ensureBranch(client, target);
  const out: UploadedAttachment[] = [];
  // one by one: parallel commits to the same branch conflict (409)
  for (const f of files) {
    const name = f.attachment.name.replace(/[^\w.-]+/g, '_') || `${f.attachment.id}.bin`;
    const path = `${dir}/${safeSegment(commentId)}/${name}`;
    const url = `${repoPath(target)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const content = await toBase64(f.data);
    const res = await client.request<{ content: { html_url: string; download_url: string | null } } | null>('PUT', url, {
      body: { message: `Comenta: вложение к комментарию ${commentId}`, content, ...(branch ? { branch } : {}) },
      allow: [422], // already uploaded by an earlier attempt
    });
    let info = res.data?.content;
    if (res.status === 422 || !info) {
      info = await client.get<{ html_url: string; download_url: string | null }>(`${url}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`);
    }
    out.push({ attachment: f.attachment, htmlUrl: info.html_url, rawUrl: info.download_url ?? undefined });
  }
  return out;
}

const safeSegment = (s: string) => s.replace(/[^\w-]+/g, '_');

/**
 * Make sure the attachments branch exists. It is created as an orphan branch with a README,
 * so it does not copy your code. Returns null for an empty repository (files then go to
 * the default branch, which GitHub creates on the first upload).
 */
export async function ensureBranch(client: GitHubClient, target: GitHubTarget): Promise<string | null> {
  const branch = target.attachmentsBranch ?? 'comenta-attachments';
  const base = repoPath(target);
  const ref = await client.request('GET', `${base}/git/ref/heads/${encodeURIComponent(branch)}`, { allow: [404, 409] });
  if (ref.status === 200) return branch;
  if (ref.status === 409) return null; // "Git Repository is empty"
  try {
    const tree = await client.request<{ sha: string }>('POST', `${base}/git/trees`, {
      body: { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: '# Comenta attachments\n\nГолосовые сообщения и записи экрана из комментариев Comenta. Каждая папка — один комментарий.\n' }] },
      retry: true,
    });
    const commit = await client.request<{ sha: string }>('POST', `${base}/git/commits`, {
      body: { message: 'Comenta: ветка для вложений', tree: tree.data.sha, parents: [] },
      retry: true,
    });
    const created = await client.request('POST', `${base}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit.data.sha }, allow: [422], retry: true });
    void created; // 422: another request created it a moment ago — fine
    return branch;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 409) return null;
    throw err;
  }
}

async function toBase64(data: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(await data.arrayBuffer());
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
