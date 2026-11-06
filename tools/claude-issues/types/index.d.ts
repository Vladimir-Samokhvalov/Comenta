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

export type IssuesComment = { id: number; author: string; body: string; createdAt: string }
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
  /** Pictures and files of the description; a picture's `svg` once read. */
  attachments: IssuesAttachment[]
  /** The comment being written, and whether it is being sent. */
  draft: string
  isSending: boolean
  /** Bumped after a send, so the field starts empty. */
  draftKey: number
  /** The login the panel acts as, once known: its comments can be changed. */
  me?: string
  /** The comment being changed, its new text, and whether it is being saved. */
  editingId?: number
  editDraft: string
  isSaving: boolean
  /** Asking "delete this comment?", and whether it is being deleted. */
  confirmDeleteId?: number
  isDeleting: boolean
}

export type IssuesAttachment = {
  kind: 'image' | 'file'
  name: string
  url: string
  status: 'loading' | 'ready' | 'failed'
  /** The picture as an SVG document (bytes inlined), when it could be read. */
  svg?: string
}

declare module 'claude-code' {
  interface PluginState {
    'issues-panel': {
      list: Shaped<IssuesList>
      detail: Shaped<IssuesDetail | null>
      /** Whether the Issues pane is up; the row above the prompt shows while it is not. */
      isPaneOpen: boolean
    }
  }
}
