import { expect, test } from '@playwright/test';
import { comment, openDemo, signIn, useSpace, widget } from './helpers';

// Visitors sign in through the fake Google / Yandex / Keycloak of demo/auth-mock.mjs.

const payload = (id: string, extra: object = {}) => ({
  id,
  text: 'Проверка',
  target: { selector: '#inc', tag: 'button' },
  page: { url: 'http://localhost/', title: 'Demo', viewport: { w: 1280, h: 800 } },
  createdAt: new Date().toISOString(),
  ...extra,
});

test.describe('sign-in', () => {
  for (const provider of ['Google', 'Яндекс', 'Keycloak']) {
    test(`not signed in: the toggle offers sign-in; ${provider} in a popup, then comment mode`, async ({ page }) => {
      await openDemo(page, '', null);
      const w = widget(page);
      await w.toggle.click();
      await expect(w.signInCard).toBeVisible();
      await expect(page.locator('comenta-feedback .ph-signin-btn')).toHaveText(['Войти через Google', 'Войти через Яндекс', 'Войти через Keycloak']);
      await expect(w.toggle).toHaveAttribute('aria-pressed', 'false'); // no comment mode yet

      const popupP = page.waitForEvent('popup');
      await page.locator('comenta-feedback .ph-signin-btn', { hasText: provider }).click();
      const popup = await popupP;
      await expect(popup).toHaveTitle(/Mock/);
      const closed = popup.waitForEvent('close'); // the popup closes itself right after the callback
      await popup.locator('.mock-user[data-user="anna"]').click();
      await closed;

      await expect(w.signInCard).toBeHidden();
      await expect(w.toggle).toHaveAttribute('aria-pressed', 'true'); // straight into comment mode
      const body = await comment(page, '#inc', 'После входа');
      expect(body.author.name).toBe('Анна');
      await expect(w.pins).toHaveCount(1);
    });
  }

  test('cancel on the provider shows the error in the card', async ({ page }) => {
    await openDemo(page, '', null);
    const w = widget(page);
    await w.toggle.click();
    const popupP = page.waitForEvent('popup');
    await page.locator('comenta-feedback .ph-signin-btn', { hasText: 'Google' }).click();
    const popup = await popupP;
    const closed = popup.waitForEvent('close');
    await popup.locator('#deny').click();
    await closed;
    await expect(page.locator('comenta-feedback .ph-signin-error')).toHaveText('Вход отменён.');
  });

  test('sign out from the menu: comments of the previous user disappear', async ({ page }) => {
    await openDemo(page, '', 'anna');
    const w = widget(page);
    await comment(page, '#inc', 'Мой комментарий');
    await expect(w.pins).toHaveCount(1);
    await w.more.click();
    const out = page.locator('comenta-feedback .ph-mi-signout');
    await expect(out).toContainText('Выйти');
    await expect(out).toContainText('Анна');
    await out.click();
    await expect(w.pins).toHaveCount(0);
    await w.toggle.click();
    await expect(w.signInCard).toBeVisible();
    expect((await page.request.get('/api/auth/me').then((r) => r.json())).user).toBeNull();
  });
});

test.describe('server rules', () => {
  test('every feedback route needs a session', async ({ page }) => {
    await useSpace(page);
    expect((await page.request.get('/api/feedback')).status()).toBe(401);
    expect((await page.request.post('/api/feedback', { data: payload('x1') })).status()).toBe(401);
    expect((await page.request.get('/api/github/status')).status()).toBe(401);
    expect((await page.request.get('/api/gitlab/status')).status()).toBe(401);
  });

  test('the author comes from the session; only the author edits, the owner may delete and resolve', async ({ page, browser }) => {
    const space = { 'X-Comenta-Space': `auth-${Math.random().toString(36).slice(2)}` };
    await signIn(page, 'anna');
    // Anna pretends to be the owner
    const created = await page.request.post('/api/feedback', { data: payload('c-auth-1', { author: { id: 'keycloak:u-vladimir', name: 'Владимир', role: 'owner' } }), headers: space });
    expect(created.status()).toBe(201);
    const list = await (await page.request.get('/api/feedback', { headers: space })).json();
    expect(list[0].author).toEqual({ id: 'keycloak:u-anna', name: 'Анна' });

    // Vladimir (owner) replies in another browser
    const owner = await (await browser.newContext()).newPage();
    await signIn(owner, 'vladimir');
    const reply = { id: 'r-auth-1', text: 'Ответ владельца', createdAt: new Date().toISOString(), author: { id: 'keycloak:u-anna', name: 'Анна' } };
    expect((await owner.request.post('/api/feedback/c-auth-1/replies', { data: reply, headers: space })).status()).toBe(201);
    const stored = (await (await page.request.get('/api/feedback', { headers: space })).json())[0].replies[0];
    expect(stored.author).toEqual({ id: 'keycloak:u-vladimir', name: 'Владимир', role: 'owner' });

    // Anna can neither edit nor delete the owner's reply
    expect((await page.request.patch('/api/feedback/c-auth-1/replies/r-auth-1', { data: { text: 'взлом' }, headers: space })).status()).toBe(403);
    expect((await page.request.delete('/api/feedback/c-auth-1/replies/r-auth-1', { headers: space })).status()).toBe(403);

    // Boris may not resolve Anna's thread; the owner may
    const boris = await (await browser.newContext()).newPage();
    await signIn(boris, 'boris', 'yandex');
    expect((await boris.request.patch('/api/feedback/c-auth-1', { data: { status: 'resolved' }, headers: space })).status()).toBe(403);
    expect((await owner.request.patch('/api/feedback/c-auth-1', { data: { status: 'resolved' }, headers: space })).status()).toBe(200);
    const after = (await (await page.request.get('/api/feedback', { headers: space })).json())[0];
    expect(after.resolvedBy).toEqual({ id: 'keycloak:u-vladimir', name: 'Владимир', role: 'owner' });
    await owner.context().close();
    await boris.context().close();
  });

  test('the owner is recognised by verified email (Google, Yandex) and by Keycloak role', async ({ page }) => {
    for (const provider of ['google', 'yandex', 'keycloak'] as const) {
      await signIn(page, 'vladimir', provider);
      expect((await (await page.request.get('/api/auth/me')).json()).user.role).toBe('owner');
      await signIn(page, 'anna', provider);
      expect((await (await page.request.get('/api/auth/me')).json()).user.role).toBeUndefined();
    }
  });

  test('after sign-in only paths of this site are allowed as the way back', async ({ page }) => {
    const res = await page.request.get('/api/auth/login/google?login_hint=anna&return=/%5Cevil.com', { maxRedirects: 0 });
    const toProvider = res.headers().location!;
    const back = await page.request.get(toProvider.replace(/^https?:\/\/[^/]+/, ''), { maxRedirects: 0 });
    const callback = back.headers().location!;
    const done = await page.request.get(callback.replace(/^https?:\/\/[^/]+/, ''), { maxRedirects: 0 });
    expect(done.status()).toBe(302);
    expect(done.headers().location).toBe('/');
  });

  test('a callback without the matching state cookie is refused', async ({ page, browser }) => {
    const res = await page.request.get('/api/auth/login/google?login_hint=anna&return=/', { maxRedirects: 0 });
    const back = await page.request.get(res.headers().location!.replace(/^https?:\/\/[^/]+/, ''), { maxRedirects: 0 });
    // another browser (no state cookie) tries to use the callback
    const other = await browser.newContext();
    const done = await other.request.get(back.headers().location!.replace(/^https?:\/\/[^/]+/, ''), { maxRedirects: 0 });
    expect(done.headers().location).toContain('comenta_auth_error=');
    expect((await (await other.request.get('/api/auth/me')).json()).user).toBeNull();
    await other.close();
  });
});

test.describe('settings page', () => {
  test('asks the site owner to sign in first; another user is told they are not the owner', async ({ page }) => {
    await useSpace(page);
    await page.goto('/demo/settings.html');
    await expect(page.locator('comenta-settings .cs-site-login')).toHaveText(['Войти через Google', 'Войти через Яндекс', 'Войти через Keycloak']);
    await signIn(page, 'anna');
    await page.reload();
    await expect(page.locator('comenta-settings .cs-note')).toContainText('не владелец сайта');
    await page.locator('comenta-settings .cs-site-logout').click();
    await expect(page.locator('comenta-settings .cs-site-login')).toHaveCount(3);
    await signIn(page, 'vladimir');
    await page.reload();
    await expect(page.locator('comenta-settings .cs-login')).toBeVisible(); // now the GitHub sign-in
  });
});
