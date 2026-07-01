import { test, expect } from '@playwright/test';
import * as electron from '@playwright/test';

let app: electron.ElectronApplication;
let mainWindow: electron.BrowserContext;

test.describe('BUI Electron App', () => {
  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['out/main/index.js'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    });

    mainWindow = app.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');

    // Give the renderer a moment to fully initialize
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      await new Promise<void>((resolve) => {
        if (window.isDestroyed()) return resolve();
        window.once('ready-to-show', () => resolve());
        if (!window.isDestroyed() && window.isVisible()) resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('app window is visible and not crashed', async () => {
    const isClosed = await mainWindow.closed().catch(() => true);
    expect(isClosed).toBe(false);

    const title = await mainWindow.title();
    expect(title).toBeTruthy();

    await mainWindow.screenshot({ path: 'tests/e2e/test-output/app-ready.png' });
  });
});
