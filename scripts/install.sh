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
# Prerequisites on the box (we check, never install — same `require_cmd` tone
# as Homebrew/rustup):
#   * curl, tar, sha256sum  — download + verify the release tarball
#   * tmux, git             — the manta server needs them at runtime
#
# Everything else (Node runtime, npm, node_modules with node-pty's native
# binding already compiled) ships in the tarball. The installer is user-
# space throughout — EXCEPT for the single privileged section of installing
# + configuring Caddy (which must run as root to bind :80/:443 for Let's
# Encrypt HTTP-01) and registering the box with the hosted push gateway
# (gateway.mantaui.com) so the gateway can mint a TLS cert for
# https://<box_id>.boxes.mantaui.com. This is the BET-205 documented
# exception to the BET-173 no-sudo rule — see step 7.5 below + the
# "SUDO EXCEPTION (BET-205)" section in docs/launch-e2e.md for the
# rationale (BET-198 changed requirements: direct-connection needs
# public TLS, which is inherently a root concern; industry norm is sudo
# + distro package manager for this step). The privileged section is
# gated three ways so the install degrades cleanly without sudo:
#   (a) Distro must be Debian/Ubuntu (v1 scope).
#   (b) `sudo` must be installed.
#   (c) `sudo -n true` must succeed (passwordless sudo).
# If any of those fail we print the exact bring-your-own-proxy commands
# and continue with the rest of the install — the loopback server +
# pairing code are unaffected. Every privileged call uses `sudo -n`
# (non-interactive) so it fails fast with a clear hint instead of
# hanging on a password prompt.
#
# Release resolution:
#   1. Fetch `${MANTA_RELEASE_HOST:-https://mantaui.com}/releases/manta-${MANTA_VERSION:-latest}.txt`
#      — a flat key=value manifest written by `npm run pack`.
#   2. Parse `file_linux_x64` + `sha256_linux_x64` from the manifest.
#   3. Download the tarball, verify sha256, extract.
#
# `MANTA_TARBALL_URL` overrides the whole flow: use a local file:// or a
# private mirror. When set, the sha256 check is SKIPPED with a warning — this
# is the only checksum bypass and exists for tests/E2E.
#
# Overrides (env):
#   MANTA_TARBALL_URL   full URL of the release tarball (skips manifest fetch + sha256)
#   MANTA_RELEASE_HOST  host for the manifest + tarball (default https://mantaui.com)
#   MANTA_REPO_URL      git URL the deploy is initialised against for `scripts/self-update.sh`
#                       (default https://github.com/antoinedc/MantaUI.git)
#   MANTA_HOME          where code is unpacked (default ~/manta)
#   MANTA_MOBILE_PORT   server port (default 8787)
#   MANTA_VERSION       version to fetch when MANTA_TARBALL_URL is unset (default: latest)
#   MANTA_GATEWAY_BASE  push-gateway base URL (default https://gateway.mantaui.com)
#   MANTA_RESTART       restart manta-server after config changes (1 = yes, 0 = no)
#
# Flags (positional args):
#   --dry-run           print the steps without touching the system (used by tests)
#   --help              show this help and exit
#
# The pure logic (URL/home resolution, health-wait, pairing format, idempotency,
# gateway-auth merge, DNS-wait poller, Caddy vhost renderer) lives in
# scripts/install-lib.mjs and is unit-tested (scripts/install.test.mjs).
# This shell stays a thin orchestrator.

# === Always-defined helpers (test-safe: defined even in test mode) ===========
# These are defined BEFORE the test-mode guard so the unit tests in
# scripts/install.test.mjs can source this script and call manifest_get /
# verify_sha256 / require_arch without the install body running.
log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Parse one key out of a key=value manifest body. Echoes the value, empty if
# absent. Values may contain `=` (cut -d= -f2- preserves them). A repeated key
# is reduced to the FIRST occurrence (head -n1) — the manifest writer emits
# exactly one of each.
manifest_get() { # $1=manifest-body $2=key
  printf '%s\n' "$1" | grep "^$2=" | head -n1 | cut -d= -f2-
}

# Die unless running on supported arch.
require_arch() {
  local m; m="$(uname -m)"
  [ "$m" = "x86_64" ] || die "only x86_64 Linux is supported by this installer today (got: $m)"
}

# Verify $1's sha256 equals $2 (64-hex). Dies on mismatch.
verify_sha256() {
  local actual; actual="$(sha256sum "$1" | cut -d' ' -f1)"
  [ "$actual" = "$2" ] || die "checksum mismatch for $1
      expected: $2
      actual:   $actual
      (corrupt download or stale manifest — re-run; if it persists, report it)"
}

# Test mode: when sourced by scripts/install.test.mjs with MANTA_INSTALL_TEST_MODE=1,
# only the bash helpers (log/ok/warn/die + manifest_get + verify_sha256 +
# require_arch) are loaded. The actual install does NOT run. Lets the unit
# tests exercise the helpers with mocked `uname`/etc. without hitting the
# network. See scripts/install.test.mjs.
if [ "${MANTA_INSTALL_TEST_MODE:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

set -euo pipefail

# ---------------------------------------------------------------------------
# main — the install body. Wrapped in a function so a truncated `curl | bash`
# download never executes a half script (the LAST line is `main "$@"`; if the
# pipe is cut mid-file, bash still has the helpers + the test-mode guard, but
# never reaches main).
# ---------------------------------------------------------------------------
main() {
  require_arch

  # ---------------------------------------------------------------------------
  # 0. Argument parsing. `--dry-run` walks the install path with every external
  #    side-effect short-circuited: no Caddy install, no curl to the gateway,
  #    no real DNS wait, no Caddyfile write, no systemctl reload. Each step
  #    prints `[dry-run] would …` so tests + humans can see the plan without
  #    actually running it. Used by `install.test.mjs` (bash sourced + mocked
  #    helpers) and by anyone previewing what a fresh install will do.
  # ---------------------------------------------------------------------------
  DRY_RUN=0
  for arg in "$@"; do
    case "$arg" in
      --dry-run)
        DRY_RUN=1
        ;;
      --help|-h)
        printf 'install.sh — manta box self-install (curl -fsSL … | bash)\n'
        printf '  --dry-run   print the steps without touching the system\n'
        printf '  --help      this help\n'
        return 0 2>/dev/null || exit 0
        ;;
      *)
        die "unknown argument: $arg (try --help)"
        ;;
    esac
  done

  # dry_log prints a "would do X" line in dry-run mode; in real mode it's a
  # no-op so the real log() call below carries the user-facing message.
  dry_log() {
    if [ "$DRY_RUN" = "1" ]; then
      printf '\033[36m▸\033[0m [dry-run] %s\n' "$*"
    fi
  }

  # ---------------------------------------------------------------------------
  # 1. Prerequisites. We ASSUME these are present; we never install them.
  #    The hint suggests the distro's package manager — the user has the
  #    permissions to run that themselves.
  # ---------------------------------------------------------------------------
  require_cmd() {
    local cmd="$1" hint="$2"
    if ! command -v "$cmd" >/dev/null 2>&1; then
      die "missing prerequisite: $cmd
        Install it and re-run. Suggested:
          $hint"
    fi
  }

  log "Checking prerequisites (curl, tar, sha256sum, tmux, git)…"
  require_cmd curl      "apt-get install -y curl   # or your distro's package manager"
  require_cmd tar       "apt-get install -y tar"
  require_cmd sha256sum "apt-get install -y coreutils"
  require_cmd git       "apt-get install -y git"
  require_cmd tmux      "apt-get install -y tmux"
  ok "Prerequisites present."

  # ---------------------------------------------------------------------------
  # 2. Resolve the release. Default path fetches the manifest + parses the
  #    file/sha256; MANTA_TARBALL_URL override skips BOTH (with a warn).
  # ---------------------------------------------------------------------------
  WORK="$(mktemp -d "$HOME/.manta-install.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT

  SKIP_CHECKSUM=0
  if [ -n "${MANTA_TARBALL_URL:-}" ]; then
    TARBALL_URL="$MANTA_TARBALL_URL"
    SKIP_CHECKSUM=1
    warn "MANTA_TARBALL_URL override — checksum verification skipped"
  else
    host="${MANTA_RELEASE_HOST:-https://mantaui.com}"
    host="${host%/}"
    version="${MANTA_VERSION:-latest}"
    log "Fetching manifest from $host/releases/manta-${version}.txt…"
    manifest="$(curl -fsSL "$host/releases/manta-${version}.txt")" \
      || die "manifest fetch failed: $host/releases/manta-${version}.txt
          (set MANTA_RELEASE_HOST to a reachable mirror, or MANTA_TARBALL_URL to a local file://)"
    TARBALL_FILE="$(manifest_get "$manifest" "file_linux_x64")"
    TARBALL_SHA="$(manifest_get "$manifest" "sha256_linux_x64")"
    if [ -z "$TARBALL_FILE" ] || [ -z "$TARBALL_SHA" ]; then
      die "manifest is malformed or this version has no linux-x64 build"
    fi
    TARBALL_URL="$host/releases/$TARBALL_FILE"
  fi
  log "Release tarball: $TARBALL_URL"

  # ---------------------------------------------------------------------------
  # 3. Download + extract. WORK is on $HOME so the final `mv` into MANTA_HOME
  #    is a same-filesystem rename (atomic), and we never trip noexec /tmp.
  # ---------------------------------------------------------------------------
  log "Downloading release…"
  curl -fsSL "$TARBALL_URL" -o "$WORK/manta.tar.gz" \
    || die "download failed: $TARBALL_URL
        (set MANTA_TARBALL_URL to a reachable tarball, e.g. a local file:// or mirror)"

  if [ "$SKIP_CHECKSUM" -eq 0 ]; then
    log "Verifying tarball sha256…"
    verify_sha256 "$WORK/manta.tar.gz" "$TARBALL_SHA"
    ok "sha256 verified."
  fi

  log "Extracting to $WORK/pkg…"
  mkdir "$WORK/pkg"
  tar -xzf "$WORK/manta.tar.gz" -C "$WORK/pkg" --strip-components=1 \
    || die "extract failed"

  # Sanity gates — a bad release tarball (e.g. an aborted publish that left a
  # stale tarball pointed at by a fresh manifest) fails loud HERE, not later
  # when the systemd unit starts.
  [ -x "$WORK/pkg/runtime/node/bin/node" ] \
    || die "bad release tarball — missing runtime/node/bin/node"
  [ -d "$WORK/pkg/node_modules" ] \
    || die "bad release tarball — missing node_modules"
  [ -f "$WORK/pkg/scripts/install-lib.mjs" ] \
    || die "bad release tarball — missing scripts/install-lib.mjs"
  [ -f "$WORK/pkg/src/server/index.mjs" ] \
    || die "bad release tarball — missing src/server/index.mjs"
  ok "Release tarball looks self-contained."

  # ---------------------------------------------------------------------------
  # 4. Atomic swap. .prev preserves the previous install in case anything in
  #    the new install fails before completion — operators can `mv` it back.
  # ---------------------------------------------------------------------------
  MANTA_HOME="${MANTA_HOME:-$HOME/manta}"
  AUTH_DIR="$HOME/.manta"

  rm -rf "$MANTA_HOME.prev"
  if [ -d "$MANTA_HOME" ]; then mv "$MANTA_HOME" "$MANTA_HOME.prev"; fi
  mv "$WORK/pkg" "$MANTA_HOME" \
    || { # mv failed — restore the .prev so the box isn't bricked.
       warn "mv into $MANTA_HOME failed — restoring $MANTA_HOME.prev"
       rm -rf "$MANTA_HOME"
       [ -d "$MANTA_HOME.prev" ] && mv "$MANTA_HOME.prev" "$MANTA_HOME"
       die "could not move extracted tarball into $MANTA_HOME — previous install restored"
    }

  # ---------------------------------------------------------------------------
  # 4b. Git-aware deploy init. `scripts/self-update.sh` (wired in BET-225.A5)
  #     assumes $MANTA_HOME is a git checkout pointed at origin/main, so the
  #     update path can do `git fetch + reset --hard origin/main`. The release
  #     tarball ships WITHOUT a .git/ (pack.mjs strips it), so we re-create one
  #     here. Idempotent: a re-run on an existing deploy updates the remote
  #     URL in place (handles renames) and re-resets to origin/main so the
  #     tarball + the working tree always agree. Untracked files
  #     (runtime/, RELEASE.json) survive — `git reset --hard` only touches
  #     tracked paths.
  # ---------------------------------------------------------------------------
  MANTA_REPO_URL="${MANTA_REPO_URL:-https://github.com/antoinedc/MantaUI.git}"
  if [ "$DRY_RUN" = "1" ]; then
    dry_log "would init git at $MANTA_HOME, fetch $MANTA_REPO_URL, reset --hard origin/main"
  else
    log "Initialising git checkout at $MANTA_HOME (origin=$MANTA_REPO_URL)"
    if [ ! -d "$MANTA_HOME/.git" ]; then
      git -C "$MANTA_HOME" init -q -b main \
        || die "git init failed at $MANTA_HOME — install git and retry"
    fi
    # `git remote add` fails if the remote already exists (re-run case);
    # `set-url` is the idempotent override.
    git -C "$MANTA_HOME" remote set-url origin "$MANTA_REPO_URL" 2>/dev/null \
      || git -C "$MANTA_HOME" remote add origin "$MANTA_REPO_URL"
    git -C "$MANTA_HOME" fetch origin main -q \
      || die "git fetch origin main failed — check network / MANTA_REPO_URL"
    git -C "$MANTA_HOME" reset --hard origin/main -q \
      || die "git reset --hard origin/main failed at $MANTA_HOME"
    ok "Deploy is git-aware: $(git -C "$MANTA_HOME" rev-parse --short HEAD)"
  fi

  # From here on, EVERY node invocation uses the vendored binary explicitly.
  # No path lookup, no reliance on a system node.
  NODE="$MANTA_HOME/runtime/node/bin/node"
  export PATH="$MANTA_HOME/runtime/node/bin:$PATH"

  # Now use the REAL tested lib for everything downstream.
  LIB="$MANTA_HOME/scripts/install-lib.mjs"
  [ -f "$LIB" ] || die "tarball is missing scripts/install-lib.mjs — bad release?"

  # Resolve the canonical config (exports MANTA_HOME, MANTA_AUTH_FILE, MANTA_PORT,
  # MANTA_HEALTH_URL, …). Version comes from package.json when unset.
  pkg_version="$("$NODE" -p 'require("./package.json").version' 2>/dev/null || echo "${MANTA_VERSION:-unknown}")"
  eval "$(MANTA_HOME="$MANTA_HOME" "$NODE" "$LIB" print-config --version "$pkg_version")"
  # Export the values the install body passes into the node subprocess via
  # process.env (waitForHealth).
  export MANTA_HOME MANTA_AUTH_DIR MANTA_AUTH_FILE MANTA_TARBALL_URL MANTA_PORT MANTA_HEALTH_URL

  # ---------------------------------------------------------------------------
  # 5. Idempotency: report whether we're preserving an existing box identity.
  # ---------------------------------------------------------------------------
  identity="$("$NODE" "$LIB" check-identity 2>/dev/null || echo fresh)"
  if [ "$identity" = "preserve" ]; then
    ok "Existing box identity found at $MANTA_AUTH_FILE — preserving it (never regenerated)."
  else
    log "No existing identity — the server will mint one on first start."
  fi

  # ---------------------------------------------------------------------------
  # 6. Chat stack provisioning (opencode + manta-native tools + tmux presence).
  #    A fresh VPS just needs claude code installed (~/.claude/.credentials.json
  #    exists). Re-running is a no-op except for version upgrades; every step
  #    is safe to run twice.
  # ---------------------------------------------------------------------------

  # UNIT_DIR is referenced by step 6E (opencode-serve) AND step 7
  # (manta-server) below; define it once, up front.
  UNIT_DIR="$HOME/.config/systemd/user"

  # --- A. opencode install (idempotent via official installer). ------------
  # We use opencode's official installer; no version pinning in v1 — the
  # installer is the source of truth for "current". Re-running is a no-op
  # when the binary is already on PATH.
  OPENCODE_BIN="$(command -v opencode || true)"
  if [ -n "$OPENCODE_BIN" ]; then
    ok "opencode already installed ($("$OPENCODE_BIN" --version 2>/dev/null | head -n1 || echo "$OPENCODE_BIN"))."
  else
    log "Installing opencode (official installer)…"
    # The installer writes to ~/.opencode/bin/opencode (per the installer's
    # current shape) and appends `export PATH=...` to ~/.bashrc. Bash
    # non-interactive shells (which is how install.sh runs) don't source
    # .bashrc, so the binary isn't on PATH in the current shell — we add
    # it explicitly. The fallback covers the documented path.
    curl -fsSL https://opencode.ai/install | bash \
      || die "opencode install failed — install manually: https://opencode.ai"
    # Refresh PATH from .bashrc if the installer wrote there, then also
    # probe the well-known install location as a safety net.
    if [ -f "$HOME/.bashrc" ]; then
      # shellcheck disable=SC1090
      set +e
      # shellcheck disable=SC1090
      . "$HOME/.bashrc" 2>/dev/null || true
      set -e
    fi
    if [ -x "$HOME/.opencode/bin/opencode" ]; then
      export PATH="$HOME/.opencode/bin:$PATH"
    fi
    OPENCODE_BIN="$(command -v opencode || true)"
    if [ -z "$OPENCODE_BIN" ]; then
      die "opencode still not on PATH after install. Try: export PATH=\"\$HOME/.opencode/bin:\$PATH\" and re-run."
    fi
    ok "opencode installed ($("$OPENCODE_BIN" --version 2>/dev/null | head -n1 || echo "$OPENCODE_BIN"))."
  fi

  # --- B. opencode config seeding — MERGE the plugin entry, never clobber. --
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
  merged="$(printf '%s' "$existing" | "$NODE" "$LIB" merge-opencode-config 2>/tmp/opencode-merge.err)" \
    || die "merge-opencode-config failed (see /tmp/opencode-merge.err)"
  if grep -q '^corrupt=1' /tmp/opencode-merge.err 2>/dev/null; then
    cp "$OPENCODE_CONFIG" "$OPENCODE_CONFIG_BACKUP" 2>/dev/null \
      && warn "opencode.jsonc was unparseable — original backed up to $OPENCODE_CONFIG_BACKUP, starting from {}." \
      || warn "opencode.jsonc was unparseable and the backup FAILED — installer continues but original is NOT preserved."
  fi
  printf '%s' "$merged" > "$OPENCODE_CONFIG"
  ok "opencode.jsonc seeded."

  # --- C. manta opencode tools + agent guidance (REAL copies, not symlinks).
  # Per AGENTS.md ("Mobile / web client"): opencode resolves tool imports from
  # the file's REAL path; a symlink into the tarball tree misses
  # ~/.config/opencode/node_modules/@opencode-ai/plugin and the tool silently
  # never registers. So we cp — same inode-disjoint paths.
  OPENCODE_TOOLS_SRC="$MANTA_HOME/docs/opencode-tools"
  OPENCODE_TOOLS_DIR="$OPENCODE_CONFIG_DIR/tools"
  OPENCODE_AGENTS="$OPENCODE_CONFIG_DIR/AGENTS.md"
  if [ -d "$OPENCODE_TOOLS_SRC" ]; then
    mkdir -p "$OPENCODE_TOOLS_DIR"
    log "Copying manta-native opencode tools into $OPENCODE_TOOLS_DIR…"
    # cp -f overwrites — tools are versioned with the tarball, so a re-run
    # naturally picks up upgrades.
    cp -f "$OPENCODE_TOOLS_SRC"/*.ts "$OPENCODE_TOOLS_DIR/" \
      || die "failed to copy opencode tools from $OPENCODE_TOOLS_SRC"
    ok "opencode tools copied."
  else
    warn "$OPENCODE_TOOLS_SRC not found in tarball — skipping tool copy (was docs/opencode-tools/* added to release/pack.mjs?)."
  fi
  # AGENTS.md append with marker guard — idempotency by a single grep on a
  # stable line ("## manta scheduled tasks"). A re-run with the marker present
  # is a clean no-op.
  if [ -f "$OPENCODE_TOOLS_SRC/AGENTS.md" ]; then
    if [ -f "$OPENCODE_AGENTS" ] && grep -q '^## manta scheduled tasks' "$OPENCODE_AGENTS"; then
      ok "opencode AGENTS.md already contains manta guidance — skipping append."
    else
      log "Appending manta opencode agent guidance to $OPENCODE_AGENTS…"
      {
        [ -f "$OPENCODE_AGENTS" ] && cat "$OPENCODE_AGENTS" && printf '\n'
        cat "$OPENCODE_TOOLS_SRC/AGENTS.md"
      } > "$OPENCODE_AGENTS.tmp" && mv "$OPENCODE_AGENTS.tmp" "$OPENCODE_AGENTS"
      ok "opencode AGENTS.md updated."
    fi
  fi

  # --- D. opencode-serve systemd --user unit (or nohup fallback). ----------
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
      rendered="$("$NODE" "$LIB" render-systemd-unit \
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
  "$NODE" -e '
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

  # ---------------------------------------------------------------------------
  # 7. manta-server systemd --user unit: substitute placeholders and enable.
  # ---------------------------------------------------------------------------
  UNIT_SRC="$MANTA_HOME/scripts/systemd/manta-server.service"
  [ -f "$UNIT_SRC" ] || die "missing systemd template: $UNIT_SRC"

  if command -v systemctl >/dev/null 2>&1; then
    log "Installing systemd --user unit…"
    mkdir -p "$UNIT_DIR"
    sed \
      -e "s|@@MANTA_HOME@@|$MANTA_HOME|g" \
      -e "s|@@NODE_BIN@@|$NODE|g" \
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
    ( MANTA_MOBILE_HOST=127.0.0.1 MANTA_MOBILE_PORT="$MANTA_PORT" nohup "$NODE" "$MANTA_HOME/src/server/index.mjs" >"$AUTH_DIR/server.log" 2>&1 & )
    SERVER_MANAGED=nohup
  fi

  # On a fresh config change, the server may need a restart to pick it up.
  if [ "${SERVER_MANAGED:-}" = "systemd" ] && [ "${MANTA_RESTART:-1}" = "1" ]; then
    systemctl --user restart manta-server.service \
      || warn "systemctl --user restart manta-server failed — run it manually"
  fi

  # Single source of truth for the inline `node -e readBoxIdentity`
  # read. Used by step 7.5 (gateway register needs box_id) and step 8
  # (the trailing-pairing heredoc prints box_id + pair-link). Without
  # this helper the two reads drifted in subtle ways — see install.test's
  # strict duplication-gate catching the 6-line clone (BET-205).
  # Reads MANTA_AUTH_FILE; returns the 32-hex box_id or empty on a
  # missing/corrupt auth.json. Errors go to stderr; the empty fallback
  # lets the caller branch (e.g. warn + skip on no box_id).
  read_box_id_for_gateway() {
    "$NODE" -e '
      import("'"$LIB"'").then((m) => {
        const id = m.readBoxIdentity(process.env.MANTA_AUTH_FILE);
        process.stdout.write(id?.box_id ?? "");
      }).catch(() => process.stdout.write(""));
    ' 2>/dev/null || true
  }

  # ===========================================================================
  # 7.5. PRIVILEGED SECTION — Caddy + DNS + gateway registration (BET-205 WP5).
  #
  #     EXCEPTION TO THE BET-173 NO-SUDO RULE. The installer is otherwise
  #     100% user-space (tarball, identity, systemd --user, opencode) — the
  #     BET-198 direct-connection design changed requirements: the box must
  #     terminate public TLS on :80/:443 (Let's Encrypt HTTP-01), which is
  #     inherently a root concern. Industry norm (Tailscale, get.docker.com,
  #     Caddy's own installer) uses sudo + distro package manager for
  #     exactly this step. We isolate it here and document it in:
  #       - scripts/install.sh header (the SUDO POLICY note at the top)
  #       - docs/launch-e2e.md ("SUDO EXCEPTION (BET-205)" section)
  #     so the next agent reading the BET-173 record doesn't "fix" this
  #     work as a regression.
  #
  #     This section runs the gateway registration + DNS wait + Caddy
  #     install + Caddyfile write + caddy reload. Every privileged call
  #     below uses `sudo -n` (non-interactive) and the whole section
  #     bails cleanly (warn + skip) on:
  #       a. Distro not in {debian, ubuntu, ID_LIKE=debian} (v1 scope)
  #       b. `sudo` missing
  #       c. `sudo -n true` failing (non-passwordless sudo)
  #     In any of those cases we print the exact commands the user
  #     should run to bring their own proxy (or install Caddy manually)
  #     and continue with the rest of the install — the loopback
  #     server + pairing code are unaffected.
  #
  #     Sub-steps:
  #       A. Install Caddy if absent (the only apt-get the installer
  #          ever runs — Caddy must run as root to bind :80/:443).
  #       B. Ask the hosted gateway (https://gateway.mantaui.com) to
  #          publish a per-box A record and mint a `gateway_token`.
  #       C. Persist the gateway_token + gateway_host into auth.json
  #          via the `merge-gateway` lib subcommand (atomic temp-rename
  #          + 0600 — preserves box_id / box_token).
  #       D. Poll until <box_id>.boxes.mantaui.com resolves to this
  #          box's public IP (OVH publication is eventually-consistent
  #          and can take up to ~30s after the gateway POST).
  #       E. Write /etc/caddy/Caddyfile.d/manta.caddy with a single
  #          reverse_proxy vhost, then `systemctl reload caddy`.
  #
  #     IDEMPOTENT: every step no-ops cleanly on re-run. Registration
  #     refreshes the A record if the box's IP changed; the Caddy block
  #     is overwritten in place; the DNS poll is skipped if it already
  #     resolves to our IP.
  #
  #     Dry-run mode (--dry-run): each step prints `[dry-run] would …`
  #     and skips the actual side-effect regardless of distro / sudo
  #     (the gates only fire when we're actually about to do real work).
  # ===========================================================================

  # Gate the section. In dry-run mode we always show what we would do
  # (the dry_log lines are below). In real mode we bail with a clear
  # bring-your-own-proxy hint when distro isn't Debian/Ubuntu or sudo
  # isn't usable.
  PRIVILEGED_SECTION_SKIP=0
  if [ "$DRY_RUN" != "1" ]; then
    # Distro check (Debian/Ubuntu only for v1 — see reviewer guidance §4).
    DISTRO_STATUS="$("$NODE" "$LIB" detect-distro 2>/dev/null || echo "")"
    DISTRO_SUPPORTED="$(printf '%s' "$DISTRO_STATUS" | "$NODE" -e '
      let s = "";
      process.stdin.on("data", (c) => { s += c; });
      process.stdin.on("end", () => {
        try { process.stdout.write(JSON.parse(s).supported ? "yes" : "no"); }
        catch { process.stdout.write("unknown"); }
      });
    ' 2>/dev/null || echo unknown)"
    DISTRO_ID="$(printf '%s' "$DISTRO_STATUS" | "$NODE" -e '
      let s = "";
      process.stdin.on("data", (c) => { s += c; });
      process.stdin.on("end", () => {
        try { process.stdout.write(JSON.parse(s).id ?? ""); }
        catch { process.stdout.write(""); }
      });
    ' 2>/dev/null || true)"
    case "$DISTRO_SUPPORTED" in
      yes)
        # supported; continue
        ;;
      no|unknown|"")
        warn "Caddy/gateway section skipped: distro ${DISTRO_ID:-unknown} is not in the v1 supported list (debian / ubuntu / ID_LIKE=debian)."
        warn "  this installer only manages Caddy + the gateway registration on Debian/Ubuntu."
        warn "  bring-your-own-proxy: point any reverse proxy at 127.0.0.1:$MANTA_PORT and serve your own TLS."
        warn "  once Caddy (or another reverse proxy) is serving the box, re-run the installer to finish gateway registration."
        PRIVILEGED_SECTION_SKIP=1
        ;;
    esac

    # Sudo check — bail cleanly if sudo is missing or non-interactive.
    # We use `sudo -n true` as the gate (non-interactive; never prompts).
    # Passwordless sudo is required because the install runs unattended
    # from `curl | bash`.
    if [ "$PRIVILEGED_SECTION_SKIP" = "0" ]; then
      if ! command -v sudo >/dev/null 2>&1; then
        warn "Caddy/gateway section skipped: \`sudo\` is not installed."
        warn "  install sudo + grant $USER passwordless sudo, or run the
  install with sudo available. To finish this section by hand:"
        warn "    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl"
        warn "    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
        warn "    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/deb.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list"
        warn "    sudo apt update && sudo apt install caddy"
        warn "  then re-run the installer (the gateway + DNS + Caddyfile steps re-run cleanly)."
        PRIVILEGED_SECTION_SKIP=1
      elif ! sudo -n true 2>/dev/null; then
        warn "Caddy/gateway section skipped: passwordless sudo is not configured for $USER."
        warn "  either configure \`$USER ALL=(ALL) NOPASSWD:ALL\` in /etc/sudoers.d/ and re-run,"
        warn "  or install Caddy by hand (commands in the previous message) and re-run the installer."
        PRIVILEGED_SECTION_SKIP=1
      fi
    fi
  fi

  if [ "$PRIVILEGED_SECTION_SKIP" = "1" ]; then
    log "Skipping public-TLS step (bring-your-own-proxy keeps the rest of the install working)."
  else
    log "Configuring public TLS via Caddy + gateway registration (privileged)…"

    # --- A. Install Caddy if absent ------------------------------------------
    if command -v caddy >/dev/null 2>&1; then
      ok "caddy already installed ($(caddy version 2>/dev/null || echo unknown))."
    elif [ "$DRY_RUN" = "1" ]; then
      dry_log "would install caddy via the official apt repo (skipped: --dry-run)"
    else
      log "Installing Caddy (official apt repo)…"
      # The Caddy project's official Debian/Ubuntu install path: add the
      # Cloudsmith-hosted stable repo + apt key, then apt install caddy.
      # We use sudo because Caddy must run as a system service (binds
      # :80/:443 for Let's Encrypt HTTP-01). The installer is otherwise
      # 100% user-space — this is the only privileged step (and it has
      # already been gated at the top of step 7.5: distro is
      # Debian/Ubuntu and `sudo -n true` has been verified to succeed).
      sudo -n apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl \
        || die "apt-get install prerequisites for Caddy failed"
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
        | sudo -n gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
        || die "failed to download Caddy GPG key"
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/deb.deb.txt \
        | sudo -n tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null \
        || die "failed to add Caddy apt repo"
      sudo -n apt-get update \
        || die "apt-get update failed"
      sudo -n apt-get install -y caddy \
        || die "apt-get install caddy failed"
      ok "caddy installed ($(caddy version 2>/dev/null || echo unknown))."
    fi

    # --- B/C. Register with the gateway + persist gateway_token -------------
  # Read box_id from auth.json (the server's first start minted it). Skip
  # the registration block entirely if we can't find one — a re-run before
  # the server has booted at least once has no box_id to register.
  BOX_ID_FOR_GATEWAY="$(read_box_id_for_gateway)"

  if [ -z "$BOX_ID_FOR_GATEWAY" ]; then
    warn "no box_id in $MANTA_AUTH_FILE yet — skipping gateway registration + Caddy setup."
    warn "  start the manta-server at least once (systemctl --user restart manta-server) and re-run."
  else
    GATEWAY_BASE="${MANTA_GATEWAY_BASE:-https://gateway.mantaui.com}"
    # Use the existing gateway_token if present so re-registration is an
    # idempotent IP refresh; otherwise POST /register with no auth and the
    # gateway returns a fresh token + host. The gateway response always
    # carries {host}; the token is only present on first registration.
    PRIOR_TOKEN="$("$NODE" -e '
      const fs = require("node:fs");
      try {
        const a = JSON.parse(fs.readFileSync(process.env.MANTA_AUTH_FILE, "utf-8"));
        process.stdout.write(typeof a?.gateway_token === "string" ? a.gateway_token : "");
      } catch { process.stdout.write(""); }
    ' 2>/dev/null || true)"

    if [ "$DRY_RUN" = "1" ]; then
      dry_log "would POST $GATEWAY_BASE/register with box_id=$BOX_ID_FOR_GATEWAY (prior_token=${PRIOR_TOKEN:+set})"
      dry_log "would persist gateway response into $MANTA_AUTH_FILE via merge-gateway"
    else
      log "Registering with gateway $GATEWAY_BASE/register…"
      REGISTER_ARGS=(-fsSL -X POST -H "content-type: application/json" --data "$(printf '{"box_id":"%s"}' "$BOX_ID_FOR_GATEWAY")")
      if [ -n "$PRIOR_TOKEN" ]; then
        REGISTER_ARGS+=(-H "authorization: Bearer $PRIOR_TOKEN")
      fi
      GW_RESP="$(curl "${REGISTER_ARGS[@]}" "$GATEWAY_BASE/register")" \
        || { warn "gateway registration POST failed — the box will retry on every server restart.
          Pair the device via SSH port-forward or use a non-gateway ingress until this works."; GW_RESP=""; }
      if [ -n "$GW_RESP" ]; then
        # Pipe the JSON to merge-gateway via stdin (lib subcommand) so the
        # auth.json write is atomic temp-rename + 0600, preserving
        # box_id / box_token / created_at.
        printf '%s' "$GW_RESP" | "$NODE" "$LIB" merge-gateway --file "$MANTA_AUTH_FILE" 2>/tmp/manta-gateway-merge.err \
          || warn "merge-gateway failed (see /tmp/manta-gateway-merge.err) — the server will re-register on next boot."
        ok "gateway registration complete."
      fi
    fi

    # --- D. Poll DNS until <box_id>.boxes.mantaui.com resolves to us -------
    # Re-read gateway_host (or default to the canonical pattern if the
    # gateway didn't return one yet) for the polling target.
    GATEWAY_HOST="$("$NODE" -e '
      const fs = require("node:fs");
      try {
        const a = JSON.parse(fs.readFileSync(process.env.MANTA_AUTH_FILE, "utf-8"));
        process.stdout.write(typeof a?.gateway_host === "string" ? a.gateway_host : "");
      } catch { process.stdout.write(""); }
    ' 2>/dev/null || true)"
    if [ -z "$GATEWAY_HOST" ]; then
      GATEWAY_HOST="$BOX_ID_FOR_GATEWAY.boxes.mantaui.com"
    fi

    # Detect this box's public IP via the gateway's source-IP report —
    # fall back to `hostname -I` if the gateway response didn't include it
    # (or in dry-run mode). We MUST use the public IP, not loopback —
    # otherwise the DNS check trivially passes on every box.
    BOX_PUBLIC_IP="$("$NODE" -e '
      const https = require("node:https");
      const opts = { hostname: "api.ipify.org", path: "/", method: "GET", timeout: 5000 };
      const req = https.request(opts, (res) => {
        let body = "";
        res.on("data", (c) => body += c);
        res.on("end", () => process.stdout.write(body.trim()));
      });
      req.on("error", () => process.stdout.write(""));
      req.end();
    ' 2>/dev/null || true)"
    if [ -z "$BOX_PUBLIC_IP" ]; then
      BOX_PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi

    if [ -z "$BOX_PUBLIC_IP" ]; then
      warn "could not determine the box's public IP — skipping DNS wait + Caddy setup."
      warn "  the box will retry on every server restart."
    else
      if [ "$DRY_RUN" = "1" ]; then
        dry_log "would poll DNS for $GATEWAY_HOST (expecting $BOX_PUBLIC_IP) for up to 5 minutes"
      else
        log "Waiting for $GATEWAY_HOST to resolve to $BOX_PUBLIC_IP (up to 5 minutes)…"
        if ! "$NODE" "$LIB" wait-for-dns \
            --hostname "$GATEWAY_HOST" \
            --expected-ip "$BOX_PUBLIC_IP" \
            --max-attempts 30 \
            --interval-ms 10000; then
          die "$GATEWAY_HOST did not resolve to $BOX_PUBLIC_IP — gateway registration may have failed.
            Check: curl -fsS $GATEWAY_BASE/healthz
            And:   journalctl --user -u manta-server -n 50 (for the gateway-register lines)"
        fi
        ok "DNS resolved."
      fi

      # --- E. Write the Caddy vhost and reload ----------------------------
      # /etc/caddy/Caddyfile.d/ is the convention used by the official
      # Caddy apt repo's stock /etc/caddy/Caddyfile (which imports
      # /etc/caddy/Caddyfile.d/*.caddy). Falling back to /etc/caddy/Caddyfile
      # with marked-block append is for distros that install Caddy without
      # the conf.d import (we test for the directory's existence).
      #
      # GrACEful DEGRADATION: every privileged call here can fail (sudo
      # tee / sudo mv / sudo systemctl), and the design-guidance §3
      # contract says we MUST let the install reach the pair-code print
      # even when the Caddyfile write fails. We track failures with a
      # local CADDY_E_SKIP flag — any privileged call that returns
      # non-zero sets the flag, and the rest of 7.5.E is skipped. The
      # pair-code step (8) below runs regardless.
      CADDY_E_SKIP=0
      CADDY_DIR_D="/etc/caddy/Caddyfile.d"
      if [ "$DRY_RUN" = "1" ]; then
        dry_log "would render Caddy vhost (box_id=$BOX_ID_FOR_GATEWAY, port=$MANTA_PORT)"
        dry_log "would write the snippet to $CADDY_DIR_D/manta.caddy"
        dry_log "would run: systemctl reload caddy"
      else
        if [ -d "$CADDY_DIR_D" ]; then
          # Caddyfile.d exists → write the snippet as a separate file.
          if ! "$NODE" "$LIB" render-caddy-vhost --box-id "$BOX_ID_FOR_GATEWAY" --port "$MANTA_PORT" --mode snippet \
              | sudo -n tee "$CADDY_DIR_D/manta.caddy" >/dev/null 2>/tmp/manta-caddy-tee.err; then
            warn "failed to write $CADDY_DIR_D/manta.caddy (sudo tee failed — see /tmp/manta-caddy-tee.err)"
            warn "  the rest of the install will proceed; re-run after fixing sudo to write the Caddy vhost."
            CADDY_E_SKIP=1
          fi
        else
          # conf.d missing → append a marker-bracketed block to the main
          # Caddyfile. A re-run overwrites the same block (between the
          # markers), so we never accumulate duplicate vhosts.
          SNIPPET="$("$NODE" "$LIB" render-caddy-vhost --box-id "$BOX_ID_FOR_GATEWAY" --port "$MANTA_PORT" --mode inline)"
          CADDYFILE="/etc/caddy/Caddyfile"
          if [ -f "$CADDYFILE" ]; then
            if grep -q '^# >>> manta >>>' "$CADDYFILE"; then
              # Replace the existing block (between the markers) with the
              # freshly-rendered one. sed -i is intentionally GNU-only —
              # the install targets x86_64 Debian/Ubuntu, which ship GNU sed.
              tmp="$(mktemp)"
              awk '/^# >>> manta >>>$/{skip=1; print; next} /^# <<< manta <<<$/{skip=0; print "REPLACE_HERE"; next} skip{next} {print}' "$CADDYFILE" \
                | awk -v snippet="$SNIPPET" '/REPLACE_HERE/{print snippet; next} {print}' \
                > "$tmp"
              if ! sudo -n mv "$tmp" "$CADDYFILE" 2>/tmp/manta-caddy-mv.err; then
                warn "could not update $CADDYFILE (sudo mv failed — see /tmp/manta-caddy-mv.err)"
                warn "  the rest of the install will proceed; re-run after fixing sudo to write the Caddy vhost."
                CADDY_E_SKIP=1
                rm -f "$tmp" 2>/dev/null || true
              fi
            else
              if ! sudo -n bash -c "printf '\n%s\n' \"\$1\" >> \"\$2\"" -- "$SNIPPET" "$CADDYFILE" 2>/tmp/manta-caddy-append.err; then
                warn "could not append to $CADDYFILE (sudo bash failed — see /tmp/manta-caddy-append.err)"
                warn "  the rest of the install will proceed; re-run after fixing sudo to write the Caddy vhost."
                CADDY_E_SKIP=1
              fi
            fi
          else
            # No Caddyfile exists — create a minimal one with the marker
            # block. We pipe via printf (not a heredoc) because heredocs
            # require the EOF marker at column 0, which conflicts with
            # install.sh's indentation. printf works at any indent.
            NEW_CADDYFILE_CONTENT="$(printf '# minimal Caddyfile — generated by install.sh (BET-205)\n\n%s\n' "$SNIPPET")"
            if ! printf '%s' "$NEW_CADDYFILE_CONTENT" | sudo -n tee "$CADDYFILE" >/dev/null 2>/tmp/manta-caddy-create.err; then
              warn "could not create $CADDYFILE (sudo tee failed — see /tmp/manta-caddy-create.err)"
              warn "  the rest of the install will proceed; re-run after fixing sudo to write the Caddy vhost."
              CADDY_E_SKIP=1
            fi
          fi
        fi

        # Sub-tasks below depend on the Caddyfile being on disk; skip them
        # if any write above failed (CADDY_E_SKIP=1). The pair-code step
        # (8) still runs regardless.
        if [ "$CADDY_E_SKIP" = "0" ]; then
          # Let's Encrypt HTTP-01 needs :80 + :443 open. If something else
          # is bound (Apache, nginx, …) warn loudly so the operator knows
          # why cert issuance will fail.
          if command -v ss >/dev/null 2>&1; then
            for port in 80 443; do
              if ss -tlnH "sport = :$port" 2>/dev/null | grep -q LISTEN \
                && ! ss -tlnH "sport = :$port" 2>/dev/null | grep -q caddy; then
                warn "port $port is bound by something other than Caddy — Let's Encrypt HTTP-01 will fail.
                  Check: ss -tlnp 'sport = :$port'
                  Fix: stop the conflicting service, or move Caddy to a non-standard port + your own reverse proxy."
              fi
            done
          fi

          if command -v systemctl >/dev/null 2>&1; then
            if ! sudo -n systemctl reload caddy 2>/tmp/manta-caddy-reload.err; then
              warn "systemctl reload caddy failed — see /tmp/manta-caddy-reload.err"
              warn "  (Caddy's daemon may not be running yet; it normally starts after \`apt install caddy\`.)"
              warn "  re-run \`sudo systemctl reload caddy\` after Caddy is up."
            fi
            ok "caddy reloaded."
          else
            warn "systemctl not found — reload caddy manually with: sudo caddy reload --config /etc/caddy/Caddyfile"
          fi
        else
          warn "Caddy vhost write was skipped — skipping port-check + systemctl reload too."
        fi
      fi
    fi
  fi
  fi # close: if [ "$PRIVILEGED_SECTION_SKIP" = "1" ] (step 7.5 wrapper)

  # ---------------------------------------------------------------------------
  # 8. Wait for health, then mint + print a pairing code. Devices connect
  #    DIRECTLY to the box's public hostname (<box_id>.boxes.mantaui.com,
  #    fronted by Caddy) — no relay, no dial-out, no separate handshake to
  #    wait for. The install just confirms the loopback server is healthy
  #    and prints the pair link.
  # ---------------------------------------------------------------------------
  log "Waiting for the server to become healthy at $MANTA_HEALTH_URL…"
  "$NODE" -e '
    import("'"$LIB"'").then(async (m) => {
      const r = await m.waitForHealth(process.env.MANTA_HEALTH_URL, { maxAttempts: 60, intervalMs: 1000 });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.error("healthy after " + r.attempts + " attempt(s)");
    }).catch((e) => { console.error(String(e)); process.exit(1); });
  ' || die "server did not become healthy — check logs:
        systemctl --user status manta-server ; journalctl --user -u manta-server -n 50"

  ok "Server is healthy."

  log "Minting pairing code…"
  # Capture the formatted pairing block; printed at the very end of main().
  PAIR_BLOCK="$("$NODE" "$MANTA_HOME/scripts/manta-pair.mjs" 2>/dev/null || true)"

  cat <<EOF

Installed. Manage the server with:
  systemctl --user status manta-server
  systemctl --user restart manta-server
  journalctl --user -u manta-server -f

Chat backend (opencode-serve) on http://127.0.0.1:4096:
  systemctl --user status opencode-serve
  systemctl --user restart opencode-serve
  journalctl --user -u opencode-serve -f
EOF

  # Trailing-pairing block — direct mode only. The Box ID line and the footer
  # are always printed.
  cat <<EOF

Your box serves its own public hostname — https://<box_id>.boxes.mantaui.com
(Caddy on this box terminates TLS and reverse-proxies 127.0.0.1:8787). The
desktop / mobile app discovers it directly via the box_id below; no relay,
no tunnel, no dial-out.
EOF

  cat <<EOF

Re-run this installer any time to upgrade in place (your box identity is preserved).
Run 'manta pair' (or 'node "$NODE" "$MANTA_HOME/scripts/manta-pair.mjs"') to mint a fresh pairing code.
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

  # The connect block prints LAST so it's what the user sees at rest.
  printf '%s\n' "$PAIR_BLOCK"

  # Cleanup: the previous install lives at $MANTA_HOME.prev until this point.
  # If we got here, everything is healthy and the new install is serving — drop
  # .prev so a future `mv` doesn't trip on a stale tree.
  rm -rf "$MANTA_HOME.prev"
}

main "$@"
