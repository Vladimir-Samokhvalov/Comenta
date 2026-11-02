// Builds dist/demo-standalone.html: the demo page with the IIFE bundle inlined.
// Opens by double click (file://), no server: uses consoleAdapter + localStorage.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const html = readFileSync(join(root, 'demo/index.html'), 'utf8');
const bundle = readFileSync(join(root, 'dist/feedback.iife.js'), 'utf8').replace(/<\/script/gi, '<\\/script');

const start = html.indexOf('<script type="module">');
const end = html.indexOf('</script>', start) + '</script>'.length;
let page = html.slice(start, end);
page = page
  .replace('<script type="module">', '<script>')
  .replace("import { initFeedback, httpAdapter, consoleAdapter } from '/dist/index.js';", 'const { initFeedback, consoleAdapter } = window.PinHelpFeedback;')
  .replace(
    /const adapters = \{[\s\S]*?\n    \};/,
    `const adapters = {
      console: () => consoleAdapter(),
      fail: () => ({ submit: () => new Promise((_, reject) => setTimeout(() => reject(new Error('сервер недоступен (симуляция)')), 400)) }),
      slow: () => { const a = consoleAdapter(); return { ...a, submit: (p) => new Promise((r) => setTimeout(r, 1500)).then(() => a.submit(p)) }; },
    };`,
  )
  .replace("route('/app/a',", "route('?route=a',")
  .replace("route('/app/b',", "route('?route=b',")
  .replace("history.pushState({}, '', path);", "try { history.pushState({}, '', path); } catch (e) { console.warn('pushState недоступен', e); }")
  .replace("select.value = params.get('adapter') ?? 'http';", "select.value = params.get('adapter') ?? 'console';");

const options = `<option value="console">console + localStorage</option>
          <option value="slow">console, медленная отправка (1,5 с)</option>
          <option value="fail">ошибка отправки (симуляция)</option>`;

const out = html
  .slice(0, start)
  .replace(/<select id="adapter">[\s\S]*?<\/select>/, `<select id="adapter">\n          ${options}\n        </select>`)
  .replace('<a id="top-left-link" href="/somewhere">', '<a id="top-left-link" href="https://example.com/somewhere">')
  .replace('<a href="/elsewhere" id="nav-away">', '<a href="https://example.com/elsewhere" id="nav-away">')
  .replace('</h1>', '</h1>\n    <p class="muted">Автономная версия: всё в одном файле, заявки пишутся в консоль браузера и localStorage.</p>')
  .concat(`<script data-auto-init="false">\n${bundle}\n</script>\n`, page, html.slice(end));

writeFileSync(join(root, 'dist/demo-standalone.html'), out);
console.log('dist/demo-standalone.html', (out.length / 1024).toFixed(0), 'KB');
