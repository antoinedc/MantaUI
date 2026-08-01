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

---

# PoC 04 FINDINGS — inject known defects and score the loop

PoC 03 established what the native render yields (geometry, derivable spacing;
no typography/colour/radius attributes). PoC 04 asks whether the pipeline can
**detect** injected deviations and whether the correcting edit can be derived
from the report alone. Five defects spanning four failure classes were applied
one at a time to `spike/swiftui-ref/MantaSpikeRef/SessionListView.swift`, each
captured by the pinned iOS simulator (`macos`, identical env across all six:
iPhone 17 Pro / iOS 26.5, fixed status bar, animations reduced), and each
measured with PoC 03's `measure.mjs` unchanged. `out/baseline/` +
`out/defect-1..5/` hold the per-tree AX captures. Every verdict below is read
from the JSON report (spec-vs-app values), never from a screenshot.

## Detection table

| # | Defect | Class | Detected? | Fixable from report alone? | Notes |
|---|---|---|---|---|---|
| 1 | Session-name font size `15.5`→`17` | typography | **Yes** | **Yes** | Caught only via geometry side-effect: every row-name text-box grows (e.g. API Gateway `89.7×18.7`→`97×20.3` vs spec `92.3×19`), and `Docs`/`Infra` flip size from match→mismatch. `fontSize` itself stays `unavailable`; the signal is a line-box height/width delta that maps back to "text too big → reduce font". |
| 2 | Row `HStack` spacing `8`→`12` | geometry | **Yes** | **Yes** | Every row-name `position.x` shifts `40`→`44` (+4px, spec 40). Clean uniform column shift; the 4px maps to the 8→12 leading spacing. |
| 3 | Delete the status-dot `Circle` | structure | **Yes** | **Yes** | Every row-name `position.x` shifts `40`→`24` (−16px, spec 40). Exactly an 8pt dot + 8pt gap removed ahead of the label — reconstructable from the 16px void. (The dot itself stays `unavailable` in AX, as PoC 03 recorded.) |
| 4 | Group-header colour `tx2`→`tx3` | colour | **No** | — | Null signal: hierarchy byte-identical to baseline (`cmp` clean). Colour has no AX representation, so a colour-only edit is invisible to the report. Matches PoC 03. |
| 5 | Group-header top padding `22`→`16` | geometry | **Yes** | **Yes** | All group-header `position.y` shift up: Alpha `190`→`184` (baseline match), Beta `365`→`352`, Gamma `540`->`520`, against spec 190/365/540. ~6px-per-group vertical shortage → restore the header's top padding. |

## Verdict

**WORTH BUILDING**

## Rationale

4 of the 5 defects were detected, and every detected one was fixable from the
report alone — so the pre-registered `WORTH BUILDING` bar (≥4 detected, every
detected one fixable from the report) is met.

The single miss is defect 4 (colour): the group-header text-token change
produces no AX-tree delta at all, exactly as PoC 03 established — colour is not
reachable through the accessibility hierarchy, so it necessarily remains a
human judgement on native. That is a platform limitation, not a pipeline gap.

One result refines PoC 03's claim that "typography is not reachable": the font-
size defect (1) **was** detected here, but only through its geometric side-
effect — the name text's content box grows enough to flip elements from
match→mismatch. The report still exposes no font-size attribute; a human (or
agent) must read a line-box-height delta as "text too large → reduce font".
So typography is detected at the level of the text's size geometry, not as a
first-class type attribute. Colour remains the one class the report cannot see
at all.

## Reproduce

```
# per defect N (1..5): point the measurement at that tree's AX capture, measure
cp spike/native-visual/out/defect-N/session-list-hierarchy.txt \
   spike/native-visual/out/session-list-hierarchy.txt
node spike/native-visual/measure.mjs
# defect-4 reproduces as a null result because its hierarchy is byte-identical
# to baseline (cmp spike/native-visual/out/defect-4/session-list-hierarchy.txt
# spike/native-visual/out/baseline/session-list-hierarchy.txt)
```

Revert-proof: the branch source tree is byte-identical to PoC 02 —
`git diff 67ae2e7 HEAD -- . ':!spike/native-visual/out'` is empty and
`git diff main...HEAD -- ':!spike/'` is empty. Only the new `out/` capture
artefacts differ from PoC 02.
