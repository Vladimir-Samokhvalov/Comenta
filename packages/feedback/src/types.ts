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
  submit(payload: FeedbackPayload): Promise<void>;
  /** Optional: return previously stored feedback for a page so pins can be restored. */
  list?(pageUrl: string): Promise<FeedbackPayload[]>;
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
  /** Comments known to the widget (sent in this session or loaded via `adapter.list`). */
  getComments(): FeedbackPayload[];
  /** Remove all DOM and listeners. */
  destroy(): void;
}
