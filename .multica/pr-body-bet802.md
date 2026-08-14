Two independent desktop chat changes, two commits:

1. **`fix(chat): scroll transcript to bottom on submit`** (BET-802 Part 1)
   - Submit no longer scrolls inline against the yet-uncommitted message list. It
     sets a `forceTailRef` flag; a post-commit effect (after the composer has
     resized) scrolls the transcript to "LAST". Previously `index: "LAST"`
     resolved to the previous last message because the optimistic row wasn't
     committed yet.
   - Consolidated the four duplicate `scrollToIndex({ index: "LAST", ... })`
     literals (question-reveal, resize rescue, re-activation, submit) into one
     shared `scrollToTail` helper.
   - New harness test asserts the ordering: `scrollToIndex({ index: "LAST",
     align: "end" })` fires only at a point where the optimistic user message is
     already in the rendered transcript.
   - No change to `Transcript.tsx`, `useSseBus.ts`, `useTranscriptState.ts`.

2. **`refactor(chat): remove streaming caret animation`** (BET-802 Part 2)
   - Pure deletion of the blinking accent caret at the end of streaming text and
     the entire `streaming` prop chain that drove it
     (`Transcript → MessageRow → ToolCall → index.css`).
   - Removed the now-unused `blink-cursor` keyframes/utility and
     `.manta-streaming` rule from `index.css`; dropped `lastId` /
     `isLastInTranscript` from `Transcript.tsx`.
   - Updated the `chatMotion.ts` header and `docs/chat-animation.md` to match
     reality.
   - `running` on `Transcript` is kept (still drives `WorkingIndicator`).

Repo-wide search: `manta-streaming` and `blink-cursor` are absent from
`src/renderer/**` and `docs/` (the only remaining hit is the gitignored
`mobile/www/` build artifact, which CI rebuilds).

Base: `origin/main @ 9e103b9` (branch cut point). Current `origin/main` is
`035e15b`; it landed commits only to other files — no overlap with the 9 files
touched here, so the branch is clean to merge.

**Files changed:** 9 files, +171 / −93.

**Verification results:**
- PR branch (`multica/BET-802-scroll-submit-caret` @ `acaa8be`):
  - typecheck: exit 0. Errors: none. log sha256: `75342603966d11824516b89baa97128413853820f43086df3254737d95622e1f`
  - test: exit 0 — vitest 2426 pass / 7 skip / 0 fail; node 1679 pass / 0 fail. log sha256: `11b72c10b286304dbf54f7d4711116ef0871595b4ebc367513d7ec166ac1acfe`
- Base (`035e15b`):
  - typecheck: exit 0. Errors: none. log sha256: `75342603966d11824516b89baa97128413853820f43086df3254737d95622e1f`
  - test: exit 0. log sha256: `7972ba3004e9b3325fa2c45ed1f618e4eaf7200ae7066dbf45fbd96524af5fe0`
- **Conclusion:** 0 failures on both branches — no new failures, no pre-existing.

Logs cached at `/tmp/typecheck-pr.log`, `/tmp/typecheck-main.log`,
`/tmp/test-pr.log`, `/tmp/test-main.log`.
