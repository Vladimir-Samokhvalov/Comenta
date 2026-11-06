import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { IssuesDetail, IssuesIssue, IssuesList, IssuesRepo } from '../types'
import {
  TrackerError,
  addComment,
  ago,
  findAttachments,
  imageAsSvg,
  issueBodyHtml,
  closeIssue,
  connect,
  cleanMarkdown,
  issueAsContext,
  listComments,
  listIssues,
  parseRemote,
  pickRemote,
  type Io,
} from './tracker'

const PANE = 'issues'
const TITLE = 'Issues'
const REFRESH_MS = 5 * 60 * 1000

// Change a tag when that value's fields change: what an earlier version
// stored outlives a reload, and a new tag reads it as the initial value.
const list = atom({ plugin: 'issues-panel', key: 'list' } as const, { status: 'idle', issues: [] } as IssuesList, {
  shape: 'list-2',
})
const detail = atom({ plugin: 'issues-panel', key: 'detail' } as const, null as IssuesDetail | null, {
  shape: 'detail-2',
})

const isPaneOpen = atom({ plugin: 'issues-panel', key: 'isPaneOpen' } as const, false)

/** Opens the pane and notes whether the surface placed it. */
async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, isPaneOpen, () => opened.isPlaced)
}

/**
 * Brings the pane up even where the app took it off screen without closing
 * it (the engine then still counts it open, and a plain open does nothing).
 */
async function showPane($: EngineInterface): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane && !pane.isShown) await $.ui.close({ id: PANE })
  await openPane($)
}

/** The Issues button: shows the pane, or closes it while it is on screen. */
async function togglePane($: EngineInterface): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isShown) await $.ui.close({ id: PANE })
  else await showPane($)
}

/** A translucent grey that reads on light and dark themes alike. */
const HOVER_BACKING = 'rgba(128, 128, 128, 0.18)'

/** The tracker's own list of the repository's issues. */
function issuesPage(repo: IssuesRepo): string {
  return repo.provider === 'github' ? `${repo.webUrl}/issues` : `${repo.webUrl}/-/issues`
}

type ResolveInput = Parameters<EngineInterface['ui']['resolve']>[0]

/** The Issues button, or nothing where this folder has no repository. */
async function issuesButton($: EngineInterface, e: ResolveInput) {
  const state = await read($, list)
  if (state.status === 'error' && !state.repo) return undefined
  const isOpen = await read($, isPaneOpen)
  const { Button, Text } = $.ui.resolve(e)
  const open = state.issues.filter(i => i.state === 'open').length
  const label = state.repo ? `Issues · ${open}` : 'Issues'
  // The desktop: bare text like the model and mode beside it, a grey
  // backing only under the pointer.
  if (e.surface !== 'terminal') {
    const { Box } = $.ui.resolve(e)
    return (
      <Box key="issues-chip">
        <Button
          key="toggle-issues"
          plain
          label={label}
          hover={{ backgroundColor: HOVER_BACKING }}
          onPress={() => togglePane($)}
        />
      </Box>
    )
  }
  return (
    <Button key="toggle-issues" plain dimColor={!isOpen} onPress={() => togglePane($)}>
      {'Issues'}
      {state.repo ? <Text dimColor> · {open}</Text> : ''}
    </Button>
  )
}

const setList = ($: EngineInterface, fn: (old: IssuesList) => IssuesList) => update($, list, fn)
const setDetail = ($: EngineInterface, fn: (old: IssuesDetail | null) => IssuesDetail | null) =>
  update($, detail, fn)

const runner = ($: EngineInterface, cwd: string): Io => ({
  run: (argv, init) => $.process.run(argv, { cwd, timeoutMs: 60_000, ...init }),
  fetch: (url, init) => $.http.fetch(url, init),
})

const message = (err: unknown) => (err instanceof TrackerError ? err.message : String(err))

/** Reads the folder's git remote, connects, and loads the issues. */
async function load($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const before = await read($, list)
  if (before.status === 'loading' && before.cwd === cwd) return
  const sameFolder = before.cwd === cwd
  await setList($, old => ({
    ...old,
    status: 'loading',
    cwd,
    error: undefined,
    ...(sameFolder ? {} : { repo: undefined, issues: [] }),
  }))
  if (!sameFolder) await setDetail($, () => null)

  const io = runner($, cwd)
  const run = io.run
  try {
    let remotes
    try {
      remotes = await run(['git', 'remote', '-v'])
    } catch {
      throw new TrackerError('git не найден')
    }
    if (remotes.exitCode !== 0) throw new TrackerError('Эта папка не git-репозиторий')
    const url = pickRemote(remotes.stdout)
    if (!url) throw new TrackerError('У репозитория нет remote')
    const remote = parseRemote(url)
    if (!remote) throw new TrackerError(`Не понял адрес remote: ${url}`)
    const repo = await connect(io, remote)
    const issues = await listIssues(io, repo)
    await setList($, old =>
      old.cwd === cwd ? { status: 'ready', cwd, repo, issues, loadedAt: Date.now() } : old,
    )
  } catch (err) {
    await setList($, old => (old.cwd === cwd ? { ...old, status: 'error', error: message(err) } : old))
  }
}

async function openIssue($: EngineInterface, issue: IssuesIssue): Promise<void> {
  const state = await read($, list)
  if (!state.repo || !state.cwd) return
  const repo = state.repo
  const io = runner($, state.cwd)
  const number = issue.number
  await setDetail($, () => ({
    number,
    status: 'loading',
    comments: [],
    isConfirmingClose: false,
    isClosing: false,
    attachments: [],
    draft: '',
    isSending: false,
    draftKey: 0,
  }))
  void loadAttachments($, io, repo, issue)
  try {
    const comments = await listComments(io, repo, number)
    await setDetail($, d => (d?.number === number ? { ...d, status: 'ready', comments } : d))
  } catch (err) {
    await setDetail($, d => (d?.number === number ? { ...d, status: 'error', error: message(err) } : d))
  }
}

/** Finds the description's pictures and files, then reads each picture. */
async function loadAttachments($: EngineInterface, io: Io, repo: IssuesRepo, issue: IssuesIssue): Promise<void> {
  const number = issue.number
  let html: string | undefined
  try {
    html = await issueBodyHtml(io, repo, number)
  } catch {
    // the pictures then load from their plain addresses, if they can
  }
  const found = findAttachments(repo, issue.body, html)
  if (found.length === 0) return
  await setDetail($, d =>
    d?.number === number
      ? {
          ...d,
          attachments: found.map(a => ({
            kind: a.kind,
            name: a.name,
            url: a.url,
            status: a.kind === 'image' ? 'loading' : 'ready',
          })),
        }
      : d,
  )
  for (const a of found) {
    if (a.kind !== 'image') continue
    const svg = await imageAsSvg(io, a.fetchUrl)
    await setDetail($, d =>
      d?.number === number
        ? {
            ...d,
            attachments: d.attachments.map(x =>
              x.url === a.url ? { ...x, status: svg ? 'ready' : 'failed', ...(svg ? { svg } : {}) } : x,
            ),
          }
        : d,
    )
  }
}

async function sendComment($: EngineInterface, number: number, text: string): Promise<void> {
  const body = text.trim()
  const state = await read($, list)
  const now = await read($, detail)
  if (!body || !state.repo || !state.cwd || now?.number !== number || now.isSending) return
  const io = runner($, state.cwd)
  await setDetail($, d => (d?.number === number ? { ...d, draft: text, isSending: true, error: undefined } : d))
  try {
    await addComment(io, state.repo, number, body)
    const comments = await listComments(io, state.repo, number)
    await setDetail($, d =>
      d?.number === number
        ? { ...d, comments, status: 'ready', draft: '', isSending: false, draftKey: d.draftKey + 1 }
        : d,
    )
    await setList($, old => ({
      ...old,
      issues: old.issues.map(i =>
        i.number === number ? { ...i, comments: comments.length, updatedAt: new Date().toISOString() } : i,
      ),
    }))
  } catch (err) {
    await setDetail($, d => (d?.number === number ? { ...d, isSending: false, error: message(err) } : d))
  }
}

async function close($: EngineInterface, number: number): Promise<void> {
  const state = await read($, list)
  if (!state.repo || !state.cwd) return
  await setDetail($, d => (d?.number === number ? { ...d, isClosing: true, error: undefined } : d))
  try {
    await closeIssue(runner($, state.cwd), state.repo, number)
    await setList($, old => ({
      ...old,
      issues: old.issues.map(i =>
        i.number === number ? { ...i, state: 'closed', updatedAt: new Date().toISOString() } : i,
      ),
    }))
    await setDetail($, d =>
      d?.number === number ? { ...d, isClosing: false, isConfirmingClose: false } : d,
    )
    $.ui.toast(`Issue #${number} закрыт`)
  } catch (err) {
    await setDetail($, d =>
      d?.number === number ? { ...d, isClosing: false, isConfirmingClose: false, error: message(err) } : d,
    )
  }
}

async function insert($: EngineInterface, issue: IssuesIssue): Promise<void> {
  const state = await read($, list)
  if (!state.repo) return
  const filled = await $.prompt.fill({ text: issueAsContext(state.repo, issue), mode: 'insert' })
  if (!filled.isFilled) $.ui.toast('Не удалось вставить в поле ввода')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'issues',
      description: 'Показать issues GitHub/GitLab этого репозитория в панели',
    })
    void openPane($)
    void load($)
    $.clock.every(REFRESH_MS, () => {
      void load($)
    })
    return started
  })

  on('command.run', { command: 'issues' }, async $ => {
    await showPane($)
    await load($)
    return { text: 'Панель issues открыта.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await update($, isPaneOpen, () => false)
    return closed
  })

  // The Issues button. The terminal draws it in the hint line under the
  // prompt; the desktop app draws no plugin tree there, so it gets the band
  // just above the prompt instead, always shown.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const button = await issuesButton($, e)
    if (!button) return next(e)
    const { Box } = $.ui.resolve(e)
    const engine = await next(e)
    return (
      <Box flexDirection="row" gap={2} alignItems="center">
        {button}
        {engine}
      </Box>
    )
  })

  // The desktop's footer under the prompt (the labels at its right, beside
  // the mode): the one place under the input the app hands to plugins.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface === 'terminal') return next(e)
    const button = await issuesButton($, e)
    if (!button) return next(e)
    const { Box } = $.ui.resolve(e)
    const engine = await next(e)
    return (
      <Box flexDirection="row" gap={2} alignItems="center">
        {button}
        {engine}
      </Box>
    )
  })

  // The session moved to another folder: show that folder's repository.
  on('classic.CwdChanged', async ($, e, next) => {
    const done = await next(e)
    void load($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown, Input } = $.ui.resolve(e)
    const elements = $.ui.resolve(e)
    // The terminal has no Svg: pictures are links there.
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const state = await read($, list)
    const open = await read($, detail)
    const now = Date.now()
    const repo = state.repo
    const issue = open && state.issues.find(i => i.number === open.number)

    if (open && issue && repo) {
      return (
        <Box flexDirection="column" gap={1}>
          {/* The actions on top; the tracker's page behind a link icon at the right. */}
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="back" onPress={() => setDetail($, () => null)}>
                ← Назад
              </Button>
              <Button key="insert" variant="primary" onPress={() => insert($, issue)}>
                Вставить в чат
              </Button>
              {issue.state === 'open' && !open.isConfirmingClose && (
                <Button
                  key="close"
                  onPress={() => setDetail($, d => (d ? { ...d, isConfirmingClose: true } : d))}
                >
                  Закрыть issue
                </Button>
              )}
            </Box>
            <Link href={issue.url} label="↗" />
          </Box>
          <Box flexDirection="column">
            <Text bold wrap="wrap">
              #{issue.number} {issue.title}
            </Text>
            <Text dimColor>
              <Text color={issue.state === 'open' ? 'success' : 'merged'}>
                {issue.state === 'open' ? 'Открыт' : 'Закрыт'}
              </Text>
              {` · ${issue.author} · ${ago(issue.updatedAt, now)}`}
              {issue.labels.length ? ` · ${issue.labels.join(', ')}` : ''}
            </Text>
          </Box>
          {open.isConfirmingClose && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text>{open.isClosing ? 'Закрываю…' : `Закрыть #${issue.number}?`}</Text>
              {!open.isClosing && (
                <Button key="close-yes" variant="primary" onPress={() => close($, issue.number)}>
                  Да, закрыть
                </Button>
              )}
              {!open.isClosing && (
                <Button
                  key="close-no"
                  onPress={() => setDetail($, d => (d ? { ...d, isConfirmingClose: false } : d))}
                >
                  Отмена
                </Button>
              )}
            </Box>
          )}
          {open.error && <Text color="error">{open.error}</Text>}
          {cleanMarkdown(issue.body) ? (
            <Markdown text={cleanMarkdown(issue.body)} />
          ) : (
            open.attachments.length === 0 && <Text dimColor>Без описания</Text>
          )}
          {open.attachments.length > 0 && (
            <Box flexDirection="column" gap={1}>
              <Text bold>Вложения ({open.attachments.length})</Text>
              {open.attachments.map((a, n) =>
                a.kind === 'image' && a.status === 'ready' && a.svg && Svg ? (
                  <Box key={`att-${n}`} flexDirection="column">
                    <Svg source={a.svg} alt={a.name} />
                    <Link href={a.url} label={`${a.name} · открыть`} />
                  </Box>
                ) : a.kind === 'image' && a.status === 'loading' ? (
                  <Text key={`att-${n}`} dimColor>
                    🖼 {a.name}: загружаю…
                  </Text>
                ) : (
                  <Link key={`att-${n}`} href={a.url} label={`${a.kind === 'image' ? '🖼' : '📎'} ${a.name}`} />
                ),
              )}
            </Box>
          )}
          <Text bold>Комментарии{open.status === 'ready' ? ` (${open.comments.length})` : ''}</Text>
          {open.status === 'loading' && <Text dimColor>Загружаю…</Text>}
          {open.status === 'ready' && open.comments.length === 0 && <Text dimColor>Пока нет</Text>}
          {open.comments.map((c, n) => (
            <Box key={`comment-${n}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Text>
                <Text bold>{c.author}</Text>
                <Text dimColor> · {ago(c.createdAt, now)}</Text>
              </Text>
              <Markdown text={cleanMarkdown(c.body) || '—'} />
            </Box>
          ))}
          <Box flexDirection="column" gap={1}>
            <Input
              key={`draft-${open.draftKey}`}
              rows={3}
              value={open.draft}
              placeholder="Написать комментарий…"
              // The field's own button (the desktop draws it beside the field;
              // the terminal hints Enter) sends: no second one.
              submitLabel="Отправить"
              onInput={value => setDetail($, d => (d?.number === issue.number ? { ...d, draft: value } : d))}
              onSubmit={value => sendComment($, issue.number, value)}
            />
            <Text dimColor>
              {open.isSending ? 'Отправляю… ' : ''}от имени{' '}
              {repo.via === 'cli' ? 'вашего входа в ' + (repo.provider === 'github' ? 'gh' : 'glab') : 'вашего входа в git'}
            </Text>
          </Box>
        </Box>
      )
    }

    // Closed issues are not listed (one closed here stays in its card until Назад).
    const shown = state.issues.filter(i => i.state === 'open')
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="column" flexShrink={1}>
            {repo ? (
              <Text>{repo.path}</Text>
            ) : (
              <Text dimColor>{state.cwd ?? 'Репозиторий'}</Text>
            )}
            {repo && (
              <Box flexDirection="row">
                <Link href={issuesPage(repo)} label={repo.provider === 'github' ? 'GitHub' : 'GitLab'} />
                <Text dimColor> · открытых: {shown.length}</Text>
              </Box>
            )}
          </Box>
          <Button key="refresh" dimColor onPress={() => load($)}>
            {state.status === 'loading' ? 'Обновляю…' : 'Обновить'}
          </Button>
        </Box>
        {state.status === 'error' && <Text color="error">{state.error}</Text>}
        {state.status === 'loading' && shown.length === 0 && <Text dimColor>Загружаю…</Text>}
        {state.status === 'ready' && shown.length === 0 && <Text dimColor>Открытых issues нет</Text>}
        <Box flexDirection="column" gap={1}>
          {shown.map(i => (
            <Box key={`card-${i.number}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Button key={`issue-${i.number}`} plain onPress={() => openIssue($, i)}>
                <Text bold wrap="truncate-end">
                  {i.title}
                </Text>
              </Button>
              <Text dimColor wrap="truncate-end">
                <Text color="success">●</Text>
                {` #${i.number} · ${i.author} · ${ago(i.updatedAt, now)}`}
                {i.comments ? ` · 💬 ${i.comments}` : ''}
              </Text>
              {i.labels.length > 0 && (
                <Text color="suggestion" wrap="truncate-end">
                  {i.labels.map(l => `#${l}`).join('  ')}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
