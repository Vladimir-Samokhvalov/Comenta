import { describe, expect, it } from 'vitest';
import { extensionFor, formatDuration, pickMimeType, recordingSupport } from '../../src/core/recorder';
import { initFeedback } from '../../src';

describe('recorder helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(1499)).toBe('0:01');
    expect(formatDuration(60_000)).toBe('1:00');
  });

  it('maps mime types to extensions', () => {
    expect(extensionFor('audio/webm')).toBe('webm');
    expect(extensionFor('video/webm')).toBe('webm');
    expect(extensionFor('audio/mp4')).toBe('m4a');
    expect(extensionFor('video/mp4')).toBe('mp4');
    expect(extensionFor('audio/ogg')).toBe('ogg');
  });

  it('detects support and picks the first supported mime type', () => {
    const fake = {
      navigator: { mediaDevices: { getUserMedia() {}, getDisplayMedia() {} } },
      MediaRecorder: { isTypeSupported: (t: string) => t === 'audio/webm' || t === 'video/webm' },
    } as unknown as Window;
    expect(recordingSupport(fake)).toEqual({ audio: true, screen: true });
    expect(pickMimeType(fake, 'audio')).toBe('audio/webm');
    expect(pickMimeType(fake, 'screen')).toBe('video/webm');
    expect(recordingSupport({ navigator: {} } as unknown as Window)).toEqual({ audio: false, screen: false });
  });

  it('hides the record button when the browser cannot record (jsdom)', () => {
    document.body.innerHTML = '<p id="p">x</p>';
    const fb = initFeedback({ adapter: { submit: async () => {} } });
    fb.open();
    document.getElementById('p')!.click();
    const root = document.querySelector('pinhelp-feedback')!.shadowRoot!;
    expect(root.querySelector('.ph-popover textarea')).not.toBeNull();
    expect(root.querySelector('.ph-rec-btn')).toBeNull();
    fb.destroy();
  });
});
