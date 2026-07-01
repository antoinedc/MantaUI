import { test, expect, chromium, BrowserContext } from '@playwright/test';
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let electronProcess: ReturnType<typeof spawn>;
let context: BrowserContext;

test.describe('BUI Electron App', () => {
  test.beforeAll(async () => {
    // Start Electron with the built app
    const electronPath = path.join(__dirname, '../../node_modules/.bin/electron');
    const appPath = path.join(__dirname, '../../out/main/index.js');

    electronProcess = spawn(electronPath, [appPath, '--no-sandbox', '--remote-debugging-port=9222'], {
      env: { ...process.env, NODE_ENV: 'test' },
    });

    // Wait for Electron to start and expose DevTools protocol
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Connect to the DevTools protocol
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    context = browser.contexts()[0];
  });

  test.afterAll(async () => {
    if (electronProcess) {
      electronProcess.kill();
    }
  });

  test('app window is visible and not crashed', async () => {
    const pages = context.pages();
    expect(pages.length).toBeGreaterThan(0);

    const page = pages[0];
    const url = page.url();
    expect(url).toBeTruthy();

    // Take a screenshot to verify the app rendered
    await page.screenshot({ path: 'tests/e2e/test-output/app-ready.png' });
  });
});
