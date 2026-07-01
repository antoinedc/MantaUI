import { test, expect, ElectronApplication, BrowserContext, chromium } from '@playwright/test';

let app: ElectronApplication;
let mainWindow: BrowserContext;

test.describe('BUI Electron App', () => {
  test.beforeAll(async () => {
    // Launch the Electron app
    app = await chromium.launch({
      executablePath: 'out/main/index.js',
      args: ['--no-sandbox'],
    } as any);

    mainWindow = app.contexts()[0];
    await mainWindow.waitForLoadState('domcontentloaded');

    // Give the renderer a moment to fully initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('app window is visible and not crashed', async () => {
    const pages = mainWindow.pages();
    expect(pages.length).toBeGreaterThan(0);

    const page = pages[0];
    const url = page.url();
    expect(url).toBeTruthy();

    // Take a screenshot to verify the app rendered
    await page.screenshot({ path: 'tests/e2e/test-output/app-ready.png' });
  });
});
