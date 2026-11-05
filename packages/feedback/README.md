# @comenta/feedback

Встраиваемый виджет комментирования элементов страницы. Пользователь включает «режим комментариев», кликает по любому элементу, пишет вопрос / предложение / ошибку, и заявка уходит разработчикам вместе с контекстом элемента (селектор, текст, положение, URL).

* Ядро на чистом DOM + TypeScript, без зависимостей. ~27 КБ gzip (с записью голоса/экрана и тредами).
* Треды: ответы на комментарий от любого пользователя, статус «Открыт / Закрыт», непрочитанное.
* UI в Shadow DOM: стили сайта не ломают виджет, стили виджета не текут на сайт.
* Транспорт за интерфейсом `FeedbackAdapter`: HTTP и console/localStorage из коробки, свой пишется в 10 строк.
* React-обёртка и `<script>`-бандл с автоинициализацией.
* Интеграция с GitHub: комментарии становятся issues (с записями и Project v2), страница настроек `<comenta-settings>`, двусторонняя синхронизация треда с issue (статус, комментарии, ответы).

## Подключение

### npm / ESM

```ts
import { initFeedback, httpAdapter } from '@comenta/feedback';

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
import { FeedbackWidget } from '@comenta/feedback/react';
import { httpAdapter } from '@comenta/feedback';

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

Без `data-endpoint` используется `consoleAdapter`. Атрибуты: `data-endpoint`, `data-position`, `data-author-id`, `data-author-name`, `data-ignore-selector`, `data-z-index`, `data-enabled="false"`. `data-auto-init="false"` отключает автозапуск, тогда вызывайте `window.Comenta.initFeedback({...})` сами. Экземпляр после автозапуска: `window.Comenta.instance`.

## Опции

| Опция | Тип | По умолчанию | |
|---|---|---|---|
| `adapter` | `FeedbackAdapter` | `consoleAdapter()` | Куда отправлять заявки |
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | `'bottom-right'` | Положение кнопки |
| `author` | `{ id?, name?, role?: 'owner' \| 'member' }` | гость | Автор комментариев и ответов. `owner` может решать любые треды. Без автора виджет создаёт гостя с постоянным id в localStorage и один раз спрашивает имя |
| `enabled` | `boolean` | `true` | `false` — ничего не рендерится |
| `ignoreSelector` | `string` | `'[data-feedback-ignore]'` | Эти элементы нельзя выбрать, и их содержимое не попадает в payload (наведение «проходит» к ближайшему разрешённому предку) |
| `recording` | `false \| { audio?, screen?, maxDurationMs? }` | всё, что умеет браузер, 60 000 мс | Голосовые и запись экрана в форме |
| `hotkey` | `string \| false` | `'c'` | Клавиша включения режима (не срабатывает при наборе текста) |
| `zIndex` | `number` | `2147483000` | Слой виджета |
| `labels` | `Partial<FeedbackLabels>` | русские строки | Тексты интерфейса |
| `pollIntervalMs` | `number \| false` | `30000` | Как часто перечитывать `list()` в поисках новых ответов (только пока вкладка видна) |
| `onSubmit` | `(payload) => void` | — | После успешной отправки |
| `onReply` | `(reply, comment) => void` | — | После сохранения ответа |
| `onStatusChange` | `(comment, { status, by, at }) => void` | — | Тред закрыт или открыт снова |
| `onError` | `(error, payload) => void` | — | Если адаптер отклонил заявку |

Методы экземпляра: `open()`, `close()`, `toggle()`, `isOpen()`, `update(partialOptions)`, `getComments()`, `showComments()` (открыть список комментариев), `openThread(id)` (открыть тред, `false` если его нет на странице), `getUnreadCount()`, `destroy()`. Ссылка с `#comenta=<id>` в адресе открывает тред сразу после загрузки (удобно для писем с уведомлениями). Повторный `initFeedback` сначала уничтожает предыдущий экземпляр.

## Поведение

* Плавающая плашка в стиле Claude Design: облачко включает режим (или клавиша `C`), шеврон рядом открывает меню «Показать все комментарии» (со счётчиком) и «Скрыть/Показать пины». Меню управляется стрелками, закрывается по `Esc` и клику мимо.
* Список «Комментарии»: вкладки «Эта страница» и «Все страницы», фильтр «Открытые / Закрытые / Все» (по умолчанию «Открытые»). В строке число ответов и кто ответил последним; треды с новыми ответами выделены жирным и синей точкой, закрытые приглушены. Клик по строке прокручивает к элементу и открывает комментарий; если элемента сейчас нет, строка приглушена с пометкой «элемент не найден»; комментарии с других страниц ведут на свою страницу. Вкладка «Все» берёт данные из `adapter.listAll()`, если он есть, иначе показывает известные в сессии.
* Режим включён: облачко залито, курсор crosshair, элемент под курсором подсвечивается рамкой с плашкой `tag#id 120×40`. Сам виджет не подсвечивается.
* Клик фиксирует выбор. Действие элемента (ссылка, submit, onClick) блокируется: `pointerdown/mousedown/pointerup/mouseup/click/dblclick/auxclick/contextmenu/submit` перехватываются в capture-фазе на `document` (`preventDefault` + `stopImmediatePropagation`). После выхода из режима всё работает как раньше.
* Поповер: необязательная категория эмодзи 🤔 Вопрос / 🚀 Предложение / 😢 Ошибка (по умолчанию ничего не выбрано, повторный клик снимает выбор, стрелки переключают фокус; подписи в `title` и `aria-label`), textarea с автофокусом и авторостом, «Отправить» неактивна при пустом тексте. `Cmd/Ctrl+Enter` — отправить, `Esc` — закрыть поповер, второй `Esc` — выйти из режима. Клик по другому элементу переносит поповер, черновик сохраняется. Focus trap, фокус возвращается на кнопку.
* Позиционирование: под элементом → над ним → прижат к нижнему краю окна; по горизонтали не выходит за экран.
* Открытый комментарий (клик по пину или строке списка) обводит свой элемент той же рамкой, что и при выборе; поповер встаёт рядом с элементом, а не поверх него.
* Запись как в Telegram: кнопка в правом нижнем углу текстового поля (у поля отступ справа и снизу, текст под кнопку не уходит). Нижняя строка формы: категории, «Отмена», «Отправить». Нажатие переключает режим микрофон ⇄ экран, удержание (350 мс, мышью или Enter/Space) начинает запись. Экран пишется вместе с голосом с микрофона; если микрофон недоступен, экран пишется без звука с пометкой. Во время записи экрана форма и плашка виджета скрываются, чтобы не закрывать элемент и не попасть в видео: внизу по центру окна остаётся компактная панель (таймер, ✕, ■), рамка выбранного элемента сохраняется, а страницей можно пользоваться как обычно (выбор элементов на это время выключен). После остановки форма возвращается с предпросмотром, текст и категория на месте. Голосовая запись идёт прямо в форме. Лимит 1 минута (таймер и полоска прогресса), запись останавливается кнопкой ■, системной кнопкой браузера «Остановить доступ» или по лимиту. До отправки есть предпросмотр с воспроизведением, «Перезаписать» и «Удалить»; `Esc` сначала отменяет идущую запись. Комментарий можно отправить одной записью без текста. В просмотре комментария запись воспроизводится, в списке у строки пометка «Голос 0:12». Отказ в доступе показывает ошибку в форме, текст не теряется. При `destroy()` и закрытии формы все медиапотоки останавливаются. Где браузер не умеет записывать, кнопки нет.
* Треды. Клик по пину открывает тред: комментарий и ответы бабблами как в Telegram (свои справа, чужие слева с именем, без аватаров), время, пометка «изменено». Внизу поле ответа с той же кнопкой записи голоса/экрана в углу и кнопки «Ответить» (`Cmd/Ctrl+Enter`) и «✓ Ответить и закрыть». В шапке статус «Открыт / Закрыт» и кнопка ✓ «Закрыть» (↺ «Открыть снова»); смена статуса видна в ленте серой строкой «Владимир закрыл(а) · 15:42». Закрывать и открывать снова могут автор комментария и `owner` (тред с issue — только `owner`); ответ в закрытый тред его не открывает. Свои ответы можно изменить (✎) и удалить (🗑, с подтверждением); `Esc` сначала выходит из редактирования. Кнопки показываются только если адаптер умеет `reply` / `updateReply` / `deleteReply` / `setStatus`.
* Непрочитанное: синий счётчик на облачке (число тредов с новыми ответами, клик открывает список), точка на пине, выделенные новые ответы в ленте. Новым считается ответ другого человека после того, как вы последний раз открывали тред (отметки хранятся в localStorage отдельно для каждого пользователя). Владельцу новыми считаются и чужие комментарии, которые он ещё не открывал. Новые ответы подтягиваются опросом `list()` раз в 30 секунд и при возвращении на вкладку; письма и пуши — задача сервера.
* Пины закрытых тредов скрыты; пункт меню «Показать закрытые» возвращает их (белый пин с ✓).
* После отправки — пин с номером в углу элемента и тост «Отправлено». При ошибке текст остаётся в форме, показывается причина, можно отправить повторно.
* Пины следуют за элементом при scroll/resize/изменении DOM (MutationObserver с троттлингом 100 мс). Если элемент пропал, пин скрывается, но комментарий не теряется; когда элемент снова появляется (даже новым узлом), пин перепривязывается по селектору. Пины показываются только для текущего URL (без hash), смена маршрута в SPA отслеживается.

Цвета заданы CSS-переменными внутри shadow root (`--ph-accent` терракотовый `#c96442` — пины предложений и без категории, `--ph-bug`, `--ph-question` и др.); эмодзи категорий меняются через `labels.kindEmoji`, есть тёмная тема по `prefers-color-scheme`.

Единственное, что виджет кладёт в документ сайта помимо своего host-элемента, — `<style id="comenta-feedback-cursor">` с курсором crosshair, и только пока режим включён.

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
  author?: { id?: string; name?: string; role?: 'owner' | 'member' };
  status?: 'open' | 'resolved';  // нет — значит open
  resolvedBy?: { id?: string; name?: string };
  resolvedAt?: string;
  replies?: FeedbackReply[];     // приходит из list(); в submit не отправляется
  issue?: {                      // ставит сервер (см. «GitHub»)
    provider: 'github'; repo: string; number: number; url: string;
    state?: 'open' | 'closed';   // только для владельца сайта и автора (см. «Синхронизация с issue»)
    stateReason?: string | null; // completed, not_planned, duplicate…
    closedAt?: string;
    unavailable?: 'deleted' | 'transferred' | 'no_access';
  };
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

```ts
interface FeedbackReply {
  id: string;
  commentId: string;
  text: string;
  createdAt: string;
  updatedAt?: string;           // если текст правили
  author?: { id?: string; name?: string; role?: 'owner' | 'member'; avatarUrl?: string; url?: string };
  attachments?: FeedbackAttachment[];
  origin?: 'github';            // написан в GitHub (только чтение, виден владельцу сайта и автору комментария)
  link?: { provider: 'github'; id: number; url: string }; // комментарий issue: оригинал или копия ответа
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
  listAll?(): Promise<FeedbackPayload[]>;                    // необязательно: вкладка «Все страницы», непрочитанное по всем страницам
  // Треды (всё необязательно; без reply тред только для чтения):
  reply?(commentId: string, reply: FeedbackReply, files?: FeedbackFile[]): Promise<void | FeedbackSubmitResult>;
  updateReply?(commentId: string, replyId: string, patch: { text: string; updatedAt: string }): Promise<void>;
  deleteReply?(commentId: string, replyId: string): Promise<void>;
  setStatus?(commentId: string, change: { status: 'open' | 'resolved'; by: FeedbackAuthor; at: string }): Promise<void>;
  subscribe?(onChange: () => void): () => void;              // пуш вместо опроса (WebSocket и т. п.)
}
```

Права (кто решает треды, кто правит ответы) виджет только отображает: проверять их должен сервер.

* `httpAdapter({ endpoint, headers?, credentials?, timeoutMs?, list?, fetch? })` — REST: `POST {endpoint}` (комментарий), `GET {endpoint}?url=<страница>` и `GET {endpoint}` (чтение с ответами и статусом; ответ — массив или `{ items }`; `list: false` отключает), `POST {endpoint}/{id}/replies`, `PATCH`/`DELETE {endpoint}/{id}/replies/{replyId}`, `PATCH {endpoint}/{id}` с `{ status, by, at }`. Без записей тело JSON; с записями — `multipart/form-data`: поле `payload` (JSON) и по файлу на запись в поле `file:<id>`. Ответ сервера `{ "attachments": { "<id>": "<url>" } }` задаёт адреса для воспроизведения. `headers` может быть функцией (в том числе async), например для свежего токена. Не-2xx и сетевые ошибки отклоняют промис.
* `consoleAdapter({ storageKey?, storage?, log?, maxInlineBytes? })` — записи до `maxInlineBytes` (1,5 МБ) хранит в localStorage как `data:` URL, большие не сохраняет (до перезагрузки они играют из памяти, потом показывается «Запись не сохранилась»); пишет в консоль и `localStorage`, реализует `list()`, `listAll()` и все методы тредов, поэтому пины, ответы и статусы переживают перезагрузку; другие вкладки видят изменения сразу (событие `storage`). Для разработки и демо.

### Свой адаптер

```ts
import type { FeedbackAdapter } from '@comenta/feedback';

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

## GitHub: комментарии → issues

Владелец сайта один раз подключает GitHub на странице настроек, и дальше каждый комментарий (в том числе гостевой) становится issue в выбранном репозитории и, по желанию, попадает в GitHub Project. Токен живёт только на вашем сервере: браузер получает лишь сессионную cookie.

```
посетитель ──comment──▶ ваш сервер ──token──▶ GitHub: issue, вложения, Project v2
владелец ──<comenta-settings>──▶ ваш сервер (/api/github/*) ──GitHub App──▶ GitHub
```

Три части:

* `@comenta/feedback/github` — серверный модуль (Node 18+, Deno, Bun, edge: нужен только `fetch`): вход через GitHub App, списки репозиториев и проектов, создание issue. В браузер его не отдавайте.
* `@comenta/feedback/settings` — компонент `<comenta-settings>` для страницы владельца (или `settings.iife.js` тегом `<script>`). В бандл виджета для посетителей он не входит.
* Ваш сервер связывает их. Рабочий пример без зависимостей: [`demo/github.mjs`](demo/github.mjs) (его подключает `demo/server.mjs`).

### Что попадает в issue

* **Заголовок** — первые слова комментария (до 72 символов, по границе слова) с эмодзи категории: `😢 Кнопка оплаты не нажимается…`. Без текста: `Голосовой комментарий: <заголовок страницы>`.
* **Тело** — текст; ссылки на записи `🎙 Голос, 0:42` / `🎥 Экран, 0:58` (картинки вставляются в тело); таблица: страница, селектор элемента, текст элемента, автор, размер экрана, браузер, время; ссылка «открыть комментарий на странице» (`#comenta=<id>`) и скрытая метка `<!-- comenta:id=<id> -->`.
* Только стандартные поля: без меток и исполнителей. `@упоминания` и `#123` из текста гостей обезврежены (не пингуют людей), подделать метку нельзя.
* **Записи** загружаются через Contents API в ветку `comenta-attachments` (создаётся как orphan-ветка, код не копирует), по папке на комментарий: `comenta/<id>/voice-….webm`.
* **Проект**: issue добавляется в выбранный Project v2 (`addProjectV2ItemById`). Если это не удалось, issue остаётся, а ошибка видна в настройках.
* **Идемпотентность**: повторная отправка того же комментария issue не дублирует. Сервер хранит ссылку на issue в комментарии; при повторной попытке после сбоя модуль сначала ищет issue по метке, а уже загруженные файлы не перезаливает. POST создания issue никогда не повторяется вслепую.
* Ссылка на issue возвращается виджету (`{ issue }` в ответе на POST и в `GET`), и в шапке треда появляется `GitHub #12`.

### Подключение на своём сервере

GitHub App регистрируется один раз, вами как автором сайта. Владельцы и гости этого шага не видят: у них только кнопка «Войти через GitHub» и выбор репозиториев на GitHub.

1. Зарегистрируйте GitHub App одной командой: `PUBLIC_URL=https://ваш-сайт pnpm github-app:setup` (без `PUBLIC_URL` — для `http://localhost:5174`). Откроется GitHub с уже заполненной формой, останется нажать «Create GitHub App». Данные, включая приватный ключ приложения, сохранятся в `demo/github-app.json` (права 600, в `.gitignore`), затем перезапустите сервер. Приложение будет приватным, установить его сможете только вы; чтобы его могли ставить другие аккаунты и чужие организации, добавьте `COMENTA_GITHUB_APP_PUBLIC=1`.
2. Вместо файла можно задать переменные окружения `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID` и `GITHUB_APP_PRIVATE_KEY` (текст .pem) или `GITHUB_APP_PRIVATE_KEY_PATH` (и `PUBLIC_URL`, если сервер стоит за прокси). Ключ создаётся на странице приложения: Private keys → Generate a private key. Без ключа всё тоже работает, но issues создаются от имени владельца и перестают приходить, когда его вход истекает. Регистрируете вручную: Callback URL `https://ваш-сайт/api/github/auth/callback`, включите «Request user authorization (OAuth) during installation», webhook выключен, права как в разделе «Права».
3. Реализуйте маршруты, которые ждёт `<comenta-settings>` (пример — `demo/github.mjs`):

| Маршрут | Что делает |
|---|---|
| `GET {endpoint}/status` | `{ oauth, pat, connected, app?, bot?, reason?: 'expired', syncing?, account?, config?, missingScopes?, sync? }` |
| `GET {endpoint}/auth/login?return=` | редирект на GitHub (`authorizeUrl`, `state` в cookie) |
| `GET {endpoint}/auth/callback` | проверка `state`, `exchangeCode`, токен и refresh-токен — в хранилище, браузеру — HttpOnly cookie. Если `countInstallations` вернул 0 — редирект на `installUrl` |
| `GET {endpoint}/auth/install?return=` | редирект на `installUrl` (`state` в cookie): установка приложения и выбор репозиториев |
| `POST {endpoint}/auth/token` | `{ token }`: personal access token (для локальной разработки) |
| `POST {endpoint}/auth/logout` | `revokeGrant` + удаление токена |
| `GET {endpoint}/repos` | `{ items }` из `listInstallationRepos`, для токена — из `listRepos` (только где есть права на запись) |
| `GET {endpoint}/projects?owner=` | `{ items }` из `listProjects` |
| `PUT {endpoint}/config` | `{ repo: 'owner/name', projectId }` → `checkRepo`, `installationId` репозитория из `listInstallationRepos` → `{ config }` |

Ошибки — `{ error: { code, message } }`; `code: 'unauthorized'` компонент понимает как «войдите заново».

4. В обработчике нового комментария вызовите `syncComment`:

```ts
import { GitHubAppAuth, GitHubClient, GitHubError, syncComment } from '@comenta/feedback/github';

// бот приложения: installation token (1 час) выпускается из приватного ключа и кэшируется
const app = new GitHubAppAuth({ appId: process.env.GITHUB_APP_ID, privateKey: process.env.GITHUB_APP_PRIVATE_KEY });
const gh = new GitHubClient({ token: async () => (await app.installationToken(config.installationId)).token });
// без ключа — токен владельца (8 часов, обновляется через refreshAccessToken):
// const gh = new GitHubClient({ token: () => owner.freshToken() });
try {
  const issue = await syncComment(gh, { owner: 'acme', repo: 'site', projectId: owner.projectId }, payload, files, {
    checkExisting: attempt > 0, // на повторах искать уже созданный issue
  });
  comment.issue = issue; // { provider: 'github', repo, number, url, nodeId, projectId? }
} catch (e) {
  if (e instanceof GitHubError && e.retryable) queueRetry(comment); // сеть, 5xx, rate limit (e.resetAt)
  else if (e instanceof GitHubError && e.code === 'uninstalled') askToReinstall(); // приложение удалили на GitHub
  else if (e instanceof GitHubError && e.code === 'unauthorized') markTokenExpired(); // покажется «Войти заново»
  else reportToOwner(e.message); // нет прав, issues выключены…
}
```

`files` — `{ attachment, data }`, где `data` — `Uint8Array`, `ArrayBuffer` или `Blob`.

5. Страница настроек:

```html
<script type="module">
  import { defineSettingsElement } from '@comenta/feedback/settings';
  defineSettingsElement();
</script>
<comenta-settings endpoint="/api/github"></comenta-settings>
```

Свойство `el.headers` добавляет заголовки (например CSRF-токен). События: `comenta-settings-save` (detail — настройки), `comenta-settings-logout`. Защитите эту страницу собственной авторизацией администратора: демо пускает того, кто подключил GitHub первым (или логины из `COMENTA_GITHUB_OWNERS`).

### Синхронизация с issue

Тред и его issue живут вместе:

* **Один статус.** «Закрыт» в Comenta = issue закрыт, «Открыт» = issue открыт. Кнопка ✓ «Закрыть» (и «Ответить и закрыть») сначала закрывает issue (причина «выполнен»), ↺ «Открыть снова» открывает его; если GitHub не ответил, статус не меняется и показывается ошибка. Закрыли или открыли issue на GitHub — тред закрывается или открывается, в ленте строка «octo-dev закрыл(а) на GitHub». Issue, закрытый как «не будет сделан» или дубликат, показывается серым «Закрыт» с причиной. Если статусы разошлись, побеждает GitHub. Тред с issue закрывает и открывает только владелец сайта: issue живёт в его репозитории. Если issue удалён или недоступен, статус живёт только в Comenta, рядом пометка «Issue недоступен».
* **GitHub → Comenta.** Комментарии к issue появляются в треде с именем и аватаром автора на GitHub и пометкой «из GitHub» (ссылка на комментарий). Правки и удаления на GitHub подтягиваются. Отвечать на них можно, редактировать нельзя.
* **Comenta → GitHub.** Ответы в треде публикуются комментарием к issue от бота приложения (без приватного ключа — от владельца) в виде `**Имя Фамилия:** текст`, с записями, если они есть. Правка и удаление ответа в Comenta правят и удаляют комментарий.
* **Без дублей.** В комментарии, который опубликовал Comenta, есть скрытая метка `<!-- comenta:reply=<id> -->`: по ней опрос узнаёт свою копию и не импортирует её обратно, а повтор после сбоя находит уже созданный комментарий вместо второго.
* **Видимость.** Обсуждение в issue может быть внутренним, поэтому комментарии из GitHub и то, кто закрыл issue на GitHub и почему, получают только владелец сайта и автор комментария (сам статус «Закрыт» видят все). Сервер вырезает их для всех остальных (`forViewer(comment, { owner, id })`, где `id` — `author.id` того, кто смотрит), виджет дополнительно прячет их от всех, кроме владельца (`author.role === 'owner'`) и автора.

**Доставка — опросом.** Раз в 30–60 с сервер делает два условных запроса на весь репозиторий: `GET /repos/{o}/{r}/issues?state=all&since=…` и `GET /repos/{o}/{r}/issues/comments?since=…` с `If-None-Match`. Если ничего не изменилось, GitHub отвечает `304`, а такие ответы не расходуют лимит. Когда владелец открывает виджет (и при каждом его опросе, не чаще раза в 20 с на issue), сервер перечитывает issues показанных карточек целиком: так находятся удалённые комментарии, удалённые и перенесённые issues, а старые карточки без данных синхронизации заполняются (их прежние ответы уходят в issue). Вебхуки можно добавить позже: обработчик событий `issues` и `issue_comment` вызывает те же `applyIssueState` и `mergeIssueComments`, а опрос становится реже.

```ts
import { fetchRepoActivity, fetchIssue, fetchIssueComments, applyIssueState, applyIssueStatus, setIssueState, mergeIssueComments,
  postReply, updateReplyComment, deleteReplyComment, forViewer } from '@comenta/feedback/github';

// опрос: cursor храните у себя (в первый раз — дата самого старого комментария с issue)
const act = await fetchRepoActivity(gh, { owner, repo }, cursor);
cursor = act.cursor;
for (const s of act.issues ?? []) {
  applyIssueState(byNumber[s.number].issue, s);
  applyIssueStatus(byNumber[s.number], s); // один статус: тред следует за issue
}
for (const c of act.comments ?? []) {
  const thread = byNumber[c.issueNumber];
  const m = mergeIssueComments(thread, [c]);
  if (m.changed) thread.replies = m.replies;
}

// тред закрыли в Comenta → сначала issue (ошибка GitHub — статус не меняем)
applyIssueState(comment.issue, await setIssueState(gh, comment.issue, 'closed'));

// ответ из Comenta → комментарий issue (повтор после сбоя — с checkExisting: true)
reply.link = await postReply(gh, comment.issue, reply, files, { checkExisting: attempt > 0 });

// GET списка: статус и комментарии GitHub — только владельцу сайта и автору комментария
res.json(comments.map((c) => forViewer(c, { owner: isOwner(req), id: currentUser(req)?.id })));
```

| Ситуация | Что происходит |
|---|---|
| Issue удалён или перенесён в другой репозиторий | На карточке «Issue недоступен», ссылка остаётся (GitHub перенаправляет со старой) |
| Автор комментария на GitHub не пользуется Comenta | Показываются его логин и аватар на GitHub |
| GitHub недоступен, вход владельца истёк, приложение удалено | Ответы ждут в очереди с нарастающей паузой и уходят, когда доступ вернётся; в треде на сайте они видны сразу |
| Ответ написан, пока issue ещё создаётся | Уходит сразу после создания issue |
| Rate limit | Опрос ждёт до сброса лимита (`resetAt`), очередь ответов тоже |

В демо-сервере это сделано в `demo/github.mjs` (раздел «thread sync»): `COMENTA_GITHUB_POLL_MS` (по умолчанию 45 000) — период опроса репозитория, `COMENTA_GITHUB_REFRESH_MS` (20 000) — как часто можно перечитывать одну issue при открытии виджета. Владельцем демо считает того, у кого есть сессия настроек GitHub, а также запросы с заголовком `X-Comenta-Role: owner`, который демо-страница шлёт, когда выбран «Владимир»; автора — по заголовку `X-Comenta-User` (id выбранного пользователя или гостя). Это только для демо: заголовки легко подделать, в настоящем бэкенде владельца и автора определяет ваша авторизация.

### Права

GitHub App просит только то, что нужно: Issues и Contents на запись (issues и загрузка записей), Metadata на чтение, Organization projects на запись (Projects v2 организаций). Токен работает только в репозиториях, выбранных при установке, и только там, где права есть и у самого пользователя; список меняется ссылкой «Изменить доступ к репозиториям на GitHub» в настройках. Issues создаёт бот приложения (`<имя-приложения>[bot]`) installation-токеном, который сервер выпускает из приватного ключа; поэтому они продолжают приходить, даже когда вход владельца истёк. Без приватного ключа issues создаются от имени владельца, с отметкой приложения. Для токена: classic с `repo` + `project` или fine-grained с Issues, Contents и Projects: read & write.

Токен пользователя живёт 8 часов и обновляется сам. Refresh-токен живёт 6 месяцев; если сервер столько не обращался к GitHub, настройки попросят войти заново.

### Ошибки и как их видит владелец

| Ситуация | Что происходит |
|---|---|
| Не вошёл | Кнопка «Войти через GitHub»; без GitHub App на сервере — форма для токена |
| Приложение не установлено | После входа GitHub сразу предлагает установку и выбор репозиториев; если уйти с этой страницы, в настройках будет подсказка и ссылка на установку |
| Вход истёк или отозван | С ключом приложения: «Сессия входа в GitHub истекла. Комментарии по-прежнему создают issues…», войти нужно только чтобы менять настройки. Без ключа: баннер «Доступ к GitHub истёк…», комментарии копятся в очереди и уходят после входа. Выбранный репозиторий сохраняется |
| Приложение удалено на GitHub | Комментарии копятся в очереди, в настройках ошибка и ссылка на установку; после повторной установки очередь уходит |
| Не хватает прав | Предупреждение со списком прав; репозиторий без прав на запись или с выключенными issues не сохраняется, с понятной причиной |
| Нет репозиториев / проектов | Подсказка вместо пустого списка; проект необязателен |
| Сеть, 5xx | Безопасные запросы повторяются 3 раза с паузой; комментарий сохраняется у вас и уходит в GitHub позже (очередь с нарастающей паузой) |
| Rate limit | «GitHub временно ограничил число запросов. Попробуйте через N мин.» и кнопка «Повторить»; короткий `Retry-After` выжидается автоматически |
| Выход | Токен отзывается на GitHub и удаляется с сервера; новые комментарии остаются только у вас |

### Попробовать без GitHub

```bash
pnpm demo:github    # тестовый GitHub на /__github: вход, репозитории, проекты, issues
```

Откройте `http://localhost:5174/demo/settings.html`, войдите, выберите репозиторий и оставьте комментарий на `/`. Что создалось, видно на `/__github/state`. Действия «на GitHub» для проверки синхронизации: `curl -X POST localhost:5174/__github/issue -H 'Content-Type: application/json' -d '{"repo":"acme-studio/web-app","number":1,"comment":"Привет из GitHub"}'` (или `"close":"completed"`, `"reopen":true`, `"delete":true`). `COMENTA_GITHUB_BOT=0 pnpm demo:github` — то же без приватного ключа (issues от имени владельца); e2e в этом режиме: `COMENTA_GITHUB_BOT=0 pnpm test:e2e`. С настоящим GitHub: `pnpm github-app:setup`, затем `pnpm demo` (токены и настройки демо хранит в `demo/github.json`).

## GitLab: комментарии → issues

То же самое для GitLab: gitlab.com или ваш собственный (self-hosted) GitLab. Сайт работает с одним трекером: на странице настроек владелец выбирает GitHub или GitLab, и пока один подключён, второй заблокирован (сначала нужно выйти).

```
посетитель ──comment──▶ ваш сервер ──token──▶ GitLab: issue, загрузки, notes
владелец ──<comenta-settings providers="github gitlab">──▶ ваш сервер (/api/gitlab/*) ──OAuth──▶ GitLab
```

* `@comenta/feedback/gitlab` — серверный модуль (нужны `fetch` и `FormData`, Node 18+): OAuth с refresh-токенами, проверка адреса GitLab, проекты, issues, загрузки, notes, закрытие и открытие.
* `@comenta/feedback/tracker` — общий для GitHub и GitLab слой: ошибки `TrackerError`, текст issue и ответа, слияние комментариев, один статус, правила видимости. Новый трекер добавляется так же: свой модуль API плюс этот слой.
* Рабочий пример бэкенда: [`demo/gitlab.mjs`](demo/gitlab.mjs). Очереди, опрос и один статус у GitHub и GitLab общие: [`demo/tracker-sync.mjs`](demo/tracker-sync.mjs), каждому трекеру нужен только небольшой «драйвер» с вызовами его API.

### Как устроено

| | GitHub | GitLab |
|---|---|---|
| Где | github.com | gitlab.com или ваш сервер (адрес вводится в настройках) |
| Вход | GitHub App | OAuth-приложение GitLab, права `api` и `read_user` |
| Токен | 8 часов, обновляется сам | 2 часа, обновляется сам по refresh-токену (он одноразовый, новый сохраняется) |
| Куда | репозиторий (+ Project v2 по желанию) | проект, в том числе проекты групп и подгрупп; поиск по всем проектам |
| Кто создаёт issues и отвечает | бот приложения (без ключа — владелец) | владелец сайта (его токен), бота нет |
| Записи и скриншоты | ветка `comenta-attachments` | Uploads API проекта, встроены в issue плеером (`![🎙 Голос, 0:42](…)`) |
| Номер в треде | `GitHub #12` | `GitLab #7` (это `iid` issue в проекте) |
| Статус | open / closed (+ причина) | opened / closed |
| Комментарии | issue comments | notes; системные («changed the description») и внутренние (internal) не импортируются никогда |

Всё остальное одинаково: метка `<!-- comenta:id=… -->` и повтор без дублей, один статус (закрыть в Comenta = закрыть issue, и наоборот; при расхождении побеждает трекер; если трекер не ответил, статус не меняется и показывается ошибка), тред с issue закрывает только владелец, ответы подписываются `**Имя Фамилия:** текст` и не возвращаются эхом, статус и комментарии из трекера видят только владелец сайта и автор комментария.

### Подключение GitLab

1. **Создайте OAuth-приложение** на том GitLab, куда будут уходить комментарии. У каждого GitLab свои приложения: ключи с gitlab.com не подходят для self-hosted, и наоборот.
   * gitlab.com или свой GitLab: аватар → **Edit profile → Applications** (`https://gitlab.com/-/user_settings/applications`), или приложение группы (**Group → Settings → Applications**), или на своём GitLab администратором (**Admin → Applications**).
   * **Name**: Comenta. **Redirect URI**: `https://ваш-сайт/api/gitlab/auth/callback` (для локального демо `http://localhost:5174/api/gitlab/auth/callback`).
   * **Confidential**: да. **Scopes**: `api` и `read_user`.
   * После сохранения GitLab покажет **Application ID** и **Secret**.
2. **Передайте их серверу**, не в браузер и не в чат: переменные окружения `GITLAB_URL` (по умолчанию `https://gitlab.com`), `GITLAB_CLIENT_ID` (Application ID), `GITLAB_CLIENT_SECRET` (Secret), либо файл `demo/gitlab-apps.json` (в `.gitignore`), если GitLab-ов несколько:

   ```json
   [{ "url": "https://git.example.com", "clientId": "…", "clientSecret": "…" }]
   ```

   За прокси задайте `PUBLIC_URL`, чтобы redirect URI совпадал с указанным в приложении.
3. **Свой сертификат.** Если у вашего GitLab самоподписанный сертификат, запустите сервер Comenta с `NODE_EXTRA_CA_CERTS=/путь/к/ca.pem`; иначе настройки покажут понятную ошибку про сертификат. Адреса `http://` принимаются только для `localhost` (или с `GITLAB_ALLOW_HTTP=1`).
4. **Страница настроек**: `<comenta-settings providers="github gitlab" endpoint="/api/github" gitlab-endpoint="/api/gitlab">`. Владелец выбирает GitLab, вводит адрес (по умолчанию gitlab.com или первый настроенный), входит, ищет проект и сохраняет. Для локальной разработки можно вставить personal access token с правом `api`.

Маршруты `/api/gitlab/*` такие же, как у GitHub, с отличиями: `GET /auth/login?return=&url=<адрес GitLab>`, `POST /auth/token { token, url }`, `GET /repos?q=` (поиск на стороне GitLab, когда проектов больше, чем поместилось в список; ответ `{ items, complete }`), `PUT /config { id, repo }`, `/projects` нет. В `GET /status` есть `active` (этот трекер — трекер сайта), `blockedBy` (подключён другой), `instances`, `defaultUrl`, `instanceUrl`.

```ts
import { GitLabClient, GitLabError, syncComment, postNote, setIssueState, applyIssueState } from '@comenta/feedback/gitlab';

const gl = new GitLabClient({ baseUrl: owner.gitlabUrl, token: () => owner.freshToken() }); // refreshAccessToken каждые ~2 часа
try {
  comment.issue = await syncComment(gl, { projectId: config.id, path: config.fullName }, payload, files, { checkExisting: attempt > 0 });
  // { provider: 'gitlab', repo: 'group/project', number: <iid>, url, nodeId, repoId: <project id> }
} catch (e) {
  if (e instanceof GitLabError && e.retryable) queueRetry(comment); // сеть, 5xx, 429 (e.resetAt)
  else if (e instanceof GitLabError && e.code === 'unauthorized') markTokenExpired();
  else reportToOwner(e.message); // нет прав (нужна роль Reporter+), issues выключены, сертификат…
}
reply.link = await postNote(gl, comment.issue, reply, files, { checkExisting: attempt > 0 });
applyIssueState(comment.issue, await setIssueState(gl, comment.issue, 'closed'));
```

**Опрос.** Раз в 30–60 с сервер запрашивает issues проекта, изменённые после курсора (`GET /projects/:id/issues?updated_after=…`). Новая или изменённая note обновляет `updated_at` своего issue, поэтому у таких issues сервер перечитывает notes целиком (так же находятся удаления). Отдельного списка notes по всему проекту в GitLab нет. Когда владелец или автор открывает виджет, issues показанных карточек перечитываются, как и для GitHub. В демо: `COMENTA_GITLAB_POLL_MS`, `COMENTA_GITLAB_REFRESH_MS`.

### Права

Comenta просит у GitLab `api` (issues, notes, загрузки) и `read_user` (имя и аватар владельца в настройках). В списке — проекты, где у владельца роль **Reporter** или выше (этого хватает, чтобы создавать, закрывать и комментировать issues), включая проекты групп и подгрупп; архивные не показываются.

### Ошибки и как их видит владелец

| Ситуация | Что происходит |
|---|---|
| Опечатка в адресе | «Это не похоже на адрес GitLab» до перехода на GitLab |
| На сервере нет OAuth-приложения для этого GitLab | Сообщение, что добавить в настройки сервера; можно подключиться по токену |
| По адресу не GitLab, сервер не найден, порт закрыт | «По этому адресу не отвечает GitLab» / «Сервер GitLab не найден» / «не принимает подключения» |
| Самоподписанный или просроченный сертификат | Ошибка про сертификат с подсказкой про `NODE_EXTRA_CA_CERTS`; без повторов |
| Токен истёк | Обновляется сам по refresh-токену, владельцу ничего делать не нужно |
| Токен отозван (или refresh-токен недействителен) | «Доступ к GitLab истёк или был отозван», кнопка «Войти заново»; комментарии и ответы ждут в очереди и уходят после входа, выбранный проект сохраняется |
| Нет права `api` | «Токену не хватает прав: api. Выйдите и войдите снова…» |
| Роль ниже Reporter, issues выключены, проект в архиве | Проект не сохраняется, причина названа; если роль понизили позже, комментарии ждут, а в настройках видна последняя ошибка |
| Нет проектов | «Нет проектов, где у вас роль Reporter или выше…» |
| Очень много проектов | Показываются первые 500, ввод ищет по всем на стороне GitLab |
| Сеть, 5xx | Безопасные запросы повторяются; комментарий сохраняется у вас, при повторе сначала ищется issue по метке |
| Rate limit (429) | «GitLab временно ограничил число запросов. Попробуйте через N мин.»; опрос и очереди ждут до сброса |
| Issue удалён или перенесён в другой проект («Move issue») | «Issue недоступен», ссылка остаётся, статус живёт в Comenta |
| Выход | Токен отзывается на GitLab и удаляется с сервера; новые комментарии остаются только у вас |

### Попробовать без GitLab

```bash
pnpm demo:gitlab    # тестовый GitLab на /__gitlab (как self-hosted): вход, проекты с группами, issues, notes
pnpm demo:mock      # тестовые GitHub и GitLab сразу
```

Откройте `http://localhost:5174/demo/settings.html`, выберите GitLab и войдите. Что создалось — на `/__gitlab/state`. Действия «на GitLab»: `curl -X POST localhost:5174/__gitlab/issue -H 'Content-Type: application/json' -d '{"project":"acme-studio/web-app","iid":1,"note":"Привет из GitLab","username":"ivan"}'` (или `"close":true`, `"reopen":true`, `"delete":true`, `"move":true`, `"internal":true` для внутренней заметки).

## Разработка

```bash
pnpm install
pnpm build          # dist/: ESM, CJS, IIFE, .d.ts
pnpm test           # unit (Vitest + jsdom): селектор, санитизация, позиционирование, адаптеры, lifecycle, React, GitHub, GitLab
pnpm test:e2e       # build + Playwright по демо-странице и настройкам (тестовые GitHub и GitLab)
pnpm demo           # http://localhost:5174 — демо + мок-сервер
pnpm demo:github    # то же с тестовым GitHub (настройки: /demo/settings.html)
pnpm demo:gitlab    # то же с тестовым GitLab
pnpm github-app:setup # регистрация GitHub App для настоящего GitHub, один раз
pnpm size           # gzip-размеры, бюджет 30 КБ
pnpm standalone     # dist/demo-standalone.html: демо одним файлом, открывается двойным кликом
```

Мок-сервер (`demo/server.mjs`, без зависимостей) реализует все маршруты `httpAdapter` и хранит комментарии с ответами в `demo/feedback.log` (JSON Lines), файлы записей кладёт в `demo/uploads/` и раздаёт по `/uploads/<id>.webm`, `?fail=1` отвечает 503. Права он не проверяет. Демо: `/` (в блоке настроек — адаптер, пользователь «Владимир (владелец) / Анна / Гость» для переписки в одном браузере, «враждебные стили»; параметры `?adapter=console|http|fail`, `?user=`, `?poll=<мс>`), `/demo/script-tag.html` — подключение тегом.

## Структура

```
src/
  core/       controller (init, состояние, режим выбора, пины, треды, опрос, layout), identity (гость, непрочитанное), recorder, position, uuid, url
  selector/   генерация селектора, эвристики хэшей, санитизация и описание элемента
  ui/         shadow-root: плашка с кнопками, меню и список комментариев, подсветка, поповер (форма и тред), поле ввода с записью, тост, стили, тексты
  adapters/   http, console/localStorage
  tracker/    общее для всех трекеров: ошибки, текст issue и ответа, слияние комментариев, один статус, видимость
  github/     серверная интеграция GitHub: клиент (повторы, ошибки), вход через GitHub App, репозитории и проекты, синхронизация
  gitlab/     серверная интеграция GitLab: клиент (ошибки, TLS), OAuth, проверка адреса, проекты, issues, загрузки, notes
  settings/   <comenta-settings>: страница настроек для владельца (GitHub или GitLab)
  react/      <FeedbackWidget />
  iife.ts     <script>-бандл с автоинициализацией
  settings-iife.ts  <script>-бандл страницы настроек
  types.ts
demo/         страница с разными элементами, script-tag пример, мок-сервер, settings.html, tracker-sync.mjs (общий движок синхронизации),
              github.mjs / gitlab.mjs (бэкенды), github-mock.mjs / gitlab-mock.mjs (тестовые GitHub и GitLab)
tests/unit    Vitest
tests/e2e     Playwright
```

## Дальше (вне MVP)

Скриншоты, упоминания @имя, редактирование самого комментария, авторизация, интеграция с YouTrack (на общем слое трекеров), мобильные жесты, iframe. GitHub и GitLab: вебхуки вместо опроса; GitHub: колонка GitHub Project на карточке; GitLab: бот (group/project access token), метки и исполнители.
