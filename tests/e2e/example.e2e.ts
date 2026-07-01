import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import * as path from 'path';

test.describe('BUI Electron App Build Verification', () => {
  test('main process bundle exists and is valid', () => {
    const mainBundle = path.join(process.cwd(), 'out/main/index.js');
    expect(existsSync(mainBundle)).toBe(true);

    const content = readFileSync(mainBundle, 'utf-8');
    expect(content.length).toBeGreaterThan(1000);
    expect(content).toContain('function');
  });

  test('preload bundle exists and is valid', () => {
    const preloadBundle = path.join(process.cwd(), 'out/preload/index.mjs');
    expect(existsSync(preloadBundle)).toBe(true);

    const content = readFileSync(preloadBundle, 'utf-8');
    expect(content.length).toBeGreaterThan(100);
  });

  test('renderer bundle exists and is valid', () => {
    const rendererHtml = path.join(process.cwd(), 'out/renderer/index.html');
    expect(existsSync(rendererHtml)).toBe(true);

    const content = readFileSync(rendererHtml, 'utf-8');
    expect(content.toLowerCase()).toContain('<!doctype html>');
    expect(content).toContain('<div');
  });

  test('renderer assets exist', () => {
    const rendererAssets = path.join(process.cwd(), 'out/renderer/assets');
    expect(existsSync(rendererAssets)).toBe(true);

    const files = readdirSync(rendererAssets);
    expect(files.length).toBeGreaterThan(0);
  });
});
