#!/usr/bin/env bash
# install.sh — one-command self-install for the manta box server.
#
#   curl -fsSL https://mantaui.com/install.sh | bash
#
# Staging channel (QA/internal only — see docs/releasing.md "Staging install"
# and the channel table in src/shared/channel.mjs, BET-370):
#
#   curl -fsSL https://mantaui.com/staging/install.sh | MANTA_CHANNEL=staging bash
#
# install.sh is one file in the repo, served byte-identical across channels
# (no build-time substitution): prod's copy is synced to
# /var/www/mantaui/install.sh by scripts/release/publish.sh; staging's copy
# is synced to /var/www/mantaui/staging/install.sh by the website-deploy.yml
# workflow (channel=staging). So the URL alone signals "staging" to a human
# but the script itself has no way to know that once piped into bash. You MUST export MANTA_CHANNEL=staging too: without it the
# script defaults to prod (MANTA_CHANNEL=${MANTA_CHANNEL:-prod} below),
# points at the prod release host, and prints a manta:// (not
# manta-staging://) pair link at the end. The desktop app's SSH orchestrator
# and any operator who manually exports MANTA_CHANNEL are the two callers
# that already set this correctly (BET-386).
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
# + distro package manager for this step).
#
# ALL-OR-NOTHING (BET-980/979): the public path is gated up front (step 3.5)
# on (a) a Debian/Ubuntu-family distro and (b) the ability to run commands
# as root. "Run as root" is resolved ONCE into one of five strategies before
# the first mutation:
#   1. root      — already uid 0 (privileged commands run bare)
#   2. askpass   — a sudo password was staged at ~/.manta-sudo-pass (a
#                  separate, short ssh call; install.sh builds the SUDO_ASKPASS
#                  helper that echoes it for `sudo -A`)
#   3. nopasswd  — passwordless sudo (sudo succeeds non-interactively)
#   4. tty       — an interactive terminal (human `curl … | bash`); sudo
#                  reads the password from /dev/tty
#   5. none      — cannot run as root → the public install refuses to start
# If the public path needs root and none of 1-4 apply, the installer dies
# BEFORE the first mutation — nothing is written, nothing to roll back.
# There is no degraded success: every privileged call goes through `sudo_priv`,
# which dispatches on the resolved strategy. The tailscale and macOS paths
# never need root or a specific distro and are unaffected.
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
#   MANTA_HOME          where code is unpacked
#                       (default ${XDG_DATA_HOME:-$HOME/.local/share}/manta; a legacy
#                       install still present at ~/manta is preserved on upgrade)
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

# Install a staged temp file as a root-owned, world-readable config file.
#
# ALWAYS use this instead of `mv` or `tee` for files a system service must
# read. `mv` preserves the SOURCE file's mode + owner, and mktemp(1) creates
# 0600 files owned by the invoking user — that is exactly what made
# /etc/caddy/Caddyfile unreadable to the `caddy` service user and silently
# broke TLS on every re-install. install(1) sets the destination mode and
# owner explicitly, so the result never depends on the temp file.
#
#   $1 = staged source path   $2 = destination path
install_root_file() {
  sudo_priv install -m 0644 -o root -g root "$1" "$2"
}

# ---------------------------------------------------------------------------
# Sudo strategy resolution (BET-979) — THE rule for every privileged call.
#
# All privileged commands in this script go through `sudo_priv`, which
# dispatches on the single resolved `SUDO_STRATEGY`. The strategy is resolved
# EXACTLY ONCE, inside the 3.5 capability preflight (step 3.5, BEFORE the
# first mutation), so a box that cannot satisfy the public path's root
# requirement is refused while nothing has been written — see
# public_ingress_preflight. Defined here (the always-defined region) so
# install.test.mjs can exercise resolution + dispatch via runBootstrap.
#
# The five strategies (the D2 table):
#   1. root       — uid 0: run privileged commands bare
#   2. askpass    — a sudo password was staged at ~/.manta-sudo-pass by the
#                   desktop installer; sudo fetches it via SUDO_ASKPASS + -A
#   3. nopasswd   — passwordless sudo (sudo succeeds non-interactively)
#   4. tty        — a HUMAN's interactive terminal (curl … | bash): sudo
#                   reads the password from /dev/tty. NEVER used by the
#                   desktop, which sets MANTA_NONINTERACTIVE=1.
#   5. none       — cannot run as root → the public path refuses to start
# ---------------------------------------------------------------------------
resolve_sudo_strategy() {
  if [ "$(id -u)" = "0" ]; then
    SUDO_STRATEGY="root"
  elif [ -f "$HOME/.manta-sudo-pass" ]; then
    SUDO_STRATEGY="askpass"
  elif sudo -n true 2>/dev/null; then
    SUDO_STRATEGY="nopasswd"
  elif [ "${MANTA_NONINTERACTIVE:-0}" != "1" ] \
      && command -v sudo >/dev/null 2>&1 \
      && { [ -t 0 ] || [ -t 1 ]; }; then
    SUDO_STRATEGY="tty"
  else
    SUDO_STRATEGY="none"
  fi
}

# sudo_priv — run one privileged command using the resolved strategy. The
# ONLY place in the script that invokes sudo (nopasswd / askpass / tty) or
# runs the command bare (root). `sudo -A` (NOT bare `sudo`) is load-bearing
# for askpass: the install stream forces a remote pty (-tt), so plain sudo
# would prefer the tty prompt and hang; `-A` forces the SUDO_ASKPASS path.
# Strategy `none` is unreachable on the public path (the preflight dies
# first) but kept as a hard guard.
sudo_priv() {
  case "$SUDO_STRATEGY" in
    root)     "$@" ;;
    askpass)  sudo -A "$@" ;;
    nopasswd) sudo -n "$@" ;;
    tty)      sudo "$@" ;;
    none)
      die "Cannot run commands as root on this server — giving it a public HTTPS address is impossible without root.
        Choose one of these and run the installer again:
        * Install as root  — ssh root@$(hostname) then run the same install command
        * Use Tailscale    — curl -fsSL https://tailscale.com/install.sh | sh; sudo tailscale up; then run the installer again
        * Grant this user sudo access on the server, then run the installer again."
      ;;
  esac
}

# apt_priv <apt-get args…> — the ONE way this installer runs apt.
#
# apt on a stock Ubuntu box ASKS QUESTIONS, and the desktop installer runs
# this script over `ssh -tt` (a real pty) with the child's stdin set to
# `ignore`. So apt sees a terminal, decides it may prompt, and the prompt is
# unanswerable by construction: the install blocks FOREVER inside the
# "Starting the service" stage while the UI's elapsed timer keeps ticking, so
# it reads as alive. Every retry reproduces it — this is a property of the
# server's distro, not a transient. Reported from the field on Ubuntu 22.04.
#
# Three env knobs close every interactive door. They must be passed PER CALL
# via `env`, NOT exported: sudo resets the environment (env_reset), so an
# exported value never survives into the privileged child. Prefixing with
# `env` works in all four sudo_priv strategies, including the bare-root one
# where no sudo is involved at all.
#
#   DEBIAN_FRONTEND=noninteractive
#       No debconf dialogs, no conffile "what do you want to do about the
#       modified configuration file?" prompt.
#   NEEDRESTART_MODE=a
#       needrestart ships enabled AND interactive by default since Ubuntu
#       22.04, hooked into apt via /etc/apt/apt.conf.d/99needrestart. Left
#       alone it draws the full-screen "Daemons using outdated libraries /
#       Which services should be restarted?" screen. `a` makes it restart
#       services itself, silently. THIS is the one that hung a real install.
#   -o DPkg::Lock::Timeout=600
#       A freshly provisioned VM runs unattended-upgrades on first boot and
#       holds the dpkg lock. With no timeout apt waits forever (same
#       symptom, different cause); with one it waits up to 10 minutes and
#       then FAILS, which the callers below report as a real error. Unknown
#       `-o` keys are ignored by older apt, so this is safe on every distro
#       the preflight admits.
apt_priv() {
  sudo_priv env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
    apt-get -o DPkg::Lock::Timeout=600 "$@"
}

# setup_askpass — strategy 2: create the SUDO_ASKPASS helper that echoes the
# staged password, export it, and arrange cleanup on exit (the temp helper
# dir AND the staged password file are both removed). The desktop installer
# stages the password at ~/.manta-sudo-pass via a SEPARATE short ssh call —
# never through the install stream, so it can never leak into the install
# log; install.sh owns the helper so the quoting stays readable.
setup_askpass() {
  SUDO_ASKPASS_DIR="$(mktemp -d)"
  cat > "$SUDO_ASKPASS_DIR/askpass.sh" <<'ASKPASS'
#!/bin/sh
cat "$HOME/.manta-sudo-pass"
ASKPASS
  chmod 700 "$SUDO_ASKPASS_DIR/askpass.sh"
  export SUDO_ASKPASS="$SUDO_ASKPASS_DIR/askpass.sh"
  trap 'rm -rf "$SUDO_ASKPASS_DIR"; rm -f "$HOME/.manta-sudo-pass"' EXIT
}

# --- Shared release-resolution helpers (BET-640) -----------------------------
# install.sh shares the four release-resolution helpers (manifest_get,
# resolve_arch, _sha256_of, verify_sha256) with scripts/self-update.sh via
# scripts/lib/release.sh so the two update paths never drift. Normally we
# source that lib, deriving install.sh's own directory from ${BASH_SOURCE[0]}
# (dev checkout, installed-box re-run, or the test harness, where the file is
# on disk).
#
# install.sh's PRIMARY mode is `curl -fsSL … | bash`, where there is NO local
# file yet — the tarball that carries scripts/lib/release.sh is downloaded
# MID-install, and a piped script has BASH_SOURCE empty and cannot read a
# sibling file. In that mode we fall back to the inline definitions below.
# Those are the SAME bytes as the lib (keep them in sync) and are the
# standalone piped artifact — self-update.sh has NO copy of its own, it always
# sources the lib. sync_opencode_guidance lives ONLY in the lib and is sourced
# from $MANTA_HOME/scripts/lib/release.sh after the tarball is extracted.
INSTALL_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd)"
if [ -n "$INSTALL_SOURCE_DIR" ] && [ -f "$INSTALL_SOURCE_DIR/lib/release.sh" ]; then
  # shellcheck disable=SC1091
  . "$INSTALL_SOURCE_DIR/lib/release.sh"
else
  # curl | bash / no local lib yet — inline fallback (byte-identical to lib).
  # >>> BEGIN GENERATED — scripts/sync-release-fallback.mjs — do not edit by hand <<<
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
# NOTE: this function is defined here so install.sh (fresh `curl | bash`) and
# self-update.sh (packaged box) resolve arch identically.
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
        *) die "unsupported Mac: $m — the MantaUI server installer supports Apple Silicon (arm64) Macs only.
      Intel Macs are not supported as a server. If you just want to USE MantaUI on this Mac,
      install the desktop app instead: https://mantaui.com/downloads/Manta-latest.dmg" ;;
      esac
      ;;
    *) die "unsupported OS: $s (the MantaUI server installer supports Linux and macOS/Apple Silicon)" ;;
  esac
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

# version_gte <a> <b> — return 0 when dotted-numeric version a >= b.
# Compares component by component, numerically, padding a short side with
# zeros (so 2.2 >= 2.1.9). Non-numeric junk in a component reads as 0, which
# keeps a malformed input from ever comparing HIGH and silently winning.
# Deliberately hand-rolled: `sort -V` is a GNU extension this must not depend
# on (the same code runs on macOS boxes).
version_gte() {
  local a="$1" b="$2" i ac bc
  local -a av bv
  IFS='.' read -r -a av <<< "$a"
  IFS='.' read -r -a bv <<< "$b"
  for ((i = 0; i < 4; i++)); do
    ac="${av[i]:-0}"; bc="${bv[i]:-0}"
    case "$ac" in *[!0-9]*|"") ac=0 ;; esac
    case "$bc" in *[!0-9]*|"") bc=0 ;; esac
    if [ "$ac" -gt "$bc" ]; then return 0; fi
    if [ "$ac" -lt "$bc" ]; then return 1; fi
  done
  return 0
}

# claude_cli_version — echo the version of the `claude` CLI on PATH, or empty.
# `claude --version` prints e.g. "2.1.257 (Claude Code)"; take the first token
# and keep it only if it looks like a dotted version. Never fails: a missing
# CLI, a hung binary, or unrecognised output all yield empty, and the caller
# falls back to the floor.
claude_cli_version() {
  local raw first
  command -v claude >/dev/null 2>&1 || return 0
  # Bounded: this runs on the install path, where a wedged binary that never
  # returns would hang the whole install with no output. `timeout` is GNU and a
  # stock macOS has none, so use it only when present — a Mac falls back to the
  # plain call, which is the pre-existing risk and no worse.
  if command -v timeout >/dev/null 2>&1; then
    raw="$(timeout 10 claude --version 2>/dev/null)" || return 0
  else
    raw="$(claude --version 2>/dev/null)" || return 0
  fi
  first="${raw%% *}"
  case "$first" in
    [0-9]*.[0-9]*) printf '%s' "$first" ;;
    *) : ;;
  esac
  return 0
}

# manta_claude_cli_version_floor — echo the fallback claim used when the box has
# no `claude` CLI, or has one older than this. Raise it only when Anthropic's
# floor moves past it AND a box's own CLI can't be relied on to be newer; the
# derivation above is the normal path.
#
# A function rather than a top-level constant on purpose: this file is sourced
# by install.sh and self-update.sh and is documented to define ONLY functions
# and run nothing at source time, so it must not assign into a caller's shell.
# It is also what lets the value ride along in install.sh's inline `curl | bash`
# fallback, which extracts whole functions.
manta_claude_cli_version_floor() {
  printf '%s' "2.1.257"
}

# resolve_anthropic_cli_version — echo the Claude Code version the opencode
# service should claim: the box's own CLI version when it is at least the
# floor, else the floor. Never echoes empty.
resolve_anthropic_cli_version() {
  local detected floor
  floor="$(manta_claude_cli_version_floor)"
  detected="$(claude_cli_version)"
  if [ -n "$detected" ] && version_gte "$detected" "$floor"; then
    printf '%s' "$detected"
  else
    printf '%s' "$floor"
  fi
}
  # >>> END GENERATED — scripts/sync-release-fallback.mjs — do not edit by hand <<<
fi

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
#                          BET-421 §E: install.sh no longer installs the
#                          claude CLI — the app does it lazily on first
#                          Claude sign-in. KEEP this entry anyway: a later
#                          lazy install (by the app) places the binary here,
#                          and both supervisors must be able to find it.
#                          Deleting it "because claude is gone from install"
#                          would break the whole design.
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

# ---------------------------------------------------------------------------
# BET-980 capability preflight: the PUBLIC ingress path is all-or-nothing.
#
# An install either completes its chosen ingress path fully, or it fails —
# there is NO degraded success. A box that prints "Installed." while being
# unreachable is worse than an install that refused to start. The public
# path needs (a) a Debian/Ubuntu-family distro and (b) the ability to run
# commands as root (passwordless sudo, or an actual root shell); without
# both we `die` BEFORE the first mutation, so nothing has been written and
# there is nothing to roll back.
#
# The tailscale and macOS paths never need root or a specific distro, so
# they are never gated here — pass their mode and this returns 0.
#
# Takes the resolved, side-effect-free inputs so the decision + message are
# unit-testable in isolation (via runBootstrap in install.test.mjs):
#   $1  ingress path mode: "public" | "tailscale" | "macos"
#   $2  root usable: "1" (uid 0, or sudo available non-interactively) | "0"
#   $3  distro supported: "yes" | "no" | "unknown" | ""   (from detect-distro)
#   $4  distro id (for the message; may be "")
# Dies (exit 1) only when the mode is "public" and a capability is missing.
# ---------------------------------------------------------------------------
public_ingress_preflight() {
  local mode="$1" root_usable="$2" distro_supported="$3" distro_id="$4"
  [ "$mode" = "public" ] || return 0

  if [ "$distro_supported" != "yes" ]; then
    die "Cannot complete the install: distro ${distro_id:-unknown} is not in the v1 supported list (debian / ubuntu / ID_LIKE=debian).
      This installer only manages Caddy + the gateway registration on Debian/Ubuntu.
      bring your own proxy: point any reverse proxy at 127.0.0.1:8787 and serve your own TLS.

      Nothing has been installed."
  fi

  if [ "$root_usable" != "1" ]; then
    die "Cannot complete the install: giving this server a public HTTPS address needs to run
      three commands as root (install Caddy, write its site config, reload it), and
      this user cannot run commands as root without a password.

      Nothing has been installed. Choose one of these and run the installer again:

        * Install as root
            ssh root@$(hostname)   then run the same install command

        * Use Tailscale — MantaUI then needs no root at all
            curl -fsSL https://tailscale.com/install.sh | sh
            sudo tailscale up
            then run the same install command

        * Grant this user sudo access on the server, then run the installer again."
  fi
}

# ---------------------------------------------------------------------------
# Ingress resolution — ONE source of truth for the tailscale/public decision
# (BET-267). Shared by BOTH the 3.5 capability preflight (which must know
# whether the D1 gate applies) and step 7 (which persists the decision), so
# the two can never disagree about which path the install is on. Defined in
# the always-defined region (before the test-mode guard) so the unit tests can
# exercise the MANTA_INGRESS logic directly.
# ---------------------------------------------------------------------------

# detect_tailscale_ip <node> <lib> — wrapper around `tailscale status --json`
# piped through the lib's `parse-tailscale-status` subcommand. Prints the
# detected Tailscale IPv4 on stdout, exit 0 — or exit 1 with no output when
# Tailscale is missing / not running / has no IPv4. Takes the node + lib
# paths as arguments because it is invoked from both the preflight (which
# reads them out of the temp $WORK/pkg) and step 7 (which uses $MANTA_HOME).
# Silent on stderr by design: the absence of tailscale is normal on the
# public-path install and must not leak a `command not found` warning.
detect_tailscale_ip() {
  local node="$1" lib="$2"
  command -v tailscale >/dev/null 2>&1 || return 1
  tailscale status --json 2>/dev/null | "$node" "$lib" parse-tailscale-status --field ip
}

# detect_tailscale_dns_name <node> <lib> — the box's MagicDNS name
# (`<host>.<tailnet>.ts.net`), or exit 1 with no output when the tailnet has
# MagicDNS disabled or the name is unusable.
#
# A MISSING NAME IS NOT A FAILURE — it is the documented fallback (advertise
# the raw IP, i.e. the pre-BET behaviour), so every call site must tolerate the
# non-zero exit rather than `die` on it. The name matters because it is the
# only form of this box's address an iOS app can legally open over plain HTTP:
# App Transport Security exempts the RFC1918 ranges but not Tailscale's
# 100.64/10, and an ATS exception can name a domain but never an IP. See the
# comment on parseTailscaleStatus in install-lib.mjs.
detect_tailscale_dns_name() {
  local node="$1" lib="$2"
  command -v tailscale >/dev/null 2>&1 || return 1
  tailscale status --json 2>/dev/null | "$node" "$lib" parse-tailscale-status --field dns-name
}

# detect_tailscale_bind_hosts <node> <lib> — the comma-separated list of every
# address the tailnet listener must bind: the IPv4, plus the IPv6 when the node
# has one.
#
# Both are needed because MagicDNS publishes BOTH under the box's name, and a
# client resolving that name will try the IPv6 first. Binding only the IPv4
# leaves an advertised address that never answers — which stalls a connection
# rather than refusing it. See parseTailscaleStatus in install-lib.mjs.
detect_tailscale_bind_hosts() {
  local node="$1" lib="$2"
  command -v tailscale >/dev/null 2>&1 || return 1
  tailscale status --json 2>/dev/null | "$node" "$lib" parse-tailscale-status --field bind-hosts
}

# resolve_ingress_mode <node> <lib> — resolve the ingress path honoring the
# MANTA_INGRESS override (auto | public | tailscale), setting INGRESS_MODE
# ("public" | "tailscale") plus four tailnet vars. Keep the bind/advertise
# split: a listener needs an address, a client needs a name it is allowed to
# dial, and those are not the same string.
#   TAILNET_IP         the box's tailnet identity — always an IPv4.
#   TAILNET_BIND_HOSTS every address the listener binds, comma-separated
#                      (IPv4 + IPv6), because the advertised name resolves to
#                      both and an unbound one stalls callers.
#   TAILNET_HOSTNAME   the advertised MagicDNS name; empty when the tailnet
#                      has none.
#   TAILNET_URL_HOST   what goes in a URL: the name if there is one, else the IP.
#
# MANTA_INGRESS=public FORCES public
# even when Tailscale is up (the box wants a public address regardless of a
# running tailnet); MANTA_INGRESS=tailscale forces tailnet and dies if
# detection fails; auto picks tailnet iff Tailscale is up. Because the
# preflight uses this too, a MANTA_INGRESS=public box with no usable root is
# correctly treated as the public path and gated (BET-980 D1).
resolve_ingress_mode() {
  local node="$1" lib="$2"
  MANTA_INGRESS="${MANTA_INGRESS:-auto}"
  TAILNET_IP=""
  TAILNET_HOSTNAME=""
  TAILNET_URL_HOST=""
  TAILNET_BIND_HOSTS=""
  case "$MANTA_INGRESS" in
    public) ;;
    tailscale)
      TAILNET_IP="$(detect_tailscale_ip "$node" "$lib")" \
        || die "MANTA_INGRESS=tailscale but Tailscale is not running (need 'tailscale status' BackendState=Running with an IPv4). Start tailscale, or use MANTA_INGRESS=public."
      ;;
    auto)
      TAILNET_IP="$(detect_tailscale_ip "$node" "$lib" 2>/dev/null || true)"
      ;;
    *) die "MANTA_INGRESS must be auto, public, or tailscale (got: $MANTA_INGRESS)" ;;
  esac
  INGRESS_MODE="public"
  if [ -n "$TAILNET_IP" ]; then
    INGRESS_MODE="tailscale"
    # Best-effort: MagicDNS is a per-tailnet setting a box does not control.
    # `|| true` because no name is a supported outcome, not an install failure.
    TAILNET_HOSTNAME="$(detect_tailscale_dns_name "$node" "$lib" 2>/dev/null || true)"
    TAILNET_URL_HOST="${TAILNET_HOSTNAME:-$TAILNET_IP}"
    # Every address the listener binds. Falls back to the IPv4 alone if the
    # lookup fails, which is exactly the previous behaviour.
    TAILNET_BIND_HOSTS="$(detect_tailscale_bind_hosts "$node" "$lib" 2>/dev/null || true)"
    TAILNET_BIND_HOSTS="${TAILNET_BIND_HOSTS:-$TAILNET_IP}"
  fi
}

# ---------------------------------------------------------------------------
# Git-aware deploy init. `scripts/self-update.sh` (wired in BET-225.A5) assumes
# $MANTA_HOME is a git checkout, so the update path can do a `git fetch +
# reset`. The release tarball ships WITHOUT a .git/ (pack.mjs strips it), so we
# re-create one here. Idempotent: a re-run on an existing deploy updates the
# remote URL in place (handles renames) and re-resets, so the tarball and the
# working tree always agree. Untracked files (runtime/, RELEASE.json) survive —
# `git reset --hard` only touches tracked paths.
#
# WE RESET TO THE RELEASE'S OWN COMMIT, NOT origin/main (BET-978). The tarball
# is where node_modules comes from — the box never builds dependencies itself —
# so resetting the source to main pairs TODAY's code with the LAST RELEASE's
# dependencies. Every package added since that release is then missing, the
# server dies on an unresolved import before it binds, and the installer can
# only report a health-check timeout. That broke EVERY clean install on prod
# and staging for the window between a dependency-adding merge and the next
# release, while already-installed boxes (which take source and dependencies
# from one tarball) were fine. Pinning makes the two agree by construction. New
# code still reaches boxes the normal way: publish a release, self-update
# applies it wholesale.
#
# `MANTA_DEPLOY_REF` overrides the pin with any ref (e.g. `origin/main`, a
# branch, a sha). That is how you deploy a branch to a box on purpose — and how
# the macOS install smoke keeps exercising a PR's own server/plist code while
# installing the last published tarball.
#
# The stamp is read HERE, in bash, and NOT through install-lib.mjs. install.sh
# is served fresh from the website, but the lib comes from the extracted
# TARBALL — which is by definition an older release and need not know any
# subcommand added since. Asking it would make this decision silently
# unavailable on exactly the installs that need it (verified: the macOS smoke
# fell back to origin/main because the 0.0.30 lib had no `deploy-ref`). The
# pattern doubles as the validation: only a full 40-char hex matches, so a
# truncated or hand-edited stamp yields nothing and falls back.
#
# $1=MANTA_HOME  $2=repo url  $3=node binary  $4=install-lib.mjs
deploy_git_checkout() {
  local home="$1" repo_url="$2" node_bin="$3" lib="$4"
  local deploy_sha deploy_ref="origin/main"

  log "Initialising git checkout at $home (origin=$repo_url)"
  if [ ! -d "$home/.git" ]; then
    git -C "$home" init -q -b main \
      || die "git init failed at $home — install git and retry"
  fi
  # `git remote add` fails if the remote already exists (re-run case);
  # `set-url` is the idempotent override.
  git -C "$home" remote set-url origin "$repo_url" 2>/dev/null \
    || git -C "$home" remote add origin "$repo_url"
  git -C "$home" fetch origin main -q \
    || die "git fetch origin main failed — check network / MANTA_REPO_URL"

  # An explicit override wins outright — deploying a branch is a deliberate act.
  if [ -n "${MANTA_DEPLOY_REF:-}" ]; then
    git -C "$home" fetch origin "$MANTA_DEPLOY_REF" -q 2>/dev/null || true
    git -C "$home" reset --hard "$MANTA_DEPLOY_REF" -q \
      || die "git reset --hard $MANTA_DEPLOY_REF failed at $home (MANTA_DEPLOY_REF)"
    ok "Deploy pinned by MANTA_DEPLOY_REF: $(git -C "$home" rev-parse --short HEAD) ($MANTA_DEPLOY_REF)"
    return 0
  fi

  # Which commit? The release stamps its own into RELEASE.json. Empty means
  # this tarball predates the stamp (or was packed outside a git checkout) —
  # then, and only then, fall back to origin/main.
  deploy_sha="$(sed -n 's/.*"git_sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' \
    "$home/RELEASE.json" 2>/dev/null | head -1)"
  if [ -n "$deploy_sha" ]; then
    # The release commit is normally an ancestor of main and already local
    # after the fetch above. If it isn't (a release built from a branch since
    # force-pushed, say), ask the remote for it directly — and only fall back
    # if the remote can't serve it either, since a checkout at main is still
    # better than no checkout at all.
    if git -C "$home" cat-file -e "${deploy_sha}^{commit}" 2>/dev/null \
      || git -C "$home" fetch origin "$deploy_sha" -q 2>/dev/null; then
      deploy_ref="$deploy_sha"
    else
      warn "release commit ${deploy_sha} is not fetchable — falling back to origin/main"
    fi
  fi
  git -C "$home" reset --hard "$deploy_ref" -q \
    || die "git reset --hard $deploy_ref failed at $home"
  ok "Deploy is git-aware: $(git -C "$home" rev-parse --short HEAD) (ref: $deploy_ref)"
}

# ---------------------------------------------------------------------------
# Dependency preflight. The pin above makes the usual source/dependency
# mismatch unreachable, but a fork via MANTA_REPO_URL, a hand-run `git pull`,
# or a half-extracted tarball can still leave a tree the shipped node_modules
# doesn't satisfy. Unchecked, that surfaces as a supervised service
# crash-looping on a module-not-found: the installer reports only "server did
# not become healthy" and the operator is sent to read service logs to discover
# a missing package. Name the packages here instead, while we can still say
# what's wrong.
#
# $1=MANTA_HOME  $2=node binary  $3=install-lib.mjs
check_release_dependencies() {
  local home="$1" node_bin="$2" lib="$3" missing
  missing="$("$node_bin" "$lib" check-deps --home "$home" 2>/dev/null || echo "")"
  [ -n "$missing" ] || return 0
  die "this release is inconsistent — its source needs packages its node_modules does not have:
$(printf '  - %s\n' $missing)
       The server cannot start like this. This is a release-packaging bug, not
       a problem with your machine — please report it. Re-running the installer
       once a fixed release is published will resolve it."
}

# Test mode: when sourced by scripts/install.test.mjs with MANTA_INSTALL_TEST_MODE=1,
# only the bash helpers (log/ok/warn/die + manifest_get + _sha256_of +
# verify_sha256 + resolve_arch + launchd_agent_path + read_box_id /
# wait_for_box_id + deploy_git_checkout / check_release_dependencies) are
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
  # 3.5 CAPABILITY PREFLIGHT — ALL-OR-NOTHING (BET-980).
  #
  # The PUBLIC ingress path needs a Debian/Ubuntu-family distro and the ability
  # to run commands as root. Before the FIRST mutation (the atomic swap into
  # $MANTA_HOME, the systemd units, the box identity, gateway registration) we
  # interrogate the machine for both and die on a missing capability — so a
  # box that would otherwise finish with an unreachable "Installed." state
  # instead refuses to start. The tarball is only extracted into $WORK (a
  # temp dir cleaned by the EXIT trap), so nothing persistent has been written:
  # failing here leaves a clean box. The vendored node + lib are read straight
  # out of $WORK/pkg — the same runtime step 7.5 uses, before the swap.
  #
  # Dry-run just reports the verdict; it never dies (a preview shows the plan,
  # and by definition has installed nothing).
  _PRE_NODE="$WORK/pkg/runtime/node/bin/node"
  _PRE_LIB="$WORK/pkg/scripts/install-lib.mjs"

  # Resolve the ingress path via the SAME shared helper step 7 uses, so the
  # D1 gate and the persisted decision can never diverge. On macOS the gate
  # never applies (loopback-only; the preflight always passes), so we short-
  # circuit to "macos" before probing Tailscale. Otherwise resolve_ingress_mode
  # honors MANTA_INGRESS (auto/public/tailscale): notably MANTA_INGRESS=public
  # FORCES the public path even when Tailscale is up, so such a box with no
  # usable root is correctly gated here.
  if [ "$IS_MACOS" = "1" ]; then
    _PRE_INGRESS="macos"
  else
    resolve_ingress_mode "$_PRE_NODE" "$_PRE_LIB"
    if [ "$INGRESS_MODE" = "tailscale" ]; then
      _PRE_INGRESS="tailscale"
    else
      _PRE_INGRESS="public"
    fi
  fi

  # Resolve the sudo strategy ONCE here, before any mutation (D2). This is
  # load-bearing: a box that cannot satisfy the public path's root requirement
  # is refused while nothing has been written, and every later privileged call
  # (via sudo_priv, step 7.5) uses the SAME resolved value — the decision can
  # never diverge between the gate and the privileged section.
  resolve_sudo_strategy

  # Root usable for the preflight = any strategy other than `none` (a box
  # with password-sudo that the desktop can satisfy via askpass, or root, or
  # passwordless sudo, or an interactive tty, all count as usable).
  _PRE_ROOT="0"
  [ "$SUDO_STRATEGY" != "none" ] && _PRE_ROOT="1"

  # Distro supported: probe detect-distro (the same subcommand step 7.5 uses).
  _PRE_DISTRO_STATUS="$("$_PRE_NODE" "$_PRE_LIB" detect-distro 2>/dev/null || echo "")"
  _PRE_DISTRO_SUPPORTED="$(printf '%s' "$_PRE_DISTRO_STATUS" | "$_PRE_NODE" -e '
      let s = "";
      process.stdin.on("data", (c) => { s += c; });
      process.stdin.on("end", () => {
        try { process.stdout.write(JSON.parse(s).supported ? "yes" : "no"); }
        catch { process.stdout.write("unknown"); }
      });
    ' 2>/dev/null || echo unknown)"
  _PRE_DISTRO_ID="$(printf '%s' "$_PRE_DISTRO_STATUS" | "$_PRE_NODE" -e '
      let s = "";
      process.stdin.on("data", (c) => { s += c; });
      process.stdin.on("end", () => {
        try { process.stdout.write(JSON.parse(s).id ?? ""); }
        catch { process.stdout.write(""); }
      });
    ' 2>/dev/null || true)"

  if [ "$DRY_RUN" = "1" ]; then
    dry_log "capability preflight: ingress=$_PRE_INGRESS root=${_PRE_ROOT} strategy=${SUDO_STRATEGY:-} distro_supported=$_PRE_DISTRO_SUPPORTED"
  else
    public_ingress_preflight "$_PRE_INGRESS" "$_PRE_ROOT" "$_PRE_DISTRO_SUPPORTED" "$_PRE_DISTRO_ID"
    # The public path may need the sudo-askpass helper (strategy 2). This runs
    # only AFTER the preflight passed, so a box that can't complete the public
    # path never touches / creates the askpass machinery.
    if [ "$_PRE_INGRESS" = "public" ] && [ "$SUDO_STRATEGY" = "askpass" ]; then
      setup_askpass
    fi
  fi

  # ---------------------------------------------------------------------------
  # 4. Atomic swap. .prev preserves the previous install in case anything in
  #    the new install fails before completion — operators can `mv` it back.
  # ---------------------------------------------------------------------------
  # BET-995: the default install location moved from ~/manta to the XDG data
  # dir (${XDG_DATA_HOME:-$HOME/.local/share}/manta). If MANTA_HOME is not set
  # but a box is already installed at the legacy ~/manta location, keep it there
  # so an install/update re-run never orphans a running server or spawns a
  # second install. An explicitly set MANTA_HOME is always the override and wins.
  if [ -z "${MANTA_HOME:-}" ] && { [ -d "$HOME/manta/.git" ] || [ -f "$HOME/manta/RELEASE.json" ]; }; then
    MANTA_HOME="$HOME/manta"
    log "Preserving existing install at $MANTA_HOME (legacy ~/manta default location)"
  else
    MANTA_HOME="${MANTA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/manta}"
  fi
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

  # BET-999: the XDG default (~/.local/share/manta) can have a parent that a
  # fresh box does NOT have. The mv into $MANTA_HOME below is a same-filesystem
  # rename that requires the target's parent to exist — create it up front and
  # die loudly rather than failing the swap mid-install.
  mkdir -p "$(dirname "$MANTA_HOME")" \
    || die "could not create $MANTA_HOME parent directory"

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
  # No path lookup, no reliance on a system node. Resolved BEFORE the git step
  # below because that step asks the tested lib which commit to pin to.
  NODE="$MANTA_HOME/runtime/node/bin/node"
  export PATH="$MANTA_HOME/runtime/node/bin:$PATH"

  # Now use the REAL tested lib for everything downstream.
  LIB="$MANTA_HOME/scripts/install-lib.mjs"
  [ -f "$LIB" ] || die "tarball is missing scripts/install-lib.mjs — bad release?"

  # 4b/4c — see deploy_git_checkout() / check_release_dependencies() above.
  MANTA_REPO_URL="${MANTA_REPO_URL:-https://github.com/antoinedc/MantaUI.git}"
  if [ "$DRY_RUN" = "1" ]; then
    dry_log "would init git at $MANTA_HOME, fetch $MANTA_REPO_URL, reset --hard to the release commit"
    dry_log "would verify every declared dependency is present in $MANTA_HOME/node_modules"
  else
    deploy_git_checkout "$MANTA_HOME" "$MANTA_REPO_URL" "$NODE" "$LIB"
    check_release_dependencies "$MANTA_HOME" "$NODE" "$LIB"
  fi

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
  # An existing install may be off-PATH in this non-login shell (the app's
  # ssh -tt install path) — probe the known install dirs before deciding to
  # reinstall. Mirrors the post-install PATH fixup below.
  for _ocdir in "$HOME/.opencode/bin" "$HOME/.local/bin"; do
    if [ -x "$_ocdir/opencode" ]; then export PATH="$_ocdir:$PATH"; break; fi
  done
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
    # Resolve the freshly-installed binary deterministically from its WELL-KNOWN
    # install dir — do NOT re-source the user's ~/.bashrc (or ~/.profile) to pick
    # up the PATH line the installer appended. Installers (nvm, rustup, and
    # opencode's own installer) never source the user's rc file; they write a
    # PATH line and probe the known dir. Sourcing rc is both fragile and
    # distro-dependent: a stock Debian/Ubuntu ROOT ~/.bashrc opens with
    # `[ -z "$PS1" ] && return`, which dereferences an unbound $PS1 in a
    # non-interactive shell and — under this script's `set -eu` — aborts the
    # whole outer bash (exit 127) before control returns to the `|| true`; the
    # fresh-root install died silently right here with no message. On other
    # distros rc can prompt (hang), `read` stdin, or execute arbitrary user
    # code. The opencode installer always installs to $HOME/.opencode/bin, so
    # probing that path is both sufficient and portable.
    if [ -x "$HOME/.opencode/bin/opencode" ]; then
      export PATH="$HOME/.opencode/bin:$PATH"
    fi
    OPENCODE_BIN="$(command -v opencode || true)"
    if [ -z "$OPENCODE_BIN" ]; then
      die "opencode still not on PATH after install. Try: export PATH=\"\$HOME/.opencode/bin:\$PATH\" and re-run."
    fi
    ok "opencode installed ($("$OPENCODE_BIN" --version 2>/dev/null | head -n1 || echo "$OPENCODE_BIN"))."
  fi

  # --- A2. claude CLI install — REMOVED (BET-421 §E). -----------------------
  # The app now owns the Claude CLI: it installs the binary lazily, the
  # first time the user picks Claude, via the official installer — no
  # confirmation step, straight into sign-in. A box that never picks Claude
  # never gets the binary, which is fine (Codex / Kimi / custom need no
  # binary). Nothing here is a flag or opt-in; the whole block is deleted.
  # The box is usable without claude — its own comment (below, at A2's old
  # site) already anticipated that.

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
  # The installer runs under `set -u`, so a bare expansion of an unset var is a
  # hard error. Both plugin vars are therefore guarded with `${VAR:-}`:
  #   - MANTA_CLAUDE_AUTH_PLUGIN — the dev/CI override; unset for every end
  #     user. The macOS CI job caught this once (BET-319): every public
  #     install crashed because end users never set the override.
  #   - OPENCODE_CLAUDE_AUTH_PLUGIN — the LOG-ONLY default name, emitted by the
  #     `print-config` eval above (line ~659). It is pure cosmetic output for
  #     the seeding message here; it must never be able to abort the install,
  #     so the (should-be-unreachable-in-practice) empty default is fine.
  if [ -f "$OPENCODE_CONFIG" ]; then
    if [ -n "${MANTA_CLAUDE_AUTH_PLUGIN:-}" ]; then
      log "Seeding Claude auth plugin (override: ${MANTA_CLAUDE_AUTH_PLUGIN}) — merging into existing ${OPENCODE_CONFIG}…"
    else
      log "Seeding Claude auth plugin (${OPENCODE_CLAUDE_AUTH_PLUGIN:-}) — merging into existing ${OPENCODE_CONFIG}…"
    fi
    existing="$(cat "$OPENCODE_CONFIG" 2>/dev/null || true)"
  else
    if [ -n "${MANTA_CLAUDE_AUTH_PLUGIN:-}" ]; then
      log "Seeding Claude auth plugin (override: ${MANTA_CLAUDE_AUTH_PLUGIN}) — no existing ${OPENCODE_CONFIG}, creating…"
    else
      log "Seeding Claude auth plugin (${OPENCODE_CLAUDE_AUTH_PLUGIN:-}) — no existing ${OPENCODE_CONFIG}, creating…"
    fi
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
  # AGENTS.md section-sync (BET-640): append any top-level `## ` guidance
  # section from docs/opencode-tools/AGENTS.md that is not already present, so
  # a section added after a box was installed lands on the NEXT install/update.
  # Existing sections are never rewritten (the user may have edited them).
  # sync_opencode_guidance lives in scripts/lib/release.sh — under clean
  # `curl | bash` it wasn't available at the top (no local file pre-download),
  # but the tarball is extracted by now, so source the lib from MANTA_HOME.
  if [ -f "$OPENCODE_TOOLS_SRC/AGENTS.md" ]; then
    if ! declare -F sync_opencode_guidance >/dev/null 2>&1; then
      . "$MANTA_HOME/scripts/lib/release.sh"
    fi
    sync_opencode_guidance "$OPENCODE_TOOLS_SRC/AGENTS.md" "$OPENCODE_AGENTS"
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
      -e "s|@@MANTA_TAILNET_HOST@@|${TAILNET_BIND_HOSTS:-}|g" \
      -e "s|@@OPENCODE_BIN@@|${OPENCODE_BIN:-}|g" \
      -e "s|@@AUTH_DIR@@|$AUTH_DIR|g" \
      -e "s|@@AGENT_PATH@@|$(launchd_agent_path)|g" \
      -e "s|@@ANTHROPIC_CLI_VERSION@@|$(resolve_anthropic_cli_version)|g" \
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
    # ALWAYS re-render, matching the manta-server branch in step 7. The old
    # `is-active → skip` early-out meant an already-running box never picked up
    # a unit change (self-update.sh does not render units either), so a new
    # Environment= line would reach fresh installs only. `enable --now` does
    # not restart an already-running unit, hence the explicit restart below —
    # gated on MANTA_RESTART exactly like manta-server's.
    log "Installing opencode-serve systemd --user unit…"
    mkdir -p "$UNIT_DIR"
    rendered="$("$NODE" "$LIB" render-systemd-unit \
      --template "$OC_UNIT_SRC" \
      --placeholder OPENCODE_BIN="$OPENCODE_BIN" \
      --placeholder AGENT_PATH="$(launchd_agent_path)" \
      --placeholder ANTHROPIC_CLI_VERSION="$(resolve_anthropic_cli_version)")" \
      || die "render-systemd-unit failed (see lib)"
    printf '%s' "$rendered" > "$OC_UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now opencode-serve.service
    if [ "${MANTA_RESTART:-1}" = "1" ]; then
      systemctl --user restart opencode-serve.service \
        || warn "systemctl --user restart opencode-serve failed — run it manually"
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
      # Same background-subagent flag AND the same claimed Claude Code version
      # the systemd unit and the LaunchAgent carry — keep the three
      # supervisors' environments identical.
      ( OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true \
        ANTHROPIC_CLI_VERSION="$(resolve_anthropic_cli_version)" \
        nohup "$OPENCODE_BIN" serve --port 4096 --hostname 127.0.0.1 >"$AUTH_DIR/opencode.log" 2>&1 & )
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

  # --- Ingress mode (BET-267) ----------------------------------------------
  # Shared resolve_ingress_mode (defined above main) computes INGRESS_MODE +
  # TAILNET_IP honoring the MANTA_INGRESS override — the SAME helper the 3.5
  # preflight uses, so the D1 gate and this persisted decision can never
  # disagree. Resolved BEFORE the unit render so the systemd template gets the
  # correct MANTA_TAILNET_HOST value (empty on public path, the Tailscale IPv4
  # on the tailnet path), then persisted to ~/.manta/ingress.json as the single
  # source of truth for `manta pair`.
  #
  # MANTA_INGRESS: auto (default — tailnet iff Tailscale is up) | public |
  # tailscale (force tailnet; die if detection fails).
  resolve_ingress_mode "$NODE" "$LIB"

  # Persist the decision. write-ingress creates the parent dir if missing
  # and writes 0600 atomically (write <file>.tmp then rename).
  INGRESS_JSON="$AUTH_DIR/ingress.json"
  if [ "$DRY_RUN" = "1" ]; then
    dry_log "would persist ingress decision to $INGRESS_JSON (mode=$INGRESS_MODE${TAILNET_IP:+, tailnetIp=$TAILNET_IP}${TAILNET_HOSTNAME:+, tailnetHostname=$TAILNET_HOSTNAME})"
  else
    ING_ARGS=("$NODE" "$LIB" write-ingress --file "$INGRESS_JSON" --mode "$INGRESS_MODE")
    if [ -n "$TAILNET_IP" ]; then
      ING_ARGS+=(--tailnet-ip "$TAILNET_IP" --port "$MANTA_PORT")
      # Only passed when detection produced one; write-ingress rejects a
      # malformed value rather than silently falling back to the IP, so an
      # empty flag must never be sent.
      if [ -n "$TAILNET_HOSTNAME" ]; then
        ING_ARGS+=(--tailnet-hostname "$TAILNET_HOSTNAME")
      fi
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
      -e "s|@@MANTA_TAILNET_HOST@@|${TAILNET_BIND_HOSTS:-}|g" \
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
    ( MANTA_MOBILE_HOST=127.0.0.1 MANTA_MOBILE_PORT="$MANTA_PORT" MANTA_TAILNET_HOST="${TAILNET_BIND_HOSTS:-}" nohup "$NODE" "$MANTA_HOME/src/server/index.mjs" >"$AUTH_DIR/server.log" 2>&1 & )
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
  #     goes through `sudo_priv` (resolved once in the 3.5 preflight into a
  #     strategy: root / askpass / nopasswd / tty) and the whole section
  #     bails cleanly (warn + skip) on:
  #       a. Distro not in {debian, ubuntu, ID_LIKE=debian} (v1 scope)
  #       b. root unusable (SUDO_STRATEGY=none — refused in the 3.5 preflight)
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
  # DNS/vhost sub-steps (A/D/E/reload). Merges the macOS case
  # (BET-274 / BET-276) with the existing tailscale case (BET-267): both
  # skip the public TLS path; gateway-register (B/C) still runs in both
  # because it's user-space and the gateway_token is still needed for
  # APNs push. Computed once, used by every guard below.
  #
  # NOTE — this is ALWAYS a legitimate, complete outcome. It is NOT the
  # removed BET-980 degrader (the old degraded-success flag is gone): the
  # only way A/D/E/reload are skipped is that the chosen ingress path
  # (tailscale / macOS) genuinely has no public TLS. A public-path install
  # reaches this code with root + a supported distro already verified by
  # the preflight.
  SKIP_PUBLIC_TLS=0
  if [ "$INGRESS_MODE" = "tailscale" ] || [ "$IS_MACOS" = "1" ]; then
    SKIP_PUBLIC_TLS=1
  fi

  # The capability gates (distro + root) now run in the 3.5 PREFLIGHT, before
  # the first mutation, and die there on a missing public-path capability —
  # so step 7.5 no longer has a "degraded success" branch. On the public path
  # root has already been verified usable (SUDO_STRATEGY resolved once in the
  # preflight); every privileged call below goes through `sudo_priv`, which
  # dispatches on that strategy — bare for root, -n for passwordless, -A for
  # the staged-password askpass helper, plain sudo for an interactive tty.

  if [ "$INGRESS_MODE" = "tailscale" ]; then
    # Tailscale path (BET-267): skip Caddy install + DNS wait + vhost write +
    # caddy reload. B/C (gateway register + merge-gateway) still
    # run below — the gateway_token is still needed for APNs push.
    log "Tailscale detected ($TAILNET_IP${TAILNET_HOSTNAME:+, MagicDNS $TAILNET_HOSTNAME}) — skipping Caddy + public DNS; devices connect over the tailnet."
  elif [ "$IS_MACOS" = "1" ]; then
    # macOS path (BET-274 / BET-276): no apt, no Caddy, no public DNS, no
    # Let's Encrypt. The box is loopback-only on the Mac; remote access
    # requires Tailscale (a Mac that's never logged in is unsupported —
    # Issue C will wire that up via LaunchAgents). B/C (gateway register
    # + merge-gateway) still run below for the APNs push token.
    log "macOS detected — skipping Caddy/apt/DNS/vhost; server is loopback-only. Use Tailscale to reach this server off-network."
  else
    log "Configuring public TLS via Caddy + gateway registration (privileged)…"
  fi

  # --- B/C. Register with the gateway + persist gateway_token -------------
  # B (POST /register) and C (merge-gateway into auth.json) are user-space and
  # run in BOTH ingress modes. On tailscale the gateway records an A record
  # that is unused on this path and must NEVER be treated as evidence of
  # public reachability (nothing terminates TLS on it); the persisted
  # gateway_token is still the APNs push credential (BET-198). On the PUBLIC
  # path a registration failure
  # is fatal (there is no public ingress without it); on tailscale / macOS it
  # stays a warn — the server re-registers on every restart and the APNs token
  # is best-effort at install time.
  # The server mints the identity asynchronously on its first start, so on a
  # fresh box this read races the mint — poll for up to ~60s rather than
  # taking the first empty answer as final (see wait_for_box_id's comment for
  # the failure this caused). Dry-run never waits: one probe and move on.
  BOX_ID_WAIT_ATTEMPTS=60
  if [ "$DRY_RUN" = "1" ]; then BOX_ID_WAIT_ATTEMPTS=1; fi
  BOX_ID_FOR_GATEWAY="$(wait_for_box_id "$LIB" "$NODE" "$BOX_ID_WAIT_ATTEMPTS" 1 || true)"

  if [ -z "$BOX_ID_FOR_GATEWAY" ]; then
    if [ "$DRY_RUN" != "1" ] && [ "$SKIP_PUBLIC_TLS" != "1" ]; then
      die "no box_id in $MANTA_AUTH_FILE after waiting — cannot register the gateway, so this server would have no public HTTPS.
        Start the manta-server at least once ($(supervisor_hint restart server)), then run the installer again.

        Fix the above and run the installer again — re-running is safe and preserves your box identity."
    fi
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
      if GW_RESP="$(curl "${REGISTER_ARGS[@]}" "$GATEWAY_BASE/register")"; then
        # Pipe the JSON to merge-gateway via stdin (lib subcommand) so the
        # auth.json write is atomic temp-rename + 0600, preserving
        # box_id / box_token / created_at.
        if printf '%s' "$GW_RESP" | "$NODE" "$LIB" merge-gateway --file "$MANTA_AUTH_FILE" 2>/tmp/manta-gateway-merge.err; then
          ok "gateway registration complete."
        else
          if [ "$SKIP_PUBLIC_TLS" != "1" ]; then
            die "merge-gateway failed — the gateway token/host could not be persisted, so this server would advertise a hostname whose config is incomplete (see /tmp/manta-gateway-merge.err).
              Fix the gateway registration issue and run the installer again.

              Fix the above and run the installer again — re-running is safe and preserves your box identity."
          fi
          warn "merge-gateway failed (see /tmp/manta-gateway-merge.err) — the server will re-register on next boot."
        fi
      else
        if [ "$SKIP_PUBLIC_TLS" != "1" ]; then
          die "gateway registration POST failed — this server would have no public HTTPS without it.
            ${MANTA_GATEWAY_BASE:+($MANTA_GATEWAY_BASE) }Fix the gateway/network issue and run the installer again.

            Fix the above and run the installer again — re-running is safe and preserves your box identity."
        fi
        warn "gateway registration POST failed — the server will retry on every server restart."
      fi
    fi
  fi

  # --- A. Install Caddy if absent ------------------------------------------
  # A, D, E/reload only run on the public path (BET-267). The
  # tailscale path AND the macOS path (BET-276) never bind :80/:443, never
  # write a Caddy vhost, never wait on DNS, never reload Caddy. Gated via
  # SKIP_PUBLIC_TLS which merges both cases into one predicate.
  if [ "$SKIP_PUBLIC_TLS" != "1" ]; then
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
      # already been gated in the 3.5 preflight: distro is
      # Debian/Ubuntu and root is usable (SUDO_STRATEGY resolved).
      # Refresh apt lists first — on a fresh box the package index can be
      # empty/stale, which makes `apt-get install debian-keyring …` fail with
      # "Unable to locate package". The Caddy docs run `apt update` up front
      # for exactly this reason.
      apt_priv update \
        || die "apt-get update failed"
      apt_priv install -y debian-keyring debian-archive-keyring apt-transport-https curl \
        || die "apt-get install prerequisites for Caddy failed"
      # Import Caddy's repo signing key. Staged through temp files and made
      # NON-INTERACTIVE for the same reason apt_priv exists (see its comment):
      # this script runs over `ssh -tt` with stdin ignored, so ANY command
      # that asks a question blocks forever inside the "Starting the service"
      # stage while the UI's elapsed timer keeps ticking — it reads as alive.
      # Reported from the field on Ubuntu 22.04.
      #
      #   --batch --yes
      #       `gpg --dearmor -o <path>` prompts "File '<path>' exists.
      #       Overwrite? (y/N)" when the keyring is ALREADY THERE, which is
      #       the normal state on a retry: the first attempt writes the key,
      #       fails or is cancelled later, and every subsequent run then hangs
      #       HERE deterministically. That self-perpetuating trap is the bug —
      #       overwriting is always what we want (the key is re-fetched from
      #       source in the line above).
      #   --connect-timeout / --max-time
      #       The key is ~7KB from a third-party host (Cloudsmith). Unreachable
      #       rather than slow, a bare curl waits forever — same symptom, same
      #       stage, different cause. Bounded so it FAILS and gets reported.
      #
      # Staging to a temp file also fixes the pipeline's error handling: in
      # `curl … | gpg …` only gpg's status is checked, so a truncated download
      # could be dearmored into a corrupt keyring that poisons apt later.
      _caddy_key_asc="$(mktemp)"
      _caddy_key_gpg="$(mktemp)"
      if ! curl -1sLf --connect-timeout 15 --max-time 60 \
          https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$_caddy_key_asc"; then
        rm -f "$_caddy_key_asc" "$_caddy_key_gpg"
        die "failed to download the Caddy signing key from dl.cloudsmith.io (network unreachable, or the host is down).
        Check the server can reach it:  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key >/dev/null"
      fi
      if ! gpg --batch --yes --dearmor -o "$_caddy_key_gpg" < "$_caddy_key_asc"; then
        rm -f "$_caddy_key_asc" "$_caddy_key_gpg"
        die "failed to decode the Caddy signing key"
      fi
      install_root_file "$_caddy_key_gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
        || { rm -f "$_caddy_key_asc" "$_caddy_key_gpg"; die "failed to install the Caddy signing key"; }
      rm -f "$_caddy_key_asc" "$_caddy_key_gpg"
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
      install_root_file "$_caddy_list_tmp" /etc/apt/sources.list.d/caddy-stable.list \
        || { rm -f "$_caddy_list_tmp"; die "failed to add Caddy apt repo"; }
      rm -f "$_caddy_list_tmp"
      apt_priv update \
        || die "apt-get update failed"
      apt_priv install -y caddy \
        || die "apt-get install caddy failed"
      ok "caddy installed ($(caddy version 2>/dev/null || echo unknown))."
    fi
  fi

  # --- D. Poll DNS until <box_id>.boxes.mantaui.com resolves to us -------
  # Public path only (BET-267 + BET-276); the tailnet path AND the macOS
  # path have no DNS wait. Gated via SKIP_PUBLIC_TLS. Under the BET-980
  # all-or-nothing rule, every public-path failure here is FATAL (progress
  # has already been made, but a box that can't be reached must be reported
  # as failed, not dressed as success). Dry-run just shows the plan.
  if [ "$SKIP_PUBLIC_TLS" != "1" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      dry_log "would determine the server's public IP and poll DNS for $GATEWAY_HOST (up to 90s)"
      dry_log "would render + install the Caddy vhost (box_id=$BOX_ID_FOR_GATEWAY, port=$MANTA_PORT)"
      dry_log "would run: systemctl reload caddy"
    else
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

      # Detect this box's public IP via api.ipify.org — fall back to
      # `hostname -I`. We MUST use the public IP, not loopback — otherwise
      # the DNS check trivially passes on every box.
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
        die "could not determine the server's public IP — cannot complete the public path.
          Fix your network/egress so api.ipify.org (or hostname -I) reports a public address, then run the installer again.

          Fix the above and run the installer again — re-running is safe and preserves your box identity."
      fi

      # Bounded at ~90s (18 × 5s). A fresh gateway registration normally
      # propagates in well under a minute; a longer wait just looks like a
      # hang. On timeout we DIE — a public-path box whose hostname never
      # resolves has no HTTPS and must be reported as failed.
      log "Waiting for $GATEWAY_HOST to resolve to $BOX_PUBLIC_IP (up to 90 seconds)…"
      "$NODE" "$LIB" wait-for-dns \
          --hostname "$GATEWAY_HOST" \
          --expected-ip "$BOX_PUBLIC_IP" \
          --max-attempts 18 \
          --interval-ms 5000 \
        || die "$GATEWAY_HOST did not resolve to $BOX_PUBLIC_IP within 90s.
          DNS propagation can lag after a fresh gateway registration.
          Check: curl -fsS $GATEWAY_BASE/healthz
          And:   journalctl --user -u manta-server -n 50 (for the gateway-register lines)

          Fix the above and run the installer again — re-running is safe and preserves your box identity."
      ok "DNS resolved."

      # --- E. Write the Caddy vhost and reload ----------------------------
      # /etc/caddy/Caddyfile.d/ is the convention used by the official
      # Caddy apt repo's stock /etc/caddy/Caddyfile (which imports
      # /etc/caddy/Caddyfile.d/*.caddy). Falling back to /etc/caddy/Caddyfile
      # with marked-block append is for distros that install Caddy without
      # the conf.d import (we test for the directory's existence).
      #
      # ALL-OR-NOTHING (BET-980): every failure here is FATAL. A vhost that
      # isn't written/live means no public TLS, so the install stops rather
      # than printing "Installed." for an unreachable box. Re-running is safe
      # and idempotent.
      CADDY_DIR_D="/etc/caddy/Caddyfile.d"
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
          die "failed to render the Caddy vhost (see /tmp/manta-caddy-render.err).
            Fix the above and run the installer again — re-running is safe and preserves your box identity."
        fi
        install_root_file "$_caddy_snippet_tmp" "$CADDY_DIR_D/manta.caddy" 2>/tmp/manta-caddy-tee.err \
          || die "failed to write $CADDY_DIR_D/manta.caddy (sudo install failed — see /tmp/manta-caddy-tee.err).
            Fix the above and run the installer again — re-running is safe and preserves your box identity."
        rm -f "$_caddy_snippet_tmp"
      else
        # conf.d missing → keep exactly one marker-bracketed block inside
        # the main Caddyfile. All the block editing lives in install-lib.mjs
        # (pure + unit-tested); this shell path only stages a temp file and
        # installs it. `cat` of a missing file yields empty stdin, which the
        # subcommand treats as "no Caddyfile yet" — so create/append/replace
        # are one code path, not three.
        #
        # The `( cat ... || true )` group is pipefail-load-bearing: without
        # it, a missing Caddyfile makes `cat` exit non-zero and `set -o
        # pipefail` fails the whole pipeline, routing to the die branch
        # below instead of reaching install_root_file — so the create-from-
        # scratch case (the box has Caddy but no main Caddyfile) would never
        # write a vhost. `|| true` yields empty stdin + exit 0 while node's
        # own render/validation exit code still propagates.
        CADDYFILE="/etc/caddy/Caddyfile"
        _caddyfile_tmp="$(mktemp)"
        if ! ( cat "$CADDYFILE" 2>/dev/null || true ) \
            | "$NODE" "$LIB" upsert-caddy-block --box-id "$BOX_ID_FOR_GATEWAY" --port "$MANTA_PORT" \
            > "$_caddyfile_tmp" 2>/tmp/manta-caddy-render.err; then
          die "failed to render the Caddy vhost (see /tmp/manta-caddy-render.err).
            Fix the above and run the installer again — re-running is safe and preserves your box identity."
        fi
        install_root_file "$_caddyfile_tmp" "$CADDYFILE" 2>/tmp/manta-caddy-write.err \
          || die "could not update $CADDYFILE (sudo install failed — see /tmp/manta-caddy-write.err).
            Fix the above and run the installer again — re-running is safe and preserves your box identity."
        rm -f "$_caddyfile_tmp"
      fi

      # The vhost is on disk; make Caddy live. Without a successful reload no
      # certificate is issued — fatal on the public path.
      if command -v systemctl >/dev/null 2>&1; then
        sudo_priv systemctl reload caddy 2>/tmp/manta-caddy-reload.err \
          || die "systemctl reload caddy failed — the vhost is on disk but NOT live, so no certificate will be issued.
            See /tmp/manta-caddy-reload.err
            Fix the above and run the installer again — re-running is safe and preserves your box identity."
        ok "caddy reloaded."
      else
        die "systemctl not found — cannot reload Caddy, so the vhost would not become live.
          Install systemd (or reload Caddy manually: sudo caddy reload --config /etc/caddy/Caddyfile).
          Fix the above and run the installer again — re-running is safe and preserves your box identity."
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
  # BET-989: write the machine-readable pairing sidecar the desktop auto-claim
  # reads. manta-pair.mjs --json emits {pairing_code, box_id, expiresAt,
  # serverUrl}; the human pairing block is no longer captured/printed on the
  # install path (the manual `manta pair` command still prints it for humans).
  "$NODE" "$MANTA_HOME/scripts/manta-pair.mjs" --json > "$AUTH_DIR/pairing.json" 2>/dev/null || true

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

Tailscale detected ($TAILNET_IP) — your server is reachable over the tailnet at
http://${TAILNET_URL_HOST:-$TAILNET_IP}:$MANTA_PORT (plain HTTP; WireGuard encrypts the hop). No
public DNS, no Caddy, no Let's Encrypt on this path. Devices on the same tailnet
can connect directly; off-tailnet devices need Tailscale access first.
EOF
    if [ -z "${TAILNET_HOSTNAME:-}" ]; then
      cat <<EOF

NOTE: this tailnet has no MagicDNS name for this machine, so the address above
is a raw Tailscale IP. The iOS app cannot open a plain-HTTP address in
Tailscale's 100.64.0.0/10 range (Apple's transport policy exempts the classic
private ranges but not that one, and the exception it does honour can only name
a domain). Turn MagicDNS on for your tailnet and re-run this installer to be
advertised as http://<name>.<tailnet>.ts.net:$MANTA_PORT instead — the desktop
app and a browser work either way.
EOF
    fi
  else
    cat <<EOF

Your server serves its own public hostname — https://<box_id>.boxes.mantaui.com
(Caddy on this server terminates TLS and reverse-proxies 127.0.0.1:8787). The
desktop / mobile app discovers it directly via the box_id below; no relay,
no tunnel, no dial-out.
EOF
  fi

  cat <<EOF

Re-run this installer any time to upgrade in place (your box identity is preserved).
Run 'manta pair' to mint a fresh pairing code (if 'manta' isn't found, open a new
shell so ~/.local/bin is on PATH, or run: "$NODE" "$MANTA_HOME/scripts/manta-pair.mjs").
EOF

  # Cleanup: the previous install lives at $MANTA_HOME.prev until this point.
  # If we got here, everything is healthy and the new install is serving — drop
  # .prev so a future `mv` doesn't trip on a stale tree.
  rm -rf "$MANTA_HOME.prev"
}

main "$@"
