# Desktop composer: `@@` agent typeahead never opens

## 1. Problem

**User-visible.** In the desktop composer (session chat and the CTO chat — both
use `useComposerController` → `useTypeahead`), typing `@@` or `@@bu` is meant to
open a popup of agents to mention. It never does. Typing a single `@` (file /
reference picker) works. The agent-mention feature (popup rows labelled `@@name`,
"No matching agents" hint, mention chips sent on the wire) is unreachable.

**Root cause (verified).** `src/renderer/hooks/useTypeahead.ts`, `detectTypeahead`
(lines 159-199):

- L177-178: `left.lastIndexOf("@")` finds the LAST `@` before the caret.
- L180-181: it opens only if that `@` is at index 0 or preceded by whitespace.
- L187: the agent branch (`after.startsWith("@")`) needs the text after the
  anchor to begin with a second `@` — i.e. the anchor must be the FIRST `@`.

For `@@x` the last `@` is index 1, preceded by `@` → the guard at L181 fails →
`null` is returned and the popup closes. The first `@` (index 0), the only
candidate that could satisfy both the guard and L187, is never examined. So
`mode: "agent"` (L187), the agent-catalog refresh (L210), the agent rows
(L239-250), and the agent apply path (L307-317) are all dead code. The original
report is correct.

**What the rest of the pipeline already defines (the contract to match):**

- Popup row label today: `@@<name>` (`useTypeahead.ts:247`; changed to `@<name>` in §3 item 5); empty hint "No matching
  agents" (`Composer.tsx:71`).
- Selection (`applyTypeahead`, L307-317): replaces the `@@partial` slice with
  `@<name>` + a space (single `@`) and records `AgentMention{id,name}`.
- Submit: `resolveAgentMentions` (`chatShared.tsx:76`) re-scans the final text for
  `@<name>` on word boundaries and sends `{name, source:{value:"@name",start,end}}`
  (session composer `ChatPanel.tsx:1492/1910`, CTO `CtoChat.tsx:1075`; box
  validation `ctoAdmission.mjs:473`). Unit-tested in `chatShared.test.ts`.

So the syntax is: **`@@` is only the *trigger* in the popup; the text that stays in
the draft and goes on the wire is `@<agent>`.** The wire format, `resolveAgentMentions`
and the box need no change. **One downstream seam DOES need a guard** (review
finding 1): the Enter-key "exact match" shortcut.

**Second defect that becomes reachable once the popup opens (verified).**
`useComposerController.ts:610-617` defines `typeaheadExactMatch` as
`input.trim() === row.primary`, and `InputArea.tsx:531-538` then cancels the popup
and SUBMITS instead of completing. Agent rows today have `primary = "@@build"`
(`useTypeahead.ts:247`). So after the detector fix, typing exactly `@@build` and
pressing Enter satisfies the shortcut → the literal text `@@build` is sent with no
recorded mention (only `applyTypeahead` rewrites to `@build` and records the
`AgentMention`, `useTypeahead.ts:307-316`; both hosts resolve only recorded
mentions: `ChatPanel.tsx:1492,1910`, `CtoChat.tsx:1075`). The shortcut must never
fire in agent mode. (This path was previously dead for the same reason as the rest.)

**Stale help text (verified).** `ChatPanel.tsx:154` (the `/help` shortcuts list)
says `@ file or agent mention typeahead`, but agents are on `@@`, not `@`.

**iOS / box check.** iOS (`mobile/native/MantaUI/ComposerTypeahead.swift`) has
only the file `@` typeahead (`detectMention`); it has no agent-mention typeahead,
and nothing on the box or in docs defines an `@@` syntax beyond the desktop code
above (`grep '@@'` hits only diff hunk headers and an env placeholder). So there
is no second definition to reconcile; iOS is out of scope. (Note iOS `detectMention`
on `@@x` also returns nil — same "second @ not after whitespace" rule — which is
harmless there since it has no agent mode.)

## 2. Goal / non-goals

**Goal.** `@@` and `@@partial` (at BOF or after whitespace, caret inside the token)
open the agent typeahead; picking an agent by Enter, Tab or mouse always inserts
`@<name> ` and records the mention (never sends a bare `@@name`); everything else
behaves exactly as today.

**Non-goals.** No change to the mention wire format, `resolveAgentMentions`, the
popup layout, iOS, or the box. Not adding agents to the single-`@` list. Not
changing what gets inserted (`@<name>`). Not fixing the pre-existing agent-catalog
failure handling (tracked in §7, finding 3) — only documenting it.

## 3. Design

### Behaviour (plain words)

The "token" is the run of non-whitespace characters ending at the caret (the
start of the token is just after the last whitespace before the caret, or BOF).
The popup is keyed off the token's *leading* characters, not the last `@`:

| Token (caret at its end) | Result |
|---|---|
| `@`, `@src/fo` | file mode, query = text after `@` (unchanged) |
| `@@`, `@@bu` | **agent mode**, query = text after `@@` (new) |
| `a@b`, `foo@`, `x@@y` (token does not start with `@`) | no popup (unchanged) |
| `@foo@bar`, `@@foo@bar` (a further `@` inside the query) | no popup (unchanged: old code bailed because the last `@` followed a non-space) |
| `@@@`, `@@@x` (third leading `@`) | no popup — agent query would contain `@` |
| `/cmd` at index 0 with caret in first word | command mode (unchanged, evaluated first) |
| caret between the two `@` of `@@x` (token to caret is `@`) | file mode, query "" — same as old behaviour |

`anchorStart` = token start; `anchorEnd` = end of the non-whitespace run past the
caret (as today). Selecting an agent therefore replaces `@@bu` (or `@@bu` plus any
trailing non-space chars) with `@build `.

### Code changes

1. **`src/renderer/chatUtils.ts`** — add pure, exported:

   ```ts
   export type TypeaheadTrigger = {
     mode: "file" | "agent" | "command";
     query: string;
     anchorStart: number;
     anchorEnd: number;
   };
   export function detectTypeaheadTrigger(text: string, caret: number): TypeaheadTrigger | null
   ```

   Logic: (a) command branch moved verbatim from the hook (`text.startsWith("/")`,
   `/^\/([\w-]*)/`, `caret <= m[0].length`). (b) Otherwise: `ts` = index after the
   last whitespace (`/\s/`) in `text.slice(0, caret)` (0 if none);
   `typed = text.slice(ts, caret)`. If `typed` does not start with `@` → `null`.
   `end` = caret advanced while `!/\s/.test(text[end])`. If `typed.startsWith("@@")`:
   `query = typed.slice(2)`; if `query` contains `@` → `null`; return `agent`.
   Else `query = typed.slice(1)`; if `query` contains `@` → `null`; return `file`.
   Always return `anchorStart: ts`, `anchorEnd: end`. Clamp `caret` to
   `[0, text.length]`.

2. **`src/renderer/hooks/useTypeahead.ts`** — `detectTypeahead` becomes
   `const t = detectTypeaheadTrigger(text, caret); return t && { ...t, selectedIdx: 0 };`
   (keep the `useCallback`/`TypeaheadState` shape so `updateInput` is untouched).
   Update the header comment (`@@<token>` → agent typeahead; `@<token>` → file/reference). Import from
   `../chatUtils`. Apart from the row-label change in item 5, catalog
   refresh and `applyTypeahead` remain unchanged.

3. `updateInput`'s chain `if command … else if (agent && agents==null) refresh …
   else if (file) …` is correct as-is for the new reachable path.

4. **`src/renderer/hooks/useComposerController.ts` (`typeaheadExactMatch`,
   L612-617) — agent-mode guard (review finding 1).** Add
   `if (typeahead.mode === "agent") return false;` right after the empty-rows
   guard. Effect: in agent mode Enter always goes to `onTypeaheadConfirm`
   (→ `applyTypeahead`), so `@@build` + Enter rewrites the draft to `@build `,
   closes the popup, records the mention and does NOT send; the next Enter (popup
   now closed) sends, and `resolveAgentMentions` yields
   `{name:"build", source:{value:"@build", start:0, end:6}}`. File and command
   modes keep the exact-match shortcut byte-for-byte. The hook's own
   `typeaheadExactMatch` (`useTypeahead.ts:351-356`) is not what `InputArea`
   consumes (the controller's overrides it, `useComposerController.ts:671`) and is
   left unchanged. The guard is explicit and does not depend on the row label.

5. **Agent row label → `@<name>` (review recommendation).**
   `useTypeahead.ts:247` changes `primary` from `@@${a.name}` to `@${a.name}` so the
   popup previews the text that will actually be inserted/sent. `row.key` (used by
   `applyTypeahead`) is unchanged, so selection/wire are unaffected; the popup
   `key` is `${kind}:${key}`, also unchanged. The trigger is explained in the help
   text (item 6) and the hook header comment. Item 4's guard is applied
   regardless — keyboard behaviour is not left to the label difference.

6. **Help text, `ChatPanel.tsx:154`.** Replace the single line with two:
   `"  @               file / reference mention typeahead"` and
   `"  @@              agent mention typeahead"` (keep column alignment with the
   neighbouring entries). Grep shows no test pins the old string.

## 4. Libraries / helpers considered

- No library: this is a ~15-line caret/tokenisation rule specific to this
  composer's syntax (mention libraries such as `react-mentions` / Tribute would
  replace the whole textarea + popup + attachment model, a far larger change than
  the bug, and none know about `@@` vs `@`).
- Reused: the existing popup, `useAgentCatalog` / `refreshAgentCatalog`,
  `resolveAgentMentions`, and the `chatUtils.ts` "extract pure logic + vitest"
  convention (AGENTS.md "Testing"). Chosen: extract detection into
  `detectTypeaheadTrigger`.

## 5. Tests

All in vitest. The component tests (B) are REQUIRED, not optional.

### A. Pure — `src/renderer/chatUtils.test.ts`, `describe("detectTypeaheadTrigger")`

Mention triggers:
- `("@@", 2)` → `{mode:"agent", query:"", anchorStart:0, anchorEnd:2}`.
- `("@@bu", 4)` → agent, query `"bu"`, anchors 0..4.
- `("hi @@bu", 7)` → agent, anchorStart 3, anchorEnd 7; `("hi\n@@x", 6)` (newline is
  whitespace).
- Mid-token caret: `("@@build ok", 4)` → agent, query `"bu"`, anchorEnd 7.
- File mode unchanged: `("@", 1)` → file, query ""; `("@src/fo", 7)` → file, query
  `"src/fo"`; `("see @a", 6)` → file, anchorStart 4.
- No popup: `("a@b", 3)`, `("foo@", 4)`, `("x@@y", 4)`, `("@foo@bar", 8)`,
  `("@@foo@bar", 9)`, `("@@@", 3)`, `("@a b", 4)` (caret past whitespace), `("", 0)`.
- Caret between the `@`s: `("@@x", 1)` → file, query "".

Slash semantics (review finding 2 — preserved deliberately, pinned explicitly):
- `("/review rest", 3)` → command, **query `"review"` (the whole first token, not
  the text before the caret)**, anchors 0..7.
- `("/review rest", 0)` → still command (caret 0 is inside the first token).
- `("/review.foo", 7)` → command, anchors 0..7 only (`[\w-]*` stops at `.`).
- `(" /rev", 5)` → null (leading space: not a command, token does not start `@`).
- `("/rev @file", 10)` → **file** mode, query `"file"`, anchorStart 5 (caret left
  the command token, falls through to mention detection).
- `("/rev x", 6)` → null; `("/@@x", 4)` → null.

The red demonstration is the component test B1 (`@@` opens the agent popup; fails on today's code) together with the positive agent assertions above.

### B. Component — `src/renderer/hooks/useTypeahead.test.tsx` (existing ChatPanel harness)

Setup: `installMockApi({ opencodeAgents: () => Promise.resolve([{name:"build",
description:"b"},{name:"plan",description:"p"}]), opencodePrompt: spy })`. A
`type(text)` helper sets the value with the native textarea setter, **sets
`selectionStart/End` to the caret BEFORE dispatching `input`** (the existing smoke
tests set it after, which is wrong because `updateInput` reads the caret during the
event), then flushes. Keys are `new KeyboardEvent("keydown", {key, bubbles:true,
cancelable:true})` on the textarea. Assertions read popup contents (rows by text),
the textarea value and the `opencodePrompt` spy — not just the textarea value. The
existing three smoke tests stay.

1. **Opens (fails on today's code):** type `@@` → popup lists `@build` and `@plan`;
   type `@@bu` → only `@build`; type `@@zzz` → "No matching agents".
2. **Exact + Enter (the blocking regression):** type `@@build`, press Enter →
   textarea becomes `@build ` (trailing space), popup closed, `opencodePrompt`
   NOT called. Press Enter again → `opencodePrompt` called once with text `@build`
   (trimmed per the existing submit path) and a 5th argument (mentions) equal to
   `[{name:"build", source:{value:"@build", start:0, end:6}}]`.
3. **Partial completion:** type `@@bu`, press Enter → `@build `, no send; same for
   Tab.
4. **Mouse selection:** type `@@pl`, click the `@plan` row → `@plan `, mention
   recorded; subsequent Enter-send carries the `plan` mention.
5. **Single `@` unchanged:** type `@` → file/reference popup (not agent rows); an
   `@file` exact-match + Enter still submits (shortcut preserved for file mode).
6. **Command unchanged:** type `/` → command rows; exact-match command + Enter
   still takes the existing submit path.
7. Run unchanged: `useTypeahead.test.tsx`, `chatShared.test.ts`,
   `backgroundRun.test.ts` (baseline per review: 116 tests pass) plus the
   command/background and CTO composer tests (`CtoChat.test.tsx`), after the change.

## 6. Acceptance criteria

- [ ] Typing `@@` in the session composer opens a popup listing agents
      (`@<name>` rows, previewing the inserted text); `@@bu` filters by substring;
      with no match it shows "No matching agents".
- [ ] Selecting a row — Enter, Tab or click — rewrites the draft to `@<name> `
      (single `@`) and records the mention; sending produces
      `{name, source:{value:"@<name>", start, end}}` (existing
      `resolveAgentMentions` behaviour, unchanged).
- [ ] Typing exactly `@@build` + Enter completes (does not send); the next Enter
      sends with the mention. Exact-match-submit is unchanged for file and
      command modes.
- [ ] `/help` lists `@` (files/references) and `@@` (agents) separately.
- [ ] The component tests in §5B pass and test 1 fails on `origin/main`.
- [ ] The CTO conversation composer behaves identically (same hook).
- [ ] Single `@` still opens the file/reference picker; `a@b` and `foo@` open
      nothing; slash-command typeahead unchanged.
- [ ] `detectTypeaheadTrigger` is a pure exported function with the §5A tests,
      including the slash-semantics cases.
- [ ] `npm run typecheck` and `npm test` pass.

## 7. Risks / open questions

- **Trigger vs inserted token.** The user types `@@`; the popup shows `@name`; the
  draft/wire token is `@name`. Documented in the hook header and `/help`. No wire
  migration. Keyboard correctness is enforced by the explicit agent-mode guard
  (§3 item 4), not by the label.
- **Caret between the two `@`** yields file mode (consistent with the old
  detector). Typing the second `@` flips file → agent via `updateInput`'s re-detect
  on every change. A debounced file search may already be pending/in flight from the
  `@` keystroke. Note the sequence counter (`fileSearchSeqRef`) increments only when
  a file-search timer fires (`useTypeahead.ts:139-149`), NOT when the mode changes,
  so a late file result can still `setFileResults`/`setReferences`; it is harmless
  because rows are built per mode (`typeaheadRows`, L218-282) and agent mode never
  reads `fileResults`. The results are hidden by mode-based row selection, not
  discarded by the counter.
- **Known limitation, NOT fixed here (review finding 3): agent catalog loading and
  failure.** `agentCatalog.ts:47-57` is `.then(...).finally(...)` with no rejection
  handler and no error/loading state, and `Composer.tsx:68-72` shows "No matching
  agents" whenever the agent rows are empty. Consequences: before the first fetch
  lands the popup says "No matching agents" (a loading hint that is really a false
  empty-state), and a rejected `opencodeAgents()` leaves an unhandled rejection and
  the same false message permanently. This predates and is independent of the
  detector change (the popup was simply never reachable). This spec does not claim
  the agent-fetch failure path is verified or complete. Follow-up to track: add a
  `loading`/`error` field to the shared agent catalog snapshot, a `.catch`, and a
  "Loading agents…" / "Couldn't load agents" hint, with a rejection test.
- **A draft ending in `@@` opens the agent list (accepted trade-off, Opus NIT).**
  E.g. a pasted diff hunk header ending in `@@` with the caret right after it:
  the popup opens and Enter completes the first agent instead of sending (Escape
  dismisses it, then Enter sends). On `main` nothing opened. Accepted: typing `@@`
  at the start of a token is exactly the trigger the feature defines, it is the
  same class as the existing bare-`@` file popup, and the popup only counts as open
  for the keyboard when the agent list has rows (`@@zzz` or a still-loading catalog
  sends as before). Narrowing the trigger (e.g. requiring a following letter) would
  make `@@` alone — the discoverable way to list agents — dead.
- iOS has no agent typeahead; adding one is a separate feature.


## Review responses

Review: `docs/superpowers/specs/reviews/2026-10-28-desktop-agent-typeahead-astra.md`.
Each finding verified against the code before responding.

1. **BLOCKING — exact-match Enter sends literal `@@build`, no mention.** Verified:
   `useComposerController.ts:612-617` (`input.trim() === row.primary`) +
   `InputArea.tsx:531-538` (submit on exact match) vs `useTypeahead.ts:247,307-316`
   (only selection rewrites and records). Accepted in full. Scope now includes
   `useComposerController.ts`: agent mode never takes the exact-match shortcut
   (§3 item 4); file/command modes unchanged. The "nothing downstream needs to
   change" claim in §1 is corrected. Required component regressions added in §5B
   (tests 2-4: `@@build`+Enter, partial completion via Enter and Tab, mouse
   selection, plus the subsequent send's mention source slice); they are not
   optional.
2. **SHOULD — pin slash semantics with explicit tests.** Verified
   (`useTypeahead.ts:163-173`: query is the whole first token; falls through when
   the caret leaves it). Accepted: §5A lists the exact cases (`/review rest`@3,
   caret 0, `/review.foo`@7, leading-space slash, `/rev @file`@end → file mode,
   plus `/rev x`, `/@@x`); command fetching/filtering/exact-match/apply stay
   unchanged (§5B tests 6-7 re-run the existing suites). Red-test concern accepted:
   the component test B1 is the red/green demonstration (rather than a missing
   export). A permanent exhaustive legacy-oracle test was proposed in the first
   revision and dropped in Round 2 (Astra R2-1: over-built; the concrete cases and
   component tests suffice).
3. **SHOULD — catalog loading/failure not handled as described; stale-result
   claim wrong.** Verified (`agentCatalog.ts:47-57` no rejection handler/state;
   `Composer.tsx:68-72` false "No matching agents"; seq counter only bumps when a
   file timer fires, `useTypeahead.ts:139-149`). Resolved by tracking, not fixing:
   a small catalog error/loading-state fix is real scope beyond this bug and the
   debt predates the change, so §7 now states the limitation plainly (no claim that
   the failure path is verified), names the follow-up, and §2 lists it as a
   non-goal. The stale-file-result statement is corrected: results are hidden by
   mode-based row selection, not discarded by the counter.
4. **NIT — help text advertises the wrong trigger.** Verified
   (`ChatPanel.tsx:154`). Accepted: §3 item 6 splits it into `@` (files/references)
   and `@@` (agents); the hook header comment is corrected too.

Reviewer recommendation (`@@name` label / `@name` insertion): adopted. Agent rows
now display `@name` (§3 item 5; label-only, `row.key` and the wire are unchanged),
with `@@` documented as the trigger, and the agent-mode guard applied independently
of the label.

### Round 2 (Astra: APPROVE, 1 SHOULD, 1 NIT)

- **R2-1 SHOULD — permanent exhaustive legacy oracle is over-built.** Accepted:
  removed from §5A and from the acceptance criteria; concrete cases + component
  tests remain; B1 is the red/green demonstration.
- **R2-2 NIT — stale "no other hook changes" sentence.** Accepted: §3 item 2 now
  says "Apart from the row-label change in item 5, catalog refresh and
  `applyTypeahead` remain unchanged."

### Code review (Opus: APPROVE, 1 SHOULD, 2 NIT)

Review: `docs/superpowers/specs/reviews/2026-10-28-desktop-agent-typeahead-opus.md`.

1. **SHOULD — single-`@` / `/` "unchanged" tests too weak.** Accepted and verified
   by mutation. §5B tests 5-6 now assert: `@` opens the reference popup (`@docs`)
   and a fully typed `@docs` + Enter still SENDS (`opencodePrompt` once, text
   `@docs`); `/rev` lists `/review` and `/review` + Enter still RUNS the command
   (`opencodeRunCommand` once, not a completion to `/review `). Widening the guard
   to `mode !== "command"` fails the file test; `mode !== "file"` fails the command
   test.
2. **NIT — draft ending in `@@` opens the agent popup.** Decision: acceptable, kept
   as is; documented as a trade-off in §7 (reasoning there).
3. **NIT — stale "Three triggers" comment.** Fixed: the `useTypeahead.ts` header now
   says "Triggers:".
