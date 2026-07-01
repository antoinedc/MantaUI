import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['html', { open: 'never' }]],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.e2e\.ts/,
      use: {
        // Electron launcher — launches the built app directly.
        // See tests/e2e/example.e2e.ts for the launch pattern.
        launchOptions: {
          args: ['out/main/index.js'],
        },
      },
    },
  ],
});
