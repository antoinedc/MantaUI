# BET-1138 — iOS context strip + sheet on-device capture

On-device verification of BOTH context states for the iOS context strip + sheet
(`multica/BET-1138-context-unknown`). Driven on the iPhone 17 Pro simulator against the
repo's deterministic capture-fixture box (127.0.0.1:8787) via its `__/control` channel.

## Known-reading path (`hasLimit:true`) — the reviewer's returned block

The fixture's `context` /__control action emits a `context` frame with `hasLimit:true`,
totalInput 55000, pct 55. `MantaContextStripVerifyUITests.testContextStripRendersOnDevice`
opens the chat, feeds that frame, and captures the KNOWN state. `UsageMeters.recompute`
(48cef268) preserves the box's `hasLimit`, so the strip renders the numeric-% known path
even though `opencode:models` returns `[]`.

- `known-strip.png` / `known-strip-hierarchy.txt` — the context strip in the KNOWN state.
  AX: Button `identifier: 'context-strip'`, `label: 'Context 28 percent, cache cold, 12k
  tokens re-billed on the next message'`, `value: 28 %` — a real numeric percentage (the
  gauge, `StaticText '28%'`, and the `12k cold` chip), NOT the unknown full-green fill.
- `known-sheet.png` / `known-sheet-hierarchy.txt` — the sheet behind the strip after
  tapping. AX: header `'28, %, 55k of 0 · Default'` (the big 28 + the `55k of <limit>`
  line) and the segmented-meter legend `fresh 4k` / `written 0` / `cached 51k`. This is
  the `hasLimit:true` segmented bar path the reviewer asked to see.

NOTE on `of 0`: the fixture serves no model with a context window (`opencode:models` →
`[]`), so the selected-model `limit` is nil and `UsageMeters.formatTokens(nil)` reads
`0`; on a real box the `of <limit>` denominator is the model's window. The point the
KNOWN path demonstrates — the strip shows a numeric %, and the sheet renders the
segmented bar with fresh/written/cached — is what the screenshots + AX trees prove.

## Unknown-reading path (`hasLimit:false`)

The fixture's `context-nolimit` /__control action emits a `context` frame with
`hasLimit:false` and only the raw token totals (fresh 10000 / cacheWrite 5000 / cacheRead
30000, total 45000, pct 0, no segments). `MantaContextStripVerifyUITests.
testNoMaxContextStateRenders` opens the chat, feeds that frame, and captures the two states.

- `unknown-strip.png` / `unknown-strip-hierarchy.txt` — the context strip in the no-max
  state. AX: Button `identifier: 'context-strip'`, `label: 'Context — no max context info
  for this model'`, `value: 100 %` — i.e. a full-green fill with NO numeric percentage and
  no `of <limit>` text.
- `unknown-sheet.png` / `unknown-sheet-hierarchy.txt` — the sheet behind the strip after
  tapping it. AX: `StaticText 'No max context info for this model'` plus only the token
  legend `fresh 10k` / `written 5k` / `cached 30k` — no bar, no pct, no `of <limit>`.

This matches the issue's "Done means": a full-green bar + "No max context info for this
model" with tokens-only for a model with no reported limit.

## Test result

Both UI tests pass on-device (iPhone 17 Pro simulator, `build/DD1138`):

- `testContextStripRendersOnDevice` (KNOWN) — **passed** (~19s): `hasNumericPct=true`,
  `knownSheetShown=true` (segmented bar + legend present).
- `testNoMaxContextStateRenders` (no-limit) — **passed**: strip label `'Context — no max
  context info for this model'` with NO numeric %, sheet shows `'No max context info for
  this model'` + tokens only. The sheet is reached by keeping the `context-nolimit` frame
  live while tapping (the fixture context is transient; a refetch can evict it before the
  tap lands, so the test re-pushes on each iteration until the sheet is confirmed).

The full `MantaUITests` unit suite is green (551 tests, 0 failures) including
`UsageMetersTests` (unknown-limit recompute cases) and `MantaEventStreamTests` (context
payload decode with/without `hasLimit`).
