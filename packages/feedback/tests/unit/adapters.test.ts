import { describe, expect, it, vi } from 'vitest';
import { consoleAdapter, httpAdapter } from '../../src/adapters';
import type { FeedbackPayload } from '../../src/types';
import { SeenStore } from '../../src/core/identity';

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

  it('picks up comments saved under the old PinHelp key and keeps them under the new one', async () => {
    localStorage.clear();
    localStorage.setItem('pinhelp:feedback', JSON.stringify([payload('https://x.test/a', 'old')]));
    const a = consoleAdapter({ log: false });
    expect((await a.list!('https://x.test/a')).map((p) => p.id)).toEqual(['old']);
    await a.submit(payload('https://x.test/a', 'new'));
    expect(JSON.parse(localStorage.getItem('comenta:feedback')!).map((p: { id: string }) => p.id)).toEqual(['old', 'new']);
  });

  it('works without storage', async () => {
    const a = consoleAdapter({ log: false, storage: false });
    await a.submit(payload());
    expect(await a.list!('https://x.test/page')).toEqual([]);
  });
});

describe('attachments', () => {
  const att = { id: 'a1', kind: 'audio' as const, name: 'voice-a1.webm', mimeType: 'audio/webm', size: 4, durationMs: 1200 };
  const withAtt = () => ({ ...payload(), attachments: [att] });

  it('httpAdapter sends multipart with payload + files and returns server URLs', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ attachments: { a1: '/uploads/a1.webm' } }), { status: 201 }));
    const blob = new Blob(['abcd'], { type: 'audio/webm' });
    const result = await httpAdapter({ endpoint: '/e', fetch }).submit(withAtt(), [{ attachment: att, blob }]);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    const form = init.body as FormData;
    expect(JSON.parse(form.get('payload') as string).attachments[0].id).toBe('a1');
    const file = form.get('file:a1') as File;
    expect(file.name).toBe('voice-a1.webm');
    expect(file.size).toBe(4);
    expect(result).toEqual({ attachmentUrls: { a1: '/uploads/a1.webm' } });
  });

  it('consoleAdapter inlines small recordings as data URLs and skips big ones', async () => {
    localStorage.clear();
    const a = consoleAdapter({ log: false, maxInlineBytes: 10 });
    const small = await a.submit(withAtt(), [{ attachment: att, blob: new Blob(['abcd'], { type: 'audio/webm' }) }]);
    expect((small as { attachmentUrls: Record<string, string> }).attachmentUrls.a1).toMatch(/^data:audio\/webm;base64,/);
    const big = { ...att, id: 'a2' };
    const res = await a.submit({ ...payload('https://x.test/page', '2'), attachments: [big] }, [{ attachment: big, blob: new Blob(['x'.repeat(50)]) }]);
    expect(res).toBeUndefined();
    const list = await a.list!('https://x.test/page');
    expect(list[0].attachments![0].url).toMatch(/^data:/);
    expect(list[1].attachments![0].url).toBeUndefined();
  });
});

describe('threads in adapters', () => {
  const reply = (id: string, text = 'ответ') => ({ id, commentId: '1', text, createdAt: '2026-11-03T10:00:00.000Z', author: { id: 'anna', name: 'Анна' } });

  it('httpAdapter uses REST routes for replies and status, and reads lists', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(init.method === 'GET' ? JSON.stringify({ items: [payload()] }) : '{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const a = httpAdapter({ endpoint: '/api/f', fetch });
    await a.reply!('c 1', reply('r1'));
    await a.updateReply!('c 1', 'r1', { text: 'x', updatedAt: 't' });
    await a.deleteReply!('c 1', 'r1');
    await a.setStatus!('c 1', { status: 'resolved', by: { id: 'v' }, at: 't' });
    const list = await a.list!('https://x.test/page?q=1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/f/c%201/replies',
      'PATCH /api/f/c%201/replies/r1',
      'DELETE /api/f/c%201/replies/r1',
      'PATCH /api/f/c%201',
      'GET /api/f?url=https%3A%2F%2Fx.test%2Fpage%3Fq%3D1',
    ]);
    expect(calls[3].body).toEqual({ status: 'resolved', by: { id: 'v' }, at: 't' });
    expect(list).toHaveLength(1);
    expect(httpAdapter({ endpoint: '/e', list: false }).list).toBeUndefined();
  });

  it('consoleAdapter stores replies, edits, deletes and status', async () => {
    localStorage.clear();
    const a = consoleAdapter({ log: false });
    await a.submit(payload('https://x.test/a', '1'));
    await a.reply!('1', reply('r1'));
    await a.reply!('1', reply('r2'));
    await a.updateReply!('1', 'r1', { text: 'исправлено', updatedAt: 't' });
    await a.deleteReply!('1', 'r2');
    await a.setStatus!('1', { status: 'resolved', by: { id: 'v', name: 'В' }, at: 't2' });
    let [c] = await a.list!('https://x.test/a');
    expect(c.replies).toEqual([{ ...reply('r1'), text: 'исправлено', updatedAt: 't' }]);
    expect(c).toMatchObject({ status: 'resolved', resolvedBy: { id: 'v', name: 'В' }, resolvedAt: 't2' });
    await a.setStatus!('1', { status: 'open', by: { id: 'v' }, at: 't3' });
    [c] = await a.list!('https://x.test/a');
    expect(c.status).toBe('open');
    expect(c.resolvedBy).toBeUndefined();
  });
});

describe('unread', () => {
  const base = payload('https://x.test/a', 'c1');
  const at = (m: number) => `2026-11-03T10:${String(m).padStart(2, '0')}:00.000Z`;

  it('counts replies by others after the thread was last opened, per user', () => {
    localStorage.clear();
    const anna = { id: 'anna', name: 'Анна' };
    const owner = { id: 'v', name: 'В', role: 'owner' as const };
    const mine = { ...base, author: anna, createdAt: at(0) };
    const annaSeen = new SeenStore(window, 'anna');
    expect(annaSeen.isUnread(mine, anna)).toBe(false); // own fresh comment
    expect(new SeenStore(window, 'v').isUnread(mine, owner)).toBe(true); // owner has not opened it
    expect(new SeenStore(window, 'bob').isUnread(mine, { id: 'bob' })).toBe(false); // not involved

    const answered = { ...mine, replies: [{ id: 'r', commentId: 'c1', text: 'ok', createdAt: at(5), author: owner }] };
    expect(annaSeen.isUnread(answered, anna)).toBe(true);
    annaSeen.markSeen(answered);
    expect(annaSeen.isUnread(answered, anna)).toBe(false);
    const more = { ...answered, replies: [...answered.replies, { id: 'r2', commentId: 'c1', text: 'и ещё', createdAt: at(9), author: owner }] };
    expect(annaSeen.isUnread(more, anna)).toBe(true);
    // my own new reply does not make it unread
    const self = { ...answered, replies: [...answered.replies, { id: 'r3', commentId: 'c1', text: 'спасибо', createdAt: at(9), author: anna }] };
    expect(annaSeen.isUnread(self, anna)).toBe(false);
  });
});
