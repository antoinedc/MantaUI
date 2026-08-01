# BET-481 SCROLL FINDING — does SwiftUI hold scroll position under a streaming transcript?

**Status: measurement only. No code fix implemented — a negative result would
have been the successful outcome; both results were positive.**

## The transcript container being measured

`spike/swiftui-ref/MantaSpikeRef/ChatView.swift` renders the transcript with a
**`ScrollView` containing a `LazyVStack`**, plus
`.defaultScrollAnchor(.bottom)`. That is the exact existing composition the 
mobile plan would build on — nothing about it was changed for this measurement
(the only edits were the streaming append on a 100ms timer and the UI-test
capture methods).

## Streaming stimulus

Appended a fixed 40-char string every 100ms for 60 ticks (6s) to the last
transcript message, auto-started when the chat screen appears. All fixed values
as specified; no randomisation, no tuning.

## Case 1 — user is at the bottom (no scroll)

**Result: HELD.** The view stays anchored to the bottom; new text remains
visible at the bottom as it arrives.

Evidence (all three during active streaming — the message kept growing between
them): the streaming message's **bottom edge stays fixed at ~743.7 pt** (the
viewport bottom) while its **top edge rises** as the text grows:

| capture | msg8 bottom (pt) | msg8 height (pt) |
|---|---|---|
| `stream-case1-early.png` | 743.7 | 852 |
| `stream-case1-mid.png`   | 743.7 | 1148 |
| `stream-case1-late.png`  | 743.4 | 1498 |

The pixel diff between consecutive captures is large (500–600k pixels) — the
visible transcript genuinely grew in place; the bottom anchor did not move.

## Case 2 — user has scrolled up to earlier messages

**Result: HELD.** The view stays where the user put it; content below grows,
the visible text does not move, and the user is not yanked to the bottom.

Evidence (all three during active streaming — the below-fold message grew 36 →
47 → 57 chunks across the three captures):

- The earlier message the user scrolled back to keeps frame `minY = 178.0` in
  all three captures; the streaming message keeps `minY = 702.7` and grows only
  downward (its `maxY` goes 1743 → 2012 → 2281, below the fold).
- The three PNGs are **pixel-identical in the content region**. The only pixel
  difference anywhere is a 9 px-wide strip at the right edge (the scroll
  indicator): `early vs mid` differs only in bbox `9x995+1188+357`;
  `mid vs late` differs by **0 pixels**.

| capture | msg8 chunks | msg1 minY (pt) | msg8 minY (pt) |
|---|---|---|---|
| `stream-case2-early.png` | 36 | 178.0 | 702.7 |
| `stream-case2-mid.png`   | 47 | 178.0 | 702.7 |
| `stream-case2-late.png`  | 57 | 178.0 | 702.7 |

## Bottom line

Both cases **held**. Streaming into a SwiftUI `ScrollView` + `LazyVStack` with
`.defaultScrollAnchor(.bottom)` does the right thing on the current reference
app: pinned to the bottom when the user is at the bottom, and scroll-position
**preserved** when the user has scrolled up — the growing content does not yank
the view. Coordinates above are accessibility-frame points on the pinned iPhone
17 Pro simulator (402×874 pt, status bar overridden).

Images: `spike/native-visual/out/stream-case1-{early,mid,late}.png` and
`spike/native-visual/out/stream-case2-{early,mid,late}.png`; auditable text
snapshots: `stream-case1-*.txt` / `stream-case2-*.txt` alongside them.
