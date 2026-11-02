import type { FeedbackAttachmentKind } from '../types';

export interface Recording {
  kind: FeedbackAttachmentKind;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  /** Screen recorded without voice because the microphone was not available. */
  noMic: boolean;
  /** Stopped because the duration limit was reached. */
  hitLimit: boolean;
}

export type RecorderError = 'denied' | 'failed';

const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

type MR = typeof MediaRecorder;

function mediaRecorderCtor(win: Window): MR | undefined {
  return (win as unknown as { MediaRecorder?: MR }).MediaRecorder;
}

export function pickMimeType(win: Window, kind: FeedbackAttachmentKind): string {
  const ctor = mediaRecorderCtor(win);
  const list = kind === 'audio' ? AUDIO_TYPES : VIDEO_TYPES;
  if (!ctor || typeof ctor.isTypeSupported !== 'function') return '';
  return list.find((t) => ctor.isTypeSupported(t)) ?? '';
}

/** Which recording modes this browser can do. */
export function recordingSupport(win: Window): { audio: boolean; screen: boolean } {
  const md = win.navigator?.mediaDevices;
  const rec = !!mediaRecorderCtor(win);
  return {
    audio: rec && !!md && typeof md.getUserMedia === 'function',
    screen: rec && !!md && typeof md.getDisplayMedia === 'function',
  };
}

export function extensionFor(mime: string): string {
  if (mime.includes('mp4')) return mime.startsWith('audio') ? 'm4a' : 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

export interface RecorderCallbacks {
  onTick: (elapsedMs: number) => void;
  onDone: (rec: Recording) => void;
  onError: (err: RecorderError, cause: unknown) => void;
}

/**
 * One recording session. `start()` asks for permissions; `stop()` finishes and
 * delivers the blob via `onDone`; `cancel()` drops everything. All tracks are
 * always stopped at the end (also when the user presses the browser's own
 * "Stop sharing" button).
 */
export class Recorder {
  private streams: MediaStream[] = [];
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cancelled = false;
  private hitLimit = false;
  private noMic = false;
  private finished = false;

  constructor(
    private readonly win: Window,
    readonly kind: FeedbackAttachmentKind,
    private readonly maxMs: number,
    private readonly cb: RecorderCallbacks,
  ) {}

  get recording() {
    return !!this.recorder && !this.finished;
  }

  async start(): Promise<void> {
    const md = this.win.navigator.mediaDevices;
    try {
      let stream: MediaStream;
      if (this.kind === 'audio') {
        stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.streams.push(stream);
      } else {
        const screen = await md.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
        this.streams.push(screen);
        let mic: MediaStream | null = null;
        try {
          mic = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          this.streams.push(mic);
        } catch {
          this.noMic = true;
        }
        stream = new MediaStream([...screen.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])]);
        // the browser's "Stop sharing" button ends the video track
        for (const t of screen.getVideoTracks()) t.addEventListener('ended', () => this.stop());
      }
      if (this.cancelled) {
        this.release();
        return;
      }
      const ctor = mediaRecorderCtor(this.win)!;
      const mimeType = pickMimeType(this.win, this.kind);
      const rec = new ctor(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000, videoBitsPerSecond: 1_000_000 } : undefined);
      this.recorder = rec;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      rec.onstop = () => this.finish();
      rec.start(1000);
      this.startedAt = Date.now();
      this.cb.onTick(0);
      this.timer = setInterval(() => {
        const elapsed = Date.now() - this.startedAt;
        this.cb.onTick(Math.min(elapsed, this.maxMs));
        if (elapsed >= this.maxMs) {
          this.hitLimit = true;
          this.stop();
        }
      }, 200);
    } catch (err) {
      this.release();
      if (this.cancelled) return;
      const name = (err as { name?: string })?.name;
      this.cb.onError(name === 'NotAllowedError' || name === 'SecurityError' || name === 'AbortError' ? 'denied' : 'failed', err);
    }
  }

  stop() {
    if (!this.recorder || this.recorder.state === 'inactive') {
      if (!this.recorder) this.cancel();
      return;
    }
    this.recorder.stop();
  }

  cancel() {
    this.cancelled = true;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.release();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    const durationMs = Math.min(Date.now() - this.startedAt, this.maxMs);
    this.release();
    if (this.cancelled) return;
    const mimeType = (this.recorder?.mimeType || pickMimeType(this.win, this.kind) || (this.kind === 'audio' ? 'audio/webm' : 'video/webm')).split(';')[0];
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    this.cb.onDone({ kind: this.kind, blob, mimeType, durationMs, noMic: this.noMic, hitLimit: this.hitLimit });
  }

  private release() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.streams) for (const t of s.getTracks()) t.stop();
    this.streams = [];
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
