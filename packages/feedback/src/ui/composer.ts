import type { FeedbackLabels } from '../types';
import type { Recording } from '../core/recorder';
import { h } from './h';
import { RecordControl, type RecordConfig } from './record';

export interface ComposerOptions {
  labels: FeedbackLabels;
  record: RecordConfig | null;
  placeholder: string;
  ariaLabel: string;
  /** Show a "Your name" field (guest without a remembered name). */
  askName: boolean;
  /** Where the screen-recording strip goes (outside the popover). */
  dockHost: HTMLElement | null;
  onDock: (docked: boolean) => void;
  /** Text, recording or busy state changed. */
  onChange: () => void;
  /** Size changed: re-position the popover. */
  reposition: () => void;
  /** Smaller field (thread replies). */
  compact?: boolean;
}

/**
 * Text field with the record button in its corner, the recording bar / preview under it,
 * an optional guest-name field and an error line. Used by the comment form and thread replies.
 */
export class Composer {
  readonly textarea: HTMLTextAreaElement;
  readonly nameInput: HTMLInputElement | null;
  readonly nodes: HTMLElement[];
  readonly rec: RecordControl | null;
  private readonly errorEl: HTMLDivElement;
  docked = false;
  busy = false;

  constructor(d: Document, private readonly o: ComposerOptions) {
    const ta = h(d, 'textarea', { class: `ph-textarea${o.compact ? ' ph-textarea-compact' : ''}`, rows: o.compact ? 2 : 3, 'aria-label': o.ariaLabel, placeholder: o.placeholder });
    ta.addEventListener('input', () => {
      this.autoGrow();
      o.onChange();
    });
    this.textarea = ta;
    this.errorEl = h(d, 'div', { class: 'ph-error', role: 'alert', hidden: true });
    this.nameInput = o.askName
      ? h(d, 'input', { type: 'text', class: 'ph-name', maxlength: 60, autocomplete: 'name', 'aria-label': o.labels.yourName, placeholder: `${o.labels.yourName} (${o.labels.guest})` })
      : null;

    this.rec = o.record
      ? new RecordControl(
          d,
          o.record,
          o.labels,
          () => {
            o.onChange();
            o.reposition();
          },
          (msg) => this.setError(msg),
          o.dockHost,
          (docked) => {
            this.docked = docked;
            o.onDock(docked);
            if (!docked) this.rec?.focusResult(this.textarea);
          },
        )
      : null;

    // The record button lives inside the text field, in its bottom-right corner.
    const field = h(d, 'div', { class: 'ph-field' }, [ta]);
    if (this.rec) {
      field.setAttribute('data-rec', '');
      field.append(this.rec.button);
    }
    this.nodes = [...(this.nameInput ? [this.nameInput] : []), field, ...(this.rec ? [this.rec.area] : []), this.errorEl];
  }

  get text() {
    return this.textarea.value.trim();
  }

  get recording(): Recording | null {
    return this.rec?.result ?? null;
  }

  get name() {
    return this.nameInput?.value.trim() ?? '';
  }

  /** Something to send and nothing in progress. */
  get ready() {
    return !this.busy && !this.rec?.recording && (this.text !== '' || !!this.recording);
  }

  setBusy(on: boolean) {
    this.busy = on;
    this.textarea.readOnly = on;
    this.o.onChange();
  }

  setError(message: string | null) {
    this.errorEl.textContent = message ?? '';
    this.errorEl.hidden = !message;
    if (message) this.textarea.focus({ preventScroll: true });
    this.o.reposition();
  }

  /** After a successful send. */
  clear() {
    this.textarea.value = '';
    this.rec?.discard();
    this.setError(null);
    this.autoGrow();
    this.o.onChange();
  }

  focus() {
    this.textarea.focus({ preventScroll: true });
  }

  cancelRecording(): boolean {
    return this.rec?.cancel() ?? false;
  }

  dispose() {
    this.rec?.dispose();
    this.docked = false;
  }

  private autoGrow() {
    const ta = this.textarea;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`;
    this.o.reposition();
  }
}
