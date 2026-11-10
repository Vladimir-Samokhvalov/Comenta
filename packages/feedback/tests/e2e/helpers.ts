import { expect, type Page, type Request } from '@playwright/test';

export const widget = (page: Page) => ({
  toggle: page.locator('comenta-feedback .ph-toggle'),
  bar: page.locator('comenta-feedback .ph-bar'),
  more: page.locator('comenta-feedback .ph-more'),
  menu: page.locator('comenta-feedback .ph-menu'),
  panel: page.locator('comenta-feedback .ph-panel'),
  items: page.locator('comenta-feedback .ph-item'),
  hoverBox: page.locator('comenta-feedback .ph-box:not(.ph-selected)'),
  selBox: page.locator('comenta-feedback .ph-box.ph-selected'),
  popover: page.locator('comenta-feedback .ph-popover'),
  textarea: page.locator('comenta-feedback .ph-textarea'),
  submit: page.locator('comenta-feedback .ph-btn-primary'),
  error: page.locator('comenta-feedback .ph-error'),
  toast: page.locator('comenta-feedback .ph-toast'),
  pins: page.locator('comenta-feedback .ph-pin'),
  feed: page.locator('comenta-feedback .ph-feed'),
  msgs: page.locator('comenta-feedback .ph-msg'),
  replyBox: page.locator('comenta-feedback .ph-reply .ph-textarea'),
  replyBtn: page.locator('comenta-feedback .ph-reply-btn'),
  resolveBtn: page.locator('comenta-feedback .ph-resolve'),
  status: page.locator('comenta-feedback .ph-status'),
  unread: page.locator('comenta-feedback .ph-unread'),
  signInCard: page.locator('comenta-feedback .ph-signin'),
});

const spaced = new WeakSet<Page>();

/** Each test gets its own store on the mock server, so parallel tests don't see each other's comments. */
export async function useSpace(page: Page, space = `t-${Math.random().toString(36).slice(2)}`) {
  if (spaced.has(page)) return;
  spaced.add(page);
  await page.addInitScript((s) => {
    (window as unknown as { __comentaSpace: string }).__comentaSpace = s;
  }, space);
}

/** Test users of the fake sign-in (demo/auth-mock.mjs). Владимир is the site owner. */
export type MockUser = 'vladimir' | 'anna' | 'boris';

/**
 * Sign in to the demo site through a fake provider (`login_hint` skips the picker). The session cookie lands in the
 * page's browser context. Call before `openDemo`, or reload the page afterwards: the widget reads the user on start.
 */
export async function signIn(page: Page, user: MockUser = 'vladimir', provider: 'google' | 'yandex' | 'keycloak' = 'keycloak') {
  const res = await page.request.get(`/api/auth/login/${provider}?login_hint=${user}&return=/demo/settings.html`);
  expect(res.ok()).toBe(true);
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.user?.id).toBe(`${provider}:u-${user}`);
}

export async function signOut(page: Page) {
  await page.request.post('/api/auth/logout');
}

/** Open the demo signed in (as Владимир, the owner, unless `user` says otherwise; `null`: not signed in). */
export async function openDemo(page: Page, query = '', user: MockUser | null = 'vladimir') {
  await useSpace(page);
  if (user) await signIn(page, user);
  await page.goto(`/${query}`);
  await expect(widget(page).toggle).toBeVisible();
}

/** Full flow: select element → type → send. Returns the POSTed payload. */
export async function comment(page: Page, selector: string, text: string) {
  const w = widget(page);
  if ((await w.toggle.getAttribute('aria-pressed')) !== 'true') await w.toggle.click();
  await page.locator(selector).first().click();
  await expect(w.popover).toBeVisible();
  await w.textarea.fill(text);
  const req = page.waitForRequest((r: Request) => r.url().includes('/api/feedback') && r.method() === 'POST');
  await w.submit.click();
  const body = (await req).postDataJSON();
  await expect(w.popover).toBeHidden();
  return body;
}

export async function viewportBox(page: Page) {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

/** Number of comments on the current page, as shown in the chevron menu. */
export async function menuCount(page: Page): Promise<string> {
  const w = widget(page);
  await w.more.click();
  await expect(w.menu).toBeVisible();
  const n = (await page.locator('comenta-feedback .ph-mi-all .ph-mi-extra').textContent()) ?? '';
  await page.keyboard.press('Escape');
  await expect(w.menu).toBeHidden();
  return n;
}
