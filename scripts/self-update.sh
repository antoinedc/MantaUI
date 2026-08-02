#!/usr/bin/env bash
# self-update.sh — pull latest main on the box, reinstall deps, restart server.
#
# Wired up in BET-225 stage 2 (server-side update poller calls this on a
# cadence). Manual invocation also works — idempotent.
#
# Resets the local checkout to origin/main and reinstalls prod-only deps, then
# refreshes the manta-native opencode tools and restarts the systemd --user
# service that runs manta-server. Safe to re-run.
#
# Run from anywhere; the script derives its checkout from $0 so the caller's
# cwd doesn't matter.
#
# Requires: a clean working tree (git reset --hard will discard any local
# edits), systemd --user with the manta-server.service unit enabled
# (`loginctl enable-linger $USER`).
#
# No flags, no branch parameterization — always pins to origin/main.
#
# BET-559: the box no longer fetches a prebuilt mobile/PWA bundle — that was
# the served web client, which is retired. Nothing here rebuilds or downloads a
# bundle; self-update only pulls server source + deps + the AI tool copies.

set -euo pipefail

MANTA_HOME="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ self-update: fetching origin/main into $MANTA_HOME"
git -C "$MANTA_HOME" fetch origin main -q

echo "▸ self-update: resetting to origin/main"
git -C "$MANTA_HOME" reset --hard origin/main -q

echo "▸ self-update: reinstalling prod-only deps"
npm ci --omit=dev --prefix "$MANTA_HOME"

# --- Refresh the manta-native opencode tools --------------------------------
# The AI-facing tool sources (docs/opencode-tools/*.ts) are COPIED into
# ~/.config/opencode/tools/ rather than symlinked — opencode resolves a tool's
# imports from the file's REAL path, so a symlink back into the checkout misses
# ~/.config/opencode/node_modules/@opencode-ai/plugin and the tool silently
# never registers.
#
# WHY THIS IS HERE: install.sh does that copy, but ONLY on install. Nothing in
# the update path did, so `git reset --hard origin/main` refreshed the SOURCE
# while every box kept running whatever tool copy it was installed with. Any
# change to what the AI is told about a tool was therefore undeliverable to an
# existing box — BET-344 rewrote serve_page's description to stop naming the
# retired *.pages.mantaui.com domain, and no box would ever have seen it.
#
# Non-fatal throughout: a tool copy failing must never abort an update that has
# already reset the checkout and reinstalled deps.
#
# NOTE: we deliberately do NOT restart opencode here. Picking up a new tool
# needs an opencode restart, but that kills every in-flight agent turn on the
# box — which is exactly the "close the lid and the work carries on" guarantee
# the product is built on. Staging the files is safe and unconditional; they
# take effect at the next opencode restart, and we say so.
refresh_opencode_tools() {
  local src="$MANTA_HOME/docs/opencode-tools"
  local dest="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/tools"

  if [ ! -d "$src" ]; then
    echo "⚠ self-update: $src not found — skipping opencode tool refresh"
    return 0
  fi
  if ! mkdir -p "$dest" 2>/dev/null; then
    echo "⚠ self-update: cannot create $dest — skipping opencode tool refresh"
    return 0
  fi

  # EXCLUDE *.test.ts: opencode loads EVERY file in tools/ as a tool, and a
  # test file imports vitest (absent under ~/.config/opencode/node_modules),
  # which makes tool resolution throw and every chat turn fail with
  # "Cannot find package 'vitest'". Same exclusion as install.sh.
  local copied=0 changed=0 tool base
  for tool in "$src"/*.ts; do
    case "$tool" in
      *.test.ts) continue ;;
    esac
    [ -e "$tool" ] || continue
    base="$(basename "$tool")"
    if ! cmp -s "$tool" "$dest/$base" 2>/dev/null; then
      changed=$((changed + 1))
    fi
    if cp -f "$tool" "$dest/" 2>/dev/null; then
      copied=$((copied + 1))
    else
      echo "⚠ self-update: failed to copy opencode tool $base"
    fi
  done

  if [ "$copied" = "0" ]; then
    echo "⚠ self-update: no opencode tool sources found in $src"
    return 0
  fi
  if [ "$changed" = "0" ]; then
    echo "✓ self-update: opencode tools already current ($copied checked)"
    return 0
  fi
  echo "✓ self-update: opencode tools refreshed ($changed of $copied changed)"
  echo "  ↳ restart opencode to load them (this will end any running agent turn):"
  if command -v systemctl >/dev/null 2>&1; then
    echo "      systemctl --user restart opencode-serve"
  elif [ "$(uname -s)" = "Darwin" ]; then
    echo "      launchctl kickstart -k gui/\$(id -u)/com.mantaui.opencode"
  fi
}

refresh_opencode_tools

# Restart the supervisor that runs manta-server. Linux uses the systemd
# --user unit (default since v1); macOS (BET-277) uses the LaunchAgent
# installed by install.sh — `launchctl kickstart -k` kills any running
# instance and starts a fresh one. Other hosts have no persistent
# supervisor and the user is expected to restart by hand.
if command -v systemctl >/dev/null 2>&1; then
  echo "▸ self-update: restarting manta-server.service"
  systemctl --user restart manta-server.service
elif [ "$(uname -s)" = "Darwin" ]; then
  echo "▸ self-update: kickstarting com.mantaui.server LaunchAgent"
  launchctl kickstart -k "gui/$(id -u)/com.mantaui.server"
else
  echo "⚠ self-update: no systemctl/launchctl — restart manta-server manually"
fi

echo "✓ self-update: complete"
