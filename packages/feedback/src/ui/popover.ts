import type { FeedbackKind, FeedbackLabels } from '../types';
import { placePopover } from '../core/position';
import { h } from './h';
import type { RecordConfig } from './record';
import type { Recording } from '../core/recorder';
import type { Rect } from './view';
import { Composer } from './composer';
import { Thread, type ThreadHandlers, type ThreadModel } from './thread';

const KINDS: FeedbackKind[] = ['question', 'suggestion', 'bug'];
const FOCUSABLE =
  'button:not([disabled]):not([hidden]), textarea:not([disabled]), input:not([disabled]):not([hidden]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])';

export interface PopoverHandlers {
  onSubmit: (kind: FeedbackKind | null, text: string, recording: Recording | null, name: string) => void;
  onCancel: () => void;
}

export type PopoverMode = 'compose' | 'view';

/** The popover dialog: the comment form, or a comment thread. */
export class Popover {
  readonly el: HTMLDivElement;
  mode: PopoverMode | null = null;
  /** id of the comment shown in view mode */
  viewing: string | null = null;
  thread: Thread | null = null;
  private composer: Composer | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private kind: FeedbackKind | null = null;
  private submitting = false;
  /** Set by the controller: re-run positioning when the popover changes size. */
  reposition: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    private readonly labels: FeedbackLabels,
    private readonly handlers: PopoverHandlers,
    private readonly record: RecordConfig | null = null,
    /** Where the screen-recording control strip is rendered (outside the popover). */
    private readonly dockHost: HTMLElement | null = null,
    private readonly onDock: (docked: boolean) => void = () => {},
  ) {
    this.el = h(doc, 'div', { class: 'ph-popover', role: 'dialog', 'aria-label': labels.dialog, hidden: true });
    this.el.addEventListener('keydown', this.onKeyDown);
    // Keep typing inside the widget from reaching page-level (bubble) shortcuts.
    for (const t of ['keydown', 'keyup', 'keypress']) this.el.addEventListener(t, (e) => e.stopPropagation());
    parent.append(this.el);
  }

  get isOpen() {
    return this.mode !== null;
  }

  /** True while a screen recording runs and the form is tucked away. */
  get docked() {
    return !!(this.composer?.docked || this.thread?.composer?.docked);
  }

  openCompose(askName = false) {
    if (this.mode === 'compose') {
      this.composer?.focus();
      return;
    }
    this.reset();
    const d = this.doc;
    this.mode = 'compose';
    this.el.setAttribute('aria-label', this.labels.dialog);
    this.el.classList.remove('ph-popover-thread');

    // Optional category: three emoji toggles, at most one pressed; clicking the pressed one clears it.
    const kinds = h(d, 'div', { class: 'ph-kinds', role: 'group', 'aria-label': this.labels.kindGroup });
    const buttons: HTMLButtonElement[] = [];
    for (const k of KINDS) {
      const b = h(d, 'button', { type: 'button', class: 'ph-kind', 'data-kind': k, 'aria-pressed': 'false', 'aria-label': this.labels.kinds[k], title: this.labels.kinds[k] }, [
        this.labels.kindEmoji[k],
      ]);
      b.addEventListener('click', () => {
        this.kind = this.kind === k ? null : k;
        for (const o of buttons) o.setAttribute('aria-pressed', String(o.dataset.kind === this.kind));
        kinds.toggleAttribute('data-picked', this.kind !== null);
      });
      buttons.push(b);
    }
    kinds.append(...buttons);
    kinds.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(e.target as HTMLButtonElement);
      if (i < 0) return;
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      buttons[(i + step + buttons.length) % buttons.length].focus();
    });

    const composer = new Composer(d, {
      labels: this.labels,
      record: this.record,
      placeholder: this.labels.placeholder,
      ariaLabel: this.labels.textarea,
      askName,
      dockHost: this.dockHost,
      onDock: this.onDock,
      onChange: () => this.syncSubmit(),
      reposition: () => this.reposition?.(),
    });
    this.composer = composer;

    const cancelBtn = h(d, 'button', { type: 'button', class: 'ph-btn', 'aria-label': this.labels.cancel }, [this.labels.cancel]);
    cancelBtn.addEventListener('click', () => this.handlers.onCancel());
    this.submitBtn = h(d, 'button', { type: 'button', class: 'ph-btn ph-btn-primary', 'aria-label': this.labels.submit, title: isMac(d) ? '⌘↵' : 'Ctrl+↵', disabled: true }, [
      this.labels.submit,
    ]);
    this.submitBtn.addEventListener('click', () => this.trySubmit());

    this.el.replaceChildren(...composer.nodes, h(d, 'div', { class: 'ph-actions' }, [kinds, cancelBtn, this.submitBtn]));
    this.el.hidden = false;
    composer.focus();
  }

  openThread(model: ThreadModel, handlers: ThreadHandlers) {
    this.reset();
    this.mode = 'view';
    this.viewing = model.payload.id;
    this.el.setAttribute('aria-label', this.labels.thread);
    this.el.classList.add('ph-popover-thread');
    this.thread = new Thread(
      this.doc,
      { labels: this.labels, record: this.record, dockHost: this.dockHost, onDock: this.onDock, reposition: () => this.reposition?.() },
      model,
      handlers,
    );
    this.el.replaceChildren(...this.thread.nodes);
    this.el.hidden = false;
    this.thread.focus();
  }

  /** Esc: cancel a recording, then reply editing; true if something was cancelled. */
  handleEscape(): boolean {
    if (this.composer?.cancelRecording() || this.thread?.composer?.cancelRecording()) return true;
    return this.thread?.handleEscape() ?? false;
  }

  close() {
    this.reset();
    this.el.hidden = true;
  }

  private reset() {
    this.composer?.dispose();
    this.thread?.dispose();
    this.composer = null;
    this.thread = null;
    this.submitBtn = null;
    this.mode = null;
    this.viewing = null;
    this.kind = null;
    this.submitting = false;
    this.el.removeAttribute('aria-busy');
    this.el.replaceChildren();
  }

  setSubmitting(on: boolean) {
    this.submitting = on;
    if (!this.submitBtn || !this.composer) return;
    this.submitBtn.textContent = on ? this.labels.submitting : this.labels.submit;
    this.el.setAttribute('aria-busy', String(on));
    this.composer.setBusy(on);
  }

  setError(message: string | null) {
    this.composer?.setError(message);
  }

  focus() {
    if (this.composer) this.composer.focus();
    else if (this.thread) this.thread.focus();
    else this.focusables()[0]?.focus({ preventScroll: true });
  }

  position(anchor: Rect, viewport: { width: number; height: number }) {
    const w = this.el.offsetWidth || 344;
    const hgt = this.el.offsetHeight || 180;
    const p = placePopover(anchor, { width: w, height: hgt }, viewport);
    this.el.style.transform = `translate(${p.left}px, ${p.top}px)`;
    this.el.setAttribute('data-side', p.side);
  }

  focusables(): HTMLElement[] {
    return Array.from(this.el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.parentElement?.closest('[hidden]'));
  }

  private trySubmit() {
    const c = this.composer;
    if (this.submitting || !c || !c.ready) return;
    c.setError(null);
    this.handlers.onSubmit(this.kind, c.text, c.recording, c.name);
  }

  private syncSubmit() {
    if (!this.submitBtn || !this.composer) return;
    this.submitBtn.disabled = this.submitting || !this.composer.ready;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (this.mode === 'compose') this.trySubmit();
      else this.thread?.submitShortcut(e.composedPath()[0] ?? e.target);
      return;
    }
    if (e.key === 'Tab') {
      // focus trap
      const items = this.focusables();
      if (!items.length) return;
      const active = (this.el.getRootNode() as ShadowRoot).activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      const next = e.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1) : idx === items.length - 1 ? 0 : idx + 1;
      e.preventDefault();
      items[next].focus();
    }
  };
}

function isMac(d: Document) {
  return /Mac|iPhone|iPad/.test(d.defaultView?.navigator.platform ?? '');
}
