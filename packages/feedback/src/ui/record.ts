import type { FeedbackAttachment, FeedbackAttachmentKind, FeedbackLabels } from '../types';
import { formatDuration, Recorder, type Recording } from '../core/recorder';
import { closeIcon, h, micIcon, redoIcon, screenIcon, stopIcon, trashIcon } from './h';

export interface RecordConfig {
  audio: boolean;
  screen: boolean;
  maxMs: number;
}

const HOLD_MS = 350;

/** Native <audio>/<video> with a workaround for MediaRecorder WebM files that report `duration: Infinity`. */
export function mediaPlayer(doc: Document, kind: FeedbackAttachmentKind, src: string, label: string): HTMLMediaElement {
  const el = kind === 'audio' ? h(doc, 'audio', { class: 'ph-audio', controls: true, preload: 'metadata', 'aria-label': label }) : h(doc, 'video', { class: 'ph-video', controls: true, preload: 'metadata', playsinline: true, 'aria-label': label });
  el.addEventListener('loadedmetadata', () => {
    if (el.duration === Infinity) {
      const reset = () => {
        el.removeEventListener('timeupdate', reset);
        el.currentTime = 0;
      };
      el.addEventListener('timeupdate', reset);
      el.currentTime = 1e101;
    }
  });
  el.src = src;
  return el;
}

/**
 * Telegram-style record button + recording bar + preview.
 *   click         → switch voice ⇄ screen (when both are available)
 *   hold (350 ms) → start recording in the current mode
 * Owns the Recorder and the preview object URL; `dispose()` releases both.
 */
export class RecordControl {
  readonly button: HTMLButtonElement;
  readonly area: HTMLDivElement;
  mode: FeedbackAttachmentKind;
  result: Recording | null = null;
  private recorder: Recorder | null = null;
  private previewUrl: string | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private holding = false;
  private pressed = false;
  private timeEl: HTMLSpanElement | null = null;
  private barEl: HTMLSpanElement | null = null;

  constructor(
    private readonly doc: Document,
    private readonly cfg: RecordConfig,
    private readonly labels: FeedbackLabels,
    /** Called whenever recording / result changes (sync the submit button). */
    private readonly onChange: () => void,
    private readonly onError: (message: string | null) => void,
  ) {
    this.mode = cfg.audio ? 'audio' : 'screen';
    this.button = h(doc, 'button', { type: 'button', class: 'ph-rec-btn' });
    this.area = h(doc, 'div', { class: 'ph-rec-area', hidden: true });
    this.renderButton();
    const b = this.button;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.press();
    });
    b.addEventListener('pointerup', () => this.release());
    b.addEventListener('pointerleave', () => this.pressed && !this.holding && this.abortPress());
    b.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        this.press();
      }
    });
    b.addEventListener('keyup', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.release();
      }
    });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get recording() {
    return !!this.recorder;
  }

  get canToggle() {
    return this.cfg.audio && this.cfg.screen;
  }

  /** Start in a given mode programmatically (also used by "redo"). */
  start(mode: FeedbackAttachmentKind = this.mode) {
    if (this.recorder) return;
    this.discard();
    this.onError(null);
    this.mode = mode;
    this.renderButton();
    const rec = new Recorder(this.doc.defaultView ?? window, mode, this.cfg.maxMs, {
      onTick: (ms) => this.tick(ms),
      onDone: (r) => {
        this.recorder = null;
        this.result = r;
        this.renderPreview();
        this.onChange();
      },
      onError: (err) => {
        this.recorder = null;
        this.area.hidden = true;
        this.button.hidden = false;
        this.onError(err === 'denied' ? this.labels.recDenied : this.labels.recFailed);
        this.onChange();
      },
    });
    this.recorder = rec;
    this.renderRecording();
    this.onChange();
    void rec.start();
  }

  stop() {
    this.recorder?.stop();
  }

  /** Cancel an in-progress recording. Returns true if there was one. */
  cancel(): boolean {
    if (!this.recorder) return false;
    this.recorder.cancel();
    this.recorder = null;
    this.area.hidden = true;
    this.area.replaceChildren();
    this.button.hidden = false;
    this.onChange();
    this.button.focus({ preventScroll: true });
    return true;
  }

  /** Drop the recorded result (and its preview). */
  discard() {
    this.result = null;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
    this.area.hidden = true;
    this.area.replaceChildren();
    this.button.hidden = false;
  }

  dispose() {
    clearTimeout(this.holdTimer);
    this.recorder?.cancel();
    this.recorder = null;
    this.discard();
  }

  // ------------------------------------------------------------- button gestures

  private press() {
    if (this.recorder) return;
    this.pressed = true;
    this.holding = false;
    this.button.classList.add('ph-pressing');
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holding = true;
      this.button.classList.remove('ph-pressing');
      this.start();
    }, HOLD_MS);
  }

  private release() {
    if (!this.pressed) return;
    this.pressed = false;
    clearTimeout(this.holdTimer);
    this.button.classList.remove('ph-pressing');
    if (this.holding) return; // recording continues until Stop
    if (this.canToggle) {
      this.mode = this.mode === 'audio' ? 'screen' : 'audio';
      this.renderButton();
    } else {
      this.start();
    }
  }

  private abortPress() {
    this.pressed = false;
    clearTimeout(this.holdTimer);
    this.button.classList.remove('ph-pressing');
  }

  // ------------------------------------------------------------- rendering

  private renderButton() {
    const d = this.doc;
    const label = this.mode === 'audio' ? this.labels.recVoice : this.labels.recScreen;
    this.button.replaceChildren(this.mode === 'audio' ? micIcon(d) : screenIcon(d));
    this.button.setAttribute('data-mode', this.mode);
    this.button.setAttribute('aria-label', `${label}: ${this.canToggle ? this.labels.recHint : this.labels.recHint.split(';')[0]}`);
    this.button.title = `${label} — ${this.canToggle ? this.labels.recHint : this.labels.recHint.split(';')[0]}`;
  }

  private renderRecording() {
    const d = this.doc;
    this.button.hidden = true;
    this.timeEl = h(d, 'span', { class: 'ph-rec-time', 'aria-live': 'off' }, ['0:00']);
    this.barEl = h(d, 'span', { class: 'ph-rec-progress-fill' });
    const stop = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-rec-stop', 'aria-label': this.labels.recStop, title: this.labels.recStop }, [stopIcon(d)]);
    stop.addEventListener('click', () => this.stop());
    const cancel = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-rec-cancel', 'aria-label': this.labels.recCancel, title: this.labels.recCancel }, [closeIcon(d)]);
    cancel.addEventListener('click', () => this.cancel());
    this.area.replaceChildren(
      h(d, 'div', { class: 'ph-rec-bar', role: 'status' }, [
        h(d, 'span', { class: 'ph-rec-dot', 'aria-hidden': 'true' }),
        h(d, 'span', { class: 'ph-rec-mode' }, [this.mode === 'audio' ? this.labels.recVoiceLabel : this.labels.recScreenLabel]),
        this.timeEl,
        h(d, 'span', { class: 'ph-rec-progress', 'aria-hidden': 'true' }, [this.barEl]),
        cancel,
        stop,
      ]),
    );
    this.area.hidden = false;
    stop.focus({ preventScroll: true });
  }

  private tick(ms: number) {
    if (this.timeEl) this.timeEl.textContent = `${formatDuration(ms)} / ${formatDuration(this.cfg.maxMs)}`;
    if (this.barEl) this.barEl.style.width = `${Math.min(100, (ms / this.cfg.maxMs) * 100)}%`;
  }

  private renderPreview() {
    const r = this.result;
    if (!r) return;
    const d = this.doc;
    this.previewUrl = URL.createObjectURL(r.blob);
    const redo = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-rec-redo', 'aria-label': this.labels.recRedo, title: this.labels.recRedo }, [redoIcon(d)]);
    redo.addEventListener('click', () => this.start(r.kind));
    const del = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-rec-delete', 'aria-label': this.labels.recDelete, title: this.labels.recDelete }, [trashIcon(d)]);
    del.addEventListener('click', () => {
      this.discard();
      this.onChange();
      this.button.focus({ preventScroll: true });
    });
    const notes: string[] = [];
    if (r.noMic) notes.push(this.labels.recNoMic);
    if (r.hitLimit) notes.push(this.labels.recLimit);
    this.area.replaceChildren(
      h(d, 'div', { class: `ph-rec-preview ph-rec-preview-${r.kind}` }, [
        mediaPlayer(d, r.kind, this.previewUrl, r.kind === 'audio' ? this.labels.recVoice : this.labels.recScreen),
        h(d, 'div', { class: 'ph-rec-row' }, [
          h(d, 'span', { class: 'ph-rec-info' }, [`${r.kind === 'audio' ? this.labels.recVoiceLabel : this.labels.recScreenLabel} · ${formatDuration(r.durationMs)}`]),
          redo,
          del,
        ]),
        ...notes.map((n) => h(d, 'div', { class: 'ph-rec-note' }, [n])),
      ]),
    );
    this.area.hidden = false;
    this.button.hidden = true;
  }
}

/** Player list for the read-only view of a sent comment. */
export function attachmentsView(doc: Document, attachments: FeedbackAttachment[], labels: FeedbackLabels): HTMLElement {
  return h(
    doc,
    'div',
    { class: 'ph-attachments' },
    attachments.map((a) => {
      const label = a.kind === 'audio' ? labels.recVoice : labels.recScreen;
      const info = h(doc, 'span', { class: 'ph-rec-info' }, [`${a.kind === 'audio' ? labels.recVoiceLabel : labels.recScreenLabel} · ${formatDuration(a.durationMs)}`]);
      return h(doc, 'div', { class: `ph-rec-preview ph-rec-preview-${a.kind}`, 'data-attachment': a.id }, [
        a.url ? mediaPlayer(doc, a.kind, a.url, label) : h(doc, 'div', { class: 'ph-rec-note' }, [labels.recMissing]),
        h(doc, 'div', { class: 'ph-rec-row' }, [info]),
      ]);
    }),
  );
}
