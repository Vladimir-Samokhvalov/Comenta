import type {
  FeedbackAdapter,
  FeedbackAuthor,
  FeedbackInstance,
  FeedbackKind,
  FeedbackLabels,
  FeedbackOptions,
  FeedbackPayload,
  FeedbackReply,
  FeedbackStatus,
  FeedbackStatusChange,
} from '../types';
import { consoleAdapter } from '../adapters/console';
import { resolveSelector } from '../selector';
import { DEFAULT_IGNORE_SELECTOR, describeTarget } from '../selector/sanitize';
import { DEFAULT_LABELS } from '../ui/labels';
import { Popover } from '../ui/popover';
import { Menu, Panel, type PanelItem } from '../ui/menu';
import { View, type Rect } from '../ui/view';
import { h } from '../ui/h';
import { normalizeUrl } from './url';
import { uuid } from './uuid';
import { extensionFor, recordingSupport, type Recording } from './recorder';
import type { RecordConfig } from '../ui/record';
import type { FeedbackAttachment, FeedbackFile, FeedbackSubmitResult } from '../types';
import { loadGuest, sameAuthor, saveGuestName, SeenStore, type Guest } from './identity';
import type { ThreadHandlers, ThreadModel } from '../ui/thread';

interface StoredComment {
  payload: FeedbackPayload;
  el: Element | null;
  pin: HTMLButtonElement | null;
}

type Off = () => void;

const CURSOR_STYLE_ID = 'comenta-feedback-cursor';
const MUTATION_THROTTLE_MS = 100;
const DEFAULT_POLL_MS = 30_000;
const HASH_PREFIX = '#comenta=';
/** Events swallowed while picking, so the page never sees the interaction. */
const BLOCKED_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const;

export class Controller {
  readonly api: FeedbackInstance;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly ignoreSelector: string;
  private readonly labels: FeedbackLabels;
  private adapter: FeedbackAdapter;
  private options: FeedbackOptions;

  private view: View | null = null;
  private popover: Popover | null = null;
  private menu: Menu | null = null;
  private panel: Panel | null = null;
  private pinsHidden = false;
  /** Pins of resolved threads are hidden unless turned on in the menu. */
  private showResolved = false;
  private guest: Guest;
  private seen: SeenStore;
  /** "Last seen" of the open thread at the moment it was opened: newer replies get highlighted. */
  private threadSince: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private hashChecked = false;
  /** blob: URLs created for in-session playback of sent recordings; revoked on destroy. */
  private objectUrls: string[] = [];
  private active = false;
  private destroyed = false;
  private hoverEl: Element | null = null;
  private selectedEl: Element | null = null;
  private selectedSnapshot: FeedbackPayload['target'] | null = null;
  private comments: StoredComment[] = [];
  private url: string;

  private globalOffs: Off[] = [];
  private modeOffs: Off[] = [];
  private observer: MutationObserver | null = null;
  private raf = 0;
  private mutationTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = true;
  private cursorStyle: HTMLStyleElement | null = null;

  constructor(options: FeedbackOptions = {}, doc: Document = document) {
    this.doc = doc;
    this.win = doc.defaultView ?? window;
    this.options = { ...options };
    this.adapter = options.adapter ?? consoleAdapter();
    this.ignoreSelector = options.ignoreSelector ?? DEFAULT_IGNORE_SELECTOR;
    this.labels = { ...DEFAULT_LABELS, ...options.labels, kinds: { ...DEFAULT_LABELS.kinds, ...options.labels?.kinds }, kindEmoji: { ...DEFAULT_LABELS.kindEmoji, ...options.labels?.kindEmoji } };
    this.url = normalizeUrl(this.win.location.href);
    this.guest = loadGuest(this.win);
    this.seen = new SeenStore(this.win, this.me().id ?? '');

    this.api = {
      open: () => this.setActive(true),
      close: () => this.setActive(false),
      toggle: () => this.setActive(!this.active),
      isOpen: () => this.active,
      update: (o) => this.update(o),
      getComments: () => this.comments.map((c) => c.payload),
      showComments: () => this.openPanel(),
      openThread: (id) => this.openThreadById(id),
      getUnreadCount: () => this.unreadCount(),
      destroy: () => this.destroy(),
    };

    if (options.enabled === false) return;
    this.mount();
  }

  // ---------------------------------------------------------------- lifecycle

  private mount() {
    const position = this.options.position ?? 'bottom-right';
    this.view = new View(this.doc, {
      position,
      zIndex: this.options.zIndex ?? 2147483000,
      labels: this.labels,
      hotkey: this.options.hotkey === undefined ? 'c' : this.options.hotkey,
      onToggle: () => this.setActive(!this.active),
    });
    this.menu = new Menu(this.doc, this.view.bar, this.labels, {
      onShowAll: () => this.openPanel(),
      onTogglePins: () => {
        this.pinsHidden = !this.pinsHidden;
        if (this.view) this.view.pinLayer.hidden = this.pinsHidden;
        if (this.pinsHidden && this.popover?.mode === 'view') this.closePopover(false);
        this.closeMenu(true);
      },
      onToggleResolved: () => {
        this.showResolved = !this.showResolved;
        this.closeMenu(true);
        this.scheduleLayout();
      },
    });
    this.panel = new Panel(this.doc, this.view.bar, this.labels, {
      onTab: (tab) => {
        if (tab === 'all') void this.loadAll();
        this.renderPanel();
      },
      onFilter: () => this.renderPanel(),
      onPick: (item) => this.pickFromPanel(item),
      onClose: () => this.closePanel(true),
    });
    this.view.more.addEventListener('click', () => (this.menu?.isOpen ? this.closeMenu(true) : this.openMenu()));
    this.view.unread.addEventListener('click', () => (this.panel?.isOpen ? this.closePanel(true) : this.openPanel()));
    this.popover = new Popover(
      this.doc,
      this.view.root,
      this.labels,
      {
        onSubmit: (kind, text, recording, name) => void this.submit(kind, text, recording, name),
        onCancel: () => this.closePopover(true),
      },
      this.recordConfig(),
      this.view.root,
      (docked) => this.onDock(docked),
    );
    this.popover.reposition = () => this.scheduleLayout();

    const relayout = () => this.scheduleLayout();
    this.globalOffs.push(
      this.listen(this.doc, 'scroll', relayout, { capture: true, passive: true }),
      // resize is only dispatched on window
      this.listen(this.win, 'resize', relayout, { passive: true }),
      this.listen(this.win, 'popstate', () => this.onMutations(), {}),
      this.listen(this.win, 'hashchange', () => this.onMutations(), {}),
      this.listen(this.doc, 'keydown', this.onKeyDown as EventListener, { capture: true }),
      this.listen(this.doc, 'focusin', this.onFocusIn as EventListener, { capture: true }),
      this.listen(this.doc, 'pointerdown', this.onOutsidePointer as EventListener, { capture: true }),
      this.listen(this.doc, 'visibilitychange', () => {
        if (this.doc.visibilityState === 'visible') void this.poll();
      }, {}),
    );
    const unsubscribe = this.adapter.subscribe?.(() => void this.poll());
    if (unsubscribe) this.globalOffs.push(unsubscribe);
    const every = this.options.pollIntervalMs === undefined ? DEFAULT_POLL_MS : this.options.pollIntervalMs;
    if (every && every > 0 && (this.adapter.list || this.adapter.listAll)) {
      this.pollTimer = setInterval(() => {
        if (this.doc.visibilityState !== 'hidden') void this.poll();
      }, every);
    }

    const MO = (this.win as Window & typeof globalThis).MutationObserver;
    if (MO) {
      this.observer = new MO((records) => {
        if (records.every((r) => this.isOwnMutation(r))) return;
        this.onMutations();
      });
      this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    }

    this.updateCount();
    void this.loadComments().then(() => this.loadAll());
  }

  private recordConfig(): RecordConfig | null {
    const opt = this.options.recording;
    if (opt === false) return null;
    const support = recordingSupport(this.win);
    const audio = support.audio && opt?.audio !== false;
    const screen = support.screen && opt?.screen !== false;
    if (!audio && !screen) return null;
    return { audio, screen, maxMs: opt?.maxDurationMs ?? 60_000 };
  }

  /** Mutations caused by the widget itself (host node, cursor style) are ignored. */
  private isOwnMutation(r: MutationRecord): boolean {
    const style = this.cursorStyle;
    const own = (n: Node) => n === this.view?.host || (style !== null && (n === style || n.parentNode === style));
    if (own(r.target)) return true;
    if (r.type !== 'childList') return false;
    const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
    return nodes.length > 0 && nodes.every(own);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setActive(false);
    for (const off of this.globalOffs.splice(0)) off();
    clearInterval(this.pollTimer);
    this.observer?.disconnect();
    this.observer = null;
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    clearTimeout(this.mutationTimer);
    this.view?.destroy();
    for (const u of this.objectUrls.splice(0)) URL.revokeObjectURL(u);
    this.view = null;
    this.popover = null;
    this.menu = null;
    this.panel = null;
    this.comments = [];
    this.hoverEl = this.selectedEl = null;
    if (current === this) current = null;
  }

  private update(o: Partial<FeedbackOptions>) {
    if (o.adapter) this.adapter = o.adapter;
    if ('onSubmit' in o) this.options.onSubmit = o.onSubmit;
    if ('onError' in o) this.options.onError = o.onError;
    if ('onReply' in o) this.options.onReply = o.onReply;
    if ('onStatusChange' in o) this.options.onStatusChange = o.onStatusChange;
    if ('author' in o) {
      const before = this.me();
      this.options.author = o.author;
      const after = this.me();
      if (before.id !== after.id || before.name !== after.name || before.role !== after.role) this.onIdentityChange();
    }
  }

  /** Who is writing: the site's author, or a remembered guest. */
  private me(): FeedbackAuthor {
    const a = this.options.author;
    const me: FeedbackAuthor = { id: a?.id || this.guest.id, name: a?.name || this.guest.name || this.labels.guest };
    if (a?.role) me.role = a.role;
    return me;
  }

  /** Ask for a name only when the site did not pass one and the guest never typed it. */
  private askName(): boolean {
    return !this.options.author?.name && !this.guest.name;
  }

  private rememberName(name: string) {
    if (name && !this.options.author?.name) saveGuestName(this.win, this.guest, name.slice(0, 60));
  }

  private onIdentityChange() {
    this.seen.setUser(this.me().id ?? '');
    this.renumber();
    this.renderPanel();
    this.refreshUnread();
    const viewing = this.popover?.mode === 'view' ? this.comments.find((c) => c.payload.id === this.popover!.viewing) : undefined;
    if (viewing) {
      this.popover!.close();
      this.openComment(viewing);
    }
  }

  private listen(target: EventTarget, type: string, fn: EventListener, opts: AddEventListenerOptions): Off {
    target.addEventListener(type, fn, opts);
    return () => target.removeEventListener(type, fn, opts);
  }

  // ---------------------------------------------------------------- mode

  private setActive(on: boolean) {
    if (!this.view || this.destroyed && on) return;
    if (on === this.active) return;
    this.active = on;
    this.view.setActive(on);
    if (on) {
      this.setPicking(true);
    } else {
      this.setPicking(false);
      if (this.popover?.mode === 'compose') this.closePopover(false);
    }
  }

  /** Attach / detach the picking listeners (hover, click blocking, crosshair). */
  private setPicking(on: boolean) {
    if (on && !this.modeOffs.length) {
      const opts = { capture: true };
      this.modeOffs.push(this.listen(this.doc, 'mousemove', this.onPointerMove as EventListener, { capture: true, passive: true }));
      this.modeOffs.push(this.listen(this.doc, 'mouseout', this.onPointerOut as EventListener, { capture: true, passive: true }));
      for (const t of BLOCKED_EVENTS) this.modeOffs.push(this.listen(this.doc, t, this.onBlocked, opts));
      this.modeOffs.push(this.listen(this.doc, 'submit', this.onBlocked, opts));
      this.setCursor(true);
    } else if (!on) {
      for (const off of this.modeOffs.splice(0)) off();
      this.setCursor(false);
      this.hoverEl = null;
      this.view?.showHover(null);
    }
  }

  /**
   * Screen recording: hide everything that would end up in the video (form, toolbar,
   * hover frame, crosshair) and let the page be used normally; the selection frame stays.
   * A compact control strip is shown at the bottom centre instead (rendered by RecordControl).
   */
  private onDock(docked: boolean) {
    if (!this.view || !this.popover) return;
    this.view.bar.hidden = docked;
    this.popover.el.hidden = docked;
    if (docked) {
      this.closeMenu(false);
      this.closePanel(false);
      this.setPicking(false);
    } else {
      if (this.active && !this.destroyed) this.setPicking(true);
      this.scheduleLayout();
    }
  }

  /** Crosshair needs a document-level rule; it only exists while the mode is on. */
  private setCursor(on: boolean) {
    if (on && !this.cursorStyle) {
      const style = this.doc.createElement('style');
      style.id = CURSOR_STYLE_ID;
      style.textContent = 'html, html * { cursor: crosshair !important; }';
      (this.doc.head ?? this.doc.documentElement).append(style);
      this.cursorStyle = style;
    } else if (!on && this.cursorStyle) {
      this.cursorStyle.remove();
      this.cursorStyle = null;
    }
  }

  /** Nearest element that can be commented: not the widget, not ignored, not html/body. */
  private pickable(target: EventTarget | null): Element | null {
    const node = target as Node | null;
    let el: Element | null = !node ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el) return null;
    if (this.ignoreSelector) {
      let ignored: Element | null;
      try {
        ignored = el.closest(this.ignoreSelector);
      } catch {
        ignored = null;
      }
      // climb above the outermost ignored ancestor
      while (ignored) {
        el = ignored.parentElement;
        if (!el) return null;
        try {
          ignored = el.closest(this.ignoreSelector);
        } catch {
          ignored = null;
        }
      }
    }
    if (!el || el === this.doc.documentElement || el === this.doc.body || el === this.view?.host) return null;
    return el;
  }

  private onPointerMove = (e: MouseEvent) => {
    if (!this.view) return;
    const el = this.view.owns(e) ? null : this.pickable(e.target);
    if (el !== this.hoverEl) {
      this.hoverEl = el;
      this.scheduleLayout();
    }
  };

  private onPointerOut = (e: MouseEvent) => {
    if (!e.relatedTarget && this.hoverEl) {
      this.hoverEl = null;
      this.scheduleLayout();
    }
  };

  private onBlocked = (e: Event) => {
    if (!this.view || this.view.owns(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click') {
      const el = this.pickable(e.target);
      if (el) this.select(el);
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'Esc') {
      this.onHotkey(e);
      return;
    }
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (this.menu?.isOpen) {
      consume();
      this.closeMenu(true);
    } else if (this.panel?.isOpen) {
      consume();
      this.closePanel(true);
    } else if (this.popover?.handleEscape()) {
      consume();
    } else if (this.popover?.isOpen) {
      e.preventDefault();
      e.stopPropagation();
      this.closePopover(true);
    } else if (this.active) {
      e.preventDefault();
      e.stopPropagation();
      this.setActive(false);
      this.view?.toggle.focus({ preventScroll: true });
    }
  };

  private onHotkey(e: KeyboardEvent) {
    const key = this.options.hotkey === undefined ? 'c' : this.options.hotkey;
    if (!key || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== key.toLowerCase()) return;
    if (this.popover?.isOpen) return;
    const t = e.composedPath()[0] as HTMLElement | undefined;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ''))) return;
    e.preventDefault();
    this.setActive(!this.active);
  }

  private onOutsidePointer = (e: PointerEvent) => {
    const path = e.composedPath();
    if (this.menu?.isOpen && !path.includes(this.menu.el) && !path.includes(this.view!.more)) this.closeMenu(false);
    if (this.panel?.isOpen && !path.includes(this.view!.bar)) this.closePanel(false);
  };

  // ---------------------------------------------------------------- menu & panel

  private openMenu() {
    if (!this.menu || !this.view) return;
    this.closePanel(false);
    const page = this.pageComments();
    this.menu.open(page.length, this.pinsHidden, this.showResolved, page.filter((c) => c.payload.status === 'resolved').length);
    this.view.more.setAttribute('aria-expanded', 'true');
    this.view.setPopupOpen(true);
  }

  private closeMenu(returnFocus: boolean) {
    if (!this.menu?.isOpen || !this.view) return;
    this.menu.close();
    this.view.more.setAttribute('aria-expanded', 'false');
    this.view.setPopupOpen(!!this.panel?.isOpen);
    if (returnFocus) this.view.more.focus({ preventScroll: true });
  }

  private openPanel() {
    if (!this.panel || !this.view) return;
    this.closeMenu(false);
    if (this.popover?.isOpen) this.closePopover(false);
    this.panel.open();
    this.view.setPopupOpen(true);
    this.renderPanel();
    if (this.panel.tab === 'all') void this.loadAll();
  }

  private closePanel(returnFocus: boolean) {
    if (!this.panel?.isOpen || !this.view) return;
    this.panel.close();
    this.view.setPopupOpen(!!this.menu?.isOpen);
    if (returnFocus) this.view.more.focus({ preventScroll: true });
  }

  private renderPanel() {
    const panel = this.panel;
    if (!panel?.isOpen) return;
    const page = this.pageComments();
    const me = this.me();
    const item = (c: StoredComment): PanelItem => {
      const idx = page.indexOf(c);
      const unread = this.seen.isUnread(c.payload, me);
      if (idx === -1) return { payload: c.payload, n: null, missing: false, unread };
      if (!c.el || !c.el.isConnected) c.el = resolveSelector(c.payload.target.selector, this.doc);
      return { payload: c.payload, n: idx + 1, missing: !c.el, unread };
    };
    const byStatus = (c: StoredComment) =>
      panel.filter === 'all' || (panel.filter === 'resolved') === (c.payload.status === 'resolved');
    const list =
      panel.tab === 'page'
        ? page.filter(byStatus).map(item)
        : [...this.comments].filter(byStatus).sort((a, b) => b.payload.createdAt.localeCompare(a.payload.createdAt)).map(item);
    panel.render(list);
  }

  private async loadAll() {
    if (!this.adapter.listAll) return;
    try {
      const all = await this.adapter.listAll();
      if (this.destroyed) return;
      this.merge(all);
    } catch (err) {
      console.warn('[feedback] adapter.listAll failed', err);
    }
  }

  private pickFromPanel(item: PanelItem) {
    if (item.n === null) {
      // the thread opens on arrival
      this.win.location.assign(`${item.payload.page.url.split('#')[0]}${HASH_PREFIX}${encodeURIComponent(item.payload.id)}`);
      return;
    }
    const c = this.comments.find((x) => x.payload.id === item.payload.id);
    if (!c || item.missing || !c.el) return;
    this.closePanel(false);
    c.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    this.openComment(c);
  }

  /** Focus trap: focus must not leave an open popover. */
  private onFocusIn = (e: FocusEvent) => {
    if (!this.popover?.isOpen || !this.view) return;
    if (this.popover.docked) return; // page is usable while the screen is being recorded
    if (e.composedPath().includes(this.popover.el)) return;
    this.popover.focus();
  };

  // ---------------------------------------------------------------- selection & popover

  private select(el: Element) {
    if (!this.popover || !this.view) return;
    this.syncUrl();
    this.selectedEl = el;
    this.selectedSnapshot = describeTarget(el, this.ignoreSelector);
    if (this.popover.mode !== 'compose') this.popover.openCompose(this.askName());
    else this.popover.focus();
    this.layout();
  }

  private closePopover(returnFocus: boolean) {
    if (!this.popover?.isOpen) return;
    // Return focus to the toggle only if focus was in the widget (or got dropped to <body>).
    const active = this.doc.activeElement;
    const hadFocus = !!this.view && (this.view.shadow.activeElement !== null || !active || active === this.doc.body);
    this.popover.close();
    this.selectedEl = null;
    this.selectedSnapshot = null;
    this.view?.showSelection(null);
    if (returnFocus && hadFocus) this.view?.toggle.focus({ preventScroll: true });
    this.scheduleLayout();
  }

  private openComment(c: StoredComment) {
    if (!this.popover) return;
    if (this.popover.mode === 'view' && this.popover.viewing === c.payload.id) {
      this.closePopover(true);
      return;
    }
    if (this.popover.isOpen) this.closePopover(false);
    this.threadSince = this.seen.since(c.payload.id);
    this.popover.openThread(this.threadModel(c), this.threadHandlers(c));
    this.markSeen(c);
    this.layout();
  }

  private openThreadById(id: string): boolean {
    const c = this.pageComments().find((x) => x.payload.id === id);
    if (!c) return false;
    if (!c.el || !c.el.isConnected) c.el = resolveSelector(c.payload.target.selector, this.doc);
    if (!c.el) return false;
    this.closePanel(false);
    c.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (this.popover?.viewing !== id) this.openComment(c);
    return true;
  }

  // ---------------------------------------------------------------- threads

  private canResolve(p: FeedbackPayload): boolean {
    const me = this.me();
    return !!this.adapter.setStatus && (me.role === 'owner' || sameAuthor(p.author, me));
  }

  private threadModel(c: StoredComment): ThreadModel {
    return {
      payload: c.payload,
      n: this.pageComments().indexOf(c) + 1,
      me: this.me(),
      canResolve: this.canResolve(c.payload),
      canReply: !!this.adapter.reply,
      canEdit: !!this.adapter.updateReply,
      canDelete: !!this.adapter.deleteReply,
      askName: this.askName(),
      unreadSince: this.threadSince,
    };
  }

  private threadHandlers(c: StoredComment): ThreadHandlers {
    return {
      reply: async (text, recording, resolve, name) => {
        if (!this.adapter.reply) return;
        this.rememberName(name);
        const files = this.toFiles(recording);
        const reply: FeedbackReply = { id: uuid(), commentId: c.payload.id, text, createdAt: new Date().toISOString(), author: this.me() };
        if (files.length) reply.attachments = files.map((f) => ({ ...f.attachment }));
        const result = await this.adapter.reply(c.payload.id, reply, files);
        if (this.destroyed) return;
        const stored = this.withUrls(reply, files, result);
        this.setPayload(c, { ...c.payload, replies: [...(c.payload.replies ?? []), stored] });
        this.options.onReply?.(stored, c.payload);
        if (resolve && c.payload.status !== 'resolved') await this.changeStatus(c, 'resolved');
        this.markSeen(c);
      },
      setStatus: (status) => this.changeStatus(c, status),
      edit: async (replyId, text) => {
        if (!this.adapter.updateReply) return;
        const patch = { text, updatedAt: new Date().toISOString() };
        await this.adapter.updateReply(c.payload.id, replyId, patch);
        this.setPayload(c, { ...c.payload, replies: (c.payload.replies ?? []).map((r) => (r.id === replyId ? { ...r, ...patch } : r)) });
      },
      remove: async (replyId) => {
        if (!this.adapter.deleteReply) return;
        await this.adapter.deleteReply(c.payload.id, replyId);
        this.setPayload(c, { ...c.payload, replies: (c.payload.replies ?? []).filter((r) => r.id !== replyId) });
      },
      close: () => this.closePopover(true),
    };
  }

  private async changeStatus(c: StoredComment, status: FeedbackStatus) {
    if (!this.adapter.setStatus) return;
    const change: FeedbackStatusChange = { status, by: this.me(), at: new Date().toISOString() };
    await this.adapter.setStatus(c.payload.id, change);
    if (this.destroyed) return;
    const next: FeedbackPayload = { ...c.payload, status };
    if (status === 'resolved') {
      next.resolvedBy = change.by;
      next.resolvedAt = change.at;
    } else {
      delete next.resolvedBy;
      delete next.resolvedAt;
    }
    this.setPayload(c, next);
    this.options.onStatusChange?.(c.payload, change);
  }

  /** Replace a comment's data and refresh everything that shows it. */
  private setPayload(c: StoredComment, payload: FeedbackPayload) {
    c.payload = payload;
    if (this.popover?.mode === 'view' && this.popover.viewing === payload.id) {
      this.popover.thread?.update(this.threadModel(c));
      this.markSeen(c);
    }
    this.renumber();
    this.renderPanel();
    this.refreshUnread();
    this.scheduleLayout();
  }

  private markSeen(c: StoredComment) {
    this.seen.markSeen(c.payload);
    this.refreshUnread();
    this.renumber();
    this.renderPanel();
  }

  private unreadCount(): number {
    const me = this.me();
    return this.comments.filter((c) => this.seen.isUnread(c.payload, me)).length;
  }

  private refreshUnread() {
    this.view?.setUnread(this.unreadCount());
  }

  /** Re-read comments (polling, adapter push, tab became visible). */
  private async poll() {
    if (this.polling || this.destroyed) return;
    this.polling = true;
    try {
      this.seen.reload();
      const url = this.url;
      const list = this.adapter.listAll ? await this.adapter.listAll() : this.adapter.list ? await this.adapter.list(this.win.location.href) : [];
      if (this.destroyed || url !== this.url) return;
      this.merge(list);
    } catch (err) {
      console.warn('[feedback] refresh failed', err);
    } finally {
      this.polling = false;
    }
  }

  /** Add new comments and take fresh replies / statuses for known ones. */
  private merge(list: FeedbackPayload[]) {
    let changed = false;
    for (const p of list) {
      const c = this.comments.find((x) => x.payload.id === p.id);
      if (!c) {
        this.addComment(p, null, false);
        changed = true;
        continue;
      }
      const next = keepUrls(c.payload, p);
      if (fingerprint(next) === fingerprint(c.payload)) continue;
      c.payload = next;
      changed = true;
      if (this.popover?.mode === 'view' && this.popover.viewing === p.id) {
        this.popover.thread?.update(this.threadModel(c));
        this.seen.markSeen(c.payload);
      }
    }
    if (changed) {
      this.comments.sort((a, b) => a.payload.createdAt.localeCompare(b.payload.createdAt));
      this.renumber();
      this.updateCount();
      this.dirty = true;
      this.scheduleLayout();
    }
    this.refreshUnread();
    this.checkHash();
  }

  /** `#comenta=<id>` in the address opens that thread (links from e-mails, the "All pages" list). */
  private checkHash() {
    if (this.hashChecked) return;
    const hash = this.win.location.hash;
    if (!hash.startsWith(HASH_PREFIX)) {
      this.hashChecked = true;
      return;
    }
    const id = decodeURIComponent(hash.slice(HASH_PREFIX.length));
    if (this.openThreadById(id)) this.hashChecked = true;
  }

  /** Playback URLs for just-sent recordings: the adapter's, or a session-only blob: URL. */
  private withUrls<T extends { attachments?: FeedbackAttachment[] }>(item: T, files: FeedbackFile[], result: void | FeedbackSubmitResult): T {
    if (!files.length) return item;
    const urls = (result && result.attachmentUrls) || {};
    return {
      ...item,
      attachments: files.map((f) => {
        let url = urls[f.attachment.id];
        if (!url) {
          url = URL.createObjectURL(f.blob);
          this.objectUrls.push(url);
        }
        return { ...f.attachment, url };
      }),
    };
  }

  // ---------------------------------------------------------------- submit

  private buildPayload(kind: FeedbackKind | null, text: string, files: FeedbackFile[]): FeedbackPayload | null {
    const el = this.selectedEl;
    const target = el && el.isConnected ? describeTarget(el, this.ignoreSelector) : this.selectedSnapshot;
    if (!target) return null;
    const nav = this.win.navigator;
    const payload: FeedbackPayload = {
      id: uuid(),
      ...(kind ? { kind } : {}),
      text,
      createdAt: new Date().toISOString(),
      page: {
        url: this.win.location.href,
        title: this.doc.title,
        viewport: { w: this.win.innerWidth, h: this.win.innerHeight },
        userAgent: nav?.userAgent ?? '',
      },
      target,
    };
    payload.author = this.me();
    if (files.length) payload.attachments = files.map((f) => ({ ...f.attachment }));
    return payload;
  }

  private toFiles(recording: Recording | null): FeedbackFile[] {
    if (!recording) return [];
    const id = uuid();
    const attachment: FeedbackAttachment = {
      id,
      kind: recording.kind,
      name: `${recording.kind === 'audio' ? 'voice' : 'screen'}-${id}.${extensionFor(recording.mimeType)}`,
      mimeType: recording.mimeType,
      size: recording.blob.size,
      durationMs: Math.round(recording.durationMs),
    };
    return [{ attachment, blob: recording.blob }];
  }

  private async submit(kind: FeedbackKind | null, text: string, recording: Recording | null = null, name = '') {
    const popover = this.popover;
    if (!popover || !this.view) return;
    this.rememberName(name);
    const files = this.toFiles(recording);
    const payload = this.buildPayload(kind, text, files);
    if (!payload) return;
    const el = this.selectedEl;
    popover.setSubmitting(true);
    let stored = payload;
    try {
      const result = await this.adapter.submit(payload, files);
      stored = this.withUrls(payload, files, result);
    } catch (err) {
      if (this.destroyed || this.popover !== popover) return;
      popover.setSubmitting(false);
      const msg = err instanceof Error && err.message ? err.message : String(err ?? '');
      popover.setError(msg ? `${this.labels.errorPrefix}: ${msg}` : this.labels.errorPrefix);
      this.options.onError?.(err, payload);
      return;
    }
    if (this.destroyed) return;
    popover.setSubmitting(false);
    this.addComment(stored, el);
    this.seen.markSeen(stored);
    this.closePopover(true);
    this.view.showToast(this.labels.sent);
    this.options.onSubmit?.(stored);
  }

  // ---------------------------------------------------------------- comments & pins

  private async loadComments() {
    if (!this.adapter.list) return;
    const url = this.url;
    try {
      const list = await this.adapter.list(this.win.location.href);
      if (this.destroyed || url !== this.url) return;
      this.merge(list);
    } catch (err) {
      console.warn('[feedback] adapter.list failed', err);
    }
  }

  private addComment(payload: FeedbackPayload, el: Element | null, refresh = true) {
    const c: StoredComment = { payload, el, pin: null };
    this.comments.push(c);
    if (refresh) {
      this.renumber();
      this.updateCount();
      this.scheduleLayout();
    }
  }

  private pageComments(): StoredComment[] {
    return this.comments.filter((c) => normalizeUrl(c.payload.page.url) === this.url);
  }

  private renumber() {
    if (!this.view) return;
    const onPage = new Set(this.pageComments());
    let n = 0;
    for (const c of this.comments) {
      if (!onPage.has(c)) {
        c.pin?.remove();
        c.pin = null;
        continue;
      }
      n++;
      if (!c.pin) {
        const pin = h(this.doc, 'button', { type: 'button', class: 'ph-pin', 'data-kind': c.payload.kind ?? null, hidden: true });
        pin.addEventListener('click', () => this.openComment(c));
        this.view.pinLayer.append(pin);
        c.pin = pin;
      }
      const resolved = c.payload.status === 'resolved';
      const unread = this.seen.isUnread(c.payload, this.me());
      c.pin.textContent = resolved ? '✓' : String(n);
      c.pin.toggleAttribute('data-resolved', resolved);
      c.pin.toggleAttribute('data-unread', unread);
      c.pin.setAttribute('aria-label', `${this.labels.pin(n)}${resolved ? ` · ${this.labels.statusResolved}` : ''}${unread ? ` · ${this.labels.unread(1)}` : ''}`);
      c.pin.title = c.payload.text.length > 80 ? `${c.payload.text.slice(0, 79)}…` : c.payload.text || (c.payload.attachments?.length ? this.labels.recVoice : '');
    }
  }

  /** Keeps the comments panel in sync with the list of comments. */
  private updateCount() {
    this.renderPanel();
  }

  // ---------------------------------------------------------------- layout

  private onMutations() {
    if (this.mutationTimer !== undefined) return;
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = undefined;
      if (this.destroyed) return;
      this.syncUrl();
      this.dirty = true;
      this.scheduleLayout();
    }, MUTATION_THROTTLE_MS);
  }

  /** SPA navigation (pushState etc.) is detected lazily: on DOM mutations, popstate and before selecting. */
  private syncUrl() {
    const url = normalizeUrl(this.win.location.href);
    if (url !== this.url) this.onRouteChange(url);
  }

  private onRouteChange(url: string) {
    this.url = url;
    this.closePopover(false);
    this.renumber();
    this.updateCount();
    void this.loadComments();
  }

  private scheduleLayout() {
    if (this.raf || this.destroyed) return;
    this.raf = this.win.requestAnimationFrame(() => {
      this.raf = 0;
      this.layout();
    });
  }

  private layout() {
    const view = this.view;
    const popover = this.popover;
    if (!view || !popover) return;
    const vp = { width: this.win.innerWidth, height: this.win.innerHeight };

    // hover + selection
    const hover = this.hoverEl && this.hoverEl.isConnected && this.hoverEl !== this.selectedEl ? this.hoverEl : null;
    view.showHover(hover ? rectOf(hover) : null, hover ? describeTag(hover) : '');
    const sel = this.selectedEl && this.selectedEl.isConnected ? rectOf(this.selectedEl) : null;

    // pins
    const resolveAll = this.dirty;
    this.dirty = false;
    let viewingRect: Rect | null = null;
    for (const c of this.pageComments()) {
      if (!c.pin) continue;
      if (resolveAll || !c.el || !c.el.isConnected) {
        if (!c.el || !c.el.isConnected) c.el = resolveSelector(c.payload.target.selector, this.doc);
      }
      const r = c.el ? rectOf(c.el) : null;
      if (!r || (r.width === 0 && r.height === 0)) {
        c.pin.hidden = true;
        if (popover.viewing === c.payload.id) popover.close();
        continue;
      }
      c.pin.hidden = (c.payload.status === 'resolved' && !this.showResolved && popover.viewing !== c.payload.id);
      const left = Math.max(r.left, r.left + r.width - 14);
      const top = r.top - 10;
      c.pin.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      if (popover.viewing === c.payload.id) {
        viewingRect = r;
      }
    }

    // selection frame: the element being commented on, or the one whose comment is open
    view.showSelection(sel ?? (popover.mode === 'view' ? viewingRect : null));

    // popover
    if (popover.mode === 'compose' && sel) popover.position(sel, vp);
    else if (popover.mode === 'compose' && !this.selectedEl?.isConnected) {
      /* element vanished: keep the popover where it was so the draft is not lost */
    } else if (popover.mode === 'view' && viewingRect) popover.position(viewingRect, vp); // next to the element, not over it
  }
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function describeTag(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  else if (el.classList.length) s += `.${Array.from(el.classList).slice(0, 2).join('.')}`;
  const r = el.getBoundingClientRect();
  return `${s}  ${Math.round(r.width)}×${Math.round(r.height)}`;
}

let current: Controller | null = null;

/**
 * Mount the widget. Calling it again destroys the previous instance first.
 */
export function initFeedback(options: FeedbackOptions = {}): FeedbackInstance {
  if (typeof document === 'undefined') {
    // SSR: return an inert instance
    const noop = () => {};
    return { open: noop, close: noop, toggle: noop, isOpen: () => false, update: noop, getComments: () => [], showComments: noop, openThread: () => false, getUnreadCount: () => 0, destroy: noop };
  }
  current?.destroy();
  current = new Controller(options);
  return current.api;
}

/** Comparable snapshot of what the widget shows (ignores playback URLs). */
function fingerprint(p: FeedbackPayload): string {
  return JSON.stringify(p, (k, v) => (k === 'url' && typeof v === 'string' ? '' : v));
}

/** Fresh server data, but keep playback URLs we already had for the same attachments. */
function keepUrls(old: FeedbackPayload, fresh: FeedbackPayload): FeedbackPayload {
  const known = new Map<string, string>();
  for (const a of old.attachments ?? []) if (a.url) known.set(a.id, a.url);
  for (const r of old.replies ?? []) for (const a of r.attachments ?? []) if (a.url) known.set(a.id, a.url);
  if (!known.size) return fresh;
  const fill = (list?: FeedbackAttachment[]) => list?.map((a) => (a.url || !known.has(a.id) ? a : { ...a, url: known.get(a.id) }));
  return {
    ...fresh,
    ...(fresh.attachments ? { attachments: fill(fresh.attachments) } : {}),
    ...(fresh.replies ? { replies: fresh.replies.map((r) => (r.attachments ? { ...r, attachments: fill(r.attachments) } : r)) } : {}),
  };
}
