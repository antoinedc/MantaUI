## BET-791 — Progress: rewrite the running indicator + the blocked card

Implements **§6.2 `ui` sink** renderer half (BET-790 was the server + `progress_report` tool; BET-783 the bounded card stack). The design mockups [C8] (running indicator) and [C9] (blocked card) are implemented against `tokens.css` / existing primitives — no new colour token, no new component for part 1.

### Part 1 — the running indicator [C8]
`WorkingIndicator` now takes one optional `progress` prop. The pure, tested `workingIndicatorLabel()` in `chatUtils.ts` builds the meta tail:

- **No progress record** → the whole line is byte-identical to before (`Ruminating… · 4m 12s · 18k tokens`, one faint mono span).
- **Working record** → the model's label renders as its own `text-text font-medium` headline span and the `· 3/5 · 4m 12s · 18k` run stays a single faint mono span (the [C8] split). `step/total` only when **both** are present — indeterminate work shows no counter, never `3/?`.
- **`blocked` yields to the card**; `done`/`failed` have no indicator treatment (the turn ending is already visible).
- No progress bar anywhere. No new element in part 1.

`Transcript`/`TranscriptTail`/`TranscriptContext` thread the record through; `ChatPanel` holds `liveProgress` (fetched via `progressGet`, refreshed on the `progress.updated` bus event — wired through the existing 3-edit path in `httpApi.ts`: `Kind` union + `listeners` record + `onProgressUpdated` subscriber, mirroring `onDelegateUpdated`). The renderer never clamps a step — it displays the server's record verbatim.

### Part 2 — the blocked card [C9]
`state === "blocked"` registers one warn-toned `BlockedProgressCard` in the **blocking tier** of the card stack, alongside permission/delegate-approval and never below an ambient card. Uses new one-line extendable primitives (reusable, per the parent epic): a **`warn` variant on `Card.tsx`** (`border-warn bg-warn-bg`, mirroring the danger variant) and a **`warn` tone on `StatusDot`**. Headline `Blocked — needs a decision` (13px/600 `text-text`), body is the model's `detail` through the transcript's markdown treatment (inline `code` like `legacy_id` renders). No `×` — it clears when the model reports a different state or the turn ends. No toast / desktop notification / push from any progress state.

### Part 3 — sidebar + iOS subtitle
- Desktop sidebar: the four-slot contract is closed; the progress label rides the existing `dotFor` running **title tooltip** (the subagent count's home) via a new `setChatProgressLabel` store action → `WindowStatusUI.progressLabel`.
- iOS `SessionListView`: `SessionRowSubtitle.text(for:)` now prefers a working `progressLabel` over `running`/`running · model` (keeps subagents precedence). `SessionListStore` fetches `progress:get` on `progress.updated` frames + a refresh backfill, threads it through `rowStatus`.

### Part 4 — attention signal for `blocked`
`blocked` was added to the existing `AttentionKind` union + `setChatAttention` latch and lights the same sidebar attention dot as a pending question (`Sidebar.dotFor` variant `att`).

### Removal beats addition
No code path was removed — nothing here superseded an old one. Part 1 deliberately adds **no** component (`WorkingIndicator` edited in place); the only new component is the blocked card, which is the one state the design says earns a card. `progressLabel` is an internal `WindowStatusUI` field (tooltip content), not a new row slot.

### Verification results
- PR branch (`multica/BET-791-progress-running-indicator` @ `fe269453`):
  - typecheck: exit 0, errors none (log sha256 `b3b1dadc`-base; local `npx tsc --noEmit` clean)
  - test: exit 0, **2485 pass / 0 fail / 7 skip** (133 files). Failures: none.
- Base (`main` @ `b3b1dadc`): same suites green locally prior to this work.
- **Conclusion:** 0 new failures. Required gate `npm run typecheck && npm test` is green on the branch.

### iOS build note
The iOS subtitle change (`mobile/native/**`) is implemented and unit-tests updated, but the native Swift build/run is a **Mac step** I (Linux box) cannot perform. **Handed to `macos`** to build + run `SessionModelsTests` and capture a screenshot if desired. The required CI gate does not compile Swift, so this does not gate the PR's own checks.

### Base
`Base: origin/main @ b3b1dadc`
