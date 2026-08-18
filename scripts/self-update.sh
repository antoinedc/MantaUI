#!/usr/bin/env bash
# self-update.sh — bring the box's manta-server code up to date, reinstall
# deps, refresh the opencode tools + agent guidance, restart the server.
#
# Wired up in BET-225 stage 2 (server-side update poller calls this on a
# cadence). Manual invocation also works — idempotent.
#
# Two kinds of box are supported (BET-640):
#
#   * git checkout (the maintainer's dev box): update = `git fetch origin main`
#     + `git reset --hard origin/main`.
#   * packaged install (every box created by `curl mantaui.com/install.sh`):
#     a plain directory with RELEASE.json (no .git). Update = download the
#     release tarball for this arch, verify it, extract it, and replace the
#     payload paths the incoming release owns (`includes` in RELEASE.json) —
#     which DOES include `runtime/` (the vendored Node, so a runtime version
#     bump can reach an installed box) but NOT `node_modules/` (which is
#     reinstalled by the `npm ci --omit=dev` step that runs immediately after).
#
# The install kind is detected, not assumed, so a box installed before the
# updater understood packaged installs (or whose git fetch fails) self-heals.
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
echo "MANTA_PROGRESS 1/7 Checking for updates"
if [ -d "$MANTA_HOME/.git" ]; then
  INSTALL_KIND=git
elif [ -f "$MANTA_HOME/RELEASE.json" ]; then
  INSTALL_KIND=packaged
else
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
# Non-fatal throughout, mirroring refresh_opencode_tools(): an offline box, a
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

echo "MANTA_PROGRESS 4/7 Installing dependencies"
install_prod_deps "$MANTA_HOME"

# --- Refresh the manta-native opencode tools --------------------------------
# The AI-facing tool sources (docs/opencode-tools/*.ts) are COPIED into
# ~/.config/opencode/tools/ rather than symlinked — opencode resolves a tool's
# imports from the file's REAL path, so a symlink back into the checkout misses
# ~/.config/opencode/node_modules/@opencode-ai/plugin and the tool silently
# never registers.
#
# WHY THIS IS HERE: install.sh does that copy, but ONLY on install. Nothing in
# the update path did, so updating the SOURCE while every box kept running
# whatever tool copy it was installed with left tool updates undeliverable to
# an existing box (BET-344 / BET-640 background delegation).
#
# Non-fatal throughout: a tool copy failing must never abort an update that has
# already updated the checkout and reinstalled deps.
#
# NOTE: we deliberately do NOT restart opencode here. Picking up a new tool
# needs an opencode restart, but that kills every in-flight agent turn on the
# box. Staging the files is safe and unconditional; they take effect at the
# next opencode restart, and we say so.
refresh_opencode_tools() {
  local src="$MANTA_HOME/docs/opencode-tools"
  local dest="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/tools"

  if [ ! -d "$src" ]; then
    echo "⚠ self-update: $src not found — skipping opencode tool refresh"
    return 0
  fi
  if ! mkdir -p "$dest" 2>/dev/null; then
    echo "⚠ self-update: cannot create $dest — skipping opencode tool refresh"
    return 0
  fi

  # EXCLUDE *.test.ts: opencode loads EVERY file in tools/ as a tool, and a
  # test file imports vitest (absent under ~/.config/opencode/node_modules),
  # which makes tool resolution throw and every chat turn fail with
  # "Cannot find package 'vitest'". Same exclusion as install.sh.
  local copied=0 changed=0 tool base
  for tool in "$src"/*.ts; do
    case "$tool" in
      *.test.ts) continue ;;
    esac
    [ -e "$tool" ] || continue
    base="$(basename "$tool")"
    if ! cmp -s "$tool" "$dest/$base" 2>/dev/null; then
      changed=$((changed + 1))
    fi
    if cp -f "$tool" "$dest/" 2>/dev/null; then
      copied=$((copied + 1))
    else
      echo "⚠ self-update: failed to copy opencode tool $base"
    fi
  done

  if [ "$copied" = "0" ]; then
    echo "⚠ self-update: no opencode tool sources found in $src"
    return 0
  fi
  if [ "$changed" = "0" ]; then
    echo "✓ self-update: opencode tools already current ($copied checked)"
    return 0
  fi
  echo "✓ self-update: opencode tools refreshed ($changed of $copied changed)"
}

echo "MANTA_PROGRESS 5/7 Refreshing AI tools"
refresh_opencode_tools

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
#   | only other CLIs changed                       | NOTHING               |
#
# `PAYLOAD_REPLACED` is the single flag set at the one place each install kind
# swaps its payload. `OPENCODE_CHANGED` comes from the upgrade-clis state file.
# A skipped step emits no MANTA_PROGRESS line; the bar jumps forward (the
# progress parser requires strictly-increasing steps).

restart_opencode() {
  # Restart opencode so refreshed tools are actually loaded. opencode only
  # re-scans its tools/ directory at startup, so without this an update leaves
  # the new tools inert on disk.
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
    systemctl --user restart manta-server.service
  elif [ "$(uname -s)" = "Darwin" ]; then
    echo "▸ self-update: kickstarting com.mantaui.server LaunchAgent"
    launchctl kickstart -k "gui/$(id -u)/com.mantaui.server"
  else
    echo "⚠ self-update: no systemctl/launchctl — restart manta-server manually"
  fi
}

if [ "$PAYLOAD_REPLACED" = "1" ]; then
  echo "MANTA_PROGRESS 6/7 Restarting opencode"
  restart_opencode
  echo "MANTA_PROGRESS 7/7 Restarting box server"
  restart_server
elif [ "$OPENCODE_CHANGED" = "1" ]; then
  echo "MANTA_PROGRESS 6/7 Restarting opencode"
  restart_opencode
else
  # Only other CLIs changed → restart nothing. Replacing a CLI binary does not
  # disturb a running process, so there is nothing to restart.
  echo "✓ self-update: CLI(s) updated; no restart needed (payload untouched, opencode unchanged)"
fi

echo "✓ self-update: complete"
