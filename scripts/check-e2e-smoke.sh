#!/usr/bin/env bash
# E2E smoke test gate for the MANTA Electron build.
#
# Builds the bundles then runs the full Playwright suite against them. The
# suite has two projects: `electron` (launches the built app via `out/`) and
# `visual` (serves the built renderer via `mobile/www`, verified fresh by
# scripts/visual/harness.mjs -> assertRendererFresh). So both bundles must be
# built here before `npx playwright test`. This is a HARD gate — exits non-zero
# on any failure.
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

echo "==> Building mobile renderer (the visual project needs mobile/www)..."
npm run build:mobile

echo
echo "==> Running Playwright e2e smoke tests..."
npx playwright test
