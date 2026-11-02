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
  kind: FeedbackKind;
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
}

export interface FeedbackAuthor {
  id?: string;
  name?: string;
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
}

export type FeedbackPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface FeedbackLabels {
  toggle: string;
  toggleActive: string;
  count: (n: number) => string;
  kinds: Record<FeedbackKind, string>;
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
}

export interface FeedbackOptions {
  /** Transport. Defaults to `consoleAdapter()`. */
  adapter?: FeedbackAdapter;
  /** Toggle button position. Default `bottom-right`. */
  position?: FeedbackPosition;
  author?: FeedbackAuthor;
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
  /** Called after the adapter resolved. */
  onSubmit?: (payload: FeedbackPayload) => void;
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
  /** Remove all DOM and listeners. */
  destroy(): void;
}
