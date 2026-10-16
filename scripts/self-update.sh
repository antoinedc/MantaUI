#!/usr/bin/env bash
# self-update.sh — bring the box's manta-server code up to date, reinstall
# deps, refresh the opencode tools + agent guidance, restart the server.
#
# Wired up in BET-225 stage 2 (server-side update poller calls this on a
# cadence). Manual invocation also works — idempotent.
#
# Two kinds of box are supported (BET-640):
#
#   * packaged install (EVERY box created by `curl mantaui.com/install.sh`):
#     identified by RELEASE.json (install.sh also git-inits the dir, but that
#     incidental .git/ never determines the path). Update = download the
#     release tarball for this arch, verify it, extract it, and replace the
#     payload paths the incoming release owns (`includes` in RELEASE.json) —
#     which includes `runtime/` (the vendored Node) AND `node_modules/` (the
#     PREBUILT, arch-/ABI-verified tree, so an update never rebuilds deps and
#     needs no toolchain). install_prod_deps skips its network-fallback `npm ci`
#     entirely when the payload supplied node_modules.
#   * git checkout (a live DEV box — a clone with NO RELEASE.json): update =
#     `git fetch origin main` + `git reset --hard origin/main`. Dev boxes have
#     a toolchain and may run arbitrary source, so they keep the on-box npm
#     path.
#
# The install kind is detected from RELEASE.json-first (never .git-first), so
# every install.sh box routes to the prebuilt tarball path and self-heals even
# when its dir carries a .git/.
#
# Two-hop note (do not "fix"): an installed box runs the copy of this script
# it already has on disk, so the FIRST update after a payload-swap change ships
# the new script but still performs the swap with the OLD logic — `runtime/`
# moves on the update AFTER that one. This is inherent to a self-replacing
# updater (bash reads a script incrementally, so it must not rewrite itself
# mid-run) and is acceptable.
#
# Regardless of kind, the tail is shared and never duplicated: reinstall
# prod-only deps, refresh the manta-native opencode tools + agent guidance,
# then restart the supervisor that runs manta-server.
#
# Run from anywhere; the script derives its checkout from $0 so the caller's
# cwd doesn't matter.
#
# Requires: a clean working tree (git reset --hard will discard any local
# edits), systemd --user with the manta-server.service unit enabled
# (`loginctl enable-linger $USER`), or the macOS LaunchAgent (BET-277).
#
# No flags, no branch parameterization — always pins to origin/main (git
# kind) or the latest release tarball (packaged kind).
#
# The script's output is written to a log under the box state directory
# (truncated on each run); early failures are reported by the caller from the
# log's last line. See src/server/opencodeAdmin.mjs `runServerSelfUpdate`.

set -euo pipefail

MANTA_HOME="$(cd "$(dirname "$0")/.." && pwd)"

# --- Own printing helpers (install.sh owns its copies; release.sh needs them) --
log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- Output log under the state dir (BET-640) --------------------------------
# Early failures (install-kind detection, manifest/version resolution, any
# error before the server restart) are knowable by the caller, which reads the
# LAST LINE of this log. Uses the same state-home resolution as
# src/shared/paths.mjs `statePath()` — MANTA_STATE_HOME override first, else
# $HOME — so tests (which sandbox the state dir) and prod agree.
STATE_HOME="${MANTA_STATE_HOME:-$HOME}"
LOG_FILE="$STATE_HOME/.manta/self-update.log"
mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"
exec >>"$LOG_FILE" 2>&1

# --- Shared release helpers (arch + manifest + checksum + guidance sync) ------
# Single copy lives at scripts/lib/release.sh (ships in the release tarball);
# install.sh and self-update.sh both source it so they never drift.
. "$MANTA_HOME/scripts/lib/release.sh"

# --- Detect install kind ------------------------------------------------------
# RELEASE.json identifies a RELEASE-DEPLOYED box and WINS over .git/: install.sh
# makes every box it creates a git checkout, so checking .git first misreads an
# install.sh box (which carries RELEASE.json AND .git) as a dev checkout and
# sends it down the on-box `npm ci` path — which fails without a toolchain.
# Only a checkout with no RELEASE.json is a true dev box; it keeps the git path.
# See detect_install_kind in scripts/lib/release.sh (unit-tested).
echo "MANTA_PROGRESS 1/7 Checking for updates"
HAS_RELEASE_JSON=0; [ -f "$MANTA_HOME/RELEASE.json" ] && HAS_RELEASE_JSON=1
HAS_GIT=0;           [ -d "$MANTA_HOME/.git" ]          && HAS_GIT=1
INSTALL_KIND="$(detect_install_kind "$HAS_RELEASE_JSON" "$HAS_GIT")"
if [ "$INSTALL_KIND" = "none" ]; then
  die "self-update: $MANTA_HOME is neither a git checkout nor a packaged install"
fi

# node for reading RELEASE.json / includes: prefer the box's bundled runtime,
# else node on PATH (the box always has one of the two because it runs the
# server).
if [ -x "$MANTA_HOME/runtime/node/bin/node" ]; then
  NODE_CMD="$MANTA_HOME/runtime/node/bin/node"
else
  # No vendored runtime (a git-checkout box runs whatever Node is on PATH).
  # Resolve to an ABSOLUTE path: the `[ -x "$NODE_CMD" ]` guard below is a real
  # filesystem test, and with the bare `node` fallback that guard ran `-x node`
  # against CWD — false even when node is on PATH, so every CLI upgrade was
  # silently skipped (BET-1158). `|| true` yields empty on a genuinely missing
  # node, which the guard correctly treats as "not available".
  NODE_CMD="$(command -v node || true)"
fi

# Put the box's OWN vendored runtime FIRST on PATH (BET-829). install.sh does
# exactly this; this script never did, and every consequence was a silent brick:
#
#   * `npm` is not on the PATH a service gets at all. manta-server's systemd
#     unit / LaunchAgent carries a minimal PATH that excludes
#     runtime/node/bin, and an install.sh box has NO system npm (it vendors
#     Node precisely so it needs none) — so the `npm ci` below died with
#     "npm: command not found" AFTER the payload swap had already happened.
#   * Worse, on a box that DOES have a system npm, that npm belongs to a
#     DIFFERENT Node (e.g. system v22 while the box runs vendored v24). It
#     rebuilds node-pty's native binding for the wrong ABI, the update reports
#     success, and manta-server then fails to start at the next restart. A
#     silent-success brick is worse than a loud failure.
#
# Pinning PATH here makes `npm`/`node`/`node-gyp` resolve to the SAME runtime
# that will load the result. Guarded because a git-kind checkout may have no
# vendored runtime (it runs whatever Node is on PATH, by design).
if [ -d "$MANTA_HOME/runtime/node/bin" ]; then
  PATH="$MANTA_HOME/runtime/node/bin:$PATH"
  export PATH
fi

# --- Put the AI CLIs on PATH for the upgrade step (BET-1158) ------------------
# upgrade-clis.mjs spawns each installed CLI's upgrade command BY NAME
# (`opencode upgrade`, `claude update`, …) and those binaries live in dirs
# that a ~/.bashrc adds but a systemd/launchd service's minimal PATH never
# carries. Prepend the same home-relative set resolveBinary() in
# src/server/cliUpdates.mjs searches so the upgrade commands resolve.
#
# The list is NOT hardcoded here (BET-1163): it comes from the SINGLE source,
# HOME_CLI_INSTALL_DIRS in src/shared/cliCatalog.mjs — emitted by
# scripts/list-cli-bin-dirs.mjs (RELATIVE to $HOME, one per line). Only
# existing dirs are added, so a box missing some is unaffected. Guarded on
# node + the script being present; if node can't run, the CLI upgrade step
# below is skipped anyway, so skipping the prepend is consistent. A packaged
# box already got its vendored runtime/node/bin above; these are the user-level
# dirs that apply to every box kind.
if [ -n "${HOME:-}" ] && [ -x "$NODE_CMD" ] && [ -f "$MANTA_HOME/scripts/list-cli-bin-dirs.mjs" ]; then
  while IFS= read -r _rel_dir; do
    [ -n "$_rel_dir" ] || continue
    _cli_dir="$HOME/$_rel_dir"
    [ -d "$_cli_dir" ] || continue
    PATH="$_cli_dir:$PATH"
  done < <("$NODE_CMD" "$MANTA_HOME/scripts/list-cli-bin-dirs.mjs")
  export PATH
fi

# --- Upgrade every installed AI CLI (BET-1097) --------------------------------
# opencode, claude, codex, kimi are installed once (deliberately UNPINNED) and
# otherwise frozen at install time, so every box drifts from whatever it was
# installed with. The whole upgrade loop lives in node (scripts/upgrade-clis.mjs,
# reusing the stage-1 catalog + detector — the ONE place that knows how to find
# and upgrade a CLI). It writes a state file with `CLIS_CHANGED` (comma-separated
# ids of CLIs whose version actually changed) and `OPENCODE_CHANGED=0|1`, which
# we source below to drive the early exit and the conditional restarts.
#
# MUST run BEFORE the packaged-install early exit and before any payload
# replacement: that cheap exit skips EVERYTHING (including the restarts) when
# the box tarball is already current, and a CLI-only upgrade must still fall
# through to the restart(s) that apply. RUNS ON THE RUNTIME NODE THE SCRIPT
# ALREADY PINNED ON PATH ($MANTA_HOME/runtime/node/bin — NODE_CMD).
#
# Non-fatal throughout: an offline box, a
# missing CLI, a refused upgrade, a vendor endpoint that 500s, or even a node
# that cannot run the script must never abort the server update.
echo "MANTA_PROGRESS 2/7 Updating command-line tools"
CLIS_CHANGED=""
OPENCODE_CHANGED=0
CLI_STATE_FILE="$STATE_HOME/.manta/upgrade-clis.state"
if [ -x "$NODE_CMD" ] && [ -f "$MANTA_HOME/scripts/upgrade-clis.mjs" ]; then
  if "$NODE_CMD" "$MANTA_HOME/scripts/upgrade-clis.mjs" \
       --progress-step=2 --progress-total=7 --state-file="$CLI_STATE_FILE"; then
    if [ -f "$CLI_STATE_FILE" ]; then
      . "$CLI_STATE_FILE"
      CLIS_CHANGED="${CLIS_CHANGED:-}"
      OPENCODE_CHANGED="${OPENCODE_CHANGED:-0}"
    fi
  else
    echo "⚠ self-update: CLI upgrade script failed — continuing with no CLI changes"
  fi
else
  echo "⚠ self-update: node unavailable — skipping CLI upgrades"
fi
if [ -n "$CLIS_CHANGED" ]; then CLIS_CHANGED_FLAG=1; else CLIS_CHANGED_FLAG=0; fi

# --- Payload-replaced flag (BET-1097) -----------------------------------------
# Tracks whether this run ACTUALLY swapped the box payload (a git reset --hard
# that moved HEAD, or a release tarball extraction). Set at the ONE place each
# kind does its swap, and ONLY when the swap really changes the payload — a
# current box (git box already on origin/main, or packaged box already at the
# published build) that only upgraded a CLI must leave this 0 so the restart
# block drops to opencode-only / nothing. The conditional restart block reads
# this single flag to decide opencode-and-server vs opencode-only vs nothing.
PAYLOAD_REPLACED=0

echo "MANTA_PROGRESS 3/7 Downloading update"
if [ "$INSTALL_KIND" = "git" ]; then
  # A git checkout has no vendored runtime under version control — the box runs
  # whatever Node is on PATH. So a git box's runtime is only ever updated by
  # re-running install.sh, never by this script. (Comment only; no code.)
  log "self-update: fetching origin/main into $MANTA_HOME"
  git -C "$MANTA_HOME" fetch origin main -q

  # Only mark the payload replaced when the reset actually moves the checkout.
  # A git box already on origin/main with only a CLI changed must not restart
  # both services (BET-1097 review fix): PAYLOAD_REPLACED reflects whether the
  # payload genuinely changed, not merely that the reset command ran.
  if [ "$(git -C "$MANTA_HOME" rev-parse HEAD)" != "$(git -C "$MANTA_HOME" rev-parse origin/main)" ]; then
    log "self-update: resetting to origin/main"
    git -C "$MANTA_HOME" reset --hard origin/main -q
    PAYLOAD_REPLACED=1
  else
    log "self-update: already at origin/main"
  fi
else
  # packaged install — download + verify + extract the release tarball and
  # replace only the payload paths the release owns.
  # Channel-derived release host. This default used to be an unconditional
  # `https://mantaui.com`, so a box installed with MANTA_CHANNEL=staging
  # fetched the PROD manifest and updated itself onto PROD builds — the
  # staging track was published but no box could ever follow it.
  #
  # Mirrors `releaseHost` in src/shared/channel.mjs (prod →
  # https://mantaui.com, staging → https://mantaui.com/staging). Kept as a
  # small case rather than shelling out to node so this still works when the
  # bundled runtime is mid-replacement. `dev` maps to the prod host on
  # purpose: a dev box is a git checkout, which takes the git branch above and
  # never reaches this code at all.
  #
  # MANTA_CHANNEL reaches us from the environment of whoever spawned this
  # script — manta-server inherits it from its own systemd unit / LaunchAgent,
  # which install.sh renders with the channel it installed. An unset value
  # falls back to prod, matching install.sh's own default.
  case "${MANTA_CHANNEL:-prod}" in
    staging) channel_release_host="https://mantaui.com/staging" ;;
    *)       channel_release_host="https://mantaui.com" ;;
  esac
  host="${MANTA_RELEASE_HOST:-$channel_release_host}"
  host="${host%/}"
  log "self-update: channel=${MANTA_CHANNEL:-prod} release host=$host"

  INSTALLED_VERSION="$("$NODE_CMD" -e 'process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)||"")' "$MANTA_HOME/RELEASE.json")"
  # The commit the installed payload was built from. Empty on a box installed
  # before releases carried one — handled by the fallback in the skip check.
  INSTALLED_GIT_SHA="$("$NODE_CMD" -e 'process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_sha)||"")' "$MANTA_HOME/RELEASE.json" 2>/dev/null || echo "")"

  log "self-update: fetching manifest from $host/releases/manta-latest.txt"
  manifest="$(curl -fsSL "$host/releases/manta-latest.txt")" \
    || die "self-update: manifest fetch failed: $host/releases/manta-latest.txt"

  resolve_arch
  TARBALL_FILE="$(manifest_get "$manifest" "file_${ARCH_KEY}")"
  TARBALL_SHA="$(manifest_get "$manifest" "sha256_${ARCH_KEY}")"
  TARBALL_VERSION="$(manifest_get "$manifest" "version")"
  TARBALL_GIT_SHA="$(manifest_get "$manifest" "git_sha")"
  if [ -z "$TARBALL_FILE" ] || [ -z "$TARBALL_SHA" ] || [ -z "$TARBALL_VERSION" ]; then
    die "self-update: manifest is malformed or has no ${ARCH_KEY} build"
  fi

  # Cheap early exit when already current — no download, no reinstall, no
  # restart. The decision itself lives in scripts/lib/release.sh so it can be
  # unit-tested; see release_is_current for why it compares the build's commit
  # rather than its version number. The exit is conditional on BOTH the box
  # being current AND no CLI having changed (BET-1016, generalised in BET-1097)
  # — a CLI-only upgrade must fall through to the restart below, never be
  # swallowed here.
  if should_skip_self_update "$INSTALLED_VERSION" "$INSTALLED_GIT_SHA" "$TARBALL_VERSION" "$TARBALL_GIT_SHA" "$CLIS_CHANGED_FLAG"; then
    if [ -n "$INSTALLED_GIT_SHA" ] && [ -n "$TARBALL_GIT_SHA" ]; then
      ok "self-update: already at $TARBALL_VERSION ($TARBALL_GIT_SHA)"
    else
      ok "self-update: already at $TARBALL_VERSION"
    fi
    exit 0
  fi

  # Split the payload decision from the early exit. `should_skip_self_update`
  # returns "carry on" for BOTH a stale box AND a current box whose CLI(s)
  # changed — so re-check `release_is_current` here to decide whether there is
  # actually a payload swap to do. This is the fix for the review Block:
  # PAYLOAD_REPLACED must reflect whether the payload ACTUALLY changed (box was
  # stale), not merely that the replace function ran. A current box with a
  # CLI-only upgrade must NOT set PAYLOAD_REPLACED — that would restart both
  # services and kill every running agent turn for no reason.
  if release_is_current "$INSTALLED_VERSION" "$INSTALLED_GIT_SHA" "$TARBALL_VERSION" "$TARBALL_GIT_SHA"; then
    # Box is already current; we only got here because a CLI changed. Fall
    # through to deps/tools/restart WITHOUT touching the payload.
    if [ -n "$TARBALL_GIT_SHA" ]; then
      ok "self-update: already at $TARBALL_VERSION ($TARBALL_GIT_SHA); CLI(s) updated → no payload swap"
    else
      ok "self-update: already at $TARBALL_VERSION; CLI(s) updated → no payload swap"
    fi
  else
    if [ -n "$INSTALLED_GIT_SHA" ] && [ -n "$TARBALL_GIT_SHA" ]; then
      log "self-update: new build $INSTALLED_GIT_SHA → $TARBALL_GIT_SHA"
    fi

    WORK="$(mktemp -d "${TMPDIR:-/tmp}/manta-update.XXXXXX")"
    trap 'rm -rf "$WORK"' EXIT

    log "self-update: downloading $host/releases/$TARBALL_FILE"
    curl -fsSL "$host/releases/$TARBALL_FILE" -o "$WORK/manta.tar.gz" \
      || die "self-update: download failed: $host/releases/$TARBALL_FILE"

    log "self-update: verifying tarball sha256…"
    verify_sha256 "$WORK/manta.tar.gz" "$TARBALL_SHA"

    log "self-update: extracting to $WORK/pkg…"
    mkdir "$WORK/pkg"
    tar -xzf "$WORK/manta.tar.gz" -C "$WORK/pkg" --strip-components=1 \
      || die "self-update: extract failed"

    # A torn/corrupt download must never overwrite a working install — confirm
    # the payload is complete before replacing anything.
    [ -f "$WORK/pkg/src/server/index.mjs" ] \
      || die "self-update: bad tarball — missing src/server/index.mjs"
    [ -f "$WORK/pkg/RELEASE.json" ] \
      || die "self-update: bad tarball — missing RELEASE.json"

    # Replace ONLY the paths the incoming release owns (`includes` in its
    # RELEASE.json — read from the INCOMING release, not the installed one, so a
    # box installed before a path joined the list still picks it up). This is a
    # single call into scripts/lib/release.sh: it stages each path as
    # `<dest>/<rel>.new` and swaps with `mv`, so a failed copy can never leave a
    # half-written tree — most important for `runtime/`, which the running server
    # executes from. It also stamps RELEASE.json so the box records its version.
    replace_release_payload "$WORK/pkg" "$MANTA_HOME" "$NODE_CMD"
    PAYLOAD_REPLACED=1
    # Report the commit alongside the version: two releases legitimately share a
    # version number now, so "0.0.29 → 0.0.29" alone reads like a no-op.
    if [ -n "$TARBALL_GIT_SHA" ]; then
      ok "self-update: replaced release payload ($INSTALLED_VERSION → $TARBALL_VERSION, commit $TARBALL_GIT_SHA)"
    else
      ok "self-update: replaced release payload ($INSTALLED_VERSION → $TARBALL_VERSION)"
    fi
  fi
fi

# --- Re-source the lib the swap just shipped (BET-1503) ----------------------
# This script sources scripts/lib/release.sh at the top, i.e. the copy that was
# on disk BEFORE the payload swap — so a helper added by the very release being
# installed is not defined in the running shell, and anything below that needs
# it would silently no-op until the NEXT update. Re-sourcing after the swap
# closes that one-update lag, and matches what install.sh already does (it
# re-sources the lib from MANTA_HOME once the tarball is extracted).
#
# Only functions are defined here (the file is documented to have no source-time
# side effects), so re-sourcing is a redefinition and nothing more. Guarded on
# the file existing so a release that somehow lacked it can't abort the update.
if [ "$PAYLOAD_REPLACED" = "1" ] && [ -f "$MANTA_HOME/scripts/lib/release.sh" ]; then
  . "$MANTA_HOME/scripts/lib/release.sh"
fi

echo "MANTA_PROGRESS 4/7 Installing dependencies"
install_prod_deps "$MANTA_HOME"

# --- Prepare OpenCode V2 (slice C3) ---------------------------------------------
# Replaces the V1 tool/plugin refresh steps that lived here and the
# old `opencode upgrade`. ONE idempotent routine — src/server/upgradeV2Prepare.mjs, shared with
# install.sh and manta-server's boot hook — now does it all:
#   * ~/.manta/opencode-password (0600) if absent
#   * the release's PINNED opencode binary → ~/.opencode/bin/opencode (integrity-checked; the
#     previous V1 binary is kept as opencode-v1 for rollback)
#   * the V2 plugins → ~/.config/opencode/plugins/
#   * Manta's V1 tools/plugins + the opencode-claude-auth config entry retired — unless a V1
#     history DB still has to be migrated, in which case that waits for the upgrade flow, the
#     service is pinned to the V1 binary, and manta-server runs the migration on its next boot.
# It never restarts anything: the conditional restart block below decides that. Non-fatal for a
# CLI-only update (nothing to prepare); fatal when it fails after a payload swap, because a box
# on a new release with half-installed V2 pieces is worse than a failed update.
echo "MANTA_PROGRESS 5/7 Preparing OpenCode"
MIGRATION_NEEDED=0
OPENCODE_BINARY_CHANGED=0
OPENCODE_PLUGINS_CHANGED=0
if [ -x "$NODE_CMD" ] && [ -f "$MANTA_HOME/src/server/upgradeV2Prepare.mjs" ]; then
  if PREPARE_OUT="$("$NODE_CMD" "$MANTA_HOME/src/server/upgradeV2Prepare.mjs" prepare --home "$MANTA_HOME")"; then
    eval "$PREPARE_OUT"
    log "self-update: OpenCode prepared (migration needed: $MIGRATION_NEEDED, binary changed: $OPENCODE_BINARY_CHANGED, plugins changed: $OPENCODE_PLUGINS_CHANGED)"
  elif [ "$PAYLOAD_REPLACED" = "1" ]; then
    die "self-update: preparing OpenCode V2 failed (see above) — the new release is on disk; re-run the update"
  else
    warn "self-update: preparing OpenCode V2 failed — continuing"
  fi
else
  warn "self-update: node or upgradeV2Prepare.mjs unavailable — skipping OpenCode preparation"
fi
# The restart plan treats "binary or plugins changed" like the old OPENCODE_CHANGED/PLUGINS_CHANGED.
OPENCODE_CHANGED="$OPENCODE_BINARY_CHANGED"
PLUGINS_CHANGED="$OPENCODE_PLUGINS_CHANGED"
# A box that still has V1 history to migrate must NOT have its opencode restarted by the update
# (opencode_restart_plan → "server"): the service is pinned to V1 and manta-server's boot hook
# (upgradeV2) restarts it itself, in order, once the disk preflight has passed.

# --- Sync opencode agent guidance (BET-640) -----------------------------------
# Appends any top-level `## ` guidance section that is missing from the user's
# AGENTS.md (replaces install.sh's old all-or-nothing marker check). Same lib
# function install.sh uses, so a section added after install lands on the next
# update without rewriting existing (possibly user-edited) sections.
sync_opencode_guidance "$MANTA_HOME/docs/opencode-tools/AGENTS.md" "${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/AGENTS.md"

# --- Conditional restarts (BET-1097) ------------------------------------------
# Replacing a CLI binary on Linux does NOT disturb a running process — a running
# opencode/claude session keeps the old version until it is next launched. So we
# restart ONLY what actually needs it:
#
#   | Condition                                     | Restart                |
#   |-----------------------------------------------|------------------------|
#   | box payload was replaced (git reset / tarball)| opencode AND server   |
#   | opencode changed, payload did not             | opencode only         |
#   | a manta opencode plugin changed, payload did not | opencode only      |
#   | only other CLIs changed                       | NOTHING               |
#
# `PAYLOAD_REPLACED` is the single flag set at the one place each install kind
# swaps its payload. `OPENCODE_CHANGED` / `PLUGINS_CHANGED` come from the OpenCode
# preparation step above (pinned binary / service definition / V2 plugins changed). The decision itself
# is `opencode_restart_plan` in scripts/lib/release.sh (unit-tested).
# A skipped step emits no MANTA_PROGRESS line; the bar jumps forward (the
# progress parser requires strictly-increasing steps).

restart_opencode() {
  # Restart opencode so refreshed tools are actually loaded. opencode only
  # re-scans its tools/ directory at startup, so without this an update leaves
  # the new tools inert on disk.
  #
  # BET-1503: bring the installed service definition up to date FIRST. A
  # supervisor stops a service using its currently-loaded definition, so the
  # patch has to land (and be reloaded) before the restart for this run's
  # restart to be the one that applies it. Units are written by install.sh and
  # never re-rendered here, so without this in-place patch the fix would reach
  # fresh installs only. Never fatal — see ensure_opencode_cli_version.
  # Guarded on the function existing: an OLD self-update.sh can reach a NEW
  # release.sh (and vice versa) across the swap above, and a missing helper
  # must degrade to the previous behaviour rather than kill the update.
  if declare -F ensure_opencode_cli_version >/dev/null 2>&1; then
    ensure_opencode_cli_version
  fi
  if command -v systemctl >/dev/null 2>&1; then
    echo "▸ self-update: restarting opencode-serve"
    systemctl --user restart opencode-serve || echo "⚠ self-update: opencode restart failed"
  elif [ "$(uname -s)" = "Darwin" ]; then
    echo "▸ self-update: kickstarting com.mantaui.opencode LaunchAgent"
    launchctl kickstart -k "gui/$(id -u)/com.mantaui.opencode" || echo "⚠ self-update: opencode restart failed"
  else
    echo "⚠ self-update: no systemctl/launchctl — restart opencode manually"
  fi
}

restart_server() {
  # Restart the supervisor that runs manta-server. Linux uses the systemd
  # --user unit (default since v1); macOS (BET-277) uses the LaunchAgent
  # installed by install.sh — `launchctl kickstart -k` kills any running
  # instance and starts a fresh one. Other hosts have no persistent
  # supervisor and the user is expected to restart by hand.
  if command -v systemctl >/dev/null 2>&1; then
    echo "▸ self-update: restarting manta-server.service"
    # BET-1192: patch the installed unit with KillMode=process (and
    # daemon-reload) BEFORE the restart. systemd stops the unit using the
    # currently-loaded config, so the patch must complete first — done this
    # way the FIRST upgrade to the fixed version already saves the user's
    # sessions instead of being the last update to destroy them.
    ensure_server_kill_policy
    systemctl --user restart manta-server.service
  elif [ "$(uname -s)" = "Darwin" ]; then
    echo "▸ self-update: kickstarting com.mantaui.server LaunchAgent"
    launchctl kickstart -k "gui/$(id -u)/com.mantaui.server"
  else
    echo "⚠ self-update: no systemctl/launchctl — restart manta-server manually"
  fi
}

# wait_server_healthy — after a payload swap + restart, confirm the box actually
# comes back up before we report the update as complete. Without this a release
# that won't boot would report "self-update: complete" on a dead box. This is a
# LOUD failure (die with guidance), not a rollback: rolling the payload back in
# place fights a self-replacing updater's two-hop hazard, so auto-restore is
# deliberately out of scope here (see the header's "Two-hop note").
wait_server_healthy() {
  local url="${MANTA_HEALTH_URL:-http://127.0.0.1:${MANTA_PORT:-8787}/auth/status}"
  local attempts="${SELF_UPDATE_HEALTH_ATTEMPTS:-40}"
  local i=1
  while [ "$i" -le "$attempts" ]; do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      ok "self-update: server healthy at $url (attempt $i)"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  warn "self-update: server did not become healthy at $url after ${attempts}s"
  die "server did not become healthy after the update — re-run install.sh to restore a matching prebuilt tree"
}

case "$(opencode_restart_plan "$PAYLOAD_REPLACED" "$OPENCODE_CHANGED" "$PLUGINS_CHANGED" "$MIGRATION_NEEDED")" in
  both)
    echo "MANTA_PROGRESS 6/7 Restarting opencode"
    restart_opencode
    echo "MANTA_PROGRESS 7/7 Restarting box server"
    restart_server
    # Confirm the new payload actually boots before reporting success.
    wait_server_healthy
    ;;
  server)
    echo "MANTA_PROGRESS 7/7 Restarting box server"
    restart_server
    wait_server_healthy
    ;;
  opencode)
    echo "MANTA_PROGRESS 6/7 Restarting opencode"
    restart_opencode
    ;;
  *)
    # Only other CLIs changed → restart nothing. Replacing a CLI binary does not
    # disturb a running process, so there is nothing to restart.
    echo "✓ self-update: CLI(s) updated; no restart needed (payload untouched, opencode and plugins unchanged)"
    ;;
esac

echo "✓ self-update: complete"
