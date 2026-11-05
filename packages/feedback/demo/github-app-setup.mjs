// Registers the GitHub App for this site in one click, from a manifest, so nobody has to fill in the
// form or copy secrets by hand: `pnpm github-app:setup`, press "Create GitHub App" on GitHub, done.
// Saves the credentials to demo/github-app.json (mode 600, gitignored); restart the server after it.
//
// Env: PUBLIC_URL      site origin for the callback (default http://localhost:5174)
//      SETUP_PORT      port of this one-off helper (default 5176)
//      GITHUB_APP_FILE, GITHUB_WEB_URL, GITHUB_API_URL   as in github.mjs
//      COMENTA_GITHUB_APP_PUBLIC=1   anyone may install the app (needed for organisations you don't own)
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const site = (env.PUBLIC_URL ?? 'http://localhost:5174').replace(/\/$/, '');
const port = Number(env.SETUP_PORT ?? 5176);
const webUrl = (env.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/$/, '');
const apiUrl = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
const file = env.GITHUB_APP_FILE ?? join(dirname(fileURLToPath(import.meta.url)), 'github-app.json');
const state = randomBytes(16).toString('base64url');

const manifest = {
  name: `Comenta ${randomBytes(2).toString('hex')}`, // app names are unique across GitHub; editable on the form
  url: site,
  callback_urls: [`${site}/api/github/auth/callback`],
  redirect_url: `http://localhost:${port}/done`,
  request_oauth_on_install: true, // after installing, back to the callback with a code
  public: env.COMENTA_GITHUB_APP_PUBLIC === '1',
  default_permissions: { issues: 'write', contents: 'write', metadata: 'read', organization_projects: 'write' },
};

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (res, status, body) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Comenta: GitHub App</title><body style="font:15px system-ui;padding:40px">${body}`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/') {
    // POST with the manifest; GitHub asks for a name and shows the "Create GitHub App" button
    return page(res, 200, `<form id="f" method="post" action="${esc(webUrl)}/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button>Создать GitHub App</button></form><script>document.getElementById('f').submit()</script>`);
  }
  if (url.pathname !== '/done') return page(res, 404, 'Нет такого адреса.');
  if (url.searchParams.get('state') !== state) return page(res, 400, 'Ссылка устарела. Запустите настройку ещё раз.');
  try {
    const r = await fetch(`${apiUrl}/app-manifests/${encodeURIComponent(url.searchParams.get('code') ?? '')}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'comenta-feedback' },
    });
    if (!r.ok) throw new Error(`GitHub ответил ${r.status}: ${await r.text()}`);
    const app = await r.json();
    // the private key mints installation tokens, so issues are authored by <slug>[bot]; the file is mode 600 and gitignored
    await writeFile(file, JSON.stringify({ id: app.id, slug: app.slug, clientId: app.client_id, clientSecret: app.client_secret, privateKey: app.pem, htmlUrl: app.html_url }, null, 2), { mode: 0o600 });
    console.log(`GitHub App «${app.slug}» создан, данные сохранены в ${file}. Перезапустите сервер.`);
    page(res, 200, `<h1>GitHub App создан</h1><p>Перезапустите сервер и нажмите «Войти через GitHub» на <a href="${esc(site)}/demo/settings.html">странице настроек</a>.</p>`);
    server.close();
    server.closeAllConnections?.();
  } catch (err) {
    console.error(err);
    page(res, 502, `Не удалось получить данные приложения: ${esc(String(err.message ?? err))}`);
  }
});

server.listen(port, 'localhost', () => {
  console.log(`Откройте http://localhost:${port} и нажмите «Create GitHub App» на GitHub.`);
});
