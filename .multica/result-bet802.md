Done — both parts of BET-802, separate commits, one PR.

**PR:** https://github.com/antoinedc/MantaUI/pull/809 (branch `multica/BET-802-scroll-submit-caret`)

**Commit 1 — `fix(chat): scroll transcript to bottom on submit`**

- Submit no longer calls `scrollToIndex({ index: "LAST" })` synchronously (that raced the uncommitted optimistic row and landed on the *previous* last message). It now sets a `forceTailRef` flag; a post-commit effect — declared after the composer-resize effect — scrolls to the tail once the new message is committed and the composer has collapsed back to one line.
- Consolidated the four duplicate `scrollToIndex({ index: "LAST", ... })` literals (question reveal, deferred question-scroll, composer-resize rescue, re-activation, submit) into one shared `scrollToTail` helper, with the dependency arrays updated. `scrollToMessage` (center-align) and `Transcript.tsx`/`useSseBus.ts`/`useTranscriptState.ts` untouched.
- New harness test proves the ordering fix: it observes every `scrollToIndex` and asserts a `{ index: "LAST", align: "end" }` call fires at a point where the optimistic user message is already in the rendered transcript (not inline against the stale list). Note: direct handle-spying proved impractical as the issue anticipated — Virtuoso recreates its imperative handle object on every render, so a handle spied after mount goes stale the moment the submit re-render lands. Instead the test wraps the real `<Virtuoso>` (delegating rendering, all other harness tests untouched) and routes every `scrollToIndex` through an observer.

**Commit 2 — `refactor(chat): remove streaming caret animation`**

- Pure deletion: the blinking accent caret and the whole `streaming` prop chain (`Transcript → MessageRow → ToolCall → index.css`). Removed the `blink-cursor` keyframes/utility and `.manta-streaming` rule from `index.css`, dropped the now-unused `lastId`/`isLastInTranscript`, updated `chatMotion.ts` header and `docs/chat-animation.md`. `running` on `Transcript` kept (still drives `WorkingIndicator`).
- Acceptance check: `manta-streaming` and `blink-cursor` are gone from `src/renderer/**` and `docs/` (only the gitignored `mobile/www/` build artifact still carries it; CI rebuilds that, source untouched).

**Verification results:**
- PR branch: typecheck exit 0 (none); test exit 0 — vitest 2426 pass / 7 skip, node 1679 pass / 0 fail.
- Base (`035e15b`): typecheck exit 0; test exit 0.
- Conclusion: 0 failures on both — no new, no pre-existing.

Branch was cut from `9e103b9`; current `origin/main` (`035e15b`) landed changes only to other files — no overlap with the 9 files touched here. No follow-ups surfaced.
