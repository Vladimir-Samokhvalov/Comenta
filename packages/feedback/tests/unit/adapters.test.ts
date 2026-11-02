import { describe, expect, it, vi } from 'vitest';
import { consoleAdapter, httpAdapter } from '../../src/adapters';
import type { FeedbackPayload } from '../../src/types';

const payload = (url = 'https://x.test/page', id = '1'): FeedbackPayload => ({
  id,
  kind: 'bug',
  text: 't',
  createdAt: new Date().toISOString(),
  page: { url, title: 'T', viewport: { w: 1, h: 1 }, userAgent: 'ua' },
  target: { selector: 'p', tag: 'p', textSnippet: '', rect: { x: 0, y: 0, w: 1, h: 1 }, attributes: {} },
});

describe('httpAdapter', () => {
  it('POSTs JSON with headers', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 201 }));
    await httpAdapter({ endpoint: '/api/f', headers: { Authorization: 'x' }, fetch }).submit(payload());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/f');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('x');
    expect(JSON.parse(init.body as string).id).toBe('1');
  });

  it('supports async header factories', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await httpAdapter({ endpoint: '/e', headers: async () => ({ 'X-Token': 't' }), fetch }).submit(payload());
    expect(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Token']).toBe('t');
  });

  it('rejects on non-2xx and network errors', async () => {
    await expect(httpAdapter({ endpoint: '/e', fetch: async () => new Response(null, { status: 500 }) }).submit(payload())).rejects.toThrow('500');
    await expect(
      httpAdapter({ endpoint: '/e', fetch: async () => Promise.reject(new TypeError('Failed to fetch')) }).submit(payload()),
    ).rejects.toThrow('недоступен');
  });
});

describe('consoleAdapter', () => {
  it('persists and lists by page url (ignoring hash)', async () => {
    localStorage.clear();
    const a = consoleAdapter({ log: false });
    await a.submit(payload('https://x.test/a', '1'));
    await a.submit(payload('https://x.test/b', '2'));
    await a.submit(payload('https://x.test/a#h', '3'));
    const list = await a.list!('https://x.test/a#other');
    expect(list.map((p) => p.id)).toEqual(['1', '3']);
  });

  it('works without storage', async () => {
    const a = consoleAdapter({ log: false, storage: false });
    await a.submit(payload());
    expect(await a.list!('https://x.test/page')).toEqual([]);
  });
});
