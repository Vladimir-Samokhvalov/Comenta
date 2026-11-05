// Minimal mock backend + static server for the demo. No dependencies.
//   node demo/server.mjs                         → http://localhost:5174
//   POST   /api/feedback                         → new comment, 201 (stored in demo/feedback.log, JSON lines)
//   POST   /api/feedback?fail=1                  → 503 (to try the error state)
//   GET    /api/feedback[?url=<page>]            → comments (of a page), with replies and status
//   POST   /api/feedback/:id/replies             → new reply
//   PATCH  /api/feedback/:id/replies/:replyId    → { text, updatedAt }
//   DELETE /api/feedback/:id/replies/:replyId
//   PATCH  /api/feedback/:id                     → { status, by, at }
//   multipart POST (payload + recordings) → files saved to demo/uploads/, answers { attachments: { id: url } }
//   /api/github/*                               → GitHub integration (demo/github.mjs, used by <comenta-settings>)
//   GITHUB_MOCK=1                               → fake GitHub at /__github (demo/github-mock.mjs), no account needed
//   Replies are mirrored to the linked issue; GitHub state and comments come back for the owner and the comment's author.
// The demo does not check permissions (who may resolve, edit, delete): a real backend must.
// Header X-Comenta-Space (or cookie comenta_space) keeps separate stores (the e2e tests use one per test).
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createGitHubIntegration } from './github.mjs';
import { MOCK_APP, createGitHubMock } from './github-mock.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const LOG = process.env.FEEDBACK_LOG ?? join(ROOT, 'demo', 'feedback.log');
const PORT = Number(process.env.PORT ?? 5174);
const UPLOADS = process.env.FEEDBACK_UPLOADS ?? join(ROOT, 'demo', 'uploads');
const TYPES = {
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json' };

/** space → comments. Loaded from the log on start, written back after every change. */
const store = new Map();
try {
  for (const line of readFileSync(LOG, 'utf8').split('\n').filter(Boolean)) {
    const { _space = 'default', ...c } = JSON.parse(line);
    if (!store.has(_space)) store.set(_space, []);
    store.get(_space).push(c);
  }
} catch {
  /* no log yet */
}
let saving = Promise.resolve();
function persist() {
  const lines = [];
  for (const [space, list] of store) for (const c of list) lines.push(JSON.stringify(space === 'default' ? c : { _space: space, ...c }));
  saving = saving.then(() => writeFile(LOG, lines.length ? `${lines.join('\n')}\n` : '')).catch((e) => console.error(e));
}
const cookieSpace = (req) => /(?:^|;\s*)comenta_space=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
const spaceOf = (req) => String(req.headers['x-comenta-space'] ?? cookieSpace(req) ?? 'default').slice(0, 80);

const mock = process.env.GITHUB_MOCK === '1' ? createGitHubMock(`http://localhost:${PORT}/__github`) : null;
if (mock) {
  Object.assign(process.env, {
    GITHUB_API_URL: `http://localhost:${PORT}/__github/api`,
    GITHUB_WEB_URL: `http://localhost:${PORT}/__github`,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? 'mock-client',
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? 'mock-secret',
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG ?? 'comenta-mock',
    // COMENTA_GITHUB_BOT=0: no private key, issues are created with the owner's user token
    ...(process.env.COMENTA_GITHUB_BOT === '0' ? {} : { GITHUB_APP_ID: String(MOCK_APP.id), GITHUB_APP_PRIVATE_KEY: MOCK_APP.privateKey }),
  });
}
const github = createGitHubIntegration({
  root: ROOT,
  uploadsDir: UPLOADS,
  persistComments: () => persist(),
  findComment: (space, id) => store.get(space)?.find((c) => c.id === id) ?? null,
  listComments: (space) => store.get(space) ?? [],
});
/**
 * GitHub state and comments written on GitHub are shown to the site owner and to the comment's author.
 * Here the owner is whoever has the GitHub settings session, or (demo only, the page has a user switcher
 * and no login) a request with `X-Comenta-Role: owner`; the viewer's author id comes from `X-Comenta-User`.
 * A real backend takes both from its own authentication.
 */
const isOwner = (req) => github.isOwner(req, spaceOf(req)) || req.headers['x-comenta-role'] === 'owner';
const viewerOf = (req) => ({ owner: isOwner(req), id: typeof req.headers['x-comenta-user'] === 'string' ? req.headers['x-comenta-user'].slice(0, 200) : undefined });
const listOf = (req) => {
  const k = spaceOf(req);
  if (!store.has(k)) store.set(k, []);
  return store.get(k);
};
const sameUrl = (a, b) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin + x.pathname + x.search === y.origin + y.pathname + y.search;
  } catch {
    return a === b;
  }
};
const json = (res, status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

/** JSON body, or multipart (field `payload` + recordings saved to UPLOADS). */
async function readItem(req) {
  const ctype = req.headers['content-type'] ?? '';
  const urls = {};
  const files = [];
  if (!ctype.startsWith('multipart/form-data')) return { item: JSON.parse((await readBody(req)).toString('utf8')), urls, files };
  const boundary = /boundary=([^;]+)/.exec(ctype)?.[1];
  const parts = parseMultipart(await readBody(req, 50 * 1024 * 1024), boundary);
  const item = JSON.parse(parts.find((p) => p.name === 'payload')?.data.toString('utf8') ?? 'null');
  await mkdir(UPLOADS, { recursive: true });
  for (const p of parts.filter((p) => p.name?.startsWith('file:'))) {
    const id = p.name.slice(5).replace(/[^a-zA-Z0-9-]/g, '');
    const att = item?.attachments?.find((a) => a.id === id);
    if (!att) continue;
    const ext = (extname(p.filename ?? '') || '.webm').replace(/[^.a-z0-9]/gi, '');
    await writeFile(join(UPLOADS, `${id}${ext}`), p.data);
    urls[id] = att.url = `/uploads/${id}${ext}`;
    files.push({ attachment: att, data: new Uint8Array(p.data) });
  }
  return { item, urls, files };
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Minimal multipart/form-data parser (enough for the demo). */
function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    const next = buf.indexOf(delim, headEnd);
    if (headEnd === -1 || next === -1) break;
    const head = buf.slice(start + 2, headEnd).toString();
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
    parts.push({ name, filename, type, data: buf.slice(headEnd + 4, next - 2) });
    pos = next;
  }
  return parts;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (mock && (await mock.handle(req, res, url))) return;
    if (url.pathname.startsWith('/api/github/')) return void (await github.handle(req, res, url, spaceOf(req)));

    if (url.pathname === '/api/feedback') {
      if (req.method === 'POST') {
        if (url.searchParams.has('fail')) {
          res.writeHead(503).end();
          return;
        }
        const { item: payload, urls, files: recordings } = await readItem(req);
        if (!payload?.id || (!payload?.text && !payload?.attachments?.length) || !payload?.target?.selector) {
          json(res, 400, { error: 'invalid payload' });
          return;
        }
        const list = listOf(req);
        delete payload.issue; // set by the server only
        const known = list.find((c) => c.id === payload.id);
        if (!known) list.push(payload);
        persist();
        const files = Object.values(urls);
        console.log(`[feedback] ${payload.kind ?? 'без категории'}: "${payload.text}" → ${payload.target.selector}${files.length ? ` + ${files.join(', ')}` : ''}`);
        // GitHub: create the issue (idempotent by comment id); waits a few seconds at most
        const issue = await github.onComment(spaceOf(req), known ?? payload, recordings);
        json(res, 201, { ok: true, id: payload.id, attachments: urls, ...(issue ? { issue } : {}) });
        return;
      }
      if (req.method === 'GET') {
        const page = url.searchParams.get('url');
        const list = listOf(req);
        const items = page ? list.filter((c) => sameUrl(c.page?.url, page)) : list;
        const viewer = viewerOf(req);
        // the owner or an author opened the widget / it polled: pull fresh issue state and comments (throttled)
        const theirs = viewer.owner ? items : items.filter((c) => viewer.id && c.author?.id === viewer.id);
        if (theirs.length) await github.refreshComments(spaceOf(req), theirs);
        json(res, 200, github.forViewer(items, viewer));
        return;
      }
      res.writeHead(405).end();
      return;
    }

    const route = /^\/api\/feedback\/([^/]+)(?:\/replies(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (route) {
      if (url.searchParams.has('fail')) {
        res.writeHead(503).end();
        return;
      }
      const [, id, replyId] = route.map((x) => (x ? decodeURIComponent(x) : x));
      const isReplies = url.pathname.includes('/replies');
      const comment = listOf(req).find((c) => c.id === id);
      if (!comment) return void json(res, 404, { error: 'not found' });
      if (!isReplies && req.method === 'PATCH') {
        const change = JSON.parse((await readBody(req)).toString('utf8'));
        if (change.status !== 'open' && change.status !== 'resolved') return void json(res, 400, { error: 'bad status' });
        const linked = comment.issue?.provider === 'github' && !comment.issue.unavailable;
        // closing the thread closes the issue in the owner's repository: owner only
        if (linked && !isOwner(req)) return void json(res, 403, { error: { code: 'forbidden', message: 'Закрыть тред с issue может только владелец сайта.' } });
        if (comment.status === change.status || (change.status === 'open' && !comment.status)) return void json(res, 200, { ok: true }); // nothing to do (e.g. a second click)
        try {
          await github.onStatus(spaceOf(req), comment, change.status); // one status: the issue follows
        } catch (err) {
          const code = err?.code ?? 'network';
          return void json(res, code === 'rate_limited' ? 429 : 502, { error: { code, message: `Статус не изменён: ${err?.message ?? 'GitHub недоступен.'}` } });
        }
        comment.status = change.status;
        delete comment.resolvedVia;
        if (change.status === 'resolved') Object.assign(comment, { resolvedBy: change.by, resolvedAt: change.at });
        else delete comment.resolvedBy, delete comment.resolvedAt;
        persist();
        console.log(`[feedback] ${id}: ${change.status} (${change.by?.name ?? '?'})`);
        return void json(res, 200, { ok: true });
      }
      if (isReplies && !replyId && req.method === 'POST') {
        const { item: reply, urls } = await readItem(req);
        if (!reply?.id || (!reply.text && !reply.attachments?.length)) return void json(res, 400, { error: 'invalid reply' });
        comment.replies ??= [];
        delete reply.origin; // set by the server only
        delete reply.link;
        const known = comment.replies.find((r) => r.id === reply.id);
        if (!known) comment.replies.push({ ...reply, commentId: id });
        persist();
        if (!known) github.onReply(spaceOf(req), comment, comment.replies.at(-1)); // → issue comment
        console.log(`[feedback] ответ ${reply.author?.name ?? '?'} → ${id}: "${reply.text}"`);
        return void json(res, 201, { ok: true, attachments: urls });
      }
      if (isReplies && replyId) {
        const reply = comment.replies?.find((r) => r.id === replyId);
        if (!reply) return void json(res, 404, { error: 'not found' });
        if (req.method === 'PATCH') {
          const patch = JSON.parse((await readBody(req)).toString('utf8'));
          if (reply.origin) return void json(res, 403, { error: 'written on GitHub' });
          reply.text = String(patch.text ?? reply.text);
          reply.updatedAt = patch.updatedAt ?? new Date().toISOString();
          persist();
          github.onReplyEdit(spaceOf(req), comment, reply);
          return void json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (reply.origin) return void json(res, 403, { error: 'written on GitHub' });
          comment.replies = comment.replies.filter((r) => r.id !== replyId);
          persist();
          github.onReplyDelete(spaceOf(req), comment, reply);
          return void json(res, 200, { ok: true });
        }
      }
      res.writeHead(405).end();
      return;
    }

    if (url.pathname.startsWith('/uploads/') && req.method === 'GET') {
      const file = normalize(join(UPLOADS, url.pathname.slice('/uploads/'.length)));
      if (!file.startsWith(UPLOADS)) return void res.writeHead(404).end();
      const data = await readFile(file);
      const ext = extname(file);
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Accept-Ranges': 'none', 'Cache-Control': 'no-store' });
      res.end(data);
      return;
    }

    // static: /demo/*, /dist/*; "/" and SPA routes → demo/index.html
    let path = url.pathname;
    if (path === '/' || path.startsWith('/app/')) path = '/demo/index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT) || !(path.startsWith('/demo/') || path.startsWith('/dist/'))) {
      res.writeHead(404).end('not found');
      return;
    }
    await stat(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch (err) {
    if (err?.status) res.writeHead(err.status).end();
    else if (err?.code === 'ENOENT') res.writeHead(404).end('not found');
    else {
      console.error(err);
      res.writeHead(500).end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Comenta demo: http://localhost:${PORT}`);
  console.log(`Настройки GitHub: http://localhost:${PORT}/demo/settings.html${mock ? ' (тестовый GitHub)' : github.oauth ? (github.bot ? ' (issues от имени бота приложения)' : ' (без приватного ключа: issues от вашего имени)') : ' (GitHub App не настроен: pnpm github-app:setup или GITHUB_MOCK=1)'}`);
});
