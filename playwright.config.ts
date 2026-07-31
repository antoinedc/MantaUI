import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Both suites live under tests/; each project narrows by filename.
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Visual assertions are deterministic by construction (fixed fixture, no
  // network, animations disabled, selector-gated). A retry would only mask a
  // real regression as an intermittent one, so the visual project opts out
  // below.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // A handful of pixels differ between otherwise-identical renders on the
    // same machine (subpixel AA on rounded corners). Anything a human would
    // notice is orders of magnitude above this.
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
  },
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
    {
      // Visual verification: drives the demo-mode build in a browser and
      // compares structure + pixels against committed baselines. Needs
      // `npm run build:mobile` to have run — the npm script chains it.
      name: 'visual',
      testMatch: /.*\.visual\.ts/,
      retries: 0,
    },
  ],
});
