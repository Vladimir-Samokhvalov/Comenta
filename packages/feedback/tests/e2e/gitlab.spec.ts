import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { signIn as signInSite, widget, type MockUser } from './helpers';

// The demo server runs with GITLAB_MOCK=1: a fake GitLab lives at /__gitlab (demo/gitlab-mock.mjs) and is
// treated as a self-hosted instance with an OAuth application. Its state is global, so this file runs serially.
test.describe.configure({ mode: 'serial' });

const s = (page: Page) => ({
  card: page.locator('comenta-settings .cs'),
  choice: (p: 'github' | 'gitlab') => page.locator(`comenta-settings .cs-choice[data-provider="${p}"]`),
  instance: page.locator('comenta-settings .cs-instance'),
  login: page.locator('comenta-settings .cs-login'),
  name: page.locator('comenta-settings .cs-name'),
  who: page.locator('comenta-settings .cs-who a'),
  repo: page.locator('comenta-settings .cs-repo-input'),
  options: page.locator('comenta-settings .cs-opt'),
  project: page.locator('comenta-settings .cs-project'),
  save: page.locator('comenta-settings .cs-save'),
  ok: page.locator('comenta-settings .cs-ok'),
  saved: page.locator('comenta-settings .cs-saved'),
  notes: page.locator('comenta-settings .cs-note'),
  logout: page.locator('comenta-settings .cs-logout'),
  logoutYes: page.locator('comenta-settings .cs-logout-yes'),
  token: page.locator('comenta-settings .cs-token'),
  details: page.locator('comenta-settings summary'),
  title: page.locator('comenta-settings .cs-title'),
});

type GlIssue = { iid: number; project_id: number; title: string; description: string; state: string; web_url: string };
type GlNote = { id: number; body: string; system: boolean; internal: boolean; author: { username: string }; noteable_iid: number };
type GlState = { issues: GlIssue[]; notes: GlNote[]; uploads: Array<{ project_id: number; name: string; size: number }>; refreshes: number; revoked: number; calls: string[] };
const glState = async (page: Page): Promise<GlState> => (await page.request.get('/__gitlab/state')).json();
const control = (page: Page, data: object) => page.request.post('/__gitlab/control', { data });
const act = async (page: Page, data: object) => (await page.request.post('/__gitlab/issue', { data })).json();

let space = '';
async function useSpace(page: Page, context: BrowserContext) {
  space = `gl-${Math.random().toString(36).slice(2)}`;
  await context.addCookies([{ name: 'comenta_space', value: space, domain: 'localhost', path: '/' }]);
  await page.addInitScript((sp) => ((window as unknown as { __comentaSpace: string }).__comentaSpace = sp), space);
}
const api = (page: Page, path: string) => page.request.get(path, { headers: { 'X-Comenta-Space': space } });

/** GitLab tab, the mock's address (a "self-hosted" GitLab), sign in. */
async function signIn(page: Page) {
  await page.goto('/demo/settings.html');
  await s(page).choice('gitlab').click();
  await expect(s(page).title).toHaveText('Интеграция с GitLab');
  await expect(s(page).instance).toHaveValue(/\/__gitlab$/);
  await s(page).login.click();
  await expect(page).toHaveTitle(/Mock GitLab/);
  await page.locator('#authorize').click();
  await page.waitForURL(/\/demo\/settings\.html$/);
  await expect(s(page).name).toHaveText('Владимир');
}

async function pickRepo(page: Page, query: string, fullName: string) {
  await s(page).repo.click();
  await s(page).repo.fill(query);
  await page.locator(`comenta-settings .cs-opt[data-repo="${fullName}"]`).click();
  await expect(s(page).repo).toHaveValue(fullName);
}

async function configure(page: Page, repo = 'acme-studio/web-app') {
  await signIn(page);
  await pickRepo(page, repo.split('/').at(-1)!, repo);
  await s(page).save.click();
  await expect(s(page).ok).toHaveText('✓ Сохранено.');
}

async function leaveComment(page: Page, text: string, path = '/') {
  await page.goto(path);
  const w = widget(page);
  await w.toggle.click();
  await page.locator('#inc').click();
  await w.textarea.fill(text);
  const res = page.waitForResponse((r) => r.url().endsWith('/api/feedback') && r.request().method() === 'POST');
  await w.submit.click();
  const body = await (await res).json();
  await expect(w.popover).toBeHidden();
  return body as { ok: boolean; id: string; issue?: { url: string; number: number; repo: string; provider: string; repoId: number } };
}

test.beforeEach(async ({ page, context }) => {
  await page.request.post('/__gitlab/reset');
  await useSpace(page, context);
  await signInSite(page, 'vladimir'); // the tracker settings are for the site owner
});

test.describe('GitLab settings', () => {
  test('choose GitLab, sign in on a self-hosted GitLab, search projects of groups and subgroups, save', async ({ page }) => {
    await page.goto('/demo/settings.html');
    // GitHub stays the first choice; nothing is connected yet, so both can be picked
    await expect(s(page).choice('github')).toHaveAttribute('aria-checked', 'true');
    await expect(s(page).choice('gitlab')).toBeEnabled();
    await signIn(page);
    await expect(s(page).who).toContainText('@demo-owner · на localhost');
    // Reporter or higher only: the Guest project and the archived one are not offered
    await s(page).repo.click();
    await expect(s(page).options).toHaveCount(5);
    await expect(page.locator('comenta-settings .cs-opt[data-repo="acme-studio/docs"]')).toHaveCount(0);
    await expect(page.locator('comenta-settings .cs-opt[data-repo="demo-owner/old-archive"]')).toHaveCount(0);
    await s(page).repo.fill('acme');
    await expect(s(page).options).toHaveCount(2);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(s(page).repo).toHaveValue('acme-studio/frontend/design-system');
    // no Projects v2 field on GitLab
    await expect(s(page).project).toHaveCount(0);
    await s(page).save.click();
    await expect(s(page).ok).toBeVisible();
    await expect(s(page).saved).toContainText('acme-studio/frontend/design-system');
    // survives a reload; the site now uses GitLab, so GitHub is locked
    await page.reload();
    await expect(s(page).choice('gitlab')).toHaveAttribute('aria-checked', 'true');
    await expect(s(page).repo).toHaveValue('acme-studio/frontend/design-system');
    await expect(s(page).choice('github')).toBeDisabled();
    await expect(s(page).choice('github')).toHaveAttribute('title', /Сайт уже подключён к GitLab/);
  });

  test('one tracker per site: GitHub refuses while GitLab is in use, and the other way round', async ({ page }) => {
    await configure(page);
    const gh = await page.request.post('/api/github/auth/token', { data: { token: 'ghp_mock_local_dev_token_123456' }, headers: { 'X-Comenta-Space': space } });
    expect(gh.status()).toBe(403);
    expect((await gh.json()).error.message).toContain('уже подключён GitLab');
    // after signing out of GitLab, GitHub can be chosen again
    await s(page).logout.click();
    await s(page).logoutYes.click();
    await expect(s(page).login).toBeVisible();
    await expect(s(page).choice('github')).toBeEnabled();
    await s(page).choice('github').click();
    await s(page).details.click();
    await s(page).token.fill('ghp_mock_local_dev_token_123456');
    await page.keyboard.press('Enter');
    await expect(s(page).name).toHaveText('Владимир');
    await expect(s(page).choice('gitlab')).toBeDisabled();
    const gl = await page.request.post('/api/gitlab/auth/token', { data: { token: 'glpat-mock-local-dev-token-1', url: new URL('/__gitlab', page.url()).href }, headers: { 'X-Comenta-Space': space } });
    expect(gl.status()).toBe(403);
  });

  test('GitLab address is checked: typos, no OAuth application, not a GitLab', async ({ page }) => {
    await page.goto('/demo/settings.html');
    await s(page).choice('gitlab').click();
    await s(page).instance.fill('not a url');
    await s(page).login.click();
    await page.waitForURL(/settings\.html$/);
    await expect(s(page).notes.filter({ hasText: 'не похоже на адрес GitLab' })).toBeVisible();
    // another instance: the server has no OAuth application for it
    await s(page).instance.fill('https://git.example.org');
    await s(page).login.click();
    await page.waitForURL(/settings\.html$/);
    await expect(s(page).notes.filter({ hasText: 'Для https://git.example.org на сервере нет OAuth-приложения GitLab' })).toBeVisible();
    await expect(s(page).choice('gitlab')).toHaveAttribute('aria-checked', 'true'); // came back to the GitLab tab
    // an address that answers, but not as GitLab (token path skips the OAuth check)
    await s(page).instance.fill(new URL('/demo', page.url()).href);
    await s(page).details.click();
    await s(page).token.fill('glpat-mock-local-dev-token-1');
    await page.keyboard.press('Enter');
    await expect(s(page).notes.filter({ hasText: 'По этому адресу не отвечает GitLab' })).toBeVisible();
  });

  test('cancelled sign-in on GitLab shows a message', async ({ page }) => {
    await page.goto('/demo/settings.html');
    await s(page).choice('gitlab').click();
    await s(page).login.click();
    await page.locator('#cancel').click();
    await page.waitForURL(/settings\.html$/);
    await expect(s(page).notes.filter({ hasText: 'Вход отменён на GitLab.' })).toBeVisible();
  });

  test('personal access token as a fallback', async ({ page }) => {
    await page.goto('/demo/settings.html');
    await s(page).choice('gitlab').click();
    await s(page).details.click();
    await s(page).token.fill('glpat-not-a-real-token-but-long');
    await page.keyboard.press('Enter');
    await expect(s(page).notes.filter({ hasText: 'GitLab не принял токен' })).toBeVisible();
    if (!(await s(page).token.isVisible())) await s(page).details.click();
    await s(page).token.fill('glpat-mock-local-dev-token-1');
    await page.keyboard.press('Enter');
    await expect(s(page).name).toHaveText('Владимир');
  });

  test('very many projects: the list is cut and typing searches all of them on GitLab', async ({ page }) => {
    await control(page, { many: 520 });
    await signIn(page);
    await expect(page.locator('comenta-settings .cs-repos-state')).toContainText('Показаны не все проекты');
    await s(page).repo.click();
    await expect(s(page).options).toHaveCount(500);
    await s(page).repo.fill('bulk-517');
    await expect(page.locator('comenta-settings .cs-opt[data-repo="acme-studio/bulk/bulk-517"]')).toBeVisible();
    await page.locator('comenta-settings .cs-opt[data-repo="acme-studio/bulk/bulk-517"]').click();
    await s(page).save.click();
    await expect(s(page).saved).toContainText('acme-studio/bulk/bulk-517');
  });

  test('no projects: the list explains', async ({ page }) => {
    await control(page, { projects: 'empty' });
    await signIn(page);
    await expect(s(page).notes.filter({ hasText: 'Нет проектов, где у вас роль Reporter или выше' })).toBeVisible();
    await expect(s(page).repo).toBeDisabled();
  });

  test('token without the api scope: warning names it, the list says what to do', async ({ page }) => {
    await control(page, { scopes: 'read_user' });
    await signIn(page);
    await expect(s(page).notes.filter({ hasText: 'Токену не хватает прав: api' })).toBeVisible();
    await expect(s(page).notes.filter({ hasText: 'У доступа к GitLab нет прав: api' })).toBeVisible();
  });

  test('project with issues turned off: clear error on save', async ({ page }) => {
    await signIn(page);
    await s(page).repo.click();
    await expect(page.locator('comenta-settings .cs-opt[data-repo="demo-owner/no-issues"] .cs-opt-tag')).toHaveText(['private', 'issues выкл.']);
    await pickRepo(page, 'no-issues', 'demo-owner/no-issues');
    await s(page).save.click();
    await expect(s(page).notes.filter({ hasText: 'В этом проекте выключены issues' })).toBeVisible();
    await expect(s(page).saved).toContainText('Проект ещё не выбран');
  });

  test('rate limit: readable message, saving again works once it is over', async ({ page }) => {
    await signIn(page);
    await pickRepo(page, 'landing', 'demo-owner/landing');
    await control(page, { rateLimit: 600 });
    await s(page).save.click();
    await expect(s(page).notes.filter({ hasText: 'GitLab временно ограничил число запросов' })).toContainText('через 10 мин');
    await expect(s(page).saved).toContainText('Проект ещё не выбран');
    await control(page, { rateLimit: 0 });
    await s(page).save.click();
    await expect(s(page).ok).toBeVisible();
    await expect(s(page).saved).toContainText('demo-owner/landing');
  });

  test('an expired access token is refreshed with the refresh token, without asking the owner', async ({ page }) => {
    await control(page, { expiresIn: 1 });
    await configure(page, 'demo-owner/landing');
    await control(page, { expiresIn: 7200 });
    await page.waitForTimeout(1100);
    const res = await leaveComment(page, 'После истечения токена');
    expect(res.issue?.number).toBe(1);
    expect((await glState(page)).refreshes).toBeGreaterThan(0);
    await page.goto('/demo/settings.html');
    await expect(s(page).name).toHaveText('Владимир');
  });
});

test.describe('comments → GitLab issues', () => {
  test('a comment becomes an issue in the project; the thread links to "GitLab #1"', async ({ page }) => {
    await configure(page);
    const res = await leaveComment(page, 'Кнопка «+1» не реагирует @someone, см. !12 и #3');
    expect(res.issue).toMatchObject({ provider: 'gitlab', repo: 'acme-studio/web-app', number: 1, repoId: 102 });
    const [issue] = (await glState(page)).issues;
    expect(issue.title).toBe('Кнопка «+1» не реагирует @someone, см. !12 и #3');
    expect(issue.description).toContain('| Элемент | `#inc` |');
    expect(issue.description).toContain(`<!-- comenta:id=${res.id} -->`);
    // guests can't ping people or link merge requests and issues
    expect(issue.description).not.toContain(' @someone');
    expect(issue.description).not.toContain(' !12');
    expect(issue.description).not.toContain(' #3');
    const w = widget(page);
    await w.pins.first().click();
    const link = page.locator('comenta-feedback .ph-issue');
    await expect(link).toHaveText('GitLab #1');
    await expect(link).toHaveAttribute('href', res.issue!.url);
    await page.reload();
    await w.pins.first().click();
    await expect(link).toHaveText('GitLab #1');
  });

  test('a voice message is uploaded to the project and embedded in the issue as a player', async ({ page }) => {
    await configure(page, 'demo-owner/landing');
    await page.goto('/');
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    const btn = page.locator('comenta-feedback .ph-rec-btn');
    const box = (await btn.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(450);
    await page.mouse.up();
    await page.waitForTimeout(1300);
    await page.locator('comenta-feedback .ph-rec-stop').click();
    await expect(page.locator('comenta-feedback .ph-popover audio')).toHaveCount(1);
    const res = page.waitForResponse((r) => r.url().endsWith('/api/feedback') && r.request().method() === 'POST');
    await w.submit.click();
    expect((await (await res).json()).issue.number).toBe(1);
    const st = await glState(page);
    expect(st.uploads).toHaveLength(1);
    expect(st.uploads[0].name).toMatch(/^voice-[\w-]+\.(webm|ogg|m4a|mp4)$/);
    expect(st.uploads[0].size).toBeGreaterThan(100);
    expect(st.issues[0].description).toMatch(/!\[🎙 Голос, 0:0\d\]\(http:\/\/localhost:\d+\/__gitlab\/-\/project\/104\/uploads\/\w+\/voice-/);
  });

  test('sending the same comment twice creates one issue', async ({ page }) => {
    await configure(page);
    const res = await leaveComment(page, 'Дубликат?');
    const payload = await page.evaluate(() => (window as unknown as { __lastPayload: unknown }).__lastPayload);
    const again = await page.request.post('/api/feedback', { data: payload, headers: { 'X-Comenta-Space': space } });
    expect((await again.json()).issue.number).toBe(res.issue!.number);
    expect((await glState(page)).issues).toHaveLength(1);
  });

  test('GitLab is down: the comment is kept and becomes an issue once GitLab is back, found by its marker on retry', async ({ page }) => {
    await configure(page);
    await control(page, { failNext: 1000 });
    const res = await leaveComment(page, 'Пока GitLab лежит');
    expect(res.issue).toBeUndefined();
    await page.goto('/demo/settings.html');
    await expect(s(page).notes.filter({ hasText: 'Последняя ошибка отправки в GitLab: GitLab не отвечает' })).toBeVisible();
    await control(page, { failNext: 0 });
    await expect.poll(async () => (await glState(page)).issues.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(async () => (await (await api(page, '/api/feedback')).json())[0]?.issue?.number, { timeout: 10_000 }).toBe(1);
    // the retry looked for an existing issue first (no duplicate when the first POST did get through)
    expect((await glState(page)).calls.some((c) => c.startsWith('GET /projects/102/issues'))).toBe(true);
  });

  test("owner's token revoked: settings ask to sign in again; queued comments are sent after it", async ({ page }) => {
    await configure(page);
    await control(page, { revoke: true });
    const res = await leaveComment(page, 'После отзыва токена');
    expect(res.issue).toBeUndefined();
    await page.goto('/demo/settings.html');
    await expect(s(page).notes.filter({ hasText: 'Доступ к GitLab истёк или был отозван' })).toBeVisible();
    await expect(s(page).login).toHaveText('Войти заново');
    await s(page).login.click();
    await page.locator('#authorize').click();
    await page.waitForURL(/settings\.html$/);
    await expect(s(page).repo).toHaveValue('acme-studio/web-app');
    await expect.poll(async () => (await glState(page)).issues.map((i) => i.title), { timeout: 10_000 }).toEqual(['После отзыва токена']);
  });

  test('role lowered to Guest: comments wait and the settings say why', async ({ page }) => {
    await configure(page);
    await control(page, { level: { project: 'acme-studio/web-app', value: 10 } });
    const res = await leaveComment(page, 'Без прав');
    expect(res.issue).toBeUndefined();
    await page.goto('/demo/settings.html');
    await expect(s(page).notes.filter({ hasText: 'нужна роль Reporter или выше' })).toBeVisible();
    expect((await glState(page)).issues).toHaveLength(0);
  });

  test('logout revokes the token; new comments stay local', async ({ page }) => {
    await configure(page);
    await s(page).logout.click();
    await expect(s(page).notes.filter({ hasText: 'Отключить GitLab?' })).toBeVisible();
    await s(page).logoutYes.click();
    await expect(s(page).login).toBeVisible();
    expect((await glState(page)).revoked).toBe(1);
    const res = await leaveComment(page, 'После выхода');
    expect(res.issue).toBeUndefined();
    await page.waitForTimeout(1000);
    expect((await glState(page)).issues).toHaveLength(0);
    expect((await api(page, '/api/gitlab/repos')).status()).toBe(401);
  });
});

test.describe('GitLab issue ↔ thread sync', () => {
  const notes = async (page: Page) => (await glState(page)).notes;
  const state = (page: Page) => page.locator('comenta-feedback .ph-issue-state');
  const external = (page: Page) => page.locator('comenta-feedback .ph-msg-external');
  const P = 'acme-studio/web-app';

  async function openSyncedThread(page: Page, text = 'Кнопка «+1» считает дважды') {
    await configure(page);
    const res = await leaveComment(page, text, '/?poll=400');
    expect(res.issue?.number).toBe(1);
    await widget(page).pins.first().click();
    await expect(page.locator('comenta-feedback .ph-issue')).toHaveText('GitLab #1');
    return res;
  }

  async function reply(page: Page, text: string) {
    const w = widget(page);
    await w.replyBox.fill(text);
    const done = page.waitForResponse((r) => r.url().includes('/replies') && r.request().method() === 'POST');
    await w.replyBtn.click();
    await done;
  }

  test('one status: closing or reopening the issue on GitLab closes or reopens the thread', async ({ page }) => {
    await openSyncedThread(page);
    const w = widget(page);
    const event = page.locator('comenta-feedback .ph-event');
    await expect(w.status).toHaveText('Открыт');
    await act(page, { project: P, iid: 1, close: true, username: 'ivan' });
    await expect(w.status).toHaveText('Закрыт');
    await expect(w.status).toHaveAttribute('title', 'GitLab: закрыт');
    await expect(event).toHaveText(/^ivan закрыл\(а\) на GitLab · \d/);
    await expect(w.resolveBtn).toHaveAttribute('aria-label', 'Открыть снова');
    await act(page, { project: P, iid: 1, reopen: true });
    await expect(w.status).toHaveText('Открыт');
    await expect(event).toHaveCount(0);
  });

  test('closing or reopening in Comenta closes or reopens the issue; GitLab keeps agreeing', async ({ page }) => {
    await openSyncedThread(page);
    const w = widget(page);
    const issue = async () => (await glState(page)).issues[0];
    await w.resolveBtn.click();
    await expect(w.status).toHaveText('Закрыт');
    expect((await issue()).state).toBe('closed');
    await page.waitForTimeout(1200);
    await expect(w.status).toHaveText('Закрыт');
    await w.resolveBtn.click();
    await expect(w.status).toHaveText('Открыт');
    expect((await issue()).state).toBe('opened');
    // "reply and close": the reply reaches the issue first
    await w.replyBox.fill('Исправлено в релизе');
    await w.replyResolveBtn.click();
    await expect(w.status).toHaveText('Закрыт');
    expect((await issue()).state).toBe('closed');
    expect((await notes(page)).map((n) => n.body.split('\n')[0])).toEqual(['**Владимир:** Исправлено в релизе']);
  });

  test('GitLab does not answer: the status stays and the error is shown', async ({ page }) => {
    await openSyncedThread(page);
    await control(page, { failNext: 1000 });
    await widget(page).resolveBtn.click();
    await expect(widget(page).error).toContainText('Статус не изменён: GitLab не отвечает');
    await expect(widget(page).status).toHaveText('Открыт');
    await control(page, { failNext: 0 });
    expect((await glState(page)).issues[0].state).toBe('opened');
  });

  test('notes written on GitLab appear with name, avatar and "из GitLab"; internal and system notes never; edits and deletions follow', async ({ page }) => {
    await openSyncedThread(page);
    const { id } = await act(page, { project: P, iid: 1, note: 'Воспроизвёл, чиню', username: 'ivan' });
    await act(page, { project: P, iid: 1, note: 'Внутренняя заметка команды', internal: true });
    await act(page, { project: P, iid: 1, note: 'changed the description', system: true });
    await expect(external(page)).toHaveCount(1);
    await expect(external(page)).toHaveAttribute('data-origin', 'gitlab');
    await expect(external(page).locator('.ph-msg-name')).toContainText('ivan');
    await expect(external(page).locator('.ph-msg-source')).toHaveText('из GitLab');
    await expect(external(page).locator('.ph-msg-source')).toHaveAttribute('href', new RegExp(`/-/issues/1#note_${id}$`));
    await expect(external(page).locator('.ph-avatar')).toHaveAttribute('src', /avatar\.svg$/);
    await expect(external(page).locator('.ph-msg-text')).toHaveText('Воспроизвёл, чиню');
    await expect(external(page).locator('.ph-msg-edit, .ph-msg-delete')).toHaveCount(0);
    await act(page, { editNote: id, body: 'Воспроизвёл, починил в !42' });
    await expect(external(page).locator('.ph-msg-text')).toHaveText('Воспроизвёл, починил в !42');
    await expect(external(page).locator('.ph-msg-edited')).toBeVisible();
    await act(page, { deleteNote: id });
    await expect(external(page)).toHaveCount(0);
    await expect(widget(page).feed).not.toContainText('Внутренняя заметка');
  });

  test('replies go to the issue as notes signed with the name only; no echo; edits and deletions follow', async ({ page }) => {
    await openSyncedThread(page);
    await reply(page, 'Спасибо, посмотрим @team');
    await expect.poll(async () => (await notes(page)).length).toBe(1);
    const [n] = await notes(page);
    expect(n.body.split('\n')[0]).toBe('**Владимир:** Спасибо, посмотрим @​team');
    expect(n.body).toMatch(/<!-- comenta:reply=[\w-]+ -->/);
    expect(n.author.username).toBe('demo-owner'); // the owner's token: no bot on GitLab
    await page.waitForTimeout(1500);
    await expect(widget(page).msgs).toHaveCount(2);
    await expect(external(page)).toHaveCount(0);
    await widget(page).msgs.last().hover();
    await page.locator('comenta-feedback .ph-msg-edit').click();
    await page.locator('comenta-feedback .ph-edit-text').fill('Спасибо, исправим завтра');
    await page.locator('comenta-feedback .ph-edit-save').click();
    await expect.poll(async () => (await notes(page))[0]?.body.split('\n')[0]).toBe('**Владимир:** Спасибо, исправим завтра');
    await widget(page).msgs.last().hover();
    await page.locator('comenta-feedback .ph-msg-delete').click();
    await page.locator('comenta-feedback .ph-confirm .ph-btn-danger').click();
    await expect.poll(async () => (await notes(page)).length).toBe(0);
  });

  test('other visitors see neither the GitLab state nor GitLab notes; the comment author does', async ({ page, browser }) => {
    await configure(page);
    const visitor = async (user: string) => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.addInitScript((sp) => {
        (window as unknown as { __comentaSpace: string }).__comentaSpace = sp;
      }, space);
      await signInSite(p, (user === 'guest' ? 'boris' : user) as MockUser); // "guest": another signed-in visitor
      return { ctx, p };
    };
    const anna = await visitor('anna');
    const res = await leaveComment(anna.p, 'Не вижу кнопку оплаты', '/?poll=400');
    expect(res.issue?.number).toBe(1);
    await widget(anna.p).pins.first().click();
    await act(page, { project: P, iid: 1, note: 'Уточните браузер, пожалуйста', username: 'ivan' });
    await act(page, { project: P, iid: 1, close: true, username: 'ivan' });
    await expect(widget(anna.p).status).toHaveText('Закрыт');
    await expect(anna.p.locator('comenta-feedback .ph-event')).toHaveText(/^ivan закрыл\(а\) на GitLab · \d/);
    await expect(widget(anna.p).resolveBtn).toHaveCount(0); // only the owner closes threads with an issue
    await expect(external(anna.p).locator('.ph-msg-text')).toHaveText('Уточните браузер, пожалуйста');

    const guest = await visitor('guest');
    const listed = guest.p.waitForResponse((r) => r.url().includes('/api/feedback') && r.request().method() === 'GET');
    await guest.p.goto(`/?poll=400#comenta=${res.id}`);
    const body = JSON.stringify(await (await listed).json());
    expect(body).not.toContain('Уточните браузер');
    expect(body).not.toContain('"state"');
    expect(body).not.toContain('ivan');
    await expect(guest.p.locator('comenta-feedback .ph-issue')).toHaveText('GitLab #1');
    await expect(widget(guest.p).status).toHaveText('Закрыт');
    await expect(guest.p.locator('comenta-feedback .ph-event')).toHaveText(/^Закрыт · \d/);
    await expect(external(guest.p)).toHaveCount(0);
    await anna.ctx.close();
    await guest.ctx.close();
  });

  test('deleted issue: the card says "Issue недоступен" and keeps the link', async ({ page }) => {
    const res = await openSyncedThread(page);
    await act(page, { project: P, iid: 1, delete: true });
    await expect(state(page)).toHaveText('Issue недоступен');
    await expect(page.locator('comenta-feedback .ph-issue')).toHaveAttribute('href', res.issue!.url);
  });

  test('issue moved to another project is marked unavailable; the thread keeps its own status', async ({ page }) => {
    await openSyncedThread(page);
    await act(page, { project: P, iid: 1, move: true });
    await expect(state(page)).toHaveText('Issue недоступен');
    await expect(widget(page).status).toHaveText('Открыт'); // the move closed the old issue; that is not a decision about the thread
  });

  test('GitLab down or rate-limited: replies wait and are sent once it is back, one note each', async ({ page }) => {
    await openSyncedThread(page);
    await control(page, { rateLimit: 2 });
    await reply(page, 'Ответ во время лимита');
    await control(page, { rateLimit: 0, failNext: 1000 });
    await reply(page, 'Ответ, пока GitLab лежит');
    await page.waitForTimeout(800);
    expect(await notes(page)).toHaveLength(0);
    await expect(widget(page).msgs).toHaveCount(3);
    await control(page, { failNext: 0 });
    await expect.poll(async () => (await notes(page)).map((n) => n.body.split('\n')[0]).sort(), { timeout: 15_000 }).toEqual(['**Владимир:** Ответ во время лимита', '**Владимир:** Ответ, пока GitLab лежит']);
    await page.waitForTimeout(1000);
    expect(await notes(page)).toHaveLength(2);
  });
});
