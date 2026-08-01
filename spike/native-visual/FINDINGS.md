# PoC 03 FINDINGS — which properties does a native iOS render yield?

The crux deliverable. A SwiftUI render of the session-list screen was captured
as its accessibility hierarchy (`out/session-list-hierarchy.txt`, 402×874 pt),
and an HTML spec fixture (`mockup/session-list.html`) was measured in Chromium
at the same viewport. `out/report.json` is the per-element, per-property
delta (match / mismatch / unavailable). This file states plainly what the
native side yields and what it does not.

## The bottom line

**Native yields geometry and derivable spacing. It yields neither typography
nor colour, and corner radius is not reachable at all.**

The accessibility hierarchy (`XCUIApplication.debugDescription`, i.e. the
standard AX snapshot) reports, per element, a `type`, a **frame** (an
axis-aligned rectangle in pt) and a `label`. That is the entire vocabulary.
There is no font, type-style, weight, colour, or corner-radius attribute in
the tree — not because this app hides them, but because the platform does not
expose them.

## Per-property, with the mechanism or reason

| Property | Native yields? | Mechanism / reason |
|---|---|---|
| **Position** | ✅ YES | Every accessible element carries an exact pt frame origin. E.g. the name `API Gateway` reports `{40, 227.5}`. |
| **Size** | ⚠️ YES — of the **content** frame, not the layout box | The frame is the bound of the accessible content. A clear-background row reports its text height (18.7 pt), **not** its 62 pt `minHeight`; only the filled (most-recent) row reports the full 62×378 box. The header reports its text box (18 pt), not the padded hit area. |
| **Font size** | ❌ NO | No font-size attribute in the hierarchy. |
| **Font weight** | ❌ NO | No type-style/weight attribute. |
| **Text colour** | ❌ NO | No colour attribute — not even for the label text. |
| **Background colour** | ❌ NO | No fill/background attribute. A visibly filled row yields no colour value. |
| **Corner radius** | ❌ NO | Frames are axis-aligned rectangles; SwiftUI's `RoundedRectangle(cornerRadius:20)` and the capsule are not exposed as radii. |
| **Spacing to next** | ✅ YES (derivable) | Gaps between frame edges are exact and reproduce Swift values: header→first-row = 6 pt (= the header's `top:22/bottom:6` padding), name→subtitle = 2 pt (= the `VStack(spacing:2)`). **Caveat:** because clear-row frames are content-bounds, a row→row gap the spec lays out as 2 pt reads as ~23.7 pt on native (the row's internal vertical centering is folded into the gap). |

Two sub-findings that follow from geometry-only:

- **SwiftUI shape elements are invisible to the AX tree.** The 8 pt status
  `Circle` (running/accent, needs-you/warn, idle/tx4) and the 40 pt accent
  `Circle` in the floating bar are not accessible elements at all. Their
  existence, size, position and colour are therefore not measurable from
  native — recorded as `unavailable` in `report.json`, never inferred.
- **The floating bar's Liquid Glass material has no HTML/token equivalent.**
  `.glassEffect(.regular)` is an iOS system material; the fixture approximates
  the capsule surface with the nearest token (`--card`) purely for layout. This
  is named here rather than hidden — and it corrupts no comparison, because the
  bar's colour is `unavailable` on native regardless.

## Cross-renderer caveats (why some geometry reads mismatch)

These are renderer-context differences, not spec errors — the fixture is a
faithful transcription of the Swift values rendered in a different engine:

- **Font metrics differ.** The fixture renders in Chromium with Inter; the app
  renders SF Pro. Text widths and line-box heights differ slightly (`API
  Gateway`: 92.3 px Inter vs 89.7 pt SF). Text sizes therefore compare, but
  with small, real deltas.
- **Absolute-y accumulates ~1 pt/group drift** from Inter-vs-SF line-height.
  Within a group the Swift rhythm reproduces exactly (header `22/6`, row
  `62`, row gap `2`, name→subtitle `2` all match).

## Honest-result notes

- Nothing here samples screenshot pixels. No accessibility label or identifier
  was added to smuggle a style value out. No spec value is hardcoded into the
  app side — the app side carries only what the AX snapshot reported.
- An `unavailable` is the **successful** recording of an absence, not a gap in
  the report: e.g. text colour is `unavailable` for all 18 measured text
  elements with the same reason string.

## What this means for the native visual-verification process

The numeric, agent-actionable loop — "the heading is 28, the spec says 24,
change it" — can be reproduced on native for **structure and layout** only:

- ✅ position, size (of content frames), and spacing between elements are
  available and comparable, and injected defects in geometry will be caught.
- ❌ typography (size, weight) and colour are **not** reachable through the
  accessibility hierarchy, and corner radius is not reachable. On native,
  those necessarily stay a human judgement — there is no free numeric signal
  to converge on.

So the process does **not** fully port to native. It ports for structure and
layout; colour and typography on native remain a weaker, human-mediated check.
That is the decision this PoC existed to surface.

## Reproduce

```
node spike/native-visual/measure.mjs      # reads the AX capture, drives the
                                          # mockup in Chromium, writes out/report.json
```

Deterministic: byte-identical across runs on the same capture + mockup.
