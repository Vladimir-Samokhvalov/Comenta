import { afterEach, describe, expect, it, vi } from 'vitest';
import { initFeedback } from '../../src';
import type { FeedbackPayload } from '../../src';
import { DEFAULT_LABELS } from '../../src/ui/labels';
import { dayLabel } from '../../src/ui/thread';

describe('dayLabel', () => {
  const now = new Date(2026, 10, 10, 12, 0);
  it('today, yesterday, a date, a date with the year', () => {
    expect(dayLabel(new Date(2026, 10, 10, 1, 0).toISOString(), DEFAULT_LABELS, now)).toBe('Сегодня');
    expect(dayLabel(new Date(2026, 10, 9, 23, 0).toISOString(), DEFAULT_LABELS, now)).toBe('Вчера');
    expect(dayLabel(new Date(2026, 10, 3, 9, 0).toISOString(), DEFAULT_LABELS, now)).toBe('3 ноября');
    expect(dayLabel(new Date(2025, 10, 3, 9, 0).toISOString(), DEFAULT_LABELS, now)).toMatch(/^3 ноября 2025/);
  });
});

describe('thread side panel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function comment(id: string, selector: string, text: string, createdAt: string): FeedbackPayload {
    return {
      id,
      text,
      createdAt,
      page: { url: location.href, title: '', viewport: { w: 1, h: 1 }, userAgent: '' },
      target: { selector, tag: 'button', textSnippet: '', rect: { x: 0, y: 0, w: 10, h: 10 }, attributes: {} },
      author: { id: 'anna', name: 'Анна' },
      replies: [{ id: `${id}-r`, commentId: id, text: 'ответ', createdAt: '2026-11-09T10:00:00Z', author: { id: 'me', name: 'Я' } }],
    };
  }

  it('expands next to the comment list, switches threads from the list, collapses back to the pin', async () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    for (const el of document.querySelectorAll('button')) {
      el.getBoundingClientRect = () => ({ top: 10, left: 10, width: 40, height: 20, right: 50, bottom: 30, x: 10, y: 10, toJSON: () => ({}) });
      el.scrollIntoView = vi.fn();
    }
    const fb = initFeedback({
      adapter: { submit: async () => {}, list: async () => [comment('c1', '#a', 'Первый\nвторая строка', '2026-11-08T10:00:00Z'), comment('c2', '#b', 'Второй', '2026-11-08T11:00:00Z')] },
      author: { id: 'me', name: 'Я' },
      pollIntervalMs: 0,
    });
    await vi.waitFor(() => expect(fb.getComments()).toHaveLength(2));
    const root = document.querySelector('comenta-feedback')!.shadowRoot!;
    const popover = root.querySelector<HTMLElement>('.ph-popover')!;

    expect(fb.openThread('c1')).toBe(true);
    expect(root.querySelector('.ph-crumb-title')!.textContent).toBe('Первый');
    expect(root.querySelector('.ph-day')).not.toBeNull(); // the reply is on another day
    expect(root.querySelector('.ph-side')).toBeNull();

    root.querySelector<HTMLButtonElement>('.ph-expand')!.click();
    expect(popover.classList.contains('ph-popover-expanded')).toBe(true);
    expect(root.querySelector('.ph-side .ph-item-active')!.getAttribute('data-id')).toBe('c1');

    root.querySelector<HTMLButtonElement>('.ph-side .ph-item[data-id="c2"]')!.click();
    expect(popover.classList.contains('ph-popover-expanded')).toBe(true);
    expect(root.querySelector('.ph-crumb-title')!.textContent).toBe('Второй');
    expect(root.querySelector('.ph-side .ph-item-active')!.getAttribute('data-id')).toBe('c2');

    root.querySelector<HTMLButtonElement>('.ph-expand')!.click();
    expect(popover.classList.contains('ph-popover-expanded')).toBe(false);
    expect(root.querySelector('.ph-side')).toBeNull();
    expect(root.querySelector('.ph-crumb-title')!.textContent).toBe('Второй');
    fb.destroy();
  });
});
