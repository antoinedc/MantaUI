# BET-1138 — iOS no-max-context capture

On-device verification of the unknown-context state for the iOS context strip + sheet
(`multica/BET-1138-context-unknown`). Driven on the iPhone 17 Pro simulator against the
repo's deterministic capture-fixture box (127.0.0.1:8787) via its `__/control` channel.

## What was captured

The fixture's new `context-nolimit` /__control action emits a `context` stream frame with
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

`xcodebuild test … -only-testing:MantaUIUITests/MantaContextStripVerifyUITests/
testNoMaxContextStateRenders` — **passed** (41s). The full `MantaUITests` unit suite is
green (551 tests, 0 failures) including `UsageMetersTests` (unknown-limit recompute cases)
and `MantaEventStreamTests` (context payload decode with/without `hasLimit`).
