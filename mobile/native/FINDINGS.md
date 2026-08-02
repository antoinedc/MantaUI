# Native capture & verification harness — findings (S3b / BET-556)

The proven recipe from BET-451's PoC (`spike/native-visual`, never-merged; the
durable anchors are the `spike/poc04-findings`/`spike/defect-*` tags) is
rebuilt here as a permanent, maintained part of the native iOS client. This
document records what was built, the determinism proof, and the measured
tolerances. It supersedes the spike's `FINDINGS.md` for the maintained harness.

## What was built

All under `mobile/native/`, as one capture script plus the measurement layer
that reports its deltas (the issue's "one capture script" is `capture.sh`; the
screenshot + hierarchy are its two legs — neither is optional).

| File | Role |
|---|---|
| `capture.sh` | The single deterministic capture recipe. Builds the app, pins the simulator, overrides the status bar, disables animations, waits on a settled frame, captures the screenshot leg, runs the UI test to dump + normalise the hierarchy leg. |
| `measure.mjs` | The measurement layer for two captures: absolute pixel deltas + spatial masking on the screenshot leg, byte-for-byte on the hierarchy leg. |
| `MantaUIUITests/MantaUIHierarchyCaptureUITests.swift` | XCUITest that prints the live `XCUIApplication.debugDescription` between `AX-TREE-BEGIN`/`AX-TREE-END` markers. |
| `project.yml` / `MantaUI.xcodeproj` | S3a project regenerated via xcodegen to add the `MantaUIUITests` UI-test target. |
| `baseline/screen.{png,hierarchy.txt}` | Committed first record: the S3a foundation screen (the `MantaUI` root view). S4a re-records against real components. |

## The six load-bearing properties — how each is met

1. **Pinned simulator device + iOS runtime.** `capture.sh` pins
   `DEVICE_NAME` (default `iPhone 17 Pro`) and `RUNTIME_IOS` (default `26.5`)
   and resolves them to exactly one UDID via `simctl list -j`; it fails loudly
   if the device is missing or ambiguous. No floating destination. (Measured
   on this machine: `iPhone 17 Pro (iOS 26.5) -> 25EEA3D7-…`.)
2. **Status bar overridden** to a fixed time and full charged battery:
   `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged
   --batteryLevel 100 --cellularBars 4 --wifiBars 3`. System appearance pinned
   to light. Unconditional — without it the clock differs in every capture and
   every future baseline drifts.
3. **Animations disabled.** `simctl spawn <udid> defaults write
   com.apple.Accessibility ReduceMotionEnabled -bool true`.
4. **Settled-frame convergence guard, no retry-until-pass.** Two consecutive
   screenshots must be byte-identical (`cmp -s`) before one is kept; if the
   frame never converges the run exits non-zero with a loud message, never
   emitting a frame. The hierarchy dump gates on a real rendered element
   (`MantaUI` title) rather than a timer.
5. **Accessibility hierarchy dumped as text, normalised.** The XCUITest prints
   the live tree; `capture.sh` redacts the two live-per-launch values — heap
   addresses (`0x…` → `0xADDR`) and the process id (`pid PID`) — preserving line
   structure and column positions. A parseable-element check (`frame + label`)
   fails the run if the tree cannot be read as text.
6. **Both legs kept.** Screenshot (colour, typography, radius) + hierarchy
   (geometry, text). The screenshot is the only coverage of a misapplied token
   (a wrong generated constant is invisible to the hierarchy).

## Determinism proof — two consecutive runs, quoted

Run 1 and Run 2 were each produced by the one command (only `OUT_DIR`
differs), on the already-pinned, already-booted iPhone 17 Pro:

```
cd <repo>
OUT_DIR=/tmp/cap1 ./mobile/native/capture.sh      # RUN 1
OUT_DIR=/tmp/cap2 ./mobile/native/capture.sh      # RUN 2
```

Both runs printed `PASS` and settled at attempts 2 and 0 respectively. The two
output directories are byte-for-byte identical:

```
$ diff -r /tmp/cap1 /tmp/cap2
<empty>            # no differences

$ shasum -a 256 /tmp/cap1/* /tmp/cap2/*
cdc6726b…a5a  /tmp/cap1/screen-hierarchy.txt
0b72974f…cfae  /tmp/cap1/screen.png
cdc6726b…a5a  /tmp/cap2/screen-hierarchy.txt
0b72974f…cfae  /tmp/cap2/screen.png
```

`diff -r` is empty and the two files' SHA-256 match exactly — the screenshot
and the normalised hierarchy are identical across runs.

## Tolerances — absolute, measured, and quoted

`measure.mjs` compares two captures. The pixel verdict is an **absolute count
of differing pixels** with a **maximum single-channel delta** — never a ratio
(a ratio silently re-tunes itself with frame size).

Measurement of two identical runs (`measure.mjs /tmp/cap1 /tmp/cap2`):

```
hierarchy leg: IDENTICAL (byte-for-byte)
screenshot leg: 1206x2622 vs 1206x2622 (dims match)
differing pixels (absolute): 0
max channel delta outside mask (absolute): 0
VERDICT: PASS
```

The measured floor for the current screen is therefore **0 differing pixels /
0 max-channel delta** — the capture is fully deterministic and needs no noise
tolerance at all.

The worked example — **known noise masked spatially, then zero tolerance
elsewhere** — is the Dynamic Island band. On this pinned device
(`iPhone 17 Pro, iOS 26.5`) the capsule's anti-aliased edge was measured from
an actual capture as the central contiguous dark run:

```
Dynamic Island capsule (pixels): x=415, y=42, w=375, h=78   (= x 138.3-263.3 pt, y 14-40 pt @3x)
```

`--mask dynamic-island` excludes that region by location and then requires
near-exact equality everywhere else. The mechanism was validated by injecting
a 20×20 red patch at `(600,900)`:

```
differing pixels (absolute): 400
max channel delta outside mask (absolute): 249
diff bounding box (px): x=600 y=900 w=20 h=20
VERDICT: FAIL
```

400 = 20×20, exactly the injected defect; exit code 1, never retried, never
tolerance-widened.

## Reuse, not re-implementation

The comparator inherits the semantic contract of the spike's `measure.mjs` and
the web gate's `scripts/visual/harness.mjs` (deterministic waits, no retries,
absolute not ratio) applied to a fixed simulator instead of a fixed browser.
No second capture script exists; `capture.sh` is the one. `FINDINGS.md` is the
one findings record under `mobile/`.

## S4a — transcript components spec fixture (BET-557)

The baseline above has been re-recorded against S4a's spec fixture — a
full-bleed transcript scene (`RootView`) rendering the three §8 atoms. Every
value resolves through the GENERATED tokens: colours via `Tokens.scheme(_:)`
(`Theme.swift`, from tokens.css `data-theme` blocks) and spacing/radius/type
via the newly generated `Metrics` enum (from tokens.css `:root`).

### What the fixture contains

| §8 atom | Component | Fixture content |
|---|---|---|
| full-bleed user band | `UserBand` | background `fill`, 2px `accent` leading edge, radius 0 leading / `--r-md` trailing, 15px/1.5 weight 500 `tx1`, padding `--sp-3`, edge-to-edge |
| assistant text | `AssistantProse` | full width, `tx1`, 15px/`--prose-lh`, margin-bottom `--sp-3` |
| step rows | `StepRowView` / `StepGroupView` | 13px row, `panel` bg, hairline `border-subtle` between rows, radius `--r-md`, verb 600 `tx2`, target 12px mono `tx4`; a four-step group rolls up to `▸ 4 steps · read 3 files, 1 search` |

The step-row output is collapsed by default and revealed inline on `inset` on
tap (a static capture cannot exercise the interaction, only the collapsed
default the design mandates). **No role captions, no right-aligned user
bubble, no hardcoded design literal** — `TranscriptComponents.swift` has no
colour/spacing/radius/size/weight literal; the only numerics are the generated
token lookups.

### Token generation (the non-colour surface)

`gen-swift-tokens.mjs` now also parses tokens.css `:root` and emits a
theme-independent `Metrics` enum — `Spacing` (the full `--sp-*` scale),
`Radius` (`--r-*`), and `TypeMetrics` (faces, §8 font sizes, weights, prose/UI
leading, and the 7px `--step-row-y` the mockup fixes off the spacing grid).
Those font-size/weight/step-row-y values were **added to tokens.css `:root`**
(additive; unused by the web app, so no visual change there) so the Swift
client can satisfy "resolve every value through the generated tokens" instead
of hardcoding §8 literals. `npm run gen:swift-tokens -- --check` stays green.

### Re-recorded determinism proof — two consecutive runs, quoted

Run 1 and Run 2 both printed `PASS`; `measure.mjs` on the pair:

```
hierarchy leg: IDENTICAL (byte-for-byte)
screenshot leg: 1206x2622 vs 1206x2622 (dims match)
differing pixels (absolute): 0
max channel delta outside mask (absolute): 0
VERDICT: PASS
```

`diff -r /tmp/cap1 /tmp/cap2` is empty; committed `baseline/screen.{png,
hierarchy.txt}` byte-match `/tmp/cap2`.

### Geometry — measured per element (accessibility hierarchy)

Each component is independently measurable in the tree (light scheme, iPhone
17 Pro @3x, values in pt):

```
user-band 1     {{0,62},{402,42}}   full-bleed width 402; content inset 12 (= --sp-3); height 42 = 12+18+12
assistant-prose {{12,120},{308.7,18}}  inset 12; 15px single line
step-rows 1     {{-0.5,149.5},{403,30.7}}  1px hairline stroke; row {{0,150},{402,29.7}} = 7+15.7+7 (--step-row-y)
  verb Ran      tx2 13px; target 'multica issue get BET-520' mono 12px tx4; duration '0.4s' tx4
assistant-prose {{12,191.7},{336,44.3}}  wrapped 2-line prose at 15px/1.55
user-band 2     {{0,248},{402,42}}   full-bleed again
step-rows 2     rollup Button '▸ 4 steps · read 3 files, 1 search' {{0,348},{402,28.3}}, 12px mono, chevron
```

Colour, typography and the 2px accent edge and trailing radius are visible only
in the screenshot leg (the hierarchy cannot see them) — the committed
`baseline/screen.png` is that evidence. The authoring agent (macos) cannot
render images; a human should eyeball the PNG once.

### Notes / honesty

- The committed baseline screenshot was verified for determinism (byte-identical
  across runs) and for having real content (this PNG is ~173 KB at 1206×2622);
  its content is confirmed by the accessibility hierarchy above.
- The `MantaUI` foundation title is gone from the app; the hierarchy-dump UI
  test's stable gate element is now the first user-band `StaticText`. The
  baseline is therefore no longer the S3a foundation screen — as FINDINGS
  anticipated ("S4a re-records against real components").
- The Dynamic Island mask rect is measured **for this pinned device**; a harness
  run on a different device must re-measure and update the preset.
