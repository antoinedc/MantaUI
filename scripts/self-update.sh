#!/usr/bin/env bash
# self-update.sh — pull latest main on the box, reinstall deps, refresh the
# prebuilt mobile bundle, restart server.
#
# Wired up in BET-225 stage 2 (server-side update poller calls this on a
# cadence). Manual invocation also works — idempotent.
#
# Resets the local checkout to origin/main, reinstalls prod-only deps, fetches
# the CI-built mobile PWA bundle, and restarts the systemd --user service that
# runs manta-server. Safe to re-run.
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
# MOBILE BUNDLE (why it's fetched, not pulled)
# --------------------------------------------
# mobile/www/ is the PWA bundle the server serves statically. It is a BUILD
# ARTIFACT of src/renderer/ and is deliberately NOT committed to git (Vite
# content-hashes filenames, which made every two in-flight PRs conflict). The
# `mobile-bundle-deploy.yml` workflow builds it on every push to main and
# publishes it to the release host as a versioned tarball + manifest. So after
# `git reset --hard origin/main` the checkout has NO mobile/www/ — this script
# downloads + verifies + extracts the tarball to restore it, keeping the served
# bundle in lockstep with main's source. A fresh install gets its bundle from
# the release tarball (scripts/release/pack.mjs builds it); this path covers
# ongoing updates.
#
# Override the release host with MANTA_RELEASE_HOST (default https://mantaui.com),
# same knob as install.sh.

set -euo pipefail

MANTA_HOME="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_HOST="${MANTA_RELEASE_HOST:-https://mantaui.com}"

echo "▸ self-update: fetching origin/main into $MANTA_HOME"
git -C "$MANTA_HOME" fetch origin main -q

echo "▸ self-update: resetting to origin/main"
git -C "$MANTA_HOME" reset --hard origin/main -q

echo "▸ self-update: reinstalling prod-only deps"
npm ci --omit=dev --prefix "$MANTA_HOME"

# --- Refresh the prebuilt mobile bundle -------------------------------------
# Non-fatal: if the release host is unreachable or the manifest is missing, we
# warn and keep whatever mobile/www/ is already on disk (server still runs; the
# bundle just stays at its prior version until the next successful fetch). We
# extract to a temp dir + verify the payload BEFORE swapping so a torn download
# never replaces a good bundle with a broken one.
refresh_mobile_bundle() {
  local manifest_url="$RELEASE_HOST/releases/mobile-latest.txt"
  echo "▸ self-update: fetching mobile bundle manifest ($manifest_url)"

  local manifest
  if ! manifest="$(curl -fsSL "$manifest_url" 2>/dev/null)"; then
    echo "⚠ self-update: mobile bundle manifest unreachable — keeping existing mobile/www/"
    return 0
  fi

  local file want_sha
  file="$(printf '%s\n' "$manifest" | sed -n 's/^file=//p' | head -1)"
  want_sha="$(printf '%s\n' "$manifest" | sed -n 's/^sha256=//p' | head -1)"
  if [ -z "$file" ] || [ -z "$want_sha" ]; then
    echo "⚠ self-update: malformed mobile bundle manifest — keeping existing mobile/www/"
    return 0
  fi

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  local tarball_url="$RELEASE_HOST/releases/$file"
  echo "▸ self-update: downloading mobile bundle ($tarball_url)"
  if ! curl -fsSL "$tarball_url" -o "$tmp/bundle.tar.gz"; then
    echo "⚠ self-update: mobile bundle download failed — keeping existing mobile/www/"
    return 0
  fi

  local got_sha
  # sha256sum (Linux/coreutils) or shasum (macOS) — pick whichever is present.
  # Same logic as install.sh's _sha256_of; kept inline here so self-update.sh
  # stays a self-contained script with no install.sh dependency.
  if command -v sha256sum >/dev/null 2>&1; then
    got_sha="$(sha256sum "$tmp/bundle.tar.gz" | cut -d' ' -f1)"
  else
    got_sha="$(shasum -a 256 "$tmp/bundle.tar.gz" | cut -d' ' -f1)"
  fi
  if [ "$got_sha" != "$want_sha" ]; then
    echo "⚠ self-update: mobile bundle sha256 mismatch (got $got_sha want $want_sha) — keeping existing mobile/www/"
    return 0
  fi

  # The tarball contains the mobile/www/ prefix. Extract to a staging dir and
  # sanity-check the payload before swapping it in.
  if ! tar -xzf "$tmp/bundle.tar.gz" -C "$tmp"; then
    echo "⚠ self-update: mobile bundle extract failed — keeping existing mobile/www/"
    return 0
  fi
  if [ ! -f "$tmp/mobile/www/index.html" ]; then
    echo "⚠ self-update: extracted bundle missing mobile/www/index.html — keeping existing mobile/www/"
    return 0
  fi

  # Atomic-ish swap: rsync the new tree into place (mirror, deleting stale
  # hashed assets), then done. rsync --delete keeps the dir from accumulating
  # old content-hashed files across versions.
  mkdir -p "$MANTA_HOME/mobile/www"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$tmp/mobile/www/" "$MANTA_HOME/mobile/www/"
  else
    rm -rf "$MANTA_HOME/mobile/www"
    mkdir -p "$MANTA_HOME/mobile"
    mv "$tmp/mobile/www" "$MANTA_HOME/mobile/www"
  fi
  echo "✓ self-update: mobile bundle refreshed ($file)"
}

refresh_mobile_bundle

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
