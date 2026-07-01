#!/usr/bin/env bash
# E2E smoke test gate for the BUI Electron build.
#
# Builds the Electron bundles, then runs the Playwright e2e suite against the
# built app. This is a HARD gate — exits non-zero on any failure.
#
# Designed to run on self-hosted CI runners. Requires:
#   - Node.js 20+
#   - @playwright/test installed (devDep)
#   - Display server (Xvfb) for headless Electron on CI runners
#
# Usage:
#   scripts/check-e2e-smoke.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building Electron bundles..."
npm run build

echo
echo "==> Running Playwright e2e smoke tests..."
npx playwright test
