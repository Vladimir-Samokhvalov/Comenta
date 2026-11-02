import { expect, test, type Page } from '@playwright/test';
import { openDemo, widget } from './helpers';

const rec = (page: Page) => ({
  btn: page.locator('pinhelp-feedback .ph-rec-btn'),
  bar: page.locator('pinhelp-feedback .ph-rec-bar'),
  time: page.locator('pinhelp-feedback .ph-rec-time'),
  stop: page.locator('pinhelp-feedback .ph-rec-stop'),
  cancel: page.locator('pinhelp-feedback .ph-rec-cancel'),
  redo: page.locator('pinhelp-feedback .ph-rec-redo'),
  del: page.locator('pinhelp-feedback .ph-rec-delete'),
  preview: page.locator('pinhelp-feedback .ph-rec-preview'),
  audio: page.locator('pinhelp-feedback .ph-popover audio'),
  video: page.locator('pinhelp-feedback .ph-popover video'),
  note: page.locator('pinhelp-feedback .ph-rec-note'),
});

/** Replace getDisplayMedia with an animated canvas stream; exposes window.__endShare() to emulate "Stop sharing". */
async function stubScreen(page: Page) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia: typeof navigator.mediaDevices.getDisplayMedia };
    md.getDisplayMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 200;
      const ctx = c.getContext('2d')!;
      let f = 0;
      setInterval(() => {
        ctx.fillStyle = `hsl(${(f += 7) % 360} 70% 50%)`;
        ctx.fillRect(0, 0, 320, 200);
      }, 50);
      const stream = c.captureStream(15);
      (window as any).__endShare = () => {
        const t = stream.getVideoTracks()[0];
        t.stop();
        t.dispatchEvent(new Event('ended'));
      };
      return stream;
    };
  });
}

/** Long press (Telegram-style) on the record button. */
async function hold(page: Page) {
  const box = (await rec(page).btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
}

async function openForm(page: Page, query = '') {
  await openDemo(page, query);
  const w = widget(page);
  await w.toggle.click();
  await page.locator('#inc').click();
  await expect(w.popover).toBeVisible();
}

test.describe('recording', () => {
  test('record button sits in the bottom-right corner of the text field; text never runs under it', async ({ page }) => {
    await openForm(page);
    const w = widget(page);
    const r = rec(page);
    await w.textarea.fill('Очень длинный комментарий, '.repeat(12));
    const ta = (await w.textarea.boundingBox())!;
    const b = (await r.btn.boundingBox())!;
    // inside the field, hugging its bottom-right corner
    expect(b.x).toBeGreaterThan(ta.x + ta.width / 2);
    expect(b.x + b.width).toBeLessThanOrEqual(ta.x + ta.width);
    expect(ta.x + ta.width - (b.x + b.width)).toBeLessThan(12);
    expect(b.y + b.height).toBeLessThanOrEqual(ta.y + ta.height);
    expect(ta.y + ta.height - (b.y + b.height)).toBeLessThan(12);
    // padding keeps text clear of the button
    const pad = await w.textarea.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom) };
    });
    expect(pad.right).toBeGreaterThanOrEqual(b.width + 6);
    expect(pad.bottom).toBeGreaterThanOrEqual(b.height);
    await expect(r.btn).toBeVisible();
    // actions row: emojis, cancel, send — no record button there
    const actions = page.locator('pinhelp-feedback .ph-popover .ph-actions');
    await expect(actions.locator('.ph-rec-btn')).toHaveCount(0);
    await expect(actions.locator('.ph-kind')).toHaveCount(3);
    await expect(actions.locator('.ph-btn')).toHaveText(['Отмена', 'Отправить']);
    // focus order: textarea → record button → first emoji
    await w.textarea.focus();
    await page.keyboard.press('Tab');
    await expect(r.btn).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(actions.locator('.ph-kind').first()).toBeFocused();
    // voice recording bar shows below the field without covering it
    await hold(page);
    await expect(r.bar).toBeVisible();
    const bar = (await r.bar.boundingBox())!;
    const ta2 = (await w.textarea.boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(ta2.y + ta2.height);
    await r.cancel.click();
    await expect(r.btn).toBeVisible();
  });

  test('voice: click toggles the mode, hold records, preview, send with multipart, play back from the pin', async ({ page }) => {
    await stubScreen(page);
    await openForm(page);
    const w = widget(page);
    const r = rec(page);

    await expect(r.btn).toHaveAttribute('data-mode', 'audio');
    await r.btn.click();
    await expect(r.btn).toHaveAttribute('data-mode', 'screen');
    await r.btn.click();
    await expect(r.btn).toHaveAttribute('data-mode', 'audio');
    await expect(r.btn).toHaveAttribute('aria-label', /Голосовое сообщение/);

    await hold(page);
    await expect(r.bar).toBeVisible();
    await expect(w.submit).toBeDisabled(); // no sending while recording
    await expect(r.time).toContainText('/ 1:00');
    await page.waitForTimeout(1300);
    await expect(r.time).toContainText('0:01');
    await r.stop.click();

    await expect(r.preview).toBeVisible();
    await expect(r.audio).toHaveCount(1);
    await expect(r.btn).toBeHidden();
    await expect(w.submit).toBeEnabled(); // a recording alone is enough

    const req = page.waitForRequest((q) => q.url().endsWith('/api/feedback') && q.method() === 'POST');
    const res = page.waitForResponse((q) => q.url().endsWith('/api/feedback'));
    await w.submit.click();
    const request = await req;
    expect(request.headers()['content-type']).toMatch(/^multipart\/form-data/);
    const body = (await res).status();
    expect(body).toBe(201);
    const json = await (await res).json();
    const [id, url] = Object.entries(json.attachments as Record<string, string>)[0];
    expect(url).toBe(`/uploads/${id}.webm`);

    const payload = await page.evaluate(() => (window as any).__lastPayload);
    expect(payload.text).toBe('');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]).toMatchObject({ id, kind: 'audio', mimeType: 'audio/webm', url });
    expect(payload.attachments[0].durationMs).toBeGreaterThan(900);
    expect(payload.attachments[0].size).toBeGreaterThan(0);

    // the stored file is served back and plays in the comment view
    const file = await page.request.get(url);
    expect(file.ok()).toBe(true);
    expect((await file.body()).length).toBe(payload.attachments[0].size);
    await page.keyboard.press('Escape');
    await w.pins.first().click();
    const player = page.locator('pinhelp-feedback .ph-popover audio');
    await expect(player).toHaveAttribute('src', url);
    await expect.poll(() => player.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0);
  });

  test('screen + mic: records, browser "Stop sharing" ends it, redo and delete work', async ({ page }) => {
    await stubScreen(page);
    await openForm(page);
    const r = rec(page);
    await r.btn.click(); // → screen
    await hold(page);
    await expect(r.bar).toBeVisible();
    await expect(page.locator('pinhelp-feedback .ph-rec-mode')).toHaveText('Экран');
    await page.waitForTimeout(800);
    await page.evaluate(() => (window as any).__endShare());
    await expect(r.video).toHaveCount(1);
    await expect(r.note).toHaveCount(0); // mic was available

    // all capture tracks are released
    // redo starts a fresh recording, delete brings the button back
    await r.redo.click();
    await expect(r.bar).toBeVisible();
    await page.waitForTimeout(600);
    await r.stop.click();
    await expect(r.video).toHaveCount(1);
    await r.del.click();
    await expect(r.preview).toHaveCount(0);
    await expect(r.btn).toBeVisible();
    await expect(widget(page).submit).toBeDisabled();
  });

  test('screen recording tucks the form away: strip at the bottom centre, page usable, form returns with preview', async ({ page }) => {
    await stubScreen(page);
    await openForm(page);
    const w = widget(page);
    const r = rec(page);
    const dock = page.locator('pinhelp-feedback .ph-rec-dock');
    await page.locator('pinhelp-feedback .ph-kind[data-kind="bug"]').click();
    await w.textarea.fill('Смотрите, что происходит');
    await r.btn.click(); // → screen
    await hold(page);

    await expect(dock).toBeVisible();
    await expect(w.popover).toBeHidden();
    await expect(w.bar).toBeHidden(); // the toolbar does not end up in the video
    await expect(w.selBox).toBeVisible(); // the selected element stays framed
    await expect(dock.locator('.ph-rec-stop')).toBeFocused();
    await expect(dock.locator('[role="timer"]')).toContainText('/ 1:00');
    const box = (await dock.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
    expect(vp.height - (box.y + box.height)).toBeLessThan(40);

    // the page can be used normally while recording (no picking, no hover frame, no crosshair)
    await page.locator('#inc').click();
    await expect(page.locator('#counter')).toHaveText('1');
    await page.locator('main h1').hover();
    await expect(w.hoverBox).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).cursor)).not.toBe('crosshair');

    await page.waitForTimeout(500);
    await dock.locator('.ph-rec-stop').click();
    await expect(dock).toHaveCount(0);
    await expect(w.popover).toBeVisible();
    await expect(w.bar).toBeVisible();
    await expect(r.video).toHaveCount(1);
    await expect(r.video).toBeFocused();
    await expect(w.textarea).toHaveValue('Смотрите, что происходит');
    await expect(page.locator('pinhelp-feedback .ph-kind[data-kind="bug"]')).toHaveAttribute('aria-pressed', 'true');

    // picking is back after the recording
    await page.locator('#inc').click();
    await expect(page.locator('#counter')).toHaveText('1');
  });

  test('screen strip: Esc and system "Stop sharing" also bring the form back', async ({ page }) => {
    await stubScreen(page);
    await openForm(page);
    const w = widget(page);
    const r = rec(page);
    const dock = page.locator('pinhelp-feedback .ph-rec-dock');
    await r.btn.click();
    await hold(page);
    await expect(dock).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dock).toHaveCount(0);
    await expect(w.popover).toBeVisible();
    await expect(r.btn).toBeVisible();

    await hold(page);
    await expect(dock).toBeVisible();
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).__endShare());
    await expect(dock).toHaveCount(0);
    await expect(w.popover).toBeVisible();
    await expect(r.video).toHaveCount(1);
  });

  test('voice recording stays inside the form', async ({ page }) => {
    await openForm(page);
    await hold(page);
    await expect(rec(page).bar).toBeVisible();
    await expect(page.locator('pinhelp-feedback .ph-rec-dock')).toHaveCount(0);
    await expect(widget(page).popover).toBeVisible();
    await expect(widget(page).bar).toBeVisible();
  });

  test('Esc cancels a recording first, then closes the form', async ({ page }) => {
    await openForm(page);
    const r = rec(page);
    await hold(page);
    await expect(r.bar).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(r.bar).toBeHidden();
    await expect(widget(page).popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(widget(page).popover).toBeHidden();
  });

  test('microphone denied: error shown, text kept, button back', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await openForm(page);
    const w = widget(page);
    await w.textarea.fill('текст не теряется');
    await hold(page);
    await expect(w.error).toContainText('Нет доступа');
    await expect(w.textarea).toHaveValue('текст не теряется');
    await expect(rec(page).btn).toBeVisible();
  });

  test('screen without mic access records silently with a note', async ({ page }) => {
    await stubScreen(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await openForm(page);
    const r = rec(page);
    await r.btn.click();
    await hold(page);
    await page.waitForTimeout(500);
    await r.stop.click();
    await expect(r.video).toHaveCount(1);
    await expect(r.note).toContainText('без звука');
  });

  test('duration limit stops the recording automatically', async ({ page }) => {
    await page.addInitScript(() => {
      // speed up time for the limit check
      const realNow = Date.now.bind(Date);
      const start = realNow();
      Date.now = () => start + (realNow() - start) * 40;
    });
    await openForm(page);
    const r = rec(page);
    await hold(page);
    await expect(r.preview).toBeVisible({ timeout: 5000 });
    await expect(r.note).toContainText('лимит');
    await expect(page.locator('pinhelp-feedback .ph-rec-info')).toContainText('1:00');
  });

  test('console adapter keeps the recording as a data URL across reloads', async ({ page }) => {
    await page.goto('/?adapter=console');
    await page.evaluate(() => localStorage.clear());
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    await hold(page);
    await page.waitForTimeout(700);
    await rec(page).stop.click();
    await w.submit.click();
    await expect(w.pins).toHaveCount(1);
    await page.reload();
    await w.pins.first().click();
    const src = await page.locator('pinhelp-feedback .ph-popover audio').getAttribute('src');
    expect(src).toMatch(/^data:audio\/webm/);
    await page.evaluate(() => (window as any).fb.showComments());
    await expect(w.items.first()).toContainText('Голос 0:0');
  });

  test('destroy() during recording stops all media tracks', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      (window as any).__tracks = [];
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await orig(c);
        (window as any).__tracks.push(...s.getTracks());
        return s;
      };
    });
    await openForm(page);
    await hold(page);
    await expect(rec(page).bar).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__tracks.length)).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).fb.destroy());
    const states = await page.evaluate(() => (window as any).__tracks.map((t: MediaStreamTrack) => t.readyState));
    expect(states.every((s: string) => s === 'ended')).toBe(true);
  });
});
