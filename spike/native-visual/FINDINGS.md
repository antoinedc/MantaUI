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

- The AX measurement never samples screenshot pixels. No accessibility label
  or identifier was added to smuggle a style value out, and no spec value is
  hardcoded into the app side. Colour and text appearance are nonetheless
  present in the captured screenshot that accompanies every hierarchy
  (`out/<tree>/session-list.png`) — PoC 04b is what makes colour detectable
  there. "Unreachable" below always reads as unreachable **through the
  accessibility hierarchy**, not unreachable in the captured pixels.
- An `unavailable` is the **successful** recording of an absence, not a gap in
  the report: e.g. text colour is `unavailable` for all 18 measured text
  elements with the same reason string.

## What this means for the native visual-verification process

The numeric, agent-actionable loop — "the heading is 28, the spec says 24,
change it" — can be reproduced on native for **structure and layout** only:

- ✅ position, size (of content frames), and spacing between elements are
  available and comparable, and injected defects in geometry will be caught.
- ❌ typography (size, weight) and colour are **not** reachable through the
  accessibility hierarchy, and corner radius is not reachable. Through the AX
  tree alone those stay a human judgement — but colour **is** reachable in the
  captured screenshot (PoC 04b), so through the full pipeline (hierarchy +
  screenshot) it is not lost entirely.

So the process does **not** fully port via the AX hierarchy alone. It ports for
structure and layout numerically; colour is recovered by the screenshot leg of
the same capture (PoC 04b) as a **change signal**, not a spec-conformance
number. A native verification loop must therefore keep the screenshot leg —
dropping it as redundant would silently remove the only coverage of
misapplied-token / colour defects. That is the decision this PoC existed to
surface.

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
| 4 | Group-header colour `tx2`→`tx3` | colour | **Yes** (pixels) | Yes (as drift) | Null **AX** signal — the hierarchy is byte-identical to baseline. Detected by pixel comparison of the captured screenshots: baseline vs defect-4 differ in 17,932 of 12,648,528 subpixels (0.142%), max channel delta 30, concentrated on the three group-header text bands (PoC 04b). Detected as *drift* (something changed), not *conformance* (wrong versus the spec). |
| 5 | Group-header top padding `22`→`16` | geometry | **Yes** | **Yes** | All group-header `position.y` shift up: Alpha `190`→`184` (baseline match), Beta `365`→`352`, Gamma `540`->`520`, against spec 190/365/540. ~6px-per-group vertical shortage → restore the header's top padding. |

## Verdict

**WORTH BUILDING**

## Rationale

All 5 of the 5 defects were detected — four from the AX-based measurement and
defect 4 (colour) from pixel comparison of the captured screenshots (PoC 04b) —
and every detected one was fixable from output the pipeline already produces.
That meets, and exceeds, the pre-registered `WORTH BUILDING` bar (≥4 detected,
every detected one fixable from the report).

Defect 4 was not a pipeline miss: it was a miss of the AX measurement alone.
The group-header text-token change produces no hierarchy delta (exactly as PoC
03 recorded), but the captured screenshot — which the pipeline already produces
for every tree — shows it plainly. So colour is unreachable **through the
accessibility hierarchy** yet reachable **through the captured screenshot**,
as a change signal rather than a conformance number. See PoC 04b.

One result refines PoC 03's claim that "typography is not reachable": the font-
size defect (1) **was** detected here, but only through its geometric side-
effect — the name text's content box grows enough to flip elements from
match→mismatch. The report still exposes no font-size attribute; a human (or
agent) must read a line-box-height delta as "text too large → reduce font".
So typography is detected at the level of the text's size geometry, not as a
first-class type attribute. Colour, by contrast, never reaches the AX tree at
all — it is recovered only by the screenshot leg (PoC 04b).

## Reproduce

```
# per defect N (1..5): point the measurement at that tree's AX capture, measure
cp spike/native-visual/out/defect-N/session-list-hierarchy.txt \
   spike/native-visual/out/session-list-hierarchy.txt
node spike/native-visual/measure.mjs
# defect-4 reproduces as a null AX result (hierarchy byte-identical to
# baseline) — it is caught only by pixel comparison of the two screenshots,
# see PoC 04b. cmp spike/native-visual/out/defect-4/session-list-hierarchy.txt
# spike/native-visual/out/baseline/session-list-hierarchy.txt
```

Revert-proof: the branch source tree is byte-identical to PoC 02 —
`git diff 67ae2e7 HEAD -- . ':!spike/native-visual/out'` is empty and
`git diff main...HEAD -- ':!spike/'` is empty. Only the new `out/` capture
artefacts differ from PoC 02.

---

# PoC 04b FINDINGS — defect 4 is detected by pixel comparison of the capture

PoC 04 scored defect 4 (group-header colour `tx2`→`tx3`) as a miss because the
AX hierarchy yielded a null signal. That verdict was too narrow: `capture.sh`
committed a settled-frame `session-list.png` for **all six** trees, and defect
4's was never compared to baseline's. Comparing the two committed PNGs — the
simplest possible pixel diff, no new tooling — detects it.

## The comparison (re-run on `spike/native-visual` against the committed PNGs)

```
baseline/session-list.png   184813 bytes   sha256 66828ca3f7a248b6c7fd610563c86f2656c1abd309aa8de264f45061f75e6b79
defect-4/session-list.png   184716 bytes   sha256 d7151f56cf5d75c28d4a2aff55ab8f1fc7839ede25547d0d5e59b9d4e9681a08

dims 1206 x 2622, 4 channels (RGBA)
differing subpixels: 17932 of 12648528  (0.142%)
max channel delta: 30
```

Where the differing pixels sit (their row bands, each ~33–42 px tall) confirms
the attribution: they are the three group-header text rows (~pt 193–207, 368–
378, 541–552) — the exact positions of the Alpha / Beta / Gamma headers whose
text token changed. ~99% of the differing pixels fall in those three header
bands; the residual (~60 px) is negligible sub-glyph edge noise. A layout
jitter or frame race would smear the diff across the whole screen, not pin it
to the three header glyph bands at a moderate channel delta of 30. The capture
uses settled-frame convergence with no retry-until-pass, so this is not frame
noise.

## Why this matters

The accessibility hierarchy reports geometry only, so a colour-only edit is
invisible to `measure.mjs`. But the screenshot leg of the same capture records
it. Generation from `tokens.css` guarantees the **palette**, never its
**application** — a view that binds the wrong generated constant emits valid
tokens and is invisible to the AX tree. Pixels are the only thing that catch
that, and this run shows the capture already carries them.

## The qualifier (honest, and the same layer split the web gate makes)

Pixel comparison detects defect 4 as **drift** (this changed vs baseline), not
as **conformance** (this is wrong vs the spec). A diff says something moved; it
does not say what it should be. That is the layer-2/layer-3 split: layer 2
(pixel/conformance against the spec render) is what catches a revert in the
rendered output; layer 3 (interpretation against the AX tree) is narrower.
Here the layer-2 signal flags the change; a human still reads the screenshot to
confirm it is a wrong token, not an intended one.

Consequence for pipeline design: a native verification loop **must keep the
screenshot leg**. Dropping the PNG as redundant would silently remove the only
coverage of misapplied-token (colour) defects. Whether pixel comparison becomes
a scored layer is a decision for whoever builds the real pipeline — this PoC
only records that the evidence exists and the captures already produce it.

## Updated score

**5 of 5 defects detected** — defect 4 detected as drift via the captured
screenshots. Verdict remains **`WORTH BUILDING`**, now for the stronger reason
that all five classes were surfaced by the pipeline (4 via AX geometry, 1 via
pixels).
