# issues-panel: issues в боковой панели Claude Code

Мод для Claude Code. Он показывает в боковой панели issues репозитория, который открыт в сессии.
По `git remote` (`origin`, иначе `upstream`, иначе первый) мод понимает, GitHub это или GitLab
(включая self-hosted), и ходит в API через ваш `gh` или `glab`. Если их нет, мод берёт вход,
который git хранит для `https://<host>` (связка ключей macOS, Git Credential Manager), то есть тот же,
что использует `git push` по https. Ничего настраивать не нужно, токен мод нигде не сохраняет.

Что умеет:

- список открытых issues (последние 300 по дате обновления, PR и MR не показываются);
- карточка issue: описание, метки, автор и комментарии (системные заметки GitLab скрыты);
- вложения из описания: картинки показываются прямо в карточке (мод скачивает их через `curl` и
  уменьшает через `sips` на macOS или ImageMagick), остальные файлы показываются ссылками.
  В терминальной версии картинки тоже показываются ссылками;
- поле «Написать комментарий» в карточке: комментарий уходит от вашего имени через gh/glab или вход из git;
- свои комментарии можно изменить или удалить («Изменить» / «Удалить» в углу комментария, удаление с подтверждением);
- **↗** в правом верхнем углу карточки: открыть issue в браузере;
- **Вставить в чат**: номер, заголовок, ссылка и описание issue попадают в поле ввода;
- **Закрыть issue**, с подтверждением;
- обновление по кнопке, каждые 5 минут и при смене папки сессии. Команда `/issues` открывает панель снова;
- кнопка «Issues · N» открывает панель и прячет её: в терминале она под полем ввода, в приложении — в строке под полем ввода, рядом с моделью и режимом. Команда `/issues` тоже возвращает панель.

## Что нужно

Подходит любой из вариантов:

- `gh` с выполненным входом (`gh auth login`) для GitHub или `glab` (`glab auth login --hostname <host>`) для GitLab.
  Мод ищет их в `PATH`, а также в `/opt/homebrew/bin`, `/usr/local/bin` и `/usr/bin`;
- либо репозиторий клонирован по https, и git помнит вход: `git pull` проходит без запроса пароля.
  В хранилище должен лежать токен (так делают GitHub Desktop, Git Credential Manager и
  `gh auth setup-git`), а не пароль от аккаунта.

Если хост не github.com и в его имени нет «gitlab», мод выбирает тот CLI, который вошёл в этот хост,
или спрашивает API хоста, GitLab это или GitHub Enterprise.

## Установка

В терминальной сессии Claude Code:

```
/plugin install issues-panel --marketplace Vladimir-Samokhvalov/Comenta
```

Из shell:

```
claude plugin install issues-panel --marketplace Vladimir-Samokhvalov/Comenta
```

В десктопном приложении, где `/plugin` не работает: нажмите «+» рядом с полем ввода, затем
Plugins → Add marketplace → `Vladimir-Samokhvalov/Comenta`, затем Add plugin. Мод, установленный из
терминала в user scope, тоже загружается в сессиях десктопного приложения.

## Разработка

```
claude --plugin-dir tools/claude-issues   # запустить с модом из папки
claude plugin validate tools/claude-issues
claude plugin test tools/claude-issues    # tests/*.test.tsx
```

Код: `hooks/tracker.ts` (remote, выбор CLI, вызовы `gh api` / `glab api`), `hooks/register.tsx`
(панель, команда `/issues`), `types/index.d.ts` (состояние панели).
