import { expect, test } from 'claude-code/testing'

import { cleanMarkdown, connect, parseRemote, pickRemote } from '../hooks/tracker'

const PANE = {
  plugin: 'issues-panel',
  component: 'Pane',
  requestId: 'issues',
  props: {
    title: 'Issues',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ok = (stdout: unknown = '') => ({
  value: {
    exitCode: 0,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})
const fail = (stderr: string) => ({
  value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const GH_ISSUES = [
  {
    number: 7,
    title: 'Кнопка не работает',
    state: 'open',
    user: { login: 'anna' },
    labels: [{ name: 'bug' }],
    html_url: 'https://github.com/acme/site/issues/7',
    updated_at: new Date().toISOString(),
    comments: 1,
    body: 'Не нажимается',
  },
  {
    number: 6,
    title: 'PR, не issue',
    state: 'open',
    user: { login: 'bob' },
    labels: [],
    html_url: 'https://github.com/acme/site/pull/6',
    updated_at: new Date().toISOString(),
    comments: 0,
    body: '',
    pull_request: {},
  },
  {
    number: 3,
    title: 'Старая задача',
    state: 'closed',
    user: { login: 'bob' },
    labels: [],
    html_url: 'https://github.com/acme/site/issues/3',
    updated_at: '2026-01-01T00:00:00Z',
    comments: 0,
    body: '',
  },
]

test('remote URLs of every form are read', () => {
  expect(parseRemote('git@github.com:acme/site.git')).toEqual({ host: 'github.com', path: 'acme/site' })
  expect(parseRemote('https://github.com/acme/site')).toEqual({ host: 'github.com', path: 'acme/site' })
  expect(parseRemote('https://oauth2:x@gitlab.example.ru/group/sub/app.git')).toEqual({
    host: 'gitlab.example.ru',
    path: 'group/sub/app',
  })
  expect(parseRemote('ssh://git@git.corp:2222/team/app.git')).toEqual({ host: 'git.corp', path: 'team/app' })
  expect(parseRemote('/srv/repos/app.git')).toBeUndefined()
  expect(
    pickRemote('fork\tgit@github.com:me/site.git (fetch)\norigin\tgit@github.com:acme/site.git (fetch)\n'),
  ).toBe('git@github.com:acme/site.git')
})

test('hidden markers and HTML tags are not drawn as text', () => {
  const body =
    '| a | b |\n\n<sub>Оставлено через Comenta · [открыть](https://x.ru)</sub>\n\n<!-- comenta:id=cbb -->'
  expect(cleanMarkdown(body)).toBe('| a | b |\n\nОставлено через Comenta · [открыть](https://x.ru)')
  expect(cleanMarkdown('**Владимир:** текст\n\n<!-- comenta:reply=75b\n-->')).toBe('**Владимир:** текст')
})

test('a host neither CLI is signed in to says what to run', async () => {
  const run = async (argv: readonly string[]) =>
    argv[1] === '--version'
      ? { exitCode: 0, stdout: '', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'not logged in' }
  await expect(connect({ run, fetch: async () => ({ status: 404, ok: false, text: '' }) }, { host: 'git.corp', path: 'team/app' })).rejects.toThrow(/glab auth login/)
})

test('a missing login on a known host is told by the API answer', async ($, on) => {
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return ok('origin\thttps://github.com/acme/site.git (fetch)\n')
    if (e.argv[0] !== 'gh') throw new Error('not found')
    if (e.argv[1] === '--version') return ok()
    return fail('HTTP 401: Bad credentials (https://api.github.com/repos/acme/site/issues)')
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /gh auth login/ })).toBeDefined()
  await ui.unmount()
})

test('the pane lists issues, opens one with comments, closes it, and inserts it', async ($, on) => {
  const calls: string[] = []
  let filled = ''
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    calls.push(argv.join(' '))
    if (argv[0] === 'git') return ok('origin\tgit@github.com:acme/site.git (fetch)\n')
    if (argv[0] !== 'gh') throw new Error('not found')
    if (argv[1] === '--version' || argv[1] === 'auth') return ok()
    const endpoint = argv[argv.length - 1]!
    if (endpoint.startsWith('repos/acme/site/issues?')) return ok(GH_ISSUES)
    if (endpoint === 'repos/acme/site/issues/7/comments?per_page=100') {
      return ok([{ user: { login: 'vlad' }, body: 'Проверю', created_at: new Date().toISOString() }])
    }
    if (endpoint === 'repos/acme/site/issues/7' && argv.includes('PATCH')) return ok({ number: 7, state: 'closed' })
    return fail(`unexpected ${endpoint}`)
  })
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ type: 'Text', text: /открытых: 1/ })).toBeDefined()
    expect(await ui.find({ key: 'issue-6' })).toBeUndefined()
    expect(await ui.find({ key: 'issue-3' })).toBeUndefined()

    await ui.press({ key: 'issue-7' })
    expect(await ui.find({ type: 'Text', text: /Комментарии \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /vlad/ })).toBeDefined()

    await ui.press({ key: 'insert' })
    expect(filled).toContain('GitHub issue #7: Кнопка не работает')
    expect(filled).toContain('https://github.com/acme/site/issues/7')

    if (surface === 'terminal') {
      await ui.press({ key: 'close' })
      await ui.press({ key: 'close-yes' })
      expect(calls.some(c => c.includes('PATCH') && c.includes('state=closed'))).toBe(true)
      expect(await ui.find({ key: 'close' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^Закрыт$/ })).toBeDefined()
    }

    await ui.press({ key: 'back' })
    // Closed on the terminal pass: no longer listed.
    if (surface === 'terminal') expect(await ui.find({ key: 'issue-7' })).toBeUndefined()
    else expect(await ui.find({ key: 'issue-7' })).toBeDefined()
    await ui.unmount()
  }
})

test('a GitLab repository is read through glab, system notes left out', async ($, on) => {
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'git') return ok('origin\thttps://gitlab.example.ru/group/app.git (fetch)\n')
    if (argv[0] !== 'glab') throw new Error('not found')
    if (argv[1] === '--version' || argv[1] === 'auth') return ok()
    const endpoint = argv[argv.length - 1]!
    if (endpoint.startsWith('projects/group%2Fapp/issues?')) {
      return ok([
        {
          iid: 12,
          title: 'Ошибка входа',
          state: 'opened',
          author: { username: 'kate' },
          labels: ['auth'],
          web_url: 'https://gitlab.example.ru/group/app/-/issues/12',
          updated_at: new Date().toISOString(),
          user_notes_count: 1,
          description: 'Падает',
        },
      ])
    }
    if (endpoint.startsWith('projects/group%2Fapp/issues/12/notes?')) {
      return ok([
        { author: { username: 'kate' }, body: 'changed the description', system: true, created_at: '' },
        { author: { username: 'oleg' }, body: 'Воспроизвёл', system: false, created_at: '' },
      ])
    }
    return fail(`unexpected ${endpoint}`)
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /GitLab · открытых: 1/ })).toBeDefined()
  await ui.press({ key: 'issue-12' })
  expect(await ui.find({ type: 'Text', text: /Комментарии \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /oleg/ })).toBeDefined()
  await ui.unmount()
})

test('a folder that is not a repository says so', async ($, on) => {
  on('session.cwd', () => ({ value: '/tmp' }))
  on('process.run', () => fail('fatal: not a git repository'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /не git-репозиторий/ })).toBeDefined()
  await ui.unmount()
})

test('without gh the login git keeps is used, straight to the API', async ($, on) => {
  const requests: { url: string; method: string; auth: string; body?: string }[] = []
  let credentialInput = ''
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'git' && argv[1] === 'remote') return ok('origin\thttps://github.com/acme/site.git (fetch)\n')
    if (argv[0] === 'git' && argv[1] === 'credential') {
      credentialInput = e.init?.stdin ?? ''
      expect(e.init?.env?.GIT_TERMINAL_PROMPT).toBe('0')
      return ok('protocol=https\nhost=github.com\nusername=vlad\npassword=gho_secret\n')
    }
    throw new Error('not found')
  })
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    requests.push({ url: e.url, method, auth: e.init?.headers?.Authorization ?? '', body: e.init?.body })
    const answer = (status: number, body: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
    })
    if (e.url.startsWith('https://api.github.com/repos/acme/site/issues?')) return answer(200, GH_ISSUES)
    if (e.url === 'https://api.github.com/repos/acme/site/issues/7/comments?per_page=100') return answer(200, [])
    if (e.url === 'https://api.github.com/repos/acme/site/issues/7' && method === 'PATCH') return answer(200, {})
    return answer(404, { message: 'Not Found' })
  })
  on('ui.toast', () => ({ value: undefined }))
  const written: string[] = []
  on('state.set', (_, e, next) => {
    written.push(JSON.stringify(e))
    return next(e)
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(credentialInput).toBe('protocol=https\nhost=github.com\n\n')
  expect(await ui.find({ type: 'Text', text: /открытых: 1/ })).toBeDefined()
  expect(requests[0]?.auth).toBe('Bearer gho_secret')

  await ui.press({ key: 'issue-7' })
  expect(await ui.find({ type: 'Text', text: /Комментарии \(0\)/ })).toBeDefined()
  await ui.press({ key: 'close' })
  await ui.press({ key: 'close-yes' })
  const patch = requests.find(r => r.method === 'PATCH')
  expect(JSON.parse(patch?.body ?? '{}')).toEqual({ state: 'closed', state_reason: 'completed' })
  expect(await ui.find({ key: 'close' })).toBeUndefined()

  // The token never lands in the panel's state.
  expect(written.length).toBeGreaterThan(0)
  expect(written.join('')).not.toContain('gho_secret')
  await ui.unmount()
})

test('without gh and without a git login, the panel says what to do', async ($, on) => {
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git' && e.argv[1] === 'remote') return ok('origin\thttps://github.com/acme/site.git (fetch)\n')
    if (e.argv[0] === 'git') return fail('fatal: could not read Username: terminal prompts disabled')
    throw new Error('not found')
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /не найден gh, и git не хранит пароль/ })).toBeDefined()
  await ui.unmount()
})

test('a row above the prompt shows while the pane is not up and reopens it', async ($, on) => {
  // The first open is not placed (as when the person closed the pane):
  // the row shows; its button opens the pane, and the row goes.
  let opens = 0
  on('ui.open', () => {
    opens += 1
    return opens > 1 ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'closed' } }
  })
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return ok('origin\tgit@github.com:acme/site.git (fetch)\n')
    if (e.argv[0] !== 'gh') throw new Error('not found')
    if (e.argv[1] === '--version' || e.argv[1] === 'auth') return ok()
    return ok(GH_ISSUES)
  })
  on('command.register', () => ({ value: { command: 'issues' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const BAND = {
    plugin: 'issues-panel',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 3,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 3 },
      view: {},
    },
  } as const

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opens).toBe(1)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'open-issues' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /открытых: 1/ })).toBeDefined()
  await band.press({ key: 'open-issues' })
  expect(opens).toBe(2)
  expect(await band.find({ key: 'open-issues' })).toBeUndefined()
  await band.unmount()
})
