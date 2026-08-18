# BET-1123 — Hands-on gesture verification report

**Result: first-swipe scroll CONFIRMED; swipe-left reveal NOT visually confirmed
via injection (inconclusive — screenshots attached for human review).**

Date: 2026-08-18
Build: main `97455f0a` (includes BET-1104, the gesture-swap fix; BET-1118 test present)
Simulator: iPhone 17 Pro, iOS 26.5
Method: **real gesture injection** — CGEvent mouse-drags delivered into the
Simulator window. This drives MessagingUI's `TiledView` pan recognisers the way
XCUITest synthetic swipes (`swipeUp()`, `press(forDuration:thenDragTo:)`) do not
(that limitation was re-confirmed in this session: a `press:thenDragTo:` drag
left `scroll%` unchanged at 0%).

Test box: `capture-fixture/fixture-box.mjs` serving its TALL transcript. The app
was paired to it; the chat opened with the transcript rendered (accessibility:
`CollectionView` + `Vertical scroll bar, 114 pages`, value `0%` at the tail).

## 1. Single-swipe scroll (the substance of BET-1104's bug fix) — CONFIRMED

A **single** deliberate up-drag (real finger-equivalent) in the transcript:

- transcript at tail before the gesture: `01-scroll-before-at-tail.png`
- the content moved on the first gesture and **stayed scrolled**:
  `02-scroll-during-drag.png` / `03-scroll-after-single-drag.png`
- pixel-diff of the transcript region (device y 0.15–0.82) between the
  at-tail frame and the post-gesture frame: **90.59% changed**, `maxDelta=250`
  (0.00% would mean no movement). The two scrolled frames are byte-identical
  to each other, i.e. the list did not spring back.

So the transcript scrolls on the **first** swipe — no second swipe required.
This is exactly the behaviour BET-1104 set out to restore.

Caveat: a fast CGEvent flick (≈250 ms, high velocity) did *not* engage the pan
(`0.00%`), while the slower deliberate drag did. Velocity-sensitive CGEvent
timing, not a product defect; a real finger falls in the engaged range.

## 2. Swipe-left reveal of the timestamp strip — NOT visually confirmed by injection

Left-drags on message rows (varied row positions + velocities, held and
released) produced **0.00%** pixel change across the whole screen:
`04-reveal-before.png`(identical to)`05-reveal-mid-drag.png` →
`06-reveal-after-release.png`. The strip is `accessibilityHidden`, so this is
visual-only evidence; the screenshots are attached for a human reviewer.

I cannot distinguish, from blind injection, "my gesture didn't hit a
recogniser the right way" from "the strip does not render". No assertion is
made either way — this remains the one behaviour BET-1118 could not exercise
and BET-1123 wanted closed out. A human should eyeball the attached reveals (or
re-run with a physical finger) before it is declared verified.

## Notes

- The a11y `scroll%` read came back `0%` at the end of the injection window,
  and the "Scroll to bottom" chip did not appear, because the app auto-scrolls
  back to the tail on its live refetch once the finger is released. That does
  not contradict §1 — the scrolled state was captured and stable 1.5 s after
  release, before any re-anchor.
- The temporary in-bundle gesture harness (with its CGEvent coordination) was
  NOT committed; it needs host-side mouse injection and is not CI-reproducible.
