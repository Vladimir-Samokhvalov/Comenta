# issues-panel: issues в боковой панели Claude Code

Мод для Claude Code. Он показывает в боковой панели issues репозитория, который открыт в сессии.
По `git remote` (`origin`, иначе `upstream`, иначе первый) мод понимает, GitHub это или GitLab
(включая self-hosted), и ходит в API через ваш `gh` или `glab`. Токен не хранится и не
настраивается: используется вход, который уже выполнен в CLI.

Что умеет:

- список issues, открытых и закрытых (последние 300 по дате обновления, PR и MR не показываются);
- карточка issue: описание, метки, автор и комментарии (системные заметки GitLab скрыты);
- **Открыть в GitHub/GitLab**: ссылка в браузер;
- **Вставить в чат**: номер, заголовок, ссылка и описание issue попадают в поле ввода;
- **Закрыть issue**, с подтверждением;
- обновление по кнопке, каждые 5 минут и при смене папки сессии. Команда `/issues` открывает панель снова.

## Что нужно

- `gh` с выполненным входом (`gh auth login`) для GitHub или `glab` (`glab auth login --hostname <host>`) для GitLab.
  Мод ищет их в `PATH`, а также в `/opt/homebrew/bin`, `/usr/local/bin` и `/usr/bin`.
- Если хост не github.com и в его имени нет «gitlab», мод выбирает тот CLI, который вошёл в этот хост.

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
