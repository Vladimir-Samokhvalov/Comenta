import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { IssuesDetail, IssuesIssue, IssuesList } from '../types'
import {
  TrackerError,
  ago,
  closeIssue,
  connect,
  issueAsContext,
  listComments,
  listIssues,
  parseRemote,
  pickRemote,
  type Run,
} from './tracker'

const PANE = 'issues'
const TITLE = 'Issues'
const REFRESH_MS = 5 * 60 * 1000

// Change a tag when that value's fields change: what an earlier version
// stored outlives a reload, and a new tag reads it as the initial value.
const list = atom({ plugin: 'issues-panel', key: 'list' } as const, { status: 'idle', issues: [] } as IssuesList, {
  shape: 'list-1',
})
const detail = atom({ plugin: 'issues-panel', key: 'detail' } as const, null as IssuesDetail | null, {
  shape: 'detail-1',
})

const setList = ($: EngineInterface, fn: (old: IssuesList) => IssuesList) => update($, list, fn)
const setDetail = ($: EngineInterface, fn: (old: IssuesDetail | null) => IssuesDetail | null) =>
  update($, detail, fn)

const runner =
  ($: EngineInterface, cwd: string): Run =>
  argv =>
    $.process.run(argv, { cwd, timeoutMs: 60_000 })

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

  const run = runner($, cwd)
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
    const repo = await connect(run, remote)
    const issues = await listIssues(run, repo)
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
  const number = issue.number
  await setDetail($, () => ({
    number,
    status: 'loading',
    comments: [],
    isConfirmingClose: false,
    isClosing: false,
  }))
  try {
    const comments = await listComments(runner($, state.cwd), state.repo, number)
    await setDetail($, d => (d?.number === number ? { ...d, status: 'ready', comments } : d))
  } catch (err) {
    await setDetail($, d => (d?.number === number ? { ...d, status: 'error', error: message(err) } : d))
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
    void $.ui.open({ id: PANE, title: TITLE })
    void load($)
    $.clock.every(REFRESH_MS, () => {
      void load($)
    })
    return started
  })

  on('command.run', { command: 'issues' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void load($)
    return { text: 'Панель issues открыта.' }
  })

  // The session moved to another folder: show that folder's repository.
  on('classic.CwdChanged', async ($, e, next) => {
    const done = await next(e)
    void load($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const state = await read($, list)
    const open = await read($, detail)
    const now = Date.now()
    const repo = state.repo
    const issue = open && state.issues.find(i => i.number === open.number)

    if (open && issue && repo) {
      const kind = repo.provider === 'github' ? 'GitHub' : 'GitLab'
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Button key="back" onPress={() => setDetail($, () => null)}>
              ← Назад
            </Button>
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
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Link href={issue.url} label={`Открыть в ${kind}`} />
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
          {issue.body.trim() ? (
            <Markdown text={issue.body} />
          ) : (
            <Text dimColor>Без описания</Text>
          )}
          <Text bold>Комментарии{open.status === 'ready' ? ` (${open.comments.length})` : ''}</Text>
          {open.status === 'loading' && <Text dimColor>Загружаю…</Text>}
          {open.status === 'ready' && open.comments.length === 0 && <Text dimColor>Пока нет</Text>}
          {open.comments.map(c => (
            <Box flexDirection="column">
              <Text dimColor>
                {c.author} · {ago(c.createdAt, now)}
              </Text>
              <Markdown text={c.body.trim() || '—'} />
            </Box>
          ))}
        </Box>
      )
    }

    const openCount = state.issues.filter(i => i.state === 'open').length
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="column" flexShrink={1}>
            {repo ? (
              <Link href={repo.webUrl} label={repo.path} />
            ) : (
              <Text dimColor>{state.cwd ?? 'Репозиторий'}</Text>
            )}
            {repo && (
              <Text dimColor>
                {repo.provider === 'github' ? 'GitHub' : 'GitLab'} · открытых {openCount} из{' '}
                {state.issues.length}
              </Text>
            )}
          </Box>
          <Button key="refresh" dimColor onPress={() => load($)}>
            {state.status === 'loading' ? 'Обновляю…' : 'Обновить'}
          </Button>
        </Box>
        {state.status === 'error' && <Text color="error">{state.error}</Text>}
        {state.status === 'loading' && state.issues.length === 0 && <Text dimColor>Загружаю…</Text>}
        {state.status === 'ready' && state.issues.length === 0 && <Text dimColor>Issues нет</Text>}
        <Box flexDirection="column">
          {state.issues.map(i => (
            <Button key={`issue-${i.number}`} plain onPress={() => openIssue($, i)}>
              <Text color={i.state === 'open' ? 'success' : 'merged'}>{i.state === 'open' ? '●' : '✓'}</Text>
              {` #${i.number} ${i.title} `}
              <Text dimColor>
                {ago(i.updatedAt, now)}
                {i.comments ? ` · 💬 ${i.comments}` : ''}
              </Text>
            </Button>
          ))}
        </Box>
      </Box>
    )
  })
}
