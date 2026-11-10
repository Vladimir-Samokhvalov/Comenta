export type FeedbackKind = 'question' | 'suggestion' | 'bug';

export interface FeedbackRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FeedbackPayload {
  /** uuid, generated on the client */
  id: string;
  /** Optional category; absent when the author did not pick one. */
  kind?: FeedbackKind;
  text: string;
  /** ISO 8601 */
  createdAt: string;
  page: {
    url: string;
    title: string;
    viewport: { w: number; h: number };
    userAgent: string;
  };
  target: {
    /** Stable CSS selector that matches exactly one element at submit time. */
    selector: string;
    tag: string;
    /** Up to 120 chars of visible text (never form values). */
    textSnippet: string;
    /** Relative to the document (not the viewport). */
    rect: FeedbackRect;
    /** id, class, data-*, aria-label, role, href (+ type, name, alt). Never input values. */
    attributes: Record<string, string>;
  };
  author?: FeedbackAuthor;
  /** Voice or screen recordings. Files travel next to the payload (see `FeedbackAdapter.submit`). */
  attachments?: FeedbackAttachment[];
  /** Thread status. Absent means `open`. */
  status?: FeedbackStatus;
  /** Who resolved the thread and when (set together with `status: 'resolved'`). */
  resolvedBy?: FeedbackAuthor;
  resolvedAt?: string;
  /** `github` / `gitlab`: the thread was closed by closing its issue on the tracker (`resolvedBy` is the tracker user, if known). */
  resolvedVia?: 'github' | 'gitlab' | (string & {});
  /** Replies, oldest first. Returned by `list()` / `listAll()`; not sent with `submit`. */
  replies?: FeedbackReply[];
  /** Issue created from this comment in a tracker (set by the backend, e.g. the GitHub or GitLab integration). */
  issue?: FeedbackIssueLink;
}

/** Link to the issue a comment became. The widget shows it in the thread header. */
export interface FeedbackIssueLink {
  provider: 'github' | 'gitlab' | (string & {});
  /** `owner/name` on GitHub, the project path (`group/subgroup/project`) on GitLab. */
  repo: string;
  /** Issue number (GitLab: the issue's `iid` in its project). */
  number: number;
  url: string;
  /** GitHub node id of the issue; GitLab: the issue's global id. */
  nodeId?: string;
  /** Stable id of the repository / project (GitLab project id: survives renames). */
  repoId?: number | string;
  /** Projects v2 node id the issue was added to. */
  projectId?: string;
  /**
   * Issue state on the tracker, kept up to date by the backend's sync. Absent: not synced yet.
   * Backends should send it (and replies with `origin`) only to the site owner and the comment's author (see `forViewer`).
   */
  state?: 'open' | 'closed';
  /** Why it was closed: GitHub's `state_reason` (`completed`, `not_planned`, `duplicate`…); GitLab: null. */
  stateReason?: string | null;
  /** ISO 8601, when `state` is `closed`. */
  closedAt?: string;
  /** `updated_at` of the issue snapshot the state comes from (sync bookkeeping). */
  stateAt?: string;
  /** The issue can no longer be read: deleted, transferred to a repository the app can't see, or access lost. */
  unavailable?: 'deleted' | 'transferred' | 'no_access';
}

/** The copy of a reply in a tracker (a GitHub issue comment, a GitLab note). */
export interface FeedbackReplyLink {
  provider: 'github' | 'gitlab' | (string & {});
  id: number | string;
  url: string;
}

export type FeedbackStatus = 'open' | 'resolved';

/** A reply in a comment thread. */
export interface FeedbackReply {
  /** uuid, generated on the client */
  id: string;
  /** id of the comment this reply belongs to */
  commentId: string;
  text: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601; set when the author edited the text. */
  updatedAt?: string;
  author?: FeedbackAuthor;
  attachments?: FeedbackAttachment[];
  /**
   * Where the reply was written. `github` / `gitlab`: a comment on the linked issue, imported by the backend
   * (read-only in the widget, shown with the tracker name and avatar). Absent: written in Comenta.
   */
  origin?: 'github' | 'gitlab' | (string & {});
  /** The tracker comment: the original for imported replies, the copy for Comenta replies the backend posted. */
  link?: FeedbackReplyLink;
}

/** A status change sent to `adapter.setStatus`. */
export interface FeedbackStatusChange {
  status: FeedbackStatus;
  by: FeedbackAuthor;
  /** ISO 8601 */
  at: string;
}

export type FeedbackAttachmentKind = 'audio' | 'screen';

export interface FeedbackAttachment {
  id: string;
  /** `audio` — voice message; `screen` — screen recording with microphone audio. */
  kind: FeedbackAttachmentKind;
  /** File name, e.g. `voice-<id>.webm`. */
  name: string;
  mimeType: string;
  /** Bytes. */
  size: number;
  durationMs: number;
  /**
   * Where the recording can be played back: a server URL (set from the adapter's result),
   * a `data:` URL (consoleAdapter) or absent if it was not stored.
   */
  url?: string;
}

/** A recorded file handed to the adapter together with its metadata from `payload.attachments`. */
export interface FeedbackFile {
  attachment: FeedbackAttachment;
  blob: Blob;
}

/** Optional result of `submit`: lets the backend tell the widget where files are stored. */
export interface FeedbackSubmitResult {
  /** attachment id → playback URL */
  attachmentUrls?: Record<string, string>;
  /** Issue the backend created for the comment (shown in the thread right away). */
  issue?: FeedbackIssueLink;
}

export interface FeedbackAuthor {
  id?: string;
  name?: string;
  /**
   * `owner` may resolve and reopen any thread; everyone else only their own.
   * The widget only hides buttons; your server must enforce the same rule.
   */
  role?: 'owner' | 'member';
  /** Avatar image URL (set for authors of replies imported from GitHub). */
  avatarUrl?: string;
  /** Profile page (GitHub profile for imported replies). */
  url?: string;
}

/**
 * Transport for feedback. Implement this to send feedback to your backend,
 * an issue tracker (YouTrack, GitLab, ...) or anywhere else.
 */
export interface FeedbackAdapter {
  /**
   * Send the payload. `files` holds the recordings described in `payload.attachments`
   * (empty when there are none). Reject to show an error in the form.
   */
  submit(payload: FeedbackPayload, files?: FeedbackFile[]): Promise<void | FeedbackSubmitResult>;
  /** Optional: return previously stored feedback for a page so pins can be restored. */
  list?(pageUrl: string): Promise<FeedbackPayload[]>;
  /** Optional: all feedback of the current user across pages (the "All" tab of the comments panel). */
  listAll?(): Promise<FeedbackPayload[]>;
  /**
   * Optional: add a reply to a thread. Without it the thread is read-only.
   * `files` holds the recordings described in `reply.attachments`.
   */
  reply?(commentId: string, reply: FeedbackReply, files?: FeedbackFile[]): Promise<void | FeedbackSubmitResult>;
  /** Optional: edit the text of a reply (only its author is offered this). */
  updateReply?(commentId: string, replyId: string, patch: { text: string; updatedAt: string }): Promise<void>;
  /** Optional: delete a reply (only its author is offered this). */
  deleteReply?(commentId: string, replyId: string): Promise<void>;
  /** Optional: resolve or reopen a thread. */
  setStatus?(commentId: string, change: FeedbackStatusChange): Promise<void>;
  /**
   * Optional: push updates (WebSocket, storage events…). Call `onChange` when comments
   * may have changed; the widget then re-reads `list()`. Return an unsubscribe function.
   */
  subscribe?(onChange: () => void): () => void;
}

export type FeedbackPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface FeedbackLabels {
  toggle: string;
  toggleActive: string;
  count: (n: number) => string;
  kinds: Record<FeedbackKind, string>;
  kindEmoji: Record<FeedbackKind, string>;
  kindGroup: string;
  textarea: string;
  placeholder: string;
  submit: string;
  submitting: string;
  cancel: string;
  close: string;
  sent: string;
  errorPrefix: string;
  dialog: string;
  pin: (n: number) => string;
  /** BCP 47 locale for relative dates. */
  locale: string;
  menu: string;
  showAll: string;
  hidePins: string;
  showPins: string;
  panelTitle: string;
  tabPage: string;
  tabAll: string;
  empty: string;
  notFound: string;
  recVoice: string;
  recScreen: string;
  recHint: string;
  recStop: string;
  recCancel: string;
  recRedo: string;
  recDelete: string;
  recVoiceLabel: string;
  recScreenLabel: string;
  recNoMic: string;
  recDenied: string;
  recFailed: string;
  recMissing: string;
  recLimit: string;
  statusOpen: string;
  statusResolved: string;
  resolve: string;
  reopen: string;
  reply: string;
  replyPlaceholder: string;
  /** @deprecated No longer shown: a thread is closed with the ✓ button in its header. */
  replyAndResolve: string;
  replyTextarea: string;
  thread: string;
  /** Header button that turns the thread into a side panel with the comment list. */
  expand: string;
  /** The same button in the side panel: back to the pin. */
  collapse: string;
  /** Day separators in a thread. */
  today: string;
  yesterday: string;
  edited: string;
  edit: string;
  save: string;
  deleteReply: string;
  deleteConfirm: string;
  replyError: string;
  resolvedBy: (name: string) => string;
  resolvedByYou: string;
  guest: string;
  yourName: string;
  filterOpen: string;
  filterResolved: string;
  filterAll: string;
  showResolved: string;
  hideResolved: string;
  unread: (n: number) => string;
  replies: (n: number) => string;
  /** Thread header link to the tracker issue, e.g. `GitHub #12`, `GitLab #7`. */
  issueLink: (issue: FeedbackIssueLink) => string;
  /** Issue state next to the link in the thread header: `открыт` / `закрыт`. */
  issueState: (issue: FeedbackIssueLink) => string;
  /** Issue state with the close reason (tooltip, comments list): `закрыт · выполнен`. */
  issueStateLong: (issue: FeedbackIssueLink) => string;
  /** The linked issue was deleted, transferred or access to it was lost. */
  issueUnavailable: string;
  /** Name of a tracker: `GitHub`, `GitLab`. */
  providerName: (provider: string) => string;
  /** Event line when the issue was closed on the tracker: `octo закрыл(а) на GitHub · не будет сделан`. */
  closedOnTracker: (provider: string, name: string | undefined, reason: string | null) => string;
  /** Mark on replies written on the tracker: `из GitHub`, `из GitLab`. */
  fromTracker: (provider: string) => string;
  /** Sign-in card (with the `auth` option). */
  signInTitle: string;
  signInWith: (provider: string) => string;
  signInFailed: string;
  signInPopupBlocked: string;
  signOut: string;
}

/**
 * Visitors sign in through your server before they can comment (Google, Yandex, Keycloak…).
 * The widget reads `GET {endpoint}/me` → `{ user, providers }`, opens `{endpoint}/login/<provider>` in a popup
 * and signs out with `POST {endpoint}/logout`. See demo/auth.mjs and `@comenta/feedback/auth`.
 */
export interface FeedbackAuthOptions {
  /** Base URL of the sign-in routes on this site, e.g. `/api/auth`. Same origin as the page. */
  endpoint: string;
  /** Open the provider in a popup (default true); false navigates the page. */
  popup?: boolean;
}

export interface FeedbackOptions {
  /** Transport. Defaults to `consoleAdapter()`. */
  adapter?: FeedbackAdapter;
  /** Toggle button position. Default `bottom-right`. */
  position?: FeedbackPosition;
  author?: FeedbackAuthor;
  /**
   * Require sign-in: the author (and the owner role) then comes from your server's session, the widget asks
   * visitors who are not signed in to sign in, and `author` is ignored.
   */
  auth?: FeedbackAuthOptions;
  /** When false the widget renders nothing. Default true. */
  enabled?: boolean;
  /**
   * Elements matching this selector (and their descendants) can not be picked
   * and their content never ends up in a payload. Default `[data-feedback-ignore]`.
   */
  ignoreSelector?: string;
  /**
   * Voice / screen recording in the comment form. Default: enabled where the browser supports it.
   * `false` hides the record button.
   */
  recording?: false | { audio?: boolean; screen?: boolean; maxDurationMs?: number };
  /** Keyboard shortcut that toggles comment mode (ignored while typing). `false` disables it. Default `'c'`. */
  hotkey?: string | false;
  /** Base z-index for the widget layer. Default 2147483000. */
  zIndex?: number;
  /** UI strings. Russian by default. */
  labels?: Partial<FeedbackLabels>;
  /**
   * How often to re-read `list()` for new replies while the tab is visible, in ms.
   * Default 30000; `false` turns polling off (e.g. when the adapter has `subscribe`).
   */
  pollIntervalMs?: number | false;
  /** Called after the adapter resolved. */
  onSubmit?: (payload: FeedbackPayload) => void;
  /** Called after a reply was stored. */
  onReply?: (reply: FeedbackReply, comment: FeedbackPayload) => void;
  /** Called after a thread was resolved or reopened. */
  onStatusChange?: (comment: FeedbackPayload, change: FeedbackStatusChange) => void;
  /** Called when the adapter rejected. */
  onError?: (error: unknown, payload: FeedbackPayload) => void;
}

export interface FeedbackInstance {
  /** Enter comment mode. */
  open(): void;
  /** Leave comment mode. */
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Update options that do not require re-mounting (adapter, author, labels, callbacks). */
  update(options: Partial<FeedbackOptions>): void;
  /** Open the "My comments" panel. */
  showComments(): void;
  /** Comments known to the widget (sent in this session or loaded via `adapter.list`). */
  getComments(): FeedbackPayload[];
  /** Open a comment thread by id (scrolls to its element). Returns false if it is not on this page. */
  openThread(id: string): boolean;
  /** Number of threads with replies the current user has not seen. */
  getUnreadCount(): number;
  /** With the `auth` option: re-read who is signed in (call after your site signed the visitor in or out). Resolves true when signed in. */
  refreshSignIn(): Promise<boolean>;
  /** Remove all DOM and listeners. */
  destroy(): void;
}
