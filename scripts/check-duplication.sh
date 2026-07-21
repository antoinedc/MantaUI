#!/usr/bin/env bash
# Anti-spaghetti detector pass — ported from leasebot/tenanture. The
# deterministic half of the duplication/dead-code discipline: LLM implementers
# tend to re-implement instead of reuse; deterministic tools in the harness
# catch that more reliably than instructions alone.
#
# This is a SIGNAL, not a gate. It NEVER exits non-zero on findings — it emits
# a markdown report for the bui-reviewer agent (or a human) to exercise
# judgment on. The CI job that calls it (.github/workflows/anti-spaghetti.yml)
# is non-blocking and NOT in required-checks.json.
#
# better-ui adaptations vs the leasebot original:
#   - scans .ts/.tsx/.mjs (server modules are .mjs here), excludes mobile/www
#     build output and content-hashed assets
#   - NO eslint section: this repo has no eslint config (the dep is present but
#     unconfigured). If a flat config lands later, restore the diff-scoped lint
#     section from the leasebot script verbatim.
#   - reviewer guidance names this repo's known intentional near-twins
#     (desktop/mobile transport mirrors — see AGENTS.md "when changing one,
#     change the other").
#
# Tooling note (BET-220): settings (minTokens, maxLines=0, ignore patterns)
# live in `.jscpd.json` at the repo root, the SAME source of truth consumed
# by scripts/check-duplication-gate.sh. Passed via --config so this script
# behaves identically regardless of cwd. Keep local + CI on jscpd@^5.x
# (4.x --max-lines default of 1000 silently masks large files; the 5.x
# default is `null` / no limit).
#
# Usage:
#   scripts/check-duplication.sh [BASE_REF]   (BASE_REF defaults to origin/main)

set -uo pipefail

BASE_REF="${1:-origin/main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF")"
mapfile -t CHANGED < <(git diff --name-only --diff-filter=d "$MERGE_BASE"...HEAD 2>/dev/null \
  | grep -E '\.(ts|tsx|mjs)$' \
  | grep -v '^mobile/www/' || true)

echo "<!-- anti-spaghetti-report -->"
echo "## Anti-spaghetti detector report"
echo
echo "_Signal, not a gate. The reviewer applies judgment — discount coincidental"
echo "clones (test fixtures, tmux format strings) and the **intentional**"
echo "desktop/mobile transport mirrors (src/main/opencode.ts ↔"
echo "src/server/opencode.mjs and friends — AGENTS.md says 'when changing one,"
echo "change the other'). Only act on duplication of the same business logic"
echo "this PR introduced, or dead code it left behind._"
echo
echo "- Base ref: \`${BASE_REF}\` (merge-base \`$(git rev-parse --short "$MERGE_BASE" 2>/dev/null || echo '?')\`)"
echo "- Changed \`.ts/.tsx/.mjs\` files (excl. mobile/www): **${#CHANGED[@]}**"
echo

if [ "${#CHANGED[@]}" -eq 0 ]; then
  echo "No TypeScript/module files changed — nothing to scan."
  exit 0
fi

echo "### Copy-paste (jscpd, changed scope, min-tokens 70)"
echo
echo '```'
npx --yes jscpd --config .jscpd.json "${CHANGED[@]}" 2>&1 \
  | tail -60 || true
echo '```'

exit 0
