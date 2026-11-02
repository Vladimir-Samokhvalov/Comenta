import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5175);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
  webServer: {
    command: 'node demo/server.mjs',
    port: PORT,
    reuseExistingServer: false,
    env: { PORT: String(PORT), FEEDBACK_LOG: `${process.env.TMPDIR ?? '/tmp'}/pinhelp-e2e-feedback.log` },
  },
});
