// A fake GitLab (OAuth sign-in + the REST v4 endpoints Comenta uses) for the demo and the e2e tests.
//   GITLAB_MOCK=1 node demo/server.mjs
// The server then treats http://localhost:PORT/__gitlab as a self-hosted GitLab with an OAuth application.
//
//   GET  /__gitlab/oauth/authorize          consent page ("Authorize" / "Cancel")
//   POST /__gitlab/oauth/token              code or refresh token → tokens (refresh tokens are single-use)
//   POST /__gitlab/oauth/revoke             revoke a token
//   GET  /__gitlab/oauth/token/info         scopes of a token
//   *    /__gitlab/api/v4/...               REST
//   GET  /__gitlab/state                     what was created (issues, notes, uploads)
//   POST /__gitlab/control                   { revoke, rateLimit, failNext, delayMs, projects: 'empty', scopes, expiresIn, level }
//   POST /__gitlab/issue                     act on an issue as someone on GitLab:
//                                              { project, iid, close: true } | { …, reopen: true } | { …, delete: true } | { …, move: true }
//                                              { project, iid, note: 'text', username?, internal?, system? } → { id }
//                                              { editNote: id, body } | { deleteNote: id }
//   POST /__gitlab/reset
export const MOCK_GITLAB = { clientId: 'mock-gl-app', clientSecret: 'mock-gl-secret' };

function initialState() {
  const ns = {
    'demo-owner': { full_path: 'demo-owner', kind: 'user' },
    'acme-studio': { full_path: 'acme-studio', kind: 'group' },
    'acme-studio/frontend': { full_path: 'acme-studio/frontend', kind: 'group' },
  };
  let id = 100;
  const project = (namespace, path, name, extra = {}) => ({
    id: ++id,
    namespace: ns[namespace],
    path,
    name,
    visibility: 'private',
    archived: false,
    issues_enabled: true,
    level: 30,
    last_activity_at: '2026-11-01T10:00:00Z',
    ...extra,
  });
  return {
    user: { id: 7, username: 'demo-owner', name: 'Владимир' },
    projects: [
      project('demo-owner', 'comenta-site', 'Comenta Site', { level: 50, last_activity_at: '2026-11-04T18:00:00Z' }),
      project('acme-studio', 'web-app', 'Web App', { last_activity_at: '2026-11-04T12:00:00Z' }),
      project('acme-studio/frontend', 'design-system', 'Design System', { visibility: 'internal', last_activity_at: '2026-11-03T12:00:00Z' }),
      project('demo-owner', 'landing', 'Landing', { visibility: 'public', level: 50, last_activity_at: '2026-11-02T09:00:00Z' }),
      project('demo-owner', 'no-issues', 'No Issues', { issues_enabled: false, level: 50, last_activity_at: '2026-10-11T09:00:00Z' }),
      project('acme-studio', 'docs', 'Docs', { level: 10, last_activity_at: '2026-10-02T09:00:00Z' }),
      project('demo-owner', 'old-archive', 'Old Archive', { archived: true, level: 50, last_activity_at: '2025-01-01T09:00:00Z' }),
    ],
    tokens: new Map(), // token → { scopes, revoked, refresh, expiresAt, pat }
    codes: new Map(), // code → scopes
    issues: [], // { id, iid, project_id, title, description, state, closed_at, closed_by, updated_at, created_at, author, deleted, moved_to_id }
    notes: [], // { id, project_id, iid, body, author, system, internal, created_at, updated_at }
    uploads: [], // { project_id, name, size, url }
    nextIssueId: 5000,
    nextNoteId: 8000,
    rateLimit: 0,
    failNext: 0,
    delayMs: 0,
    emptyProjects: false,
    grantScopes: ['api', 'read_user'],
    expiresIn: 7200,
    refreshes: 0,
    revoked: 0,
    calls: [],
  };
}

export function createGitLabMock(base) {
  let s = initialState();
  const json = (res, status, data, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(data));
  const readRaw = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  };
  const readBody = async (req) => {
    const text = (await readRaw(req)).toString('utf8');
    if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    try {
      return JSON.parse(text || '{}');
    } catch {
      return {};
    }
  };
  const rand = () => `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  let lastTick = 0;
  const tick = () => {
    lastTick = Math.max(Date.now(), lastTick + 1);
    return new Date(lastTick).toISOString();
  };
  const fullPath = (p) => `${p.namespace.full_path}/${p.path}`;
  const webUrl = (p) => `${base}/${fullPath(p)}`;
  const findProject = (ref) => {
    const key = decodeURIComponent(ref);
    return s.projects.find((p) => String(p.id) === key || fullPath(p) === key) ?? null;
  };
  const projectJson = (p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    path_with_namespace: fullPath(p),
    namespace: { full_path: p.namespace.full_path, kind: p.namespace.kind },
    visibility: p.visibility,
    archived: p.archived,
    issues_enabled: p.issues_enabled,
    web_url: webUrl(p),
    last_activity_at: p.last_activity_at,
    permissions: { project_access: { access_level: p.level }, group_access: null },
  });
  const userJson = (username, name) => ({ username, name: name ?? (username === s.user.username ? s.user.name : username), avatar_url: `${base}/avatar.svg`, web_url: `${base}/${username}` });
  const issueJson = (i) => {
    const p = s.projects.find((x) => x.id === i.project_id);
    return {
      id: i.id,
      iid: i.iid,
      project_id: i.project_id,
      title: i.title,
      description: i.description,
      state: i.state,
      created_at: i.created_at,
      updated_at: i.updated_at,
      closed_at: i.closed_at,
      closed_by: i.state === 'closed' && i.closed_by ? userJson(i.closed_by) : null,
      moved_to_id: i.moved_to_id ?? null,
      author: userJson(i.author),
      web_url: `${webUrl(p)}/-/issues/${i.iid}`,
      references: { full: `${fullPath(p)}#${i.iid}` },
    };
  };
  const noteJson = (n) => ({ id: n.id, body: n.body, system: !!n.system, internal: !!n.internal, confidential: !!n.internal, created_at: n.created_at, updated_at: n.updated_at, author: userJson(n.author), noteable_iid: n.iid });
  const touch = (i) => (i.updated_at = tick());
  const addNote = (issue, body, author, extra = {}) => {
    const at = tick();
    const n = { id: s.nextNoteId++, project_id: issue.project_id, iid: issue.iid, body, author, created_at: at, updated_at: at, ...extra };
    s.notes.push(n);
    issue.updated_at = at; // like GitLab: a note touches its issue
    return n;
  };
  const tokenOf = (req) => {
    const t = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? req.headers['private-token'];
    if (!t) return null;
    // personal access tokens for the "paste a token" path: anything starting with glpat-mock
    if (!s.tokens.has(t) && t.startsWith('glpat-mock')) s.tokens.set(t, { scopes: s.grantScopes, revoked: false, pat: true });
    const rec = s.tokens.get(t);
    if (!rec || rec.revoked) return null;
    if (rec.expiresAt && rec.expiresAt < Date.now()) return null;
    return rec;
  };
  const issueTokens = (scopes) => {
    const token = `glo_mock_${rand()}`;
    const refresh = `glr_mock_${rand()}`;
    s.tokens.set(token, { scopes, revoked: false, refresh, expiresAt: Date.now() + s.expiresIn * 1000 });
    return { access_token: token, token_type: 'Bearer', expires_in: s.expiresIn, refresh_token: refresh, scope: scopes.join(' '), created_at: Math.floor(Date.now() / 1000) };
  };

  async function api(req, res, path, url) {
    s.calls.push(`${req.method} ${path}`);
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (path === '/version' && !req.headers.authorization) return json(res, 401, { message: '401 Unauthorized' });
    if (s.failNext > 0) {
      s.failNext--;
      return json(res, 502, { message: '502 Bad Gateway' });
    }
    const tok = tokenOf(req);
    if (!tok) return json(res, 401, { error: 'invalid_token', error_description: 'Token is expired. You can either do re-authorization or token refresh.' });
    if (s.rateLimit) return json(res, 429, { message: 'Retry later' }, { 'Retry-After': String(s.rateLimit), 'RateLimit-Reset': String(Math.floor(Date.now() / 1000) + s.rateLimit), 'RateLimit-Remaining': '0' });
    const needApi = !(req.method === 'GET' && (path === '/user' || path === '/version'));
    if (needApi && !tok.scopes.includes('api') && !(req.method === 'GET' && tok.scopes.includes('read_api'))) {
      return json(res, 403, { error: 'insufficient_scope', error_description: 'The request requires higher privileges than provided by the access token.', scope: 'api' }, { 'WWW-Authenticate': 'Bearer realm="GitLab", error="insufficient_scope", scope="api"' });
    }
    const send = (status, data, extra = {}) => json(res, status, data, extra);
    const page = (list) => {
      const per = Math.min(100, Number(url.searchParams.get('per_page') ?? 20));
      const pg = Number(url.searchParams.get('page') ?? 1);
      const next = new URL(url);
      next.searchParams.set('page', String(pg + 1));
      return { items: list.slice((pg - 1) * per, pg * per), extra: pg * per < list.length ? { Link: `<${base}/api/v4${path}?${next.searchParams}>; rel="next"` } : {} };
    };
    let m;
    if (path === '/version') return send(200, { version: '17.5.0-mock', revision: 'mock' });
    if (path === '/user' && req.method === 'GET') return send(200, { id: s.user.id, username: s.user.username, name: s.user.name, avatar_url: `${base}/avatar.svg`, web_url: `${base}/${s.user.username}` });
    if (path === '/personal_access_tokens/self' && req.method === 'GET') return tok.pat ? send(200, { scopes: tok.scopes }) : send(404, { message: '404 Not Found' });
    if (path === '/projects' && req.method === 'GET') {
      const min = Number(url.searchParams.get('min_access_level') ?? 0);
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const list = s.emptyProjects
        ? []
        : s.projects
            .filter((p) => p.level >= min && (url.searchParams.get('archived') !== 'false' || !p.archived))
            .filter((p) => !q || `${fullPath(p)} ${p.name}`.toLowerCase().includes(q))
            .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
            .map(projectJson);
      const { items, extra } = page(list);
      return send(200, items, extra);
    }
    if ((m = /^\/projects\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const p = findProject(m[1]);
      return p && p.level >= 10 ? send(200, projectJson(p)) : send(404, { message: '404 Project Not Found' });
    }
    if ((m = /^\/projects\/([^/]+)\/(.+)$/.exec(path))) {
      const p = findProject(m[1]);
      if (!p || p.level < 10) return send(404, { message: '404 Project Not Found' });
      const rest = `/${m[2]}`;
      if (rest === '/uploads' && req.method === 'POST') {
        const raw = await readRaw(req);
        const name = /filename="([^"]+)"/.exec(raw.toString('latin1'))?.[1] ?? 'file';
        const secret = rand().slice(0, 32);
        const up = { project_id: p.id, name, size: raw.length, url: `/uploads/${secret}/${name}` };
        s.uploads.push(up);
        return send(201, { id: s.uploads.length, alt: name, url: up.url, full_path: `/-/project/${p.id}/uploads/${secret}/${name}`, markdown: `![${name}](${up.url})` });
      }
      if (rest === '/issues' && req.method === 'POST') {
        if (!p.issues_enabled) return send(403, { message: '403 Forbidden' });
        if (p.level < 20) return send(403, { message: '403 Forbidden' });
        const body = await readBody(req);
        if (!body.title) return send(400, { message: { title: ['is missing'] } });
        const at = tick();
        const issue = { id: s.nextIssueId++, iid: s.issues.filter((i) => i.project_id === p.id).length + 1, project_id: p.id, title: body.title, description: body.description ?? '', state: 'opened', created_at: at, updated_at: at, closed_at: null, closed_by: null, author: s.user.username };
        s.issues.push(issue);
        return send(201, issueJson(issue));
      }
      if (rest === '/issues' && req.method === 'GET') {
        const after = url.searchParams.get('updated_after') ?? '';
        const q = url.searchParams.get('search') ?? '';
        const list = s.issues
          .filter((i) => i.project_id === p.id && !i.deleted && i.updated_at >= after && (!q || `${i.title} ${i.description}`.includes(q)))
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .map(issueJson);
        const { items, extra } = page(list);
        return send(200, items, extra);
      }
      if ((m = /^\/issues\/(\d+)(\/notes(?:\/(\d+))?)?$/.exec(rest))) {
        const issue = s.issues.find((i) => i.project_id === p.id && i.iid === Number(m[1]));
        if (!issue || issue.deleted) return send(404, { message: '404 Issue Not Found' });
        if (!m[2] && req.method === 'GET') return send(200, issueJson(issue));
        if (!m[2] && req.method === 'PUT') {
          const { state_event } = await readBody(req);
          if (p.level < 20) return send(403, { message: '403 Forbidden' });
          if (state_event === 'close' && issue.state !== 'closed') Object.assign(issue, { state: 'closed', closed_at: tick(), closed_by: s.user.username, updated_at: tick() });
          if (state_event === 'reopen' && issue.state === 'closed') Object.assign(issue, { state: 'opened', closed_at: null, closed_by: null, updated_at: tick() });
          s.issueEdits = (s.issueEdits ?? 0) + 1;
          return send(200, issueJson(issue));
        }
        if (m[2] && !m[3] && req.method === 'GET') {
          const list = s.notes.filter((n) => n.project_id === p.id && n.iid === issue.iid).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(noteJson);
          const { items, extra } = page(list);
          return send(200, items, extra);
        }
        if (m[2] && !m[3] && req.method === 'POST') {
          const { body } = await readBody(req);
          if (!body) return send(400, { message: { note: ["can't be blank"] } });
          return send(201, noteJson(addNote(issue, String(body), s.user.username)));
        }
        if (m[3]) {
          const n = s.notes.find((x) => x.id === Number(m[3]) && x.project_id === p.id && x.iid === issue.iid);
          if (!n) return send(404, { message: '404 Note Not Found' });
          if (req.method === 'GET') return send(200, noteJson(n));
          if (req.method === 'PUT') {
            const { body } = await readBody(req);
            n.body = String(body ?? '');
            n.updated_at = tick();
            touch(issue);
            return send(200, noteJson(n));
          }
          if (req.method === 'DELETE') {
            s.notes = s.notes.filter((x) => x !== n);
            touch(issue);
            return res.writeHead(204).end();
          }
        }
      }
    }
    return send(404, { message: '404 Not Found' });
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** Returns true when the request was for the mock. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/__gitlab/')) return false;
    const path = url.pathname.slice('/__gitlab'.length);
    if (path === '/avatar.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#6b4fbb"/><text x="20" y="26" font-family="system-ui,sans-serif" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">В</text></svg>',
      );
      return true;
    }
    if (path === '/oauth/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '/';
      const state = url.searchParams.get('state') ?? '';
      const ok = url.searchParams.get('client_id') === MOCK_GITLAB.clientId;
      const code = `glcode_${rand()}`;
      s.codes.set(code, s.grantScopes);
      const yes = `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      const no = `${redirect}?error=access_denied&error_description=${encodeURIComponent('The resource owner denied the request.')}&state=${encodeURIComponent(state)}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Mock GitLab — Authorize</title>
<body style="font:15px system-ui;background:#fbfafd;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="background:#fff;border:1px solid #dcdcde;border-radius:8px;padding:28px;max-width:400px">
<p style="color:#737278;margin:0 0 6px">Тестовый GitLab (мок)</p>
${ok ? `<h1 style="font-size:20px;margin:0 0 12px">Разрешить Comenta доступ к вашему аккаунту @${esc(s.user.username)}?</h1>
<p>Права: ${esc(url.searchParams.get('scope') ?? '')}</p>
<p style="display:flex;gap:8px"><a id="authorize" href="${esc(yes)}" style="background:#1f75cb;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none">Authorize</a>
<a id="cancel" href="${esc(no)}" style="padding:8px 14px;border:1px solid #dcdcde;border-radius:4px;text-decoration:none;color:#333238">Deny</a></p>` : '<h1>The client application is unknown.</h1>'}</main>`);
      return true;
    }
    if (path === '/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.client_id !== MOCK_GITLAB.clientId || body.client_secret !== MOCK_GITLAB.clientSecret) return json(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed.' }), true;
      if (body.grant_type === 'refresh_token') {
        const old = [...s.tokens.values()].find((t) => t.refresh === body.refresh_token && !t.refreshed);
        if (!old || old.revoked) return json(res, 400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired, revoked.' }), true;
        old.revoked = true;
        old.refreshed = true;
        s.refreshes++;
        return json(res, 200, issueTokens(old.scopes)), true;
      }
      const scopes = s.codes.get(body.code);
      if (!scopes) return json(res, 400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired, revoked.' }), true;
      s.codes.delete(body.code);
      return json(res, 200, issueTokens(scopes)), true;
    }
    if (path === '/oauth/revoke' && req.method === 'POST') {
      const body = await readBody(req);
      const rec = s.tokens.get(body.token);
      if (rec && !rec.revoked) (rec.revoked = true), s.revoked++;
      return json(res, 200, {}), true;
    }
    if (path === '/oauth/token/info' && req.method === 'GET') {
      const tok = tokenOf(req);
      if (!tok || tok.pat) return json(res, 401, { error: 'invalid_token' }), true;
      return json(res, 200, { scope: tok.scopes, expires_in: Math.round((tok.expiresAt - Date.now()) / 1000) }), true;
    }
    if (path === '/state' && req.method === 'GET') {
      return json(res, 200, { issues: s.issues.map(issueJson), notes: s.notes.map(noteJson), uploads: s.uploads, refreshes: s.refreshes, revoked: s.revoked, calls: s.calls, issueEdits: s.issueEdits ?? 0 }), true;
    }
    if (path === '/control' && req.method === 'POST') {
      const c = await readBody(req);
      if (c.revoke) for (const t of s.tokens.values()) t.revoked = true;
      if ('rateLimit' in c) s.rateLimit = Number(c.rateLimit) || 0;
      if ('failNext' in c) s.failNext = Number(c.failNext) || 0;
      if ('delayMs' in c) s.delayMs = Number(c.delayMs) || 0;
      if ('projects' in c) s.emptyProjects = c.projects === 'empty';
      if ('scopes' in c) s.grantScopes = String(c.scopes).split(/[\s,]+/).filter(Boolean);
      if ('expiresIn' in c) s.expiresIn = Number(c.expiresIn);
      if ('level' in c) for (const p of s.projects) if (p.id === c.level.project || `${p.namespace.full_path}/${p.path}` === c.level.project) p.level = c.level.value;
      return json(res, 200, { ok: true }), true;
    }
    if (path === '/issue' && req.method === 'POST') {
      const a = await readBody(req);
      if (a.editNote || a.deleteNote) {
        const n = s.notes.find((x) => x.id === Number(a.editNote ?? a.deleteNote));
        if (!n) return json(res, 404, { message: 'no such note' }), true;
        if (a.deleteNote) s.notes = s.notes.filter((x) => x !== n);
        else (n.body = String(a.body ?? '')), (n.updated_at = tick());
        const issue = s.issues.find((i) => i.project_id === n.project_id && i.iid === n.iid);
        if (issue) touch(issue);
        return json(res, 200, { ok: true }), true;
      }
      const p = findProject(String(a.project));
      const issue = p && s.issues.find((i) => i.project_id === p.id && i.iid === Number(a.iid));
      if (!issue) return json(res, 404, { message: 'no such issue' }), true;
      let out = { ok: true };
      const who = a.username ?? 'gl-dev';
      if (a.close) Object.assign(issue, { state: 'closed', closed_at: tick(), closed_by: who, updated_at: tick() });
      if (a.reopen) Object.assign(issue, { state: 'opened', closed_at: null, closed_by: null, updated_at: tick() });
      if (a.note) out = { id: addNote(issue, String(a.note), who, { internal: !!a.internal, system: !!a.system }).id };
      if (a.delete) issue.deleted = true;
      if (a.move) Object.assign(issue, { state: 'closed', closed_at: tick(), closed_by: who, moved_to_id: issue.id + 100000, updated_at: tick() });
      return json(res, 200, out), true;
    }
    if (path === '/reset' && req.method === 'POST') {
      s = initialState();
      return json(res, 200, { ok: true }), true;
    }
    if (path.startsWith('/api/v4/')) {
      await api(req, res, path.slice('/api/v4'.length), url);
      return true;
    }
    // project pages, issues, uploads: a plain page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Mock GitLab</title><p>Тестовый GitLab: ${esc(path)}</p>`);
    return true;
  }

  return { handle, reset: () => (s = initialState()) };
}
