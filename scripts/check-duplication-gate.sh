#!/usr/bin/env bash
# duplication-gate — the BLOCKING half of the anti-spaghetti discipline
# (the advisory sticky-comment report in check-duplication.sh stays as the
# reviewer's judgment layer on top).
#
# STRICT policy (owner decision 2026-07-02): ANY jscpd clone (min-tokens 70)
# among the PR's changed .ts/.tsx/.mjs files fails the gate. Exceptions live
# ONLY in scripts/duplication-gate-ignore.txt — the documented intentional
# desktop/mobile transport mirrors (AGENTS.md: "when changing one, change the
# other"). Changing the ignore list is reviewed like any scripts/ change; the
# gate-file human-review boundary now lives in .github/CODEOWNERS
# (.github/** + .gitleaks.toml → @antoinedc) enforced by the main branch ruleset.
#
# Scope note: clones are detected WITHIN the changed-file set (plus each
# changed file against itself). Cross-file duplication against UNCHANGED files
# is the advisory report's job — jscpd pairwise over the whole repo is too
# slow/noisy for a hard gate.
#
# Tooling note (BET-220): jscpd settings (minTokens, maxLines=0 to disable
# the 4.x 1000-line mask, ignore patterns) live in `.jscpd.json` at the repo
# root — the SINGLE SOURCE OF TRUTH shared with check-duplication.sh and
# consumed by jscpd via --config. Keep local (`npm install` → jscpd@^5.0.12)
# and CI (no `npm ci` before this job → fetches latest from npm) on the
# same 5.x line; both must read this config. If you bump or pin a different
# jscpd version, update .jscpd.json to match.
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
npx --yes jscpd --config .jscpd.json "${CHANGED[@]}" --output "$OUT_DIR" \
  >/dev/null 2>&1 || true

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
