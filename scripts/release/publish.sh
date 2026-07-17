#!/usr/bin/env bash
# publish.sh — publish a built manta release to the prod box in one command.
#
#   bash scripts/release/publish.sh
#
# What it does (in order; each step idempotent and runs unconditionally unless
# its artifact is missing — desktop is a separately-shippable leg, not a failure):
#   1. preflight   refuse if git tree is dirty, if v<version> tag already
#                  exists, or if dist/manta-<version>.tar.gz is absent (run
#                  `npm run pack` first).
#   2. tarball     scp dist/manta-<version>.tar.gz to
#                  <host>:/var/www/mantaui/releases/ and refresh
#                  manta-latest.tar.gz there.
#   3. desktop     if dist/desktop/ has binaries: scp them + the latest-*.yml
#                  feeds to <host>:/var/www/mantaui/updates/ and the binaries
#                  to /var/www/mantaui/downloads/, then refresh
#                  Manta-latest.{dmg,AppImage}. If dist/desktop/ is empty
#                  (e.g. mac build runs on a Mac): print the exact one-line
#                  command the owner runs there and continue — desktop is a
#                  separate leg, not a release blocker.
#   4. relay       ssh <host> 'git -C /opt/manta pull && systemctl restart
#                  manta-relay && systemctl is-active manta-relay', then sync
#                  the freshly-pulled scripts/install.sh into the Caddy web
#                  root (/var/www/mantaui/install.sh) — the pull updates the
#                  repo checkout, but Caddy serves install.sh statically from
#                  the web root, so without this copy the advertised one-liner
#                  keeps serving the stale installer (BET-171).
#   5. verify      HEAD each published URL — tarball 200, install.sh 200,
#                  and (if desktop uploaded) Manta-latest.{dmg,AppImage} 200.
#                  install.sh is ALSO content-verified: the served body must
#                  byte-match the repo's scripts/install.sh (a 200 alone does
#                  not prove the deploy took — a stale file also 200s).
#                  Fail loudly on any non-200 or content mismatch.
#   6. tag         git tag v<version> && git push origin v<version> (a tag
#                  means "published and verified").
#
# Env:
#   MANTA_PROD_HOST  ssh target (default `root@91.107.196.2`). Override for
#                    local testing or a staging box — never embed a host.
#   MANTA_SITE       public URL the install tarball is served from
#                    (default https://mantaui.com). Used by the verify step.
#
# Idempotency: re-publishing the current version against prod (same artifacts
# in place) is a no-op end-to-end — scp overwrites, ssh runs again, tag is
# refused if it already exists.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

PROD_HOST="${MANTA_PROD_HOST:-root@91.107.196.2}"
SITE="${MANTA_SITE:-https://mantaui.com}"

VERSION="$(node -p 'require("./package.json").version')"
TARBALL="dist/manta-${VERSION}.tar.gz"
DESKTOP_DIR="dist/desktop"
WEBROOT_DIR="/var/www/mantaui"
RELEASES_DIR="${WEBROOT_DIR}/releases"
UPDATES_DIR="${WEBROOT_DIR}/updates"
DOWNLOADS_DIR="${WEBROOT_DIR}/downloads"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. preflight -----------------------------------------------------------
log "Preflight (version=${VERSION}, host=${PROD_HOST})…"

if [ -n "$(git status --porcelain)" ]; then
  die "git tree is dirty — commit/stash before publishing"
fi

if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
  die "tag v${VERSION} already exists — a tag means 'published and verified'. To re-publish the same version (idempotent), delete the tag first: git tag -d v${VERSION} && git push origin :v${VERSION}"
fi

if [ ! -f "${TARBALL}" ]; then
  die "${TARBALL} missing — run \`npm run pack\` first"
fi

ok "preflight ok"

# --- 2. tarball -------------------------------------------------------------
log "Uploading ${TARBALL} → ${PROD_HOST}:${RELEASES_DIR}/…"
scp "${TARBALL}" "${PROD_HOST}:${RELEASES_DIR}/"
ssh "${PROD_HOST}" "cd ${RELEASES_DIR} && cp -f manta-${VERSION}.tar.gz manta-latest.tar.gz"
ok "tarball published"

# --- 3. desktop (optional leg) ----------------------------------------------
shopt -s nullglob
DMGS=( "${DESKTOP_DIR}"/*.dmg )
APPIMAGES=( "${DESKTOP_DIR}"/*.AppImage )
FEEDS=()
[ -f "${DESKTOP_DIR}/latest-mac.yml" ]   && FEEDS+=( "${DESKTOP_DIR}/latest-mac.yml" )
[ -f "${DESKTOP_DIR}/latest-linux.yml" ] && FEEDS+=( "${DESKTOP_DIR}/latest-linux.yml" )

pick_latest() {
  # args: <pattern...> ; prints the lexicographically largest basename.
  local f
  for f in "$@"; do echo "$(basename "$f")"; done | sort -V | tail -n 1
}

if [ "${#DMGS[@]}" -eq 0 ] && [ "${#APPIMAGES[@]}" -eq 0 ]; then
  warn "no desktop artifacts in ${DESKTOP_DIR}/ — skipping desktop leg."
  warn "If you build desktop on a separate host (e.g. mac), run there:"
  warn "  bash scripts/release/desktop.sh && MANTA_PROD_HOST=${PROD_HOST} bash scripts/release/publish.sh"
else
  ALL_ARTIFACTS=( "${DMGS[@]}" "${APPIMAGES[@]}" )
  LATEST_DMG=""
  LATEST_APPIMAGE=""
  [ "${#DMGS[@]}" -gt 0 ]       && LATEST_DMG="$(pick_latest "${DMGS[@]}")"
  [ "${#APPIMAGES[@]}" -gt 0 ]  && LATEST_APPIMAGE="$(pick_latest "${APPIMAGES[@]}")"

  log "Uploading desktop artifacts → ${PROD_HOST}:${UPDATES_DIR}/…"
  scp "${ALL_ARTIFACTS[@]}" "${FEEDS[@]}" "${PROD_HOST}:${UPDATES_DIR}/"

  log "Uploading desktop artifacts → ${PROD_HOST}:${DOWNLOADS_DIR}/…"
  scp "${ALL_ARTIFACTS[@]}" "${PROD_HOST}:${DOWNLOADS_DIR}/"

  log "Refreshing Manta-latest.* stable copies…"
  if [ -n "${LATEST_DMG}" ]; then
    ssh "${PROD_HOST}" "cd ${DOWNLOADS_DIR} && cp -f ${LATEST_DMG} Manta-latest.dmg"
  fi
  if [ -n "${LATEST_APPIMAGE}" ]; then
    ssh "${PROD_HOST}" "cd ${DOWNLOADS_DIR} && cp -f ${LATEST_APPIMAGE} Manta-latest.AppImage"
  fi

  ok "desktop published"
fi

# --- 4. relay + install.sh sync ---------------------------------------------
log "Deploying relay on ${PROD_HOST}…"
ssh "${PROD_HOST}" 'git -C /opt/manta pull && systemctl restart manta-relay && systemctl is-active manta-relay'
ok "relay deployed"

# Caddy serves install.sh statically from the web root, NOT from the repo
# checkout. The git pull above updates /opt/manta/scripts/install.sh but leaves
# the served copy stale — sync it explicitly (BET-171). Caddy re-reads static
# files per request, so no reload is needed.
log "Syncing install.sh into web root (${WEBROOT_DIR}/install.sh)…"
ssh "${PROD_HOST}" "cp -f /opt/manta/scripts/install.sh ${WEBROOT_DIR}/install.sh"
ok "install.sh synced to web root"

# --- 5. verify --------------------------------------------------------------
log "Verifying published URLs (${SITE})…"
check_200() {
  local url="$1" status
  status="$(curl -s -o /dev/null -w '%{http_code}' "${url}")"
  if [ "${status}" != "200" ]; then
    die "verify failed: ${url} → ${status} (expected 200)"
  fi
  ok "${url} → 200"
}

check_200 "${SITE}/releases/manta-${VERSION}.tar.gz"
check_200 "${SITE}/install.sh"

# A 200 on install.sh is not enough — a stale file also 200s (BET-171). Verify
# the served body byte-matches the repo's scripts/install.sh so we know the
# deploy actually took.
log "Verifying served install.sh matches repo…"
LOCAL_INSTALL_SHA="$(sha256sum scripts/install.sh | awk '{print $1}')"
SERVED_INSTALL_SHA="$(curl -fsSL "${SITE}/install.sh" | sha256sum | awk '{print $1}')"
if [ "${LOCAL_INSTALL_SHA}" != "${SERVED_INSTALL_SHA}" ]; then
  die "install.sh mismatch: served=${SERVED_INSTALL_SHA} repo=${LOCAL_INSTALL_SHA} — web-root sync did not take"
fi
ok "served install.sh matches repo (${LOCAL_INSTALL_SHA})"

if [ "${#DMGS[@]}" -gt 0 ]; then
  check_200 "${SITE}/downloads/Manta-latest.dmg"
fi
if [ "${#APPIMAGES[@]}" -gt 0 ]; then
  check_200 "${SITE}/downloads/Manta-latest.AppImage"
fi

ok "verify ok"

# --- 6. tag -----------------------------------------------------------------
log "Tagging v${VERSION}…"
git tag "v${VERSION}"
git push origin "v${VERSION}"
ok "tagged v${VERSION} and pushed"

log "Done."
