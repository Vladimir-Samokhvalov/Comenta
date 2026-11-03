import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5175);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    // fake microphone / camera; getDisplayMedia is stubbed per test
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  webServer: {
    command: 'node demo/server.mjs',
    port: PORT,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      FEEDBACK_LOG: `${process.env.TMPDIR ?? '/tmp'}/comenta-e2e-feedback.log`,
      FEEDBACK_UPLOADS: `${process.env.TMPDIR ?? '/tmp'}/comenta-e2e-uploads`,
    },
  },
});
