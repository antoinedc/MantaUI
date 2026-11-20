#!/usr/bin/env bash
# prod-disk.sh — disk hygiene for the prod web box, run ON the box.
#
# The box has no checkout of this script; release workflows stream it:
#   ssh <host> bash -s -- guard <bytes> <dir> < scripts/release/prod-disk.sh
#   ssh <host> bash -s -- prune-desktop <keep> <dir>... < scripts/release/prod-disk.sh
#
# Commands:
#   guard <bytes> <dir>
#       Exit 1 (printing "need <N> free, have <M>") when the filesystem holding
#       <dir> has less than <bytes> + 2 GiB free. <dir> may not exist yet: the
#       nearest existing ancestor is measured.
#   prune-desktop <keep> <dir>...
#       In each <dir> (non-recursive) group desktop installers named
#       "Manta UI-<ver>-*", "Manta-UI-<ver>-*", "Manta-UI-Staging-<ver>-*" or
#       "Manta-Staging-<ver>-*" by <ver>, keep the newest <keep> versions and
#       delete the rest. Nothing else is ever touched (latest*.yml,
#       Manta-latest*.{dmg,exe}, server.json, ...). <keep> must be an integer >= 2.
#
# Server tarballs (releases/manta-*) are deliberately never pruned: a box rolling
# back an upgrade re-installs its previous release, which can be old.
#
# Env: PROD_DISK_MARGIN_BYTES overrides the 2 GiB margin (tests only).
#
# Reads nothing from stdin (stdin is this script when streamed). GNU coreutils.

set -euo pipefail

# Overridable only so tests do not depend on the free space of the machine they run on.
MARGIN_BYTES="${PROD_DISK_MARGIN_BYTES:-$((2 * 1024 * 1024 * 1024))}"

usage() {
  echo "usage: prod-disk.sh guard <bytes> <dir>" >&2
  echo "       prod-disk.sh prune-desktop <keep> <dir>..." >&2
  exit 2
}

human() { numfmt --to=iec --suffix=B "$1"; }

cmd_guard() {
  [ "$#" -eq 2 ] || usage
  local bytes="$1" dir="$2"
  [[ "$bytes" =~ ^[0-9]+$ ]] || usage
  local need=$((bytes + MARGIN_BYTES))
  while [ ! -d "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
    dir="$(dirname "$dir")"
  done
  local have
  have="$(df --output=avail -B1 "$dir" | tail -n 1 | tr -d ' ')"
  if [ "$have" -lt "$need" ]; then
    echo "need $(human "$need") free, have $(human "$have") (on the filesystem of $dir)" >&2
    exit 1
  fi
  echo "disk ok: need $(human "$need"), have $(human "$have")"
}

# Prints the version of a desktop artifact filename, or nothing.
artifact_version() {
  local re='^Manta([ -]UI|-UI-Staging|-Staging)-([0-9]+\.[0-9]+\.[0-9]+)-.+'
  if [[ "$1" =~ $re ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
  fi
}

cmd_prune_desktop() {
  [ "$#" -ge 2 ] || usage
  local keep="$1"
  shift
  [[ "$keep" =~ ^[0-9]+$ ]] || usage
  [ "$keep" -ge 2 ] || usage

  local freed=0 dir name ver size
  for dir in "$@"; do
    if [ ! -d "$dir" ]; then
      echo "skip $dir (not a directory)"
      continue
    fi
    local names=() versions=()
    while IFS= read -r name; do
      ver="$(artifact_version "$name")"
      [ -n "$ver" ] || continue
      names+=("$name")
      versions+=("$ver")
    done < <(find "$dir" -maxdepth 1 -type f -printf '%f\n')

    [ "${#names[@]}" -gt 0 ] || continue
    local kept
    kept="$(printf '%s\n' "${versions[@]}" | sort -uV | tail -n "$keep")"
    local i
    for i in "${!names[@]}"; do
      if printf '%s\n' "$kept" | grep -qxF -- "${versions[$i]}"; then
        continue
      fi
      size="$(stat -c%s "$dir/${names[$i]}")"
      rm -f -- "$dir/${names[$i]}"
      freed=$((freed + size))
      echo "deleted $dir/${names[$i]} ($(human "$size"))"
    done
  done
  echo "freed $(human "$freed")"
}

[ "$#" -ge 1 ] || usage
command="$1"
shift
case "$command" in
  guard) cmd_guard "$@" ;;
  prune-desktop) cmd_prune_desktop "$@" ;;
  *) usage ;;
esac
