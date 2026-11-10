import type { FeedbackAttachment, FeedbackAuthor, FeedbackLabels, FeedbackPayload, FeedbackReply, FeedbackStatus } from '../types';
import type { Recording } from '../core/recorder';
import { sameAuthor } from '../core/identity';
import { checkIcon, circleCheckIcon, closeIcon, collapseIcon, crumbIcon, expandIcon, globeIcon, h, pencilIcon, sendIcon, trashIcon, waveLine } from './h';
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
  /** Shown as a side panel with the comment list (the header button switches). */
  expanded: boolean;
  /** Header expand / collapse button; none when omitted. */
  onExpand?: () => void;
}

/** Colours for other people's names, picked by a hash of their id. */
const NAME_COLORS = 7;

/**
 * A comment with its replies, laid out like a chat thread: a breadcrumb header with icon actions
 * (status is the ✓ icon), other people's messages as plain text under their name, mine in a bubble
 * on the right, day separators, the linked issue above a one-line reply field.
 * `update()` re-renders the header and the feed and keeps the draft.
 */
export class Thread {
  readonly nodes: HTMLElement[];
  readonly composer: Composer | null;
  private readonly head: HTMLDivElement;
  private readonly feed: HTMLDivElement;
  /** The linked issue, above the reply field. */
  private readonly issueBar: HTMLDivElement;
  /** Issue bar + reply field; hidden when it has neither. */
  private readonly replyBox: HTMLDivElement;
  private readonly replyBtn: HTMLButtonElement | null = null;
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
    this.issueBar = h(d, 'div', { class: 'ph-issue-bar', hidden: true });

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
      // the send button sits inside the field, after the record button
      this.replyBtn = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-reply-btn', disabled: true, 'aria-label': L.reply, title: `${L.reply} (${isMac(d) ? '⌘↵' : 'Ctrl+↵'})` }, [sendIcon(d)]);
      this.replyBtn.addEventListener('click', () => void this.send(false));
      this.composer.field.append(this.replyBtn);
      this.replyBox = h(d, 'div', { class: 'ph-reply' }, [this.issueBar, ...this.composer.nodes]);
    } else {
      this.composer = null;
      this.replyBox = h(d, 'div', { class: 'ph-reply' }, [this.issueBar]);
    }
    this.nodes = [this.head, this.feed, this.replyBox];
    this.render(true);
  }

  get viewing() {
    return this.model.payload.id;
  }

  /** Popover switched between the pin and the side panel: swap the header button. */
  setExpanded(on: boolean) {
    this.env.expanded = on;
    this.render(false);
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
    if (this.replyBtn && c) {
      this.replyBtn.disabled = !c.ready || this.pending;
      this.replyBtn.setAttribute('aria-busy', String(c.busy));
    }
    const rb = this.head.querySelector<HTMLButtonElement>('.ph-resolve');
    if (rb) rb.disabled = this.pending;
  }

  // ---------------------------------------------------------------- rendering

  private render(scrollToEnd: boolean) {
    const d = this.doc;
    const L = this.env.labels;
    const m = this.model;
    const p = m.payload;
    const resolved = p.status === 'resolved';

    // header: "Comments › first line", status as an icon, then actions
    // closed on GitHub as "not planned" / duplicate: the same "Закрыт", in grey
    const closedOther = resolved && !!p.issue?.stateReason && p.issue.stateReason !== 'completed' && p.issue.state === 'closed';
    const statusTitle = resolved && p.issue?.state === 'closed' ? `${L.providerName(p.issue.provider)}: ${L.issueStateLong(p.issue)}` : null;
    const status = resolved ? (closedOther ? 'closed-other' : 'resolved') : 'open';
    const title = firstLine(p.text) || (p.attachments?.[0]?.kind === 'screen' ? L.recScreen : p.attachments?.length ? L.recVoice : `#${m.n}`);
    const headKids: Node[] = [
      h(d, 'nav', { class: 'ph-crumbs', 'aria-label': L.thread }, [
        h(d, 'span', { class: 'ph-crumb-root' }, [L.panelTitle]),
        crumbIcon(d),
        h(d, 'span', { class: 'ph-crumb-title', title }, [title]),
      ]),
      // the word stays for screen readers; on screen the ✓ icon says it
      h(d, 'span', { class: 'ph-status ph-sr', 'data-status': status, title: statusTitle }, [resolved ? L.statusResolved : L.statusOpen]),
    ];
    if (m.canResolve) {
      const label = resolved ? L.reopen : L.resolve;
      const b = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-resolve', 'data-status': status, 'aria-label': label, title: statusTitle ?? label }, [circleCheckIcon(d)]);
      b.addEventListener('click', () => void this.toggleStatus());
      headKids.push(b);
    } else if (resolved) {
      headKids.push(h(d, 'span', { class: 'ph-status-icon', 'data-status': status, title: statusTitle ?? L.statusResolved, 'aria-hidden': 'true' }, [circleCheckIcon(d)]));
    }
    const issue = p.issue && /^https?:\/\//.test(p.issue.url) ? p.issue : null;
    if (issue) {
      headKids.push(h(d, 'a', { class: 'ph-icon-btn ph-issue-open', href: issue.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': L.issueLink(issue), title: L.issueLink(issue) }, [globeIcon(d)]));
    }
    if (this.env.onExpand) {
      const label = this.env.expanded ? L.collapse : L.expand;
      const x = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-expand', 'aria-label': label, title: label, 'aria-pressed': String(this.env.expanded) }, [this.env.expanded ? collapseIcon(d) : expandIcon(d)]);
      x.addEventListener('click', () => this.env.onExpand?.());
      headKids.push(x);
    }
    const close = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-thread-close', 'aria-label': L.close, title: L.close }, [closeIcon(d)]);
    close.addEventListener('click', () => this.handlers.close());
    headKids.push(close);
    this.head.replaceChildren(...headKids);

    // the linked issue, above the reply field: the whole bar opens it
    if (issue) {
      const state = issue.unavailable
        ? h(d, 'span', { class: 'ph-issue-state', 'data-state': 'unavailable', title: `${issue.repo}#${issue.number}` }, [L.issueUnavailable])
        : issue.state
          ? h(d, 'span', { class: 'ph-issue-status', 'data-state': issue.state }, [L.issueStateLong(issue)])
          : null;
      this.issueBar.setAttribute('data-state', issue.unavailable ? 'unavailable' : issue.state ?? 'unknown');
      this.issueBar.replaceChildren(
        h(d, 'span', { class: 'ph-issue-dot', 'aria-hidden': 'true' }),
        h(d, 'a', { class: 'ph-issue', href: issue.url, target: '_blank', rel: 'noopener noreferrer', title: `${issue.repo}#${issue.number}` }, [L.issueLink(issue)]),
        h(d, 'span', { class: 'ph-issue-repo' }, [issue.repo]),
        ...(state ? [state] : []),
      );
      this.issueBar.hidden = false;
    } else {
      this.issueBar.hidden = true;
      this.issueBar.replaceChildren();
    }
    this.replyBox.hidden = !this.composer && this.issueBar.hidden;

    // feed: the comment, replies, and the "resolved" line where it happened; a separator between days
    const items: Node[] = [this.message(p, null)];
    let lastDay = dayKey(p.createdAt);
    const dayBreak = (iso: string) => {
      const key = dayKey(iso);
      if (!key || key === lastDay) return;
      lastDay = key;
      items.push(h(d, 'div', { class: 'ph-day', role: 'separator' }, [waveLine(d), h(d, 'span', {}, [dayLabel(iso, L)]), waveLine(d)]));
    };
    let eventShown = false;
    const event = () => {
      eventShown = true;
      let text = !p.resolvedBy ? L.statusResolved : sameAuthor(p.resolvedBy, m.me) ? L.resolvedByYou : L.resolvedBy(displayName(p.resolvedBy, L));
      if (p.resolvedVia && p.resolvedVia === p.issue?.provider) text = L.closedOnTracker(p.resolvedVia, p.resolvedBy?.name, p.issue?.stateReason ?? null);
      return h(d, 'div', { class: 'ph-event', role: 'note' }, [checkIcon(d), `${text}${p.resolvedAt ? ` · ${formatTime(p.resolvedAt, L.locale)}` : ''}`]);
    };
    for (const r of p.replies ?? []) {
      if (resolved && !eventShown && p.resolvedAt && r.createdAt > p.resolvedAt) items.push(event());
      dayBreak(r.createdAt);
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
    const external = !!reply?.origin;
    const time = h(d, 'time', { dateTime: item.createdAt, title: fullTime(item.createdAt, L.locale) }, [formatTime(item.createdAt, L.locale)]);
    const edited = item.updatedAt ? h(d, 'span', { class: 'ph-msg-edited' }, [L.edited]) : null;
    const kind = !reply && m.payload.kind ? h(d, 'span', { class: 'ph-msg-kind' }, [`${L.kindEmoji[m.payload.kind]} ${L.kinds[m.payload.kind]}`]) : null;
    // others: a header line with the name; mine: no name, time under the text
    let head: HTMLElement | null = null;
    if (external) {
      // `ph-msg-github` is kept for styles written against it: it marks every tracker reply
      wrap.classList.add('ph-msg-github', 'ph-msg-external');
      wrap.setAttribute('data-origin', reply!.origin!);
      const a = item.author;
      const avatar = a?.avatarUrl && /^(https?:\/\/|\/)/.test(a.avatarUrl) ? h(d, 'img', { class: 'ph-avatar', src: a.avatarUrl, alt: '', width: 14, height: 14, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null;
      const name = a?.url && /^https?:\/\//.test(a.url) ? h(d, 'a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, [displayName(a, L)]) : displayName(a, L);
      const source = reply?.link?.url && /^https?:\/\//.test(reply.link.url) ? h(d, 'a', { class: 'ph-msg-source', href: reply.link.url, target: '_blank', rel: 'noopener noreferrer' }, [L.fromTracker(reply!.origin!)]) : h(d, 'span', { class: 'ph-msg-source' }, [L.fromTracker(reply!.origin!)]);
      head = h(d, 'div', { class: 'ph-msg-head' }, [h(d, 'div', { class: 'ph-msg-name', 'data-color': colorIndex(a) }, [avatar, name, source]), time, edited, kind]);
    } else if (!mine) {
      const who = displayName(item.author, L);
      head = h(d, 'div', { class: 'ph-msg-head' }, [
        h(d, 'span', { class: 'ph-initial', 'data-color': colorIndex(item.author), 'aria-hidden': 'true' }, [initial(who)]),
        h(d, 'div', { class: 'ph-msg-name', 'data-color': colorIndex(item.author) }, [who]),
        time,
        edited,
        kind,
      ]);
    }
    if (head) bubble.append(head);
    if (item.text) bubble.append(h(d, 'div', { class: reply ? 'ph-msg-text' : 'ph-msg-text ph-view-text' }, [item.text]));
    if (item.attachments?.length) bubble.append(attachmentsView(d, item.attachments, L));
    if (!head) bubble.append(h(d, 'div', { class: 'ph-msg-foot' }, [kind, edited, time]));
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

function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0].trim();
}

/** Local calendar day, for separators; '' for a bad date. */
function dayKey(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toDateString();
}

/** "Сегодня", "Вчера", "3 ноября" (with the year when it is not this one). */
export function dayLabel(iso: string, labels: FeedbackLabels, now = new Date()): string {
  const t = new Date(iso);
  if (t.toDateString() === now.toDateString()) return labels.today;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return labels.yesterday;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  if (t.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  try {
    return t.toLocaleDateString(labels.locale, opts);
  } catch {
    return t.toDateString();
  }
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
