import { expect, type Page, type Request } from '@playwright/test';

export const widget = (page: Page) => ({
  toggle: page.locator('pinhelp-feedback .ph-toggle'),
  count: page.locator('pinhelp-feedback .ph-count'),
  hoverBox: page.locator('pinhelp-feedback .ph-box:not(.ph-selected)'),
  selBox: page.locator('pinhelp-feedback .ph-box.ph-selected'),
  popover: page.locator('pinhelp-feedback .ph-popover'),
  textarea: page.locator('pinhelp-feedback .ph-textarea'),
  submit: page.locator('pinhelp-feedback .ph-btn-primary'),
  error: page.locator('pinhelp-feedback .ph-error'),
  toast: page.locator('pinhelp-feedback .ph-toast'),
  pins: page.locator('pinhelp-feedback .ph-pin'),
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
