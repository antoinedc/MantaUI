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
