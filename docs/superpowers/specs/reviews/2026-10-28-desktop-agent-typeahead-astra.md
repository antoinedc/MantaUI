# Astra spec review

## Findings

1. **BLOCKING — Fully typed agent + Enter bypasses selection and sends no agent mention.** Evidence: `src/renderer/hooks/useComposerController.ts:610-617` considers `input.trim() === row.primary` an exact match; `src/renderer/InputArea.tsx:531-538` submits rather than selects on that match. Agent rows use `@@build` (`useTypeahead.ts:247`), but only selection rewrites to `@build` and records the mention (`useTypeahead.ts:307-316`). After this fix, typing exactly `@@build` and pressing Enter therefore sends literal `@@build` without recording a mention. Both hosts resolve only recorded mentions (`ChatPanel.tsx:1492,1910`, `CtoChat.tsx:1075`, `chatShared.tsx:82-103`). This contradicts the claim that the entire downstream path is already correct. **Exact change:** include `useComposerController.ts` in scope; agent mode must never take the exact-match submit shortcut. Preserve the existing shortcut for file/command modes. Require a component regression for `@@build` + Enter: first press inserts `@build `, does not send, and records the mention; subsequent send includes its correct source slice. Also exercise partial completion and mouse/Tab selection. The existing harness supports input events and keyboard events; this regression must not be optional.

2. **SHOULD — Preserve the less-obvious slash semantics with explicit tests, not the existing smoke assertions.** Evidence: `useTypeahead.ts:163-173` derives the command query from the entire first command token, not the text before the caret, and falls through to mention detection when the caret leaves that token. `hooks/useTypeahead.test.tsx:50-99` checks only textarea values, never popup contents or selection. **Exact change:** extend §5 to assert `/review rest` at caret 3 gives query `review`, anchors 0..7; caret 0 retains command mode; `/review.foo` at caret 7 anchors only `/review`; leading-space slash does not trigger; `/rev @file` at the final caret still opens file mode. Keep command fetching, filtering, exact-match Enter and application unchanged. Run the existing hook, command/background, and mention tests after implementation. A new export missing on main is not itself a meaningful red test: demonstrate the regression against the old detector body or through the component.

3. **SHOULD — Loading and catalog failure are not actually handled as the spec describes.** Evidence: `agentCatalog.ts:47-57` has `.then(...).finally(...)` with no rejection handler or error state; `Composer.tsx:68-72` displays “No matching agents” whenever agent rows are empty. A rejected request leaves an unhandled rejection and a false no-results message, not just a temporary loading hint. This is pre-existing shared-catalog debt, not caused by token extraction, but §7 should not describe all failure cases as acceptable loading. **Exact change:** explicitly distinguish and track the existing failure limitation in the spec (or scope a small catalog error/loading-state fix with a rejection test). Do not claim the agent-fetch failure path is verified or complete. Also correct §7's stale-file-result claim: the sequence counter increments only when a file timer fires (`useTypeahead.ts:139-149`), not when switching to agent mode; mode-based row selection hides those results, rather than the counter necessarily discarding them.

4. **NIT — In-app help still advertises the wrong trigger.** Evidence: `ChatPanel.tsx:154` says `@ file or agent mention typeahead`; the proposed fix deliberately keeps agents out of the single-`@` picker. **Exact change:** split that help entry into `@` for files/references and `@@` for agents, alongside the planned hook-header correction.

## Requested recommendation: `@@name` label / `@name` insertion

Keep `@@` as the trigger and `@name` as the inserted/wire token. Prefer displaying `@name` in agent rows, so the popup previews the actual insertion; the trigger can be explained in help. This is a label-only change and does not require a wire migration. If minimal scope keeps the current `@@name` label, document trigger-versus-insertion explicitly and still apply finding 1's agent-mode guard. Do not rely on a display-label mismatch to enforce keyboard behaviour.

## Verification and scope assessment

- Root cause confirmed: choosing the last `@` makes the agent branch unreachable. The proposed leading-token detector fixes it. Session and CTO share the same hook; iOS has no agent-mode sibling to fix.
- Compared the actual existing detector body (extracted in memory from `useTypeahead.ts`) with an in-memory implementation of the specified algorithm over **219,345 text/caret cases** (strings through length five over `@ / a - _ space newline !`, every valid caret). **Zero unexpected differences**; 1,938 changes were exclusively old-null → new-agent. Additional longer slash/mid-token examples preserved the full-token query and fallback behaviour. This verifies the proposed algorithm, not an implementation that has not been written yet. Caret clamping intentionally changes invalid programmatic offsets; textarea carets are already in bounds.
- Baseline check: `vitest run src/renderer/hooks/useTypeahead.test.tsx src/renderer/chatShared.test.ts src/renderer/backgroundRun.test.ts --maxWorkers=1` — **3 files, 116 tests passed**. No claim that post-change tests pass: only the spec exists today.
- Moving detection into `chatUtils` adds no new dependency edge: the hook already imports that module. Existing command filtering/application and submit parsing need no changes. The no-library choice is proportionate for this small grammar fix.
- No implementation files changed during review.

VERDICT: CHANGES REQUIRED

## Round 2

### Resolution of Round 1

- **Finding 1 resolved in the spec:** §3.4 explicitly disables exact-match submission in agent mode, independently of display copy. §5B makes completion-without-send and subsequent mention-bearing submission mandatory. This fixes the actual controller consumed by InputArea and preserves file/command behaviour.
- **Finding 2 resolved in the spec:** §5A pins the full-token slash query, caret-zero behaviour, punctuation boundary, leading-space exclusion and fallback to file mentions. Component tests now assert popup/selection/send outcomes, rather than merely textarea values. The component opening test provides a meaningful baseline failure.
- **Finding 3 resolved by accurate scoping:** §7 records the pre-existing catalog failure/loading limitation and follow-up; it correctly explains that mode selection hides late file results. Deferring the shared-catalog change is appropriate for this bug.
- **Finding 4 resolved in the spec:** §3.6 corrects `/help`, alongside the hook comment.
- **Label recommendation adopted correctly:** `@name` previews insertion, while `@@` remains the trigger. The explicit keyboard guard remains necessary as a semantic rule, rather than depending on label formatting.

### New findings

1. **SHOULD — The permanent exhaustive legacy oracle is over-built; retain the focused regressions instead.** Evidence: spec lines 197-204 and 254-255 now require a copied old implementation and 219,345 comparisons on every test run. Round 1's exhaustive comparison was a one-off review experiment, not a requested permanent test architecture. The explicit token/slash cases and required component red test already cover this fix meaningfully. **Exact change:** remove the mandatory exhaustive oracle and its acceptance-criteria reference; keep the concrete cases and component tests. If retained as an optional experiment, compare only trigger fields: the old body returns `selectedIdx: 0` (`useTypeahead.ts:171,191`), whereas the proposed helper deliberately does not. Literal equality against the verbatim legacy return would fail on every ordinary file/command result. Also call this a compatibility check, not the red demonstration: an oracle test allowing null→agent differences does not itself require any such difference; the positive agent assertions/component test do.

2. **NIT — One stale scope sentence contradicts the accepted label change.** Evidence: spec lines 126-127 say “No other hook changes: agent rows … are already correct,” but §3.5 explicitly changes those rows. **Exact change:** say “Apart from the row-label change in item 5, catalog refresh and applyTypeahead remain unchanged.”

### Assessment

No remaining blocking design issue found. Production changes are proportionate: detector extraction/fix, a one-branch keyboard guard, and matching row/help copy. The only unnecessary expansion is the permanent exhaustive legacy-test requirement above. Command detection is still specified verbatim; the previous parity evidence continues to apply because that algorithm has not changed. This is spec approval, not implementation verification: source files remain unchanged, so no new post-change test result is claimed.

VERDICT: APPROVE
