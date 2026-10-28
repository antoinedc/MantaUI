# Opus code review — desktop `@@` agent typeahead

Commit reviewed: `8e6223cb` (`origin/main..fix/desktop-agent-typeahead`).
Files read in full around the change: `chatUtils.ts` (new `detectTypeaheadTrigger`),
`hooks/useTypeahead.ts` (detector, `updateInput`, rows, `applyTypeahead`, the hook's
own exact-match), `hooks/useComposerController.ts` (`typeaheadExactMatch`,
`onTypeaheadConfirm`, `typeaheadOpen`), `InputArea.tsx` keydown handler,
`ChatPanel.tsx` help text, both test files. Callers grepped: `useTypeahead` has the
one consumer (`useComposerController`), and InputArea reads the controller's
`typeaheadExactMatch` (not the hook's). Nothing was deleted that still has users.

Checks run in this worktree:
- `vitest run hooks/useTypeahead.test.tsx chatUtils.test.ts chatShared.test.ts` →
  3 files, 785 tests passed.
- `npm run typecheck` (tsc ×3 + eslint) → clean.

## What I verified

- **Bug fixed.** The detector now looks at the token's leading characters, so
  `@@` / `@@bu` (at BOF or after whitespace) return agent mode. Component test 1
  fails on `origin/main`: there the detector returns null for `@@`, so no `@build`
  row is ever rendered. Test 2 also fails on main (`@@build`+Enter sends the literal
  text).
- **Single `@`, email-like text and `/` are unchanged.** Old file-mode condition:
  "last `@` before the caret sits at BOF/after whitespace, and nothing between it and
  the caret is whitespace". That is the same as "the token ending at the caret starts
  with `@` and contains no other `@`", which is exactly the new file branch. `a@b`,
  `foo@`, `x@@y`, `@foo@bar` all still return null. The command branch is moved
  across unchanged, including the "query is the whole first word" quirk and the
  fall-through to `@` detection when the caret leaves the command word. Unit tests
  pin each case. This matches Astra's 219k-case equivalence run on the spec.
- **Enter-to-send.** `typeaheadOpen` requires at least one row. An agent popup
  with no rows (`@@zzz`, or the catalog still loading) is therefore "closed" for
  keyboard purposes, and Enter sends exactly as on main. With rows, Enter/Tab confirm
  through `applyTypeahead`. The new agent-only guard makes sure a fully typed
  `@@build` completes the mention and does not send the bare `@@build`. The guard
  returns before any row comparison, so file and command exact-match behave
  identically to before.
- **Mention correctness.** Selection inserts `@<name> ` over `[anchorStart,
  anchorEnd)` (whole token, also mid-token) and records `{id,name}`. The send path
  resolves the token from the text. Test 2 asserts the wire mention
  `{name:"build", source:{value:"@build",start:0,end:6}}`, and the mouse test asserts
  the same for `plan`. The row label change (`@name`) is cosmetic: `applyTypeahead`
  builds the insertion from `row.key`.
- **Caret / IME.** The caret is clamped. `updateInput` reads `selectionStart`
  inside the change event, which is post-insertion, the same as before. If the caret
  sits between the two `@`, you get file mode, the same as main. IME: the trigger
  needs ASCII `@@` (a full-width `＠` does not match). The keydown handler has no
  `isComposing` guard, but that is pre-existing and already applies to file mode. No
  new exposure.
- **Races.** A file search debounced from the first `@` can still land after the
  switch to agent mode. It only writes `fileResults`/`references`, which agent mode
  never reads. It is harmless, and the spec documents it.
- **No dead controls / swallowed errors added.** The guard and detector have no
  catch blocks. The pre-existing agent-catalog rejection gap is acknowledged and
  tracked in spec §7, not made worse.
- **Security.** Pure string handling, no new I/O.
- **Scope.** Minimal: detector extraction, a one-line guard, row label, help text,
  tests. The help-text columns line up.

## Findings

1. **SHOULD — the component tests for "single `@` unchanged" and "command
   unchanged" are weaker than spec §5B tests 5–6, which the spec marks REQUIRED.**
   `src/renderer/hooks/useTypeahead.test.tsx:214-220` only checks that agent text is
   *absent* after typing `@`. It never shows the file/reference popup opened, and it
   does not test that an exact `@file` + Enter still submits. `:222-227` only checks
   that `/clear` is listed and never tests exact-match command + Enter submitting.
   These are the two behaviours the new `typeaheadExactMatch` guard sits right next
   to. A future edit that widened the guard (for example to `mode !== "command"`)
   would pass the whole suite. **Fix:**
   (a) In the `@` test, mock `opencodeReferences: () => Promise.resolve([{name:"docs",
   description:"d"}])` (or `opencodeFindFiles` returning `["a.ts"]`, with a cwd in
   PROPS). Assert `@docs` is listed, then type `@docs`, press Enter, and assert
   `opencodePrompt` was called once with text `@docs`.
   (b) In the slash test, type `/clear`, press Enter, and assert the existing submit
   path ran: the popup closed and the `/clear` builtin's observable effect (or the
   relevant API spy) fired, not a completion to `/clear `.

2. **NIT — a draft that ends in `@@` now opens the agent popup, so Enter completes
   instead of sending.** Example: a pasted diff hunk header ending in `@@` with the
   caret right after it. On main nothing opened. This is inherent to the chosen
   trigger and the same class as the existing bare-`@` behaviour, and Escape gets out
   of it. No change required. Consider a line in spec §7 so it is a documented
   trade-off rather than a surprise.

3. **NIT — `useTypeahead.ts` header comment says "Three triggers"** and now lists
   four lines (`/`, `@`, `@@`). Change the wording to "triggers:" or "Three trigger
   kinds".

VERDICT: APPROVE
