import type { FeedbackAttachment, FeedbackAuthor, FeedbackLabels, FeedbackPayload, FeedbackReply, FeedbackStatus } from '../types';
import type { Recording } from '../core/recorder';
import { sameAuthor } from '../core/identity';
import { checkIcon, closeIcon, h, pencilIcon, reopenIcon, trashIcon } from './h';
import { attachmentsView, type RecordConfig } from './record';
import { Composer } from './composer';

export interface ThreadModel {
  payload: FeedbackPayload;
  /** Pin number on this page. */
  n: number;
  me: FeedbackAuthor;
  canResolve: boolean;
  canReply: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Ask a guest for their name in the reply field. */
  askName: boolean;
  /** Replies by others after this time are marked as new. */
  unreadSince: string | null;
}

export interface ThreadHandlers {
  reply(text: string, recording: Recording | null, resolve: boolean, name: string): Promise<void>;
  setStatus(status: FeedbackStatus): Promise<void>;
  edit(replyId: string, text: string): Promise<void>;
  remove(replyId: string): Promise<void>;
  close(): void;
}

export interface ThreadEnv {
  labels: FeedbackLabels;
  record: RecordConfig | null;
  dockHost: HTMLElement | null;
  onDock: (docked: boolean) => void;
  reposition: () => void;
}

/** Colours for other people's names, picked by a hash of their id. */
const NAME_COLORS = 7;

/**
 * A comment with its replies: Telegram-style bubbles (mine on the right), status in the header,
 * a reply field at the bottom. `update()` re-renders the header and the feed and keeps the draft.
 */
export class Thread {
  readonly nodes: HTMLElement[];
  readonly composer: Composer | null;
  private readonly head: HTMLDivElement;
  private readonly feed: HTMLDivElement;
  private readonly actions: HTMLDivElement | null;
  private readonly replyBtn: HTMLButtonElement | null = null;
  private readonly resolveReplyBtn: HTMLButtonElement | null = null;
  private model: ThreadModel;
  /** Reply being edited, and its draft text. */
  private editing: { id: string; draft: string } | null = null;
  private confirmDelete: string | null = null;
  private pending = false;
  private disposed = false;

  constructor(private readonly doc: Document, private readonly env: ThreadEnv, model: ThreadModel, private readonly handlers: ThreadHandlers) {
    const d = doc;
    const L = env.labels;
    this.model = model;
    this.head = h(d, 'div', { class: 'ph-thread-head' });
    this.feed = h(d, 'div', { class: 'ph-feed', role: 'log', 'aria-label': L.thread, 'aria-live': 'polite', tabindex: 0 });

    if (model.canReply) {
      this.composer = new Composer(d, {
        labels: L,
        record: env.record,
        placeholder: L.replyPlaceholder,
        ariaLabel: L.replyTextarea,
        askName: model.askName,
        dockHost: env.dockHost,
        onDock: env.onDock,
        onChange: () => this.syncButtons(),
        reposition: env.reposition,
        compact: true,
      });
      this.replyBtn = h(d, 'button', { type: 'button', class: 'ph-btn ph-btn-primary ph-reply-btn', disabled: true, title: isMac(d) ? '⌘↵' : 'Ctrl+↵' }, [L.reply]);
      this.replyBtn.addEventListener('click', () => void this.send(false));
      this.resolveReplyBtn = h(d, 'button', { type: 'button', class: 'ph-btn ph-btn-resolve', disabled: true }, [checkIcon(d), L.replyAndResolve]);
      this.resolveReplyBtn.addEventListener('click', () => void this.send(true));
      this.actions = h(d, 'div', { class: 'ph-actions' }, [this.resolveReplyBtn, this.replyBtn]);
      this.nodes = [this.head, this.feed, h(d, 'div', { class: 'ph-reply' }, [...this.composer.nodes, this.actions])];
    } else {
      this.composer = null;
      this.actions = null;
      this.nodes = [this.head, this.feed];
    }
    this.render(true);
  }

  get viewing() {
    return this.model.payload.id;
  }

  update(model: ThreadModel) {
    const atBottom = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 24;
    this.model = model;
    if (this.editing && !model.payload.replies?.some((r) => r.id === this.editing!.id)) this.editing = null;
    this.render(atBottom);
  }

  /** Esc: leave reply editing / delete confirmation first. */
  handleEscape(): boolean {
    if (this.editing || this.confirmDelete) {
      const id = this.editing?.id ?? this.confirmDelete;
      this.editing = null;
      this.confirmDelete = null;
      this.render(false);
      this.feed.querySelector<HTMLElement>(`[data-id="${cssEscape(id ?? '')}"] .ph-msg-edit`)?.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  /** ⌘↵ inside the thread. */
  submitShortcut(target: EventTarget | null) {
    if (target instanceof HTMLTextAreaElement && target.classList.contains('ph-edit-text')) void this.saveEdit();
    else if (this.composer && target === this.composer.textarea) void this.send(false);
  }

  focus() {
    if (this.composer) this.composer.focus();
    else this.head.querySelector<HTMLElement>('.ph-thread-close')?.focus({ preventScroll: true });
  }

  dispose() {
    this.disposed = true;
    this.composer?.dispose();
  }

  // ---------------------------------------------------------------- actions

  private async send(resolve: boolean) {
    const c = this.composer;
    if (!c || !c.ready || this.pending) return;
    c.setError(null);
    c.setBusy(true);
    try {
      await this.handlers.reply(c.text, c.recording, resolve, c.name);
      if (this.disposed) return;
      c.clear();
      if (c.nameInput && c.name) c.nameInput.hidden = true;
      this.feed.scrollTop = this.feed.scrollHeight;
    } catch (err) {
      if (!this.disposed) c.setError(errorText(this.env.labels.replyError, err));
    } finally {
      if (!this.disposed) c.setBusy(false);
    }
  }

  private async toggleStatus() {
    if (this.pending) return;
    const next: FeedbackStatus = this.model.payload.status === 'resolved' ? 'open' : 'resolved';
    this.pending = true;
    this.syncButtons();
    try {
      await this.handlers.setStatus(next);
    } catch (err) {
      this.flash(errorText(this.env.labels.replyError, err));
    } finally {
      this.pending = false;
      if (!this.disposed) {
        this.syncButtons();
        this.head.querySelector<HTMLElement>('.ph-resolve')?.focus({ preventScroll: true });
      }
    }
  }

  private async saveEdit() {
    const ed = this.editing;
    if (!ed || this.pending) return;
    const text = ed.draft.trim();
    const reply = this.model.payload.replies?.find((r) => r.id === ed.id);
    if (!text && !reply?.attachments?.length) return;
    if (reply && text === reply.text) {
      this.handleEscape();
      return;
    }
    this.pending = true;
    try {
      await this.handlers.edit(ed.id, text);
      this.editing = null;
    } catch (err) {
      this.flash(errorText(this.env.labels.replyError, err));
    } finally {
      this.pending = false;
      if (!this.disposed) {
        this.render(false);
        this.feed.querySelector<HTMLElement>(`[data-id="${cssEscape(ed.id)}"] .ph-msg-edit`)?.focus({ preventScroll: true });
      }
    }
  }

  private async remove(id: string) {
    if (this.pending) return;
    this.pending = true;
    try {
      await this.handlers.remove(id);
      this.confirmDelete = null;
    } catch (err) {
      this.flash(errorText(this.env.labels.replyError, err));
    } finally {
      this.pending = false;
      if (!this.disposed) {
        this.render(false);
        this.focus();
      }
    }
  }

  private flash(message: string) {
    if (this.composer) this.composer.setError(message);
    else this.head.setAttribute('title', message);
  }

  private syncButtons() {
    const c = this.composer;
    const open = this.model.payload.status !== 'resolved';
    if (this.replyBtn && c) this.replyBtn.disabled = !c.ready || this.pending;
    if (this.resolveReplyBtn && c) {
      this.resolveReplyBtn.hidden = !(this.model.canResolve && open);
      this.resolveReplyBtn.disabled = !c.ready || this.pending;
    }
    const rb = this.head.querySelector<HTMLButtonElement>('.ph-resolve');
    if (rb) rb.disabled = this.pending;
    if (this.replyBtn) this.replyBtn.textContent = c?.busy ? this.env.labels.submitting : this.env.labels.reply;
  }

  // ---------------------------------------------------------------- rendering

  private render(scrollToEnd: boolean) {
    const d = this.doc;
    const L = this.env.labels;
    const m = this.model;
    const p = m.payload;
    const resolved = p.status === 'resolved';

    // header: #n · category, status, resolve / reopen, close
    const badge = p.kind ? `#${m.n} · ${L.kindEmoji[p.kind]} ${L.kinds[p.kind]}` : `#${m.n}`;
    // closed on GitHub as "not planned" / duplicate: the same "Закрыт", in grey
    const closedOther = resolved && !!p.issue?.stateReason && p.issue.stateReason !== 'completed' && p.issue.state === 'closed';
    const statusTitle = resolved && p.issue?.state === 'closed' ? `GitHub: ${L.issueStateLong(p.issue)}` : null;
    const headKids: Node[] = [
      h(d, 'span', { class: 'ph-badge' }, [badge]),
      h(d, 'span', { class: 'ph-status', 'data-status': resolved ? (closedOther ? 'closed-other' : 'resolved') : 'open', title: statusTitle }, [resolved ? L.statusResolved : L.statusOpen]),
    ];
    if (p.issue && /^https?:\/\//.test(p.issue.url)) {
      const i = p.issue;
      headKids.push(h(d, 'a', { class: 'ph-issue', href: i.url, target: '_blank', rel: 'noopener noreferrer', title: `${i.repo}#${i.number}` }, [L.issueLink(i)]));
      // the issue can't be reached any more: the status above lives in Comenta only
      if (i.unavailable) headKids.push(h(d, 'span', { class: 'ph-issue-state', 'data-state': 'unavailable', title: `${i.repo}#${i.number}` }, [L.issueUnavailable]));
    }
    headKids.push(h(d, 'span', { class: 'ph-spacer' }));
    if (m.canResolve) {
      const label = resolved ? L.reopen : L.resolve;
      const b = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-resolve', 'data-status': resolved ? 'resolved' : 'open', 'aria-label': label, title: label }, [resolved ? reopenIcon(d) : checkIcon(d)]);
      b.addEventListener('click', () => void this.toggleStatus());
      headKids.push(b);
    }
    const close = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-thread-close', 'aria-label': L.close, title: L.close }, [closeIcon(d)]);
    close.addEventListener('click', () => this.handlers.close());
    headKids.push(close);
    this.head.replaceChildren(...headKids);

    // feed: the comment, replies, and the "resolved" line where it happened
    const items: Node[] = [this.message(p, null)];
    let eventShown = false;
    const event = () => {
      eventShown = true;
      let text = !p.resolvedBy ? L.statusResolved : sameAuthor(p.resolvedBy, m.me) ? L.resolvedByYou : L.resolvedBy(displayName(p.resolvedBy, L));
      if (p.resolvedVia === 'github') text = L.closedOnGitHub(p.resolvedBy?.name, p.issue?.stateReason ?? null);
      return h(d, 'div', { class: 'ph-event', role: 'note' }, [checkIcon(d), `${text}${p.resolvedAt ? ` · ${formatTime(p.resolvedAt, L.locale)}` : ''}`]);
    };
    for (const r of p.replies ?? []) {
      if (resolved && !eventShown && p.resolvedAt && r.createdAt > p.resolvedAt) items.push(event());
      items.push(this.message(r, r));
    }
    if (resolved && !eventShown) items.push(event());
    this.feed.replaceChildren(...items);
    if (scrollToEnd) this.feed.scrollTop = this.feed.scrollHeight;
    this.syncButtons();
    this.env.reposition();
  }

  /** One bubble. `reply` is null for the comment itself. */
  private message(item: { text: string; createdAt: string; author?: FeedbackAuthor; attachments?: FeedbackAttachment[]; updatedAt?: string }, reply: FeedbackReply | null): HTMLElement {
    const d = this.doc;
    const L = this.env.labels;
    const m = this.model;
    const mine = sameAuthor(item.author, m.me);
    const isNew = !!reply && !mine && !!m.unreadSince && reply.createdAt > m.unreadSince;
    const wrap = h(d, 'div', { class: `ph-msg${mine ? ' ph-mine' : ''}${isNew ? ' ph-msg-new' : ''}`, 'data-id': reply?.id ?? null, 'data-root': reply ? null : '' });

    if (reply && this.editing?.id === reply.id) {
      wrap.append(this.editor(reply));
      return wrap;
    }

    const bubble = h(d, 'div', { class: 'ph-bubble' });
    const external = reply?.origin === 'github';
    if (external) {
      wrap.classList.add('ph-msg-github');
      const a = item.author;
      const avatar = a?.avatarUrl && /^(https?:\/\/|\/)/.test(a.avatarUrl) ? h(d, 'img', { class: 'ph-avatar', src: a.avatarUrl, alt: '', width: 16, height: 16, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null;
      const name = a?.url && /^https?:\/\//.test(a.url) ? h(d, 'a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, [displayName(a, L)]) : displayName(a, L);
      const source = reply?.link?.url && /^https?:\/\//.test(reply.link.url) ? h(d, 'a', { class: 'ph-msg-source', href: reply.link.url, target: '_blank', rel: 'noopener noreferrer' }, [L.fromGitHub]) : h(d, 'span', { class: 'ph-msg-source' }, [L.fromGitHub]);
      bubble.append(h(d, 'div', { class: 'ph-msg-name', 'data-color': colorIndex(a) }, [avatar, name, source]));
    } else if (!mine) bubble.append(h(d, 'div', { class: 'ph-msg-name', 'data-color': colorIndex(item.author) }, [displayName(item.author, L)]));
    if (item.text) bubble.append(h(d, 'div', { class: reply ? 'ph-msg-text' : 'ph-msg-text ph-view-text' }, [item.text]));
    if (item.attachments?.length) bubble.append(attachmentsView(d, item.attachments, L));
    bubble.append(
      h(d, 'div', { class: 'ph-msg-foot' }, [
        item.updatedAt ? h(d, 'span', { class: 'ph-msg-edited' }, [L.edited]) : null,
        h(d, 'time', { dateTime: item.createdAt, title: fullTime(item.createdAt, L.locale) }, [formatTime(item.createdAt, L.locale)]),
      ]),
    );
    wrap.append(bubble);

    if (reply && mine && !external && (m.canEdit || m.canDelete)) {
      const tools = h(d, 'div', { class: 'ph-msg-tools' });
      if (m.canEdit && reply.text) {
        const e = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-msg-edit', 'aria-label': L.edit, title: L.edit }, [pencilIcon(d)]);
        e.addEventListener('click', () => {
          this.editing = { id: reply.id, draft: reply.text };
          this.confirmDelete = null;
          this.render(false);
          const ta = this.feed.querySelector<HTMLTextAreaElement>('.ph-edit-text');
          ta?.focus({ preventScroll: true });
          ta?.setSelectionRange(ta.value.length, ta.value.length);
        });
        tools.append(e);
      }
      if (m.canDelete) {
        const del = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-msg-delete', 'aria-label': L.deleteReply, title: L.deleteReply }, [trashIcon(d)]);
        del.addEventListener('click', () => {
          this.confirmDelete = reply.id;
          this.editing = null;
          this.render(false);
          this.feed.querySelector<HTMLElement>('.ph-confirm .ph-btn-danger')?.focus({ preventScroll: true });
        });
        tools.append(del);
      }
      wrap.append(tools);
    }

    if (reply && this.confirmDelete === reply.id) {
      const yes = h(d, 'button', { type: 'button', class: 'ph-btn ph-btn-danger' }, [L.deleteReply]);
      yes.addEventListener('click', () => void this.remove(reply.id));
      const no = h(d, 'button', { type: 'button', class: 'ph-btn' }, [L.cancel]);
      no.addEventListener('click', () => this.handleEscape());
      wrap.append(h(d, 'div', { class: 'ph-confirm', role: 'group', 'aria-label': L.deleteConfirm }, [h(d, 'span', {}, [L.deleteConfirm]), no, yes]));
    }
    return wrap;
  }

  private editor(reply: FeedbackReply): HTMLElement {
    const d = this.doc;
    const L = this.env.labels;
    const ta = h(d, 'textarea', { class: 'ph-textarea ph-edit-text', rows: 2, 'aria-label': L.edit });
    ta.value = this.editing?.draft ?? reply.text;
    ta.addEventListener('input', () => {
      if (this.editing) this.editing.draft = ta.value;
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`;
    });
    const save = h(d, 'button', { type: 'button', class: 'ph-btn ph-btn-primary ph-edit-save' }, [L.save]);
    save.addEventListener('click', () => void this.saveEdit());
    const cancel = h(d, 'button', { type: 'button', class: 'ph-btn ph-edit-cancel' }, [L.cancel]);
    cancel.addEventListener('click', () => this.handleEscape());
    return h(d, 'div', { class: 'ph-editor' }, [ta, h(d, 'div', { class: 'ph-actions' }, [cancel, save])]);
  }
}

export function displayName(a: FeedbackAuthor | undefined, labels: FeedbackLabels): string {
  return a?.name?.trim() || labels.guest;
}

function colorIndex(a: FeedbackAuthor | undefined): string {
  const key = a?.id ?? a?.name ?? '';
  let hsh = 0;
  for (let i = 0; i < key.length; i++) hsh = (hsh * 31 + key.charCodeAt(i)) | 0;
  return String(Math.abs(hsh) % NAME_COLORS);
}

/** Telegram-like: time today, "3 нояб., 14:05" otherwise. */
export function formatTime(iso: string, locale: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  try {
    const time = t.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    if (t.toDateString() === now.toDateString()) return time;
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
    if (t.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return `${t.toLocaleDateString(locale, opts)}, ${time}`;
  } catch {
    return t.toLocaleString();
  }
}

function fullTime(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale);
  } catch {
    return iso;
  }
}

function errorText(prefix: string, err: unknown): string {
  const msg = err instanceof Error && err.message ? err.message : String(err ?? '');
  return msg ? `${prefix}: ${msg}` : prefix;
}

function isMac(d: Document) {
  return /Mac|iPhone|iPad/.test(d.defaultView?.navigator.platform ?? '');
}

function cssEscape(s: string) {
  return s.replace(/["\\]/g, '\\$&');
}
