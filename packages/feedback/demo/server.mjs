// Minimal mock backend + static server for the demo. No dependencies.
//   node demo/server.mjs            → http://localhost:5174
//   POST /api/feedback              → appends the payload to demo/feedback.log (JSON lines), 201
//   POST /api/feedback?fail=1       → 503 (to try the error state)
//   GET  /api/feedback              → all stored payloads
//   multipart POST (payload + recordings) → files saved to demo/uploads/, answers { attachments: { id: url } }
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOG = process.env.FEEDBACK_LOG ?? join(ROOT, 'demo', 'feedback.log');
const PORT = Number(process.env.PORT ?? 5174);
const UPLOADS = process.env.FEEDBACK_UPLOADS ?? join(ROOT, 'demo', 'uploads');
const TYPES = {
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json' };

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
        const ctype = req.headers['content-type'] ?? '';
        let payload;
        const urls = {};
        if (ctype.startsWith('multipart/form-data')) {
          const boundary = /boundary=([^;]+)/.exec(ctype)?.[1];
          const parts = parseMultipart(await readBody(req, 50 * 1024 * 1024), boundary);
          payload = JSON.parse(parts.find((p) => p.name === 'payload')?.data.toString('utf8') ?? 'null');
          await mkdir(UPLOADS, { recursive: true });
          for (const p of parts.filter((p) => p.name?.startsWith('file:'))) {
            const id = p.name.slice(5).replace(/[^a-zA-Z0-9-]/g, '');
            const att = payload?.attachments?.find((a) => a.id === id);
            if (!att) continue;
            const ext = (extname(p.filename ?? '') || '.webm').replace(/[^.a-z0-9]/gi, '');
            await writeFile(join(UPLOADS, `${id}${ext}`), p.data);
            urls[id] = att.url = `/uploads/${id}${ext}`;
          }
        } else {
          payload = JSON.parse((await readBody(req)).toString('utf8'));
        }
        if (!payload?.id || (!payload?.text && !payload?.attachments?.length) || !payload?.target?.selector) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid payload"}');
          return;
        }
        await appendFile(LOG, `${JSON.stringify(payload)}\n`);
        const files = Object.values(urls);
        console.log(`[feedback] ${payload.kind ?? 'без категории'}: "${payload.text}" → ${payload.target.selector}${files.length ? ` + ${files.join(', ')}` : ''}`);
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, id: payload.id, attachments: urls }));
        return;
      }
      if (req.method === 'GET') {
        const raw = await readFile(LOG, 'utf8').catch(() => '');
        const items = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(items));
        return;
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

server.listen(PORT, () => console.log(`PinHelp demo: http://localhost:${PORT}`));
