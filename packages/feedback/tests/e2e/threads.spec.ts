import { expect, test, type Page } from '@playwright/test';
import { comment, openDemo, signIn, useSpace, widget, type MockUser } from './helpers';

/** Sign in as someone else in the same browser and let the widget re-read the session (an open thread stays open). */
const asUser = async (page: Page, user: MockUser) => {
  await signIn(page, user);
  expect(await page.evaluate(() => (window as unknown as { fb: { refreshSignIn(): Promise<boolean> } }).fb.refreshSignIn())).toBe(true);
};

/** Reply in the open thread (then close it with ✓ when `resolve`); resolves with the POSTed reply. */
async function reply(page: Page, text: string, resolve = false) {
  const w = widget(page);
  await w.replyBox.fill(text);
  const req = page.waitForRequest((r) => /\/api\/feedback\/[^/]+\/replies$/.test(r.url()) && r.method() === 'POST');
  await w.replyBtn.click();
  const body = (await req).postDataJSON();
  await expect(w.replyBox).toHaveValue('');
  if (resolve) await w.resolveBtn.click();
  return body;
}

test.describe('threads', () => {
  test('replies from two people show as Telegram-style bubbles, no avatars', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    const payload = await comment(page, '#inc', 'Почему счётчик растёт на 2?');
    await w.pins.first().click();
    await expect(w.msgs).toHaveCount(1);
    await expect(w.msgs.first()).toHaveClass(/ph-mine/);

    // Anna answers
    await asUser(page, 'anna');
    await expect(w.replyBox).toBeVisible(); // the thread is re-opened for the new user
    await expect(w.msgs.first()).not.toHaveClass(/ph-mine/);
    await expect(w.msgs.first().locator('.ph-msg-name')).toHaveText('Владимир');
    const r = await reply(page, 'Это двойной клик, уточню');
    expect(r).toMatchObject({ commentId: payload.id, text: 'Это двойной клик, уточню', author: { id: 'keycloak:u-anna', name: 'Анна' } });
    await expect(w.msgs).toHaveCount(2);
    await expect(w.msgs.nth(1)).toHaveClass(/ph-mine/);

    // Vladimir sees Anna on the left with her name, himself on the right
    await asUser(page, 'vladimir');
    await expect(w.msgs.nth(1).locator('.ph-msg-name')).toHaveText('Анна');
    await expect(w.msgs.first()).toHaveClass(/ph-mine/);
    await expect(page.locator('comenta-feedback .ph-avatar')).toHaveCount(0);
    const mine = (await w.msgs.first().locator('.ph-bubble').boundingBox())!;
    const theirs = (await w.msgs.nth(1).locator('.ph-bubble').boundingBox())!;
    expect(mine.x).toBeGreaterThan(theirs.x + 20); // mine hugs the right edge

    // stored on the server
    const space = await page.evaluate(() => (window as unknown as { __comentaSpace: string }).__comentaSpace);
    const list = await (await page.request.get('/api/feedback', { headers: { 'X-Comenta-Space': space } })).json();
    expect(list[0].replies).toHaveLength(1);
    expect(list[0].replies[0].text).toBe('Это двойной клик, уточню');

    // and after a reload
    await page.reload();
    await w.pins.first().click();
    await expect(w.msgs).toHaveCount(2);
  });

  test('✓ closes the thread; a later reply keeps it resolved; reopen by button', async ({ page }) => {
    await openDemo(page, '', 'anna');
    const w = widget(page);
    await comment(page, '#inc', 'Кнопка не работает');
    await asUser(page, 'vladimir');
    await w.pins.first().click();
    await expect(w.status).toHaveText('Открыт');
    const statusReq = page.waitForRequest((r) => /\/api\/feedback\/[^/]+$/.test(r.url()) && r.method() === 'PATCH');
    await reply(page, 'Готово, поправили', true);
    expect((await statusReq).postDataJSON()).toMatchObject({ status: 'resolved', by: { id: 'keycloak:u-vladimir', role: 'owner' } });
    await expect(w.status).toHaveText('Закрыт');
    await expect(page.locator('comenta-feedback .ph-event')).toContainText('Вы закрыли');
    await expect(w.resolveBtn).toHaveAttribute('aria-label', 'Открыть снова');

    // a reply into a resolved thread does not reopen it
    await reply(page, 'И ещё обновили текст');
    await expect(w.status).toHaveText('Закрыт');

    // resolved pins are hidden once the thread is closed; the menu shows them
    await page.keyboard.press('Escape');
    await expect(w.popover).toBeHidden();
    await expect(w.pins.first()).toBeHidden();
    await w.more.click();
    await page.locator('comenta-feedback .ph-mi-resolved').click();
    await expect(w.pins.first()).toBeVisible();
    await expect(w.pins.first()).toHaveText('✓');

    // list filters
    await w.more.click();
    await page.locator('comenta-feedback .ph-mi-all').click();
    await expect(w.items).toHaveCount(0); // "Открытые" by default
    await page.locator('comenta-feedback .ph-filter[data-filter="resolved"]').click();
    await expect(w.items).toHaveCount(1);
    await expect(w.items.first().locator('.ph-replies')).toHaveText('2 ответа');
    await w.items.first().click();

    // reopen
    await w.resolveBtn.click();
    await expect(w.status).toHaveText('Открыт');
    await expect(page.locator('comenta-feedback .ph-event')).toHaveCount(0);
  });

  test('only the comment author and the owner can resolve', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await comment(page, '#inc', 'Комментарий Владимира');
    await asUser(page, 'anna');
    await w.pins.first().click();
    await expect(w.replyBox).toBeVisible();
    await expect(w.resolveBtn).toHaveCount(0);
    await page.keyboard.press('Escape');

    await comment(page, '#counter', 'Комментарий Анны');
    await w.pins.nth(1).click();
    await expect(w.resolveBtn).toBeVisible();
  });

  test('edit and delete own replies; others have no tools; Esc leaves editing first', async ({ page }) => {
    await openDemo(page);
    const w = widget(page);
    await comment(page, '#inc', 'Вопрос');
    await w.pins.first().click();
    await reply(page, 'Первая версия ответа');
    const own = w.msgs.nth(1);

    // edit
    await own.hover();
    await own.locator('.ph-msg-edit').click();
    const editor = page.locator('comenta-feedback .ph-edit-text');
    await expect(editor).toBeFocused();
    await editor.fill('Временно');
    await page.keyboard.press('Escape'); // cancels the edit, the thread stays open
    await expect(editor).toHaveCount(0);
    await expect(w.popover).toBeVisible();
    await expect(own).toContainText('Первая версия ответа');

    await own.hover();
    await own.locator('.ph-msg-edit').click();
    await editor.fill('Исправленный ответ');
    const patch = page.waitForRequest((r) => /\/replies\/[^/]+$/.test(r.url()) && r.method() === 'PATCH');
    await page.locator('comenta-feedback .ph-edit-save').click();
    expect((await patch).postDataJSON().text).toBe('Исправленный ответ');
    await expect(own).toContainText('Исправленный ответ');
    await expect(own.locator('.ph-msg-edited')).toHaveText('изменено');

    // someone else's reply has no edit / delete
    await asUser(page, 'anna');
    await reply(page, 'Ответ Анны');
    await asUser(page, 'vladimir');
    await expect(w.msgs.nth(2).locator('.ph-msg-tools')).toHaveCount(0);

    // delete with confirmation
    await w.msgs.nth(1).hover();
    await w.msgs.nth(1).locator('.ph-msg-delete').click();
    await expect(page.locator('comenta-feedback .ph-confirm')).toContainText('Удалить ответ?');
    const del = page.waitForRequest((r) => /\/replies\/[^/]+$/.test(r.url()) && r.method() === 'DELETE');
    await page.locator('comenta-feedback .ph-confirm .ph-btn-danger').click();
    await del;
    await expect(w.msgs).toHaveCount(2);
    await expect(w.feed).not.toContainText('Исправленный ответ');
  });

  test('unread: counter on the toggle, dot on the pin, bold row; cleared when the thread is opened', async ({ page }) => {
    await openDemo(page, '', 'anna');
    const w = widget(page);
    await comment(page, '#inc', 'Где настройки?');
    await expect(w.unread).toBeHidden(); // my own fresh comment is not "new"

    await asUser(page, 'vladimir');
    await expect(w.unread).toHaveText('1'); // owner: someone else's comment he has not opened
    await w.pins.first().click();
    await expect(w.unread).toBeHidden();
    await reply(page, 'В профиле, справа вверху');
    await page.keyboard.press('Escape');

    await asUser(page, 'anna');
    await expect(w.unread).toHaveText('1');
    await expect(w.pins.first()).toHaveAttribute('data-unread', '');
    await w.unread.click(); // opens the list
    await expect(w.items.first()).toHaveClass(/ph-item-unread/);
    await w.items.first().click();
    await expect(page.locator('comenta-feedback .ph-msg-new')).toHaveCount(1);
    await expect(w.unread).toBeHidden();
    await expect(w.pins.first()).not.toHaveAttribute('data-unread', '');
  });

  test('new replies from another browser arrive by polling', async ({ browser }) => {
    const space = `t-${Math.random().toString(36).slice(2)}`;
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    await useSpace(a, space);
    await useSpace(b, space);
    // same page URL in both browsers (comments belong to a URL), a different person signed in in each
    await openDemo(a, '?poll=500', 'anna');
    await comment(a, '#inc', 'Ждём ответа');
    await openDemo(b, '?poll=500', 'vladimir');
    const wb = widget(b);
    await wb.pins.first().click();
    await reply(b, 'Отвечаю из другого браузера');

    const wa = widget(a);
    await expect(wa.unread).toHaveText('1', { timeout: 5000 });
    await wa.pins.first().click();
    await expect(wa.msgs).toHaveCount(2);
    // while the thread is open, the next reply shows up in place
    await reply(b, 'И ещё одно');
    await expect(wa.msgs).toHaveCount(3, { timeout: 5000 });
    await expect(wa.msgs.last()).toContainText('И ещё одно');
    await a.context().close();
    await b.context().close();
  });

  test('without the sign-in option (console adapter) a guest is asked for a name once, then it is remembered', async ({ page }) => {
    await openDemo(page, '?adapter=console', null);
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    const name = page.locator('comenta-feedback .ph-name');
    await expect(name).toBeVisible();
    await name.fill('Ира');
    await w.textarea.fill('Комментарий гостя');
    await w.submit.click();
    await expect(w.pins).toHaveCount(1);
    const payload = await page.evaluate(() => (window as unknown as { __lastPayload: { author: { id: string; name: string } } }).__lastPayload);
    expect(payload.author.name).toBe('Ира');
    expect(payload.author.id).toMatch(/^guest-/);

    await page.locator('#counter').click();
    await expect(w.textarea).toBeVisible();
    await expect(name).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.reload();
    await w.pins.first().click();
    await expect(name).toHaveCount(0);
    await expect(w.msgs.first()).toHaveClass(/ph-mine/);
  });

  test('console adapter keeps replies and status in localStorage', async ({ page }) => {
    await openDemo(page, '?adapter=console');
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    await w.textarea.fill('Локальный комментарий');
    await w.submit.click();
    await expect(w.pins).toHaveCount(1);
    await w.pins.first().click();
    await w.replyBox.fill('Локальный ответ');
    await w.replyBtn.click();
    await expect(w.msgs).toHaveCount(2);
    await w.resolveBtn.click();
    await expect(w.status).toHaveText('Закрыт');
    await page.reload();
    await w.more.click();
    await page.locator('comenta-feedback .ph-mi-resolved').click();
    await w.pins.first().click();
    await expect(w.msgs).toHaveCount(2);
    await expect(w.status).toHaveText('Закрыт');
  });
});
