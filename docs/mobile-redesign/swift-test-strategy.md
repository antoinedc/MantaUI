# Swift test strategy — options

The mobile client is being rebuilt natively in Swift (settled stack, `DECISIONS.md`
§2) against a box that is now the **single interpreter** of the session stream
(`DECISIONS.md` §17, settled by BET-469). The web client migrates to that same
box interpretation, so the behaviour that today holds the web client together in
`src/renderer/` and `src/server/` is being repartitioned — and a Swift client
inherits none of the existing Node test suite automatically.

This document measures that suite, traces what §17 does to each part of it, and
lays out the viable test strategies for whatever actually lands on the device. It
is a comparison, not a decision: it ends with the question a human has to answer.

## What the current suite covers

The behaviour-critical logic lives in `src/renderer/chatUtils.ts` (2900 lines),
`src/renderer/api/httpApi.ts` (1101), `src/renderer/store.ts` (1051) and the
renderer hooks, with pure shared helpers in `src/shared/*.mjs`. It is held in
place by these test files:

| Module (BET-469-assigned) | Test file | Lines | Pure / rendering |
|---|---|---|---|
| `chatUtils.ts` (2900) | `chatUtils.test.ts` | 4040 | Pure |
| `store.ts` (1051) | `store.test.ts` | 726 | Pure |
| `api/httpApi.ts` (1101) | `api/httpApi.test.ts` | 370 | Pure |
| `voice.ts` (568) | `voice.test.ts` | 87 | Pure |
| `hooks/useSseBus.ts` (763) | `hooks/useSseBus.test.tsx` | 687 | Rendering (jsdom) |
| `hooks/useTranscriptState.ts` (397) | `hooks/useTranscriptState.test.tsx` | 389 | Rendering (jsdom) |
| `hooks/useTypeahead.ts` (328) | `hooks/useTypeahead.test.tsx` | 101 | Rendering (jsdom) |
| `hooks/useVoice.ts` (316) | `hooks/useVoice.test.tsx` | 186 | Rendering (jsdom) |
| `hooks/useInputHistory.ts` (159) | *(no dedicated suite)* | — | Via render harness |
| `hooks/useSessionResources.ts` (232) | *(no dedicated suite)* | — | Via render harness |

Two modules (`useInputHistory`, `useSessionResources`) have no dedicated test
file; the only suite that touches them is the render harness
`src/renderer/ChatPanel.harness.test.tsx` (711 lines, jsdom), which mounts the
full `ChatPanel` and covers them indirectly. Those four rendering-dependent
hook suites (`useSseBus`, `useTranscriptState`, `useTypeahead`, `useVoice`, 1363
lines) plus the harness (711) are the only tests that need a DOM/React
environment at all.

**The load-bearing split.** Of the dedicated logic-layer suites (6586 lines:
4040 + 726 + 87 + 370 + 687 + 389 + 101 + 186):

- **5223 lines are pure** — no DOM, no React, no Electron (all of `chatUtils`,
  `store`, `httpApi`, `voice`). These test behaviour that is independent of any
  rendering environment.
- **1363 lines require a rendering environment** — the four hook suites, each
  mounting `ChatPanel` in jsdom. Add the 711-line harness
  (`useInputHistory` / `useSessionResources` sole coverage) and the
  rendering-dependent total is 2074.

This is the number that matters: **pure tests move wherever the logic moves;
rendering-dependent tests do not.** The 5223 pure lines follow their functions
across the box/device boundary unchanged; the 1363 (+711) rendering lines are
tied to the React render lifecycle and exist because the current design couples
logic to the component tree.

`src/shared/*.mjs` adds a further 4280 test lines across ~20 files. Only a
subset is chat logic: `voiceClassifier.mjs` (minus-classifier input to the
device) and the `net/` reconnect modules (`backoff`, `backpressure`,
`connectionManager`, `state`). The rest — the token/identity surface (`claim`,
`unpair`, `transport`, `configMigration`, `worktree`, …) — is the shared module
layer §17 explicitly keeps (`DECISIONS.md` §1.10 / §17).

## What BET-469's decision does to it

§17 assigns each piece of logic to **box**, **device** or **split** by the
round-trip criterion (would moving it to the box add a network round trip, or
ride one that already happens?). Stream interpretation rides the existing wire
and moves up; interaction/formatting run at keystroke or frame rate and stay.
Applying that criterion to the BET-469-assigned modules:

| Module | §17 home | What happens to its existing tests |
|---|---|---|
| `chatUtils.ts` | **Split** — interpretation (~60%: truncation, delta flush, context arithmetic, cache staleness, todo, subagent, question hydration, turn-complete, auto-rename) → **box**; interaction (scroll pinning, command filtering, question form state, queued-drain abort) + formatting → **device** | Box-bound tests **stay in Node** (re-homed to the box's new interpretation module, same shape, untouched suite). Device-bound tests **reimplemented in Swift**. |
| `api/httpApi.ts` | **Device** — the client's HTTP transport to the box | **Reimplemented in Swift** (`URLSession`); the JS fetch wrapper suite no longer applies. |
| `store.ts` | **Device** — the client UI/state store | **Reimplemented in Swift** (state layer). |
| `hooks/useSseBus.ts` | **Split** — stream connection/reconnect/hold → **device**; event interpretation → **box** | Interpretation tests **stay in Node**; connection ones **reimplemented in Swift**. |
| `hooks/useTranscriptState.ts` | **Split** — delta buffering/flush, turn-complete → **box**; pin-to-bottom scroll → **device** (native; measured by BET-481) | Buffer/flush tests **stay in Node**; scroll behaviour **reimplemented natively** (SwiftUI provides it — BET-481 measures whether). |
| `hooks/useTypeahead.ts` | **Device** — keystroke-rate | **Reimplemented in Swift**. |
| `hooks/useInputHistory.ts` | **Device** — keystroke-rate | **Reimplemented in Swift**. |
| `hooks/useSessionResources.ts` | **Device** — session-resource view of box data | **Reimplemented in Swift**. |
| `hooks/useVoice.ts` | **Device** — interaction/gating | **Reimplemented in Swift** (with `voiceClassifier`). |
| `src/shared/*.mjs` | **Split** — the shared token module **survives** (BET-453); chat-logic shared (`voiceClassifier`, `net/` reconnect) is device-reachable | Token-module tests **stay in Node + shared Swift mirror**; device-reachable logic **reimplemented in Swift**. |

**Column totals** (counting each module once against its dominant fate, and each
split module for both of its halves):

- **Stays in Node, untouched:** the box-bound halves of `chatUtils`, `useSseBus`,
  `useTranscriptState` (delta/buffer work) and the surviving token module. This
  is the majority of the 5223 pure lines.
- **Must be reimplemented in Swift:** the device-bound `httpApi`, `store`,
  `useTypeahead`, `useInputHistory`, `useSessionResources`, `useVoice`, the
  interaction/formatting half of `chatUtils`, the scroll half of
  `useTranscriptState`, and the connection half of `useSseBus`.
- **Becomes unnecessary because the behaviour moved away:** the flushing/
  interpretation coverage that moves wholesale to the box (its DOM-independent
  logic) and the rendering-dependent harness coverage of hook wiring, which
  stops applying once the component tree is SwiftUI.

The rendering-dependent 1363 (+711) lines are the awkward residue: they test
behaviour that partly stays on the device, but only by mounting the React
component tree. None of that transfers to Swift unchanged — it is the design
cost of logic being coupled to `ChatPanel`.

## What lands on the device

After the box absorbs interpretation, the Swift client's testable surface is
small and mostly pure:

- **Interaction logic ported from `chatUtils`** — scroll pinning policy,
  command filtering, question form state, queued-drain abort.
- **Formatting** — token counts, durations, clock times, stage colours (one
  line each, per §17).
- **Transport + state** — the `URLSession` client (`httpApi` equivalent) and the
  on-device state store (`store` equivalent).
- **Keystroke-rate logic** — `useTypeahead`, `useInputHistory`, `useVoice` /
  `voiceClassifier`.
- **Stream connection** — SSE connection, reconnect, backoff (`net/`),
  degraded-mode hold.

Everything else — truncation, delta flush boundaries, context arithmetic, cache
staleness, todo, subagent tracking, question hydration, turn-complete,
auto-rename — is asserted by the box, and the Swift client is not where that
behaviour is tested.

## Options for the device side

Any option that needs a simulator (UI tests, snapshot) inherits the macOS-runner
constraints priced in `docs/mobile-redesign/swift-ci-options.md` (BET-482):
a Mac build/job is metered queue time on a Mac runner, and a simulator boots only
on a Mac.

**Option 1 — Unit tests of pure Swift logic.** Test the ported interaction,
formatting, transport, store and keystroke logic as pure Swift functions.
- Catches: regressions in the device-side logic under §17 — scroll policy,
  command/typeahead/input-history behaviour, voice dispatch, state transitions,
  formatting, reconnect/backoff.
- Does not catch: anything visual, anything requiring a running UI, integration
  against the real box.
- Cost: pure and fast; runs headless on a macOS runner (or even
  `swift test` non-simulator on a Mac). Cheapest option per assertion. This is
  where the reimplemented half of the split modules and the device-only modules
  would live.
- Framework: either **XCTest** (built-in, familiar, stable) or **Swift Testing**
  (newer, cleaner `#expect` syntax, `swift-testing` parallelized, requires
  Swift 6 / Xcode 16+, integrates with the same `swift test` runner). Both are
  available; the choice is the human's — see the open question.

**Option 2 — Snapshot/visual verification via the existing capture recipe.**
Reuse `spike/native-visual/capture.sh` (or its successor) to capture rendered
SwiftUI scenes and diff them, mirroring the web client's visual gate.
- Catches: unintended visual/regression drift in fixed scenes — the transcript,
  the session list, stage colours.
- Does not catch: live-typed behavioural logic, or streaming under motion
  (snapshots are about a frozen moment).
- Cost: requires a simulator on a macOS runner to render; a capture per scene is
  cheap but each new scene is authoring work, and simulator captures are slower
  and flakier than headless unit tests (see BET-482's simulator-cost note).

**Option 3 — UI tests through the accessibility layer (XCUITest/XCUI).**
Drive the real running app via the accessibility hierarchy — the recipe BET-481
already uses for driving scroll on the simulator.
- Catches: end-to-end user flows as a user would do them — onboarding/pairing
  round trip against a live box, tapping a session, scrolling a streaming
  transcript, degraded mode when the link drops. This is the only option that
  catches wiring gaps between the Swift views and the logic that unit tests
  cannot.
- Does not catch: anything not reachable through the accessibility tree, and it
  is the most fragile — it depends on simulator availability and on
  accessibility identifiers staying stable.
- Cost: the most expensive per assertion (a full simulator boot + app launch +
  live box per run), the flakiest, and wholly dependent on the macOS-runner
  decision in BET-482. BET-481's hierarchy-dump precedent shows it is
  achievable but simulator-dependent.

**Option 4 — No automated testing on the device side, risk stated honestly.**
Ship the Swift client without local automated tests, relying on the box's Node
suite for all behavioural correctness and on manual QA for the thin client.
- Catches: nothing on the device automatically. The box suite still pins every
  interpretation decision; only the small device-side interaction/formatting set
  would be unguarded — but this set is exactly the part that survives §17, so a
  regression there would be caught only by a human manually driving the app, on
  a platform with no visual gate and no CI.
- Cost: near zero now for the device, but it is precisely the gap this issue
  exists to avoid — device-side drift chosen by omission rather than
  deliberately, with the most regressible behaviour (scroll policy, input
  history) unprotected.

The three real options (1, 2, 3) are not mutually exclusive — 1 is the cheap
base that covers the logic that actually lands on the device; 2 and 3 are
progressively heavier, more Mac-bound layers covering the visual and the
end-to-end. Option 4 is the honest-cost baseline against which to judge the
other three.

## Open question for the human

What does the Swift client's test suite need to be, and at what cost in
macOS-runner CI minutes? The narrowest credible position is Option 1 only —
unit tests of the device-side interaction, formatting, transport, store and
keystroke logic, run headless on a Mac — costing nothing but the CI time this
small pure surface takes to compile and run, and inheriting none of the
simulator constraints from BET-482. Each additional layer (snapshot via the
capture recipe, then XCUITest end-to-end) buys coverage of things unit tests
cannot see — the rendered visual, and the wiring between Swift views and a live
box — but each is simulator-bound and metered by the same macOS-runner decision.
And separately, for whatever is run, the choice of Swift Testing versus XCTest
for the unit layer has to be made; both are current and CI-friendly, with Swift
Testing the newer idiomatic option, and this document does not pick one. The
question is whether the device side is guarded by nothing (Option 4), by unit
tests alone (Option 1), or by unit tests plus one or both simulator-dependent
layers (Options 2 and 3) — and on which testing framework if any unit layer is
chosen.
