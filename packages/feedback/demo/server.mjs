// Minimal mock backend + static server for the demo. No dependencies.
//   node demo/server.mjs            → http://localhost:5174
//   POST /api/feedback              → appends the payload to demo/feedback.log (JSON lines), 201
//   POST /api/feedback?fail=1       → 503 (to try the error state)
//   GET  /api/feedback              → all stored payloads
import { createServer } from 'node:http';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LOG = process.env.FEEDBACK_LOG ?? join(ROOT, 'demo', 'feedback.log');
const PORT = Number(process.env.PORT ?? 5174);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new Error('too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
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
        const payload = JSON.parse(await readBody(req));
        if (!payload?.id || !payload?.text || !payload?.target?.selector) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid payload"}');
          return;
        }
        await appendFile(LOG, `${JSON.stringify(payload)}\n`);
        console.log(`[feedback] ${payload.kind}: "${payload.text}" → ${payload.target.selector}`);
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, id: payload.id }));
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
    if (err?.code === 'ENOENT') res.writeHead(404).end('not found');
    else {
      console.error(err);
      res.writeHead(500).end();
    }
  }
});

server.listen(PORT, () => console.log(`PinHelp demo: http://localhost:${PORT}`));
