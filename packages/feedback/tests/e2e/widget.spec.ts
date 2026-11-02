import { expect, test } from '@playwright/test';
import { comment, menuCount, openDemo, viewportBox, widget } from './helpers';

test.describe('comment mode', () => {
  test('happy path: enable → select → write → send → pin', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await w.toggle.click();
    await expect(w.toggle).toHaveAttribute('aria-pressed', 'true');
    // crosshair cursor while active
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).cursor)).toBe('crosshair');

    await page.locator('#table-section td', { hasText: 'Борис' }).click();
    await expect(w.popover).toBeVisible();
    await expect(w.textarea).toBeFocused();
    await expect(w.submit).toBeDisabled();
    await page.locator('pinhelp-feedback .ph-kind[data-kind="bug"]').click();
    await w.textarea.fill('Статус Бориса неверный');
    await expect(w.submit).toBeEnabled();

    const req = page.waitForRequest((r) => r.url().endsWith('/api/feedback') && r.method() === 'POST');
    const res = page.waitForResponse((r) => r.url().endsWith('/api/feedback'));
    await w.submit.click();
    const payload = (await req).postDataJSON();
    expect((await res).status()).toBe(201);

    // payload schema
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.kind).toBe('bug');
    expect(payload.text).toBe('Статус Бориса неверный');
    expect(new Date(payload.createdAt).toISOString()).toBe(payload.createdAt);
    expect(payload.page).toMatchObject({ url: expect.stringContaining('localhost'), title: expect.any(String), userAgent: expect.any(String) });
    expect(payload.page.viewport).toEqual({ w: 1280, h: 800 });
    expect(payload.target.tag).toBe('td');
    expect(payload.target.textSnippet).toBe('Борис');
    expect(payload.target.rect).toEqual({ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });
    expect(payload.author).toEqual({ id: 'demo', name: 'Демо-пользователь' });
    const same = await page.evaluate((sel) => {
      const found = document.querySelectorAll(sel);
      return found.length === 1 && found[0].textContent === 'Борис';
    }, payload.target.selector);
    expect(same).toBe(true);

    await expect(w.popover).toBeHidden();
    await expect(w.toast).toHaveText('Отправлено');
    await expect(w.pins).toHaveCount(1);
    await expect(w.pins.first()).toBeVisible();
    await expect(w.pins.first()).toHaveText('1');
    expect(await menuCount(page)).toBe('1');

    // pin opens read-only view
    await w.pins.first().click();
    await expect(w.popover).toContainText('Статус Бориса неверный');
    await expect(w.textarea).toHaveCount(0);

    // the commented element is framed while its comment is open, and the frame follows it
    const td = page.locator('#table-section td', { hasText: 'Борис' });
    const frameMatches = async () => {
      const f = (await w.selBox.boundingBox())!;
      const e = (await td.boundingBox())!;
      return Math.abs(f.x - e.x) < 2 && Math.abs(f.y - e.y) < 2 && Math.abs(f.width - e.width) < 2;
    };
    await expect(w.selBox).toBeVisible();
    expect(await frameMatches()).toBe(true);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(100);
    expect(await frameMatches()).toBe(true);
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.waitForTimeout(100);
    expect(await frameMatches()).toBe(true);
    await page.locator('pinhelp-feedback .ph-popover .ph-btn').click(); // «Закрыть»
    await expect(w.popover).toBeHidden();
    await expect(w.selBox).toBeHidden();
  });

  test('highlight follows the cursor and ignores the widget', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').hover();
    await expect(w.hoverBox).toBeVisible();
    const box = await w.hoverBox.boundingBox();
    const target = await page.locator('#inc').boundingBox();
    expect(Math.abs(box!.x - target!.x)).toBeLessThan(2);
    expect(Math.abs(box!.width - target!.width)).toBeLessThan(2);
    await expect(page.locator('pinhelp-feedback .ph-tag')).toContainText('button#inc');

    await w.toggle.hover();
    await expect(w.hoverBox).toBeHidden();

    // ignored subtree is never highlighted itself
    await page.locator('.pii').hover();
    await expect(page.locator('pinhelp-feedback .ph-tag')).not.toContainText('p.pii');
  });

  test('clicks do nothing in comment mode and work again afterwards', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    await page.locator('#nav-away').click();
    await page.locator('#submit-form').click();
    await page.locator('[data-testid="top-right-btn"]').click();
    await expect(page.locator('#counter')).toHaveText('0');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await page.evaluate(() => (window as any).__submitted ?? 0)).toBe(0);
    expect(await page.evaluate(() => (window as any).__clicks ?? 0)).toBe(0);

    await page.keyboard.press('Escape'); // close popover
    await page.keyboard.press('Escape'); // leave mode
    await expect(w.toggle).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#inc').click();
    await expect(page.locator('#counter')).toHaveText('1');
    await page.locator('#submit-form').click();
    expect(await page.evaluate(() => (window as any).__submitted)).toBe(1);
  });

  for (const [name, selector] of [
    ['top-right edge', '[data-testid="top-right-btn"]'],
    ['left edge', '#edge-left'],
    ['bottom edge', '#edge-bottom'],
    ['element taller than the screen', '#tall'],
  ] as const) {
    test(`popover stays on screen: ${name}`, async ({ page }) => {
      await openDemo(page);
      const w = widget(page);
      if (selector === '#tall') await page.locator('#tall').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await w.toggle.click();
      await page.locator(selector).click({ position: selector === '#tall' ? { x: 50, y: 50 } : undefined });
      await expect(w.popover).toBeVisible();
      await page.waitForTimeout(50);
      const box = (await w.popover.boundingBox())!;
      const vp = await viewportBox(page);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    });
  }

  test('keyboard: Ctrl+Enter sends, Esc closes popover then leaves mode, focus returns', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#buttons h2').click();
    await w.textarea.fill('С клавиатуры');
    const req = page.waitForRequest((r) => r.url().endsWith('/api/feedback'));
    await page.keyboard.press('Control+Enter');
    await req;
    await expect(w.popover).toBeHidden();
    await expect(w.toggle).toBeFocused();

    await page.locator('#buttons h2').click();
    await expect(w.textarea).toBeFocused();
    // focus trap
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('PINHELP-FEEDBACK');
    await page.keyboard.press('Escape');
    await expect(w.popover).toBeHidden();
    await expect(w.toggle).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(w.toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('re-clicking another element keeps the draft', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#buttons h2').click();
    await w.textarea.fill('черновик');
    await page.locator('#table-section h2').click();
    await expect(w.textarea).toHaveValue('черновик');
  });
});

test.describe('payload', () => {
  test('selector resolves to exactly the clicked element (UI flow)', async ({ page }) => {
    await openDemo(page);
    const cases = [
      '#inc',
      '#buttons .card:nth-child(2) button',
      '#table-section tbody tr:nth-child(3) td:nth-child(2)',
      '#signup',
      '#top-left-link',
      '#dynamic [data-feedback-id="removable"]',
      'main > h1',
      '#anchor p',
    ];
    for (const [i, sel] of cases.entries()) {
      // the element actually under the cursor at the click point (may be a child of `sel`)
      await page.locator(sel).first().scrollIntoViewIfNeeded();
      const b = (await page.locator(sel).first().boundingBox())!;
      await page.evaluate(({ x, y }) => ((window as any).__expected = document.elementFromPoint(x, y)), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const payload = await comment(page, sel, `case ${i}`);
      const ok = await page.evaluate((built) => {
        const found = document.querySelectorAll(built);
        return found.length === 1 && found[0] === (window as any).__expected;
      }, payload.target.selector);
      expect(ok, `${sel} → ${payload.target.selector}`).toBe(true);
      expect(payload.target.selector).not.toMatch(/__a1B2c|css-1x2y3z/);
    }
  });

  test('selector round-trips for every element on the demo page', async ({ page }) => {
    await openDemo(page);
    const failures = await page.evaluate(async () => {
      const { buildSelector } = await import('/dist/index.js' as string);
      const bad: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        if (el.tagName === 'PINHELP-FEEDBACK') continue;
        const sel = buildSelector(el);
        const found = document.querySelectorAll(sel);
        if (found.length !== 1 || found[0] !== el) bad.push(`${el.tagName} → ${sel}`);
      }
      return bad;
    });
    expect(failures).toEqual([]);
  });

  test('form values never leak into the payload', async ({ page }) => {
    await openDemo(page);
    await page.locator('#email').fill('typed-secret@example.com');
    const secrets = ['secret@example.com', 'typed-secret', 'TOP-SECRET-BIO', 'SECRET-CITY', 'SECRET-EDITABLE', 'SECRET-PASSPORT'];
    for (const sel of ['#signup', '#email', '#bio', '#city', '#editor', '#form-section']) {
      const payload = await comment(page, sel, 'privacy');
      const json = JSON.stringify(payload);
      for (const s of secrets) expect(json, `${sel} leaked ${s}`).not.toContain(s);
    }
  });
});

test.describe('errors', () => {
  test('unreachable endpoint keeps the text, shows the error, retry works', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    let fail = true;
    await page.route('**/api/feedback', (route) => (fail ? route.abort('connectionrefused') : route.fallback()));
    await w.toggle.click();
    await page.locator('#inc').click();
    await w.textarea.fill('Не потеряй меня');
    await w.submit.click();
    await expect(w.error).toBeVisible();
    await expect(w.error).toContainText('Не удалось отправить');
    await expect(w.textarea).toHaveValue('Не потеряй меня');
    await expect(w.pins).toHaveCount(0);

    // server error too
    await page.unroute('**/api/feedback');
    await page.route('**/api/feedback', (route) => (fail ? route.fulfill({ status: 500 }) : route.fallback()));
    await w.submit.click();
    await expect(w.error).toContainText('500');
    await expect(w.textarea).toHaveValue('Не потеряй меня');

    fail = false;
    await w.submit.click();
    await expect(w.popover).toBeHidden();
    await expect(w.toast).toHaveText('Отправлено');
    await expect(w.pins).toHaveCount(1);
  });
});

test.describe('pins', () => {
  async function pinOffset(page: import('@playwright/test').Page, target: string) {
    const pin = (await widget(page).pins.first().boundingBox())!;
    const el = (await page.locator(target).boundingBox())!;
    return { dx: pin.x - (el.x + el.width), dy: pin.y - el.y };
  }

  test('pins stay attached on scroll, resize, layout shift; hide and return with the element', async ({ page }) => {
    await openDemo(page);
    const target = '[data-feedback-id="removable"]';
    await comment(page, target, 'Пин на динамическом блоке');
    await page.keyboard.press('Escape');
    const w = widget(page);
    await expect(w.pins.first()).toBeVisible();
    const base = await pinOffset(page, target);

    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(100);
    expect(await pinOffset(page, target)).toEqual(base);

    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(100);
    expect(await pinOffset(page, target)).toEqual(base);

    await page.locator('#shift-layout').click();
    await page.waitForTimeout(250);
    expect(await pinOffset(page, target)).toEqual(base);

    await page.locator('#toggle-target').click(); // remove
    await expect(w.pins.first()).toBeHidden();
    expect(await menuCount(page)).toBe('1'); // comment is not lost

    await page.locator('#toggle-target').click(); // re-add (new node)
    await expect(w.pins.first()).toBeVisible();
    await page.waitForTimeout(50);
    expect(await pinOffset(page, target)).toEqual(base);
  });

  test('pins are per page in an SPA', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await page.locator('#route-a').click();
    await comment(page, '#route-view', 'На странице A');
    await page.keyboard.press('Escape');
    await expect(w.pins.first()).toBeVisible();
    await page.locator('#route-b').click();
    await expect(w.pins).toHaveCount(0);
    expect(await menuCount(page)).toBe('0');
    await page.goBack();
    await expect(w.pins).toHaveCount(1);
  });

  test('console adapter restores pins after reload', async ({ page }) => {
    await page.goto('/?adapter=console');
    await page.evaluate(() => localStorage.clear());
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    await w.textarea.fill('сохранится');
    await w.submit.click();
    await expect(w.pins).toHaveCount(1);
    await page.reload();
    await expect(w.pins).toHaveCount(1);
    await expect(w.pins.first()).toBeVisible();
  });
});

test.describe('lifecycle & isolation', () => {
  test('destroy() removes everything and re-init works', async ({ page }) => {
    await openDemo(page);
    await widget(page).toggle.click();
    await page.evaluate(() => (window as any).fb.destroy());
    await expect(page.locator('pinhelp-feedback')).toHaveCount(0);
    await expect(page.locator('#pinhelp-feedback-cursor')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).cursor)).not.toBe('crosshair');
    await page.locator('#inc').click();
    await expect(page.locator('#counter')).toHaveText('1');

    await page.evaluate(async () => {
      const { initFeedback, consoleAdapter } = await import('/dist/index.js' as string);
      (window as any).fb = initFeedback({ adapter: consoleAdapter({ log: false }) });
    });
    await expect(page.locator('pinhelp-feedback')).toHaveCount(1);
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    await w.textarea.fill('after re-init');
    await w.submit.click();
    await expect(w.pins).toHaveCount(1);
  });

  test('hostile page styles do not break the widget', async ({ page }) => {
    await openDemo(page);
    await page.locator('#hostile-toggle').check();
    const w = widget(page);
    await expect(w.toggle).toBeVisible();
    const t = await w.toggle.evaluate((el) => {
      const s = getComputedStyle(el);
      const bar = getComputedStyle(el.parentElement!);
      return { w: s.width, h: s.height, border: s.borderStyle, bg: bar.backgroundColor, pos: bar.position, barBorder: bar.borderStyle, radius: bar.borderRadius };
    });
    expect(t).toEqual({ w: '36px', h: '36px', border: 'none', bg: 'rgb(255, 255, 255)', pos: 'fixed', barBorder: 'solid', radius: '12px' });
    await w.toggle.click();
    await page.locator('#inc').click();
    await expect(w.popover).toBeVisible();
    const ta = await w.textarea.evaluate((el) => getComputedStyle(el).fontSize);
    expect(ta).toBe('14px');
    const pop = (await w.popover.boundingBox())!;
    expect(Math.round(pop.width)).toBe(320);
  });

  test('script tag build auto-initialises from data attributes', async ({ page }) => {
    await page.goto('/demo/script-tag.html');
    const w = widget(page);
    await expect(w.toggle).toBeVisible();
    await expect(w.bar).toHaveClass(/ph-pos-bottom-left/);
    page.on('dialog', () => {
      throw new Error('click was not blocked');
    });
    const payload = await comment(page, '#btn', 'через script');
    expect(payload.author).toEqual({ name: 'Гость' });
    expect(payload.target.selector).toBe('#btn');
  });
});

test.describe('toolbar menu & comments panel', () => {
  test('chevron menu: show all comments, jump to a comment, hide pins', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await comment(page, '#inc', 'Первый');
    await comment(page, '#anchor p', 'Второй, внизу страницы');
    await page.keyboard.press('Escape');
    await page.evaluate(() => scrollTo(0, 0));

    await w.more.click();
    await expect(w.more).toHaveAttribute('aria-expanded', 'true');
    await expect(w.menu).toBeVisible();
    await expect(page.locator('pinhelp-feedback .ph-mi-all')).toContainText('Показать все комментарии');
    await expect(page.locator('pinhelp-feedback .ph-mi-all .ph-mi-extra')).toHaveText('2');
    await expect(page.locator('pinhelp-feedback .ph-mi-all')).toBeFocused();

    await page.locator('pinhelp-feedback .ph-mi-all').click();
    await expect(w.menu).toBeHidden();
    await expect(w.panel).toBeVisible();
    await expect(w.items).toHaveCount(2);
    await expect(w.items.nth(1)).toContainText('Второй, внизу страницы');

    // jump to the comment below the fold
    await w.items.nth(1).click();
    await expect(w.panel).toBeHidden();
    await expect(page.locator('#anchor p')).toBeInViewport();
    await expect(w.popover).toContainText('Второй, внизу страницы');
    await expect(w.selBox).toBeVisible();
    const f = (await w.selBox.boundingBox())!;
    const e = (await page.locator('#anchor p').boundingBox())!;
    expect(Math.abs(f.y - e.y)).toBeLessThan(2);
    await page.keyboard.press('Escape');
    await expect(w.selBox).toBeHidden();

    // hide / show pins
    await w.more.click();
    await page.locator('pinhelp-feedback .ph-mi-pins').click();
    await expect(w.pins.first()).toBeHidden();
    await w.more.click();
    await expect(page.locator('pinhelp-feedback .ph-mi-pins')).toContainText('Показать пины');
    await page.locator('pinhelp-feedback .ph-mi-pins').click();
    await expect(w.pins.last()).toBeVisible();
  });

  test('panel marks missing elements and lists other pages under "All"', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await comment(page, '[data-feedback-id="removable"]', 'На блоке');
    await page.keyboard.press('Escape');
    await page.locator('#toggle-target').click(); // remove the element
    await page.locator('#route-a').click();
    await comment(page, '#route-view', 'Со страницы A');
    await page.keyboard.press('Escape');
    await page.goBack();

    await page.evaluate(() => (window as any).fb.showComments());
    await expect(w.panel).toBeVisible();
    await expect(w.items).toHaveCount(1);
    await expect(w.items.first()).toHaveClass(/ph-item-missing/);
    await expect(w.items.first()).toContainText('элемент не найден');

    await page.locator('pinhelp-feedback .ph-tab[data-tab="all"]').click();
    await expect(w.items).toHaveCount(2);
    await expect(w.items.first()).toContainText('/app/a');

    // outside click closes the panel
    await page.locator('main h1').click();
    await expect(w.panel).toBeHidden();
  });

  test('hotkey C toggles comment mode, but not while typing', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await page.locator('main h1').click();
    await page.keyboard.press('c');
    await expect(w.toggle).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('c');
    await expect(w.toggle).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#email').fill('');
    await page.locator('#email').press('c');
    await expect(w.toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#email')).toHaveValue('c');
  });

  test('tooltip on hover', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await w.toggle.hover();
    await expect(page.locator('pinhelp-feedback .ph-tip')).toHaveCSS('opacity', '1');
    await expect(page.locator('pinhelp-feedback .ph-tip')).toContainText('Комментировать');
  });
});
