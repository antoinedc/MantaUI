#!/usr/bin/env bash
# desktop.sh — build the Manta UI desktop installers.
#
#   bash scripts/release/desktop.sh [--mac-only|--linux-only]
#
# What it does:
#   1. `npm run build` then `npx electron-builder --mac --linux --publish never`.
#      `--publish never` tells electron-builder to emit the
#      `latest-mac.yml` / `latest-linux.yml` files next to the binaries
#      (electron-updater's "generic" feed) but to NOT upload anything.
#   2. Print the exact publish command the owner runs to ship the artifacts
#      to the prod box. Nothing is uploaded by this script — see
#      `scripts/release/publish.sh` for the single source of upload truth.
#
# Where the owner sends artifacts (per BET-154):
#   - /var/www/mantaui/updates/  — full output dir, includes the latest-*.yml
#                                  feeds (electron-updater's "generic" provider
#                                  polls `${url}/latest-mac.yml` and
#                                  `${url}/latest-linux.yml`).
#   - /var/www/mantaui/downloads/ — human-facing binaries; the website's
#                                   "Download" buttons link to the
#                                   `Manta-latest.{dmg,AppImage}` copies here.
#
# Env:
#   MANTA_PROD_HOST  ssh target (default `root@91.107.196.2`). Override for
#                    local testing or a staging box — never embed a host.
#
# Flags:
#   --mac-only       only build mac targets (skip linux)
#   --linux-only     only build linux targets (skip mac)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# --- arg parsing -----------------------------------------------------------
BUILD_MAC=1
BUILD_LINUX=1
for arg in "$@"; do
  case "$arg" in
    --mac-only)   BUILD_LINUX=0 ;;
    --linux-only) BUILD_MAC=0 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

PROD_HOST="${MANTA_PROD_HOST:-root@91.107.196.2}"
OUTPUT_DIR="dist/desktop"

# --- build -----------------------------------------------------------------
echo "▸ Building renderer + main bundles…"
npm run build

EB_ARGS=(electron-builder)
[ "${BUILD_MAC}"   -eq 1 ] && EB_ARGS+=(--mac)
[ "${BUILD_LINUX}" -eq 1 ] && EB_ARGS+=(--linux)
EB_ARGS+=(--publish never)

echo "▸ Running: npx ${EB_ARGS[*]}"
npx "${EB_ARGS[@]}"

# --- enumerate artifacts ---------------------------------------------------
shopt -s nullglob

DMGS=( "${OUTPUT_DIR}"/*.dmg )
APPIMAGES=( "${OUTPUT_DIR}"/*.AppImage )

# Pick the canonical "latest" files the website buttons link to. The artifact
# name is `<productName>-<version>-<arch>.<ext>`; on Apple Silicon hosts the
# arm64 dmg is the right pick, on linux x64 the AppImage is the only one
# built today. We pick the highest-arch one we can find and print its name
# so the owner can sanity-check before publishing.
pick_latest() {
  # args: <pattern...> ; prints the lexicographically largest basename.
  local f
  for f in "$@"; do echo "$(basename "$f")"; done | sort -V | tail -n 1
}

LATEST_DMG=""
LATEST_APPIMAGE=""
if [ "${#DMGS[@]}" -gt 0 ]; then
  LATEST_DMG="$(pick_latest "${DMGS[@]}")"
fi
if [ "${#APPIMAGES[@]}" -gt 0 ]; then
  LATEST_APPIMAGE="$(pick_latest "${APPIMAGES[@]}")"
fi

if [ -z "${LATEST_DMG}" ] && [ "${BUILD_MAC}" -eq 1 ]; then
  echo "✗ no .dmg in ${OUTPUT_DIR}/ — mac build failed silently?" >&2
  exit 1
fi
if [ -z "${LATEST_APPIMAGE}" ] && [ "${BUILD_LINUX}" -eq 1 ]; then
  echo "✗ no .AppImage in ${OUTPUT_DIR}/ — linux build failed silently?" >&2
  exit 1
fi

FEEDS=()
[ -f "${OUTPUT_DIR}/latest-mac.yml" ]   && FEEDS+=( "${OUTPUT_DIR}/latest-mac.yml" )
[ -f "${OUTPUT_DIR}/latest-linux.yml" ] && FEEDS+=( "${OUTPUT_DIR}/latest-linux.yml" )

# --- owner checklist -------------------------------------------------------
cat <<EOF

✓ Build complete. Artifacts in ${OUTPUT_DIR}/.

To publish, run:

  bash scripts/release/publish.sh

(That script uploads the tarball + desktop binaries, deploys the relay, and
verifies every URL. It picks up the latest dmg/AppImage from ${OUTPUT_DIR}/ —
this script's only job was to BUILD them. Re-run \`publish.sh\` from any host
that has the artifacts; pass MANTA_PROD_HOST=... for a non-prod target.)

Latest dmg       : ${LATEST_DMG:-"(none — mac skipped)"}
Latest AppImage  : ${LATEST_APPIMAGE:-"(none — linux skipped)"}
MANTA_PROD_HOST  : ${PROD_HOST}
EOF
