#!/usr/bin/env bash
# E2E smoke test gate for the MANTA Electron build.
#
# Builds the bundles then runs the full Playwright suite against them. The
# suite has two projects: `electron` (launches the built app via `out/`) and
# `visual` (serves the built renderer via `out/renderer`, verified fresh by
# scripts/visual/harness.mjs -> assertRendererFresh). BET-559: the desktop
# renderer build serves the visual project now that the web/PWA bundle is
# retired, so `npm run build` produces everything the suite needs. This is a
# HARD gate — exits non-zero on any failure.
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

echo "==> Building Electron bundles (the visual project serves out/renderer)..."
npm run build

echo
echo "==> Running Playwright e2e smoke tests..."
npx playwright test
