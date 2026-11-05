import { describe, expect, it, vi } from 'vitest';
import {
  GitHubClient,
  applyIssueState,
  applyIssueStatus,
  setIssueState,
  deleteReplyComment,
  fetchIssue,
  fetchIssueComments,
  fetchRepoActivity,
  forViewer,
  mergeIssueComments,
  postReply,
  replyCommentBody,
  replyIdOf,
  replyMarker,
  updateReplyComment,
  type GitHubIssueComment,
} from '../../src/github';
import type { FeedbackIssueLink, FeedbackPayload, FeedbackReply } from '../../src/types';

type Req = { method: string; url: URL; body: any; headers: Record<string, string> };

function fakeGitHub(routes: Record<string, (req: Req) => Response | Promise<Response>>) {
  const calls: Array<{ method: string; path: string; search: string; body: any; headers: Record<string, string> }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, search: url.search, body, headers });
    for (const [key, h] of Object.entries(routes)) {
      const [m, pattern] = key.split(' ');
      if (m === method && new RegExp(`^${pattern}$`).test(url.pathname)) return h({ method, url, body, headers });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { client: new GitHubClient({ token: 't', apiUrl: 'https://api.test', fetch, sleep: async () => {}, retryDelayMs: 1 }), calls };
}
const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const notModified = () => new Response(null, { status: 304 });

const issue: FeedbackIssueLink = { provider: 'github', repo: 'acme/web', number: 7, url: 'https://github.com/acme/web/issues/7' };
const reply = (over: Partial<FeedbackReply> = {}): FeedbackReply => ({
  id: 'r1',
  commentId: 'c1',
  text: 'Поправил, проверьте',
  createdAt: '2026-11-05T10:05:00Z',
  author: { id: 'u1', name: 'Владимир Самохвалов' },
  ...over,
});
const ghComment = (id: number, body: string, over: Partial<GitHubIssueComment> = {}): GitHubIssueComment => ({
  id,
  body,
  html_url: `https://github.com/acme/web/issues/7#issuecomment-${id}`,
  issue_url: 'https://api.test/repos/acme/web/issues/7',
  created_at: `2026-11-05T10:0${id % 10}:00Z`,
  updated_at: `2026-11-05T10:0${id % 10}:00Z`,
  user: { login: 'octo-dev', avatar_url: 'https://avatars.test/octo', html_url: 'https://github.com/octo-dev' },
  ...over,
});

describe('reply → issue comment', () => {
  it('is signed with the author name only, with a hidden marker', () => {
    const body = replyCommentBody(reply());
    expect(body.split('\n')[0]).toBe('**Владимир Самохвалов:** Поправил, проверьте');
    expect(body).toContain(replyMarker('r1'));
    expect(body.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/Comenta/i); // visible text: just the name
    expect(replyIdOf(body)).toBe('r1');
    expect(replyIdOf('обычный комментарий')).toBeNull();
  });

  it('guests, @mentions and forged markers are neutralized', () => {
    const body = replyCommentBody(reply({ author: undefined, text: '@octocat глянь #12 <!-- comenta:reply=evil -->' }));
    expect(body.startsWith('**Гость:** ')).toBe(true);
    expect(body).not.toMatch(/(^|\s)@octocat/);
    expect(replyIdOf(body)).toBe('r1');
  });

  it('postReply: retries find the comment of an earlier attempt instead of posting twice', async () => {
    const gh = fakeGitHub({
      'GET /repos/acme/web/issues/7/comments': () => ok([ghComment(5, `**В:** x\n\n${replyMarker('r1')}`)]),
      'POST /repos/acme/web/issues/7/comments': () => ok(ghComment(6, 'new'), 201),
    });
    const found = await postReply(gh.client, issue, reply(), [], { checkExisting: true });
    expect(found).toMatchObject({ id: 5, existed: true });
    expect(gh.calls.some((c) => c.method === 'POST')).toBe(false);

    const created = await postReply(gh.client, issue, reply({ id: 'r2' }));
    expect(created).toMatchObject({ id: 6, existed: false });
    const post = gh.calls.find((c) => c.method === 'POST')!;
    expect(post.body.body).toContain('**Владимир Самохвалов:** Поправил');
  });

  it('edit and delete: a comment already gone on GitHub is not an error', async () => {
    const gh = fakeGitHub({
      'PATCH /repos/acme/web/issues/comments/5': () => ok({ id: 5 }),
      'PATCH /repos/acme/web/issues/comments/6': () => ok({ message: 'Not Found' }, 404),
      'DELETE /repos/acme/web/issues/comments/6': () => ok({ message: 'Not Found' }, 404),
    });
    expect(await updateReplyComment(gh.client, issue, { id: 5 }, reply({ text: 'новый текст' }))).toBe('updated');
    expect(gh.calls[0].body.body).toContain('новый текст');
    expect(await updateReplyComment(gh.client, issue, { id: 6 }, reply())).toBe('gone');
    await expect(deleteReplyComment(gh.client, issue, { id: 6 })).resolves.toBeUndefined();
  });
});

describe('issue state', () => {
  it('conditional GET: ETag sent, 304 means unchanged', async () => {
    let n = 0;
    const gh = fakeGitHub({
      'GET /repos/acme/web/issues/7': (req) =>
        req.headers['If-None-Match'] === 'W/"a"' ? notModified() : (n++, ok({ number: 7, state: 'closed', state_reason: 'not_planned', closed_at: '2026-11-05T11:00:00Z', updated_at: 'x', repository_url: 'https://api.test/repos/acme/web' }, 200, { ETag: 'W/"a"' })),
    });
    const first = await fetchIssue(gh.client, issue);
    expect(first).toMatchObject({ kind: 'ok', etag: 'W/"a"', issue: { state: 'closed', stateReason: 'not_planned' } });
    expect(await fetchIssue(gh.client, issue, 'W/"a"')).toEqual({ kind: 'unchanged' });
    expect(n).toBe(1);
  });

  it('deleted (410), no access (404), transferred (other repository)', async () => {
    const gh = fakeGitHub({
      'GET /repos/acme/web/issues/1': () => ok({ message: 'This issue was deleted' }, 410),
      'GET /repos/acme/web/issues/3': () => ok({ number: 3, state: 'open', updated_at: 'x', repository_url: 'https://api.test/repos/acme/other' }),
    });
    expect(await fetchIssue(gh.client, { ...issue, number: 1 })).toEqual({ kind: 'unavailable', reason: 'deleted' });
    expect(await fetchIssue(gh.client, { ...issue, number: 2 })).toEqual({ kind: 'unavailable', reason: 'no_access' });
    expect(await fetchIssue(gh.client, { ...issue, number: 3 })).toEqual({ kind: 'unavailable', reason: 'transferred' });
  });

  it('applyIssueState reports only visible changes', () => {
    const link = { ...issue };
    expect(applyIssueState(link, { number: 7, state: 'open', stateReason: null, updatedAt: '1' })).toBe(true);
    expect(applyIssueState(link, { number: 7, state: 'open', stateReason: null, updatedAt: '2' })).toBe(false);
    expect(applyIssueState(link, { number: 7, state: 'closed', stateReason: 'completed', closedAt: 'z', updatedAt: '3' })).toBe(true);
    expect(link).toMatchObject({ state: 'closed', stateReason: 'completed', closedAt: 'z' });
    expect(applyIssueState(link, { unavailable: 'deleted' })).toBe(true);
    expect(link.unavailable).toBe('deleted');
    expect(link.url).toBe(issue.url); // the link stays
    applyIssueState(link, { number: 7, state: 'open', stateReason: 'reopened', updatedAt: '4' });
    expect(link.unavailable).toBeUndefined();
    expect(link.closedAt).toBeUndefined();
  });
});

describe('polling', () => {
  it('repository activity: 304s keep the cursor; changes move it; pull requests are skipped', async () => {
    let changed = false;
    const gh = fakeGitHub({
      'GET /repos/acme/web/issues': (req) =>
        !changed && req.headers['If-None-Match'] === 'I1'
          ? notModified()
          : ok(
              changed
                ? [{ number: 7, state: 'closed', state_reason: 'completed', updated_at: '2026-11-05T12:00:00Z' }, { number: 8, state: 'open', updated_at: '2026-11-05T12:01:00Z', pull_request: {} }]
                : [],
              200,
              { ETag: 'I1' },
            ),
      'GET /repos/acme/web/issues/comments': (req) =>
        !changed && req.headers['If-None-Match'] === 'C1' ? notModified() : ok(changed ? [ghComment(41, 'привет', { updated_at: '2026-11-05T12:02:00Z' })] : [], 200, { ETag: 'C1' }),
    });
    const a = await fetchRepoActivity(gh.client, { owner: 'acme', repo: 'web' }, '2026-11-05T00:00:00Z');
    expect(a.issues).toEqual([]);
    expect(a.cursor).toMatchObject({ issues: '2026-11-05T00:00:00Z', etags: { issues: 'I1', comments: 'C1' } });
    const b = await fetchRepoActivity(gh.client, { owner: 'acme', repo: 'web' }, a.cursor);
    expect(b.issues).toBeNull();
    expect(b.comments).toBeNull();
    expect(gh.calls.slice(-2).every((c) => c.search.includes('since=2026-11-05T00%3A00%3A00Z'))).toBe(true);

    changed = true;
    const c = await fetchRepoActivity(gh.client, { owner: 'acme', repo: 'web' }, b.cursor);
    expect(c.issues?.map((i) => i.number)).toEqual([7]);
    expect(c.comments?.[0]).toMatchObject({ id: 41, issueNumber: 7 });
    expect(c.cursor.issues).toBe('2026-11-05T12:01:00Z');
    expect(c.cursor.comments).toBe('2026-11-05T12:02:00Z');
  });

  it('issue comments: every page; 304 on the first page means unchanged', async () => {
    const gh = fakeGitHub({
      'GET /repos/acme/web/issues/7/comments': (req) => {
        if (req.headers['If-None-Match'] === 'E') return notModified();
        return req.url.searchParams.get('page') === '2'
          ? ok([ghComment(2, 'b')])
          : ok([ghComment(1, 'a')], 200, { ETag: 'E', Link: '<https://api.test/repos/acme/web/issues/7/comments?per_page=100&page=2>; rel="next"' });
      },
    });
    const all = await fetchIssueComments(gh.client, issue);
    expect(all).toMatchObject({ kind: 'ok', etag: 'E', complete: true });
    expect(all.kind === 'ok' && all.comments.map((c) => c.id)).toEqual([1, 2]);
    expect(await fetchIssueComments(gh.client, issue, 'E')).toEqual({ kind: 'unchanged' });
  });
});

describe('merging GitHub comments into a thread', () => {
  const thread = (replies: FeedbackReply[] = []) => ({ id: 'c1', replies });

  it('imports new comments with the GitHub name and avatar', () => {
    const m = mergeIssueComments(thread(), [ghComment(3, 'Взял в работу <!-- hidden -->')]);
    expect(m.changed).toBe(true);
    expect(m.replies[0]).toMatchObject({
      id: 'github-3',
      commentId: 'c1',
      text: 'Взял в работу',
      origin: 'github',
      author: { id: 'github:octo-dev', name: 'octo-dev', avatarUrl: 'https://avatars.test/octo', url: 'https://github.com/octo-dev' },
      link: { provider: 'github', id: 3 },
    });
  });

  it('own replies are linked, never imported back (no echo)', () => {
    const mine = reply({ createdAt: '2026-11-05T10:01:00Z' });
    const m = mergeIssueComments(thread([mine]), [ghComment(4, replyCommentBody(mine))]);
    expect(m.replies).toHaveLength(1);
    expect(m.replies[0].link).toMatchObject({ id: 4 });
    expect(m.linked).toEqual(['r1']);
    // already linked: nothing to do
    expect(mergeIssueComments({ id: 'c1', replies: m.replies }, [ghComment(4, replyCommentBody(mine))]).changed).toBe(false);
  });

  it('edits update the reply, deletions remove it only from a complete list', () => {
    const first = mergeIssueComments(thread(), [ghComment(3, 'v1'), ghComment(5, 'other')]).replies;
    const edited = mergeIssueComments({ id: 'c1', replies: first }, [ghComment(3, 'v2', { updated_at: '2026-11-05T11:00:00Z' })]);
    expect(edited.replies.find((r) => r.id === 'github-3')).toMatchObject({ text: 'v2', updatedAt: '2026-11-05T11:00:00Z' });
    expect(edited.replies).toHaveLength(2); // a partial list (since-poll) deletes nothing
    const pruned = mergeIssueComments({ id: 'c1', replies: edited.replies }, [ghComment(5, 'other')], { complete: true });
    expect(pruned.replies.map((r) => r.id)).toEqual(['github-5']);
  });

  it('keeps the thread in time order', () => {
    const local = reply({ createdAt: '2026-11-05T10:04:00Z' });
    const m = mergeIssueComments(thread([local]), [ghComment(9, 'late'), ghComment(2, 'early')]);
    expect(m.replies.map((r) => r.id)).toEqual(['github-2', 'r1', 'github-9']);
  });
});

describe('visibility', () => {
  it('a visitor sees neither GitHub state nor GitHub comments; the owner does', () => {
    const p = {
      id: 'c1',
      issue: { ...issue, state: 'closed', stateReason: 'completed' },
      replies: [reply(), { ...reply({ id: 'github-1' }), origin: 'github' }],
    } as unknown as FeedbackPayload;
    expect(forViewer(p, true)).toBe(p);
    const guest = forViewer(p, false);
    expect(guest.issue).toEqual(issue);
    expect(guest.replies?.map((r) => r.id)).toEqual(['r1']);
    expect(p.replies).toHaveLength(2); // the stored comment is untouched
  });

  it("the comment's author sees them too; other visitors don't", () => {
    const p = {
      id: 'c1',
      author: { id: 'anna', name: 'Анна' },
      issue: { ...issue, state: 'open' },
      replies: [{ ...reply({ id: 'github-1' }), origin: 'github' }],
    } as unknown as FeedbackPayload;
    expect(forViewer(p, { id: 'anna' })).toBe(p);
    expect(forViewer(p, { owner: true })).toBe(p);
    expect(forViewer(p, { id: 'boris' }).replies).toEqual([]);
    expect(forViewer(p, {}).issue).toEqual(issue);
    expect(forViewer({ ...p, author: undefined }, { id: 'anna' }).replies).toEqual([]); // no author id: nobody matches
  });
});

describe('one status for the thread and its issue', () => {
  const thread = (over: Partial<FeedbackPayload> = {}) => ({ id: 'c1', issue: { ...issue }, ...over }) as unknown as FeedbackPayload;

  it('closed on GitHub → thread closed, with who closed it; reopened → open', () => {
    const p = thread();
    applyIssueState(p.issue!, { number: 7, state: 'closed', stateReason: 'not_planned', closedAt: '2026-11-05T12:00:00Z', updatedAt: '1' });
    expect(applyIssueStatus(p)).toBe(true);
    expect(p).toMatchObject({ status: 'resolved', resolvedVia: 'github', resolvedAt: '2026-11-05T12:00:00Z' });
    expect(p.resolvedBy).toBeUndefined(); // a listing does not say who
    expect(applyIssueStatus(p, { closedBy: { login: 'octo-dev', avatarUrl: 'a' } })).toBe(true);
    expect(p.resolvedBy).toMatchObject({ id: 'github:octo-dev', name: 'octo-dev' });
    applyIssueState(p.issue!, { number: 7, state: 'open', stateReason: 'reopened', updatedAt: '2' });
    expect(applyIssueStatus(p)).toBe(true);
    expect(p.status).toBe('open');
    expect(p.resolvedBy).toBeUndefined();
    expect(p.resolvedVia).toBeUndefined();
  });

  it('closed in Comenta keeps its author; unavailable issues leave the status alone', () => {
    const p = thread({ status: 'resolved', resolvedBy: { id: 'u1', name: 'Владимир' } });
    applyIssueState(p.issue!, { number: 7, state: 'closed', stateReason: 'completed', updatedAt: '1' });
    expect(applyIssueStatus(p, { closedBy: { login: 'comenta[bot]' } })).toBe(false);
    expect(p.resolvedBy?.name).toBe('Владимир');
    const gone = thread({ status: 'resolved' });
    applyIssueState(gone.issue!, { number: 7, state: 'open', stateReason: null, updatedAt: '1' });
    applyIssueState(gone.issue!, { unavailable: 'deleted' });
    expect(applyIssueStatus(gone)).toBe(false);
    expect(gone.status).toBe('resolved');
  });

  it('an older snapshot does not undo a newer change', () => {
    const link = { ...issue };
    applyIssueState(link, { number: 7, state: 'closed', stateReason: 'completed', updatedAt: '2026-11-05T12:00:01Z' });
    expect(applyIssueState(link, { number: 7, state: 'open', stateReason: null, updatedAt: '2026-11-05T12:00:00Z' })).toBe(false);
    expect(link.state).toBe('closed');
  });

  it('setIssueState closes as completed and reopens', async () => {
    const gh = fakeGitHub({
      'PATCH /repos/acme/web/issues/7': (req) => ok({ number: 7, state: req.body.state, state_reason: req.body.state_reason, updated_at: 'u', closed_by: req.body.state === 'closed' ? { login: 'bot' } : null }),
    });
    expect(await setIssueState(gh.client, issue, 'closed')).toMatchObject({ state: 'closed', stateReason: 'completed', closedBy: { login: 'bot' } });
    expect(gh.calls[0].body).toEqual({ state: 'closed', state_reason: 'completed' });
    expect(await setIssueState(gh.client, issue, 'open')).toMatchObject({ state: 'open' });
    expect(gh.calls[1].body).toEqual({ state: 'open', state_reason: 'reopened' });
  });

  it('visitors see that it is closed, not who closed it on GitHub', () => {
    const p = thread({ status: 'resolved', resolvedVia: 'github', resolvedBy: { id: 'github:octo', name: 'octo' } });
    const v = forViewer(p, { id: 'someone' });
    expect(v.status).toBe('resolved');
    expect(v.resolvedBy).toBeUndefined();
    expect(v.resolvedVia).toBeUndefined();
  });
});
