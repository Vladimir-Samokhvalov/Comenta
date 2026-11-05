export type IssuesProvider = 'github' | 'gitlab'
export type Provider = IssuesProvider

/** The repository the panel shows, and the CLI that reaches it. */
export type IssuesRepo = {
  provider: Provider
  host: string
  /** owner/repo, or group/subgroup/project */
  path: string
  /** How the API is reached: the gh/glab CLI, or the login git keeps for the host. */
  via: 'cli' | 'git'
  /** The CLI executable found (`gh`, `/opt/homebrew/bin/glab`, ...), with `via: 'cli'`. */
  bin?: string
  webUrl: string
}
export type Repo = IssuesRepo

export type IssuesIssue = {
  number: number
  title: string
  state: 'open' | 'closed'
  author: string
  labels: string[]
  url: string
  updatedAt: string
  comments: number
  body: string
}
export type Issue = IssuesIssue

export type IssuesComment = { author: string; body: string; createdAt: string }
export type Comment = IssuesComment

/** The list: what was loaded for which folder. */
export type IssuesList = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  cwd?: string
  repo?: Repo
  issues: Issue[]
  error?: string
  loadedAt?: number
}

/** The open issue, when the panel shows one. */
export type IssuesDetail = {
  number: number
  status: 'loading' | 'ready' | 'error'
  comments: Comment[]
  error?: string
  /** Asking "close this issue?" */
  isConfirmingClose: boolean
  isClosing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'issues-panel': {
      list: Shaped<IssuesList>
      detail: Shaped<IssuesDetail | null>
    }
  }
}
