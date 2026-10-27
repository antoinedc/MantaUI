# Refresh updated Manta guidance sections on update

## Problem
`sync_opencode_guidance` (scripts/lib/release.sh, called by install.sh and
self-update.sh) only APPENDS `## ` sections of docs/opencode-tools/AGENTS.md
that are missing from `~/.config/opencode/AGENTS.md`. A section that already
exists is never touched, so a revised section (e.g. the 2026-10-27 rewrite of
"## MantaUI background delegation", PR #1624) never reaches existing boxes.
The opencode tools/plugins themselves are already refreshed automatically by
`upgradeV2Prepare` — only the guidance is stuck.

## Rule
A Manta section in the user's file is REPLACED with the shipped version when it
is unedited, and left alone (with a warning) when the user edited it.

"Unedited" = the section body currently in the user's file hashes to a version
Manta itself shipped:
1. **Recorded hash** — whenever sync writes (appends or replaces) a section, it
   records `heading<TAB>sha256(body)` in `~/.manta/opencode-guidance.manifest`
   (state home via the same `MANTA_STATE_HOME`-aware path the box uses; one
   line per heading, rewritten atomically).
2. **Historical hashes** — a committed file
   `docs/opencode-tools/AGENTS.history` lists `heading<TAB>sha256(body)` for
   EVERY version of every section ever shipped in
   docs/opencode-tools/AGENTS.md (generated from git history by a new script
   `scripts/release/guidance-history.mjs`, run by hand when the guidance
   changes). This covers boxes that got a section before the manifest existed.

Per shipped section (heading H, shipped body B):
- H absent in dest → append (as today), record hash(B).
- H present, dest body D == B → nothing (record hash(B) if not recorded).
- H present, hash(D) is the recorded hash for H OR in the history for H →
  replace D with B in place (same position, rest of file byte-for-byte
  untouched), record hash(B).
- otherwise (user edited) → leave D, `warn` once naming the section.

"Section body" = from the `## ` heading line up to (not including) the next
line that starts with `## ` or EOF, with trailing blank lines stripped before
hashing (so the blank separator the append writes doesn't change the hash).
Sections in the dest that Manta never shipped are never touched. Headings
match by exact line, as today.

## Constraints
- Stays in bash in scripts/lib/release.sh (install.sh sources the lib; it is
  NOT in the piped-mode fallback list, keep it that way). Portable sha256:
  reuse the lib's existing `_sha256_of` helper (or the same sha256sum/shasum
  logic). Works on Linux and macOS bash 3.2 (no associative arrays).
- Atomic write (temp + mv) as today; non-fatal throughout; a missing manifest
  or history file degrades to today's behaviour plus the recorded-hash path.
- A test (scripts/lib/*.test.mjs, node:test running the bash function against
  temp files, like the existing release.sh tests) MUST fail when
  docs/opencode-tools/AGENTS.md has a section whose current body hash is not in
  AGENTS.history — so nobody can ship a guidance change without regenerating
  history (the message tells them to run the script).
- Tests: append; identical → no-op; unedited legacy (history match) → replaced
  in place, neighbours untouched; recorded match → replaced; user-edited →
  left + warning; non-Manta section untouched; manifest written; idempotent
  second run; trailing-blank-line insensitivity.

## Deploy
Ships with the next `server-v*` release; the update that installs it refreshes
the guidance (self-update runs the sync before its restart step).
