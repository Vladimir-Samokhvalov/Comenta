import type {
  FeedbackAdapter,
  FeedbackInstance,
  FeedbackKind,
  FeedbackLabels,
  FeedbackOptions,
  FeedbackPayload,
} from '../types';
import { consoleAdapter } from '../adapters/console';
import { resolveSelector } from '../selector';
import { DEFAULT_IGNORE_SELECTOR, describeTarget } from '../selector/sanitize';
import { DEFAULT_LABELS } from '../ui/labels';
import { Popover } from '../ui/popover';
import { View, type Rect } from '../ui/view';
import { h } from '../ui/h';
import { normalizeUrl } from './url';
import { uuid } from './uuid';

interface StoredComment {
  payload: FeedbackPayload;
  el: Element | null;
  pin: HTMLButtonElement | null;
}

type Off = () => void;

const CURSOR_STYLE_ID = 'pinhelp-feedback-cursor';
const MUTATION_THROTTLE_MS = 100;
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
    this.labels = { ...DEFAULT_LABELS, ...options.labels, kinds: { ...DEFAULT_LABELS.kinds, ...options.labels?.kinds } };
    this.url = normalizeUrl(this.win.location.href);

    this.api = {
      open: () => this.setActive(true),
      close: () => this.setActive(false),
      toggle: () => this.setActive(!this.active),
      isOpen: () => this.active,
      update: (o) => this.update(o),
      getComments: () => this.comments.map((c) => c.payload),
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
      onToggle: () => this.setActive(!this.active),
    });
    this.popover = new Popover(this.doc, this.view.root, this.labels, {
      onSubmit: (kind, text) => void this.submit(kind, text),
      onCancel: () => this.closePopover(true),
    });

    const relayout = () => this.scheduleLayout();
    this.globalOffs.push(
      this.listen(this.doc, 'scroll', relayout, { capture: true, passive: true }),
      // resize is only dispatched on window
      this.listen(this.win, 'resize', relayout, { passive: true }),
      this.listen(this.win, 'popstate', () => this.onMutations(), {}),
      this.listen(this.win, 'hashchange', () => this.onMutations(), {}),
      this.listen(this.doc, 'keydown', this.onKeyDown as EventListener, { capture: true }),
      this.listen(this.doc, 'focusin', this.onFocusIn as EventListener, { capture: true }),
    );

    const MO = (this.win as Window & typeof globalThis).MutationObserver;
    if (MO) {
      this.observer = new MO((records) => {
        if (records.every((r) => this.isOwnMutation(r))) return;
        this.onMutations();
      });
      this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    }

    this.updateCount();
    void this.loadComments();
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
    this.observer?.disconnect();
    this.observer = null;
    if (this.raf) this.win.cancelAnimationFrame(this.raf);
    clearTimeout(this.mutationTimer);
    this.view?.destroy();
    this.view = null;
    this.popover = null;
    this.comments = [];
    this.hoverEl = this.selectedEl = null;
    if (current === this) current = null;
  }

  private update(o: Partial<FeedbackOptions>) {
    if (o.adapter) this.adapter = o.adapter;
    if ('author' in o) this.options.author = o.author;
    if ('onSubmit' in o) this.options.onSubmit = o.onSubmit;
    if ('onError' in o) this.options.onError = o.onError;
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
      const opts = { capture: true };
      this.modeOffs.push(this.listen(this.doc, 'mousemove', this.onPointerMove as EventListener, { capture: true, passive: true }));
      this.modeOffs.push(this.listen(this.doc, 'mouseout', this.onPointerOut as EventListener, { capture: true, passive: true }));
      for (const t of BLOCKED_EVENTS) this.modeOffs.push(this.listen(this.doc, t, this.onBlocked, opts));
      this.modeOffs.push(this.listen(this.doc, 'submit', this.onBlocked, opts));
      this.setCursor(true);
    } else {
      for (const off of this.modeOffs.splice(0)) off();
      this.setCursor(false);
      this.hoverEl = null;
      this.view.showHover(null);
      if (this.popover?.mode === 'compose') this.closePopover(false);
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
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (this.popover?.isOpen) {
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

  /** Focus trap: focus must not leave an open popover. */
  private onFocusIn = (e: FocusEvent) => {
    if (!this.popover?.isOpen || !this.view) return;
    if (e.composedPath().includes(this.popover.el)) return;
    this.popover.focus();
  };

  // ---------------------------------------------------------------- selection & popover

  private select(el: Element) {
    if (!this.popover || !this.view) return;
    this.syncUrl();
    this.selectedEl = el;
    this.selectedSnapshot = describeTarget(el, this.ignoreSelector);
    if (this.popover.mode !== 'compose') this.popover.openCompose();
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
    this.popover.openView(c.payload, this.pageComments().indexOf(c) + 1);
    this.layout();
  }

  // ---------------------------------------------------------------- submit

  private buildPayload(kind: FeedbackKind, text: string): FeedbackPayload | null {
    const el = this.selectedEl;
    const target = el && el.isConnected ? describeTarget(el, this.ignoreSelector) : this.selectedSnapshot;
    if (!target) return null;
    const nav = this.win.navigator;
    const payload: FeedbackPayload = {
      id: uuid(),
      kind,
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
    const author = this.options.author;
    if (author && (author.id || author.name)) payload.author = { ...author };
    return payload;
  }

  private async submit(kind: FeedbackKind, text: string) {
    const popover = this.popover;
    if (!popover || !this.view) return;
    const payload = this.buildPayload(kind, text);
    if (!payload) return;
    const el = this.selectedEl;
    popover.setSubmitting(true);
    try {
      await this.adapter.submit(payload);
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
    this.addComment(payload, el);
    this.closePopover(true);
    this.view.showToast(this.labels.sent);
    this.options.onSubmit?.(payload);
  }

  // ---------------------------------------------------------------- comments & pins

  private async loadComments() {
    if (!this.adapter.list) return;
    const url = this.url;
    try {
      const list = await this.adapter.list(this.win.location.href);
      if (this.destroyed || url !== this.url) return;
      for (const p of list) if (!this.comments.some((c) => c.payload.id === p.id)) this.addComment(p, null, false);
      this.comments.sort((a, b) => a.payload.createdAt.localeCompare(b.payload.createdAt));
      this.renumber();
      this.updateCount();
      this.dirty = true;
      this.scheduleLayout();
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
        const pin = h(this.doc, 'button', { type: 'button', class: 'ph-pin', 'data-kind': c.payload.kind, hidden: true });
        pin.addEventListener('click', () => this.openComment(c));
        this.view.pinLayer.append(pin);
        c.pin = pin;
      }
      c.pin.textContent = String(n);
      c.pin.setAttribute('aria-label', this.labels.pin(n));
      c.pin.title = c.payload.text.length > 80 ? `${c.payload.text.slice(0, 79)}…` : c.payload.text;
    }
  }

  private updateCount() {
    this.view?.setCount(this.pageComments().length);
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
    view.showSelection(sel);

    // pins
    const resolveAll = this.dirty;
    this.dirty = false;
    let viewingAnchor: Rect | null = null;
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
      c.pin.hidden = false;
      const left = Math.max(r.left, r.left + r.width - 14);
      const top = r.top - 10;
      c.pin.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      if (popover.viewing === c.payload.id) viewingAnchor = { top, left, width: 24, height: 24 };
    }

    // popover
    if (popover.mode === 'compose' && sel) popover.position(sel, vp);
    else if (popover.mode === 'compose' && !this.selectedEl?.isConnected) {
      /* element vanished: keep the popover where it was so the draft is not lost */
    } else if (popover.mode === 'view' && viewingAnchor) popover.position(viewingAnchor, vp);
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
    return { open: noop, close: noop, toggle: noop, isOpen: () => false, update: noop, getComments: () => [], destroy: noop };
  }
  current?.destroy();
  current = new Controller(options);
  return current.api;
}
