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
  got_sha="$(sha256sum "$tmp/bundle.tar.gz" | cut -d' ' -f1)"
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

echo "▸ self-update: restarting manta-server.service"
systemctl --user restart manta-server.service

echo "✓ self-update: complete"
