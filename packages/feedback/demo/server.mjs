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
// The demo does not check permissions (who may resolve, edit, delete): a real backend must.
// Header X-Comenta-Space keeps separate stores (the e2e tests use one per test).
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

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
const spaceOf = (req) => String(req.headers['x-comenta-space'] ?? 'default').slice(0, 80);
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
  if (!ctype.startsWith('multipart/form-data')) return { item: JSON.parse((await readBody(req)).toString('utf8')), urls };
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
  }
  return { item, urls };
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
    if (url.pathname === '/api/feedback') {
      if (req.method === 'POST') {
        if (url.searchParams.has('fail')) {
          res.writeHead(503).end();
          return;
        }
        const { item: payload, urls } = await readItem(req);
        if (!payload?.id || (!payload?.text && !payload?.attachments?.length) || !payload?.target?.selector) {
          json(res, 400, { error: 'invalid payload' });
          return;
        }
        const list = listOf(req);
        if (!list.some((c) => c.id === payload.id)) list.push(payload);
        persist();
        const files = Object.values(urls);
        console.log(`[feedback] ${payload.kind ?? 'без категории'}: "${payload.text}" → ${payload.target.selector}${files.length ? ` + ${files.join(', ')}` : ''}`);
        json(res, 201, { ok: true, id: payload.id, attachments: urls });
        return;
      }
      if (req.method === 'GET') {
        const page = url.searchParams.get('url');
        const list = listOf(req);
        json(res, 200, page ? list.filter((c) => sameUrl(c.page?.url, page)) : list);
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
        comment.status = change.status;
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
        if (!comment.replies.some((r) => r.id === reply.id)) comment.replies.push({ ...reply, commentId: id });
        persist();
        console.log(`[feedback] ответ ${reply.author?.name ?? '?'} → ${id}: "${reply.text}"`);
        return void json(res, 201, { ok: true, attachments: urls });
      }
      if (isReplies && replyId) {
        const reply = comment.replies?.find((r) => r.id === replyId);
        if (!reply) return void json(res, 404, { error: 'not found' });
        if (req.method === 'PATCH') {
          const patch = JSON.parse((await readBody(req)).toString('utf8'));
          reply.text = String(patch.text ?? reply.text);
          reply.updatedAt = patch.updatedAt ?? new Date().toISOString();
          persist();
          return void json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          comment.replies = comment.replies.filter((r) => r.id !== replyId);
          persist();
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

server.listen(PORT, () => console.log(`Comenta demo: http://localhost:${PORT}`));
