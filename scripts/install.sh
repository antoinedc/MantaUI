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
# binding already compiled) ships in the tarball. The installer never uses
# sudo, never invokes a package manager, never compiles anything on the box.
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
#   MANTA_HOME          where code is unpacked (default ~/manta)
#   MANTA_MOBILE_PORT   server port (default 8787)
#   MANTA_VERSION       version to fetch when MANTA_TARBALL_URL is unset (default: latest)
#
# The pure logic (URL/home resolution, health-wait, pairing format, idempotency)
# lives in scripts/install-lib.mjs and is unit-tested (scripts/install.test.mjs).
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
  # process.env (waitForHealth / waitForRelay).
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
  # 6. Chat stack provisioning (opencode + bui-native tools + tmux presence).
  #    Independent of the relay work — a fresh VPS just needs claude code
  #    installed (~/.claude/.credentials.json exists). Re-running is a no-op
  #    except for version upgrades; every step is safe to run twice.
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

  # ---------------------------------------------------------------------------
  # 8. Wait for health, then verify the relay handshake, then mint + print a
  #    pairing code. Devices pair THROUGH the relay (relay.mantaui.com) — the
  #    install must confirm the box agent actually reached the relay before
  #    handing the pairing code back. If the handshake never completes we warn
  #    (the box still works locally) and continue — operators can read the
  #    journalctl hint and diagnose later.
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

  # Derive the loopback base (drop the /auth/status path) — waitForRelay takes a
  # base URL and appends /relay/status itself.
  MANTA_RELAY_BASE="$(printf '%s\n' "$MANTA_HEALTH_URL" | sed 's#/auth/status$##')"
  log "Waiting for the relay handshake at $MANTA_RELAY_BASE/relay/status…"
  # waitForRelay is best-effort — relay outage never fails the install. We log
  # the state on stderr and emit exactly one of "connected|disabled|degraded" on
  # stdout so the bash below can branch on it without re-fetching.
  RELAY_CHECK="$(MANTA_RELAY_BASE="$MANTA_RELAY_BASE" "$NODE" -e '
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
  PAIR_BLOCK="$("$NODE" "$MANTA_HOME/scripts/manta-pair.mjs" 2>/dev/null || true)"
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
  BOX_ID_DISPLAY="$("$NODE" -e '
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

  # Cleanup: the previous install lives at $MANTA_HOME.prev until this point.
  # If we got here, everything is healthy and the new install is serving — drop
  # .prev so a future `mv` doesn't trip on a stale tree.
  rm -rf "$MANTA_HOME.prev"
}

main "$@"
