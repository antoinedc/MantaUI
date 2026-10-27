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

# detect_install_kind <has_release_json> <has_git>
#
# Decide which update path a box takes: `packaged` (release tarball -> prebuilt
# node_modules, no on-box build) or `git` (a live dev checkout -> git reset +
# on-box npm).
#
# RELEASE.json is the ground truth for a RELEASE-DEPLOYED box and therefore
# WINS over an incidental .git/. install.sh makes every box it creates a git
# checkout (deploy_git_checkout) so the box can self-update, but such a box's
# source+deps come from the release tarball and it has no toolchain — misreading
# it as a dev git box sends it down the git path, which rebuilds node_modules on
# the box and fails with no compiler (the "re-run install.sh to get a matching
# prebuilt tree" brick). Only a checkout with NO RELEASE.json is a true dev box.
#
# Pure: both inputs are caller-computed booleans, so this is unit-testable.
detect_install_kind() { # $1=has_release_json $2=has_git
  if [ "$1" = "1" ]; then
    printf 'packaged'
  elif [ "$2" = "1" ]; then
    printf 'git'
  else
    printf 'none'
  fi
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
# require_free_space <pkg-dir> <dest-dir>
#
# Refuse the payload swap when <dest-dir> cannot hold another copy of the
# extracted payload. replace_release_payload stages each path as `<rel>.new`
# BEFORE deleting the old one, so an update transiently needs roughly the
# payload's size in free space on top of what is already installed. Without
# this the swap dies halfway through with an ENOSPC from `cp`.
#
# Deliberately NON-FATAL when either probe fails (no `du`, no `df`, an unusual
# mount): a preflight must never become a new way for a healthy update to fail.
# Both probes are asked for KB so the units already agree.
require_free_space() {
  local pkg="$1" dest="$2" need avail
  need="$(du -sk "$pkg" 2>/dev/null | awk '{print $1}')"
  avail="$(df -Pk "$dest" 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$need" ] && [ -n "$avail" ] || return 0
  case "$need" in *[!0-9]*) return 0 ;; esac
  case "$avail" in *[!0-9]*) return 0 ;; esac
  [ "$avail" -ge "$need" ] || die "release payload: not enough disk space at $dest — need $((need / 1024)) MB free, have $((avail / 1024)) MB. Free up space and run the update again."
}

# node-bin is passed in rather than read from a global so this function has no
# dependency on the caller's variable names.
replace_release_payload() {
  local pkg="$1" dest="$2" node_bin="$3" rel includes cp_err mv_err
  # Tells install_prod_deps whether this run already installed a prebuilt,
  # build-time-verified node_modules from the payload. Reset per call so a
  # caller can never inherit a stale "yes" from an earlier invocation.
  REPLACED_NODE_MODULES=0
  includes="$("$node_bin" -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).includes||[]; process.stdout.write(i.join("\n"))' "$pkg/RELEASE.json")" \
    || die "release payload: cannot read includes from $pkg/RELEASE.json"
  [ -n "$includes" ] || die "release payload: $pkg/RELEASE.json has an empty includes list"
  require_free_space "$pkg" "$dest"
  for rel in $includes; do
    [ -n "$rel" ] || continue
    [ -e "$pkg/$rel" ] || die "release payload: tarball is missing $rel"
    rm -rf "$dest/$rel.new"
    mkdir -p "$(dirname "$dest/$rel")"
    cp_err="$(cp -R "$pkg/$rel" "$dest/$rel.new" 2>&1)" || die "release payload: copy failed for $rel: $cp_err"
    rm -rf "$dest/$rel"
    mv_err="$(mv "$dest/$rel.new" "$dest/$rel" 2>&1)" || die "release payload: swap failed for $rel: $mv_err"
    [ "$rel" = "node_modules" ] && REPLACED_NODE_MODULES=1
  done
  cp "$pkg/RELEASE.json" "$dest/RELEASE.json"
}

# sync_opencode_guidance <src-agents-md> <dest-agents-md>
#
# Bring a box's ~/.config/opencode/AGENTS.md in sync with the tool guidance that
# ships with this release. Every top-level `## ` section of <src> is compared
# with <dest>:
#
#   * missing                          -> appended
#   * present and identical            -> nothing
#   * present, differs, and the box copy is a version Manta itself shipped
#     (manifest of what this sync last wrote, or docs/opencode-tools/
#     AGENTS.history = every version ever committed) -> REPLACED in place
#   * present, differs, not a known Manta version (the user edited it)
#                                      -> left alone, with a warning
#   * absent under its current heading but present under an OLD heading listed
#     in docs/opencode-tools/AGENTS.aliases (a rename) -> the pristine old copy
#     is replaced/removed so no stale duplicate is left behind
#
# Sections Manta never shipped, and the text before the first `## `, are never
# touched. Spec: docs/superpowers/specs/2026-10-27-guidance-section-refresh.md.
# The parser contract (section split, fences, canonical hash) is shared with
# scripts/release/guidance-history.mjs — keep the two in lockstep.
#
# Whole-file writes go through a temp file in the destination directory + `mv`;
# the guidance is committed first, then the manifest. Non-fatal throughout
# (always returns 0, warns on failure): this runs inside callers that use
# `set -euo pipefail`, so every step is checked explicitly.
sync_opencode_guidance() {
  local src="$1" dest="$2" work rc=0
  if [ ! -f "$src" ]; then
    warn "sync_opencode_guidance: source not found: $src"
    return 0
  fi
  if ! work="$(mktemp -d "${TMPDIR:-/tmp}/manta-guidance.XXXXXX" 2>/dev/null)"; then
    warn "sync_opencode_guidance: cannot create a scratch directory; guidance left unchanged"
    return 0
  fi
  _guidance_sync_run "$src" "$dest" "$work" || rc=$?
  rm -rf "$work"
  if [ "$rc" -ne 0 ]; then
    warn "sync_opencode_guidance: could not update $dest; left unchanged"
  fi
  return 0
}

# _guidance_split <file> <out-prefix>
# Parse <file> per the shared contract. Writes each section's canonical bytes to
# "<out-prefix>.<n>.body" and prints one "n<TAB>start<TAB>end<TAB>heading" line
# per section (1-based file lines; end includes trailing blank lines).
_guidance_split() {
  awk -v outp="$2" '
    function fence_run(l,   i, j, c) {
      F_CHAR = ""; F_LEN = 0; F_REST = ""
      i = 1
      while (substr(l, i, 1) == " ") i++
      if (i - 1 > 3) return 0
      c = substr(l, i, 1)
      if (c != "`" && c != "~") return 0
      j = i
      while (substr(l, j, 1) == c) j++
      if (j - i < 3) return 0
      F_CHAR = c; F_LEN = j - i; F_REST = substr(l, j)
      return 1
    }
    function flush(endl,   k, last, f) {
      if (n == 0) return
      last = cnt
      while (last > 0 && body[last] ~ /^[ \t]*$/) last--
      f = outp "." n ".body"
      for (k = 1; k <= last; k++) print body[k] > f
      close(f)
      printf "%d\t%d\t%d\t%s\n", n, startl, endl, head
    }
    BEGIN { n = 0; cnt = 0; infence = 0 }
    {
      line = $0
      sub(/\r$/, "", line)
      isstart = 0
      if (infence) {
        if (fence_run(line) && F_CHAR == fch && F_LEN >= flen && F_REST ~ /^[ \t]*$/) infence = 0
      } else if (substr(line, 1, 3) == "## ") {
        isstart = 1
      } else if (fence_run(line)) {
        infence = 1; fch = F_CHAR; flen = F_LEN
      }
      if (isstart) {
        flush(NR - 1)
        n++; startl = NR; cnt = 0
        head = line; sub(/[ \t\r]+$/, "", head)
      }
      if (n > 0) body[++cnt] = line
    }
    END { flush(NR) }
  ' "$1"
}

# _guidance_hash_index <idx> <out-prefix> <out-file>
# Append the sha256 of each section's canonical body as a 5th column.
_guidance_hash_index() {
  local n s e h hash
  : > "$3" || return 1
  while IFS=$'\t' read -r n s e h; do
    [ -n "$n" ] || continue
    hash="$(_sha256_of "$2.$n.body")" || return 1
    [ -n "$hash" ] || return 1
    printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$s" "$e" "$h" "$hash" >> "$3" || return 1
  done < "$1"
}

# _guidance_find <hashed-idx> <heading> — print the index lines with that heading.
_guidance_find() {
  GS_H="$2" awk -F'\t' '$4 == ENVIRON["GS_H"]' "$1"
}

# _guidance_known <heading> <hash> <file>... — 0 when a "<heading>\t<hash>" line
# is present verbatim in any of the files.
_guidance_known() {
  local line f
  line="$1"$'\t'"$2"
  shift 2
  for f in "$@"; do
    if grep -Fxq -- "$line" "$f" 2>/dev/null; then return 0; fi
  done
  return 1
}

# _guidance_apply <dest-or-/dev/null> <sorted-plan> <append-file-or-empty> <nofinal 0|1>
# Rewrite <dest> to stdout. Plan lines: start<TAB>end<TAB>R|D<TAB>file<TAB>blank.
# R replaces the line span with <file>'s lines (+ one blank line when blank=1),
# D deletes it. Every other line is copied byte for byte.
_guidance_apply() {
  GS_NOFINAL="$4" awk -v plan="$2" -v appendf="$3" '
    function emit(s) {
      if (started) printf "\n"
      printf "%s", s
      started = 1
      lastline = s
    }
    BEGIN {
      np = 0; cur = 1; started = 0; lastorig = 0; lastline = ""
      while ((getline pl < plan) > 0) {
        np++
        split(pl, a, "\t")
        ps[np] = a[1] + 0; pe[np] = a[2] + 0; pa[np] = a[3]; pf[np] = a[4]; pb[np] = a[5]
      }
      close(plan)
    }
    {
      lastorig = 0
      if (cur <= np && NR >= ps[cur] && NR <= pe[cur]) {
        if (NR == ps[cur] && pa[cur] == "R") {
          while ((getline fl < pf[cur]) > 0) emit(fl)
          close(pf[cur])
          if (pb[cur] == "1") emit("")
        }
        if (NR == pe[cur]) cur++
        next
      }
      emit($0)
      lastorig = 1
    }
    END {
      if (appendf != "") {
        if (started && lastline !~ /^[ \t\r]*$/) emit("")
        while ((getline fl < appendf) > 0) emit(fl)
        close(appendf)
        lastorig = 0
      }
      if (started && !(ENVIRON["GS_NOFINAL"] == "1" && lastorig)) printf "\n"
    }
  ' "$1"
}

_guidance_sync_run() { # $1=src $2=dest $3=scratch dir
  local src="$1" dest="$2" work="$3"
  local tab=$'\t' srcdir state manifest hist aliases
  srcdir="$(dirname "$src")"
  hist="$srcdir/AGENTS.history"
  aliases="$srcdir/AGENTS.aliases"
  case "${MANTA_STATE_HOME-}" in
    *[![:space:]]*) state="$MANTA_STATE_HOME" ;;
    *) state="$HOME" ;;
  esac
  manifest="$state/.manta/opencode-guidance.manifest"

  # Lookup tables (CR stripped so a CRLF checkout of the data files still works).
  if [ -f "$hist" ]; then tr -d '\r' < "$hist" > "$work/history" || return 1; else : > "$work/history"; fi
  if [ -f "$aliases" ]; then tr -d '\r' < "$aliases" > "$work/aliases" || return 1; else : > "$work/aliases"; fi
  if [ -f "$manifest" ]; then tr -d '\r' < "$manifest" > "$work/manifest.old" || return 1; else : > "$work/manifest.old"; fi

  _guidance_split "$src" "$work/src" > "$work/src.idx" || return 1
  _guidance_hash_index "$work/src.idx" "$work/src" "$work/src.hidx" || return 1
  local destsrc="/dev/null" nofinal=0
  if [ -f "$dest" ]; then
    destsrc="$dest"
    if [ -s "$dest" ] && [ -n "$(tail -c 1 "$dest")" ]; then nofinal=1; fi
  fi
  _guidance_split "$destsrc" "$work/dest" > "$work/dest.idx" || return 1
  _guidance_hash_index "$work/dest.idx" "$work/dest" "$work/dest.hidx" || return 1
  local dtotal
  dtotal="$(grep -c '' "$work/dest.hidx" 2>/dev/null || true)"
  dtotal="${dtotal:-0}"

  # Shipped duplicates are ambiguous: skip those headings entirely.
  awk -F'\t' '{ c[$4]++ } END { for (h in c) if (c[h] > 1) print h }' "$work/src.hidx" > "$work/src.dups" || return 1
  local dup
  while IFS= read -r dup; do
    [ -n "$dup" ] || continue
    warn "opencode guidance: the shipped AGENTS.md repeats the heading \"$dup\"; skipping it"
  done < "$work/src.dups"

  : > "$work/plan.raw"; : > "$work/append"; : > "$work/rec"; : > "$work/claimed"
  local n_app=0 n_ref=0 n_del=0
  local sn ss se H hB m cnt dn ds de dh dhash flag
  local preds A pm pcnt pn ps_ pe_ ph phash pris edited ambig first
  while IFS=$'\t' read -r sn ss se H hB; do
    [ -n "$sn" ] || continue
    case "$H" in *"$tab"*) continue ;; esac
    if grep -Fxq -- "$H" "$work/src.dups" 2>/dev/null; then continue; fi

    m="$(_guidance_find "$work/dest.hidx" "$H")" || return 1
    cnt=0
    if [ -n "$m" ]; then cnt=1; case "$m" in *$'\n'*) cnt=2 ;; esac; fi
    if [ "$cnt" -gt 1 ]; then
      warn "opencode guidance: \"$H\" appears more than once in $dest; left unchanged"
      continue
    fi

    # Predecessors: every alias OLD -> H whose heading exists in dest.
    : > "$work/pris"; edited=""; ambig=""
    preds="$(GS_H="$H" awk -F'\t' '$2 == ENVIRON["GS_H"] && $1 != "" { print $1 }' "$work/aliases")" || return 1
    while IFS= read -r A; do
      [ -n "$A" ] || continue
      [ "$A" != "$H" ] || continue
      if [ -n "$(_guidance_find "$work/src.hidx" "$A")" ]; then continue; fi
      pm="$(_guidance_find "$work/dest.hidx" "$A")" || return 1
      [ -n "$pm" ] || continue
      pcnt=1; case "$pm" in *$'\n'*) pcnt=2 ;; esac
      if [ "$pcnt" -gt 1 ]; then ambig="$ambig \"$A\""; continue; fi
      IFS=$'\t' read -r pn ps_ pe_ ph phash <<< "$pm"
      if grep -Fxq -- "$pn" "$work/claimed" 2>/dev/null; then continue; fi
      if _guidance_known "$A" "$phash" "$work/manifest.old" "$work/history"; then
        printf '%s\t%s\t%s\t%s\n' "$ps_" "$pe_" "$pn" "$A" >> "$work/pris" || return 1
      else
        edited="$edited \"$A\""
      fi
    done <<< "$preds"
    [ -s "$work/pris" ] && LC_ALL=C sort -n -t "$tab" -k1,1 "$work/pris" > "$work/pris.sorted" && mv "$work/pris.sorted" "$work/pris" || true

    if [ "$cnt" -eq 1 ]; then
      IFS=$'\t' read -r dn ds de dh dhash <<< "$m"
      if [ "$dhash" = "$hB" ]; then
        printf '%s\t%s\n' "$H" "$hB" >> "$work/rec" || return 1
      elif _guidance_known "$H" "$dhash" "$work/manifest.old" "$work/history"; then
        flag=0; [ "$dn" -lt "$dtotal" ] && flag=1
        printf '%s\t%s\tR\t%s\t%s\n' "$ds" "$de" "$work/src.$sn.body" "$flag" >> "$work/plan.raw" || return 1
        printf '%s\n' "$dn" >> "$work/claimed" || return 1
        printf '%s\t%s\n' "$H" "$hB" >> "$work/rec" || return 1
        n_ref=$((n_ref + 1))
      else
        warn "opencode guidance: you edited \"$H\" in $dest; not updated (delete that section to get the shipped version)"
      fi
      # Rule 4: the current heading is present, so pristine predecessors are stale duplicates.
      while IFS=$'\t' read -r ps_ pe_ pn A; do
        [ -n "$pn" ] || continue
        printf '%s\t%s\tD\t-\t0\n' "$ps_" "$pe_" >> "$work/plan.raw" || return 1
        printf '%s\n' "$pn" >> "$work/claimed" || return 1
        n_del=$((n_del + 1))
      done < "$work/pris"
      [ -z "$edited$ambig" ] || warn "opencode guidance: old section(s)$edited$ambig left in place (edited or ambiguous) next to \"$H\""
    else
      if [ ! -s "$work/pris" ] && [ -z "$edited$ambig" ]; then
        if [ -s "$work/append" ]; then printf '\n' >> "$work/append" || return 1; fi
        cat "$work/src.$sn.body" >> "$work/append" || return 1
        printf '%s\t%s\n' "$H" "$hB" >> "$work/rec" || return 1
        n_app=$((n_app + 1))
      elif [ -n "$edited$ambig" ]; then
        warn "opencode guidance: \"$H\" not applied: old section(s)$edited$ambig were edited or are ambiguous; left unchanged"
      else
        first=1
        while IFS=$'\t' read -r ps_ pe_ pn A; do
          [ -n "$pn" ] || continue
          if [ "$first" = "1" ]; then
            first=0
            flag=0; [ "$pn" -lt "$dtotal" ] && flag=1
            printf '%s\t%s\tR\t%s\t%s\n' "$ps_" "$pe_" "$work/src.$sn.body" "$flag" >> "$work/plan.raw" || return 1
            n_ref=$((n_ref + 1))
          else
            printf '%s\t%s\tD\t-\t0\n' "$ps_" "$pe_" >> "$work/plan.raw" || return 1
            n_del=$((n_del + 1))
          fi
          printf '%s\n' "$pn" >> "$work/claimed" || return 1
        done < "$work/pris"
        printf '%s\t%s\n' "$H" "$hB" >> "$work/rec" || return 1
      fi
    fi
  done < "$work/src.hidx"

  local committed=0 gdir stage appendarg=""
  if [ -s "$work/plan.raw" ] || [ -s "$work/append" ]; then
    LC_ALL=C sort -n -t "$tab" -k1,1 "$work/plan.raw" > "$work/plan" || return 1
    [ -s "$work/append" ] && appendarg="$work/append"
    gdir="$(dirname "$dest")"
    mkdir -p "$gdir" || return 1
    stage="$(mktemp "$gdir/.AGENTS.md.XXXXXX")" || return 1
    if [ -f "$dest" ]; then
      cp -p "$dest" "$stage" || { rm -f "$stage"; return 1; }
    else
      chmod 644 "$stage" || { rm -f "$stage"; return 1; }
    fi
    _guidance_apply "$destsrc" "$work/plan" "$appendarg" "$nofinal" > "$stage" || { rm -f "$stage"; return 1; }
    mv "$stage" "$dest" || { rm -f "$stage"; return 1; }
    committed=1
  fi

  # Manifest: one line per heading, the version this sync last wrote/confirmed.
  GS_RECF="$work/rec" awk -F'\t' '
    BEGIN { while ((getline l < ENVIRON["GS_RECF"]) > 0) { split(l, a, "\t"); drop[a[1]] = 1 } }
    !($1 in drop)
  ' "$work/manifest.old" > "$work/manifest.new" || return 0
  cat "$work/rec" >> "$work/manifest.new" || return 0
  LC_ALL=C sort -u "$work/manifest.new" > "$work/manifest.sorted" || return 0
  local mchanged=0
  if [ -f "$manifest" ]; then
    cmp -s "$work/manifest.sorted" "$manifest" || mchanged=1
  elif [ -s "$work/manifest.sorted" ]; then
    mchanged=1
  fi
  if [ "$mchanged" = "1" ]; then
    local mdir mstage
    mdir="$(dirname "$manifest")"
    if mkdir -p "$mdir" \
       && mstage="$(mktemp "$mdir/.opencode-guidance.manifest.XXXXXX")" \
       && cat "$work/manifest.sorted" > "$mstage" \
       && chmod 644 "$mstage" \
       && mv "$mstage" "$manifest"; then
      :
    else
      [ -z "${mstage:-}" ] || rm -f "$mstage"
      warn "opencode guidance: could not record $manifest; the next update will re-evaluate the sections"
    fi
  fi

  if [ "$committed" = "1" ]; then
    ok "opencode AGENTS.md updated ($n_app added, $n_ref refreshed, $n_del stale removed)."
  else
    ok "opencode AGENTS.md already current."
  fi
  return 0
}

# write_previous_release <file> <git_sha> <version>
#
# Record the release a box is ABOUT TO REPLACE, so a failed V1 → V2 upgrade can put it back
# (`self-update.sh --to <sha>`, driven by src/server/upgradeV2.mjs rollback). Written BEFORE the
# payload swap — afterwards the old RELEASE.json / HEAD is gone. JSON `{git_sha, version, at}`,
# temp file + mv, 0600. No sha → writes nothing and returns 1 (a box installed before releases
# carried a commit cannot be rolled back by commit; the caller says so rather than inventing one).
# Values are restricted to safe characters, so plain printf JSON is exact.
write_previous_release() {
  local file="$1" sha="$2" version="$3" tmp
  case "$sha" in ''|*[!0-9a-fA-F]*) return 1 ;; esac
  case "$version" in *[!0-9A-Za-z.+_-]*) version="" ;; esac
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 1
  tmp="$file.tmp.$$"
  printf '{"git_sha":"%s","version":"%s","at":"%s"}\n' "$sha" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp" 2>/dev/null \
    && chmod 600 "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$file" 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null; return 1; }
}

# release_sha_matches <wanted> <actual> — a (possibly abbreviated) commit matches a full one when
# either is a prefix of the other and both are non-empty hex of >= 7 chars. Pure.
release_sha_matches() {
  local want="$1" have="$2"
  case "$want$have" in *[!0-9a-fA-F]*) return 1 ;; esac
  [ "${#want}" -ge 7 ] && [ "${#have}" -ge 7 ] || return 1
  case "$have" in "$want"*) return 0 ;; esac
  case "$want" in "$have"*) return 0 ;; esac
  return 1
}

# opencode_restart_plan <payload_replaced> <opencode_changed> <plugins_changed> [migration_pending]
#
# The updater's conditional-restart decision, extracted so it is testable.
# Echoes exactly one of:
#   both      the box payload was replaced → restart opencode AND the server
#   opencode  payload untouched, but opencode itself or a plugin changed
#             (opencode loads plugins only at startup) → opencode only
#   server    a V1 → V2 migration is pending → restart ONLY the server: the
#             opencode service is pinned to the V1 binary until manta-server's
#             upgrade flow (src/server/upgradeV2.mjs) takes it through the disk
#             preflight and the migration in order, so the updater must not
#             bounce it (that would also end running turns for nothing)
#   none      nothing that needs a restart changed
# Pure: no I/O, no globals.
opencode_restart_plan() {
  if [ "${4:-0}" = "1" ]; then
    if [ "$1" = "1" ]; then echo server; else echo none; fi
  elif [ "$1" = "1" ]; then
    echo both
  elif [ "$2" = "1" ] || [ "$3" = "1" ]; then
    echo opencode
  else
    echo none
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
    mv "$backup" "$dest/node_modules" || die "self-update: could not restore node_modules — server may not start; re-run install.sh"
    die "self-update: dependency install failed; previous node_modules restored.
      The server still runs, but it is now on new source with older deps — re-run
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

# ensure_kill_policy_text — echo unit text with `KillMode=process` present in
# [Service] exactly once. Idempotent, and NEVER overrides an existing
# KillMode= line whatever its value (an operator's explicit choice wins).
# $1 = full unit file text. Behaviour, exhaustively:
#   * text already containing any line matching `^KillMode=` -> echo unchanged,
#     byte for byte
#   * otherwise -> insert `KillMode=process` on the line immediately after
#     [Service]
#   * no [Service] section at all -> echo unchanged (nothing safe to do)
ensure_kill_policy_text() {
  local text="$1" line
  # Already carries a KillMode line (whatever its value) -> leave byte-for-byte.
  if printf '%s\n' "$text" | grep -q '^KillMode='; then
    printf '%s' "$text"
    return 0
  fi
  # No [Service] section -> nothing safe to anchor the insert on.
  if ! printf '%s\n' "$text" | grep -q '^\[Service\]'; then
    printf '%s' "$text"
    return 0
  fi
  # Insert KillMode=process on the line immediately after [Service]. sed keeps
  # every other byte (and trailing newline) untouched, so the insert is exact
  # and re-applying is a no-op (the next run sees ^KillMode= and returns early).
  printf '%s' "$text" | sed '/^\[Service\]$/a KillMode=process'
  return 0
}

# ensure_server_kill_policy — patch the INSTALLED systemd unit in place if
# needed and daemon-reload so the NEXT restart uses it. Never fatal: the worst
# case on any failure is the pre-existing behaviour (sessions destroyed by the
# restart), which is no worse than not running this at all.
# $1 = unit path, default $HOME/.config/systemd/user/manta-server.service.
# Behaviour, exhaustively:
#   * unit file missing (macOS, nohup fallback) -> return 0, write nothing
#   * patched text identical to current text -> return 0, do NOT write, do NOT
#     daemon-reload
#   * text changed -> write it back, `systemctl --user daemon-reload`, log once
#   * any failure (unwritable file, daemon-reload non-zero) -> warn, return 0
ensure_server_kill_policy() {
  local unit="${1:-$HOME/.config/systemd/user/manta-server.service}"
  local current patched
  [ -f "$unit" ] || return 0
  if ! current="$(cat "$unit")"; then
    warn "ensure_server_kill_policy: could not read $unit"
    return 0
  fi
  patched="$(ensure_kill_policy_text "$current")" || return 0
  if [ "$patched" = "$current" ]; then
    return 0
  fi
  if ! printf '%s' "$patched" > "$unit"; then
    warn "ensure_server_kill_policy: could not write $unit"
    return 0
  fi
  if ! systemctl --user daemon-reload; then
    warn "ensure_server_kill_policy: daemon-reload failed for $unit"
    return 0
  fi
  log "manta-server unit patched with KillMode=process ($unit)"
  return 0
}

# ---------------------------------------------------------------------------
# Claude Code version claimed to Anthropic (BET-1503)
# ---------------------------------------------------------------------------
#
# opencode reaches Anthropic through the `opencode-claude-auth` plugin, which
# authenticates as Claude Code and therefore sends a Claude Code version in its
# user-agent + billing headers. That version is HARDCODED in the plugin
# (`config.ccVersion`) and lags badly: the cached `@latest` on a live box was
# 2.1.185 and even the newest published release claims 2.1.217.
#
# Anthropic gates new models on a minimum client version, and REFUSES the
# request outright when the claim is below it — "Claude Code <x> does not
# support this model; version <y> or newer is required". So an out-of-date
# claim makes a model the user is entitled to simply unusable, with an error
# that misdirects them into updating a CLI that is already current.
#
# The plugin reads `ANTHROPIC_CLI_VERSION` from its environment and prefers it
# over the hardcoded value, so the box sets it on the opencode service.
#
# DO NOT let this become a pinned constant that needs a release every time
# Anthropic raises the floor. The value is DERIVED at install/update time from
# the real `claude` CLI on the box, which self-update already keeps current
# (unpinned, upgraded on every run) — so the claim tracks the CLI on its own.
# The floor below is only the fallback for a box where that CLI is absent
# (install.sh no longer installs it — the app does, lazily, on first Claude
# sign-in) or is itself too old to satisfy the current gate.

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

# ensure_cli_version_text <unit-text> <version> — echo systemd unit text
# carrying `Environment=ANTHROPIC_CLI_VERSION=<version>` in [Service].
# Idempotent and monotonic. Behaviour, exhaustively:
#   * an existing line whose value is >= <version> -> echo unchanged, byte for
#     byte (never downgrade a value an operator, or a newer box, set higher)
#   * an existing line with a lower value -> replaced in place
#   * no such line -> inserted immediately after [Service]
#   * no [Service] section -> echo unchanged (nothing safe to anchor on)
ensure_cli_version_text() {
  local text="$1" version="$2" existing
  if ! printf '%s\n' "$text" | grep -q '^\[Service\]'; then
    printf '%s' "$text"
    return 0
  fi
  existing="$(printf '%s\n' "$text" | grep '^Environment=ANTHROPIC_CLI_VERSION=' | head -n1)"
  if [ -n "$existing" ]; then
    existing="${existing#Environment=ANTHROPIC_CLI_VERSION=}"
    if version_gte "$existing" "$version"; then
      printf '%s' "$text"
      return 0
    fi
    printf '%s' "$text" | sed "s|^Environment=ANTHROPIC_CLI_VERSION=.*|Environment=ANTHROPIC_CLI_VERSION=$version|"
    return 0
  fi
  printf '%s' "$text" | sed "/^\[Service\]$/a Environment=ANTHROPIC_CLI_VERSION=$version"
  return 0
}

# ensure_opencode_cli_version — patch the INSTALLED opencode service definition
# in place so the NEXT restart claims a supported Claude Code version, on both
# supervisors. Call it immediately BEFORE restarting opencode: a supervisor
# stops a service using its currently-LOADED definition, so the patch has to
# land (and be reloaded) first.
#
# This exists because units are written by install.sh and self-update.sh never
# re-renders them — so without an in-place patch the fix would reach fresh
# installs only, and every existing box would stay broken forever. Same shape,
# and same reasoning, as ensure_server_kill_policy above.
#
# Never fatal: every failure path leaves the pre-existing (broken-for-new-
# models, but working for everything else) behaviour rather than aborting an
# update.
# $1 = version to claim, default resolve_anthropic_cli_version.
# $2 = systemd unit path, default ~/.config/systemd/user/opencode-serve.service.
# $3 = LaunchAgent plist path, default the com.mantaui.opencode agent.
ensure_opencode_cli_version() {
  local version="${1:-$(resolve_anthropic_cli_version)}"
  local unit="${2:-$HOME/.config/systemd/user/opencode-serve.service}"
  local plist="${3:-$HOME/Library/LaunchAgents/com.mantaui.opencode.plist}"
  local current patched plistbuddy="/usr/libexec/PlistBuddy"

  if [ -f "$unit" ]; then
    if ! current="$(cat "$unit")"; then
      warn "ensure_opencode_cli_version: could not read $unit"
      return 0
    fi
    patched="$(ensure_cli_version_text "$current" "$version")" || return 0
    if [ "$patched" = "$current" ]; then
      return 0
    fi
    if ! printf '%s' "$patched" > "$unit"; then
      warn "ensure_opencode_cli_version: could not write $unit"
      return 0
    fi
    if ! systemctl --user daemon-reload; then
      warn "ensure_opencode_cli_version: daemon-reload failed for $unit"
      return 0
    fi
    log "opencode unit now claims Claude Code $version ($unit)"
    return 0
  fi

  # macOS. Edit the plist with PlistBuddy rather than by hand — it is on every
  # Mac and it will not mangle the XML. `Set` fails when the key is absent, so
  # fall back to `Add`; both are no-ops for us if PlistBuddy is missing.
  if [ -f "$plist" ] && [ -x "$plistbuddy" ]; then
    local key=":EnvironmentVariables:ANTHROPIC_CLI_VERSION" existing
    existing="$("$plistbuddy" -c "Print $key" "$plist" 2>/dev/null || true)"
    if [ -n "$existing" ] && version_gte "$existing" "$version"; then
      return 0
    fi
    if ! "$plistbuddy" -c "Set $key $version" "$plist" 2>/dev/null \
       && ! "$plistbuddy" -c "Add $key string $version" "$plist" 2>/dev/null; then
      warn "ensure_opencode_cli_version: could not patch $plist"
      return 0
    fi
    # launchd keeps its own copy of the job definition, so editing the file is
    # not enough — the agent has to be booted out and back in for the new
    # environment to reach the process. `kickstart -k` alone would restart the
    # job with the STALE definition, i.e. silently do nothing here.
    local uid; uid="$(id -u)"
    launchctl bootout "gui/$uid/com.mantaui.opencode" 2>/dev/null || true
    if ! launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null; then
      warn "ensure_opencode_cli_version: could not reload com.mantaui.opencode"
      return 0
    fi
    log "opencode LaunchAgent now claims Claude Code $version ($plist)"
    return 0
  fi

  return 0
}
