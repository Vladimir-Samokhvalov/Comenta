// GitHub / GitLab access through the person's own `gh` or `glab` login.
// Everything goes through the CLI (`gh api`, `glab api`), so the token never
// leaves the CLI and self-hosted hosts work the way the CLI is set up.

import type { Comment, Issue, Provider, Repo } from '../types'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
/** Runs a command by argv; rejects when it cannot start (not installed). */
export type Run = (argv: readonly string[]) => Promise<RunResult>

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

// ---------------------------------------------------------------- CLI

const CANDIDATES: Record<Provider, string[]> = {
  github: ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'],
  gitlab: ['glab', '/opt/homebrew/bin/glab', '/usr/local/bin/glab', '/usr/bin/glab'],
}
const CLI_NAME: Record<Provider, string> = { github: 'gh', gitlab: 'glab' }

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
 * Decides GitHub or GitLab for a remote host, and checks the CLI is signed
 * in there. github.com is GitHub; a host named like gitlab is GitLab; any
 * other host is whichever CLI is signed in to it.
 */
export async function connect(run: Run, remote: Remote): Promise<Repo> {
  const { host, path } = remote
  const guess: Provider | undefined =
    host === 'github.com' || host.endsWith('.github.com')
      ? 'github'
      : /(^|[.-])gitlab([.-]|$)/.test(host)
        ? 'gitlab'
        : undefined
  const order: Provider[] = guess ? [guess] : ['github', 'gitlab']
  const missing: Provider[] = []
  for (const provider of order) {
    const bin = await findCli(run, provider)
    if (!bin) {
      missing.push(provider)
      continue
    }
    // A known host needs no `auth status` (it can fail where the API works,
    // e.g. behind a proxy): a missing login shows up as the API's 401.
    if (guess || (await isLoggedIn(run, bin, host))) {
      return { provider, host, path, bin, webUrl: `https://${host}/${path}` }
    }
  }
  if (guess && missing.length) {
    throw new TrackerError(
      `Не найден ${CLI_NAME[guess]}. Установите его и выполните ` +
        `${CLI_NAME[guess]} auth login${host === 'github.com' ? '' : ` --hostname ${host}`}`,
    )
  }
  throw new TrackerError(
    `Не понял, GitHub это или GitLab: ${host}. Войдите в него через ` +
      `gh auth login --hostname ${host} или glab auth login --hostname ${host}`,
  )
}

async function api(
  run: Run,
  repo: Repo,
  endpoint: string,
  extra: readonly string[] = [],
): Promise<unknown> {
  const argv = [repo.bin, 'api', '--hostname', repo.host, ...extra, endpoint]
  let r: RunResult
  try {
    r = await run(argv)
  } catch (err) {
    throw new TrackerError(`${CLI_NAME[repo.provider]} не запустился: ${String(err)}`)
  }
  if (r.exitCode !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')
    const cli = CLI_NAME[repo.provider]
    if (/401|unauthori[sz]ed|bad credentials|auth login|not logged|no token/i.test(why)) {
      throw new TrackerError(
        `${cli} не вошёл в ${repo.host}. Выполните в терминале: ${cli} auth login` +
          (repo.host === 'github.com' ? '' : ` --hostname ${repo.host}`),
      )
    }
    throw new TrackerError(why || `${cli} api: код ${r.exitCode}`)
  }
  const out = r.stdout.trim()
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

/** Open and closed issues, most recently updated first, PRs/MRs left out. */
export async function listIssues(run: Run, repo: Repo): Promise<Issue[]> {
  const issues: Issue[] = []
  for (let page = 1; issues.length < MAX_ISSUES; page++) {
    const batch =
      repo.provider === 'github'
        ? await api(
            run,
            repo,
            `repos/${repo.path}/issues?state=all&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`,
          )
        : await api(
            run,
            repo,
            `${gitlabProject(repo)}/issues?state=all&order_by=updated_at&sort=desc&per_page=${PAGE}&page=${page}`,
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

export async function listComments(run: Run, repo: Repo, number: number): Promise<Comment[]> {
  if (repo.provider === 'github') {
    const raw = await api(run, repo, `repos/${repo.path}/issues/${number}/comments?per_page=100`)
    return Array.isArray(raw) ? raw.map(fromGithubComment) : []
  }
  const raw = await api(
    run,
    repo,
    `${gitlabProject(repo)}/issues/${number}/notes?sort=asc&order_by=created_at&per_page=100`,
  )
  return Array.isArray(raw)
    ? raw.map(fromGitlabNote).filter((c): c is Comment => c !== undefined)
    : []
}

export async function closeIssue(run: Run, repo: Repo, number: number): Promise<void> {
  if (repo.provider === 'github') {
    await api(run, repo, `repos/${repo.path}/issues/${number}`, [
      '-X',
      'PATCH',
      '-f',
      'state=closed',
      '-f',
      'state_reason=completed',
    ])
  } else {
    await api(run, repo, `${gitlabProject(repo)}/issues/${number}`, [
      '-X',
      'PUT',
      '-f',
      'state_event=close',
    ])
  }
}

// ---------------------------------------------------------------- text

/** What "Вставить в чат" puts in the prompt. */
export function issueAsContext(repo: Repo, issue: Issue): string {
  const kind = repo.provider === 'github' ? 'GitHub' : 'GitLab'
  const body = issue.body.trim()
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
