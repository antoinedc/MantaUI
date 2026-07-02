#!/usr/bin/env bash
# duplication-gate — the BLOCKING half of the anti-spaghetti discipline
# (the advisory sticky-comment report in check-duplication.sh stays as the
# reviewer's judgment layer on top).
#
# STRICT policy (owner decision 2026-07-02): ANY jscpd clone (min-tokens 70)
# among the PR's changed .ts/.tsx/.mjs files fails the gate. Exceptions live
# ONLY in scripts/duplication-gate-ignore.txt — the documented intentional
# desktop/mobile transport mirrors (AGENTS.md: "when changing one, change the
# other"). Changing the ignore list itself is a .github/**-adjacent act: the
# file lives under scripts/, which approval-policy.json classes as HUMAN, so
# an agent PR cannot silently widen its own exemptions.
#
# Scope note: clones are detected WITHIN the changed-file set (plus each
# changed file against itself). Cross-file duplication against UNCHANGED files
# is the advisory report's job — jscpd pairwise over the whole repo is too
# slow/noisy for a hard gate.
#
# Usage: scripts/check-duplication-gate.sh [BASE_REF]   (default origin/main)
# Exit: 0 = no disallowed clones; 1 = clones found (gate fails).

set -uo pipefail

BASE_REF="${1:-origin/main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IGNORE_FILE="scripts/duplication-gate-ignore.txt"

MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF")"
mapfile -t CHANGED < <(git diff --name-only --diff-filter=d "$MERGE_BASE"...HEAD 2>/dev/null \
  | grep -E '\.(ts|tsx|mjs)$' \
  | grep -v '^mobile/www/' || true)

if [ "${#CHANGED[@]}" -eq 0 ]; then
  echo "duplication-gate: no scannable changed files — PASS"
  exit 0
fi

# Drop files matching the ignore list (documented intentional mirrors).
# NOTE the ${arr[@]+...} expansion guard — "${arr[@]:-}" on an EMPTY array
# yields ONE EMPTY STRING and feeds jscpd a "" arg (the bug this replaced).
if [ -f "$IGNORE_FILE" ]; then
  FILTERED=()
  for f in "${CHANGED[@]}"; do
    skip=0
    while IFS= read -r pat; do
      [ -z "$pat" ] && continue
      case "$pat" in \#*) continue ;; esac
      # shellcheck disable=SC2254
      case "$f" in $pat) skip=1; break ;; esac
    done < "$IGNORE_FILE"
    [ "$skip" -eq 0 ] && FILTERED+=("$f")
  done
  CHANGED=(${FILTERED[@]+"${FILTERED[@]}"})
fi

if [ "${#CHANGED[@]}" -eq 0 ]; then
  echo "duplication-gate: all changed files are documented mirrors — PASS"
  exit 0
fi

echo "duplication-gate: scanning ${#CHANGED[@]} changed file(s) (min-tokens 70, STRICT)"
OUT_DIR="$(mktemp -d)"
npx --yes jscpd "${CHANGED[@]}" --min-tokens 70 --reporters json --output "$OUT_DIR" \
  --absolute >/dev/null 2>&1 || true

REPORT="$OUT_DIR/jscpd-report.json"
if [ ! -f "$REPORT" ]; then
  echo "duplication-gate: jscpd produced no report (tool failure) — PASS with warning"
  echo "::warning::jscpd did not produce a report; gate could not evaluate."
  exit 0
fi

CLONES=$(python3 -c "
import json
r=json.load(open('$REPORT'))
print(len(r.get('duplicates',[])))")

if [ "$CLONES" -gt 0 ]; then
  echo "duplication-gate: FAIL — $CLONES clone(s) detected among changed files:"
  python3 -c "
import json
r=json.load(open('$REPORT'))
for d in r.get('duplicates',[]):
    a,b=d.get('firstFile',{}),d.get('secondFile',{})
    print(f\"  {a.get('name')} <-> {b.get('name')} ({d.get('lines')} lines)\")"
  echo
  echo "Fix: extract the shared logic, or — ONLY for a documented intentional"
  echo "mirror — add the file to scripts/duplication-gate-ignore.txt (human-"
  echo "approval class) with a comment referencing the AGENTS.md section."
  exit 1
fi

echo "duplication-gate: PASS — no clones"
exit 0
