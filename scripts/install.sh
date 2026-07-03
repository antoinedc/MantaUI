#!/usr/bin/env bash
# install.sh — one-command VPS self-install for the bui box server.
#
#   curl -fsSL https://bui.useronda.com/install.sh | bash
#
# Gets bui-server running under systemd --user on a fresh Linux box and prints a
# 6-digit pairing code to enter in the desktop app. Idempotent: re-running
# upgrades the code in place and PRESERVES ~/.bui-mobile/ (box identity + config)
# — the script never generates box_id/box_token itself; ensureAuth() in
# src/server/auth.mjs is the single source of truth.
#
# Overrides (env):
#   BUI_TARBALL_URL   full URL of the release tarball (skips host+version build)
#   BUI_RELEASE_HOST  host for the default tarball URL (default bui.useronda.com)
#   BUI_HOME          where code is unpacked (default ~/bui)
#   BUI_MOBILE_PORT   server port (default 8787)
#   BUI_VERSION       version to fetch when BUI_TARBALL_URL is unset (default: latest)
#
# The pure logic (URL/home resolution, health-wait, pairing format, idempotency)
# lives in scripts/install-lib.mjs and is unit-tested (scripts/install.test.mjs).
# This shell stays a thin orchestrator.

set -euo pipefail

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Prerequisites — verify; report-and-instruct if missing (never silent sudo).
# ---------------------------------------------------------------------------
require_cmd() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "missing prerequisite: $cmd
      Install it and re-run. Suggested:
        $hint"
  fi
}

log "Checking prerequisites (node, npm, git, tmux, curl, tar)…"
require_cmd curl "apt-get install -y curl   # or your distro's package manager"
require_cmd tar  "apt-get install -y tar"
require_cmd node "install Node.js LTS: https://nodejs.org  (nvm: 'nvm install --lts')"
require_cmd npm  "ships with Node.js — reinstall Node if npm is missing"
require_cmd git  "apt-get install -y git"
require_cmd tmux "apt-get install -y tmux"

# Node 20+ required (matches the desktop app / server runtime).
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  die "Node.js 20+ required (found $(node -v)). Upgrade Node and re-run."
fi
ok "Prerequisites present ($(node -v), npm $(npm -v))."

# ---------------------------------------------------------------------------
# 2. Resolve config. Bootstrap install-lib.mjs so we can reuse its pure helpers
#    even before the tarball is unpacked — download just that one file first.
# ---------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bui-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Determine version (for the default tarball URL). If BUI_TARBALL_URL is set the
# version is irrelevant (lib ignores it), so pass a harmless placeholder.
BUI_VERSION="${BUI_VERSION:-latest}"

# Fetch the release tarball. We need install-lib.mjs to resolve the URL, but
# install-lib.mjs lives INSIDE the tarball — chicken/egg. Resolve the URL with a
# tiny inline node expression that mirrors resolveTarballUrl's default shape;
# once unpacked, all further logic uses the real (tested) lib.
if [ -n "${BUI_TARBALL_URL:-}" ]; then
  TARBALL_URL="$BUI_TARBALL_URL"
else
  host="${BUI_RELEASE_HOST:-https://bui.useronda.com}"
  host="${host%/}"
  TARBALL_URL="${host}/releases/bui-${BUI_VERSION}.tar.gz"
fi
log "Release tarball: $TARBALL_URL"

# ---------------------------------------------------------------------------
# 3. Download + extract the pre-built tarball (ships mobile/www/ prebuilt, so no
#    renderer toolchain needed on the VPS).
# ---------------------------------------------------------------------------
BUI_HOME="${BUI_HOME:-$HOME/bui}"
AUTH_DIR="$HOME/.bui-mobile"

log "Downloading release…"
curl -fsSL "$TARBALL_URL" -o "$WORK/bui.tar.gz" \
  || die "download failed: $TARBALL_URL
      (set BUI_TARBALL_URL to a reachable tarball, e.g. a local file:// or mirror)"

log "Extracting to $BUI_HOME…"
mkdir -p "$BUI_HOME"
# Preserve ~/.bui-mobile no matter what — it lives outside BUI_HOME, but be
# explicit that we never touch it. Extract stripping the top-level dir.
tar -xzf "$WORK/bui.tar.gz" -C "$BUI_HOME" --strip-components=1 \
  || die "extract failed"
ok "Unpacked bui into $BUI_HOME."

cd "$BUI_HOME"

# Now use the REAL tested lib for everything downstream.
LIB="$BUI_HOME/scripts/install-lib.mjs"
[ -f "$LIB" ] || die "tarball is missing scripts/install-lib.mjs — bad release?"

# Resolve the canonical config (exports BUI_HOME, BUI_AUTH_FILE, BUI_PORT,
# BUI_HEALTH_URL, …). Version comes from package.json when unset.
pkg_version="$(node -p 'require("./package.json").version' 2>/dev/null || echo "$BUI_VERSION")"
eval "$(BUI_HOME="$BUI_HOME" node "$LIB" print-config --version "$pkg_version")"

# ---------------------------------------------------------------------------
# 4. Idempotency: report whether we're preserving an existing box identity.
# ---------------------------------------------------------------------------
identity="$(node "$LIB" check-identity 2>/dev/null || echo fresh)"
if [ "$identity" = "preserve" ]; then
  ok "Existing box identity found at $BUI_AUTH_FILE — preserving it (never regenerated)."
else
  log "No existing identity — the server will mint one on first start."
fi

# ---------------------------------------------------------------------------
# 5. Production install (tarball ships mobile/www/ prebuilt → no build step).
# ---------------------------------------------------------------------------
log "Installing production dependencies (npm ci --omit=dev)…"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "Dependencies installed."

# ---------------------------------------------------------------------------
# 6. systemd --user unit: substitute placeholders and enable.
# ---------------------------------------------------------------------------
NODE_BIN="$(command -v node)"
UNIT_SRC="$BUI_HOME/scripts/systemd/bui-server.service"
UNIT_DIR="$HOME/.config/systemd/user"
[ -f "$UNIT_SRC" ] || die "missing systemd template: $UNIT_SRC"

if command -v systemctl >/dev/null 2>&1; then
  log "Installing systemd --user unit…"
  mkdir -p "$UNIT_DIR"
  sed \
    -e "s|@@BUI_HOME@@|$BUI_HOME|g" \
    -e "s|@@NODE_BIN@@|$NODE_BIN|g" \
    -e "s|@@BUI_PORT@@|$BUI_PORT|g" \
    "$UNIT_SRC" > "$UNIT_DIR/bui-server.service"

  # Survive logout/reboot without an active session.
  loginctl enable-linger "$USER" >/dev/null 2>&1 \
    || warn "could not enable-linger for $USER — the server may stop on logout. Run: sudo loginctl enable-linger $USER"

  systemctl --user daemon-reload
  systemctl --user enable --now bui-server.service
  ok "bui-server enabled and started (systemctl --user status bui-server)."
  SERVER_MANAGED=systemd
else
  warn "systemctl not found (not a systemd host?). Starting the server in the background instead."
  warn "It will NOT survive reboot — set up your own supervisor for that."
  ( BUI_MOBILE_HOST=127.0.0.1 BUI_MOBILE_PORT="$BUI_PORT" nohup node "$BUI_HOME/src/server/index.mjs" >"$AUTH_DIR/server.log" 2>&1 & )
  SERVER_MANAGED=nohup
fi

# ---------------------------------------------------------------------------
# 7. Wait for health, then mint + print a pairing code.
# ---------------------------------------------------------------------------
log "Waiting for the server to become healthy at $BUI_HEALTH_URL…"
node -e '
  import("'"$LIB"'").then(async (m) => {
    const r = await m.waitForHealth(process.env.BUI_HEALTH_URL, { maxAttempts: 60, intervalMs: 1000 });
    if (!r.ok) { console.error(r.error); process.exit(1); }
    console.error("healthy after " + r.attempts + " attempt(s)");
  }).catch((e) => { console.error(String(e)); process.exit(1); });
' || die "server did not become healthy — check logs:
      systemctl --user status bui-server ; journalctl --user -u bui-server -n 50"

ok "Server is healthy."

log "Minting pairing code…"
# Delegate to the same `bui pair` CLI the user runs later (loopback GET /auth/pair).
node "$BUI_HOME/scripts/bui-pair.mjs" || die "failed to mint pairing code (is the server local-reachable?)"

cat <<EOF

Installed. Manage the server with:
  systemctl --user status bui-server
  systemctl --user restart bui-server
  journalctl --user -u bui-server -f

Re-run this installer any time to upgrade in place (your box identity is preserved).
Run 'bui pair' (or 'npm run pair' in $BUI_HOME) to mint a fresh pairing code.
EOF
