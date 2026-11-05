import { describe, expect, it, vi } from 'vitest';
import {
  GitLabClient,
  GitLabError,
  authorizeUrl,
  checkProject,
  connectionError,
  exchangeCode,
  fetchIssue,
  fetchNotes,
  fetchProjectActivity,
  issueStateOf,
  listProjects,
  mergeNotes,
  missingScopes,
  normalizeBaseUrl,
  postNote,
  probeInstance,
  refreshAccessToken,
  setIssueState,
  syncComment,
  updateNote,
} from '../../src/gitlab';
import { TrackerError, applyIssueStatus, forViewer, providerName } from '../../src/tracker';
import { GitHubError } from '../../src/github';
import type { FeedbackPayload, FeedbackReply } from '../../src/types';

const BASE = 'https://git.example.com';

const payload = (over: Partial<FeedbackPayload> = {}): FeedbackPayload => ({
  id: 'c0ffee00-1111-2222-3333-444455556666',
  text: 'Кнопка оплаты не нажимается @boss, см. !12',
  createdAt: '2026-11-05T10:00:00.000Z',
  page: { url: 'https://shop.test/cart', title: 'Корзина', viewport: { w: 390, h: 844 }, userAgent: 'UA' },
  target: { selector: '#pay', tag: 'button', textSnippet: '', rect: { x: 0, y: 0, w: 1, h: 1 }, attributes: {} },
  author: { id: 'u-anna', name: 'Анна' },
  ...over,
});

const issueJson = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  iid: 7,
  project_id: 42,
  state: 'opened',
  description: '',
  web_url: `${BASE}/acme/web/-/issues/7`,
  updated_at: '2026-11-05T10:00:00Z',
  references: { full: 'acme/web#7' },
  ...over,
});

type Handler = (req: { method: string; url: URL; body: any; headers: Record<string, string> }) => Response | Promise<Response>;

/** Tiny fake GitLab: "METHOD /regex" → handler; records calls. */
function fakeGitLab(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body instanceof FormData ? init.body : init.body ? (String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : Object.fromEntries(new URLSearchParams(String(init.body)))) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    for (const [key, h] of Object.entries(routes)) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      if (new RegExp(`^${pattern}$`).test(url.pathname)) return h({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    }
    return new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const client = new GitLabClient({ baseUrl: BASE, token: 'glo_test', fetch, retryDelayMs: 1, sleep: async () => {} });
  return { client, calls, fetch };
}
const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('normalizeBaseUrl', () => {
  it('accepts what people type and returns one canonical form', () => {
    expect(normalizeBaseUrl('gitlab.com')).toBe('https://gitlab.com');
    expect(normalizeBaseUrl(' https://git.example.com/ ')).toBe('https://git.example.com');
    expect(normalizeBaseUrl('https://git.example.com/gitlab/api/v4')).toBe('https://git.example.com/gitlab');
    expect(normalizeBaseUrl('https://git.example.com/users/sign_in')).toBe('https://git.example.com');
    expect(normalizeBaseUrl('https://git.example.com:8443/')).toBe('https://git.example.com:8443');
    expect(normalizeBaseUrl('http://localhost:8080/gl')).toBe('http://localhost:8080/gl');
  });

  it('refuses http on the internet, credentials, non-URLs and other schemes', () => {
    const bad = (u: string) => {
      try {
        normalizeBaseUrl(u);
        return null;
      } catch (e) {
        return e as GitLabError;
      }
    };
    expect(bad('http://git.example.com')?.message).toContain('https://');
    expect(normalizeBaseUrl('http://git.example.com', { allowHttp: true })).toBe('http://git.example.com');
    expect(bad('https://user:pass@git.example.com')?.message).toContain('логин и пароль');
    expect(bad('not a url')?.code).toBe('validation');
    expect(bad('intranet')?.code).toBe('validation');
    expect(bad('ftp://git.example.com')?.code).toBe('validation');
    expect(bad('')?.message).toContain('Укажите адрес');
  });
});

describe('GitLabClient errors', () => {
  it('maps statuses to codes with Russian messages', async () => {
    const { client } = fakeGitLab({
      'GET /api/v4/a': () => ok({ error: 'invalid_token' }, 401),
      'GET /api/v4/b': () => ok({ error: 'insufficient_scope', scope: 'api' }, 403, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="api"' }),
      'GET /api/v4/c': () => ok({ message: '403 Forbidden' }, 403),
      'GET /api/v4/d': () => ok({ message: 'Retry later' }, 429, { 'Retry-After': '120', 'RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 600) }),
      'GET /api/v4/e': () => ok({ message: { title: ['is missing'] } }, 400),
    });
    const err = (p: string): Promise<GitLabError> => client.get(p).then(() => { throw new Error('no error'); }, (e: GitLabError) => e);
    const a = await err('/a');
    expect(a).toBeInstanceOf(GitLabError);
    expect(a).toBeInstanceOf(TrackerError);
    expect([a.code, a.provider]).toEqual(['unauthorized', 'gitlab']);
    const b = await err('/b');
    expect([b.code, b.missingScopes, b.message]).toEqual(['forbidden', ['api'], 'У доступа к GitLab нет прав: api. Выйдите и войдите через GitLab снова, чтобы выдать их.']);
    expect((await err('/c')).message).toContain('Reporter');
    const d = await err('/d');
    expect(d.code).toBe('rate_limited');
    expect(d.message).toBe('GitLab временно ограничил число запросов. Попробуйте через 10 мин.');
    expect(d.retryable).toBe(true);
    expect((await err('/e')).message).toBe('GitLab отклонил запрос. {"title":["is missing"]}');
  });

  it('retries GETs on 5xx, never a POST', async () => {
    let n = 0;
    const { client, calls } = fakeGitLab({
      'GET /api/v4/x': () => (++n < 3 ? new Response('', { status: 502 }) : ok({ fine: true })),
      'POST /api/v4/y': () => new Response('', { status: 502 }),
    });
    expect(await client.get('/x')).toEqual({ fine: true });
    await expect(client.request('POST', '/y', { body: {} })).rejects.toMatchObject({ code: 'network' });
    expect(calls.filter((c) => c.path === '/api/v4/y')).toHaveLength(1);
  });

  it('tells a self-signed certificate, an unknown host and a refused port apart', () => {
    const cause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
    expect(connectionError(cause('SELF_SIGNED_CERT_IN_CHAIN'))).toMatchObject({ code: 'tls' });
    expect(connectionError(cause('DEPTH_ZERO_SELF_SIGNED_CERT')).message).toContain('NODE_EXTRA_CA_CERTS');
    expect(connectionError(cause('CERT_HAS_EXPIRED')).code).toBe('tls');
    expect(connectionError(cause('ENOTFOUND')).message).toContain('не найден');
    expect(connectionError(cause('ECONNREFUSED')).message).toContain('не принимает подключения');
    expect(connectionError(new Error('boom')).message).toBe('GitLab не отвечает. Попробуйте ещё раз чуть позже.');
  });

  it('a TLS failure is not retried and reaches the caller as `tls`', async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
    }) as unknown as typeof globalThis.fetch;
    const client = new GitLabClient({ baseUrl: BASE, token: 't', fetch, sleep: async () => {} });
    await expect(client.get('/user')).rejects.toMatchObject({ code: 'tls' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('an HTML page instead of JSON says the address is not GitLab', async () => {
    const fetch = vi.fn(async () => new Response('<html>hi</html>', { status: 200 })) as unknown as typeof globalThis.fetch;
    const client = new GitLabClient({ baseUrl: BASE, token: 't', fetch });
    await expect(client.get('/user')).rejects.toMatchObject({ code: 'validation', message: expect.stringContaining('не GitLab API') });
  });
});

describe('probeInstance', () => {
  it('accepts a GitLab (401 JSON without a token) and rejects other sites', async () => {
    const gl = vi.fn(async () => ok({ message: '401 Unauthorized' }, 401)) as unknown as typeof globalThis.fetch;
    await expect(probeInstance(BASE, { fetch: gl })).resolves.toEqual({});
    const site = vi.fn(async () => new Response('<html>', { status: 404, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    await expect(probeInstance(BASE, { fetch: site })).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('OAuth', () => {
  it('builds the authorize URL with the scopes Comenta needs', () => {
    const u = new URL(authorizeUrl({ baseUrl: `${BASE}/`, clientId: 'app', redirectUri: 'https://site.test/api/gitlab/auth/callback', state: 'xyz' }));
    expect(u.origin + u.pathname).toBe(`${BASE}/oauth/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'app', redirect_uri: 'https://site.test/api/gitlab/auth/callback', response_type: 'code', state: 'xyz', scope: 'api read_user' });
  });

  it('exchanges the code and refreshes; refresh tokens are passed on, dead ones mean "sign in again"', async () => {
    const { fetch, calls } = fakeGitLab({
      'POST /oauth/token': ({ body }) =>
        body.grant_type === 'authorization_code'
          ? ok({ access_token: 'a1', refresh_token: 'r1', expires_in: 7200, created_at: Math.floor(Date.now() / 1000), scope: 'api read_user' })
          : body.refresh_token === 'r1'
            ? ok({ access_token: 'a2', refresh_token: 'r2', expires_in: 7200, scope: 'api read_user' })
            : ok({ error: 'invalid_grant', error_description: 'revoked' }, 400),
    });
    const o = { baseUrl: BASE, clientId: 'app', clientSecret: 'sec', redirectUri: 'https://site.test/cb', fetch };
    const t = await exchangeCode({ ...o, code: 'c' });
    expect(t).toMatchObject({ token: 'a1', refreshToken: 'r1', scopes: ['api', 'read_user'] });
    expect(t.expiresAt! - Date.now()).toBeGreaterThan(7000_000);
    expect(calls[0].body).toMatchObject({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://site.test/cb', client_secret: 'sec' });
    expect(await refreshAccessToken({ ...o, refreshToken: 'r1' })).toMatchObject({ token: 'a2', refreshToken: 'r2' });
    await expect(refreshAccessToken({ ...o, refreshToken: 'r1-old' })).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('Войдите через GitLab заново') });
  });

  it('a GitLab outage during refresh is a network error, not a revoked token', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(refreshAccessToken({ baseUrl: BASE, clientId: 'a', clientSecret: 'b', redirectUri: 'c', refreshToken: 'r', fetch })).rejects.toMatchObject({ code: 'network' });
  });

  it('missing scopes: api covers everything', () => {
    expect(missingScopes(['api', 'read_user'])).toEqual([]);
    expect(missingScopes(['read_user'])).toEqual(['api']);
    expect(missingScopes(null)).toEqual([]);
  });
});

describe('projects', () => {
  it('lists projects with Reporter+ (groups, subgroups), drops archived and read-only ones', async () => {
    const raw = (id: number, path: string, ns: string, kind: string, level: number, extra = {}) => ({
      id,
      name: path,
      path,
      path_with_namespace: `${ns}/${path}`,
      namespace: { full_path: ns, kind },
      visibility: 'private',
      web_url: `${BASE}/${ns}/${path}`,
      permissions: { project_access: null, group_access: { access_level: level } },
      ...extra,
    });
    const { client, calls } = fakeGitLab({
      'GET /api/v4/projects': () => ok([raw(1, 'web', 'acme', 'group', 30), raw(2, 'ds', 'acme/frontend', 'group', 40), raw(3, 'docs', 'acme', 'group', 10), raw(4, 'old', 'me', 'user', 50, { archived: true })]),
    });
    const { items, complete } = await listProjects(client, { search: 'we' });
    expect(items.map((p) => [p.fullName, p.owner, p.ownerType])).toEqual([
      ['acme/web', 'acme', 'Organization'],
      ['acme/frontend/ds', 'acme/frontend', 'Organization'],
    ]);
    expect(complete).toBe(true);
    const q = new URL(`http://x${calls[0].path}`).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ membership: 'true', min_access_level: '20', archived: 'false', search: 'we' });
  });

  it('checkProject explains why a project can not be used', async () => {
    const { client } = fakeGitLab({
      'GET /api/v4/projects/1': () => ok({ id: 1, path: 'a', name: 'A', path_with_namespace: 'me/a', web_url: '', issues_enabled: false, permissions: { project_access: { access_level: 50 } } }),
      'GET /api/v4/projects/2': () => ok({ id: 2, path: 'b', name: 'B', path_with_namespace: 'me/b', web_url: '', permissions: { project_access: { access_level: 10 } } }),
      'GET /api/v4/projects/3': () => ok({ id: 3, path: 'c', name: 'C', path_with_namespace: 'me/c', web_url: '', archived: true, permissions: { project_access: { access_level: 50 } } }),
    });
    await expect(checkProject(client, 1)).rejects.toMatchObject({ code: 'issues_disabled' });
    await expect(checkProject(client, 2)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('Reporter') });
    await expect(checkProject(client, 3)).rejects.toMatchObject({ message: expect.stringContaining('архиве') });
  });
});

describe('syncComment', () => {
  it('uploads recordings, embeds them as players and creates the issue once', async () => {
    const { client, calls } = fakeGitLab({
      'POST /api/v4/projects/42/uploads': () => ok({ url: '/uploads/abc/voice.webm', full_path: '/-/project/42/uploads/abc/voice.webm' }, 201),
      'POST /api/v4/projects/42/issues': ({ body }) => ok(issueJson({ title: body.title, description: body.description }), 201),
    });
    const p = payload({ attachments: [{ id: 'v1', kind: 'audio', name: 'voice.webm', mimeType: 'audio/webm', size: 3, durationMs: 42_000 }] });
    const res = await syncComment(client, { projectId: 42, path: 'acme/web' }, p, [{ attachment: p.attachments![0], data: new Uint8Array([1, 2, 3]) }], { checkExisting: false });
    expect(res).toEqual({ provider: 'gitlab', repo: 'acme/web', number: 7, url: `${BASE}/acme/web/-/issues/7`, nodeId: '9001', repoId: 42, existed: false });
    const create = calls.find((c) => c.path.endsWith('/issues'))!;
    expect(create.body.description).toContain(`![🎙 Голос, 0:42](${BASE}/-/project/42/uploads/abc/voice.webm)`);
    expect(create.body.description).toContain('<!-- comenta:id=c0ffee00-1111-2222-3333-444455556666 -->');
    expect(create.body.description).toContain('@​boss');
    expect(create.body.description).toContain('!​12');
    const upload = calls.find((c) => c.path.endsWith('/uploads'))!;
    expect((upload.body as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('a retry finds the issue an earlier attempt created by its marker', async () => {
    const marker = '<!-- comenta:id=c0ffee00-1111-2222-3333-444455556666 -->';
    const { client, calls } = fakeGitLab({
      'GET /api/v4/projects/42/issues': () => ok([issueJson({ iid: 3, description: 'другой' }), issueJson({ description: `текст\n${marker}` })]),
    });
    const res = await syncComment(client, { projectId: 42 }, payload());
    expect(res).toMatchObject({ number: 7, existed: true, repo: 'acme/web' });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(calls[0].path).toContain('in=description');
  });
});

describe('thread sync', () => {
  it('maps the state; a moved issue or one answering from another project is transferred', () => {
    expect(issueStateOf(issueJson({ state: 'closed', closed_at: '2026-11-05T11:00:00Z', closed_by: { username: 'ivan', name: 'Иван' } }) as never)).toEqual({
      number: 7,
      state: 'closed',
      stateReason: null,
      closedAt: '2026-11-05T11:00:00Z',
      updatedAt: '2026-11-05T10:00:00Z',
      closedBy: { login: 'ivan', name: 'Иван' },
    });
    expect(issueStateOf(issueJson({ moved_to_id: 99 }) as never).moved).toBe(true);
    expect(issueStateOf(issueJson() as never, { repoId: 41 }).moved).toBe(true);
    expect(issueStateOf(issueJson() as never, { repoId: 42 }).moved).toBeUndefined();
  });

  it('fetchIssue: 404 → unavailable; close / reopen with state_event', async () => {
    const { client, calls } = fakeGitLab({
      'GET /api/v4/projects/42/issues/7': () => ok(issueJson()),
      'GET /api/v4/projects/42/issues/8': () => ok({ message: '404 Not Found' }, 404),
      'PUT /api/v4/projects/42/issues/7': ({ body }) => ok(issueJson({ state: body.state_event === 'close' ? 'closed' : 'opened' })),
    });
    const link = { repo: 'acme/web', repoId: 42, number: 7 };
    expect(await fetchIssue(client, link)).toMatchObject({ kind: 'ok', issue: { state: 'open' } });
    expect(await fetchIssue(client, { ...link, number: 8 })).toEqual({ kind: 'unavailable', reason: 'no_access' });
    expect((await setIssueState(client, link, 'closed')).state).toBe('closed');
    expect(calls.at(-1)!.body).toEqual({ state_event: 'close' });
  });

  it('notes: system and internal notes are never imported; merging is idempotent; deletions follow', async () => {
    const note = (id: number, body: string, extra = {}) => ({ id, body, created_at: `2026-11-05T10:0${id % 10}:00Z`, updated_at: `2026-11-05T10:0${id % 10}:00Z`, author: { username: 'ivan', name: 'Иван', avatar_url: 'https://a/x.png', web_url: `${BASE}/ivan` }, ...extra });
    let list = [note(1, 'Посмотрю'), note(2, 'changed the description', { system: true }), note(3, 'Только для команды', { internal: true }), note(4, '**Анна:** Спасибо\n\n<!-- comenta:reply=r1 -->')];
    const { client } = fakeGitLab({ 'GET /api/v4/projects/42/issues/7/notes': () => ok(list) });
    const issue = { repo: 'acme/web', repoId: 42, number: 7, url: `${BASE}/acme/web/-/issues/7` };
    const thread: Pick<FeedbackPayload, 'id' | 'replies'> = { id: 'c1', replies: [{ id: 'r1', commentId: 'c1', text: 'Спасибо', createdAt: '2026-11-05T10:03:00Z', author: { name: 'Анна' } }] };
    const { comments, complete } = await fetchNotes(client, issue);
    expect(comments.map((c) => c.id)).toEqual([1, 4]);
    const m = mergeNotes(thread, comments, { complete });
    expect(m.linked).toEqual(['r1']);
    expect(m.replies.map((r) => [r.origin ?? 'comenta', r.author?.name, r.text, r.link?.url])).toEqual([
      ['gitlab', 'Иван', 'Посмотрю', `${BASE}/acme/web/-/issues/7#note_1`],
      ['comenta', 'Анна', 'Спасибо', `${BASE}/acme/web/-/issues/7#note_4`],
    ]);
    expect(m.replies[0].author?.id).toBe('gitlab:ivan');
    expect(mergeNotes({ ...thread, replies: m.replies }, comments, { complete }).changed).toBe(false);
    list = [list[3]];
    const gone = mergeNotes({ ...thread, replies: m.replies }, (await fetchNotes(client, issue)).comments, { complete: true });
    expect(gone.replies.map((r) => r.id)).toEqual(['r1']);
  });

  it('posting a reply: signed with the name, marker, retry finds the earlier note; edits keep upload links', async () => {
    const posted: string[] = [];
    const { client } = fakeGitLab({
      'GET /api/v4/projects/42/issues/7/notes': () => ok(posted.map((body, i) => ({ id: 100 + i, body, created_at: '2026-11-05T10:00:00Z', author: { username: 'owner' } }))),
      'POST /api/v4/projects/42/issues/7/notes': ({ body }) => (posted.push(body.body), ok({ id: 100 + posted.length - 1, body: body.body }, 201)),
      'GET /api/v4/projects/42/issues/7/notes/100': () => ok({ id: 100, body: posted[0] }),
      'PUT /api/v4/projects/42/issues/7/notes/100': ({ body }) => ((posted[0] = body.body), ok({ id: 100 })),
    });
    const issue = { repo: 'acme/web', repoId: 42, number: 7, url: `${BASE}/acme/web/-/issues/7` };
    const reply: FeedbackReply = { id: 'r9', commentId: 'c1', text: 'Исправим @team', createdAt: '2026-11-05T10:00:00Z', author: { name: 'Анна Петрова' } };
    const first = await postNote(client, issue, reply);
    expect(first).toEqual({ provider: 'gitlab', id: 100, url: `${BASE}/acme/web/-/issues/7#note_100`, existed: false });
    expect(posted[0]).toBe('**Анна Петрова:** Исправим @​team\n\n<!-- comenta:reply=r9 -->');
    expect(await postNote(client, issue, reply, [], { checkExisting: true })).toMatchObject({ id: 100, existed: true });
    expect(posted).toHaveLength(1);
    // a reply with a recording: editing the text keeps the uploaded file's link
    posted[0] = `**Анна Петрова:** Исправим\n\n🎥 Экран, 0:05\n\n![🎥 Экран, 0:05](${BASE}/-/project/42/uploads/x/s.webm)\n\n<!-- comenta:reply=r9 -->`;
    const withVideo = { ...reply, text: 'Исправим завтра', attachments: [{ id: 's', kind: 'screen' as const, name: 's.webm', mimeType: 'video/webm', size: 1, durationMs: 5000 }] };
    expect(await updateNote(client, issue, { id: 100 }, withVideo)).toBe('updated');
    expect(posted[0]).toContain('**Анна Петрова:** Исправим завтра');
    expect(posted[0]).toContain(`![🎥 Экран, 0:05](${BASE}/-/project/42/uploads/x/s.webm)`);
  });

  it('project activity: issues updated since the cursor, the cursor moves to the newest', async () => {
    const { client, calls } = fakeGitLab({
      'GET /api/v4/projects/42/issues': () => ok([issueJson({ iid: 1, updated_at: '2026-11-05T10:01:00Z' }), issueJson({ iid: 2, state: 'closed', updated_at: '2026-11-05T10:02:00Z' })]),
    });
    const act = await fetchProjectActivity(client, 42, '2026-11-05T10:00:00Z');
    expect(act.issues.map((i) => [i.number, i.state])).toEqual([
      [1, 'open'],
      [2, 'closed'],
    ]);
    expect(act.cursor).toEqual({ issues: '2026-11-05T10:02:00Z' });
    expect(calls[0].path).toContain('updated_after=2026-11-05T10%3A00%3A00Z');
  });
});

describe('shared tracker layer', () => {
  it('names providers and keeps one error family', () => {
    expect([providerName('github'), providerName('gitlab')]).toEqual(['GitHub', 'GitLab']);
    expect(new GitHubError('network', 'x')).toBeInstanceOf(TrackerError);
    expect(new GitHubError('network', 'x').provider).toBe('github');
  });

  it('one status follows a GitLab close, naming the GitLab user; only the owner and the author see who', () => {
    const p = payload({ issue: { provider: 'gitlab', repo: 'acme/web', number: 7, url: 'u', state: 'closed', closedAt: '2026-11-05T11:00:00Z' } });
    expect(applyIssueStatus(p, { closedBy: { login: 'Ivan', name: 'Иван' } })).toBe(true);
    expect(p).toMatchObject({ status: 'resolved', resolvedVia: 'gitlab', resolvedBy: { id: 'gitlab:ivan', name: 'Иван' } });
    const guest = forViewer(p, { id: 'someone-else' });
    expect(guest.status).toBe('resolved');
    expect(guest.resolvedBy).toBeUndefined();
    expect(guest.issue?.state).toBeUndefined();
    expect(forViewer(p, { id: 'u-anna' }).resolvedBy?.name).toBe('Иван');
  });
});
