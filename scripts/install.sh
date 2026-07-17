#!/usr/bin/env bash
# install.sh — one-command VPS self-install for the manta box server.
#
#   curl -fsSL https://mantaui.com/install.sh | bash
#
# Gets manta-server running under systemd --user on a fresh Linux box and prints a
# 6-digit pairing code to enter in the desktop app. Idempotent: re-running
# upgrades the code in place and PRESERVES ~/.manta/ (box identity + config)
# — the script never generates box_id/box_token itself; ensureAuth() in
# src/server/auth.mjs is the single source of truth.
#
# Overrides (env):
#   MANTA_TARBALL_URL   full URL of the release tarball (skips host+version build)
#   MANTA_RELEASE_HOST  host for the default tarball URL (default mantaui.com)
#   MANTA_HOME          where code is unpacked (default ~/manta)
#   MANTA_MOBILE_PORT   server port (default 8787)
#   MANTA_VERSION       version to fetch when MANTA_TARBALL_URL is unset (default: latest)
#
# The pure logic (URL/home resolution, health-wait, pairing format, idempotency)
# lives in scripts/install-lib.mjs and is unit-tested (scripts/install.test.mjs).
# This shell stays a thin orchestrator.

# === Always-defined helpers (test-safe: defined even in test mode) ===========
# These are defined BEFORE the test-mode guard and the install body so the unit
# tests in scripts/install.test.mjs can source this script and call bootstrap_node
# / install_node_via_* / require_cmd without the install body running.
log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisite bootstrap (BET-162 F1 fix) — installs Node.js when missing.
# Mirrors the "report-and-instruct, never silent sudo" tone of require_cmd,
# but actually performs the install when missing. Idempotent: re-running with
# node already on PATH is a no-op (no apt/dnf/yum call, no curl).
# ---------------------------------------------------------------------------

# Detect distro ID from /etc/os-release. Echoes the ID (without quotes), or
# empty string if unreadable. Pure: uses a subshell so /etc/os-release's vars
# do NOT leak into the caller's environment.
detect_distro_id() {
  ( . /etc/os-release 2>/dev/null && printf '%s' "${ID:-}" ) || true
}

# Returns "root" / "sudo" via stdout; returns 1 if neither is available.
# Tests stub install_node_via_* directly so they don't exercise this, but it's
# kept simple + side-effect-free for symmetry.
package_install_mode() {
  if [ "$(id -u)" -eq 0 ]; then
    printf 'root'
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    printf 'sudo'
    return 0
  fi
  return 1
}

# Install nodejs via apt + NodeSource 20.x repo (Debian/Ubuntu). Exposed so
# scripts/install.test.mjs can stub it with a mock and verify the call site
# without hitting the network.
install_node_via_apt() {
  local mode
  mode="$(package_install_mode)" || {
    die "node is missing and neither root nor sudo is available.
        Install Node.js 20+ manually: https://nodejs.org  (nvm: 'nvm install --lts')
        then re-run the installer."
  }
  local ns_script="/tmp/manta-nodesource-setup_20.x.sh"
  log "Downloading NodeSource 20.x setup script…"
  curl -fsSL https://deb.nodesource.com/setup_20.x -o "$ns_script" \
    || { warn "failed to download NodeSource setup script"; return 1; }
  log "Adding NodeSource 20.x apt repository (mode=$mode)…"
  if [ "$mode" = "root" ]; then
    bash "$ns_script" && apt-get install -y nodejs
  else
    warn "this installer needs to install Node.js, which requires sudo."
    warn "you'll be prompted for your sudo password."
    sudo bash "$ns_script" && sudo apt-get install -y nodejs
  fi
  local rc=$?
  rm -f "$ns_script"
  return $rc
}

# Install nodejs via dnf + NodeSource 20.x (Fedora / Amazon Linux / RHEL 8+).
install_node_via_dnf() {
  local mode
  mode="$(package_install_mode)" || {
    die "node is missing and neither root nor sudo is available.
        Install Node.js 20+ manually: https://nodejs.org  (nvm: 'nvm install --lts')
        then re-run the installer."
  }
  local ns_script="/tmp/manta-nodesource-setup_20.x.sh"
  log "Downloading NodeSource 20.x setup script…"
  curl -fsSL https://rpm.nodesource.com/setup_20.x -o "$ns_script" \
    || { warn "failed to download NodeSource setup script"; return 1; }
  log "Adding NodeSource 20.x dnf repository (mode=$mode)…"
  if [ "$mode" = "root" ]; then
    bash "$ns_script" && dnf install -y nodejs
  else
    warn "this installer needs to install Node.js, which requires sudo."
    warn "you'll be prompted for your sudo password."
    sudo bash "$ns_script" && sudo dnf install -y nodejs
  fi
  local rc=$?
  rm -f "$ns_script"
  return $rc
}

# Install nodejs via yum + NodeSource 20.x (older RHEL/CentOS where dnf is absent).
install_node_via_yum() {
  local mode
  mode="$(package_install_mode)" || {
    die "node is missing and neither root nor sudo is available.
        Install Node.js 20+ manually: https://nodejs.org  (nvm: 'nvm install --lts')
        then re-run the installer."
  }
  local ns_script="/tmp/manta-nodesource-setup_20.x.sh"
  log "Downloading NodeSource 20.x setup script…"
  curl -fsSL https://rpm.nodesource.com/setup_20.x -o "$ns_script" \
    || { warn "failed to download NodeSource setup script"; return 1; }
  log "Adding NodeSource 20.x yum repository (mode=$mode)…"
  if [ "$mode" = "root" ]; then
    bash "$ns_script" && yum install -y nodejs
  else
    warn "this installer needs to install Node.js, which requires sudo."
    warn "you'll be prompted for your sudo password."
    sudo bash "$ns_script" && sudo yum install -y nodejs
  fi
  local rc=$?
  rm -f "$ns_script"
  return $rc
}

# Top-level: ensure node is on PATH. Idempotent — early-returns when already
# present (no curl / apt / dnf / yum call). Distro-specific installer is
# selected by detect_distro_id; unknown distros die with a manual-install
# hint (same tone as require_cmd failures).
bootstrap_node() {
  if command -v node >/dev/null 2>&1; then
    return 0  # no-op when node is already on PATH (the common idempotent path)
  fi

  # The bootstrap path itself needs curl + tar to download the NodeSource
  # setup script. If those are also missing, we can't auto-fix — bail with a
  # clear manual-install hint (same tone as the require_cmd failures).
  local missing=""
  for cmd in curl tar; do
    command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
  done
  if [ -n "$missing" ]; then
    die "node is missing and so are:$missing.
        Install Node.js 20+ and the missing tools manually, then re-run:
          apt-get install -y curl tar nodejs   # Debian/Ubuntu
          dnf install -y curl tar nodejs       # Fedora
          yum install -y curl tar nodejs       # RHEL/CentOS
        or use the installer from https://nodejs.org."
  fi

  log "node is missing — bootstrapping Node.js 20.x via NodeSource."
  local distro
  distro="$(detect_distro_id)"

  case "$distro" in
    ubuntu|debian)
      install_node_via_apt \
        || die "Node.js install via apt failed.
            Install manually: https://nodejs.org  (nvm: 'nvm install --lts')
            then re-run the installer."
      ;;
    fedora|amzn)
      install_node_via_dnf \
        || die "Node.js install via dnf failed.
            Install manually: https://nodejs.org  (nvm: 'nvm install --lts')
            then re-run the installer."
      ;;
    rhel|centos|rocky|almalinux|ol)
      install_node_via_dnf \
        || install_node_via_yum \
        || die "Node.js install via dnf/yum failed.
            Install manually: https://nodejs.org  (nvm: 'nvm install --lts')
            then re-run the installer."
      ;;
    "")
      die "node is missing and /etc/os-release is unreadable.
          Install Node.js 20+ manually: https://nodejs.org  (nvm: 'nvm install --lts')
          then re-run the installer."
      ;;
    *)
      die "node is missing and your distro ('$distro') is not auto-bootstrapped.
          Install Node.js 20+ manually: https://nodejs.org  (nvm: 'nvm install --lts')
          then re-run the installer."
      ;;
  esac

  if ! command -v node >/dev/null 2>&1; then
    die "node is still missing after bootstrap. Install manually: https://nodejs.org"
  fi
  ok "node $(node --version 2>/dev/null || echo unknown) installed via NodeSource."
}

# Test mode: when sourced by scripts/install.test.mjs with MANTA_INSTALL_TEST_MODE=1,
# only the bash helpers (log/ok/warn/die + bootstrap_node + its distro-specific
# installers + require_cmd) are loaded. The actual install does NOT run. Lets the
# unit tests exercise bootstrap_node / install_node_via_* without hitting the
# network. See scripts/install.test.mjs "bootstrap_node" cases.
if [ "${MANTA_INSTALL_TEST_MODE:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Prerequisites — bootstrap node, then verify the rest; report-and-instruct
#    if missing (never silent sudo).
# ---------------------------------------------------------------------------
require_cmd() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "missing prerequisite: $cmd
      Install it and re-run. Suggested:
        $hint"
  fi
}

# Bootstrap node FIRST (idempotent no-op when already present). Doing this
# before the prereq verify means a fresh cloud image with curl+tar but no
# node still completes the install end-to-end.
bootstrap_node

log "Checking prerequisites (curl, tar, git, tmux, node, npm)…"
require_cmd curl "apt-get install -y curl   # or your distro's package manager"
require_cmd tar  "apt-get install -y tar"
require_cmd git  "apt-get install -y git"
require_cmd tmux "apt-get install -y tmux"
# Defense-in-depth: bootstrap_node guarantees node on PATH, but require it
# again so a failure in the bootstrap path still produces a clean error
# instead of a confusing crash later in the script.
require_cmd node "install Node.js LTS: https://nodejs.org  (nvm: 'nvm install --lts')"
require_cmd npm  "ships with Node.js — reinstall Node if npm is missing"

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
WORK="$(mktemp -d "${TMPDIR:-/tmp}/manta-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Determine version (for the default tarball URL). If MANTA_TARBALL_URL is set the
# version is irrelevant (lib ignores it), so pass a harmless placeholder.
MANTA_VERSION="${MANTA_VERSION:-latest}"

# Fetch the release tarball. We need install-lib.mjs to resolve the URL, but
# install-lib.mjs lives INSIDE the tarball — chicken/egg. Resolve the URL with a
# tiny inline node expression that mirrors resolveTarballUrl's default shape;
# once unpacked, all further logic uses the real (tested) lib.
if [ -n "${MANTA_TARBALL_URL:-}" ]; then
  TARBALL_URL="$MANTA_TARBALL_URL"
else
  host="${MANTA_RELEASE_HOST:-https://mantaui.com}"
  host="${host%/}"
  TARBALL_URL="${host}/releases/manta-${MANTA_VERSION}.tar.gz"
fi
log "Release tarball: $TARBALL_URL"

# ---------------------------------------------------------------------------
# 3. Download + extract the pre-built tarball (ships mobile/www/ prebuilt, so no
#    renderer toolchain needed on the VPS).
# ---------------------------------------------------------------------------
MANTA_HOME="${MANTA_HOME:-$HOME/manta}"
AUTH_DIR="$HOME/.manta"

log "Downloading release…"
curl -fsSL "$TARBALL_URL" -o "$WORK/manta.tar.gz" \
  || die "download failed: $TARBALL_URL
      (set MANTA_TARBALL_URL to a reachable tarball, e.g. a local file:// or mirror)"

log "Extracting to $MANTA_HOME…"
mkdir -p "$MANTA_HOME"
# Preserve ~/.manta no matter what — it lives outside MANTA_HOME, but be
# explicit that we never touch it. Extract stripping the top-level dir.
tar -xzf "$WORK/manta.tar.gz" -C "$MANTA_HOME" --strip-components=1 \
  || die "extract failed"
ok "Unpacked manta into $MANTA_HOME."

cd "$MANTA_HOME"

# Now use the REAL tested lib for everything downstream.
LIB="$MANTA_HOME/scripts/install-lib.mjs"
[ -f "$LIB" ] || die "tarball is missing scripts/install-lib.mjs — bad release?"

# Resolve the canonical config (exports MANTA_HOME, MANTA_AUTH_FILE, MANTA_PORT,
# MANTA_HEALTH_URL, …). Version comes from package.json when unset.
pkg_version="$(node -p 'require("./package.json").version' 2>/dev/null || echo "$MANTA_VERSION")"
eval "$(MANTA_HOME="$MANTA_HOME" node "$LIB" print-config --version "$pkg_version")"

# ---------------------------------------------------------------------------
# 4. Idempotency: report whether we're preserving an existing box identity.
# ---------------------------------------------------------------------------
identity="$(node "$LIB" check-identity 2>/dev/null || echo fresh)"
if [ "$identity" = "preserve" ]; then
  ok "Existing box identity found at $MANTA_AUTH_FILE — preserving it (never regenerated)."
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
# 6. Chat stack provisioning (opencode + bui-native tools + tmux presence).
#    Independent of the relay work — a fresh VPS just needs claude code
#    installed (~/.claude/.credentials.json exists). Re-running is a no-op
#    except for version upgrades; every step is safe to run twice.
# ---------------------------------------------------------------------------

# --- A. tmux presence gate (hard requirement of the product). -------------
# §1 already verified tmux exists; we re-state it here as a section-level
# gate so a missing-tmux failure surfaces in the chat stack section, not
# buried at the top. We deliberately do NOT auto-install distro packages —
# the installer never assumes root.
if ! command -v tmux >/dev/null 2>&1; then
  die "missing prerequisite for chat stack: tmux
      Install it and re-run. Suggested:
        apt-get install -y tmux        # Debian/Ubuntu
        yum install -y tmux            # RHEL/Fedora/Amazon Linux"
fi
ok "tmux present."

# --- B. opencode install (idempotent via official installer). ------------
# We use opencode's official installer; no version pinning in v1 — the
# installer is the source of truth for "current". Re-running is a no-op
# when the binary is already on PATH.
OPENCODE_BIN="$(command -v opencode || true)"
if [ -n "$OPENCODE_BIN" ]; then
  ok "opencode already installed ($("$OPENCODE_BIN" --version 2>/dev/null | head -n1 || echo "$OPENCODE_BIN"))."
else
  log "Installing opencode (official installer)…"
  # The installer writes to ~/.local/bin/opencode by default; that dir is on
  # PATH for most distros but not all. We source the installer's PATH hint
  # if it added anything, then re-check.
  curl -fsSL https://opencode.ai/install | bash \
    || die "opencode install failed — install manually: https://opencode.ai"
  OPENCODE_BIN="$(command -v opencode || true)"
  if [ -z "$OPENCODE_BIN" ]; then
    die "opencode still not on PATH after install. Try: export PATH=\"\$HOME/.local/bin:\$PATH\" and re-run."
  fi
  ok "opencode installed ($("$OPENCODE_BIN" --version 2>/dev/null | head -n1 || echo "$OPENCODE_BIN"))."
fi

# --- C. opencode config seeding — MERGE the plugin entry, never clobber. --
# Target: ~/.config/opencode/opencode.jsonc. Required:
#   plugin: ["opencode-claude-auth@latest", ...]
# All other keys (theme, model, mcp, provider, …) are preserved. On parse
# failure we back the file up to .pre-manta and start from {} — matches the
# documented skills.urls merge pattern in src/server/local.mjs.
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCODE_CONFIG="$OPENCODE_CONFIG_DIR/opencode.jsonc"
mkdir -p "$OPENCODE_CONFIG_DIR"
OPENCODE_CONFIG_BACKUP="$OPENCODE_CONFIG.pre-manta"
if [ -f "$OPENCODE_CONFIG" ]; then
  log "Seeding opencode-claude-auth plugin (merging into existing $OPENCODE_CONFIG)…"
  existing="$(cat "$OPENCODE_CONFIG" 2>/dev/null || true)"
else
  log "Seeding opencode-claude-auth plugin (no existing $OPENCODE_CONFIG — creating)…"
  existing=""
fi
merged="$(printf '%s' "$existing" | node "$LIB" merge-opencode-config 2>/tmp/opencode-merge.err)" \
  || die "merge-opencode-config failed (see /tmp/opencode-merge.err)"
if grep -q '^corrupt=1' /tmp/opencode-merge.err 2>/dev/null; then
  cp "$OPENCODE_CONFIG" "$OPENCODE_CONFIG_BACKUP" 2>/dev/null \
    && warn "opencode.jsonc was unparseable — original backed up to $OPENCODE_CONFIG_BACKUP, starting from {}." \
    || warn "opencode.jsonc was unparseable and the backup FAILED — installer continues but original is NOT preserved."
fi
printf '%s' "$merged" > "$OPENCODE_CONFIG"
ok "opencode.jsonc seeded."

# --- D. manta opencode tools + agent guidance (REAL copies, not symlinks).
# Per AGENTS.md ("Mobile / web client"): opencode resolves tool imports from
# the file's REAL path; a symlink into the tarball tree misses
# ~/.config/opencode/node_modules/@opencode-ai/plugin and the tool silently
# never registers. So we cp — same inode-disjoint paths.
OPENCODE_TOOLS_SRC="$MANTA_HOME/docs/opencode-tools"
OPENCODE_TOOLS_DIR="$OPENCODE_CONFIG_DIR/tools"
OPENCODE_AGENTS="$OPENCODE_CONFIG_DIR/AGENTS.md"
if [ -d "$OPENCODE_TOOLS_SRC" ]; then
  mkdir -p "$OPENCODE_TOOLS_DIR"
  log "Copying bui-native opencode tools into $OPENCODE_TOOLS_DIR…"
  # cp -f overwrites — tools are versioned with the tarball, so a re-run
  # naturally picks up upgrades.
  cp -f "$OPENCODE_TOOLS_SRC"/*.ts "$OPENCODE_TOOLS_DIR/" \
    || die "failed to copy opencode tools from $OPENCODE_TOOLS_SRC"
  ok "opencode tools copied."
else
  warn "$OPENCODE_TOOLS_SRC not found in tarball — skipping tool copy (was docs/opencode-tools/* added to release/pack.mjs?)."
fi
# AGENTS.md append with marker guard — idempotency by a single grep on a
# stable line ("## bui scheduled tasks"). A re-run with the marker present
# is a clean no-op.
if [ -f "$OPENCODE_TOOLS_SRC/AGENTS.md" ]; then
  if [ -f "$OPENCODE_AGENTS" ] && grep -q '^## bui scheduled tasks' "$OPENCODE_AGENTS"; then
    ok "opencode AGENTS.md already contains bui guidance — skipping append."
  else
    log "Appending bui opencode agent guidance to $OPENCODE_AGENTS…"
    {
      [ -f "$OPENCODE_AGENTS" ] && cat "$OPENCODE_AGENTS" && printf '\n'
      cat "$OPENCODE_TOOLS_SRC/AGENTS.md"
    } > "$OPENCODE_AGENTS.tmp" && mv "$OPENCODE_AGENTS.tmp" "$OPENCODE_AGENTS"
    ok "opencode AGENTS.md updated."
  fi
fi

# --- E. opencode-serve systemd --user unit (or nohup fallback). ----------
# Mirrors the manta-server install path right below: substitute the
# @@OPENCODE_BIN@@ placeholder, install to ~/.config/systemd/user/, then
# enable --now. Health-wait reuses the existing waitForHealth lib with
# acceptAnyStatus:true (any HTTP status = listener is up — opencode's HTTP
# surface is minimal and may not respond to a bare GET /). Same fallback
# chain as manta-server when systemctl is unavailable.
OC_UNIT_SRC="$MANTA_HOME/scripts/systemd/opencode-serve.service"
OC_UNIT="$UNIT_DIR/opencode-serve.service"
[ -f "$OC_UNIT_SRC" ] || die "missing systemd template: $OC_UNIT_SRC"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet opencode-serve.service 2>/dev/null; then
    ok "opencode-serve already active — skipping (re-run picks up unit upgrades via daemon-reload below)."
  else
    log "Installing opencode-serve systemd --user unit…"
    mkdir -p "$UNIT_DIR"
    rendered="$(node "$LIB" render-systemd-unit \
      --template "$OC_UNIT_SRC" \
      --placeholder OPENCODE_BIN="$OPENCODE_BIN")" \
      || die "render-systemd-unit failed (see lib)"
    printf '%s' "$rendered" > "$OC_UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now opencode-serve.service
  fi
else
  if pgrep -f 'opencode serve --port 4096' >/dev/null 2>&1; then
    ok "opencode-serve already running (nohup) — skipping."
  else
    warn "systemctl not found. Starting opencode-serve in the background instead."
    warn "It will NOT survive reboot — set up your own supervisor for that."
    ( nohup "$OPENCODE_BIN" serve --port 4096 --hostname 127.0.0.1 >"$AUTH_DIR/opencode.log" 2>&1 & )
  fi
fi
# Health-wait: opencode is loopback-only on :4096. acceptAnyStatus:true is
# the default in waitForHealth; we pass it explicitly so a future reader
# sees the intent ("any response = listening").
log "Waiting for opencode-serve at http://127.0.0.1:4096/…"
node -e '
  import("'"$LIB"'").then(async (m) => {
    const r = await m.waitForHealth("http://127.0.0.1:4096/", {
      maxAttempts: 30,
      intervalMs: 1000,
      acceptAnyStatus: true,
    });
    if (!r.ok) { console.error(r.error); process.exit(1); }
    console.error("healthy after " + r.attempts + " attempt(s) (status " + r.status + ")");
  }).catch((e) => { console.error(String(e)); process.exit(1); });
' || die "opencode-serve did not become healthy at http://127.0.0.1:4096/ — check logs:
      systemctl --user status opencode-serve ; journalctl --user -u opencode-serve -n 50
      or: tail -f $AUTH_DIR/opencode.log"
ok "opencode-serve is healthy."

# --- F. Final summary block (extended heredoc) ----------------------------
# We extend the heredoc that prints at the end (originally section 7).
# The chat-stack bits live in this script (section 6) and show their own
# ok lines above; the heredoc only needs to surface the next-step nudge
# and the claude credentials warning.

# ---------------------------------------------------------------------------
# 7. manta-server systemd --user unit: substitute placeholders and enable.
# ---------------------------------------------------------------------------
NODE_BIN="$(command -v node)"
UNIT_SRC="$MANTA_HOME/scripts/systemd/manta-server.service"
UNIT_DIR="$HOME/.config/systemd/user"
[ -f "$UNIT_SRC" ] || die "missing systemd template: $UNIT_SRC"

if command -v systemctl >/dev/null 2>&1; then
  log "Installing systemd --user unit…"
  mkdir -p "$UNIT_DIR"
  sed \
    -e "s|@@MANTA_HOME@@|$MANTA_HOME|g" \
    -e "s|@@NODE_BIN@@|$NODE_BIN|g" \
    -e "s|@@MANTA_PORT@@|$MANTA_PORT|g" \
    "$UNIT_SRC" > "$UNIT_DIR/manta-server.service"

  # Survive logout/reboot without an active session.
  loginctl enable-linger "$USER" >/dev/null 2>&1 \
    || warn "could not enable-linger for $USER — the server may stop on logout. Run: sudo loginctl enable-linger $USER"

  systemctl --user daemon-reload
  systemctl --user enable --now manta-server.service
  ok "manta-server enabled and started (systemctl --user status manta-server)."
  SERVER_MANAGED=systemd
else
  warn "systemctl not found (not a systemd host?). Starting the server in the background instead."
  warn "It will NOT survive reboot — set up your own supervisor for that."
  ( MANTA_MOBILE_HOST=127.0.0.1 MANTA_MOBILE_PORT="$MANTA_PORT" nohup node "$MANTA_HOME/src/server/index.mjs" >"$AUTH_DIR/server.log" 2>&1 & )
  SERVER_MANAGED=nohup
fi

# ---------------------------------------------------------------------------
# 8. Wait for health, then verify the relay handshake, then mint + print a
#    pairing code. Devices pair THROUGH the relay (relay.mantaui.com) — the
#    install must confirm the box agent actually reached the relay before
#    handing the pairing code back. If the handshake never completes we warn
#    (the box still works locally) and continue — operators can read the
#    journalctl hint and diagnose later.
# ---------------------------------------------------------------------------
log "Waiting for the server to become healthy at $MANTA_HEALTH_URL…"
node -e '
  import("'"$LIB"'").then(async (m) => {
    const r = await m.waitForHealth(process.env.MANTA_HEALTH_URL, { maxAttempts: 60, intervalMs: 1000 });
    if (!r.ok) { console.error(r.error); process.exit(1); }
    console.error("healthy after " + r.attempts + " attempt(s)");
  }).catch((e) => { console.error(String(e)); process.exit(1); });
' || die "server did not become healthy — check logs:
      systemctl --user status manta-server ; journalctl --user -u manta-server -n 50"

ok "Server is healthy."

# Derive the loopback base (drop the /auth/status path) — waitForRelay takes a
# base URL and appends /relay/status itself.
MANTA_RELAY_BASE="$(printf '%s\n' "$MANTA_HEALTH_URL" | sed 's#/auth/status$##')"
log "Waiting for the relay handshake at $MANTA_RELAY_BASE/relay/status…"
# waitForRelay is best-effort — relay outage never fails the install. We log
# the state on stderr and emit exactly one of "connected|disabled|degraded" on
# stdout so the bash below can branch on it without re-fetching.
RELAY_CHECK="$(MANTA_RELAY_BASE="$MANTA_RELAY_BASE" node -e '
  import("'"$LIB"'").then(async (m) => {
    const r = await m.waitForRelay(process.env.MANTA_RELAY_BASE, { maxAttempts: 30, intervalMs: 1000 });
    if (r.ok && r.connected) {
      console.error("connected after " + r.attempts + " attempt(s)");
      process.stdout.write("connected");
    } else if (r.ok && !r.enabled) {
      console.error("relay disabled by config");
      process.stdout.write("disabled");
    } else if (r.ok && !r.connected) {
      console.error("not connected after " + r.attempts + " attempt(s)");
      process.stdout.write("degraded");
    } else {
      console.error(r.error || "unknown failure");
      process.stdout.write("degraded");
    }
  }).catch((e) => {
    console.error(String(e));
    process.stdout.write("degraded");
  });
' 2>/dev/null || echo degraded)"
export MANTA_RELAY_BASE

case "$RELAY_CHECK" in
  connected) ok "Relay link established (relay.mantaui.com).";;
  disabled)
    log "Relay disabled by config (relayEnabled=false) — devices will pair via direct ingress only.";;
  *)
    warn "Relay handshake did not complete — the box is reachable locally; journalctl --user -u manta-server -n 50 will show why."
    warn "  Re-run later: systemctl --user restart manta-server"
    ;;
esac

log "Minting pairing code…"
# Delegate to the same `manta pair` CLI the user runs later (loopback GET /auth/pair).
# We CAPTURE stdout this time so the install-sh heredoc below can quote the
# ready-to-paste `manta://pair?box=…&code=…` link — BET-156 §1. manta-pair.mjs
# prints a stable "  Pairing code:  NNNNNN" line via formatPairingOutput, which
# we sed-extract (no second JSON round-trip; the format is the contract).
PAIR_BLOCK="$(node "$MANTA_HOME/scripts/manta-pair.mjs" 2>/dev/null || true)"
# Echo the formatted block so the user still sees it on stdout (the heredoc
# below ONLY surfaces the box id + ready-to-paste link, not the full block).
printf '%s\n' "$PAIR_BLOCK"
PAIR_CODE="$(printf '%s\n' "$PAIR_BLOCK" | sed -n 's/^  Pairing code:[[:space:]]\+\([0-9]\{6\}\).*/\1/p' | head -n1)"
export PAIR_CODE
if [ -z "$PAIR_CODE" ]; then
  warn "could not extract a 6-digit code from manta-pair.mjs output — pair link will be omitted."
fi

# Read the box_id from ~/.manta/auth.json via the tested install-lib loader
# (NEVER re-parse the JSON in bash — auth.json's shape belongs to the server).
BOX_ID_DISPLAY="$(node -e '
  import("'"$LIB"'").then((m) => {
    const id = m.readBoxIdentity(process.env.MANTA_AUTH_FILE);
    process.stdout.write(id?.box_id ?? "");
  }).catch(() => process.stdout.write(""));
' 2>/dev/null || true)"
export BOX_ID_DISPLAY

cat <<EOF

Installed. Manage the server with:
  systemctl --user status manta-server
  systemctl --user restart manta-server
  journalctl --user -u manta-server -f

Chat backend (opencode-serve) on http://127.0.0.1:4096:
  systemctl --user status opencode-serve
  systemctl --user restart opencode-serve
  journalctl --user -u opencode-serve -f

Your box pairs with devices THROUGH the relay (relay.mantaui.com) — no public
port on this box, no tunnel, no reverse proxy to set up. The desktop / mobile
app discovers it via the relay using the box_id below.
EOF

if [ -n "$BOX_ID_DISPLAY" ]; then
  printf '\n  Box ID:        %s\n' "$BOX_ID_DISPLAY"
fi

# Ready-to-paste pair link (BET-156 §1) — the desktop app parses this directly
# via parsePairPayload and routes through the relay's /pair endpoint. Both
# BOX_ID_DISPLAY and PAIR_CODE are loaded via tested helpers, so this is safe
# even if either is missing (we just print the available half, never crash).
if [ -n "${BOX_ID_DISPLAY:-}" ] && [ -n "${PAIR_CODE:-}" ]; then
  printf '\n  Pair link:     manta://pair?box=%s&code=%s\n' "$BOX_ID_DISPLAY" "$PAIR_CODE"
  printf '                 (paste into the desktop app, or scan as a QR)\n'
fi

cat <<EOF

  (Pairing code printed above by manta pair — re-run any time to mint a fresh one.)

Re-run this installer any time to upgrade in place (your box identity is preserved).
Run 'manta pair' (or 'npm run pair' in $MANTA_HOME) to mint a fresh pairing code.
EOF

# --- Final claude credentials check (warn — not die — per BET-153 step F).
# The only auth prerequisite we assume is the user has run/authed `claude`
# on this box at least once, producing ~/.claude/.credentials.json.
# opencode-serve reads that on first start; without it the chat backend
# starts but rejects all chat requests with a 401 until the user
# authenticates.
if [ -f "$HOME/.claude/.credentials.json" ]; then
  ok "claude credentials detected — chat backend will authenticate on first request."
else
  warn "no \$HOME/.claude/.credentials.json — chat will start but reject requests until you authenticate."
  warn "Run \`claude\` once on this box to sign in, then:"
  warn "  systemctl --user restart opencode-serve"
fi
