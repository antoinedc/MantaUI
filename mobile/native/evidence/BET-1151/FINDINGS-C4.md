# BET-1151 — C4 on-device re-run (load-earlier reachable) with the early-history fixture mode

**Result: load-earlier (C4) CONFIRMED reachable and functional on current `main`
(BET-1105 merged, MessagingUI `1ec611a`)** — the reviewer's Block is closed by
evidence, using manta-dev's new `capture-fixture` early-history mode.

Date: 2026-08-18
Build: current `main` `b4c92470` + manta-dev's `capture-fixture` change
(branch `multica/BET-1151-fixture-early-history`). iPhone 17 Pro sim, iOS 26.5.
Method: real-gesture CGEvent slow drags (BET-1123/1151 method — not XCUITest
`swipeUp()`, which cannot drive MessagingUI's pan, and not the harness that
produced the "frozen" artifact). Fixture run with `FIXTURE_EARLY_HISTORY=1` so
`opencode:messages` honors the client `limit` and returns the recent-tail
window, exactly as a real box does.

## Setup: the app now sees a "more history exists" window

With the early-history fixture, the app's first fetch is
`opencode:messages {limit:30}`. The fixture returns the last 30 of the 46
messages (window starts at `f1016` / "Filler question 8"). So the store's
`hasEarlier` = `loaded.count >= limit` (30 >= 30) = **true** — the load-earlier
edge row is live (it never was, before this fixture mode: the old fixture
returned all 46 at any limit, so `hasEarlier` was always false).

Evidence: `c4-01-tail-30msg-window.png` shows the chat opened anchored at the
tail with the 30-message window. The fixture served
`early-history window limit=30 -> 30 msgs (full=46)`.

## 1. Load-earlier is reachable (scrolling to the top edge triggers it)

Stepwise real-gesture down-drags walked the transcript up from the tail. The
very drag that brought the window's first message ("Filler question 8") to the
top of the viewport made the load-earlier **edge trigger fire** — the fixture
log shows `opencode:messages` immediately re-requested with the widened
`limit=80`:

```
[rpc] opencode:messages early-history window limit=30 -> 30 msgs (full=46)
[rpc] opencode:messages early-history window limit=80 -> 46 msgs (full=46)
```

`c4-02-top-edge-load-earlier-fired.png` captures that exact frame: the window
top ("Filler question 8") pinned at the top edge with the widen in flight.

**Mechanism (documented for the reviewer):** MessagingUI's `.prependLoader` is
**edge-triggered** — `TiledView.swift`'s `EdgeLoadTrigger` fires `perform`
(`store.loadEarlier()`) when the user scrolls near the top edge (`case
edgeThreshold`). The app's `LoadEarlierRow` button action is empty (`{}`); the
load is driven by reaching the edge, not by tapping the row. The row's loading
state is a `ProgressView` (no OCR-able "Load earlier messages" text), which is
why the reachability is evidenced by the edge-trigger + widen rather than by a
text line. This is the product's actual designed behavior, not a regression.

## 2. Loading earlier widens the history (the 16 earlier messages appear)

After the edge-trigger fires, the app requests `limit=80`; the fixture returns
the full 46. The earlier 16 messages (`f1000..f1015`, "Filler question 0..7")
— which were NOT in the initial 30-window — are now loaded. Continuing the
real-gesture scroll past the old edge reveals them: `c4-03-earlier-revealed-
scrolling-past-edge.png` (scrolling past the former top now shows the earlier
filler rows that were previously absent).

## 3. The edge row drops once the whole history's top is reached

Once `limit=80` returns all 46 messages, `hasEarlier` = `46 >= 80` = false, so
no further load-earlier can fire. Real-gesture scroll to the very top of the
full history pins "Filler question 0" (the first message) at the top with no
load-earlier row (`c4-04-full-history-top-row-dropped.png`), matching the
acceptance "the row drops once the top is reached". Live AX confirmed no
load-earlier element at the full-history top.

## Numbers (objective, computed)

- Window before widen: 30 msgs; the transcript is freely swipe-scrollable from
  the tail to the window top with real drags (first drag already moved it: see
  the earlier C5 evidence in `FINDINGS.md` on `agent/macos/89af73d4`).
- Fixture log is the authoritative widen signal: `limit=30` → `limit=80` fired
  exactly when "Filler question 8" reached the top edge (stepwise run: widen
  count incremented on the step where the window top hit the viewport top).
- Full-history top: "Filler question 0" at the top, row dropped.

## Verdict

Both BET-1105 interactive checks are now evidenced:
- **C4 (load-earlier reachable):** the affordance is reachable (scroll to the
  top edge) and widens history (30 → 46, the 16 earlier messages appear); the
  row drops at the full-history top. Confirmed on the post-migration build.
- **C5 (scrolls on first swipe):** confirmed in the companion run (a single
  real drag scrolls from the tail; "Scroll to bottom" chip appears).

Combined with §"frozen"-is-artifact reproduction on the same build, this
closes BET-1151: no ships-alone transcript code change is warranted. The one
fixture-only change that makes all of this exercisable is manta-dev's
`FIXTURE_EARLY_HISTORY=1` mode in `capture-fixture/fixture-box.mjs`.
