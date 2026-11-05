// Plain JS: it needs Node APIs, and the TypeScript tests are type-checked without Node types.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('pnpm github-app:setup registers the app from a manifest and saves its credentials', async ({ page, baseURL }) => {
  const file = join(tmpdir(), `comenta-app-${Date.now()}.json`);
  const child = spawn('node', ['demo/github-app-setup.mjs'], {
    env: { ...process.env, SETUP_PORT: '5177', GITHUB_APP_FILE: file, GITHUB_WEB_URL: `${baseURL}/__github`, GITHUB_API_URL: `${baseURL}/__github/api` },
  });
  try {
    await new Promise((r) => child.stdout.once('data', r));
    await page.goto('http://localhost:5177/');
    await expect(page.locator('h1')).toHaveText('GitHub App создан');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ slug: 'comenta-mock', clientId: 'mock-client', clientSecret: 'mock-secret' });
  } finally {
    child.kill();
    rmSync(file, { force: true });
  }
});
