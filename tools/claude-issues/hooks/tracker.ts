// GitHub / GitLab access through the person's own `gh` or `glab` login.
// Everything goes through the CLI (`gh api`, `glab api`), so the token never
// leaves the CLI and self-hosted hosts work the way the CLI is set up.

import type { Comment, Issue, Provider, Repo } from '../types'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
/** Runs a command by argv; rejects when it cannot start (not installed). */
export type RunInit = { stdin?: string; env?: Record<string, string>; timeoutMs?: number }
export type Run = (argv: readonly string[], init?: RunInit) => Promise<RunResult>

export class TrackerError extends Error {}

/** How many issues are fetched at most (most recently updated first). */
export const MAX_ISSUES = 300
const PAGE = 100

// ---------------------------------------------------------------- remote

export type Remote = { host: string; path: string }

/**
 * Reads a git remote URL: scp form (`git@host:group/repo.git`), ssh://,
 * https:// (with or without a user or port). Answers undefined for a local path.
 */
export function parseRemote(url: string): Remote | undefined {
  const text = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return undefined
    }
    if (parsed.protocol === 'file:') return undefined
    host = parsed.hostname
    path = decodeURIComponent(parsed.pathname)
  } else if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    return undefined
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  if (!host || !path.includes('/')) return undefined
  return { host: host.toLowerCase(), path }
}

/** Picks the remote to use: `origin`, else `upstream`, else the first. */
export function pickRemote(listing: string): string | undefined {
  const urls = new Map<string, string>()
  for (const line of listing.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line)
    if (m && !urls.has(m[1]!)) urls.set(m[1]!, m[2]!)
  }
  return urls.get('origin') ?? urls.get('upstream') ?? urls.values().next().value
}

// ---------------------------------------------------------------- access

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
export type FetchResult = { status: number; ok: boolean; text: string }
/** The host's own fetch (`$.http.fetch`). */
export type Fetch = (url: string, init?: FetchInit) => Promise<FetchResult>
/** What the tracker reaches the outside with. */
export type Io = { run: Run; fetch: Fetch }

const CANDIDATES: Record<Provider, string[]> = {
  github: ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'],
  gitlab: ['glab', '/opt/homebrew/bin/glab', '/usr/local/bin/glab', '/usr/bin/glab'],
}
const CLI_NAME: Record<Provider, string> = { github: 'gh', gitlab: 'glab' }

/**
 * Tokens read from git's credential store, by host. Kept in the module only:
 * never in the panel's state, never written anywhere.
 */
const gitTokens = new Map<string, string>()

/**
 * Finds the CLI's executable. An app started from the Dock often has a short
 * PATH, so the usual Homebrew places are tried too.
 */
export async function findCli(run: Run, provider: Provider): Promise<string | undefined> {
  for (const bin of CANDIDATES[provider]) {
    try {
      const r = await run([bin, '--version'])
      if (r.exitCode === 0) return bin
    } catch {
      // not there: try the next place
    }
  }
  return undefined
}

async function isLoggedIn(run: Run, bin: string, host: string): Promise<boolean> {
  try {
    const r = await run([bin, 'auth', 'status', '--hostname', host])
    return r.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Asks git for the password it keeps for https://<host> (macOS keychain,
 * Git Credential Manager, ...), the one `git push` over https uses.
 * Never prompts: with nothing stored it answers undefined.
 */
export async function gitCredential(run: Run, host: string): Promise<string | undefined> {
  try {
    const r = await run(['git', 'credential', 'fill'], {
      stdin: `protocol=https\nhost=${host}\n\n`,
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' },
      timeoutMs: 15_000,
    })
    if (r.exitCode !== 0) return undefined
    const line = r.stdout.split('\n').find(l => l.startsWith('password='))
    const token = line?.slice('password='.length).trim()
    return token || undefined
  } catch {
    return undefined
  }
}

export function apiBase(provider: Provider, host: string): string {
  if (provider === 'gitlab') return `https://${host}/api/v4`
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
}

function authHeaders(provider: Provider, token: string): Record<string, string> {
  return provider === 'github'
    ? {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    : { Authorization: `Bearer ${token}` }
}

/** For a host of unknown kind: which API answers to the token. */
async function probe(io: Io, host: string, token: string): Promise<Provider | undefined> {
  for (const [provider, endpoint] of [
    ['gitlab', 'version'],
    ['github', 'user'],
  ] as const) {
    try {
      const r = await io.fetch(`${apiBase(provider, host)}/${endpoint}`, {
        headers: authHeaders(provider, token),
      })
      if (r.ok) return provider
    } catch {
      // not this one
    }
  }
  return undefined
}

const loginHint = (provider: Provider, host: string) =>
  `${CLI_NAME[provider]} auth login${host === 'github.com' ? '' : ` --hostname ${host}`}`

/**
 * Decides GitHub or GitLab for a remote host and how to reach it.
 * github.com is GitHub; a host named like gitlab is GitLab; any other host is
 * whichever CLI is signed in to it. Without gh/glab (or signed out there) the
 * login git keeps for the host is used, the one `git push` over https uses.
 */
export async function connect(io: Io, remote: Remote): Promise<Repo> {
  const { host, path } = remote
  const webUrl = `https://${host}/${path}`
  const guess: Provider | undefined =
    host === 'github.com' || host.endsWith('.github.com')
      ? 'github'
      : /(^|[.-])gitlab([.-]|$)/.test(host)
        ? 'gitlab'
        : undefined
  const order: Provider[] = guess ? [guess] : ['github', 'gitlab']
  let fallbackCli: { provider: Provider; bin: string } | undefined
  for (const provider of order) {
    const bin = await findCli(io.run, provider)
    if (!bin) continue
    if (await isLoggedIn(io.run, bin, host)) {
      return { provider, host, path, via: 'cli', bin, webUrl }
    }
    // `auth status` can fail where the API works (behind a proxy, say):
    // keep this CLI for a known host in case git has no login either.
    if (guess) fallbackCli = { provider, bin }
  }

  const token = await gitCredential(io.run, host)
  if (token) {
    const provider = guess ?? (await probe(io, host, token))
    if (provider) {
      gitTokens.set(host, token)
      return { provider, host, path, via: 'git', webUrl }
    }
  }
  if (fallbackCli) return { ...fallbackCli, host, path, via: 'cli', webUrl }

  if (guess) {
    throw new TrackerError(
      `Нет входа в ${host}: не найден ${CLI_NAME[guess]}, и git не хранит пароль для https://${host}. ` +
        `Выполните ${loginHint(guess, host)} или сделайте git pull по https с входом.`,
    )
  }
  throw new TrackerError(
    `Не понял, GitHub это или GitLab: ${host}. Войдите через ` +
      `gh auth login --hostname ${host} или glab auth login --hostname ${host}`,
  )
}

function authError(repo: Repo): TrackerError {
  return repo.via === 'git'
    ? new TrackerError(
        `Сохранённый в git вход не подходит для API ${repo.host} (нужен токен, а не пароль). ` +
          `Выполните ${loginHint(repo.provider, repo.host)}.`,
      )
    : new TrackerError(
        `${CLI_NAME[repo.provider]} не вошёл в ${repo.host}. Выполните в терминале: ${loginHint(repo.provider, repo.host)}`,
      )
}

async function api(
  io: Io,
  repo: Repo,
  endpoint: string,
  method = 'GET',
  fields: Record<string, string> = {},
): Promise<unknown> {
  let out: string
  if (repo.via === 'git') {
    const token = gitTokens.get(repo.host) ?? (await gitCredential(io.run, repo.host))
    if (!token) throw authError(repo)
    gitTokens.set(repo.host, token)
    const hasBody = Object.keys(fields).length > 0
    let r: FetchResult
    try {
      r = await io.fetch(`${apiBase(repo.provider, repo.host)}/${endpoint}`, {
        method,
        headers: {
          ...authHeaders(repo.provider, token),
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(fields) } : {}),
      })
    } catch (err) {
      throw new TrackerError(`Нет связи с ${repo.host}: ${String(err)}`)
    }
    if (r.status === 401) {
      gitTokens.delete(repo.host)
      throw authError(repo)
    }
    if (!r.ok) {
      let why = ''
      try {
        why = String(JSON.parse(r.text)?.message ?? '')
      } catch {
        // not JSON
      }
      throw new TrackerError(`${repo.host}: HTTP ${r.status}${why ? ` ${why}` : ''}`)
    }
    out = r.text.trim()
  } else {
    const cli = CLI_NAME[repo.provider]
    const argv = [repo.bin ?? cli, 'api', '--hostname', repo.host]
    if (method !== 'GET') argv.push('-X', method)
    for (const [k, v] of Object.entries(fields)) argv.push('-f', `${k}=${v}`)
    argv.push(endpoint)
    let r: RunResult
    try {
      r = await io.run(argv)
    } catch (err) {
      throw new TrackerError(`${cli} не запустился: ${String(err)}`)
    }
    if (r.exitCode !== 0) {
      const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')
      if (/401|unauthori[sz]ed|bad credentials|auth login|not logged|no token/i.test(why)) {
        throw authError(repo)
      }
      throw new TrackerError(why || `${cli} api: код ${r.exitCode}`)
    }
    out = r.stdout.trim()
  }
  if (!out) return null
  try {
    return JSON.parse(out)
  } catch {
    throw new TrackerError('Не удалось прочитать ответ API')
  }
}

const gitlabProject = (repo: Repo) => `projects/${encodeURIComponent(repo.path)}`

// ---------------------------------------------------------------- mapping

type Json = Record<string, any>

export function fromGithubIssue(raw: Json): Issue | undefined {
  if (raw.pull_request) return undefined
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    author: String(raw.user?.login ?? ''),
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l: Json | string) => (typeof l === 'string' ? l : String(l?.name ?? '')))
      : [],
    url: String(raw.html_url ?? ''),
    updatedAt: String(raw.updated_at ?? ''),
    comments: Number(raw.comments ?? 0),
    body: String(raw.body ?? ''),
  }
}

export function fromGitlabIssue(raw: Json): Issue {
  return {
    number: Number(raw.iid),
    title: String(raw.title ?? ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    author: String(raw.author?.username ?? ''),
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l: Json | string) => (typeof l === 'string' ? l : String(l?.name ?? '')))
      : [],
    url: String(raw.web_url ?? ''),
    updatedAt: String(raw.updated_at ?? ''),
    comments: Number(raw.user_notes_count ?? 0),
    body: String(raw.description ?? ''),
  }
}

export function fromGithubComment(raw: Json): Comment {
  return {
    author: String(raw.user?.login ?? ''),
    body: String(raw.body ?? ''),
    createdAt: String(raw.created_at ?? ''),
  }
}

export function fromGitlabNote(raw: Json): Comment | undefined {
  if (raw.system) return undefined
  return {
    author: String(raw.author?.username ?? ''),
    body: String(raw.body ?? ''),
    createdAt: String(raw.created_at ?? ''),
  }
}

// ---------------------------------------------------------------- calls

/** Open issues, most recently updated first, PRs/MRs left out. */
export async function listIssues(io: Io, repo: Repo): Promise<Issue[]> {
  const issues: Issue[] = []
  for (let page = 1; issues.length < MAX_ISSUES; page++) {
    const batch =
      repo.provider === 'github'
        ? await api(
            io,
            repo,
            `repos/${repo.path}/issues?state=open&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`,
          )
        : await api(
            io,
            repo,
            `${gitlabProject(repo)}/issues?state=opened&order_by=updated_at&sort=desc&per_page=${PAGE}&page=${page}`,
          )
    if (!Array.isArray(batch)) break
    for (const raw of batch) {
      const issue = repo.provider === 'github' ? fromGithubIssue(raw) : fromGitlabIssue(raw)
      if (issue) issues.push(issue)
    }
    if (batch.length < PAGE) break
  }
  return issues.slice(0, MAX_ISSUES)
}

export async function listComments(io: Io, repo: Repo, number: number): Promise<Comment[]> {
  if (repo.provider === 'github') {
    const raw = await api(io, repo, `repos/${repo.path}/issues/${number}/comments?per_page=100`)
    return Array.isArray(raw) ? raw.map(fromGithubComment) : []
  }
  const raw = await api(
    io,
    repo,
    `${gitlabProject(repo)}/issues/${number}/notes?sort=asc&order_by=created_at&per_page=100`,
  )
  return Array.isArray(raw)
    ? raw.map(fromGitlabNote).filter((c): c is Comment => c !== undefined)
    : []
}

export async function closeIssue(io: Io, repo: Repo, number: number): Promise<void> {
  if (repo.provider === 'github') {
    await api(io, repo, `repos/${repo.path}/issues/${number}`, 'PATCH', {
      state: 'closed',
      state_reason: 'completed',
    })
  } else {
    await api(io, repo, `${gitlabProject(repo)}/issues/${number}`, 'PUT', { state_event: 'close' })
  }
}

// ---------------------------------------------------------------- text

/**
 * Markdown as the panel draws it: HTML comments (hidden markers such as
 * Comenta's `<!-- comenta:id=… -->`) dropped, and the HTML tags the panel's
 * Markdown would print as text (`<sub>`, `<details>`, ...) unwrapped.
 */
export function cleanMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:sub|sup|small|span|div|p|details|summary|b|i|u|em|strong|kbd|ins|del|center|font)\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** What "Вставить в чат" puts in the prompt. */
export function issueAsContext(repo: Repo, issue: Issue): string {
  const kind = repo.provider === 'github' ? 'GitHub' : 'GitLab'
  const body = cleanMarkdown(issue.body)
  const cut = body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body
  return (
    `${kind} issue #${issue.number}: ${issue.title}\n${issue.url}\n` +
    (cut ? `\n${cut}\n` : '') +
    '\n'
  )
}

/** "5 мин назад", "3 д назад" for an ISO time. */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const min = Math.max(0, Math.round((now - t) / 60000))
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч`
  const d = Math.round(h / 24)
  if (d < 31) return `${d} д`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} мес`
  return `${Math.round(mo / 12)} г`
}
