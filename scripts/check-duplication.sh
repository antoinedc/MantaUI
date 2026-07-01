#!/usr/bin/env bash
# Anti-spaghetti detector pass — the deterministic half of the duplication
# discipline encoded in the reviewer workflow.
#
# This is a SIGNAL, not a gate. It NEVER exits non-zero on findings — it only
# emits a structured markdown report to stdout for a human or the reviewer
# agent to read and exercise judgment on. The CI job that calls it is
# non-blocking and is NOT in `required-checks.json`.
#
# Tool: jscpd (copy-paste, pulled on demand via npx — not a repo dep).
#
# Usage:
#   scripts/check-duplication.sh [BASE_REF]   (BASE_REF defaults to origin/main)

set -uo pipefail

BASE_REF="${1:-origin/main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF")"
mapfile -t CHANGED < <(git diff --name-only --diff-filter=d "$MERGE_BASE"...HEAD 2>/dev/null \
  | grep -E '\.(ts|tsx|mjs)$' || true)

echo "<!-- anti-spaghetti-report -->"
echo "## Anti-spaghetti detector report"
echo
echo "_Signal, not a gate. The reviewer applies judgment — discount coincidental"
echo "clones (drizzle query chains, test fixtures, Electron boilerplate) and"
echo "intentional structural duplicates (parallel config files, themed entry"
echo "points). Only act on duplication of the **same business logic** this PR"
echo "introduced, or dead code it left behind._"
echo
echo "- Base ref: \`${BASE_REF}\` (merge-base \`$(git rev-parse --short "$MERGE_BASE" 2>/dev/null || echo '?')\`)"
echo "- Changed files: **${#CHANGED[@]}**"
echo

if [ "${#CHANGED[@]}" -eq 0 ]; then
  echo "No TypeScript/JS files changed — nothing to scan."
  exit 0
fi

echo "### Copy-paste (jscpd, changed scope, min-tokens 70)"
echo
echo '```'
npx --yes jscpd "${CHANGED[@]}" --min-tokens 70 --reporters consoleFull --absolute 2>&1 \
  | tail -60 || true
echo '```'
echo

echo "### Lint (ESLint, changed scope)"
echo
echo '```'
if command -v npx &> /dev/null && [ -f "package.json" ] && grep -q '"eslint"' package.json; then
  npx eslint --format compact "${CHANGED[@]}" 2>&1 | tail -40 || true
else
  echo "ESLint not installed or not in package.json — skipping."
fi
echo '```'

exit 0
