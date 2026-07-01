import { describe, it, expect } from 'vitest';

describe('BET-8 E2E Smoke Gate', () => {
  it('should confirm Playwright is installed', () => {
    const { execSync } = require('child_process');
    const version = execSync('npx playwright --version', { encoding: 'utf-8' }).trim();
    expect(version).toMatch(/^Version \d+\.\d+\.\d+$/);
  });

  it('should confirm the e2e test file exists', () => {
    const { existsSync } = require('fs');
    const testFile = 'tests/e2e/example.e2e.ts';
    expect(existsSync(testFile)).toBe(true);
  });

  it('should confirm the check-e2e-smoke.sh script exists', () => {
    const { existsSync } = require('fs');
    const script = 'scripts/check-e2e-smoke.sh';
    expect(existsSync(script)).toBe(true);
  });
});
