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
});

export async function openDemo(page: Page, query = '') {
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
