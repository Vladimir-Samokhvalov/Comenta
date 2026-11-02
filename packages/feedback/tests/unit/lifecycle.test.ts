import { afterEach, describe, expect, it, vi } from 'vitest';
import { initFeedback } from '../../src';
import type { FeedbackAdapter } from '../../src';

function trackListeners(target: EventTarget) {
  const live = new Map<string, number>();
  const key = (type: string, opts?: boolean | AddEventListenerOptions) =>
    `${type}:${typeof opts === 'boolean' ? opts : !!opts?.capture}`;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const a = vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, opts) => {
    live.set(key(type, opts), (live.get(key(type, opts)) ?? 0) + 1);
    add(type, fn, opts);
  });
  const r = vi.spyOn(target, 'removeEventListener').mockImplementation((type, fn, opts) => {
    live.set(key(type, opts), (live.get(key(type, opts)) ?? 0) - 1);
    remove(type, fn, opts);
  });
  return {
    count: () => [...live.values()].reduce((s, n) => s + n, 0),
    restore: () => {
      a.mockRestore();
      r.mockRestore();
    },
  };
}

const noopAdapter: FeedbackAdapter = { submit: async () => {} };

describe('lifecycle', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('destroy() removes all DOM and listeners; re-init works', () => {
    const doc = trackListeners(document);
    const win = trackListeners(window);
    const fb = initFeedback({ adapter: noopAdapter });
    expect(document.querySelectorAll('pinhelp-feedback').length).toBe(1);
    fb.open();
    expect(fb.isOpen()).toBe(true);
    expect(document.getElementById('pinhelp-feedback-cursor')).not.toBeNull();
    expect(doc.count()).toBeGreaterThan(0);

    fb.destroy();
    expect(document.querySelectorAll('pinhelp-feedback').length).toBe(0);
    expect(document.getElementById('pinhelp-feedback-cursor')).toBeNull();
    expect(doc.count()).toBe(0);
    expect(win.count()).toBe(0);

    const fb2 = initFeedback({ adapter: noopAdapter });
    expect(document.querySelectorAll('pinhelp-feedback').length).toBe(1);
    fb2.destroy();
    expect(doc.count()).toBe(0);
    doc.restore();
    win.restore();
  });

  it('a second initFeedback replaces the first', () => {
    initFeedback({ adapter: noopAdapter });
    const fb = initFeedback({ adapter: noopAdapter });
    expect(document.querySelectorAll('pinhelp-feedback').length).toBe(1);
    fb.destroy();
  });

  it('enabled: false renders nothing', () => {
    const fb = initFeedback({ adapter: noopAdapter, enabled: false });
    expect(document.querySelectorAll('pinhelp-feedback').length).toBe(0);
    fb.open();
    expect(fb.isOpen()).toBe(false);
    fb.destroy();
  });

  it('blocks clicks in comment mode and restores them after', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    const onClick = vi.fn();
    document.getElementById('b')!.addEventListener('click', onClick);
    const fb = initFeedback({ adapter: noopAdapter });
    fb.open();
    document.getElementById('b')!.click();
    expect(onClick).not.toHaveBeenCalled();
    const host = document.querySelector('pinhelp-feedback')!;
    expect(host.shadowRoot!.querySelector('.ph-popover')!.hasAttribute('hidden')).toBe(false);
    fb.close();
    document.getElementById('b')!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    fb.destroy();
  });
});
