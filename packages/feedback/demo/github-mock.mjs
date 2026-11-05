// A fake GitHub (GitHub App sign-in + the REST/GraphQL endpoints Comenta uses) for the demo and the e2e tests.
//   GITHUB_MOCK=1 node demo/server.mjs
// The server then points GITHUB_API_URL / GITHUB_WEB_URL here and sets a fake GitHub App.
//
//   GET  /__github/login/oauth/authorize    consent page ("Authorize" / "Cancel")
//   POST /__github/login/oauth/access_token code or refresh token → token
//   GET  /__github/apps/:slug/installations/new  install page
//   POST /__github/settings/apps/new         registers an app from a manifest (pnpm github-app:setup)
//   *    /__github/api/...                   REST + /graphql
//   GET  /__github/state                     what was created (issues, files, project items)
//   POST /__github/control                   { revoke, rateLimit, failNext, repos, projects, scopes, delayMs,
//                                              installed, selected, expiresIn }
//   POST /__github/issue                     act on an issue as someone on GitHub:
//                                              { repo, number, close: 'completed'|'not_planned' } | { …, reopen: true }
//                                              { repo, number, comment: 'text', login? } → { id }
//                                              { editComment: id, body } | { deleteComment: id }
//                                              { repo, number, delete: true } | { repo, number, transfer: 'owner/name' }
//   POST /__github/reset
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

const AVATAR = '/__github/avatar.svg';
/** The fake app. Its private key mints installation tokens (ghs_, issues authored by comenta-mock[bot]). */
export const MOCK_APP = { id: 424242, slug: 'comenta-mock', clientId: 'mock-client', clientSecret: 'mock-secret' };
MOCK_APP.privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey; // PKCS#1, like GitHub's .pem
const PUBLIC_KEY = createPublicKey(MOCK_APP.privateKey);
function verifyJwt(jwt) {
  const [h, p, sig] = (jwt ?? '').split('.');
  if (!sig) return false;
  if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), PUBLIC_KEY, Buffer.from(sig, 'base64url'))) return false;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  return claims.iss === String(MOCK_APP.id) && claims.exp * 1000 > Date.now();
}

function initialState() {
  const repo = (owner, name, extra = {}) => ({
    owner,
    name,
    private: false,
    has_issues: true,
    archived: false,
    push: true,
    ownerType: owner === 'acme-studio' ? 'Organization' : 'User',
    pushed_at: '2026-11-01T10:00:00Z',
    ...extra,
  });
  return {
    user: { login: 'demo-owner', name: 'Владимир', id: 1001 },
    repos: [
      repo('demo-owner', 'comenta-site', { private: true, pushed_at: '2026-11-04T18:00:00Z' }),
      repo('acme-studio', 'web-app', { private: true, pushed_at: '2026-11-04T12:00:00Z' }),
      repo('demo-owner', 'landing', { pushed_at: '2026-11-03T09:00:00Z' }),
      repo('acme-studio', 'design-system', { pushed_at: '2026-10-30T09:00:00Z' }),
      repo('acme-studio', 'mobile', { private: true, pushed_at: '2026-10-21T09:00:00Z' }),
      repo('demo-owner', 'no-issues', { has_issues: false, pushed_at: '2026-10-11T09:00:00Z' }),
      repo('acme-studio', 'docs', { push: false, pushed_at: '2026-10-02T09:00:00Z' }),
      repo('demo-owner', 'old-archive', { archived: true, pushed_at: '2025-01-01T09:00:00Z' }),
    ],
    projects: {
      'demo-owner': [
        { id: 'PVT_owner_1', number: 1, title: 'Отзывы с сайта', closed: false },
        { id: 'PVT_owner_2', number: 2, title: 'Личный роадмап', closed: true },
      ],
      'acme-studio': [
        { id: 'PVT_acme_3', number: 3, title: 'Web App — бэклог', closed: false },
        { id: 'PVT_acme_4', number: 4, title: 'Дизайн-ревью', closed: false },
      ],
    },
    tokens: new Map(), // token → { scopes, revoked }
    codes: new Map(), // code → what the app may do
    issues: [], // { repo, number, title, body, node_id, html_url, state, state_reason, … }
    comments: [], // { id, repo, number, body, user, created_at, updated_at }
    nextCommentId: 9001,
    notModified: 0, // conditional GETs answered with 304
    files: new Map(), // `${repo}@${branch}:${path}` → { size }
    branches: new Map(), // repo → Set
    projectItems: [], // { projectId, contentId }
    rateLimit: 0, // seconds; > 0 → every API call answers 403 rate limit
    failNext: 0, // next N API calls answer 503
    delayMs: 0,
    emptyRepos: false,
    emptyProjects: false,
    installed: true, // the app is installed for the user
    selected: null, // ['owner/name']: repositories chosen at install; null: all
    expiresIn: 28800, // lifetime of new user tokens, seconds
    refreshes: 0,
    installationTokens: 0,
    calls: [],
  };
}

export function createGitHubMock(base) {
  let s = initialState();
  const manifests = new Map(); // code → manifest; survives reset: other e2e files reset concurrently
  const json = (res, status, data, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(data));
  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    try {
      return JSON.parse(text || '{}');
    } catch {
      return {};
    }
  };
  const repoJson = (r) => ({
    full_name: `${r.owner}/${r.name}`,
    name: r.name,
    owner: { login: r.owner, type: r.ownerType },
    private: r.private,
    has_issues: r.has_issues,
    archived: r.archived,
    html_url: `${base}/web/${r.owner}/${r.name}`,
    default_branch: 'main',
    pushed_at: r.pushed_at,
    permissions: { admin: false, push: r.push, pull: true },
  });
  const findRepo = (o, n) => s.repos.find((r) => r.owner === o && r.name === n);
  const rand = () => `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  /** Tokens of a GitHub App: no scopes in the headers; `can` is what the app may do. */
  const issueToken = (can) => {
    const token = `ghu_mock_${rand()}`;
    const refresh = `ghr_mock_${rand()}`;
    s.tokens.set(token, { app: true, scopes: [], can, revoked: false, refresh });
    return { access_token: token, refresh_token: refresh, expires_in: s.expiresIn, refresh_token_expires_in: 15897600, scope: '', token_type: 'bearer' };
  };
  /** A GitHub App token sees only the repositories the app was installed on. */
  const visible = (tok, r) => !tok.app || (s.installed && (!s.selected || s.selected.includes(`${r.owner}/${r.name}`)));
  const tokenOf = (req) => {
    const m = /^(?:Bearer|token)\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const t = m[1];
    // personal access tokens for the "paste a token" path: anything starting with ghp_mock
    if (!s.tokens.has(t) && t.startsWith('ghp_mock')) s.tokens.set(t, { scopes: s.grantScopes ?? ['repo', 'project', 'read:org', 'read:user'], revoked: false });
    const rec = s.tokens.get(t);
    if (rec?.installation && !s.installed) return null; // the app was removed
    return rec && !rec.revoked ? rec : null;
  };

  /** Strictly increasing timestamps: `since` filters stay exact even within one millisecond. */
  let lastTick = 0;
  const tick = () => {
    lastTick = Math.max(Date.now(), lastTick + 1);
    return new Date(lastTick).toISOString();
  };
  const touch = (repo, number) => {
    const i = s.issues.find((x) => x.repo === repo && x.number === number);
    if (i) i.updated_at = tick();
  };
  const userJson = (login) => ({ login, avatar_url: `${base}/avatar.svg`, html_url: `${base}/web/${login}`, type: login.endsWith('[bot]') ? 'Bot' : 'User' });
  const issueJson = (i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    node_id: i.node_id,
    html_url: i.html_url,
    state: i.state,
    state_reason: i.state_reason,
    closed_at: i.closed_at,
    closed_by: i.state === 'closed' && i.closed_by ? userJson(i.closed_by) : null,
    created_at: i.created_at,
    updated_at: i.updated_at,
    comments: s.comments.filter((c) => c.repo === i.repo && c.number === i.number).length,
    user: userJson(i.author),
    repository_url: `${base}/api/repos/${i.transferredTo ?? i.repo}`,
  });
  const commentJson = (c) => ({
    id: c.id,
    body: c.body,
    html_url: `${base}/web/${c.repo}/issues/${c.number}#issuecomment-${c.id}`,
    issue_url: `${base}/api/repos/${c.repo}/issues/${c.number}`,
    created_at: c.created_at,
    updated_at: c.updated_at,
    user: userJson(c.login),
  });
  const addComment = (issue, body, login) => {
    const at = tick();
    const c = { id: s.nextCommentId++, repo: issue.repo, number: issue.number, body, login, created_at: at, updated_at: at };
    s.comments.push(c);
    issue.updated_at = at;
    return c;
  };

  async function api(req, res, path, url) {
    s.calls.push(`${req.method} ${path}`);
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (s.failNext > 0) {
      s.failNext--;
      return json(res, 503, { message: 'Service Unavailable' });
    }
    if (req.method === 'DELETE' && /^\/applications\/[^/]+\/grant$/.test(path)) {
      const { access_token } = await readBody(req);
      const rec = s.tokens.get(access_token);
      if (rec) rec.revoked = true;
      return res.writeHead(204).end();
    }
    if (req.method === 'POST' && /^\/app-manifests\/[^/]+\/conversions$/.test(path)) {
      const code = path.split('/')[2];
      const manifest = manifests.get(code);
      if (!manifest) return json(res, 404, { message: 'Not Found' });
      manifests.delete(code);
      return json(res, 201, { id: MOCK_APP.id, slug: MOCK_APP.slug, client_id: MOCK_APP.clientId, client_secret: MOCK_APP.clientSecret, pem: MOCK_APP.privateKey, webhook_secret: null, html_url: `${base}/web/apps/comenta-mock`, name: manifest.name });
    }
    let mi;
    if ((mi = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && req.method === 'POST') {
      if (!verifyJwt(/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1])) return json(res, 401, { message: 'A JSON web token could not be decoded' });
      if (mi[1] !== '1' || !s.installed) return json(res, 404, { message: 'Not Found' });
      const token = `ghs_mock_${rand()}`;
      s.tokens.set(token, { app: true, installation: true, scopes: [], can: s.grantScopes ?? ['project'], revoked: false });
      s.installationTokens++;
      return json(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const tok = tokenOf(req);
    if (!tok) return json(res, 401, { message: 'Bad credentials' });
    const scopeHeaders = { 'X-OAuth-Scopes': tok.scopes.join(', '), 'X-RateLimit-Remaining': String(s.rateLimit ? 0 : 4999) };
    if (s.rateLimit) {
      return json(res, 403, { message: 'API rate limit exceeded for user.' }, { ...scopeHeaders, 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + s.rateLimit) });
    }
    const send = (status, data, extra = {}) => json(res, status, data, { ...scopeHeaders, ...extra });
    let m;

    if (path === '/user' && req.method === 'GET') {
      return send(200, { login: s.user.login, name: s.user.name, id: s.user.id, avatar_url: `${base}/avatar.svg`, html_url: `${base}/web/${s.user.login}` });
    }
    if (path === '/user/installations' && req.method === 'GET') {
      if (!tok.app) return send(403, { message: 'You must authenticate with an access token authorized to a GitHub App.' });
      const installations = s.installed ? [{ id: 1, account: { login: s.user.login }, app_slug: 'comenta-mock' }] : [];
      return send(200, { total_count: installations.length, installations });
    }
    if (path === '/user/installations/1/repositories' && req.method === 'GET') {
      if (!tok.app) return send(403, { message: 'You must authenticate with an access token authorized to a GitHub App.' });
      const repositories = s.emptyRepos ? [] : s.repos.filter((r) => visible(tok, r)).map(repoJson);
      return send(200, { total_count: repositories.length, repositories });
    }
    if (path === '/user/repos' && req.method === 'GET') {
      const all = s.emptyRepos ? [] : s.repos.map(repoJson);
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const slice = all.slice((page - 1) * per, page * per);
      const extra = page * per < all.length ? { Link: `<${base}/api/user/repos?per_page=${per}&page=${page + 1}>; rel="next"` } : {};
      return send(200, slice, extra);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const r = findRepo(m[1], m[2]);
      return r && visible(tok, r) ? send(200, repoJson(r)) : send(404, { message: 'Not Found' });
    }
    if (path === '/search/issues' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const id = /comenta:id=([\w-]+)/.exec(q)?.[1];
      const repo = /repo:(\S+)/.exec(q)?.[1];
      const items = s.issues.filter((i) => i.repo === repo && id && i.body.includes(`comenta:id=${id}`));
      return send(200, { total_count: items.length, items });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path)) && req.method === 'POST') {
      const r = findRepo(m[1], m[2]);
      if (!r) return send(404, { message: 'Not Found' });
      if (!r.has_issues) return send(410, { message: 'Issues are disabled for this repo' });
      if (!r.push && !tok.scopes.includes('repo')) return send(403, { message: 'Resource not accessible' });
      const body = await readBody(req);
      if (!body.title) return send(422, { message: 'Validation Failed' });
      const number = s.issues.filter((i) => i.repo === `${r.owner}/${r.name}`).length + 1;
      const now = new Date().toISOString();
      const issue = { repo: `${r.owner}/${r.name}`, number, title: body.title, body: body.body ?? '', node_id: `I_mock_${r.name}_${number}`, html_url: `${base}/web/${r.owner}/${r.name}/issues/${number}`, author: tok.installation ? `${MOCK_APP.slug}[bot]` : s.user.login, state: 'open', state_reason: null, closed_at: null, created_at: now, updated_at: now };
      s.issues.push(issue);
      return send(201, issue);
    }
    // ---- issue state and comments (conditional GETs: ETag / If-None-Match → 304)
    const cached = (data, extra = {}) => {
      const etag = `W/"${createHash('sha1').update(JSON.stringify(data)).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        s.notModified++;
        return res.writeHead(304, { ETag: etag, ...scopeHeaders }).end();
      }
      return send(200, data, { ETag: etag, ...extra });
    };
    const readable = (repo) => {
      const [o, n] = repo.split('/');
      const r = findRepo(o, n);
      return r && visible(tok, r);
    };
    const page = (list) => {
      const per = Math.min(100, Number(url.searchParams.get('per_page') ?? 30));
      const pg = Number(url.searchParams.get('page') ?? 1);
      const next = new URL(url);
      next.searchParams.set('page', String(pg + 1));
      return { items: list.slice((pg - 1) * per, pg * per), extra: pg * per < list.length ? { Link: `<${base}/api${path}?${next.searchParams}>; rel="next"` } : {} };
    };
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments$/.exec(path)) && req.method === 'GET') {
      const repo = `${m[1]}/${m[2]}`;
      if (!readable(repo)) return send(404, { message: 'Not Found' });
      const since = url.searchParams.get('since') ?? '';
      const list = s.comments.filter((c) => c.repo === repo && c.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at)).map(commentJson);
      const { items, extra } = page(list);
      return cached(items, extra);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(path))) {
      const c = s.comments.find((x) => x.id === Number(m[3]) && x.repo === `${m[1]}/${m[2]}`);
      if (!c) return send(404, { message: 'Not Found' });
      if (req.method === 'GET') return send(200, commentJson(c));
      if (req.method === 'PATCH') {
        const { body } = await readBody(req);
        c.body = String(body ?? '');
        c.updated_at = tick();
        touch(c.repo, c.number);
        return send(200, commentJson(c));
      }
      if (req.method === 'DELETE') {
        s.comments = s.comments.filter((x) => x !== c);
        touch(c.repo, c.number);
        return res.writeHead(204, scopeHeaders).end();
      }
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path)) && req.method === 'GET') {
      const repo = `${m[1]}/${m[2]}`;
      if (!readable(repo)) return send(404, { message: 'Not Found' });
      const since = url.searchParams.get('since') ?? '';
      const list = s.issues.filter((i) => i.repo === repo && !i.deleted && i.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at)).map(issueJson);
      const { items, extra } = page(list);
      return cached(items, extra);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/comments)?$/.exec(path))) {
      const repo = `${m[1]}/${m[2]}`;
      const issue = s.issues.find((i) => i.repo === repo && i.number === Number(m[3]));
      if (!issue || !readable(repo)) return send(404, { message: 'Not Found' });
      if (issue.deleted) return send(410, { message: 'This issue was deleted' });
      if (!m[4] && req.method === 'GET') return cached(issueJson(issue));
      if (!m[4] && req.method === 'PATCH') {
        const { state, state_reason } = await readBody(req);
        const by = tok.installation ? `${MOCK_APP.slug}[bot]` : s.user.login;
        if (state === 'closed') Object.assign(issue, { state, state_reason: state_reason ?? 'completed', closed_at: issue.state === 'closed' ? issue.closed_at : new Date().toISOString(), closed_by: by, updated_at: tick() });
        else if (state === 'open') Object.assign(issue, { state, state_reason: issue.state === 'closed' ? 'reopened' : issue.state_reason, closed_at: null, closed_by: null, updated_at: tick() });
        s.issueEdits = (s.issueEdits ?? 0) + 1;
        return send(200, issueJson(issue));
      } // after a transfer GitHub redirects; the JSON names the new repository
      if (m[4] && req.method === 'GET') {
        const { items, extra } = page(s.comments.filter((c) => c.repo === repo && c.number === issue.number).map(commentJson));
        return cached(items, extra);
      }
      if (m[4] && req.method === 'POST') {
        const { body } = await readBody(req);
        if (!body) return send(422, { message: 'Validation Failed' });
        const c = addComment(issue, String(body), tok.installation ? `${MOCK_APP.slug}[bot]` : s.user.login);
        return send(201, commentJson(c));
      }
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/.exec(path)) && req.method === 'GET') {
      const has = s.branches.get(`${m[1]}/${m[2]}`)?.has(decodeURIComponent(m[3]));
      return has ? send(200, { ref: `refs/heads/${m[3]}`, object: { sha: 'abc' } }) : send(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/git\/(trees|commits)$/.exec(path)) && req.method === 'POST') {
      await readBody(req);
      return send(201, { sha: `${m[3]}_${Math.random().toString(36).slice(2, 8)}` });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(path)) && req.method === 'POST') {
      const { ref } = await readBody(req);
      const key = `${m[1]}/${m[2]}`;
      if (!s.branches.has(key)) s.branches.set(key, new Set());
      const name = ref.replace('refs/heads/', '');
      if (s.branches.get(key).has(name)) return send(422, { message: 'Reference already exists' });
      s.branches.get(key).add(name);
      return send(201, { ref });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path))) {
      const repo = `${m[1]}/${m[2]}`;
      const filePath = decodeURIComponent(m[3]);
      const info = (branch) => ({ content: { path: filePath, html_url: `${base}/web/${repo}/blob/${branch}/${filePath}`, download_url: `${base}/raw/${repo}/${branch}/${filePath}` } });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const branch = body.branch ?? 'main';
        const key = `${repo}@${branch}:${filePath}`;
        if (s.files.has(key)) return send(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        s.files.set(key, { size: Buffer.from(body.content ?? '', 'base64').length });
        return send(201, info(branch));
      }
      if (req.method === 'GET') {
        const branch = url.searchParams.get('ref') ?? 'main';
        return s.files.has(`${repo}@${branch}:${filePath}`) ? send(200, info(branch).content) : send(404, { message: 'Not Found' });
      }
    }
    if (path === '/graphql' && req.method === 'POST') {
      const { query, variables } = await readBody(req);
      if (tok.app && !tok.can.includes('project')) return send(200, { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
      const hasProject = tok.app || tok.scopes.includes('project') || tok.scopes.includes('read:project');
      if (!hasProject) {
        return send(200, { errors: [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes." }] });
      }
      if (query.includes('repositoryOwner')) {
        const login = variables.login;
        const known = s.repos.some((r) => r.owner === login) || s.projects[login];
        if (!known) return send(200, { data: { repositoryOwner: null } });
        const nodes = s.emptyProjects ? [] : (s.projects[login] ?? []).map((p) => ({ ...p, url: `${base}/web/${login}/projects/${p.number}` }));
        return send(200, { data: { repositoryOwner: { __typename: login === 'acme-studio' ? 'Organization' : 'User', projectsV2: { nodes } } } });
      }
      if (query.includes('addProjectV2ItemById')) {
        const { p, c } = variables;
        const exists = Object.values(s.projects).flat().some((x) => x.id === p);
        if (!exists) return send(200, { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] });
        if (!s.projectItems.some((i) => i.projectId === p && i.contentId === c)) s.projectItems.push({ projectId: p, contentId: c });
        return send(200, { data: { addProjectV2ItemById: { item: { id: `PVTI_${c}` } } } });
      }
      return send(200, { errors: [{ message: 'unknown query' }] });
    }
    return send(404, { message: 'Not Found' });
  }

  /** Returns true when the request was for the mock. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/__github/')) return false;
    const path = url.pathname.slice('/__github'.length);
    if (path === '/avatar.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#c96442"/><text x="20" y="26" font-family="system-ui,sans-serif" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">В</text></svg>',
      );
      return true;
    }
    if (path === '/settings/apps/new' && req.method === 'POST') {
      const manifest = JSON.parse((await readBody(req)).manifest ?? '{}');
      const code = `manifest_${rand()}`;
      manifests.set(code, manifest);
      const state = url.searchParams.get('state');
      res.writeHead(302, { Location: `${manifest.redirect_url}?code=${code}${state ? `&state=${encodeURIComponent(state)}` : ''}` }).end();
      return true;
    }
    if (/^\/apps\/[^/]+\/installations\/new$/.test(path)) {
      // like an app with "Request user authorization during installation": back to the callback with a code
      const state = url.searchParams.get('state') ?? '';
      const code = `code_${rand()}`;
      s.codes.set(code, s.grantScopes ?? ['project']);
      const ok = `${base}/control/install?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Mock GitHub — Install</title>
<body style="font:15px system-ui;background:#f6f8fa;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px;max-width:380px">
<p style="color:#59636e;margin:0 0 6px">Тестовый GitHub (мок)</p>
<h1 style="font-size:20px;margin:0 0 12px">Установить Comenta для @${s.user.login}?</h1>
<p>Здесь на настоящем GitHub выбираются репозитории.</p>
<p style="display:flex;gap:8px"><a id="install" href="${ok.replace(/&/g, '&amp;')}" style="background:#1f883d;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Install</a></p></main>`);
      return true;
    }
    if (path === '/control/install') {
      s.installed = true;
      res.writeHead(302, { Location: `${new URL(base).origin}/api/github/auth/callback?code=${encodeURIComponent(url.searchParams.get('code') ?? '')}&installation_id=1&setup_action=install&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}` }).end();
      return true;
    }
    if (path === '/login/oauth/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '/';
      const state = url.searchParams.get('state') ?? '';
      const code = `code_${Math.random().toString(36).slice(2)}`;
      s.codes.set(code, s.grantScopes ?? ['project']);
      const ok = `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      const no = `${redirect}?error=access_denied&state=${encodeURIComponent(state)}`;
      const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Mock GitHub — Authorize</title>
<body style="font:15px system-ui;background:#f6f8fa;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px;max-width:380px">
<p style="color:#59636e;margin:0 0 6px">Тестовый GitHub (мок)</p>
<h1 style="font-size:20px;margin:0 0 12px">Разрешить Comenta доступ к @${esc(s.user.login)}?</h1>
<p>Права: issues, contents, projects</p>
<p style="display:flex;gap:8px"><a id="authorize" href="${esc(ok)}" style="background:#1f883d;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Authorize</a>
<a id="cancel" href="${esc(no)}" style="padding:8px 14px;border:1px solid #d0d7de;border-radius:6px;text-decoration:none;color:#1f2328">Cancel</a></p></main>`);
      return true;
    }
    if (path === '/login/oauth/access_token' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.grant_type === 'refresh_token') {
        // single use, like on GitHub: the old pair stops working
        const old = [...s.tokens.values()].find((t) => t.refresh === body.refresh_token && !t.refreshed);
        if (!old || old.revoked || body.client_secret !== 'mock-secret') return json(res, 200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }), true;
        old.revoked = true;
        old.refreshed = true;
        s.refreshes++;
        json(res, 200, issueToken(old.can));
        return true;
      }
      const can = s.codes.get(body.code);
      if (!can || body.client_secret !== 'mock-secret') return json(res, 200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }), true;
      s.codes.delete(body.code);
      json(res, 200, issueToken(can));
      return true;
    }
    if (path === '/state' && req.method === 'GET') {
      json(res, 200, { issues: s.issues, comments: s.comments, notModified: s.notModified, files: [...s.files.keys()], branches: Object.fromEntries([...s.branches].map(([k, v]) => [k, [...v]])), projectItems: s.projectItems, calls: s.calls, refreshes: s.refreshes, installationTokens: s.installationTokens, revoked: [...s.tokens.values()].filter((t) => t.revoked && !t.refreshed).length });
      return true;
    }
    if (path === '/control' && req.method === 'POST') {
      const c = await readBody(req);
      if (c.revoke) for (const t of s.tokens.values()) t.revoked = true;
      if (c.revokeUser) for (const t of s.tokens.values()) if (!t.installation) t.revoked = true; // the owner's sign-in ends, the app stays installed
      if ('rateLimit' in c) s.rateLimit = Number(c.rateLimit) || 0;
      if ('failNext' in c) s.failNext = Number(c.failNext) || 0;
      if ('delayMs' in c) s.delayMs = Number(c.delayMs) || 0;
      if ('repos' in c) s.emptyRepos = c.repos === 'empty';
      if ('projects' in c) s.emptyProjects = c.projects === 'empty';
      if ('installed' in c) s.installed = !!c.installed;
      if ('selected' in c) s.selected = c.selected;
      if ('expiresIn' in c) s.expiresIn = Number(c.expiresIn);
      if ('scopes' in c) s.grantScopes = c.scopes ? String(c.scopes).split(/[\s,]+/).filter(Boolean) : undefined;
      json(res, 200, { ok: true });
      return true;
    }
    if (path === '/issue' && req.method === 'POST') {
      const a = await readBody(req);
      if (a.editComment || a.deleteComment) {
        const c = s.comments.find((x) => x.id === Number(a.editComment ?? a.deleteComment));
        if (!c) return json(res, 404, { message: 'no such comment' }), true;
        if (a.deleteComment) s.comments = s.comments.filter((x) => x !== c);
        else (c.body = String(a.body ?? ''), (c.updated_at = tick()));
        touch(c.repo, c.number);
        json(res, 200, { ok: true });
        return true;
      }
      const issue = s.issues.find((i) => i.repo === a.repo && i.number === Number(a.number));
      if (!issue) return json(res, 404, { message: 'no such issue' }), true;
      let out = { ok: true };
      if (a.close) Object.assign(issue, { state: 'closed', state_reason: a.close === true ? 'completed' : a.close, closed_at: new Date().toISOString(), closed_by: a.login ?? 'octo-dev', updated_at: tick() });
      if (a.reopen) Object.assign(issue, { state: 'open', state_reason: 'reopened', closed_at: null, closed_by: null, updated_at: tick() });
      if (a.comment) out = { id: addComment(issue, String(a.comment), a.login ?? 'octo-dev').id };
      if (a.delete) issue.deleted = true;
      if (a.transfer) issue.transferredTo = a.transfer;
      json(res, 200, out);
      return true;
    }
    if (path === '/reset' && req.method === 'POST') {
      s = initialState();
      json(res, 200, { ok: true });
      return true;
    }
    if (path.startsWith('/api/')) {
      await api(req, res, path.slice(4), url);
      return true;
    }
    if (path.startsWith('/web/') || path.startsWith('/raw/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Mock GitHub</title><p>Тестовый GitHub: ${path.replace(/[<>&]/g, '')}</p>`);
      return true;
    }
    res.writeHead(404).end();
    return true;
  }

  return { handle, reset: () => (s = initialState()) };
}
