# BET-1151 — Interactive real-gesture re-run on current `main` (BET-1105 merged)

**Result: first-swipe scroll CONFIRMED on current `main`; the "frozen at tail"
report is an XCUITest synthetic-swipe artifact, not a product defect** — i.e.
manta-dev's root-cause attribution (from BET-1123) is reproduced on the
post-migration build and the transcript scrolls with a real finger.

Date: 2026-08-18
Build: current `main` `b4c92470` (BET-1105 merged — MessagingUI pinned to
`1ec611a`, `TiledView(items:)` snapshot API).
Simulator: iPhone 17 Pro, iOS 26.5 (UDID 25EEA3D7-…). Xcode 26.6.
Method: real gesture injection — host-side CGEvent mouse-drags delivered into
the Simulator window (the same method BET-1123 documented as the one that
engages MessagingUI's `TiledView` pan recognisers, where XCUITest
`swipeUp()`/`press(forDuration:thenDragTo:)` do not).
Test box: `capture-fixture/fixture-box.mjs` on `127.0.0.1:8787` (46-message
tall transcript = 22 long prose filler pairs + 2 anchors). App paired to it,
chat opened to the transcript, anchored at the tail.

## 1. First real drag scrolls immediately (BET-1105 Check 5) — CONFIRMED

From the tail, a SINGLE deliberate downward CGEvent drag in the transcript:

- `01-at-tail.png` (before) vs `02-after-first-drag.png` (after one drag):
  pixel-diff of the transcript region (device y 0.15–0.82) = **15.23% changed,
  maxDelta 204** (0.00% would mean no motion). The content visibly moved up one
  full filler pair ("Filler question 21" → "Filler question 20" at the same
  screen position).
- Live accessibility of the running app immediately after: the **"Scroll to
  bottom" chip is present** (AX query hit `desc="Scroll to bottom"`), which is
  the designated corroborating signal that the list has moved off the tail.

So the transcript scrolls on the **first** swipe with a real gesture — no second
swipe required.

## 2. Swipe-scrolls up from the tail across the whole fixture — CONFIRMED

Repeated down-drags walked the transcript from the tail through all 46 messages
to the very top ("Filler question 0" pinned under the `Chat` header), in
monotonic, non-jumping steps (no content-offset jumps: each drag advanced
exactly one filler pair, `03-scrolled-to-top.png`). Pixel-diff tail-vs-top:
**19.04% changed**. The transcript is freely swipe-scrollable over its full
range from the tail.

## 3. The "frozen" signature is instrumentation, reproduced on current main

The XCUITest driver `MantaFirstSwipeScrollGestureUITests` (same tall fixture,
same main build, one synthetic `swipeUp()`) observed:
`at-tail=true scrollBefore=0% scrollAfter=0% chipAppearedAfterOneSwipe=false`.
That is exactly the "frozen at tail / scrollbar pinned / no motion" reading
BET-1151 reported and BET-1123 attributed to synthetic XCUITest swipes being
unable to drive MessagingUI's pan. It is the reciprocal of §1's real-gesture
result on the same build.

## 4. Load-earlier affordance (BET-1105 Check 4) — fixture limitation, noted

The "Load earlier messages" row is `TiledView`'s `.prependLoader` edge-header;
it participates in scroll bounds only while the edge-loader is visible, and the
store's `loadEarlier()` is guarded on `hasEarlier`. With this fixture the whole
46-message history is returned in ONE `opencode:messages` response, so the
widening refetch has nothing new to add and no persistent edge-row to show; at
the pinned top the AX tree contains no `load-earlier` element. This is a
property of the non-paginated fixture, not of the migration: BET-1105 changed
only `dataSource`→`items` (scroll/inset/gesture config byte-identical per the
ticket), and this fixture cannot exercise a real early-history window. Verifying
the affordance's reachability requires a box that returns a truncated
"has earlier" window; none of the shipped fixture data does.

## Notes / method details

- The simulator's own `simctl` screenshot + Vision OCR + a live-AX read were
  used for objective text/geometry signals (this report's author cannot view
  raster images). All numbers above are computed from the screenshots, not
  read by eye.
- The pairing was driven via a deep-link claim (`manta://pair?box=…&code=…&
  server=http://127.0.0.1:8787`); the first post-claim session-list load
  reported a transient "Couldn't reach your server" that cleared on the next
  launch (the app then rendered Demo/Chat from the fixture) — that transient is
  the claim flow, unrelated to the scroll path under test.
- The previously-committed `MantaUI.xcodeproj/project.pbxproj` was stale (it did
  not reference `DeprecatedModelOptIns.swift`, so a clean `xcodebuild` failed
  with "cannot find 'DeprecatedModelOptIns' in scope"); regenerating with
  `xcodegen generate` builds cleanly. That regeneration is NOT shipped here
  (out of BET-1151 scope).
