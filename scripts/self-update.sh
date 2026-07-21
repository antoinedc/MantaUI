#!/usr/bin/env bash
# self-update.sh — pull latest main on the box, reinstall deps, restart server.
#
# Wired up in BET-225 stage 2 (server-side update poller calls this on a
# cadence). Manual invocation also works — idempotent.
#
# Resets the local checkout to origin/main, reinstalls prod-only deps, and
# restarts the systemd --user service that runs manta-server. Safe to re-run.
#
# Run from anywhere; the script derives its checkout from $0 so the caller's
# cwd doesn't matter.
#
# Requires: a clean working tree (git reset --hard will discard any local
# edits), systemd --user with the manta-server.service unit enabled
# (`loginctl enable-linger $USER`).
#
# No flags, no branch parameterization — always pins to origin/main.

set -euo pipefail

MANTA_HOME="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ self-update: fetching origin/main into $MANTA_HOME"
git -C "$MANTA_HOME" fetch origin main -q

echo "▸ self-update: resetting to origin/main"
git -C "$MANTA_HOME" reset --hard origin/main -q

echo "▸ self-update: reinstalling prod-only deps"
npm ci --omit=dev --prefix "$MANTA_HOME"

echo "▸ self-update: restarting manta-server.service"
systemctl --user restart manta-server.service

echo "✓ self-update: complete"
