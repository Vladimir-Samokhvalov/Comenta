import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { widget } from './helpers';

// The demo server runs with GITHUB_MOCK=1: a fake GitHub lives at /__github (demo/github-mock.mjs).
// Its state is global, so this file runs serially and resets it before every test
// (with --repeat-each add --workers 1: copies of the file would share the mock).
test.describe.configure({ mode: 'serial' });
// COMENTA_GITHUB_BOT=0: the server has no private key and creates issues under the owner's user token
const botMode = process.env.COMENTA_GITHUB_BOT !== '0';

const s = (page: Page) => ({
  card: page.locator('comenta-settings .cs'),
  login: page.locator('comenta-settings .cs-login'),
  name: page.locator('comenta-settings .cs-name'),
  repo: page.locator('comenta-settings .cs-repo-input'),
  options: page.locator('comenta-settings .cs-opt'),
  list: page.locator('comenta-settings .cs-list'),
  project: page.locator('comenta-settings .cs-project'),
  save: page.locator('comenta-settings .cs-save'),
  ok: page.locator('comenta-settings .cs-ok'),
  saved: page.locator('comenta-settings .cs-saved'),
  notes: page.locator('comenta-settings .cs-note'),
  logout: page.locator('comenta-settings .cs-logout'),
  logoutYes: page.locator('comenta-settings .cs-logout-yes'),
  token: page.locator('comenta-settings .cs-token'),
  details: page.locator('comenta-settings summary'),
});

type State = {
  issues: Array<{ repo: string; number: number; title: string; body: string; node_id: string; author: string }>;
  files: string[];
  branches: Record<string, string[]>;
  projectItems: Array<{ projectId: string; contentId: string }>;
  revoked: number;
  refreshes: number;
  installationTokens: number;
};
const ghState = async (page: Page): Promise<State> => (await page.request.get('/__github/state')).json();
const control = (page: Page, data: object) => page.request.post('/__github/control', { data });

let space = '';
async function useGitHubSpace(page: Page, context: BrowserContext) {
  space = `gh-${Math.random().toString(36).slice(2)}`;
  // the widget sends the space as a header; the OAuth redirects carry it in a cookie
  await context.addCookies([{ name: 'comenta_space', value: space, domain: 'localhost', path: '/' }]);
  await page.addInitScript((sp) => ((window as unknown as { __comentaSpace: string }).__comentaSpace = sp), space);
}

async function signIn(page: Page) {
  await page.goto('/demo/settings.html');
  await s(page).login.click();
  await expect(page).toHaveTitle(/Mock GitHub/);
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

async function configure(page: Page, repo = 'acme-studio/web-app', project: string | null = 'Web App — бэклог') {
  await signIn(page);
  await pickRepo(page, repo.split('/')[1], repo);
  if (project) await s(page).project.selectOption({ label: project });
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
  return body as { ok: boolean; id: string; issue?: { url: string; number: number; repo: string } };
}

test.beforeEach(async ({ page, context }) => {
  await page.request.post('/__github/reset');
  await useGitHubSpace(page, context);
});

test.describe('GitHub settings', () => {
  test('sign in with GitHub, search a repository, pick a project, save', async ({ page }) => {
    await page.goto('/demo/settings.html');
    await expect(s(page).login).toHaveText('Войти через GitHub');
    await signIn(page);
    // searchable list: only repos with write access, archived ones hidden
    await s(page).repo.click();
    await expect(s(page).options).toHaveCount(6);
    await expect(page.locator('comenta-settings .cs-opt[data-repo="acme-studio/docs"]')).toHaveCount(0);
    await s(page).repo.fill('acme');
    await expect(s(page).options).toHaveCount(3);
    await page.keyboard.press('ArrowDown'); // second match
    await page.keyboard.press('Enter');
    await expect(s(page).repo).toHaveValue('acme-studio/design-system');
    // projects of the repo's owner
    await expect(s(page).project.locator('option')).toHaveText(['Без проекта', 'Web App — бэклог', 'Дизайн-ревью']);
    await s(page).project.selectOption({ label: 'Дизайн-ревью' });
    await s(page).save.click();
    await expect(s(page).ok).toBeVisible();
    await expect(s(page).saved).toContainText('acme-studio/design-system');
    await expect(s(page).saved).toContainText('Дизайн-ревью');
    await expect(s(page).save).toBeDisabled();
    // survives a reload
    await page.reload();
    await expect(s(page).repo).toHaveValue('acme-studio/design-system');
    await expect(s(page).project).toHaveValue('PVT_acme_4');
  });

  test('switching to a repository of another owner reloads projects and clears the choice', async ({ page }) => {
    await signIn(page);
    await pickRepo(page, 'landing', 'demo-owner/landing');
    await expect(s(page).project.locator('option')).toHaveText(['Без проекта', 'Отзывы с сайта', 'Личный роадмап (закрыт)']);
    await s(page).project.selectOption({ label: 'Отзывы с сайта' });
    await pickRepo(page, 'web-app', 'acme-studio/web-app');
    await expect(s(page).project).toHaveValue('');
    await expect(s(page).project.locator('option')).toHaveText(['Без проекта', 'Web App — бэклог', 'Дизайн-ревью']);
    // same owner: the project stays
    await s(page).project.selectOption({ label: 'Дизайн-ревью' });
    await pickRepo(page, 'mobile', 'acme-studio/mobile');
    await expect(s(page).project).toHaveValue('PVT_acme_4');
  });

  test('cancelled sign-in on GitHub shows a message', async ({ page }) => {
    await page.goto('/demo/settings.html');
    await s(page).login.click();
    await page.locator('#cancel').click();
    await page.waitForURL(/settings\.html$/);
    await expect(s(page).notes.filter({ hasText: 'Вход отменён на GitHub.' })).toBeVisible();
    await expect(s(page).login).toBeVisible();
  });

  test('personal access token as a fallback', async ({ page }) => {
    await page.goto('/demo/settings.html');
    await s(page).details.click();
    await s(page).token.fill('nope-not-a-real-token-but-long-enough');
    await page.keyboard.press('Enter');
    await expect(s(page).notes.filter({ hasText: 'GitHub не принял токен' })).toBeVisible();
    await s(page).details.click().catch(() => {}); // re-render closes the <details>; open again if needed
    if (!(await s(page).token.isVisible())) await s(page).details.click();
    await s(page).token.fill('ghp_mock_local_dev_token_123456');
    await page.keyboard.press('Enter');
    await expect(s(page).name).toHaveText('Владимир');
  });

  test('no repositories / no projects', async ({ page }) => {
    await control(page, { repos: 'empty' });
    await signIn(page);
    await expect(s(page).notes.filter({ hasText: 'Приложению пока не открыт' })).toBeVisible();
    await expect(s(page).repo).toBeDisabled();
    await control(page, { repos: 'default', projects: 'empty' });
    await page.reload();
    await pickRepo(page, 'landing', 'demo-owner/landing');
    await expect(page.locator('comenta-settings .cs-projects-empty')).toHaveText('У demo-owner нет проектов GitHub. Issues будут создаваться без проекта.');
    await s(page).save.click();
    await expect(s(page).saved).toContainText('demo-owner/landing');
  });

  test('missing project permission: warning, repo still usable', async ({ page }) => {
    await control(page, { scopes: 'none' });
    await signIn(page);
    await pickRepo(page, 'landing', 'demo-owner/landing');
    await expect(s(page).notes.filter({ hasText: 'У токена нет нужных прав' })).toBeVisible();
    await s(page).save.click();
    await expect(s(page).ok).toBeVisible();
  });

  test('classic token without the project scope: warning names it', async ({ page }) => {
    await control(page, { scopes: 'repo read:user' });
    await page.goto('/demo/settings.html');
    await s(page).details.click();
    await s(page).token.fill('ghp_mock_local_dev_token_no_project');
    await page.keyboard.press('Enter');
    await expect(s(page).notes.filter({ hasText: 'Токену не хватает прав: project' })).toBeVisible();
  });

  test('app not installed yet: sign-in goes on to the install page and comes back connected', async ({ page }) => {
    await control(page, { installed: false });
    await page.goto('/demo/settings.html');
    await s(page).login.click();
    await page.locator('#authorize').click();
    await expect(page).toHaveTitle(/Install/);
    await page.locator('#install').click();
    await page.waitForURL(/\/demo\/settings\.html$/);
    await expect(s(page).name).toHaveText('Владимир');
    await s(page).repo.click();
    await expect(s(page).options).toHaveCount(6);
  });

  test('install cancelled: signed in, the list explains and links to GitHub', async ({ page }) => {
    await control(page, { installed: false });
    await page.goto('/demo/settings.html');
    await s(page).login.click();
    await page.locator('#authorize').click();
    await expect(page).toHaveTitle(/Install/);
    await page.goto('/demo/settings.html'); // GitHub has no "cancel" here: the owner just comes back
    await expect(s(page).notes.filter({ hasText: 'Приложению пока не открыт' })).toBeVisible();
    await expect(page.locator('comenta-settings .cs-manage')).toHaveAttribute('href', /\/api\/github\/auth\/install/);
  });

  test('only repositories chosen at install are offered and accepted', async ({ page }) => {
    await control(page, { selected: ['demo-owner/landing'] });
    await signIn(page);
    await s(page).repo.click();
    await expect(s(page).options).toHaveCount(1);
    await expect(page.locator('comenta-settings .cs-opt[data-repo="demo-owner/landing"]')).toBeVisible();
    const res = await page.request.put('/api/github/config', { data: { repo: 'acme-studio/web-app' }, headers: { 'X-Comenta-Space': space } });
    expect(res.status()).toBe(404);
  });

  test('an expired user token is refreshed without asking the owner', async ({ page }) => {
    await control(page, { expiresIn: 1 });
    await configure(page, 'demo-owner/landing', null);
    await control(page, { expiresIn: 28800 });
    const res = await leaveComment(page, 'После истечения токена');
    expect(res.issue?.number).toBe(1);
    expect((await ghState(page)).refreshes).toBeGreaterThan(0);
    await page.goto('/demo/settings.html');
    await expect(s(page).name).toHaveText('Владимир');
  });

  test('repository with issues turned off: clear error on save', async ({ page }) => {
    await signIn(page);
    await pickRepo(page, 'no-issues', 'demo-owner/no-issues');
    await s(page).save.click();
    await expect(s(page).notes.filter({ hasText: 'выключены issues' })).toBeVisible();
    await expect(s(page).saved).toContainText('Репозиторий ещё не выбран');
  });

  test('rate limit: readable message and retry', async ({ page }) => {
    await signIn(page);
    await expect(s(page).repo).toBeEnabled();
    await control(page, { rateLimit: 600 });
    await pickRepo(page, 'landing', 'demo-owner/landing'); // loads the owner's projects → limited
    const note = s(page).notes.filter({ hasText: 'GitHub временно ограничил число запросов' });
    await expect(note).toContainText('через 10 мин');
    await expect(s(page).project).toBeEnabled();
    await control(page, { rateLimit: 0 });
    await note.getByRole('button', { name: 'Повторить' }).click();
    await expect(note).toHaveCount(0);
    await expect(s(page).project.locator('option')).toHaveCount(3);
  });
});

test.describe('comments → GitHub issues', () => {
  test('a comment becomes an issue in the repository and the project; the thread links to it', async ({ page }) => {
    await configure(page);
    const res = await leaveComment(page, 'Кнопка «+1» не реагирует на двойной клик @someone');
    expect(res.issue).toMatchObject({ repo: 'acme-studio/web-app', number: 1 });
    const st = await ghState(page);
    expect(st.issues).toHaveLength(1);
    const issue = st.issues[0];
    expect(issue.title).toBe('Кнопка «+1» не реагирует на двойной клик @someone');
    expect(issue.body).toContain('| Элемент | `#inc` |');
    expect(issue.body).toContain(`<!-- comenta:id=${res.id} -->`);
    expect(issue.body).not.toContain(' @someone');
    expect(st.projectItems).toEqual([{ projectId: 'PVT_acme_3', contentId: issue.node_id }]);
    // the thread header links to the issue
    const w = widget(page);
    await w.pins.first().click();
    const link = page.locator('comenta-feedback .ph-issue');
    await expect(link).toHaveText('GitHub #1');
    await expect(link).toHaveAttribute('href', res.issue!.url);
    await expect(link).toHaveAttribute('target', '_blank');
    // and keeps it after a reload (the server stored it)
    await page.reload();
    await w.pins.first().click();
    await expect(link).toHaveText('GitHub #1');
  });

  test('a voice message is uploaded to the attachments branch and linked with its duration', async ({ page }) => {
    await configure(page, 'demo-owner/landing', null);
    await page.goto('/');
    const w = widget(page);
    await w.toggle.click();
    await page.locator('#inc').click();
    // Telegram-style: hold the record button (fake microphone)
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
    const body = await (await res).json();
    expect(body.issue.number).toBe(1);
    const st = await ghState(page);
    expect(st.branches['demo-owner/landing']).toEqual(['comenta-attachments']);
    expect(st.files).toHaveLength(1);
    expect(st.files[0]).toMatch(new RegExp(`^demo-owner/landing@comenta-attachments:comenta/${body.id}/voice-[\\w-]+\\.(webm|ogg|m4a|mp4)$`));
    expect(st.issues[0].body).toMatch(/- \[🎙 Голос, 0:0\d\]\(http:\/\/localhost:\d+\/__github\/web\/demo-owner\/landing\/blob\/comenta-attachments\/comenta\//);
    expect(st.issues[0].title).toBe('Голосовой комментарий: Comenta — демо виджета комментариев');
  });

  test('sending the same comment twice creates one issue', async ({ page }) => {
    await configure(page);
    const res = await leaveComment(page, 'Дубликат?');
    const payload = await page.evaluate(() => (window as unknown as { __lastPayload: unknown }).__lastPayload);
    const again = await page.request.post('/api/feedback', { data: payload, headers: { 'X-Comenta-Space': space } });
    expect((await again.json()).issue.number).toBe(res.issue!.number);
    expect((await ghState(page)).issues).toHaveLength(1);
  });

  test('GitHub is down: the comment is kept and becomes an issue once GitHub is back', async ({ page }) => {
    await configure(page);
    await control(page, { failNext: 1000 });
    const res = await leaveComment(page, 'Пока GitHub лежит');
    expect(res.ok).toBe(true);
    expect(res.issue).toBeUndefined();
    await control(page, { failNext: 0 });
    await expect.poll(async () => (await ghState(page)).issues.length, { timeout: 10_000 }).toBe(1);
    // the server stores the link (after adding the issue to the project) …
    await expect
      .poll(async () => (await (await page.request.get('/api/feedback', { headers: { 'X-Comenta-Space': space } })).json())[0]?.issue?.number, { timeout: 10_000 })
      .toBe(1);
    // … and it reaches the widget on the next refresh
    await page.reload();
    await widget(page).pins.first().click();
    await expect(page.locator('comenta-feedback .ph-issue')).toHaveText('GitHub #1');
  });

  test("issues are authored by the app's bot; one installation token serves several comments", async ({ page }) => {
    test.skip(!botMode, 'needs the app private key');
    await configure(page, 'demo-owner/landing', null);
    await leaveComment(page, 'Первый');
    await leaveComment(page, 'Второй');
    const st = await ghState(page);
    expect(st.issues.map((i) => [i.title, i.author])).toEqual([
      ['Первый', 'comenta-mock[bot]'],
      ['Второй', 'comenta-mock[bot]'],
    ]);
    expect(st.installationTokens).toBe(1);
    const status = await (await page.request.get('/api/github/status', { headers: { 'X-Comenta-Space': space } })).json();
    expect(status.bot).toBe(true);
  });

  test("owner's sign-in revoked: comments still become issues; settings ask to sign in to change them", async ({ page }) => {
    test.skip(!botMode, 'needs the app private key');
    await configure(page);
    await control(page, { revokeUser: true });
    await page.goto('/demo/settings.html');
    await expect(s(page).notes.filter({ hasText: 'Сессия входа в GitHub истекла. Комментарии по-прежнему создают issues' })).toBeVisible();
    await expect(s(page).login).toHaveText('Войти заново');
    const res = await leaveComment(page, 'После отзыва входа');
    expect(res.issue?.number).toBe(1);
    expect((await ghState(page)).issues[0].author).toBe('comenta-mock[bot]');
    await page.goto('/demo/settings.html');
    await s(page).login.click();
    await page.locator('#authorize').click();
    await page.waitForURL(/settings\.html$/);
    await expect(s(page).repo).toHaveValue('acme-studio/web-app');
  });

  test('app removed on GitHub: comments wait; installing it again sends them', async ({ page }) => {
    test.skip(!botMode, 'needs the app private key');
    await configure(page);
    await control(page, { installed: false });
    const res = await leaveComment(page, 'Пока приложение удалено');
    expect(res.issue).toBeUndefined();
    await page.waitForTimeout(1000); // longer than the retry queue tick
    expect((await ghState(page)).issues).toHaveLength(0);
    await page.goto('/demo/settings.html');
    await expect(s(page).notes.filter({ hasText: 'больше не установлено' }).or(s(page).notes.filter({ hasText: 'удалено из GitHub' }))).toBeVisible();
    // "Изменить доступ на GitHub" opens a new tab; follow it here
    await page.goto('/api/github/auth/install?return=/demo/settings.html');
    await expect(page).toHaveTitle(/Install/);
    await page.locator('#install').click();
    await page.waitForURL(/settings\.html$/);
    await expect.poll(async () => (await ghState(page)).issues.map((i) => i.title), { timeout: 10_000 }).toEqual(['Пока приложение удалено']);
  });

  test('no private key: revoked token asks to sign in again; queued comments are sent after it', async ({ page }) => {
    test.skip(botMode, 'user-token mode only');
    await configure(page);
    await control(page, { revoke: true });
    const res = await leaveComment(page, 'После отзыва токена');
    expect(res.issue).toBeUndefined();
    await page.goto('/demo/settings.html');
    await expect(s(page).notes.filter({ hasText: 'Доступ к GitHub истёк или был отозван' })).toBeVisible();
    await expect(s(page).login).toHaveText('Войти заново');
    await s(page).login.click();
    await page.locator('#authorize').click();
    await page.waitForURL(/settings\.html$/);
    await expect(s(page).repo).toHaveValue('acme-studio/web-app');
    await expect.poll(async () => (await ghState(page)).issues.map((i) => [i.title, i.author]), { timeout: 10_000 }).toEqual([['После отзыва токена', 'demo-owner']]);
  });

  test('logout deletes the token: GitHub grant revoked, new comments stay local', async ({ page }) => {
    await configure(page);
    await s(page).logout.click();
    await expect(s(page).notes.filter({ hasText: 'Отключить GitHub?' })).toBeVisible();
    await s(page).logoutYes.click();
    await expect(s(page).login).toBeVisible();
    expect((await ghState(page)).revoked).toBe(1);
    const res = await leaveComment(page, 'После выхода');
    expect(res.issue).toBeUndefined();
    await page.waitForTimeout(1000); // longer than the retry queue tick
    expect((await ghState(page)).issues).toHaveLength(0);
    // settings routes need the session again
    const r = await page.request.get('/api/github/repos', { headers: { 'X-Comenta-Space': space } });
    expect(r.status()).toBe(401);
  });

  test('without GitHub configured nothing changes for comments', async ({ page }) => {
    const res = await leaveComment(page, 'Обычный комментарий');
    expect(res.issue).toBeUndefined();
    await widget(page).pins.first().click();
    await expect(page.locator('comenta-feedback .ph-issue')).toHaveCount(0);
  });
});

test.describe('GitHub issue ↔ thread sync', () => {
  type Comment = { id: number; repo: string; number: number; body: string; login: string };
  const comments = async (page: Page): Promise<Comment[]> => (await (await page.request.get('/__github/state')).json()).comments;
  const act = async (page: Page, data: object) => (await page.request.post('/__github/issue', { data })).json();
  const state = (page: Page) => page.locator('comenta-feedback .ph-issue-state');
  const github = (page: Page) => page.locator('comenta-feedback .ph-msg-github');

  /** Configured repo, one comment that became issue #1, its thread open; the widget re-reads every 400 ms. */
  async function openSyncedThread(page: Page, text = 'Кнопка «+1» считает дважды') {
    await configure(page);
    const res = await leaveComment(page, text, '/?poll=400');
    expect(res.issue?.number).toBe(1);
    await widget(page).pins.first().click();
    await expect(page.locator('comenta-feedback .ph-issue')).toHaveText('GitHub #1');
    return res;
  }

  async function reply(page: Page, text: string) {
    const w = widget(page);
    await w.replyBox.fill(text);
    const done = page.waitForResponse((r) => r.url().includes('/replies') && r.request().method() === 'POST');
    await w.replyBtn.click();
    await done;
  }

  test('one status: closing or reopening the issue on GitHub closes or reopens the thread', async ({ page }) => {
    await openSyncedThread(page);
    const w = widget(page);
    const event = page.locator('comenta-feedback .ph-event');
    await expect(w.status).toHaveText('Открыт');
    await expect(state(page)).toHaveCount(0); // no second badge
    await act(page, { repo: 'acme-studio/web-app', number: 1, close: 'completed', login: 'octo-dev' });
    await expect(w.status).toHaveText('Закрыт');
    await expect(w.status).toHaveAttribute('data-status', 'resolved');
    await expect(event).toHaveText(/^octo-dev закрыл\(а\) на GitHub · \d/);
    // the button follows: reopen only, no second close
    await expect(w.resolveBtn).toHaveAttribute('aria-label', 'Открыть снова');
    await expect(w.replyResolveBtn).toBeHidden();
    await act(page, { repo: 'acme-studio/web-app', number: 1, reopen: true });
    await expect(w.status).toHaveText('Открыт');
    await expect(event).toHaveCount(0);
    await expect(w.resolveBtn).toHaveAttribute('aria-label', 'Закрыть');
    // "not planned" / duplicate: the same "Закрыт", in grey, with the reason
    await act(page, { repo: 'acme-studio/web-app', number: 1, close: 'not_planned', login: 'octo-dev' });
    await expect(w.status).toHaveAttribute('data-status', 'closed-other');
    await expect(w.status).toHaveText('Закрыт');
    await expect(event).toHaveText(/^octo-dev закрыл\(а\) на GitHub · не будет сделан · \d/);
    // the list's "Закрытые" filter has it
    await page.keyboard.press('Escape');
    await w.more.click();
    await page.locator('comenta-feedback .ph-mi-all').click();
    await page.locator('comenta-feedback .ph-panel-filters button', { hasText: 'Закрытые' }).click();
    await expect(w.items).toHaveCount(1);
  });

  test('closing or reopening in Comenta closes or reopens the issue; GitHub keeps agreeing', async ({ page }) => {
    await openSyncedThread(page);
    const w = widget(page);
    const issue = async () => (await ghState(page)).issues[0] as unknown as { state: string; state_reason: string | null };
    await w.resolveBtn.click();
    await expect(w.status).toHaveText('Закрыт');
    await expect(page.locator('comenta-feedback .ph-event')).toHaveText(/^Вы закрыли/);
    expect(await issue()).toMatchObject({ state: 'closed', state_reason: 'completed' });
    // several polls later it is still closed (the poll that was on its way does not undo it)
    await page.waitForTimeout(1200);
    await expect(w.status).toHaveText('Закрыт');
    await expect(w.resolveBtn).toHaveAttribute('aria-label', 'Открыть снова');
    await w.resolveBtn.click();
    await expect(w.status).toHaveText('Открыт');
    expect(await issue()).toMatchObject({ state: 'open' });
    // "reply and close": the reply reaches the issue, then the issue is closed
    await w.replyBox.fill('Исправлено в релизе');
    await w.replyResolveBtn.click();
    await expect(w.status).toHaveText('Закрыт');
    expect(await issue()).toMatchObject({ state: 'closed' });
    expect((await comments(page)).map((c) => c.body.split('\n')[0])).toEqual(['**Владимир:** Исправлено в релизе']);
  });

  test('GitHub does not answer: the status stays and the error is shown', async ({ page }) => {
    await openSyncedThread(page);
    await control(page, { failNext: 1000 });
    await widget(page).resolveBtn.click();
    await expect(widget(page).error).toContainText('Статус не изменён');
    await expect(widget(page).status).toHaveText('Открыт');
    await control(page, { failNext: 0 });
    expect(((await ghState(page)).issues[0] as unknown as { state: string }).state).toBe('open');
  });

  test('comments written on GitHub appear in the thread with name, avatar and "из GitHub"; edits and deletions follow', async ({ page }) => {
    await openSyncedThread(page);
    const { id } = await act(page, { repo: 'acme-studio/web-app', number: 1, comment: 'Воспроизвёл, чиню', login: 'octo-dev' });
    await expect(github(page)).toHaveCount(1);
    await expect(github(page).locator('.ph-msg-name')).toContainText('octo-dev');
    await expect(github(page).locator('.ph-msg-source')).toHaveText('из GitHub');
    await expect(github(page).locator('.ph-avatar')).toHaveAttribute('src', /avatar\.svg$/);
    await expect(github(page).locator('.ph-msg-text')).toHaveText('Воспроизвёл, чиню');
    // read-only here
    await expect(github(page).locator('.ph-msg-edit, .ph-msg-delete')).toHaveCount(0);
    await act(page, { editComment: id, body: 'Воспроизвёл, починил в #42' });
    await expect(github(page).locator('.ph-msg-text')).toHaveText('Воспроизвёл, починил в #42');
    await expect(github(page).locator('.ph-msg-edited')).toBeVisible();
    await act(page, { deleteComment: id });
    await expect(github(page)).toHaveCount(0);
  });

  test('replies go to the issue as comments signed with the name only; no echo; edits and deletions follow', async ({ page }) => {
    await openSyncedThread(page);
    await reply(page, 'Спасибо, посмотрим @team');
    await expect.poll(async () => (await comments(page)).length).toBe(1);
    const [c] = await comments(page);
    expect(c.body.split('\n')[0]).toBe('**Владимир:** Спасибо, посмотрим @​team');
    expect(c.body).toMatch(/<!-- comenta:reply=[\w-]+ -->/);
    expect(c.login).toBe(botMode ? 'comenta-mock[bot]' : 'demo-owner');
    // several polls later the thread still has the comment and one reply: the copy is not imported back
    await page.waitForTimeout(1500);
    await expect(widget(page).msgs).toHaveCount(2);
    await expect(github(page)).toHaveCount(0);
    // polling uses conditional requests: unchanged answers are 304s, which cost no rate limit
    expect((await (await page.request.get('/__github/state')).json()).notModified).toBeGreaterThan(0);
    // edit → the GitHub comment is rewritten
    await widget(page).msgs.last().hover();
    await page.locator('comenta-feedback .ph-msg-edit').click();
    await page.locator('comenta-feedback .ph-edit-text').fill('Спасибо, исправим завтра');
    await page.locator('comenta-feedback .ph-edit-save').click();
    await expect.poll(async () => (await comments(page))[0]?.body.split('\n')[0]).toBe('**Владимир:** Спасибо, исправим завтра');
    // delete → the GitHub comment is deleted
    await widget(page).msgs.last().hover();
    await page.locator('comenta-feedback .ph-msg-delete').click();
    await page.locator('comenta-feedback .ph-confirm .ph-btn-danger').click();
    await expect.poll(async () => (await comments(page)).length).toBe(0);
  });

  test('other visitors see neither the GitHub state nor GitHub comments; the owner does', async ({ page, browser }) => {
    const res = await openSyncedThread(page);
    await act(page, { repo: 'acme-studio/web-app', number: 1, comment: 'Внутреннее обсуждение', login: 'octo-dev' });
    await act(page, { repo: 'acme-studio/web-app', number: 1, close: 'completed' });
    await expect(github(page)).toHaveCount(1);
    await expect(widget(page).status).toHaveText('Закрыт');
    await expect(page.locator('comenta-feedback .ph-event')).toHaveText(/^octo-dev закрыл\(а\) на GitHub · \d/);

    // a visitor: no GitHub session, not the owner
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await guest.addInitScript((sp) => {
      (window as unknown as { __comentaSpace: string }).__comentaSpace = sp;
      localStorage.setItem('comenta-demo-user', 'anna');
    }, space);
    const listed = guest.waitForResponse((r) => r.url().includes('/api/feedback') && r.request().method() === 'GET');
    await guest.goto(`/?poll=400#comenta=${res.id}`); // closed threads' pins are hidden: open it by link
    const body = JSON.stringify(await (await listed).json());
    expect(body).not.toContain('Внутреннее обсуждение'); // the server does not send it at all
    expect(body).not.toContain('"state"');
    expect(body).not.toContain('octo-dev');
    await expect(guest.locator('comenta-feedback .ph-issue')).toHaveText('GitHub #1');
    await expect(guest.locator('comenta-feedback .ph-issue-state')).toHaveCount(0);
    await expect(guest.locator('comenta-feedback .ph-msg')).toHaveCount(1);
    // everyone sees that it is closed, not who closed it on GitHub
    await expect(widget(guest).status).toHaveText('Закрыт');
    await expect(guest.locator('comenta-feedback .ph-event')).toHaveText(/^Закрыт · \d/);
    await expect(widget(guest).resolveBtn).toHaveCount(0);
    await ctx.close();

    // the owner's own browser switched to another user hides them as well
    await widget(page).userSelect.selectOption('anna');
    await expect(github(page)).toHaveCount(0);
    await expect(state(page)).toHaveCount(0);
  });

  test("the comment's author sees the GitHub state and comments of their own comment", async ({ page, browser }) => {
    await configure(page);
    const visitor = async (user: string) => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.addInitScript(([sp, u]) => {
        (window as unknown as { __comentaSpace: string }).__comentaSpace = sp;
        localStorage.setItem('comenta-demo-user', u);
      }, [space, user] as const);
      return { ctx, p };
    };
    // Anna (not the owner, no GitHub session) leaves a comment that becomes issue #1
    const anna = await visitor('anna');
    const res = await leaveComment(anna.p, 'Не вижу кнопку оплаты', '/?poll=400');
    expect(res.issue?.number).toBe(1);
    await widget(anna.p).pins.first().click();
    await act(page, { repo: 'acme-studio/web-app', number: 1, comment: 'Уточните браузер, пожалуйста', login: 'octo-dev' });
    await act(page, { repo: 'acme-studio/web-app', number: 1, close: 'completed' });
    await expect(widget(anna.p).status).toHaveText('Закрыт');
    await expect(anna.p.locator('comenta-feedback .ph-event')).toHaveText(/^octo-dev закрыл\(а\) на GitHub · \d/);
    // the issue lives in the owner's repository: only the owner closes and reopens it
    await expect(widget(anna.p).resolveBtn).toHaveCount(0);
    await expect(github(anna.p).locator('.ph-msg-text')).toHaveText('Уточните браузер, пожалуйста');

    // a guest looking at the same page does not get them
    const guest = await visitor('guest');
    const listed = guest.p.waitForResponse((r) => r.url().includes('/api/feedback') && r.request().method() === 'GET');
    await guest.p.goto(`/?poll=400#comenta=${res.id}`);
    expect(JSON.stringify(await (await listed).json())).not.toContain('Уточните браузер');
    await expect(widget(guest.p).status).toHaveText('Закрыт');
    await expect(guest.p.locator('comenta-feedback .ph-issue-state')).toHaveCount(0);
    await expect(guest.p.locator('comenta-feedback .ph-msg-github')).toHaveCount(0);
    await anna.ctx.close();
    await guest.ctx.close();
  });

  test('deleted issue: the card says "Issue недоступен" and keeps the link', async ({ page }) => {
    const res = await openSyncedThread(page);
    await act(page, { repo: 'acme-studio/web-app', number: 1, delete: true });
    await expect(state(page)).toHaveText('Issue недоступен');
    await expect(page.locator('comenta-feedback .ph-issue')).toHaveAttribute('href', res.issue!.url);
  });

  test('transferred issue is marked unavailable too', async ({ page }) => {
    await openSyncedThread(page);
    await act(page, { repo: 'acme-studio/web-app', number: 1, transfer: 'acme-studio/mobile' });
    await expect(state(page)).toHaveText('Issue недоступен');
  });

  test('GitHub down or rate-limited: replies wait and are sent once it is back', async ({ page }) => {
    await openSyncedThread(page);
    await control(page, { rateLimit: 2 });
    await reply(page, 'Ответ во время лимита');
    await control(page, { rateLimit: 0, failNext: 1000 });
    await reply(page, 'Ответ, пока GitHub лежит');
    await page.waitForTimeout(800);
    expect(await comments(page)).toHaveLength(0);
    // the replies are already in the thread for everyone on the site
    await expect(widget(page).msgs).toHaveCount(3);
    await control(page, { failNext: 0 });
    await expect.poll(async () => (await comments(page)).map((c) => c.body.split('\n')[0]).sort(), { timeout: 15_000 }).toEqual(['**Владимир:** Ответ во время лимита', '**Владимир:** Ответ, пока GitHub лежит']);
    // one copy each, even though the first attempts may have reached GitHub
    await page.waitForTimeout(1000);
    expect(await comments(page)).toHaveLength(2);
  });

  test('a reply written before the issue exists is posted after it is created', async ({ page }) => {
    await configure(page);
    await control(page, { failNext: 1000 });
    const res = await leaveComment(page, 'Пока GitHub лежит', '/?poll=400');
    expect(res.issue).toBeUndefined();
    await widget(page).pins.first().click();
    await reply(page, 'Уточнение к комментарию');
    await control(page, { failNext: 0 });
    await expect.poll(async () => (await ghState(page)).issues.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(async () => (await comments(page)).map((c) => [c.number, c.body.split('\n')[0]]), { timeout: 10_000 }).toEqual([[1, '**Владимир:** Уточнение к комментарию']]);
  });
});

test.describe('security', () => {
  const payload = (id: string, extra: object = {}) => ({
    id,
    text: 'Проверка',
    target: { selector: '#inc', tag: 'button' },
    page: { url: 'http://localhost/', title: 'Demo', viewport: { w: 1280, h: 800 } },
    createdAt: new Date().toISOString(),
    author: { id: 'guest-1', name: 'Гость' },
    ...extra,
  });
  const headers = () => ({ 'X-Comenta-Space': space });

  test('a client-sent attachment url never makes the server read and upload its own files', async ({ page }) => {
    await configure(page, 'demo-owner/landing', null);
    const id = `sec-${Date.now()}`;
    const created = await page.request.post('/api/feedback', { data: payload(id), headers: headers() });
    expect(created.status()).toBe(201);
    await expect.poll(async () => (await ghState(page)).issues.length, { timeout: 10_000 }).toBe(1);
    // a reply that points its "recording" at a file outside the uploads folder (the GitHub App private key, tokens…)
    const evil = { id: 'evil-1', kind: 'audio', mimeType: 'audio/webm', name: 'voice.webm', url: '/uploads/../github-app.json' };
    const reply = await page.request.post(`/api/feedback/${id}/replies`, {
      data: { id: 'r-sec-1', text: 'смотри', createdAt: new Date().toISOString(), author: { id: 'guest-1', name: 'Гость' }, attachments: [evil] },
      headers: headers(),
    });
    expect(reply.status()).toBe(201);
    // the reply goes to GitHub, but without any file
    await expect.poll(async () => (await (await page.request.get('/__github/state')).json()).comments.length, { timeout: 10_000 }).toBe(1);
    expect((await ghState(page)).files).toEqual([]);
    const stored = (await (await page.request.get('/api/feedback', { headers: headers() })).json()).find((c: { id: string }) => c.id === id);
    expect(stored.replies[0].attachments[0].url).toBeUndefined();
  });

  test('uploads are only recordings and images, served so they can never run as a page', async ({ page }) => {
    const id = `sec-${Date.now()}`;
    const res = await page.request.post('/api/feedback', {
      headers: headers(),
      multipart: {
        payload: JSON.stringify(payload(id, { attachments: [{ id: 'html-1', kind: 'audio', mimeType: 'audio/webm', name: 'x' }, { id: 'ok-1', kind: 'audio', mimeType: 'audio/webm', name: 'voice.webm' }] })),
        'file:html-1': { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') },
        'file:ok-1': { name: 'voice.webm', mimeType: 'audio/webm', buffer: Buffer.from('webm') },
      },
    });
    expect(res.status()).toBe(201);
    const { attachments } = await res.json();
    expect(attachments).toEqual({ 'ok-1': '/uploads/ok-1.webm' });
    expect((await page.request.get('/uploads/html-1.html')).status()).toBe(404);
    expect((await page.request.get('/uploads/..%2fgithub-app.json')).status()).toBe(404);
    const media = await page.request.get('/uploads/ok-1.webm');
    expect(media.status()).toBe(200);
    expect(media.headers()['content-type']).toBe('video/webm');
    expect(media.headers()['x-content-type-options']).toBe('nosniff');
    expect(media.headers()['content-security-policy']).toContain('sandbox');
  });
});
