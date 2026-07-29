#!/usr/bin/env bash
# install.sh — one-command self-install for the manta box server.
#
#   curl -fsSL https://mantaui.com/install.sh | bash
#
# On a fresh Linux box: gets manta-server running under systemd --user and
# prints a 6-digit pairing code to enter in the desktop app.
#
# On a fresh macOS box (Apple Silicon, BET-274): gets manta-server running
# in the background and prints a 6-digit pairing code. macOS is loopback +
# Tailscale-only — no Caddy, no public DNS, no Let's Encrypt. The persistent
# service-manager (LaunchAgent) lands in Issue C (BET-277); until then the
# macOS install warns that the background process does NOT survive
# logout/reboot.
#
# Idempotent: re-running upgrades the code in place and PRESERVES ~/.manta/
# (box identity + config) — the script never generates box_id/box_token
# itself; ensureAuth() in src/server/auth.mjs is the single source of truth.
#
# Prerequisites on the box (we check, never install — same `require_cmd` tone
# as Homebrew/rustup):
#   * curl, tar, sha256sum (or `shasum -a 256` on macOS)  — download + verify
#     the release tarball. macOS ships shasum by default but NOT sha256sum
#     (no coreutils out of the box); the installer accepts either, see
#     `_sha256_of` + the prereq check in step 1.
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
#      — a flat key=value manifest carrying BOTH arch pairs (`file_<archkey>`
#      + `sha256_<archkey>` for each). Written per-arch by `npm run pack`,
#      merged into the combined manifest by `scripts/release/merge-manifest.mjs`
#      in the `server-v*` deploy workflow (`.github/workflows/server-tarball-deploy.yml`).
#   2. Parse `file_<arch>` + `sha256_<arch>` where `<arch>` is `linux_x64` or
#      `linux_arm64`, selected from `uname -m` via `resolve_arch` (below).
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
#   MANTA_CHANNEL       build channel — prod|staging|dev (default prod). Drives
#                       the pair-link URL scheme install.sh/`manta pair` print
#                       (BET-386 — see scripts/install-lib.mjs's resolveConfig),
#                       and baked into the manta-server systemd unit / LaunchAgent
#                       plist as Environment/EnvironmentVariables so the box's
#                       own long-lived process resolves the right pair-link URL
#                       scheme (resolveBoxChannel() in src/server/pairPage.mjs,
#                       BET-373/BET-392). Baked into the `manta` CLI shim at
#                       install time so later `manta pair` re-runs agree. Not
#                       persisted anywhere.
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
# verify_sha256 / resolve_arch without the install body running.
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

# Map (uname -s, uname -m) to the release manifest arch key. Sets global
# ARCH_KEY. Dies on any (OS, arch) we don't ship a tarball for. This is the
# SINGLE place the installer decides which OS+arch it is — see BET-274.
resolve_arch() {
  local s m; s="$(uname -s)"; m="$(uname -m)"
  case "$s" in
    Linux)
      case "$m" in
        x86_64)         ARCH_KEY="linux_x64" ;;
        aarch64|arm64)  ARCH_KEY="linux_arm64" ;;
        *) die "unsupported architecture: $m on Linux (this installer ships linux x86_64 and arm64)" ;;
      esac
      ;;
    Darwin)
      case "$m" in
        arm64)  ARCH_KEY="darwin_arm64" ;;
        *) die "unsupported Mac: $m — the MantaUI box installer supports Apple Silicon (arm64) Macs only.
      Intel Macs are not supported as a box. If you just want to USE MantaUI on this Mac,
      install the desktop app instead: https://mantaui.com/downloads/Manta-latest.dmg" ;;
      esac
      ;;
    *) die "unsupported OS: $s (the MantaUI box installer supports Linux and macOS/Apple Silicon)" ;;
  esac
}

# launchd_agent_path — the PATH a MantaUI supervisor-managed service must
# run with. Used by:
#   * BOTH LaunchAgent plists (`scripts/launchd/com.mantaui.{opencode,server}.plist`)
#     via @@AGENT_PATH@@ substitution,
#   * BOTH systemd --user units (`scripts/systemd/{opencode-serve,manta-server}.service`)
#     via @@AGENT_PATH@@ substitution (systemd's Environment=PATH=).
#
# launchd does NOT give an agent the user's login-shell PATH; it hands out a
# bare `/usr/bin:/bin:/usr/sbin:/sbin`. Every tool the box actually depends on
# that a Mac gets from Homebrew (tmux above all — macOS ships no tmux) is
# therefore invisible to manta-server and opencode even though the very same
# command works in Terminal. The failure is silent and confusing: the box
# installs, pairs, and answers HTTP, but `tmux:new-session` 500s with ENOENT
# and `listProjects` swallows its error and reports an empty box.
#
# systemd --user services have the SAME trap (a minimal default PATH that
# excludes Homebrew / user-local dirs) — the BET-353 fix unifies the two
# supervisors onto one PATH so a tool either works under both or fails under
# both. Same class of fix as the macOS PATH handling in the desktop plugin
# executor (see AGENTS.md, "macOS PATH gotcha").
#
# Composition (precedence left-to-right; first match wins at exec time):
#   1. $HOME/.local/bin  — where the official `claude` CLI installer places
#                          its symlink (`~/.local/bin/claude`). Without this,
#                          the credential-refresh machinery in
#                          src/server/opencode.mjs (doRefresh → cpSpawn
#                          "claude") ENOENTs and Claude auth silently rots.
#                          Same resolver as opencode.mjs's resolveClaudeBin.
#                          Dedup'd against the existing base (a Homebrew-
#                          installed claude that also lives in /usr/local/bin
#                          must not appear twice).
#   2. the directory `tmux` was actually resolved from when it lives
#      somewhere else entirely (MacPorts, /usr/local/opt, a hand-built
#      binary) — the prereq check already proved that copy exists.
#   3. Homebrew prefixes (Apple Silicon + Intel) + standard system dirs.
launchd_agent_path() {
  local base="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local tmux_bin tmux_dir
  tmux_bin="$(command -v tmux 2>/dev/null || true)"
  if [ -n "$tmux_bin" ]; then
    tmux_dir="$(dirname "$tmux_bin")"
    case ":$base:" in
      *":$tmux_dir:"*) ;;
      *) base="$tmux_dir:$base" ;;
    esac
  fi
  case ":$base:" in
    *":$HOME/.local/bin:"*) ;;
    *) base="$HOME/.local/bin:$base" ;;
  esac
  printf '%s' "$base"
}

# _sha256_of echoes the sha256 hex of $1. Prefers GNU sha256sum (Linux ships
# it via coreutils); falls back to BSD `shasum -a 256` on macOS, which ships
# shasum by default but NOT sha256sum. Single shared helper so the prereq
# check (step 1) and verify_sha256 can't drift — the BET-278 review concern.
_sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Verify $1's sha256 equals $2 (64-hex). Dies on mismatch.
verify_sha256() {
  local actual; actual="$(_sha256_of "$1")"
  [ "$actual" = "$2" ] || die "checksum mismatch for $1
      expected: $2
      actual:   $actual
      (corrupt download or stale manifest — re-run; if it persists, report it)"
}

# print_provider_detection_summary <lib-path> <node-path> <home-path> [is_macos]
# Probe opencode's `connected[]` + the local Claude credentials file + the
# claude/codex/kimi CLIs on PATH, then print the per-provider detection
# block at the tail of a successful install (BET-313).
#
# Warns (never dies) for each missing provider; only prints the "chat will
# start but reject requests" guidance when ZERO providers are connected.
# Also probes the claude / codex / kimi CLIs on PATH so the user can see
# why a launcher slot in MantaUI's session-mode dropdown is or is not
# offered. The restart hint (systemctl vs launchctl) inside the guidance
# block follows IS_MACOS.
#
# Extracted as a top-level function (defined alongside the other testable
# helpers) so unit tests in scripts/install.test.mjs can call it via
# runBootstrap — both the runMain flag-parser and the install body itself
# go through this one entry point, so the tests pin the actual install
# behavior rather than a replicated copy of it.
print_provider_detection_summary() {
  local lib="$1" node_bin="$2" home_path="$3" macos="${4:-0}"

  log "Checking provider connections…"

  # Probe opencode for connected[]. Pure: fetchConnectedProviders returns
  # [] on any failure (network error, opencode down, malformed response,
  # non-2xx status). install.sh treats absence as "not detected" — the
  # formatProviderDetection fallback for Claude then checks the local
  # cred file. We pipe the newline-separated ids to format-provider-
  # detection; the subcommand also accepts a JSON array via stdin.
  local connected_ids
  connected_ids="$("$node_bin" -e '
    import("'"$lib"'").then(async (m) => {
      const ids = await m.fetchConnectedProviders();
      process.stdout.write(ids.join("\n"));
    }).catch(() => process.stdout.write(""));
  ' 2>/dev/null || true)"

  # Probe local credential files. Only Claude has one — opencode's native
  # Codex/Kimi auth lives inside opencode's auth store, not on the shell.
  local has_claude_creds=0
  [ -f "$home_path/.claude/.credentials.json" ] && has_claude_creds=1

  # Probe CLIs via command -v through the same shell — never install any.
  local cli_claude=0 cli_codex=0 cli_kimi=0
  command -v claude >/dev/null 2>&1 && cli_claude=1
  command -v codex  >/dev/null 2>&1 && cli_codex=1
  command -v kimi   >/dev/null 2>&1 && cli_kimi=1

  local detection_json
  detection_json="$(printf '%s\n' "$connected_ids" | "$node_bin" "$lib" format-provider-detection \
    --has-claude-creds "$has_claude_creds" \
    --cli-claude "$cli_claude" \
    --cli-codex  "$cli_codex"  \
    --cli-kimi   "$cli_kimi" 2>/tmp/manta-detect.err)" \
    || detection_json=""

  if [ -z "$detection_json" ]; then
    # format-provider-detection failed unexpectedly (would only happen if
    # the lib crashed). Don't die — emit a single generic warn so the
    # user still sees SOMETHING, and move on. install.sh never blocks on
    # detection (BET-313: a missing provider is not an installation
    # failure).
    warn "could not build provider detection summary (see /tmp/manta-detect.err) — assuming no providers connected."
    warn "Connect any provider from the MantaUI app."
    # BET-354: the app now connects Claude end-to-end (spawns `claude auth
    # login` over the pty bus, feeds the OAuth callback code back, restarts
    # opencode, verifies `anthropic` in connected[]). The "run claude by
    # hand" fallback is no longer the primary path; it's a safety net for
    # when the app is genuinely unreachable. The same caveat applies to
    # Codex/Kimi but those already had opencode-native OAuth, so only the
    # Claude-specific copy changes.
    warn "Fallback (if the app is unavailable): connect providers from inside opencode (Claude: 'claude auth login'; Codex: '/auth' command)."
    return 0
  fi

  # Print each row. Three provider rows (status-driven ok/warn) + one CLI
  # row with three slots (status-driven ✓ detected / ○ not found).
  local show_guidance
  show_guidance="$(printf '%s' "$detection_json" | "$node_bin" -e '
    let s = ""; process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(s).showGuidance ? "1" : "0"); }
      catch { process.stdout.write("0"); }
    });
  ' 2>/dev/null || echo 1)"

  "$node_bin" -e '
    let s = ""; process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(s); } catch { process.exit(2); }
      for (const r of parsed.rows) {
        if (r.kind === "provider") {
          process.stdout.write("ROW\t" + r.status + "\t" + r.label + "\t" + r.suffix + "\n");
        } else if (r.kind === "cli") {
          for (const slot of r.slots) {
            process.stdout.write("CLI\t" + slot.id + "\t" + (slot.detected ? "1" : "0") + "\n");
          }
        }
      }
    });
  ' <<<"$detection_json" 2>/dev/null | while IFS=$'\t' read -r kind a b c; do
    case "$kind" in
      ROW)
        if [ "$a" = "ok" ]; then ok "$b $c"
        else warn "$b $c"
        fi
        ;;
      CLI)
        if [ "$b" = "1" ]; then
          ok "$a CLI detected"
        else
          warn "$a CLI not found"
        fi
        ;;
    esac
  done

  if [ "$show_guidance" = "1" ]; then
    warn "no providers connected — chat will start but reject requests until you authenticate."
    warn "Connect any of Claude, Codex, or Kimi from the MantaUI app."
    # BET-354: the app drives Claude's OAuth end-to-end (BET-352 POC +
    # BET-354 wiring), so the "run claude by hand" guidance is now only
    # a fallback for boxes where the app is unreachable. Codex/Kimi
    # already had opencode-native OAuth, so the original copy just lost
    # its Claude-specific invocation.
    warn "Fallback (if the app is unavailable): connect providers from inside opencode (Claude: 'claude auth login'; Codex: '/auth' command)."
  fi
}

# read_box_id <lib-path> <node-path>
# Echo the 32-hex box_id out of $MANTA_AUTH_FILE, or nothing when the file is
# missing / half-written / corrupt. Single source of truth for the inline
# `node -e readBoxIdentity` read — used by step 7.5 (gateway register needs
# box_id) and step 8 (the trailing pairing block prints box_id + pair-link).
# Without this helper the two reads drifted in subtle ways — see install.test's
# strict duplication-gate catching the 6-line clone (BET-205).
#
# Errors go to /dev/null; the empty fallback lets the caller branch (e.g. warn
# + skip on no box_id).
read_box_id() {
  "$2" -e '
    import("'"$1"'").then((m) => {
      const id = m.readBoxIdentity(process.env.MANTA_AUTH_FILE);
      process.stdout.write(id?.box_id ?? "");
    }).catch(() => process.stdout.write(""));
  ' 2>/dev/null || true
}

# wait_for_box_id <lib-path> <node-path> [max-attempts] [interval-seconds]
# Poll read_box_id until the identity shows up. Echoes the box_id (exit 0) or
# nothing (exit 1) once the budget is spent.
#
# WHY THE WAIT (regression guard): the box identity is minted by the SERVER on
# its first start (ensureAuth runs before it binds the port), and step 7 only
# waits for the supervisor to fork the process — not for it to finish booting.
# On a fresh box the identity read therefore RACED the mint and came back
# empty, which cascaded: gateway registration was skipped, and step 7.5.E then
# invoked `render-caddy-vhost` with an empty --box-id, which fails with
#   render-caddy-vhost: --box-id <32hex> required
# so the Caddy vhost was never written. The install still printed a pairing
# code, so the box LOOKED installed while having no public TLS at all — and a
# second run of the installer (by which time the identity existed) silently
# "fixed" it. Polling here is what makes the first run sufficient.
wait_for_box_id() {
  local lib="$1" node_bin="$2" attempts="${3:-60}" interval="${4:-1}"
  local id="" i=1
  while [ "$i" -le "$attempts" ]; do
    id="$(read_box_id "$lib" "$node_bin")"
    if [ -n "$id" ]; then
      if [ "$i" -gt 1 ]; then
        printf 'box identity appeared after %s attempt(s)\n' "$i" >&2
      fi
      printf '%s' "$id"
      return 0
    fi
    if [ "$i" = "1" ] && [ "$attempts" -gt 1 ]; then
      printf 'waiting for the server to mint the box identity…\n' >&2
    fi
    i=$((i + 1))
    if [ "$i" -le "$attempts" ]; then sleep "$interval"; fi
  done
  return 1
}

# Test mode: when sourced by scripts/install.test.mjs with MANTA_INSTALL_TEST_MODE=1,
# only the bash helpers (log/ok/warn/die + manifest_get + _sha256_of +
# verify_sha256 + resolve_arch + launchd_agent_path +
# print_provider_detection_summary + read_box_id / wait_for_box_id) are
# loaded. The actual install does NOT run. Lets the unit tests exercise
# the helpers with mocked `uname`/etc. without hitting the network. See
# scripts/install.test.mjs.
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
  resolve_arch

  # OS gate — set ONCE from `uname -s` so the rest of the install branches
  # on a single flag instead of re-running uname in scattered places. The
  # macOS box path (BET-274 / BET-276) keys off this: loopback + Tailscale
  # only, no apt/Caddy/DNS/vhost. Issue C (BET-277) will add the launchd
  # service path; until then, the macOS nohup fallback gets a temporary
  # warn so a partial merge is never silently broken.
  IS_MACOS=0
  [ "$(uname -s)" = "Darwin" ] && IS_MACOS=1

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

  log "Checking prerequisites (curl, tar, sha256sum|shasum, tmux, git)…"
  require_cmd curl      "apt-get install -y curl   # or your distro's package manager"
  require_cmd tar       "apt-get install -y tar"
  # sha256sum (coreutils, Linux) or shasum (BSD/macOS) — accept either so
  # the macOS box path doesn't need coreutils. _sha256_of picks whichever
  # is available at runtime.
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    die "missing prerequisite: sha256sum or shasum
      Install one and re-run. Suggested:
        apt-get install -y coreutils   # provides sha256sum
        brew install coreutils         # provides sha256sum (macOS)
        # macOS ships 'shasum' by default — no install needed on a stock Mac"
  fi
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
    TARBALL_FILE="$(manifest_get "$manifest" "file_${ARCH_KEY}")"
    TARBALL_SHA="$(manifest_get "$manifest" "sha256_${ARCH_KEY}")"
    if [ -z "$TARBALL_FILE" ] || [ -z "$TARBALL_SHA" ]; then
      die "manifest is malformed or this version has no ${ARCH_KEY} build"
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
  # BET-386/BET-392: resolve + export MANTA_CHANNEL here (same
  # "unset/unrecognised -> prod" fallback resolveBoxChannel() applies) so every
  # downstream node invocation in THIS run sees it, so it's available below when
  # the manta-server systemd unit / LaunchAgent plist get rendered, and so the
  # value is available to bake into the `manta` CLI shim below for later
  # re-runs. Never persisted to disk — channel is a property of the
  # build/install, not box state (BET-370).
  MANTA_CHANNEL="${MANTA_CHANNEL:-prod}"
  export MANTA_CHANNEL

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
    # NOTE: download-then-run is load-bearing, do NOT collapse this back into
    # `curl … | bash`. Two constraints collide:
    #  (a) install.sh is itself run as `curl -fsSL … | bash`, so the OUTER bash
    #      reads THIS script from stdin (the pipe). A child that reads stdin
    #      (a prompt / read / cat) drains the rest of install.sh's bytes and the
    #      outer bash then hits EOF here and exits 0 — no error, the install
    #      silently stops "after opencode install". So the child's stdin must
    #      be /dev/null.
    #  (b) But `curl … | bash </dev/null` DOES NOT WORK: bash reads its SCRIPT
    #      from stdin, and the redirect replaces the pipe with /dev/null — bash
    #      sees an empty script, runs nothing, exits 0, and curl dies writing to
    #      the closed pipe (`curl: (23) Failure writing output to destination`),
    #      which pipefail turns into a spurious "opencode install failed".
    # Writing the installer to a file satisfies both: script from the file,
    # stdin from /dev/null.
    _oc_installer="$WORK/opencode-install.sh"
    curl -fsSL https://opencode.ai/install -o "$_oc_installer" \
      || die "opencode installer download failed — install manually: https://opencode.ai"
    bash "$_oc_installer" </dev/null \
      || die "opencode install failed — install manually: https://opencode.ai"
    rm -f "$_oc_installer"
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

  # --- A2. claude CLI install (idempotent via official installer). ----------
  # opencode's "anthropic" provider is a passthrough that reads
  # ~/.claude/.credentials.json — a file only the `claude` CLI writes. Without
  # the binary, Claude cannot work on a fresh box at all (BET-353). Same
  # shape as the opencode install above: curl-to-file + bash </dev/null +
  # PATH probe + non-fatal-on-failure (a box without Claude must still finish
  # installing, still pair, and still be usable with Codex).
  #
  # The official installer places the binary in $HOME/.local/bin/claude —
  # SAME dir we prepend to launchd_agent_path above so the supervisor-managed
  # services can spawn it for credential refresh
  # (src/server/opencode.mjs doRefresh / refreshClaudeCredentials). Reuses
  # the opencode install's stdin dance because the SAME `curl | bash` pipe-
  # truncation footgun applies (install.sh itself is run as `curl | bash`,
  # so the child's stdin must be /dev/null AND the script must come from a
  # file, not stdin).
  #
  # PLATFORM: macOS arm64 + Linux x64/arm64 — same matrix install.sh ships
  # tarballs for (resolve_arch). The official installer honours that matrix
  # directly.
  if [ "$DRY_RUN" = "1" ]; then
    if command -v claude >/dev/null 2>&1; then
      dry_log "claude CLI already installed ($(command -v claude)) — would skip install step"
    else
      dry_log "would install claude CLI (official installer https://claude.ai/install.sh); idempotent on PATH probe"
    fi
  elif command -v claude >/dev/null 2>&1; then
    ok "claude CLI already installed ($(command -v claude))."
  else
    log "Installing claude CLI (official installer)…"
    _claude_installer="$WORK/claude-install.sh"
    curl -fsSL https://claude.ai/install.sh -o "$_claude_installer" \
      || { warn "claude installer download failed — skipping. Connect Codex/Kimi from the MantaUI app, or install manually: https://claude.ai"; rm -f "$_claude_installer"; }
    if [ -f "$_claude_installer" ]; then
      bash "$_claude_installer" </dev/null \
        || warn "claude install failed — skipping. Connect Codex/Kimi from the MantaUI app, or install manually: https://claude.ai"
      rm -f "$_claude_installer"
      # Mirror the opencode install's PATH recovery: source .bashrc if the
      # installer wrote to it, then probe the well-known install location
      # as a safety net.
      if [ -f "$HOME/.bashrc" ]; then
        set +e
        # shellcheck disable=SC1090
        . "$HOME/.bashrc" 2>/dev/null || true
        set -e
      fi
      if [ -x "$HOME/.local/bin/claude" ]; then
        export PATH="$HOME/.local/bin:$PATH"
      fi
      CLAUDE_BIN="$(command -v claude || true)"
      if [ -n "$CLAUDE_BIN" ]; then
        ok "claude CLI installed ($("$CLAUDE_BIN" --version 2>/dev/null | head -n1 || echo "$CLAUDE_BIN"))."
      else
        warn "claude installer ran but the binary is not on PATH — non-fatal: Claude auth will be unavailable until you install it manually (https://claude.ai). Connect Codex/Kimi from the MantaUI app in the meantime."
      fi
    fi
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
    log "Copying manta-native opencode tools into ${OPENCODE_TOOLS_DIR}…"
    # cp -f overwrites — tools are versioned with the tarball, so a re-run
    # naturally picks up upgrades. EXCLUDE *.test.ts: opencode loads EVERY file
    # in tools/ as a tool, and a test file imports vitest (absent under
    # ~/.config/opencode/node_modules), which makes tool resolution throw and
    # every chat turn fail with "Cannot find package 'vitest'". Copy only real
    # tool sources.
    copied_any=0
    for _tool in "$OPENCODE_TOOLS_SRC"/*.ts; do
      case "$_tool" in
        *.test.ts) continue ;;
      esac
      [ -e "$_tool" ] || continue
      cp -f "$_tool" "$OPENCODE_TOOLS_DIR/" \
        || die "failed to copy opencode tool $_tool"
      copied_any=1
    done
    [ "$copied_any" = "1" ] || warn "no opencode tool .ts files found in $OPENCODE_TOOLS_SRC"
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
      log "Appending manta opencode agent guidance to ${OPENCODE_AGENTS}…"
      {
        [ -f "$OPENCODE_AGENTS" ] && cat "$OPENCODE_AGENTS" && printf '\n'
        cat "$OPENCODE_TOOLS_SRC/AGENTS.md"
      } > "$OPENCODE_AGENTS.tmp" && mv "$OPENCODE_AGENTS.tmp" "$OPENCODE_AGENTS"
      ok "opencode AGENTS.md updated."
    fi
  fi

  # install_launchd_agent <label> <template-src> <dest-plist> — render the
  # @@…@@ placeholders and (re)load the LaunchAgent idempotently. macOS only.
  # Mirrors the systemd `daemon-reload + enable --now` shape:
  #   * bootout (ignore failure if not loaded) → bootstrap → kickstart.
  #   * Older macOS where `bootstrap` isn't available falls back to
  #     `launchctl load -w` (deprecated but still works).
  #   * kickstart -k forces a restart so a re-run picks up the new plist
  #     immediately, mirroring `systemctl restart`.
  # Caller MUST have already created the dest-plist's parent dir (mkdir -p).
  install_launchd_agent() {
    local label="$1" src="$2" dest="$3"
    [ -f "$src" ] || die "missing launchd template: $src"
    sed \
      -e "s|@@MANTA_HOME@@|$MANTA_HOME|g" \
      -e "s|@@NODE_BIN@@|$NODE|g" \
      -e "s|@@MANTA_PORT@@|$MANTA_PORT|g" \
      -e "s|@@MANTA_TAILNET_HOST@@|${TAILNET_IP:-}|g" \
      -e "s|@@OPENCODE_BIN@@|${OPENCODE_BIN:-}|g" \
      -e "s|@@AUTH_DIR@@|$AUTH_DIR|g" \
      -e "s|@@AGENT_PATH@@|$(launchd_agent_path)|g" \
      -e "s|@@MANTA_CHANNEL@@|${MANTA_CHANNEL:-prod}|g" \
      "$src" > "$dest"
    local uid; uid="$(id -u)"
    # bootout first (ignore failure if not loaded), then bootstrap for a clean
    # reload that picks up template changes on re-run.
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true

    # `bootout` is ASYNCHRONOUS: launchctl returns as soon as the request is
    # accepted, while launchd is still tearing the job down. Bootstrapping the
    # same label during that window fails with "Input/output error" (5) — and
    # because the original code silenced that failure, the RE-INSTALL path
    # ended with NO agent loaded at all: the box came back with a dead
    # opencode-serve and the install died at the health-wait. Wait for the
    # label to actually disappear (up to ~10s) before bootstrapping, then
    # retry a few times — launchd can still be busy on a slow machine.
    local waited=0
    while [ "$waited" -lt 50 ] && launchctl print "gui/$uid/$label" >/dev/null 2>&1; do
      sleep 0.2
      waited=$((waited + 1))
    done

    local attempt=1 boot_err=""
    while [ "$attempt" -le 5 ]; do
      if boot_err="$(launchctl bootstrap "gui/$uid" "$dest" 2>&1)"; then
        break
      fi
      sleep 1
      attempt=$((attempt + 1))
    done

    # Verify by observation, not by exit code: `bootstrap` can report failure
    # for a job that did load (and vice-versa). Only fall back to the
    # deprecated `load -w` (older macOS, no `bootstrap`) when the label really
    # isn't there, and surface the reason instead of swallowing it.
    if ! launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
      launchctl load -w "$dest" 2>/dev/null || true
      if ! launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
        warn "launchctl could not load $label${boot_err:+ ($boot_err)}"
        warn "  check: launchctl print gui/\$(id -u)/$label"
      fi
    fi
    launchctl kickstart -k "gui/$uid/$label" 2>/dev/null || true
  }

  # supervisor_hint <action> <service> — emit the right supervisor command
  # for the OS we're actually running on (BET-277 acceptance criterion #3:
  # "The installer never prints a `systemctl` command on macOS"). Three
  # failure-path messages (the opencode health-wait die, the gateway-
  # registration warn when box_id is missing, the manta-server health-wait
  # die) used to hardcode `systemctl --user …`; this helper makes them
  # launchctl on macOS and systemctl everywhere else.
  #
  # Usage: echo "hint: $(supervisor_hint status server)"   # → status command
  #        echo "hint: $(supervisor_hint restart opencode)" # → restart command
  # The `gui/$(id -u)` token is intentionally left literal (no command
  # substitution) so the hint prints verbatim — the user runs it on their
  # own box, where $UID will resolve. Same pattern the trailing footer
  # uses for the launchctl commands.
  supervisor_hint() {
    local action="$1" service="$2"
    if [ "$IS_MACOS" = "1" ]; then
      case "$action:$service" in
        status:opencode) echo "launchctl print gui/\$(id -u)/com.mantaui.opencode" ;;
        status:server)   echo "launchctl print gui/\$(id -u)/com.mantaui.server" ;;
        restart:opencode) echo "launchctl kickstart -k gui/\$(id -u)/com.mantaui.opencode" ;;
        restart:server)   echo "launchctl kickstart -k gui/\$(id -u)/com.mantaui.server" ;;
        *) echo "supervisor_hint: unknown action:service $action:$service" >&2; return 2 ;;
      esac
    else
      case "$action:$service" in
        status:opencode) echo "systemctl --user status opencode-serve" ;;
        status:server)   echo "systemctl --user status manta-server" ;;
        restart:opencode) echo "systemctl --user restart opencode-serve" ;;
        restart:server)   echo "systemctl --user restart manta-server" ;;
        *) echo "supervisor_hint: unknown action:service $action:$service" >&2; return 2 ;;
      esac
    fi
  }

  # --- D. opencode-serve: systemd --user (Linux) / launchd (macOS) / nohup (other). ----
  # Three-way branch mirroring the manta-server install path right below.
  # Health-wait reuses the existing waitForHealth lib with acceptAnyStatus:true
  # (any HTTP status = listener is up — opencode's HTTP surface is minimal and
  # may not respond to a bare GET /). Same health-wait works for all three
  # branches — opencode binds 127.0.0.1:4096 regardless of supervisor.
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
        --placeholder OPENCODE_BIN="$OPENCODE_BIN" \
        --placeholder AGENT_PATH="$(launchd_agent_path)")" \
        || die "render-systemd-unit failed (see lib)"
      printf '%s' "$rendered" > "$OC_UNIT"
      systemctl --user daemon-reload
      systemctl --user enable --now opencode-serve.service
    fi
  elif [ "$IS_MACOS" = "1" ]; then
    # macOS path (BET-277): proper LaunchAgent so opencode-serve survives
    # logout/reboot — the previous nohup fallback died on logout. Loaded
    # per-user into the GUI session; RunAtLoad=true + KeepAlive=true handle
    # the lifecycle, no `enable-linger` equivalent needed.
    LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
    OC_PLIST_SRC="$MANTA_HOME/scripts/launchd/com.mantaui.opencode.plist"
    OC_PLIST="$LAUNCH_AGENTS_DIR/com.mantaui.opencode.plist"
    [ -f "$OC_PLIST_SRC" ] || die "missing launchd template: $OC_PLIST_SRC"
    log "Installing opencode-serve LaunchAgent (com.mantaui.opencode)…"
    mkdir -p "$LAUNCH_AGENTS_DIR"
    install_launchd_agent "com.mantaui.opencode" "$OC_PLIST_SRC" "$OC_PLIST"
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
  # sees the intent ("any response = listening"). requestTimeoutMs bounds each
  # probe so a half-open socket (opencode binds :4096 before it can answer on
  # first boot) can't hang the whole wait — see waitForHealth's doc comment.
  log "Waiting for opencode-serve at http://127.0.0.1:4096/…"
  "$NODE" -e '
    import("'"$LIB"'").then(async (m) => {
      const r = await m.waitForHealth("http://127.0.0.1:4096/", {
        maxAttempts: 30,
        intervalMs: 1000,
        requestTimeoutMs: 5000,
        acceptAnyStatus: true,
      });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.error("healthy after " + r.attempts + " attempt(s) (status " + r.status + ")");
    }).catch((e) => { console.error(String(e)); process.exit(1); });
  ' || die "opencode-serve did not become healthy at http://127.0.0.1:4096/ — check logs:
        $(supervisor_hint status opencode)
        or: tail -f $AUTH_DIR/opencode.log"
  ok "opencode-serve is healthy."

  # ---------------------------------------------------------------------------
  # 7. manta-server systemd --user unit: substitute placeholders and enable.
  # ---------------------------------------------------------------------------

  # detect_tailscale_ip — wrapper around `tailscale status --json` piped
  # through the lib's `parse-tailscale-status` subcommand. Returns the
  # detected Tailscale IPv4 on stdout, exit 0 — OR exits 1 with no output
  # when Tailscale is missing / not running / has no IPv4. install.sh uses
  # the exit code to drive the INGRESS_MODE decision (BET-267).
  #
  # HOISTED ABOVE the mode-resolution block (BET-267 review fix): bash does
  # NOT forward-reference function definitions within the same function, so
  # defining this AFTER its call sites (the original placement, near the
  # box-identity read) silently failed with
  # `detect_tailscale_ip: command not found` and the auto branch fell through
  # to public mode even when Tailscale was running. Moving the definition
  # above the call sites is the minimal fix; `bash -n` parses but does not
  # execute, so this only shows up under real (or DRY_RUN=1) tracing.
  #
  # Silent on stderr by design: install.sh logs the result separately so
  # we never want a `tailscale: command not found` warning to leak through
  # the box's user-facing output (the absence of tailscale is normal on
  # the public-path install).
  detect_tailscale_ip() {
    command -v tailscale >/dev/null 2>&1 || return 1
    tailscale status --json 2>/dev/null | "$NODE" "$LIB" parse-tailscale-status
  }

  # --- Ingress mode (BET-267) ----------------------------------------------
  # Resolved BEFORE step 7 so the systemd unit template can be rendered
  # with the correct MANTA_TAILNET_HOST value (empty on public path, the
  # Tailscale IPv4 on the tailnet path). The decision is persisted to
  # ~/.manta/ingress.json as the single source of truth for `manta pair`
  # (which has no access to the install's env vars).
  #
  # MANTA_INGRESS: auto (default — tailnet iff Tailscale is up) | public |
  # tailscale (force tailnet; die if detection fails).
  MANTA_INGRESS="${MANTA_INGRESS:-auto}"
  TAILNET_IP=""
  case "$MANTA_INGRESS" in
    public) ;;
    tailscale)
      TAILNET_IP="$(detect_tailscale_ip)" \
        || die "MANTA_INGRESS=tailscale but Tailscale is not running (need 'tailscale status' BackendState=Running with an IPv4). Start tailscale, or use MANTA_INGRESS=public."
      ;;
    auto)
      TAILNET_IP="$(detect_tailscale_ip 2>/dev/null || true)"
      ;;
    *) die "MANTA_INGRESS must be auto, public, or tailscale (got: $MANTA_INGRESS)" ;;
  esac
  INGRESS_MODE="public"
  if [ -n "$TAILNET_IP" ]; then INGRESS_MODE="tailscale"; fi

  # Persist the decision. write-ingress creates the parent dir if missing
  # and writes 0600 atomically (write <file>.tmp then rename).
  INGRESS_JSON="$AUTH_DIR/ingress.json"
  if [ "$DRY_RUN" = "1" ]; then
    dry_log "would persist ingress decision to $INGRESS_JSON (mode=$INGRESS_MODE${TAILNET_IP:+, tailnetIp=$TAILNET_IP})"
  else
    ING_ARGS=("$NODE" "$LIB" write-ingress --file "$INGRESS_JSON" --mode "$INGRESS_MODE")
    if [ -n "$TAILNET_IP" ]; then
      ING_ARGS+=(--tailnet-ip "$TAILNET_IP" --port "$MANTA_PORT")
    fi
    "${ING_ARGS[@]}" >/dev/null 2>/tmp/manta-ingress.err \
      || warn "write-ingress failed (see /tmp/manta-ingress.err) — \`manta pair\` will fall back to public-default connect block."
  fi

  UNIT_SRC="$MANTA_HOME/scripts/systemd/manta-server.service"
  [ -f "$UNIT_SRC" ] || die "missing systemd template: $UNIT_SRC"

  if command -v systemctl >/dev/null 2>&1; then
    log "Installing systemd --user unit…"
    mkdir -p "$UNIT_DIR"
    sed \
      -e "s|@@MANTA_HOME@@|$MANTA_HOME|g" \
      -e "s|@@NODE_BIN@@|$NODE|g" \
      -e "s|@@MANTA_PORT@@|$MANTA_PORT|g" \
      -e "s|@@MANTA_TAILNET_HOST@@|$TAILNET_IP|g" \
      -e "s|@@AGENT_PATH@@|$(launchd_agent_path)|g" \
      -e "s|@@MANTA_CHANNEL@@|${MANTA_CHANNEL:-prod}|g" \
      "$UNIT_SRC" > "$UNIT_DIR/manta-server.service"

    # Survive logout/reboot without an active session.
    loginctl enable-linger "$USER" >/dev/null 2>&1 \
      || warn "could not enable-linger for $USER — the server may stop on logout. Run: sudo loginctl enable-linger $USER"

    systemctl --user daemon-reload
    systemctl --user enable --now manta-server.service
    ok "manta-server enabled and started (systemctl --user status manta-server)."
    SERVER_MANAGED=systemd
  elif [ "$IS_MACOS" = "1" ]; then
    # macOS path (BET-277): proper LaunchAgent so manta-server survives
    # logout/reboot — the previous nohup fallback died on logout. Loaded
    # per-user into the GUI session; RunAtLoad=true + KeepAlive=true handle
    # the lifecycle, no `enable-linger` equivalent needed.
    LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
    SERVER_PLIST_SRC="$MANTA_HOME/scripts/launchd/com.mantaui.server.plist"
    SERVER_PLIST="$LAUNCH_AGENTS_DIR/com.mantaui.server.plist"
    [ -f "$SERVER_PLIST_SRC" ] || die "missing launchd template: $SERVER_PLIST_SRC"
    log "Installing manta-server LaunchAgent (com.mantaui.server)…"
    mkdir -p "$LAUNCH_AGENTS_DIR"
    install_launchd_agent "com.mantaui.server" "$SERVER_PLIST_SRC" "$SERVER_PLIST"
    SERVER_MANAGED=launchd
  else
    warn "systemctl not found (not a systemd host?). Starting the server in the background instead."
    warn "It will NOT survive reboot — set up your own supervisor for that."
    ( MANTA_MOBILE_HOST=127.0.0.1 MANTA_MOBILE_PORT="$MANTA_PORT" MANTA_TAILNET_HOST="$TAILNET_IP" nohup "$NODE" "$MANTA_HOME/src/server/index.mjs" >"$AUTH_DIR/server.log" 2>&1 & )
    SERVER_MANAGED=nohup
  fi

  # On a fresh config change, the server may need a restart to pick it up.
  if [ "${SERVER_MANAGED:-}" = "systemd" ] && [ "${MANTA_RESTART:-1}" = "1" ]; then
    systemctl --user restart manta-server.service \
      || warn "systemctl --user restart manta-server failed — run it manually"
  elif [ "${SERVER_MANAGED:-}" = "launchd" ] && [ "${MANTA_RESTART:-1}" = "1" ]; then
    launchctl kickstart -k "gui/$(id -u)/com.mantaui.server" 2>/dev/null \
      || warn "launchctl kickstart com.mantaui.server failed — restart manually"
  fi

  # The identity read + its bounded first-boot wait are top-level helpers
  # (read_box_id / wait_for_box_id, defined above main so install.test.mjs
  # can exercise them) — main just calls them.

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

  # Public-TLS predicate — ONE gate, ONE source of truth for the Caddy/apt/
  # DNS/vhost sub-steps (A/D/E/port-check/reload). Merges the macOS case
  # (BET-274 / BET-276) with the existing tailscale case (BET-267): both
  # skip the public TLS path; gateway-register (B/C) still runs in both
  # because it's user-space and the gateway_token is still needed for
  # APNs push. Computed once, used by every guard below.
  SKIP_PUBLIC_TLS=0
  if [ "$INGRESS_MODE" = "tailscale" ] || [ "$IS_MACOS" = "1" ]; then
    SKIP_PUBLIC_TLS=1
  fi

  # Gate the section. In dry-run mode we always show what we would do
  # (the dry_log lines are below). In real mode we bail with a clear
  # bring-your-own-proxy hint when distro isn't Debian/Ubuntu or sudo
  # isn't usable.
  #
  # Tailscale path (BET-267) AND macOS path (BET-276): distro / sudo checks
  # are irrelevant — no sudo is needed at all on either path (the whole
  # point is "skip Caddy + public DNS"). PRIVILEGED_SECTION_SKIP is left
  # at 0 so sub-steps B + C (gateway register + merge-gateway) still run —
  # they are user-space and the gateway_token is still needed for APNs
  # push. A/D/E/port-check/reload are gated on SKIP_PUBLIC_TLS further
  # down.
  PRIVILEGED_SECTION_SKIP=0
  if [ "$DRY_RUN" != "1" ] && [ "$SKIP_PUBLIC_TLS" != "1" ]; then
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
        warn "    echo 'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/ubuntu noble main' | sudo tee /etc/apt/sources.list.d/caddy-stable.list"
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

  if [ "$INGRESS_MODE" = "tailscale" ]; then
    # Tailscale path (BET-267): skip Caddy install + DNS wait + vhost write +
    # port-check + caddy reload. B/C (gateway register + merge-gateway) still
    # run below — the gateway_token is still needed for APNs push.
    log "Tailscale detected ($TAILNET_IP) — skipping Caddy + public DNS; devices connect over the tailnet."
  elif [ "$IS_MACOS" = "1" ]; then
    # macOS path (BET-274 / BET-276): no apt, no Caddy, no public DNS, no
    # Let's Encrypt. The box is loopback-only on the Mac; remote access
    # requires Tailscale (a Mac that's never logged in is unsupported —
    # Issue C will wire that up via LaunchAgents). B/C (gateway register
    # + merge-gateway) still run below for the APNs push token.
    log "macOS detected — skipping Caddy/apt/DNS/vhost; box is loopback-only. Use Tailscale to reach this box off-network."
  elif [ "$PRIVILEGED_SECTION_SKIP" = "1" ]; then
    log "Skipping public-TLS step (bring-your-own-proxy keeps the rest of the install working)."
  else
    log "Configuring public TLS via Caddy + gateway registration (privileged)…"
  fi

  # --- B/C. Register with the gateway + persist gateway_token -------------
  # B (POST /register) and C (merge-gateway into auth.json) are user-space and
  # run in BOTH ingress modes. On tailscale the gateway records an A record
  # that is unused but harmless; the persisted gateway_token is still the
  # APNs push credential (BET-198). Skipped entirely only on distro/sudo
  # failure (PRIVILEGED_SECTION_SKIP=1) where the rest of the section is
  # being skipped.
  if [ "$PRIVILEGED_SECTION_SKIP" = "0" ]; then
    # The server mints the identity asynchronously on its first start, so on a
    # fresh box this read races the mint — poll for up to ~60s rather than
    # taking the first empty answer as final (see wait_for_box_id's comment for
    # the failure this caused). Dry-run never waits: one probe and move on.
    BOX_ID_WAIT_ATTEMPTS=60
    if [ "$DRY_RUN" = "1" ]; then BOX_ID_WAIT_ATTEMPTS=1; fi
    BOX_ID_FOR_GATEWAY="$(wait_for_box_id "$LIB" "$NODE" "$BOX_ID_WAIT_ATTEMPTS" 1 || true)"

    if [ -z "$BOX_ID_FOR_GATEWAY" ]; then
      warn "no box_id in $MANTA_AUTH_FILE after waiting — skipping gateway registration."
      warn "  start the manta-server at least once ($(supervisor_hint restart server)) and re-run."
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
    fi
  fi

  # --- A. Install Caddy if absent ------------------------------------------
  # A, D, E/port-check/reload only run on the public path (BET-267). The
  # tailscale path AND the macOS path (BET-276) never bind :80/:443, never
  # write a Caddy vhost, never wait on DNS, never reload Caddy. Gated via
  # SKIP_PUBLIC_TLS which merges both cases into one predicate.
  if [ "$PRIVILEGED_SECTION_SKIP" = "0" ] && [ "$SKIP_PUBLIC_TLS" != "1" ]; then
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
      # Refresh apt lists first — on a fresh box the package index can be
      # empty/stale, which makes `apt-get install debian-keyring …` fail with
      # "Unable to locate package". The Caddy docs run `apt update` up front
      # for exactly this reason.
      sudo -n apt-get update \
        || die "apt-get update failed"
      sudo -n apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl \
        || die "apt-get install prerequisites for Caddy failed"
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
        | sudo -n gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
        || die "failed to download Caddy GPG key"
      # Write the apt repo line DIRECTLY with a resolved, known-good codename
      # instead of piping Cloudsmith's config.deb.txt. That script probes
      # /etc/os-release and, on a distro its detector doesn't recognize (e.g.
      # Ubuntu's rolling "resolute"), falls back to the generic
      # `deb/any-distro any-version` suite — which Cloudsmith no longer serves,
      # so the next `apt update` 404s and the poisoned .list blocks all apt.
      # We map the running codename to the nearest supported Ubuntu/Debian
      # suite ourselves so an unknown/rolling release still resolves to a live
      # repo. Cloudsmith's Caddy repo is keyed by real distro codenames.
      # Source os-release in a SUBSHELL so it can't leak $ID/$NAME/$VERSION/etc
      # into the rest of main() — we only want the codename out.
      _caddy_codename="$(
        if [ -r /etc/os-release ]; then
          # shellcheck disable=SC1091
          . /etc/os-release
          printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
        fi
      )"
      # Cloudsmith serves these Caddy suites (Ubuntu + Debian codenames).
      # Anything not in this allowlist (or empty) → pin to the current
      # Ubuntu LTS, which is always live.
      case "$_caddy_codename" in
        noble|jammy|focal|bookworm|bullseye|trixie) : ;;   # known-good, use as-is
        *) _caddy_codename="noble" ;;                      # unknown/rolling → LTS fallback
      esac
      # Fetch nothing; render the .list line to a temp path FIRST, then install
      # it atomically. A direct `… | sudo tee /etc/apt/sources.list.d/…` lets
      # tee create a partial file before an error is seen, poisoning the next
      # `apt update`. Staging + install(1) avoids the partial write.
      _caddy_list_tmp="$(mktemp)"
      {
        printf 'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/ubuntu %s main\n' "$_caddy_codename"
        printf 'deb-src [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/ubuntu %s main\n' "$_caddy_codename"
      } > "$_caddy_list_tmp"
      sudo -n install -m 0644 "$_caddy_list_tmp" /etc/apt/sources.list.d/caddy-stable.list \
        || { rm -f "$_caddy_list_tmp"; die "failed to add Caddy apt repo"; }
      rm -f "$_caddy_list_tmp"
      sudo -n apt-get update \
        || die "apt-get update failed"
      sudo -n apt-get install -y caddy \
        || die "apt-get install caddy failed"
      ok "caddy installed ($(caddy version 2>/dev/null || echo unknown))."
    fi
  fi

  # --- D. Poll DNS until <box_id>.boxes.mantaui.com resolves to us -------
  # Public path only (BET-267 + BET-276); the tailnet path AND the macOS
  # path have no DNS wait. Gated via SKIP_PUBLIC_TLS.
  if [ "$PRIVILEGED_SECTION_SKIP" = "0" ] && [ "$SKIP_PUBLIC_TLS" != "1" ]; then
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
      # DNS_TIMED_OUT gates step E below: if the box hostname hasn't
      # propagated yet, writing the Caddy vhost is pointless (Let's Encrypt
      # HTTP-01 would fail cert issuance against an unresolvable name), so we
      # skip it and let the operator re-run once DNS is live.
      DNS_TIMED_OUT=0
      if [ "$DRY_RUN" = "1" ]; then
        dry_log "would poll DNS for $GATEWAY_HOST (expecting $BOX_PUBLIC_IP) for up to 90 seconds"
      else
        # Bounded at ~90s (18 × 5s) rather than 5 min. A fresh gateway
        # registration normally propagates in well under a minute; a longer
        # wait just looks like a hang. On timeout we WARN (never die) so the
        # installer still reaches the pair-code print — the box re-registers
        # + retries DNS on every server restart, and re-running the installer
        # picks up step E cleanly once the name resolves.
        log "Waiting for $GATEWAY_HOST to resolve to $BOX_PUBLIC_IP (up to 90 seconds)…"
        if ! "$NODE" "$LIB" wait-for-dns \
            --hostname "$GATEWAY_HOST" \
            --expected-ip "$BOX_PUBLIC_IP" \
            --max-attempts 18 \
            --interval-ms 5000; then
          warn "$GATEWAY_HOST did not resolve to $BOX_PUBLIC_IP within 90s — skipping the Caddy vhost for now."
          warn "  DNS propagation can lag; the box re-registers on every server restart."
          warn "  Once it resolves, re-run the installer (or: sudo systemctl reload caddy) to finish public TLS."
          warn "  Check: curl -fsS $GATEWAY_BASE/healthz"
          warn "  And:   journalctl --user -u manta-server -n 50 (for the gateway-register lines)"
          DNS_TIMED_OUT=1
        else
          ok "DNS resolved."
        fi
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
      #
      # Seed the flag from the DNS wait: if the box hostname didn't resolve,
      # skip the vhost write entirely (cert issuance would fail against an
      # unresolvable name). DRY_RUN never times out, so this is a no-op there.
      CADDY_E_SKIP="${DNS_TIMED_OUT:-0}"
      # Second seed: no box_id ⇒ nothing to name the vhost after. Without this
      # guard the renderer below was invoked with an empty --box-id and failed
      # ("render-caddy-vhost: --box-id <32hex> required") — noisy in the
      # conf.d path and FATAL in the inline path (a failed command
      # substitution under `set -e` kills the install before the pair code is
      # printed). wait_for_box_id above makes this unreachable in practice;
      # keep it as the belt to that braces.
      if [ "$DRY_RUN" != "1" ] && [ -z "${BOX_ID_FOR_GATEWAY:-}" ]; then
        warn "no box_id available — skipping the Caddy vhost write (nothing to point the hostname at)."
        warn "  re-run the installer once the server has minted an identity ($(supervisor_hint status server))."
        CADDY_E_SKIP=1
      fi
      CADDY_DIR_D="/etc/caddy/Caddyfile.d"
      if [ "$DRY_RUN" = "1" ]; then
        dry_log "would render Caddy vhost (box_id=$BOX_ID_FOR_GATEWAY, port=$MANTA_PORT)"
        dry_log "would write the snippet to $CADDY_DIR_D/manta.caddy"
        dry_log "would run: systemctl reload caddy"
      elif [ "$CADDY_E_SKIP" != "0" ]; then
        # DNS didn't resolve above — skip the vhost write; the reload guard
        # below (CADDY_E_SKIP != 0) will also be skipped. Re-run once DNS is live.
        :
      else
        if [ -d "$CADDY_DIR_D" ]; then
          # Caddyfile.d exists → write the snippet as a separate file.
          # Render to a temp file FIRST, then install(1) it atomically. A
          # direct `render | sudo tee` truncates the destination BEFORE the
          # renderer's exit status is known, so a failed re-run replaces a
          # working vhost with an empty file. Same staging rationale as the
          # apt .list write above.
          _caddy_snippet_tmp="$(mktemp)"
          if ! "$NODE" "$LIB" render-caddy-vhost --box-id "$BOX_ID_FOR_GATEWAY" --port "$MANTA_PORT" --mode snippet \
              > "$_caddy_snippet_tmp" 2>/tmp/manta-caddy-render.err; then
            warn "failed to render the Caddy vhost (see /tmp/manta-caddy-render.err)"
            warn "  the rest of the install will proceed; re-run to write the Caddy vhost."
            CADDY_E_SKIP=1
          elif ! sudo -n install -m 0644 "$_caddy_snippet_tmp" "$CADDY_DIR_D/manta.caddy" 2>/tmp/manta-caddy-tee.err; then
            warn "failed to write $CADDY_DIR_D/manta.caddy (sudo install failed — see /tmp/manta-caddy-tee.err)"
            warn "  the rest of the install will proceed; re-run after fixing sudo to write the Caddy vhost."
            CADDY_E_SKIP=1
          fi
          rm -f "$_caddy_snippet_tmp"
        else
          # conf.d missing → append a marker-bracketed block to the main
          # Caddyfile. A re-run overwrites the same block (between the
          # markers), so we never accumulate duplicate vhosts.
          # `|| true` + the empty check below: a bare command substitution that
          # fails would abort the whole install under `set -e`, before the pair
          # code is ever printed. A Caddyfile we couldn't render is a warn, not
          # a fatal.
          SNIPPET="$("$NODE" "$LIB" render-caddy-vhost --box-id "$BOX_ID_FOR_GATEWAY" --port "$MANTA_PORT" --mode inline 2>/tmp/manta-caddy-render.err || true)"
          CADDYFILE="/etc/caddy/Caddyfile"
          if [ -z "$SNIPPET" ]; then
            warn "failed to render the Caddy vhost (see /tmp/manta-caddy-render.err)"
            warn "  the rest of the install will proceed; re-run to write the Caddy vhost."
            CADDY_E_SKIP=1
          elif [ -f "$CADDYFILE" ]; then
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

  # ---------------------------------------------------------------------------
  # 8. Wait for health, then mint + print a pairing code. Devices connect
  #    DIRECTLY to the box's public hostname (<box_id>.boxes.mantaui.com,
  #    fronted by Caddy) — no relay, no dial-out, no separate handshake to
  #    wait for. The install just confirms the loopback server is healthy
  #    and prints the pair link.
  # ---------------------------------------------------------------------------
  log "Waiting for the server to become healthy at ${MANTA_HEALTH_URL}…"
  "$NODE" -e '
    import("'"$LIB"'").then(async (m) => {
      const r = await m.waitForHealth(process.env.MANTA_HEALTH_URL, { maxAttempts: 60, intervalMs: 1000 });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.error("healthy after " + r.attempts + " attempt(s)");
    }).catch((e) => { console.error(String(e)); process.exit(1); });
  ' || die "server did not become healthy — check logs:
        $(supervisor_hint status server)"

  ok "Server is healthy."

  # Drop a `manta` CLI shim so `manta pair` works (the pairing block + docs tell
  # the user to run `manta pair`, but nothing put it on PATH — it was only ever
  # runnable as `node .../manta-pair.mjs` or `npm run pair`). ~/.local/bin is on
  # PATH by default on modern Debian/Ubuntu (~/.profile adds it); if it isn't,
  # the footer below still prints the explicit node invocation as a fallback.
  MANTA_BIN_DIR="$HOME/.local/bin"
  MANTA_SHIM="$MANTA_BIN_DIR/manta"
  mkdir -p "$MANTA_BIN_DIR"
  cat > "$MANTA_SHIM" <<SHIM
#!/usr/bin/env bash
# manta — thin CLI shim dropped by install.sh. Today it only knows 'pair'.
set -euo pipefail
MANTA_HOME="$MANTA_HOME"
NODE="$NODE"
# BET-386 (review cycle 2): bake the install-time channel in the same way
# MANTA_HOME/NODE above are baked — a fresh shell running \`manta pair\`
# months later has no other way to learn the channel (resolveConfig()
# deliberately never persists it to disk). Exported so manta-pair.mjs's
# child process (which reads process.env.MANTA_CHANNEL via resolveConfig())
# actually sees it, not just this shim's own shell.
MANTA_CHANNEL="$MANTA_CHANNEL"
export MANTA_CHANNEL
case "\${1:-}" in
  pair) exec "\$NODE" "\$MANTA_HOME/scripts/manta-pair.mjs" ;;
  ""|-h|--help|help)
    echo "usage: manta pair   # mint a fresh pairing code"; exit 0 ;;
  *) echo "manta: unknown command '\$1' (try: manta pair)" >&2; exit 1 ;;
esac
SHIM
  chmod +x "$MANTA_SHIM"
  ok "Installed \`manta\` CLI shim at $MANTA_SHIM (run: manta pair)."

  log "Minting pairing code…"
  # Capture the formatted pairing block; printed at the very end of main().
  PAIR_BLOCK="$("$NODE" "$MANTA_HOME/scripts/manta-pair.mjs" 2>/dev/null || true)"

  if [ "$IS_MACOS" = "1" ]; then
    # macOS path (BET-277): LaunchAgent management commands, not systemctl.
    # `launchctl print` introspects a loaded agent; `launchctl kickstart -k`
    # restarts it (the -k kills if already running). Logs go to the
    # StandardOutPath/StandardErrorPath the plist declares
    # ($AUTH_DIR/server.log + $AUTH_DIR/opencode.log).
    cat <<EOF

Installed. Manage the server with:
  launchctl print gui/\$(id -u)/com.mantaui.server
  launchctl kickstart -k gui/\$(id -u)/com.mantaui.server
  tail -f $AUTH_DIR/server.log

Chat backend (opencode-serve) on http://127.0.0.1:4096:
  launchctl print gui/\$(id -u)/com.mantaui.opencode
  launchctl kickstart -k gui/\$(id -u)/com.mantaui.opencode
  tail -f $AUTH_DIR/opencode.log

Note: LaunchAgents load at GUI login and survive reboot as long as the
user is logged in. A headless-never-logs-in Mac would need a LaunchDaemon
(requires root) — out of scope.
EOF
  else
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
  fi

  # Trailing-pairing block — direct mode only. The Box ID line and the footer
  # are always printed. The "how does this box reach the internet" line varies
  # by ingress mode (BET-267): on the public path Caddy terminates TLS at
  # https://<box_id>.boxes.mantaui.com; on the tailscale path the server binds
  # a second listener on the Tailscale interface at http://<tailscale-ip>:<port>
  # (plain HTTP — WireGuard encrypts the hop), and no public DNS / Caddy is
  # involved.
  if [ "$INGRESS_MODE" = "tailscale" ]; then
    cat <<EOF

Tailscale detected ($TAILNET_IP) — your box is reachable over the tailnet at
http://$TAILNET_IP:$MANTA_PORT (plain HTTP; WireGuard encrypts the hop). No public
DNS, no Caddy, no Let's Encrypt on this path. Devices on the same tailnet can
connect directly; off-tailnet devices need Tailscale access first.
EOF
  else
    cat <<EOF

Your box serves its own public hostname — https://<box_id>.boxes.mantaui.com
(Caddy on this box terminates TLS and reverse-proxies 127.0.0.1:8787). The
desktop / mobile app discovers it directly via the box_id below; no relay,
no tunnel, no dial-out.
EOF
  fi

  cat <<EOF

Re-run this installer any time to upgrade in place (your box identity is preserved).
Run 'manta pair' to mint a fresh pairing code (if 'manta' isn't found, open a new
shell so ~/.local/bin is on PATH, or run: "$NODE" "$MANTA_HOME/scripts/manta-pair.mjs").
EOF

  # --- Final per-provider detection summary (BET-313). --------------------
  # Replaces the prior single-Claude credentials check. Warns (never dies)
  # for each missing provider; only prints the "chat will start but reject
  # requests" guidance when ZERO providers are connected. Also probes the
  # claude / codex / kimi CLIs on PATH so the user can see why a launcher
  # slot in MantaUI's session-mode dropdown is or is not offered.
  #
  # The helper is defined alongside the other testable helpers at the top
  # of install.sh (so unit tests in scripts/install.test.mjs can call it
  # via runBootstrap). The install body stays a thin orchestrator.
  print_provider_detection_summary "$LIB" "$NODE" "$HOME" "$IS_MACOS"

  # The connect block prints LAST so it's what the user sees at rest.
  printf '%s\n' "$PAIR_BLOCK"

  # Cleanup: the previous install lives at $MANTA_HOME.prev until this point.
  # If we got here, everything is healthy and the new install is serving — drop
  # .prev so a future `mv` doesn't trip on a stale tree.
  rm -rf "$MANTA_HOME.prev"
}

main "$@"
