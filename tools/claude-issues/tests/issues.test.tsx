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

    expect(await ui.find({ key: 'group-open', text: 'Открытые · 1 ⌄' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'acme/site' })).toBeUndefined()
    const issuesLink = await ui.find({ type: 'Link', text: 'GitHub' })
    expect((issuesLink as { props?: { href?: string } } | undefined)?.props?.href).toBe('https://github.com/acme/site/issues')
    expect(await ui.find({ key: 'issue-6' })).toBeUndefined()
    // Closed issues sit in their own group, folded until pressed.
    expect(await ui.find({ key: 'issue-3' })).toBeUndefined()
    if (surface === 'desktop') {
      expect(calls.some(c => c.includes('state=closed&'))).toBe(true)
      await ui.press({ key: 'group-closed' })
      expect(await ui.find({ key: 'issue-3' })).toBeDefined()
      await ui.press({ key: 'group-closed' })
      expect(await ui.find({ key: 'group-closed', text: 'Закрытые · 1 ›' })).toBeDefined()
    }

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
    // Closed on the terminal pass: moved to the folded «Закрытые» group.
    if (surface === 'terminal') {
      expect(await ui.find({ key: 'issue-7' })).toBeUndefined()
      expect(await ui.find({ key: 'group-closed', text: 'Закрытые · 2 ›' })).toBeDefined()
    }
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
  expect(await ui.find({ key: 'group-open', text: 'Открытые · 1 ⌄' })).toBeDefined()
  const issuesLink = await ui.find({ type: 'Link', text: 'GitLab' })
  expect((issuesLink as { props?: { href?: string } } | undefined)?.props?.href).toBe(
    'https://gitlab.example.ru/group/app/-/issues',
  )
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
  expect(await ui.find({ key: 'group-open', text: 'Открытые · 1 ⌄' })).toBeDefined()
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

test('without a login the panel asks for a token, checks it and stores it through git', async ($, on) => {
  const stored: string[] = []
  let kept = ''
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'git' && argv[1] === 'remote') return ok('origin\tgit@gitlab.acme.dev:team/app.git (fetch)\n')
    if (argv[0] === 'git' && argv[1] === 'credential' && argv[2] === 'approve') {
      stored.push(e.init?.stdin ?? '')
      kept = /password=(.*)/.exec(e.init?.stdin ?? '')?.[1] ?? ''
      return ok()
    }
    if (argv[0] === 'git' && argv[1] === 'credential') {
      return kept ? ok(`protocol=https\nhost=gitlab.acme.dev\nusername=oauth2\npassword=${kept}\n`) : fail('no')
    }
    throw new Error('not found')
  })
  on('http.fetch', (_, e) => {
    const auth = e.init?.headers?.Authorization ?? ''
    const answer = (status: number, body: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
    })
    if (auth !== 'Bearer glpat-good') return answer(401, { message: '401 Unauthorized' })
    if (e.url === 'https://gitlab.acme.dev/api/v4/version') return answer(200, { version: '17.0' })
    if (e.url.startsWith('https://gitlab.acme.dev/api/v4/projects/team%2Fapp/issues?')) return answer(200, [])
    return answer(404, { message: 'Not Found' })
  })
  on('ui.toast', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /не найден glab, и git не хранит для него токен/ })).toBeDefined()
  const page = await ui.find({ type: 'Link', text: /Создать токен в GitLab/ })
  expect((page as { props?: { href?: string } } | undefined)?.props?.href).toBe(
    'https://gitlab.acme.dev/-/user_settings/personal_access_tokens?name=Claude%20Issues&scopes=api',
  )

  // A wrong token is refused and nothing is stored.
  await ui.input({ key: 'token-0', text: 'glpat-bad', kind: 'submit' })
  expect(stored).toEqual([])
  expect(await ui.find({ type: 'Text', text: /не принял этот токен/ })).toBeDefined()

  // A good one is stored through git, and the list loads.
  await ui.input({ key: 'token-1', text: 'glpat-good', kind: 'submit' })
  expect(stored).toEqual(['protocol=https\nhost=gitlab.acme.dev\nusername=oauth2\npassword=glpat-good\n\n'])
  expect(await ui.find({ key: 'group-open', text: 'Открытые · 0 ⌄' })).toBeDefined()
  await ui.unmount()
})

test('the Issues button shows the pane and closes it: under the prompt on the terminal and on the desktop', async ($, on) => {
  // The first open is not placed (as when the app took the pane away).
  let opens = 0
  let closes = 0
  let shown = false
  on('ui.open', () => {
    opens += 1
    shown = opens > 1
    return shown ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'closed' } }
  })
  on('ui.close', () => {
    closes += 1
    shown = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: shown ? [{ id: 'issues', title: 'Issues', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
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

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opens).toBe(1)

  const HINT = {
    plugin: 'issues-panel',
    component: 'PromptHint',
    requestId: 'hint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  } as const
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

  // The desktop: in the footer under the prompt, as its own button; not in
  // the hint line, not in the band above.
  const hintOnDesktop = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await hintOnDesktop.find({ key: 'toggle-issues' })).toBeUndefined()
  await hintOnDesktop.unmount()
  const bandOnDesktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await bandOnDesktop.find({ key: 'toggle-issues' })).toBeUndefined()
  await bandOnDesktop.unmount()
  const footer = await $.ui.mount({
    plugin: 'issues-panel',
    component: 'SessionMode',
    requestId: 'footer',
    props: { modes: ['Auto'] },
    surface: 'desktop',
  })
  expect(await footer.find({ key: 'toggle-issues', text: 'Issues · 1' })).toBeDefined()
  await footer.press({ key: 'toggle-issues' })
  expect(opens).toBe(2)
  await footer.press({ key: 'toggle-issues' })
  expect(closes).toBe(1)
  expect(await footer.find({ key: 'toggle-issues' })).toBeDefined()
  await footer.unmount()

  // The terminal: in the hint line, not in the band.
  const bandOnTerminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await bandOnTerminal.find({ key: 'toggle-issues' })).toBeUndefined()
  await bandOnTerminal.unmount()
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await hint.find({ type: 'Text', text: /· 1/ })).toBeDefined()
  await hint.press({ key: 'toggle-issues' })
  expect(opens).toBe(3)
  await hint.unmount()
})

test('/issues brings back a pane the app took off screen', async ($, on) => {
  const calls: string[] = []
  on('ui.panes', () => ({
    value: [{ id: 'issues', title: 'Issues', isShown: false, isFocused: false, isPlaced: true }],
  }))
  on('ui.close', () => {
    calls.push('close')
    return { value: undefined }
  })
  on('ui.open', () => {
    calls.push('open')
    return { value: { isPlaced: true } }
  })
  on('session.cwd', () => ({ value: '/tmp' }))
  on('process.run', () => fail('fatal: not a git repository'))
  await $.command.run({ command: 'issues' } as Parameters<typeof $.command.run>[0])
  expect(calls).toEqual(['close', 'open'])
})

test('a comment is written from the card, and description pictures are drawn', async ($, on) => {
  const posted: string[] = []
  let fetched = ''
  const body =
    'Смотри скрин\n\n<img width="1904" height="664" alt="Image" src="https://github.com/user-attachments/assets/f30b2f99-9cc0-4259-b33b-5ef59a10f8fe" />\n\n[запись.webm](https://github.com/acme/site/blob/comenta-attachments/comenta/1/rec.webm)'
  const issue = { ...GH_ISSUES[0]!, body }
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'git') return ok('origin\tgit@github.com:acme/site.git (fetch)\n')
    if (argv[0] === 'sh') {
      fetched = argv[argv.length - 1]!
      return ok('image/jpeg 40 20\nQUJD')
    }
    if (argv[0] !== 'gh') throw new Error('not found')
    if (argv[1] === '--version' || argv[1] === 'auth') return ok()
    const endpoint = argv[argv.length - 1]!
    if (endpoint.startsWith('repos/acme/site/issues?')) return ok([issue])
    if (endpoint === 'repos/acme/site/issues/7' && argv.includes('Accept: application/vnd.github.full+json')) {
      return ok({
        body_html:
          '<p><img alt="Image" src="https://private-user-images.githubusercontent.com/1/2-f30b2f99-9cc0-4259-b33b-5ef59a10f8fe.png?jwt=abc&amp;x=1"></p>',
      })
    }
    if (endpoint === 'repos/acme/site/issues/7/comments' && argv.includes('POST')) {
      posted.push(argv[argv.indexOf('-f') + 1]!)
      return ok({})
    }
    if (endpoint === 'repos/acme/site/issues/7/comments?per_page=100') {
      return ok(posted.map(p => ({ user: { login: 'vlad' }, body: p.slice('body='.length), created_at: new Date().toISOString() })))
    }
    return fail(`unexpected ${endpoint}`)
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'issue-7' })

  // The picture is read from the signed address and drawn; the recording is a link.
  expect(fetched).toBe(
    'https://private-user-images.githubusercontent.com/1/2-f30b2f99-9cc0-4259-b33b-5ef59a10f8fe.png?jwt=abc&x=1',
  )
  expect(await ui.find({ type: 'Text', text: /Вложения \(2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /запись\.webm/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /<img/ })).toBeUndefined()

  await ui.input({ key: 'draft-0', text: 'Починил, проверь', kind: 'change' })
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.input({ key: 'draft-0', text: 'Починил, проверь', kind: 'submit' })
  expect(posted).toEqual(['body=Починил, проверь'])
  expect(await ui.find({ type: 'Text', text: /Комментарии \(1\)/ })).toBeDefined()
  expect(await ui.find({ key: 'draft-1' })).toBeDefined()
  await ui.unmount()
})

test('own comments are changed and deleted from the card, others are left alone', async ($, on) => {
  let comments = [
    { id: 1, user: { login: 'vlad' }, body: 'мой', created_at: new Date().toISOString() },
    { id: 2, user: { login: 'anna' }, body: 'чужой', created_at: new Date().toISOString() },
  ]
  const calls: string[] = []
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'git') return ok('origin\tgit@github.com:acme/site.git (fetch)\n')
    if (argv[0] === 'sh') return fail('no pictures')
    if (argv[0] !== 'gh') throw new Error('not found')
    if (argv[1] === '--version' || argv[1] === 'auth') return ok()
    const endpoint = argv[argv.length - 1]!
    if (endpoint.startsWith('repos/acme/site/issues?')) return ok([GH_ISSUES[0]])
    if (endpoint === 'user') return ok({ login: 'vlad' })
    if (endpoint === 'repos/acme/site/issues/7') return ok({ body_html: '' })
    if (endpoint === 'repos/acme/site/issues/7/comments?per_page=100') return ok(comments)
    if (endpoint === 'repos/acme/site/issues/comments/1' && argv.includes('PATCH')) {
      const body = argv[argv.indexOf('-f') + 1]!.slice('body='.length)
      calls.push(`edit ${body}`)
      comments = comments.map(c => (c.id === 1 ? { ...c, body } : c))
      return ok(comments[0])
    }
    if (endpoint === 'repos/acme/site/issues/comments/1' && argv.includes('DELETE')) {
      calls.push('delete')
      comments = comments.filter(c => c.id !== 1)
      return ok()
    }
    return fail(`unexpected ${endpoint}`)
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'issue-7' })

  expect(await ui.find({ key: 'edit-1' })).toBeDefined()
  expect(await ui.find({ key: 'edit-2' })).toBeUndefined()
  expect(await ui.find({ key: 'delete-2' })).toBeUndefined()

  await ui.press({ key: 'edit-1' })
  await ui.input({ key: 'editing-1', text: 'исправил', kind: 'submit' })
  expect(calls).toEqual(['edit исправил'])
  expect(await ui.find({ key: 'editing-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: /исправил/ })).toBeDefined()

  await ui.press({ key: 'delete-1' })
  expect(await ui.find({ type: 'Text', text: /Удалить комментарий\?/ })).toBeDefined()
  await ui.press({ key: 'delete-yes-1' })
  expect(calls).toEqual(['edit исправил', 'delete'])
  expect(await ui.find({ type: 'Text', text: /Комментарии \(1\)/ })).toBeDefined()
  await ui.unmount()
})

test('ticked issues are closed or reopened from the selection bar', async ($, on) => {
  const calls: string[] = []
  on('session.cwd', () => ({ value: '/work/site' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'git') return ok('origin\tgit@github.com:acme/site.git (fetch)\n')
    if (argv[0] !== 'gh') throw new Error('not found')
    if (argv[1] === '--version' || argv[1] === 'auth') return ok()
    const endpoint = argv[argv.length - 1]!
    if (endpoint.startsWith('repos/acme/site/issues?')) return ok(GH_ISSUES)
    if (argv.includes('PATCH')) {
      calls.push(`${endpoint} ${argv.filter(a => a.startsWith('state=')).join(' ')}`)
      return ok({})
    }
    throw new Error(`unexpected ${endpoint}`)
  })
  on('ui.toast', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ key: 'selection-bar' })).toBeUndefined()
  await ui.press({ key: 'check-7' })
  expect(await ui.find({ type: 'Text', text: '1 выбрано' })).toBeDefined()
  expect(await ui.find({ key: 'selection-reopen' })).toBeUndefined()
  await ui.press({ key: 'selection-close' })
  expect(calls).toEqual(['repos/acme/site/issues/7 state=closed'])
  expect(await ui.find({ key: 'selection-bar' })).toBeUndefined()

  await ui.press({ key: 'group-closed' })
  await ui.press({ key: 'check-3' })
  await ui.press({ key: 'selection-reopen' })
  expect(calls[1]).toBe('repos/acme/site/issues/3 state=open')
  expect(await ui.find({ key: 'group-open', text: 'Открытые · 1 ⌄' })).toBeDefined()

  await ui.press({ key: 'check-3' })
  await ui.press({ key: 'selection-clear' })
  expect(await ui.find({ key: 'selection-bar' })).toBeUndefined()
  await ui.unmount()
})
