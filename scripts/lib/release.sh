# scripts/lib/release.sh — shared release-resolution helpers + opencode agent
# guidance sync for the box install/update path (BET-640).
#
# SOURCED (not executed) by BOTH scripts/install.sh and scripts/self-update.sh,
# so it must define ONLY functions and never run anything at source time: no
# side effects, no `set -e`, no toplevel calls. Function bodies reference the
# `log`/`ok`/`warn`/`die` printing helpers that each CALLING script defines
# and owns (install.sh and self-update.sh each define their own copies, since
# a `curl … | bash` install can't share shell state with the box's scripts).
#
# These helpers used to be defined inline in install.sh; they are moved here so
# the two scripts never drift on arch resolution / manifest parsing / checksum
# verification — the exact drift that left packaged installs unable to run
# their own updater.
#
# NOTE (BET-640): adding a tool here still requires restarting opencode for it
# to register — opencode re-scans ~/.config/opencode/tools only at startup.
# These scripts restart manta-server, not opencode, and changing that is out
# of scope.

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
        *) die "unsupported Mac: $m — the MantaUI box installer supports Apple Silicon (arm64) Macs only.
      Intel Macs are not supported as a box. If you just want to USE MantaUI on this Mac,
      install the desktop app instead: https://mantaui.com/downloads/Manta-latest.dmg" ;;
      esac
      ;;
    *) die "unsupported OS: $s (the MantaUI box installer supports Linux and macOS/Apple Silicon)" ;;
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

# replace_release_payload <pkg-dir> <dest-dir> <node-bin>
#
# Replace every path the incoming release owns in <dest-dir> with the copy from
# the extracted tarball at <pkg-dir>, then stamp RELEASE.json itself so the box
# records the version it now runs.
#
# `includes` is read from <pkg-dir>/RELEASE.json — the INCOMING release, not the
# installed one. The incoming release is what knows which paths it owns, so a
# box installed before a path joined the list still picks that path up.
#
# Each path is staged as `<dest>/<rel>.new` and swapped in with `mv`, so a
# failed or interrupted copy can never leave a half-written tree. That matters
# most for `runtime`: the running manta-server executes from it. Deleting the
# directory out from under the running process is safe on Linux and macOS (the
# open binary's inode survives until the process exits) and the caller restarts
# the server at the end of the update.
#
# node-bin is passed in rather than read from a global so this function has no
# dependency on the caller's variable names.
replace_release_payload() {
  local pkg="$1" dest="$2" node_bin="$3" rel includes
  # Tells install_prod_deps whether this run already installed a prebuilt,
  # build-time-verified node_modules from the payload. Reset per call so a
  # caller can never inherit a stale "yes" from an earlier invocation.
  REPLACED_NODE_MODULES=0
  includes="$("$node_bin" -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).includes||[]; process.stdout.write(i.join("\n"))' "$pkg/RELEASE.json")" \
    || die "release payload: cannot read includes from $pkg/RELEASE.json"
  [ -n "$includes" ] || die "release payload: $pkg/RELEASE.json has an empty includes list"
  for rel in $includes; do
    [ -n "$rel" ] || continue
    [ -e "$pkg/$rel" ] || die "release payload: tarball is missing $rel"
    rm -rf "$dest/$rel.new"
    mkdir -p "$(dirname "$dest/$rel")"
    cp -R "$pkg/$rel" "$dest/$rel.new" || die "release payload: copy failed for $rel"
    rm -rf "$dest/$rel"
    mv "$dest/$rel.new" "$dest/$rel" || die "release payload: swap failed for $rel"
    [ "$rel" = "node_modules" ] && REPLACED_NODE_MODULES=1
  done
  cp "$pkg/RELEASE.json" "$dest/RELEASE.json"
}

# sync_opencode_guidance <src-agents-md> <dest-agents-md>
#
# Bring a box's ~/.config/opencode/AGENTS.md in sync with the tool guidance
# that ships with this release. We append each top-level `## ` section from
# the source to the destination ONLY if a line exactly matching that heading is
# not already present in the destination. Existing sections are left
# byte-for-byte alone — the user may have edited them, and this must NEVER
# rewrite their file. This replaces install.sh's old all-or-nothing marker
# check (which, once ANY manta section existed, never appended a later
# section — exactly how the delegation tool guidance never reached boxes
# installed before delegation shipped).
#
# Writes via a temp file + atomic `mv`, the same idiom install.sh already used.
# Non-fatal throughout: a missing source just logs a warning and returns.
sync_opencode_guidance() {
  local src="$1" dest="$2"
  if [ ! -f "$src" ]; then
    warn "sync_opencode_guidance: source not found: $src"
    return 0
  fi
  local tmp changed=0 section heading line
  tmp="$(mktemp "${TMPDIR:-/tmp}/manta-agents.XXXXXX")"
  [ -f "$dest" ] && cat "$dest" > "$tmp"
  section=""
  heading=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '##'*)
        if [ -n "$section" ]; then
          if ! grep -qFx -- "$heading" "$dest" 2>/dev/null; then
            [ -s "$tmp" ] && printf '\n' >> "$tmp"
            printf '%s' "$section" >> "$tmp"
            changed=1
          fi
        fi
        heading="$line"
        section="${line}
"
        ;;
      *)
        section="${section}${line}
"
        ;;
    esac
  done < "$src"
  if [ -n "$section" ]; then
    if ! grep -qFx -- "$heading" "$dest" 2>/dev/null; then
      [ -s "$tmp" ] && printf '\n' >> "$tmp"
      printf '%s' "$section" >> "$tmp"
      changed=1
    fi
  fi
  if [ "$changed" = "1" ]; then
    mkdir -p "$(dirname "$dest")"
    mv "$tmp" "$dest"
    ok "opencode AGENTS.md updated with new guidance sections."
  else
    rm -f "$tmp"
    ok "opencode AGENTS.md already current."
  fi
}

# install_prod_deps <dest-dir>
#
# Make <dest-dir>/node_modules correct for the box, NON-DESTRUCTIVELY (BET-829).
#
# WHY THIS IS NOT JUST `npm ci` ANY MORE
# --------------------------------------
# The old update step was a bare `npm ci --omit=dev --prefix <dest>`. `npm ci`
# DELETES node_modules before it installs, so every way it could fail left the
# box with no loadable `node-pty` — i.e. a manta-server that cannot start. It
# failed routinely:
#
#   * no `npm` on a service PATH (fixed by the PATH pin in self-update.sh);
#   * no C toolchain — a clean VPS has no `make`/`g++`, and install.sh never
#     installs one because the release tarball ships node_modules PREBUILT;
#   * a system npm bound to a different Node than the vendored runtime, which
#     "succeeds" while producing a binding for the wrong ABI;
#   * npm does not preserve the executable bit on node-pty's `spawn-helper`,
#     which pack.mjs explicitly repairs at build time and an on-box install
#     silently would not.
#
# So the release payload is the PREFERRED source: pack.mjs materializes an
# --omit=dev tree, repairs spawn-helper, and PROVES it by requiring node-pty
# through the vendored node for that exact arch. If the incoming release owns
# node_modules, replace_release_payload has already swapped that verified tree
# in and there is nothing to do here.
#
# `npm ci` remains the fallback for the cases with no payload to take deps
# from — a git-kind checkout, or a packaged box updating to a release built
# before node_modules joined `includes`. It is now wrapped so a failure is
# survivable: the existing tree is moved aside (a rename, so it is cheap and
# on the same filesystem) and restored if the install fails, leaving the box
# exactly as bootable as it was before the attempt.
install_prod_deps() {
  local dest="$1" backup="$1/node_modules.prev"

  # Set by replace_release_payload in THIS run when the incoming release owned
  # node_modules. Deliberately a run-scoped variable rather than a marker file
  # on disk: a marker would go stale the moment a box updated to a release that
  # did NOT ship node_modules, and we would then skip the install that release
  # actually needed.
  if [ "${REPLACED_NODE_MODULES:-0}" = "1" ]; then
    ok "self-update: prod deps came from the release payload (prebuilt, arch- and ABI-verified at build time)"
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    die "self-update: npm not found on PATH.
      The box vendors its own npm at \$MANTA_HOME/runtime/node/bin; if that
      directory is missing, the install is incomplete — re-run install.sh."
  fi

  log "self-update: reinstalling prod-only deps with npm ci"
  rm -rf "$backup"
  if [ -d "$dest/node_modules" ]; then
    mv "$dest/node_modules" "$backup" || die "self-update: could not set aside node_modules"
  fi

  if npm ci --omit=dev --prefix "$dest"; then
    rm -rf "$backup"
    ok "self-update: prod deps installed"
    return 0
  fi

  # Restore, so a box whose deps cannot be rebuilt here still starts. This is
  # the difference between "the update failed" and "the box is bricked".
  warn "self-update: npm ci failed — restoring the previous node_modules"
  rm -rf "$dest/node_modules"
  if [ -d "$backup" ]; then
    mv "$backup" "$dest/node_modules" || die "self-update: could not restore node_modules — box may not start; re-run install.sh"
    die "self-update: dependency install failed; previous node_modules restored.
      The box still runs, but it is now on new source with older deps — re-run
      install.sh to get a matching prebuilt tree."
  fi
  die "self-update: dependency install failed and there was no previous node_modules to restore — re-run install.sh"
}

# release_is_current <installed_version> <installed_git_sha> <release_version> <release_git_sha>
#
# Answers the one question the updater asks before downloading anything: is
# this box already running the published build? Returns 0 (skip the update) or
# 1 (there is something new).
#
# WHY THE COMMIT AND NOT THE VERSION: `version` comes from package.json and is
# maintained by hand. A release cut without bumping it was byte-for-byte
# indistinguishable from the installed one as far as this check could tell, so
# every box reported "already at <version>" and silently skipped a real update
# — no error, no signal, and no way to notice from the outside except that the
# fix never shipped. The commit a build came from is its true identity and
# needs no bookkeeping to stay correct.
#
# Both sides must supply a commit for it to be authoritative. When either is
# missing — a box installed before releases carried one, or a release packed
# outside a git checkout — fall back to comparing versions, which is exactly
# the previous behaviour and no worse.
#
# Pure: no I/O, no globals. Unit-tested in scripts/lib/release.test.mjs.
release_is_current() {
  installed_version="$1"
  installed_sha="$2"
  release_version="$3"
  release_sha="$4"

  if [ -n "$installed_sha" ] && [ -n "$release_sha" ]; then
    [ "$installed_sha" = "$release_sha" ]
    return $?
  fi

  # An empty installed version means we could not read RELEASE.json at all —
  # treat that as "not current" so the box repairs itself by reinstalling
  # rather than skipping forever on an unreadable stamp.
  if [ -z "$installed_version" ]; then
    return 1
  fi
  [ "$installed_version" = "$release_version" ]
}

# should_skip_self_update <installed_version> <installed_git_sha> <release_version> <release_git_sha> <clis_changed>
#
# The updater's EARLY-EXIT decision (BET-1016, generalised in BET-1097): skip the
# ENTIRE self-update (no download, no reinstall, no restart) only when BOTH the
# box release is current AND no CLI changed. When a CLI changed, the box must
# fall through to its restart step even if the tarball is current — otherwise a
# CLI-only upgrade would be swallowed by the cheap early exit and leave the
# upgraded (but un-restarted) binary inert until the next update.
#
# `clis_changed` is a flag (0 or 1) the caller sets from the upgrade-clis state
# file: 1 when ANY changed CLI is listed. opencode is just one row of the
# catalog; its restart is governed by the conditional restart block, not here.
#
# Returns 0 (skip) when the box is current AND no CLI changed; 1 (do not skip)
# otherwise. Pure: no I/O, no globals. Unit-tested in release.test.mjs
# alongside release_is_current.
should_skip_self_update() {
  installed_version="$1"
  installed_sha="$2"
  release_version="$3"
  release_sha="$4"
  clis_changed="$5"

  if release_is_current "$installed_version" "$installed_sha" "$release_version" "$release_sha" \
     && [ "$clis_changed" = "0" ]; then
    return 0
  fi
  return 1
}
