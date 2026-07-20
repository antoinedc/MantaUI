#!/usr/bin/env bash
# publish.sh — publish a built manta release to the prod box in one command.
#
#   bash scripts/release/publish.sh
#
# What it does (in order; each step idempotent and runs unconditionally unless
# its artifact is missing — desktop is a separately-shippable leg, not a failure):
#   1. preflight   refuse if git tree is dirty, if v<version> tag already
#                  exists, or if dist/manta-<version>-linux-x64.tar.gz OR
#                  dist/manta-<version>.txt (the manifest) is absent.
#                  (Run `npm run pack` first.)
#   2. tarball     scp dist/manta-<version>-linux-x64.tar.gz + the manifest
#                  to <host>:/var/www/mantaui/releases/. THEN (strictly last)
#                  ssh to copy manta-<version>.txt → manta-latest.txt — this
#                  ordering is the atomicity guarantee: a client either sees
#                  the OLD manifest (and old tarball) or the NEW manifest
#                  (with new tarball already uploaded). Drift between the two
#                  is impossible.
#   3. desktop     if dist/desktop/ has binaries: scp them + the latest-*.yml
#                  feeds to <host>:/var/www/mantaui/updates/ and the binaries
#                  to /var/www/mantaui/downloads/, then refresh
#                  Manta-latest.{dmg,AppImage}. If dist/desktop/ is empty
#                  (e.g. mac build runs on a Mac): print the exact one-line
#                  command the owner runs there and continue — desktop is a
#                  separate leg, not a release blocker.
#   4. server      ssh <host> 'git -C /opt/manta pull && systemctl restart
#                  manta-server && systemctl is-active manta-server', then
#                  sync the freshly-pulled scripts/install.sh into the Caddy
#                  web root (/var/www/mantaui/install.sh) — the pull updates
#                  the repo checkout, but Caddy serves install.sh statically
#                  from the web root, so without this copy the advertised
#                  one-liner keeps serving the stale installer (BET-171).
#   5. verify      HEAD each published URL — tarball 200, manifest live with
#                  matching version + tarball sha, install.sh 200, install.sh
#                  body byte-matches the repo. Fail loudly on any non-200,
#                  manifest drift, or install.sh drift. This makes the
#                  script/tarball/manifest drift (the F4 class from BET-171)
#                  fail the publish loudly.
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
TARBALL="dist/manta-${VERSION}-linux-x64.tar.gz"
MANIFEST="dist/manta-${VERSION}.txt"
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

if [ ! -f "${MANIFEST}" ]; then
  die "${MANIFEST} missing — run \`npm run pack\` first (the tarball's manifest sidecar)"
fi

ok "preflight ok"

# --- 2. tarball + manifest (atomicity: tarball first, manifest pointer last) -
log "Uploading ${TARBALL} → ${PROD_HOST}:${RELEASES_DIR}/…"
scp "${TARBALL}" "${PROD_HOST}:${RELEASES_DIR}/"
log "Uploading ${MANIFEST} → ${PROD_HOST}:${RELEASES_DIR}/…"
scp "${MANIFEST}" "${PROD_HOST}:${RELEASES_DIR}/"

# The latest-pointer copy goes LAST. Clients either see the old manifest (the
# old tarball is still served too) OR the new manifest (and the new tarball is
# already up). Drift between manifest and tarball is impossible.
log "Publishing manifest pointer ${PROD_HOST}:${RELEASES_DIR}/manta-latest.txt…"
ssh "${PROD_HOST}" "cd ${RELEASES_DIR} && cp -f manta-${VERSION}.txt manta-latest.txt"
ok "tarball + manifest published"

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

# --- 4. server + install.sh sync ---------------------------------------------
log "Deploying manta-server on ${PROD_HOST}…"
ssh "${PROD_HOST}" 'git -C /opt/manta pull && systemctl restart manta-server && systemctl is-active manta-server'
ok "manta-server deployed"

# Caddy serves both install.sh and llms-install.md statically from the web
# root, NOT from the repo checkout. The git pull above updates /opt/manta
# but leaves the served copies stale — sync them explicitly (BET-171 for
# install.sh; BET-174 for llms-install.md). Caddy re-reads static files
# per request, so no reload is needed.
# Pair format: "<src-under-repo>:<dest-on-prod>". Keep the two files in sync
# so a single cp + verify loop covers both legs (BET-174).
WEBROOT_DOCS=(
  "scripts/install.sh:${WEBROOT_DIR}/install.sh"
  "llms-install.md:${WEBROOT_DIR}/llms-install.md"
)
log "Syncing static docs into web root…"
for pair in "${WEBROOT_DOCS[@]}"; do
  src="${pair%%:*}"
  dest="${pair#*:}"
  ssh "${PROD_HOST}" "cp -f /opt/manta/${src} ${dest}"
  ok "${dest##*/} synced to web root"
done

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

check_200 "${SITE}/releases/manta-${VERSION}-linux-x64.tar.gz"
for pair in "${WEBROOT_DOCS[@]}"; do
  check_200 "${SITE}/${pair##*:}"
done

# Manifest + tarball drift check (BET-171 F4 class). The publish script just
# pushed both files; we re-fetch the manifest over HTTPS and assert that the
# served tarball's sha256 matches the manifest's sha256_linux_x64 line. A
# failure here means we shipped a tarball + manifest that disagree — clients
# would download the tarball, sha256-fail it, and die. Catch that HERE.
log "Verifying manifest ↔ tarball drift…"
SERVED_MANIFEST="$(curl -fsSL "${SITE}/releases/manta-latest.txt")"
SERVED_VERSION="$(printf '%s\n' "$SERVED_MANIFEST" | grep '^version=' | head -n1 | cut -d= -f2-)"
if [ "$SERVED_VERSION" != "$VERSION" ]; then
  die "manifest not live: served version='${SERVED_VERSION}' expected='${VERSION}'"
fi
SERVED_FILE="$(printf '%s\n' "$SERVED_MANIFEST" | grep '^file_linux_x64=' | head -n1 | cut -d= -f2-)"
SERVED_SHA="$(printf '%s\n' "$SERVED_MANIFEST" | grep '^sha256_linux_x64=' | head -n1 | cut -d= -f2-)"
if [ -z "$SERVED_FILE" ] || [ -z "$SERVED_SHA" ]; then
  die "served manifest is malformed (missing file_linux_x64 or sha256_linux_x64)"
fi
ACTUAL_SHA="$(curl -fsSL "${SITE}/releases/${SERVED_FILE}" | sha256sum | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$SERVED_SHA" ]; then
  die "tarball/manifest drift: served sha=${SERVED_SHA} actual=${ACTUAL_SHA} for ${SERVED_FILE}"
fi
ok "served manifest live (version=${VERSION}, sha=${ACTUAL_SHA})"

# A 200 is not enough — a stale file also 200s (BET-171). Verify each
# web-root doc byte-matches the repo so we know the deploy actually took.
# Same loop as the sync step above: one block, multiple files (BET-174).
log "Verifying served docs match repo…"
for pair in "${WEBROOT_DOCS[@]}"; do
  src="${pair%%:*}"
  dest="${pair#*:}"
  LOCAL_SHA="$(sha256sum "${src}" | awk '{print $1}')"
  SERVED_SHA="$(curl -fsSL "${SITE}/${dest##*/}" | sha256sum | awk '{print $1}')"
  if [ "${LOCAL_SHA}" != "${SERVED_SHA}" ]; then
    die "${dest##*/} mismatch: served=${SERVED_SHA} repo=${LOCAL_SHA} — web-root sync did not take"
  fi
  ok "served ${dest##*/} matches repo (${LOCAL_SHA})"
done

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
