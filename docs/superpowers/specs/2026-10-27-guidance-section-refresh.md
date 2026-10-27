# Refresh updated Manta guidance sections on update

Revision 3 (after two reviews).

## Problem
`sync_opencode_guidance` (scripts/lib/release.sh, called by install.sh and
self-update.sh) only APPENDS `## ` sections of docs/opencode-tools/AGENTS.md
that are missing from `~/.config/opencode/AGENTS.md`. A section that already
exists is never touched, so a revised section (e.g. the 2026-10-27 rewrite of
"## MantaUI background delegation", PR #1624) never reaches existing boxes.
Renamed sections (e.g. the bui→manta rebrand, commit e0d04f43) leave the old
copy behind and append a second one. The opencode tools/plugins themselves are
already refreshed by `upgradeV2Prepare`; only the guidance is stuck. Repo rule:
upgrades are always automatic (AGENTS.md, Release & CD).

## 1. Parser contract (shared by the bash sync and the history generator)
- Input is read as lines; CR before LF is stripped for PARSING and HASHING only.
- A **section starts** at a line that begins (column 0) with exactly `## `
  (two `#` then a space) AND is not inside a fenced code block (fences below).
  `###`+ lines are body text.
- The **preamble** (everything before the first section) belongs to nobody and
  is never modified.
- A section's **body** = its heading line through the line before the next
  section start (or EOF).
- **Fences** (CommonMark-style): an opening fence is a line with at most 3
  leading spaces, then a run of ≥3 backticks or ≥3 tildes (the info string after
  it is allowed). It closes only on a line with at most 3 leading spaces, a run
  of the SAME character at least as long as the opening run, and nothing but
  whitespace after it. A shorter/other-character run inside is body text. An
  unclosed fence runs to EOF.
- **Heading key** = the heading line with trailing whitespace/CR removed.
- **Canonical bytes for hashing** = the body's lines joined with `\n`, trailing
  lines that are empty or whitespace-only removed, then exactly one final `\n`.
  sha256 hex of that. Bash and the JS generator must produce identical hashes
  (cross-language fixture test).
- Rewriting a section replaces exactly its original line span (original bytes
  of everything else untouched; the replacement uses `\n` endings, followed by
  one blank line if another section follows).

## 2. Data files (committed, next to the source)
- `docs/opencode-tools/AGENTS.history` — lines `<heading key>\t<sha256>`,
  sorted, deduplicated, APPEND-ONLY: the set of every (heading, canonical hash)
  that any committed version of docs/opencode-tools/AGENTS.md ever had.
- `docs/opencode-tools/AGENTS.aliases` — lines `<old heading key>\t<current
  heading key>`, hand-maintained, seeded by the generator's report of headings
  that disappeared (implementer fills it for every rename found in history, e.g.
  `## bui scheduled tasks` → `## manta scheduled tasks`; a removed section with
  no successor gets no alias and is left alone on boxes).
- `scripts/release/guidance-history.mjs` regenerates history: walks
  `git log --follow --format=%H -- docs/opencode-tools/AGENTS.md` on the full
  history, parses each version with §1, MERGES into the existing file (never
  drops a line), writes sorted output. It refuses to run on a shallow clone
  (`git rev-parse --is-shallow-repository`) and prints headings present in
  history but absent today (alias candidates).
- The sync locates both files beside its `<src>` argument
  (`$(dirname src)/AGENTS.history|aliases`), never via the working directory.
  Missing files → that lookup is empty (degrade, don't fail).

## 3. Box state
`~/.manta/opencode-guidance.manifest`: lines `<heading key>\t<sha256>` of the
version this sync last wrote/confirmed per heading. Path: the helper resolves it
itself as `${MANTA_STATE_HOME:-$HOME}/.manta/opencode-guidance.manifest`, where a
MANTA_STATE_HOME that is empty or whitespace-only counts as unset (same
semantics as src/shared/paths.mjs; same parent convention as self-update.sh:85).
Tests always sandbox it with MANTA_STATE_HOME.

## 4. Sync rules (per shipped section, heading H, shipped body B, hash hB)
Shipped file with duplicate headings → warn and skip those headings entirely.
"Known(H, h)" := manifest has (H,h) OR history has (H,h).

1. Find H in dest. If H occurs more than once in dest → warn ("ambiguous"),
   change nothing for H, record nothing.
2. H present once with body D:
   - hash(D) == hB → no change; record (H,hB) if not recorded.
   - Known(H, hash(D)) → replace D with B in place; record (H,hB).
   - else → leave D; warn once ("you edited <H>; not updated"); record nothing.
3. H absent:
   - Let P = every alias A with A→H (all of them, independent of file order)
     that occurs in dest. Classify each: pristine (occurs once and
     Known(A, hash)), edited (occurs once, not known), ambiguous (occurs >1).
   - If exactly one pristine predecessor and no edited/ambiguous ones → replace
     that span in place with B; record (H,hB).
   - If more than one pristine and none edited/ambiguous → replace the FIRST in
     file order with B, delete the other pristine spans; record (H,hB).
   - If any predecessor is edited or ambiguous → change nothing for H (no
     append, no deletions), warn naming them; record nothing.
   - If P is empty → append B (blank-line separated; if dest lacks a final
     newline add one first), record (H,hB).
4. H present once (after rule 2 ran) AND predecessors P exist in dest: delete
   each pristine predecessor span (occurs once, Known); leave edited/ambiguous
   ones with a warning.
Sections in dest that Manta never shipped (not in source, not in history, not
an alias) are never touched.

## 5. Writing, failure handling
- Stage the new file in the SAME directory as dest (`mktemp
  "$(dirname dest)/.AGENTS.md.XXXXXX"`), `mv` onto dest. Write guidance first,
  then the manifest (same staging rule in its directory). Guarantees: a failure
  BEFORE the guidance rename leaves both files byte-identical, warns, returns 0.
  A manifest failure AFTER the guidance rename leaves the updated guidance and
  the previous manifest, warns, returns 0 (recoverable: the shipped hash is in
  history, so the next run sees the section as pristine).
- Must work with the callers' `set -euo pipefail` in effect (use explicit
  `|| …` guards; no unguarded failing pipelines).
- bash 3.2 / BSD tools: no associative arrays, no `mapfile`, no GNU-only flags;
  awk is allowed (POSIX awk) and recommended for the parser. Hashing via the
  lib's `_sha256_of` (sha256sum or `shasum -a 256`).
- Stays in scripts/lib/release.sh; NOT added to `HELPER_NAMES` (piped install
  already sources the lib from the extracted payload, install.sh ~1176).

## 6. Tests
scripts/lib/*.test.mjs (node:test running bash under `set -euo pipefail`,
sandboxed MANTA_STATE_HOME + temp dirs):
- parser: fenced `## ` ignored; `###` body; preamble untouched; CRLF dest;
  no-final-newline dest; whitespace-only trailing lines; cross-language hash
  parity with guidance-history.mjs on the same fixtures.
- rules: append; identical no-op; history-pristine replaced in place with
  neighbours byte-identical; manifest-pristine replaced; edited left + warning;
  duplicate dest heading left + warning; duplicate shipped heading skipped;
  alias pristine replaced in place under the new heading; alias edited left and
  no append; both alias and new present; non-Manta section untouched; second run
  is a no-op; failure (unwritable dir) leaves dest unchanged and returns 0.
- freshness: every section of the current docs/opencode-tools/AGENTS.md has its
  (heading, hash) in AGENTS.history (message: run
  `node scripts/release/guidance-history.mjs`); history is sorted/unique; a
  regeneration over the existing file never removes a line.
- fences: four-backtick fence containing a three-backtick block and a `## `
  line → no section split; closing fence with trailing text is not a close.
- aliases: multiple predecessors (pristine+pristine, pristine+edited) in
  either alias-file order; current H plus pristine predecessor → predecessor
  removed.
- failure between the two commits: guidance updated, old manifest kept,
  returns 0, next run is a no-op.
- lifecycle (behavioural): (a) an OLD self-update lib (the function as on
  origin/main, inlined into a fixture) followed by re-sourcing the NEW lib from
  a fixture payload results in the NEW sync running — reproduce the re-source
  sequence of scripts/self-update.sh in a harness; (b) piped install: run the
  install.sh guidance block in a harness with no lib sourced up front and a
  fixture payload dir, and assert the sync ran. Plus the existing textual
  ordering assertions.

## 7. Real-box check (implementer)
Run the sync against a COPY of this box's `~/.config/opencode/AGENTS.md`
(`cp` to a temp dir; never write the real file) with MANTA_STATE_HOME sandboxed,
and report which sections it would replace / leave / append.

## Deploy
Ships with the next `server-v*` release; that update refreshes the guidance
itself (self-update runs the sync after the new payload is on disk).
