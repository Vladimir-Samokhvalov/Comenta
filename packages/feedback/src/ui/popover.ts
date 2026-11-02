import type { FeedbackKind, FeedbackLabels, FeedbackPayload } from '../types';
import { placePopover } from '../core/position';
import { h } from './h';
import { attachmentsView, RecordControl, type RecordConfig } from './record';
import type { Recording } from '../core/recorder';
import type { Rect } from './view';

const KINDS: FeedbackKind[] = ['question', 'suggestion', 'bug'];
const FOCUSABLE =
  'button:not([disabled]):not([hidden]), textarea:not([disabled]), input:not([disabled]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])';

export interface PopoverHandlers {
  onSubmit: (kind: FeedbackKind | null, text: string, recording: Recording | null) => void;
  onCancel: () => void;
}

export type PopoverMode = 'compose' | 'view';

/** The popover dialog: compose form or read-only view of a sent comment. */
export class Popover {
  readonly el: HTMLDivElement;
  mode: PopoverMode | null = null;
  /** id of the comment shown in view mode */
  viewing: string | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private errorEl: HTMLDivElement | null = null;
  private kind: FeedbackKind | null = null;
  private submitting = false;
  private rec: RecordControl | null = null;
  /** True while a screen recording runs and the form is tucked away. */
  docked = false;

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

  openCompose() {
    if (this.mode === 'compose') {
      this.textarea?.focus();
      return;
    }
    const d = this.doc;
    this.mode = 'compose';
    this.viewing = null;
    this.submitting = false;
    this.kind = null;

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

    const ta = h(d, 'textarea', { class: 'ph-textarea', rows: 3, 'aria-label': this.labels.textarea, placeholder: this.labels.placeholder });
    ta.addEventListener('input', () => {
      this.autoGrow();
      this.syncSubmit();
    });
    this.textarea = ta;

    this.errorEl = h(d, 'div', { class: 'ph-error', role: 'alert', hidden: true });

    const isMac = /Mac|iPhone|iPad/.test(d.defaultView?.navigator.platform ?? '');
    this.cancelBtn = h(d, 'button', { type: 'button', class: 'ph-btn', 'aria-label': this.labels.cancel }, [this.labels.cancel]);
    this.cancelBtn.addEventListener('click', () => this.handlers.onCancel());
    this.submitBtn = h(d, 'button', { type: 'button', class: 'ph-btn ph-btn-primary', 'aria-label': this.labels.submit, title: isMac ? '⌘↵' : 'Ctrl+↵', disabled: true }, [
      this.labels.submit,
    ]);
    this.submitBtn.addEventListener('click', () => this.trySubmit());

    const actions = h(d, 'div', { class: 'ph-actions' }, [
      kinds,
      this.cancelBtn,
      this.submitBtn,
    ]);

    if (this.record) {
      this.rec = new RecordControl(
        d,
        this.record,
        this.labels,
        () => {
          this.syncSubmit();
          this.reposition?.();
        },
        (msg) => this.setError(msg),
        this.dockHost,
        (docked) => {
          this.docked = docked;
          this.onDock(docked);
          if (!docked) this.rec?.focusResult(this.textarea);
        },
      );
    }

    // The record button lives inside the text field, in its bottom-right corner.
    const field = h(d, 'div', { class: 'ph-field' }, [ta]);
    if (this.rec) {
      field.setAttribute('data-rec', '');
      field.append(this.rec.button);
    }

    this.el.replaceChildren(field, ...(this.rec ? [this.rec.area] : []), this.errorEl, actions);
    this.el.hidden = false;
    ta.focus({ preventScroll: true });
  }

  openView(payload: FeedbackPayload, n: number) {
    const d = this.doc;
    this.mode = 'view';
    this.viewing = payload.id;
    this.textarea = this.submitBtn = this.cancelBtn = null;
    this.errorEl = null;
    const close = h(d, 'button', { type: 'button', class: 'ph-btn', 'aria-label': this.labels.close }, [this.labels.close]);
    close.addEventListener('click', () => this.handlers.onCancel());
    let when = '';
    try {
      when = new Date(payload.createdAt).toLocaleString();
    } catch {
      /* ignore */
    }
    const text = payload.text ? h(d, 'div', { class: 'ph-view-text', tabindex: 0 }, [payload.text]) : null;
    const media = payload.attachments?.length ? attachmentsView(d, payload.attachments, this.labels) : null;
    this.el.replaceChildren(
      h(d, 'div', { class: 'ph-view-head' }, [
        h(d, 'span', { class: 'ph-badge' }, [payload.kind ? `#${n} · ${this.labels.kindEmoji[payload.kind]} ${this.labels.kinds[payload.kind]}` : `#${n}`]),
        h(d, 'span', { class: 'ph-meta' }, [when]),
      ]),
      ...(text ? [text] : []),
      ...(media ? [media] : []),
      h(d, 'div', { class: 'ph-actions' }, [close]),
    );
    this.el.hidden = false;
    close.focus({ preventScroll: true });
  }

  /** Cancel an in-progress recording; true if there was one (Esc handling). */
  cancelRecording(): boolean {
    return this.rec?.cancel() ?? false;
  }

  /** Set by the controller: re-run positioning when the popover changes size. */
  reposition: (() => void) | null = null;

  close() {
    this.rec?.dispose();
    this.rec = null;
    this.docked = false;
    this.mode = null;
    this.viewing = null;
    this.textarea = this.submitBtn = this.cancelBtn = null;
    this.errorEl = null;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  setSubmitting(on: boolean) {
    this.submitting = on;
    if (!this.submitBtn || !this.textarea) return;
    this.submitBtn.textContent = on ? this.labels.submitting : this.labels.submit;
    this.textarea.readOnly = on;
    this.el.setAttribute('aria-busy', String(on));
    this.syncSubmit();
  }

  setError(message: string | null) {
    if (!this.errorEl) return;
    this.errorEl.textContent = message ?? '';
    this.errorEl.hidden = !message;
    if (message) this.textarea?.focus({ preventScroll: true });
  }

  focus() {
    (this.textarea ?? this.focusables()[0])?.focus({ preventScroll: true });
  }

  position(anchor: Rect, viewport: { width: number; height: number }) {
    const w = this.el.offsetWidth || 344;
    const hgt = this.el.offsetHeight || 180;
    const p = placePopover(anchor, { width: w, height: hgt }, viewport);
    this.el.style.transform = `translate(${p.left}px, ${p.top}px)`;
    this.el.setAttribute('data-side', p.side);
  }

  focusables(): HTMLElement[] {
    return Array.from(this.el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
      // radio group: only the checked radio is in the tab sequence
      return !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked);
    });
  }

  private trySubmit() {
    if (this.submitting || !this.textarea) return;
    const text = this.textarea.value.trim();
    const recording = this.rec?.result ?? null;
    if ((!text && !recording) || this.rec?.recording) return;
    this.setError(null);
    this.handlers.onSubmit(this.kind, text, recording);
  }

  private syncSubmit() {
    if (!this.submitBtn || !this.textarea) return;
    this.submitBtn.disabled =
      this.submitting || !!this.rec?.recording || (this.textarea.value.trim() === '' && !this.rec?.result);
  }

  private autoGrow() {
    const ta = this.textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && this.mode === 'compose') {
      e.preventDefault();
      this.trySubmit();
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
