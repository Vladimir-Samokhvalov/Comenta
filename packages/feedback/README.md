# @pinhelp/feedback

Встраиваемый виджет комментирования элементов страницы. Пользователь включает «режим комментариев», кликает по любому элементу, пишет вопрос / предложение / ошибку, и заявка уходит разработчикам вместе с контекстом элемента (селектор, текст, положение, URL).

* Ядро на чистом DOM + TypeScript, без зависимостей. ~11 КБ gzip.
* UI в Shadow DOM: стили сайта не ломают виджет, стили виджета не текут на сайт.
* Транспорт за интерфейсом `FeedbackAdapter`: HTTP и console/localStorage из коробки, свой пишется в 10 строк.
* React-обёртка и `<script>`-бандл с автоинициализацией.

## Подключение

### npm / ESM

```ts
import { initFeedback, httpAdapter } from '@pinhelp/feedback';

const fb = initFeedback({
  adapter: httpAdapter({ endpoint: '/api/feedback' }),
  position: 'bottom-right',
  author: { id: user.id, name: user.name },
});

fb.open();    // включить режим комментариев
fb.close();   // выключить
fb.destroy(); // убрать DOM и все слушатели
```

### React

```tsx
import { FeedbackWidget } from '@pinhelp/feedback/react';
import { httpAdapter } from '@pinhelp/feedback';

const adapter = httpAdapter({ endpoint: '/api/feedback' });

export function App() {
  return (
    <>
      <Routes />
      <FeedbackWidget adapter={adapter} author={{ id: user.id, name: user.name }} />
    </>
  );
}
```

Компонент ничего не рендерит в дерево React. `position`, `zIndex`, `ignoreSelector`, `enabled`, `labels` пересоздают виджет; `adapter`, `author`, `onSubmit`, `onError` обновляются на лету. Через `ref` доступен экземпляр (`open`, `close`, …). React — `peerDependency`, в ядро не попадает.

### Тег `<script>`

```html
<script
  src="https://cdn.example.com/feedback.iife.js"
  data-endpoint="/api/feedback"
  data-position="bottom-left"
  data-author-id="42"
  data-author-name="Анна"
></script>
```

Без `data-endpoint` используется `consoleAdapter`. Атрибуты: `data-endpoint`, `data-position`, `data-author-id`, `data-author-name`, `data-ignore-selector`, `data-z-index`, `data-enabled="false"`. `data-auto-init="false"` отключает автозапуск, тогда вызывайте `window.PinHelpFeedback.initFeedback({...})` сами. Экземпляр после автозапуска: `window.PinHelpFeedback.instance`.

## Опции

| Опция | Тип | По умолчанию | |
|---|---|---|---|
| `adapter` | `FeedbackAdapter` | `consoleAdapter()` | Куда отправлять заявки |
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | `'bottom-right'` | Положение кнопки |
| `author` | `{ id?, name? }` | — | Попадает в `payload.author` |
| `enabled` | `boolean` | `true` | `false` — ничего не рендерится |
| `ignoreSelector` | `string` | `'[data-feedback-ignore]'` | Эти элементы нельзя выбрать, и их содержимое не попадает в payload (наведение «проходит» к ближайшему разрешённому предку) |
| `recording` | `false \| { audio?, screen?, maxDurationMs? }` | всё, что умеет браузер, 60 000 мс | Голосовые и запись экрана в форме |
| `hotkey` | `string \| false` | `'c'` | Клавиша включения режима (не срабатывает при наборе текста) |
| `zIndex` | `number` | `2147483000` | Слой виджета |
| `labels` | `Partial<FeedbackLabels>` | русские строки | Тексты интерфейса |
| `onSubmit` | `(payload) => void` | — | После успешной отправки |
| `onError` | `(error, payload) => void` | — | Если адаптер отклонил заявку |

Методы экземпляра: `open()`, `close()`, `toggle()`, `isOpen()`, `update(partialOptions)`, `getComments()`, `showComments()` (открыть «Мои комментарии»), `destroy()`. Повторный `initFeedback` сначала уничтожает предыдущий экземпляр.

## Поведение

* Плавающая плашка в стиле Claude Design: облачко включает режим (или клавиша `C`), шеврон рядом открывает меню «Показать все комментарии» (со счётчиком) и «Скрыть/Показать пины». Меню управляется стрелками, закрывается по `Esc` и клику мимо.
* «Мои комментарии»: вкладки «Эта страница» и «Все». Клик по строке прокручивает к элементу и открывает комментарий; если элемента сейчас нет, строка приглушена с пометкой «элемент не найден»; комментарии с других страниц ведут на свою страницу. Вкладка «Все» берёт данные из `adapter.listAll()`, если он есть, иначе показывает известные в сессии.
* Режим включён: облачко залито, курсор crosshair, элемент под курсором подсвечивается рамкой с плашкой `tag#id 120×40`. Сам виджет не подсвечивается.
* Клик фиксирует выбор. Действие элемента (ссылка, submit, onClick) блокируется: `pointerdown/mousedown/pointerup/mouseup/click/dblclick/auxclick/contextmenu/submit` перехватываются в capture-фазе на `document` (`preventDefault` + `stopImmediatePropagation`). После выхода из режима всё работает как раньше.
* Поповер: необязательная категория эмодзи 🤔 Вопрос / 🚀 Предложение / 😢 Ошибка (по умолчанию ничего не выбрано, повторный клик снимает выбор, стрелки переключают фокус; подписи в `title` и `aria-label`), textarea с автофокусом и авторостом, «Отправить» неактивна при пустом тексте. `Cmd/Ctrl+Enter` — отправить, `Esc` — закрыть поповер, второй `Esc` — выйти из режима. Клик по другому элементу переносит поповер, черновик сохраняется. Focus trap, фокус возвращается на кнопку.
* Позиционирование: под элементом → над ним → прижат к нижнему краю окна; по горизонтали не выходит за экран.
* Открытый комментарий (клик по пину или строке списка) обводит свой элемент той же рамкой, что и при выборе; поповер встаёт рядом с элементом, а не поверх него.
* Запись как в Telegram: кнопка рядом с «Отправить». Нажатие переключает режим микрофон ⇄ экран, удержание (350 мс, мышью или Enter/Space) начинает запись. Экран пишется вместе с голосом с микрофона; если микрофон недоступен, экран пишется без звука с пометкой. Лимит 1 минута (таймер и полоска прогресса), запись останавливается кнопкой ■, системной кнопкой браузера «Остановить доступ» или по лимиту. До отправки есть предпросмотр с воспроизведением, «Перезаписать» и «Удалить»; `Esc` сначала отменяет идущую запись. Комментарий можно отправить одной записью без текста. В просмотре комментария запись воспроизводится, в списке у строки пометка «Голос 0:12». Отказ в доступе показывает ошибку в форме, текст не теряется. При `destroy()` и закрытии формы все медиапотоки останавливаются. Где браузер не умеет записывать, кнопки нет.
* После отправки — пин с номером в углу элемента и тост «Отправлено». При ошибке текст остаётся в форме, показывается причина, можно отправить повторно.
* Пины следуют за элементом при scroll/resize/изменении DOM (MutationObserver с троттлингом 100 мс). Если элемент пропал, пин скрывается, но комментарий не теряется; когда элемент снова появляется (даже новым узлом), пин перепривязывается по селектору. Пины показываются только для текущего URL (без hash), смена маршрута в SPA отслеживается.

Цвета заданы CSS-переменными внутри shadow root (`--ph-accent` терракотовый `#c96442` — пины предложений и без категории, `--ph-bug`, `--ph-question` и др.); эмодзи категорий меняются через `labels.kindEmoji`, есть тёмная тема по `prefers-color-scheme`.

Единственное, что виджет кладёт в документ сайта помимо своего host-элемента, — `<style id="pinhelp-feedback-cursor">` с курсором crosshair, и только пока режим включён.

## Формат payload

```ts
type FeedbackKind = 'question' | 'suggestion' | 'bug';

interface FeedbackPayload {
  id: string;                 // uuid, генерирует клиент
  kind?: FeedbackKind;        // нет, если категория не выбрана
  text: string;
  createdAt: string;          // ISO
  page: { url: string; title: string; viewport: { w: number; h: number }; userAgent: string };
  target: {
    selector: string;         // находит ровно один элемент
    tag: string;
    textSnippet: string;      // до 120 символов видимого текста
    rect: { x: number; y: number; w: number; h: number }; // относительно документа
    attributes: Record<string, string>; // id, class, data-*, aria-label, role, href, type, name, alt
  };
  author?: { id?: string; name?: string };
  attachments?: Array<{
    id: string;
    kind: 'audio' | 'screen';   // голосовое | запись экрана с голосом
    name: string;               // voice-<id>.webm
    mimeType: string;           // audio/webm, video/webm, ...
    size: number;               // байты
    durationMs: number;
    url?: string;               // где воспроизвести (ставит виджет из ответа адаптера)
  }>;
}
```

**Селектор.** Приоритет: `[data-testid]` / `[data-feedback-id]` → `#id` (если уникален и не сгенерирован: `:r1:`, `ember12`, uuid, числа) → путь `tag.class:nth-of-type(n)` вверх до ближайшего предка с таким якорем; путь обрывается, как только становится уникальным. Хэшированные и служебные классы (CSS-modules `Btn__a1B2c`, `css-1x2y3z`, `sc-…`, `jsx-…`, Tailwind-варианты `hover:…`, `w-[13px]`, состояния `active`, `is-open`) не используются. Каждый селектор проверяется `querySelectorAll(sel).length === 1`; в крайнем случае — абсолютный путь `:nth-child`. Чтобы селекторы были устойчивыми, ставьте `data-feedback-id` на ключевые блоки.

**Приватность.** Значения `input`, `textarea`, `select`, `contenteditable` и всего внутри `ignoreSelector` никогда не попадают в `textSnippet`. В `attributes` нет `value` и `data-*value*`; у самих полей ввода и приватных элементов остаются только идентифицирующие атрибуты (`id`, `class`, `role`, `type`, `name`, `data-testid`, `data-feedback-id`).

## Адаптеры

```ts
interface FeedbackAdapter {
  // files: записи, описанные в payload.attachments ({ attachment, blob }).
  // Можно вернуть { attachmentUrls: { [id]: url } }, чтобы виджет воспроизводил записи по этим адресам.
  submit(payload: FeedbackPayload, files?: FeedbackFile[]): Promise<void | FeedbackSubmitResult>; // reject → ошибка в форме
  list?(pageUrl: string): Promise<FeedbackPayload[]>;       // необязательно: восстановить пины
  listAll?(): Promise<FeedbackPayload[]>;                    // необязательно: вкладка «Все»
}
```

* `httpAdapter({ endpoint, headers?, credentials?, timeoutMs?, fetch? })` — `POST` JSON; с записями — `multipart/form-data`: поле `payload` (JSON) и по файлу на запись в поле `file:<id>`. Ответ сервера `{ "attachments": { "<id>": "<url>" } }` задаёт адреса для воспроизведения. `headers` может быть функцией (в том числе async), например для свежего токена. Не-2xx и сетевые ошибки отклоняют промис.
* `consoleAdapter({ storageKey?, storage?, log?, maxInlineBytes? })` — записи до `maxInlineBytes` (1,5 МБ) хранит в localStorage как `data:` URL, большие не сохраняет (до перезагрузки они играют из памяти, потом показывается «Запись не сохранилась»); пишет в консоль и `localStorage`, реализует `list()` и `listAll()`, поэтому пины и список переживают перезагрузку. Для разработки и демо.

### Свой адаптер

```ts
import type { FeedbackAdapter } from '@pinhelp/feedback';

export function youtrackAdapter(opts: { baseUrl: string; project: string; token: () => string }): FeedbackAdapter {
  return {
    async submit(p) {
      const res = await fetch(`${opts.baseUrl}/api/issues`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: { id: opts.project },
          summary: `[${p.kind}] ${p.text.slice(0, 80)}`,
          description: `${p.text}\n\nСтраница: ${p.page.url}\nЭлемент: \`${p.target.selector}\``,
        }),
      });
      if (!res.ok) throw new Error(`YouTrack ответил ${res.status}`); // текст покажется в форме
    },
  };
}
```

Сообщение из `Error` показывается пользователю после «Не удалось отправить: ».

## Разработка

```bash
pnpm install
pnpm build          # dist/: ESM, CJS, IIFE, .d.ts
pnpm test           # unit (Vitest + jsdom): селектор, санитизация, позиционирование, адаптеры, lifecycle, React
pnpm test:e2e       # build + Playwright по демо-странице
pnpm demo           # http://localhost:5174 — демо + мок-сервер
pnpm size           # gzip-размеры, бюджет 30 КБ
pnpm standalone     # dist/demo-standalone.html: демо одним файлом, открывается двойным кликом
```

Мок-сервер (`demo/server.mjs`, без зависимостей): `POST /api/feedback` дописывает payload в `demo/feedback.log` (JSON Lines), файлы записей кладёт в `demo/uploads/` и раздаёт по `/uploads/<id>.webm`, `?fail=1` отвечает 503, `GET /api/feedback` отдаёт всё сохранённое. Демо: `/` (селектор адаптера и «враждебные стили» в блоке настроек, `?adapter=console|http|fail`), `/demo/script-tag.html` — подключение тегом.

## Структура

```
src/
  core/       controller (init, состояние, режим выбора, пины, layout), position, uuid, url
  selector/   генерация селектора, эвристики хэшей, санитизация и описание элемента
  ui/         shadow-root: плашка с кнопками, меню и список комментариев, подсветка, поповер, тост, стили, тексты
  adapters/   http, console/localStorage
  react/      <FeedbackWidget />
  iife.ts     <script>-бандл с автоинициализацией
  types.ts
demo/         страница с разными элементами, script-tag пример, мок-сервер
tests/unit    Vitest
tests/e2e     Playwright
```

## Дальше (вне MVP)

Скриншоты, треды и ответы, статусы, авторизация, вложения, интеграции с YouTrack/GitLab (через адаптер), общие комментарии между пользователями (через `adapter.list`), мобильные жесты, iframe.
