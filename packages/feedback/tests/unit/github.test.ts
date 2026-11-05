import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GitHubAppAuth,
  GitHubClient,
  GitHubError,
  createAppJwt,
  attachmentCaption,
  authorizeUrl,
  checkRepo,
  exchangeCode,
  installUrl,
  listInstallationRepos,
  refreshAccessToken,
  formatDuration,
  issueBody,
  issueTitle,
  listProjects,
  listRepos,
  syncComment,
} from '../../src/github';
import { httpAdapter } from '../../src/adapters';
import type { FeedbackAttachment, FeedbackPayload } from '../../src/types';

const payload = (over: Partial<FeedbackPayload> = {}): FeedbackPayload => ({
  id: 'c0ffee00-1111-2222-3333-444455556666',
  text: 'Кнопка оплаты не нажимается на мобильном',
  createdAt: '2026-11-05T10:00:00.000Z',
  page: { url: 'https://shop.test/cart?x=1', title: 'Корзина', viewport: { w: 390, h: 844 }, userAgent: 'UA/1.0' },
  target: { selector: '#pay > button.primary', tag: 'button', textSnippet: 'Оплатить | сейчас', rect: { x: 0, y: 0, w: 1, h: 1 }, attributes: {} },
  author: { name: 'Анна' },
  ...over,
});

const att = (kind: 'audio' | 'screen', durationMs: number, id: string = kind): FeedbackAttachment => ({
  id,
  kind,
  name: `${kind === 'audio' ? 'voice' : 'screen'}-${id}.webm`,
  mimeType: kind === 'audio' ? 'audio/webm' : 'video/webm',
  size: 3,
  durationMs,
});

type Handler = (req: { method: string; url: URL; body: any; headers: Record<string, string> }) => Response | Promise<Response>;

/** Tiny fake GitHub: routes "METHOD /path" → handler; records calls. */
function fakeGitHub(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    for (const [key, h] of Object.entries(routes)) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      if (new RegExp(`^${pattern}$`).test(url.pathname)) return h({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const client = new GitHubClient({ token: 't0k', apiUrl: 'https://api.test', fetch, sleep: async () => {}, retryDelayMs: 1 });
  return { client, calls, fetch };
}
/** The error a promise rejects with (fails the test if it resolves). */
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (e) => e as GitHubError);
const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('issue text', () => {
  it('title: first words, cut on a word boundary, with the category emoji', () => {
    expect(issueTitle(payload())).toBe('Кнопка оплаты не нажимается на мобильном');
    expect(issueTitle(payload({ kind: 'bug' }))).toBe('😢 Кнопка оплаты не нажимается на мобильном');
    const long = issueTitle(payload({ text: 'Очень длинный комментарий про то, что форма заказа ломается, если ввести адрес с дефисом и потом вернуться назад' }));
    expect(long.length).toBeLessThanOrEqual(73);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/\s…$/);
    expect(issueTitle(payload({ text: '', attachments: [att('audio', 42000)] }))).toBe('Голосовой комментарий: Корзина');
  });

  it('durations and captions', () => {
    expect(formatDuration(42_400)).toBe('0:42');
    expect(formatDuration(60_000)).toBe('1:00');
    expect(attachmentCaption(att('audio', 42_000))).toBe('🎙 Голос, 0:42');
    expect(attachmentCaption(att('screen', 58_000))).toBe('🎥 Экран, 0:58');
  });

  it('body: text, recordings, element, page, hidden marker; guests cannot ping people or forge markers', () => {
    const p = payload({ text: 'Привет @octocat, см. #12 <!-- comenta:id=evil -->', attachments: [att('audio', 42000), att('screen', 58000)] });
    const body = issueBody(p, [
      { attachment: p.attachments![0], htmlUrl: 'https://gh.test/a.webm' },
      { attachment: p.attachments![1], htmlUrl: 'https://gh.test/s.webm' },
    ]);
    expect(body).toContain('- [🎙 Голос, 0:42](https://gh.test/a.webm)');
    expect(body).toContain('- [🎥 Экран, 0:58](https://gh.test/s.webm)');
    expect(body).toContain('| Элемент | `#pay > button.primary` |');
    expect(body).toContain('| Текст элемента | Оплатить \\| сейчас |');
    expect(body).toContain('[Корзина](https://shop.test/cart?x=1)');
    expect(body).toContain('#comenta=c0ffee00-1111-2222-3333-444455556666');
    expect(body.trim().endsWith('<!-- comenta:id=c0ffee00-1111-2222-3333-444455556666 -->')).toBe(true);
    expect(body).not.toContain('@octocat');
    expect(body).toContain('@​octocat');
    expect(body).toContain('#​12');
    expect(body.match(/<!--/g)).toHaveLength(1);
  });

  it('body: images inline, missing uploads listed', () => {
    const img: FeedbackAttachment = { id: 'i', kind: 'screen', name: 'shot.png', mimeType: 'image/png', size: 1, durationMs: 0 };
    const p = payload({ attachments: [img, att('audio', 5000)] });
    const body = issueBody(p, [{ attachment: img, htmlUrl: 'https://gh.test/shot.png', rawUrl: 'https://raw.test/shot.png' }]);
    expect(body).toContain('![shot.png](https://raw.test/shot.png)');
    expect(body).toContain('🎙 Голос, 0:05 (файл не загружен)');
  });
});

describe('GitHubClient', () => {
  it('retries safe requests on 5xx, then succeeds', async () => {
    let n = 0;
    const { client } = fakeGitHub({ 'GET /user': () => (++n < 3 ? new Response('', { status: 503 }) : ok({ login: 'me' })) });
    expect(await client.get('/user')).toEqual({ login: 'me' });
    expect(n).toBe(3);
  });

  it('never repeats a POST on 5xx (could duplicate an issue)', async () => {
    let n = 0;
    const { client } = fakeGitHub({ 'POST /repos/o/r/issues': () => (n++, new Response('', { status: 502 })) });
    await expect(client.request('POST', '/repos/o/r/issues', { body: {} })).rejects.toMatchObject({ code: 'network' });
    expect(n).toBe(1);
  });

  it('maps 401 to unauthorized (expired / revoked token)', async () => {
    const { client } = fakeGitHub({ 'GET /user': () => ok({ message: 'Bad credentials' }, 401) });
    const err = await rejection(client.get('/user'));
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toMatch(/Войдите/);
  });

  it('maps the primary rate limit with its reset time, without retrying', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    let n = 0;
    const { client } = fakeGitHub({ 'GET /user/repos': () => (n++, ok({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })) });
    const err = await rejection(client.get('/user/repos'));
    expect(err.code).toBe('rate_limited');
    expect(err.resetAt).toBe(reset * 1000);
    expect(err.message).toMatch(/10 мин/);
    expect(err.retryable).toBe(true);
    expect(n).toBe(1);
  });

  it('waits out a short secondary rate limit (Retry-After)', async () => {
    let n = 0;
    const sleep = vi.fn(async () => {});
    const fetch = (async () => (++n === 1 ? ok({ message: 'secondary rate limit' }, 403, { 'retry-after': '2' }) : ok({ ok: 1 }))) as unknown as typeof globalThis.fetch;
    const client = new GitHubClient({ token: 't', apiUrl: 'https://api.test', fetch, sleep });
    expect(await client.get('/x')).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('names missing OAuth scopes on 403', async () => {
    const { client } = fakeGitHub({ 'GET /x': () => ok({ message: 'Resource not accessible' }, 403, { 'x-accepted-oauth-scopes': 'repo', 'x-oauth-scopes': 'read:user' }) });
    const err = await rejection(client.get('/x'));
    expect(err.code).toBe('forbidden');
    expect(err.missingScopes).toEqual(['repo']);
    expect(err.message).toMatch(/repo/);
  });

  it('maps GraphQL INSUFFICIENT_SCOPES to forbidden', async () => {
    const { client } = fakeGitHub({
      'POST /graphql': () => ok({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: "The 'projectsV2' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes." }] }),
    });
    const err = await rejection(listProjects(client, 'me'));
    expect(err.code).toBe('forbidden');
    expect(err.missingScopes).toEqual(['read:project']);
  });

  it('follows Link: rel="next" when paginating', async () => {
    const { client } = fakeGitHub({
      'GET /user/repos': ({ url }) =>
        url.searchParams.get('page') === '2'
          ? ok([{ n: 2 }])
          : ok([{ n: 1 }], 200, { link: '<https://api.test/user/repos?page=2>; rel="next", <https://api.test/user/repos?page=2>; rel="last"' }),
    });
    expect(await client.paginate('/user/repos')).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('repositories and projects', () => {
  const raw = (name: string, extra: object = {}) => ({
    full_name: `me/${name}`,
    name,
    owner: { login: 'me', type: 'User' },
    private: false,
    has_issues: true,
    html_url: `https://gh.test/me/${name}`,
    default_branch: 'main',
    pushed_at: null,
    permissions: { push: true },
    ...extra,
  });

  it('lists only repositories you can push to, without archived ones', async () => {
    const { client } = fakeGitHub({ 'GET /user/repos': () => ok([raw('a'), raw('ro', { permissions: { push: false } }), raw('old', { archived: true })]) });
    expect((await listRepos(client)).map((r) => r.fullName)).toEqual(['me/a']);
  });

  it('checkRepo explains why a repository can not be used', async () => {
    const { client } = fakeGitHub({
      'GET /repos/me/ro': () => ok(raw('ro', { permissions: { push: false } })),
      'GET /repos/me/off': () => ok(raw('off', { has_issues: false })),
    });
    await expect(checkRepo(client, 'me', 'ro')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(checkRepo(client, 'me', 'off')).rejects.toMatchObject({ code: 'issues_disabled' });
    await expect(checkRepo(client, 'me', 'gone')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists projects of a user or org, open ones first', async () => {
    const { client } = fakeGitHub({
      'POST /graphql': () => ok({ data: { repositoryOwner: { projectsV2: { nodes: [{ id: 'P1', number: 1, title: 'old', url: 'u', closed: true }, { id: 'P2', number: 2, title: 'new', url: 'u', closed: false }] } } } }),
    });
    expect((await listProjects(client, 'me')).map((p) => p.id)).toEqual(['P2', 'P1']);
  });
});

describe('syncComment', () => {
  const target = { owner: 'me', repo: 'site', projectId: 'PVT_1' };
  const issue = { number: 7, html_url: 'https://gh.test/me/site/issues/7', node_id: 'I_7' };

  function repoRoutes(extra: Record<string, Handler> = {}) {
    return {
      'GET /repos/me/site/git/ref/heads/comenta-attachments': () => ok({ message: 'Not Found' }, 404),
      'POST /repos/me/site/git/trees': () => ok({ sha: 'tree1' }, 201),
      'POST /repos/me/site/git/commits': () => ok({ sha: 'commit1' }, 201),
      'POST /repos/me/site/git/refs': () => ok({ ref: 'refs/heads/comenta-attachments' }, 201),
      'PUT /repos/me/site/contents/.+': ({ url }: { url: URL }) => ok({ content: { html_url: `https://gh.test/blob${url.pathname.split('/contents')[1]}`, download_url: null } }, 201),
      'POST /repos/me/site/issues': () => ok(issue, 201),
      'POST /graphql': () => ok({ data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } }),
      ...extra,
    };
  }

  it('uploads recordings to an orphan branch, creates the issue and adds it to the project', async () => {
    const { client, calls } = fakeGitHub(repoRoutes());
    const p = payload({ attachments: [att('audio', 42000, 'a1')] });
    const res = await syncComment(client, target, p, [{ attachment: p.attachments![0], data: new Uint8Array([1, 2, 3]) }], { checkExisting: false });
    expect(res).toMatchObject({ provider: 'github', repo: 'me/site', number: 7, url: issue.html_url, projectId: 'PVT_1', existed: false });
    const commit = calls.find((c) => c.path.endsWith('/git/commits'))!;
    expect(commit.body.parents).toEqual([]); // orphan: does not copy the code
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/repos/me/site/contents/comenta/c0ffee00-1111-2222-3333-444455556666/voice-a1.webm');
    expect(put.body).toMatchObject({ branch: 'comenta-attachments', content: 'AQID' });
    const created = calls.find((c) => c.path.endsWith('/issues'))!;
    expect(created.body.title).toBe('Кнопка оплаты не нажимается на мобильном');
    expect(created.body.body).toContain('[🎙 Голос, 0:42](https://gh.test/blob/comenta/c0ffee00-1111-2222-3333-444455556666/voice-a1.webm)');
    const gql = calls.find((c) => c.path === '/graphql')!;
    expect(gql.body.variables).toEqual({ p: 'PVT_1', c: 'I_7' });
    expect(calls.some((c) => c.path.startsWith('/search'))).toBe(false);
  });

  it('is idempotent: a retry finds the issue by its marker and creates nothing', async () => {
    const p = payload();
    const { client, calls } = fakeGitHub(
      repoRoutes({ 'GET /search/issues': () => ok({ items: [{ ...issue, body: `x\n<!-- comenta:id=${p.id} -->` }] }) }),
    );
    const res = await syncComment(client, target, p, []);
    expect(res).toMatchObject({ number: 7, existed: true });
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues'))).toBe(false);
    expect(calls.find((c) => c.path === '/search/issues')).toBeTruthy();
  });

  it('reuses recordings uploaded by an earlier attempt (422 → read the file)', async () => {
    const p = payload({ attachments: [att('screen', 58000, 's1')] });
    const { client } = fakeGitHub(
      repoRoutes({
        'GET /repos/me/site/git/ref/heads/comenta-attachments': () => ok({ ref: 'x' }),
        'PUT /repos/me/site/contents/.+': () => ok({ message: '"sha" wasn\'t supplied.' }, 422),
        'GET /repos/me/site/contents/.+': () => ok({ html_url: 'https://gh.test/existing.webm', download_url: null }),
        'GET /search/issues': () => ok({ items: [] }),
      }),
    );
    const files = [{ attachment: p.attachments![0], data: new Uint8Array([9]) }];
    const res = await syncComment(client, target, p, files);
    expect(res.number).toBe(7);
  });

  it('keeps the issue when adding it to the project fails', async () => {
    const { client } = fakeGitHub(repoRoutes({ 'POST /graphql': () => ok({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }) }));
    const res = await syncComment(client, target, payload(), [], { checkExisting: false });
    expect(res.number).toBe(7);
    expect(res.projectError).toMatch(/Не найдено/);
    expect(res.projectId).toBeUndefined();
  });

  it('surfaces a disabled issue tracker clearly', async () => {
    const { client } = fakeGitHub(repoRoutes({ 'POST /repos/me/site/issues': () => ok({ message: 'Issues are disabled for this repo' }, 410) }));
    await expect(syncComment(client, target, payload(), [], { checkExisting: false })).rejects.toMatchObject({ code: 'issues_disabled' });
  });
});

describe('OAuth', () => {
  it('builds the authorize URL with state and no scopes (a GitHub App has permissions instead)', () => {
    const u = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'https://site.test/cb', state: 's1' }));
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.has('scope')).toBe(false);
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('exchanges a code; an expired code gives a clear error', async () => {
    const good = (async () => ok({ access_token: 'ghu_x', refresh_token: 'ghr_x', expires_in: 28800, scope: '' })) as unknown as typeof fetch;
    const before = Date.now();
    const got = await exchangeCode({ clientId: 'a', clientSecret: 'b', code: 'c', redirectUri: 'r', fetch: good });
    expect(got).toMatchObject({ token: 'ghu_x', refreshToken: 'ghr_x' });
    expect(got.expiresAt).toBeGreaterThanOrEqual(before + 28800_000);
    const bad = (async () => ok({ error: 'bad_verification_code' })) as unknown as typeof fetch;
    await expect(exchangeCode({ clientId: 'a', clientSecret: 'b', code: 'c', redirectUri: 'r', fetch: bad })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refreshes a token; a dead refresh token asks to sign in, a GitHub outage does not', async () => {
    const calls: Array<Record<string, string>> = [];
    const good = (async (_: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return ok({ access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 });
    }) as unknown as typeof fetch;
    const o = { clientId: 'a', clientSecret: 'b', refreshToken: 'ghr_old' };
    expect(await refreshAccessToken({ ...o, fetch: good })).toMatchObject({ token: 'ghu_new', refreshToken: 'ghr_new' });
    expect(calls[0]).toEqual({ client_id: 'a', client_secret: 'b', grant_type: 'refresh_token', refresh_token: 'ghr_old' });
    const dead = (async () => ok({ error: 'bad_refresh_token' })) as unknown as typeof fetch;
    await expect(refreshAccessToken({ ...o, fetch: dead })).rejects.toMatchObject({ code: 'unauthorized' });
    const down = (async () => ok({ message: 'oops' }, 503)) as unknown as typeof fetch;
    await expect(refreshAccessToken({ ...o, fetch: down })).rejects.toMatchObject({ code: 'network', retryable: true });
  });

  it('builds the install URL', () => {
    expect(installUrl({ slug: 'comenta-1', state: 's 1' })).toBe('https://github.com/apps/comenta-1/installations/new?state=s%201');
  });

  it('asks a token function before every request', async () => {
    const seen: string[] = [];
    const fetch = (async (_: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization);
      return ok({});
    }) as unknown as typeof globalThis.fetch;
    let n = 0;
    const client = new GitHubClient({ token: async () => `t${++n}`, fetch });
    await client.get('/a');
    await client.get('/b');
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('lists repositories of all installations: writable, not archived, latest first', async () => {
    const repo = (name: string, pushed_at: string, extra = {}) => ({ full_name: `me/${name}`, name, owner: { login: 'me', type: 'User' }, private: false, has_issues: true, html_url: '', default_branch: 'main', pushed_at, permissions: { push: true }, ...extra });
    const { client } = fakeGitHub({
      'GET /user/installations': () => ok({ total_count: 2, installations: [{ id: 1 }, { id: 2 }] }),
      'GET /user/installations/1/repositories': () => ok({ repositories: [repo('old', '2026-01-01T00:00:00Z'), repo('archived', '2026-09-01T00:00:00Z', { archived: true })] }),
      'GET /user/installations/2/repositories': () => ok({ repositories: [repo('new', '2026-06-01T00:00:00Z'), repo('readonly', '2026-07-01T00:00:00Z', { permissions: { pull: true } })] }),
    });
    const repos = await listInstallationRepos(client);
    expect(repos.map((r) => r.name)).toEqual(['new', 'old']);
    expect(repos.map((r) => r.installationId)).toEqual([2, 1]);
  });
});

describe('GitHub App (bot)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

  it('signs an RS256 JWT with the PKCS#1 key GitHub hands out', async () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    const jwt = await createAppJwt(424242, privateKey, now);
    const [h, p, sig] = jwt.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(privateKey), Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toEqual({ iss: '424242', iat: now / 1000 - 60, exp: now / 1000 + 540 });
  });

  it('rejects an unreadable key with a clear error', async () => {
    await expect(createAppJwt(1, 'not a key')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('mints installation tokens once and reuses them until close to expiry', async () => {
    let minted = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/app/installations/7/access_tokens' && init.method === 'POST') {
        expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
        return ok({ token: `ghs_${++minted}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const auth = new GitHubAppAuth({ appId: 1, privateKey, apiUrl: 'https://api.test', fetch });
    const [a, b] = await Promise.all([auth.installationToken(7), auth.installationToken(7)]);
    expect(a.token).toBe('ghs_1');
    expect(b.token).toBe('ghs_1');
    expect((await auth.installationToken(7)).token).toBe('ghs_1');
    auth.forget(7);
    expect((await auth.installationToken(7)).token).toBe('ghs_2');
    // removed app: GitHub answers 404 for the installation
    await expect(auth.installationToken(8)).rejects.toMatchObject({ code: 'uninstalled' });
  });
});

describe('httpAdapter + issue link', () => {
  it('passes the issue from the server answer to the widget', async () => {
    const issueLink = { provider: 'github', repo: 'me/site', number: 3, url: 'https://gh.test/3' };
    const fetch = vi.fn(async () => ok({ ok: true, issue: issueLink }, 201));
    const res = await httpAdapter({ endpoint: '/api/f', fetch }).submit(payload());
    expect(res).toEqual({ issue: issueLink });
  });
});
