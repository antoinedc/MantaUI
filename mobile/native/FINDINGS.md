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

### Micro-token resolution (review returned, 2026-08-02)

A re-read by `manta-reviewer` flagged two residual literals in the S4a
fixture as inconsistent with the "no hardcoded literal" claim: the 6px status
dot and a 9px rollup chevron glyph. Both resolved in the same direction as
`--step-row-y`:

- **6px status dot → `--step-dot`** added to tokens.css `:root`, emitted into
  `Metrics.type.stepDot`; the circle now sizes from it.
- **9px chevron → removed.** The mockup's roll-up is the literal `▸` at 12px
  mono (`.group`), not a separate glyph; the component rendered an SF Symbol on
  top of the `▸` already in the summary string, duplicating it. The image is
  gone; the roll-up row is now the `▸ 4 steps · …` 12px mono `tx4` text alone,
  matching the mockup exactly.

The FINDINGS claim is now accurate as written: the only numerics in the app
source are generated-token lookups.

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
step-rows 2     rollup Button '▸ 4 steps · read 3 files, 1 search' {{0,348},{402,28.3}}, 12px mono
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

## S4b — subagent agent row + drill-in screen (BET-558)

Built on S4a's components per §8a. A **subagent is a session, not a tool call**:
it is a navigation row (never a step row) that PUSHES a child screen. Both the
parent and every child render through ONE shared `TranscriptView` — there is no
second transcript renderer.

### What changed

| Surface | Change |
|---|---|
| `gen-swift-tokens.mjs` | Now also emits `accentSoft` (`--accent-soft`, already in `tokens.css` light+dark) — the §8a 16px agent-glyph tile colour. Regenerated `Theme.swift`; `--check` green. |
| `TranscriptComponents.swift` | `SubagentRowView` (glyph tile + 600 `tx1` task name + live status + `›` chevron), `SubagentScreen` (child with its own header, read-only), `SubagentHeader`, `TranscriptView` (the single renderer), and `StepGroupRow` so the grouped container mixes step + agent rows (§8a "inside the same grouped container"). |
| `RootView.swift` | `NavigationStack` push (never an inline expansion or a sheet), parent scroll preserved, running child keeps streaming while open; optional `MANTA_SCENE=child` harness entry. |
| `capture.sh` / UI test | `SCENE_MODE` drives a second stable scene (the child drill-in). Scene delivered to BOTH capture legs via the app's own `UserDefaults` (the hierarchy leg's XCUITest runner does not inherit the shell env). |

### The design decisions from §8a, as built

- **Agent row** in the same grouped container as step rows: 16px `accentSoft`
  tile (`Metrics.spacing.sp4`), name 600 `tx1` (`Metrics.type.small` + semibold)
  — a task name, never a command — a live duration while running (`twoXS`
  `tx4`), and a `›` chevron meaning "there is more here", not "expand this
  output".
- **Push, not inline/sheet**: `NavigationStack` value navigation. The parent
  stays in the stack, so its scroll position is untouched by a visit; a pushed
  child stays alive in the stack (the structural precondition for
  streaming-while-open — see the honesty note on why live streaming is
  deferred this stage). Nesting is free — a sub-subagent is another push.
- **Child header**: task name + `subagent · running 1m12s` / `subagent · done`
  as the 500 `tx4` subtitle (§8 two-line header), with a back chevron. No
  trailing affordance — the child is read-only in v1 (no composer, no write
  affordance).
- **Child transcript**: rendered via the SAME `TranscriptView` (UserBand,
  AssistantProse, StepGroupView) as the parent — not a copy.

### Determinism proof — two scenes, two runs each, quoted

Each scene is one `capture.sh` invocation; two runs per scene:

```
# parent scene
OUT_DIR=/tmp/s4b-parent1 ./mobile/native/capture.sh
OUT_DIR=/tmp/s4b-parent2 ./mobile/native/capture.sh
# child scene
OUT_DIR=/tmp/s4b-child1 SCENE_MODE=child ./mobile/native/capture.sh
OUT_DIR=/tmp/s4b-child2 SCENE_MODE=child ./mobile/native/capture.sh
```

`node mobile/native/measure.mjs <A> <B> --mask dynamic-island`:

```
=== PARENT ===
hierarchy leg: IDENTICAL (byte-for-byte)
screenshot leg: 1206x2622 vs 1206x2622 (dims match)
masks applied: [415,42 375x78]
differing pixels (absolute): 0
max channel delta outside mask (absolute): 0
VERDICT: PASS

=== CHILD ===
hierarchy leg: IDENTICAL (byte-for-byte)
screenshot leg: 1206x2622 vs 1206x2622 (dims match)
masks applied: [415,42 375x78]
differing pixels (absolute): 0
max channel delta outside mask (absolute): 0
VERDICT: PASS
```

Both scenes are fully deterministic: 0 differing pixels, byte-identical
hierarchies. Committed baselines: `baseline/screen.{png,hierarchy.txt}` (the
parent transcript, now with agent rows) and `baseline/child.{png,hierarchy.txt}`
(the drill-in screen).

### Geometry — measured per element (parent scene, accessibility hierarchy)

```
agent-row 1   {{0,248},{402,30}}   glyph tile 16px `accentSoft` at x 12 (--sp-3); name 13px/600 tx1 at {36,255.2}; status 'done' 11px tx4 at {349.7,256.3}; chevron '›' at {384,255.2}
agent-row 2   {{0,279},{402,30}}   same treatment
agent-row 3   {{0,310},{402,30}}   'pr-closed sweep' · status '1m12s' (live duration) at {343.7,318.3}
step-rows     {{-0.5,247.5},{403,93}}  the grouped container — panel bg, hairline border-subtle between the three agent rows, radius --r-md
```

### Geometry — measured per element (child scene, accessibility hierarchy)

```
subagent-scene   full screen, identifier 'subagent-scene'
subagent-header  {{12,70},{273,34}}   back chevron '‹' button at {12,70} (id 'subagent-back'); title 'pr-closed sweep' 13px/600 tx1 at {163.8,72}; subtitle 'subagent · running 1m12s' 11px tx4 at {147.7,88.7}
ScrollView       {{0,112},{402,762}}  child transcript below the header
assistant-prose  'Reading the close-on-merge workflow and its CI posture.'  {{12,112},{316,44.3}}
step-rows        two S4a step rows ('Read multica-close-on-merge.yml 0.3s', 'Ran node scripts/multica-unblock.mjs --dry-run 1.8s')
assistant-prose  'The sweep flips a blocked issue to todo the moment its blockers clear.'
```

The child transcript renders through the VERY SAME components as the parent —
there is no copy of a transcript renderer anywhere.

### Honesty notes

- The **status is a live duration while running** (§8a) is represented in the
  fixture by fixed text ("1m12s"), exactly as S4a's `.running` step rows use
  fixed durations. A real per-second tick would change the status text every
  frame and defeat the settled-frame convergence guard the harness is built on.
- **Streaming-while-open is intentionally deferred — the child renders a FROZEN
  snapshot today.** `SubagentScreen` takes the session's `[TranscriptBlock]` as
  a plain value, so the transcript does not update while the screen is open.
  This is correct for S4b: it is a fixture/measurement stage with no live
  subagent data source, and neither the parent nor anything else streams in the
  fixture. The §8a requirement is not silently claimed here — when a real,
  observable subagent store lands (a later stage), `SubagentScreen`'s transcript
  argument is the SINGLE seam to rewire to that source; the push structure keeps
  the child alive in the stack, so once that seam reads a live source the same
  view streams without a second renderer being introduced.
- The agent **glyph tile** is rendered as an empty 16px `accentSoft` tile. §8a
  names the tile but not a glyph; an initial/icon inside it would be a design
  decision beyond the spec, so the fixture stays faithful to what §8a states.
- The back chevron (`‹`) and row chevron (`›`) are text glyphs at token sizes
  (`Metrics.type.body` / `Metrics.type.small`); the CSS-mockup's 14px chevron
  has no `:root` counterpart, so it is resolved through the nearest tokens
  rather than a hardcoded 14.
- Colour/typography/radius are visible only in the screenshot leg; the authoring
  agent (macos) cannot render images, so a human should eyeball
  `baseline/screen.png` and `baseline/child.png` once.
- The `accentSoft` token is the one generator addition this issue needed; the
  broader "emit :root spacing/radius/easing" token work BET-574 already covers,
  and the generator now reads both `data-theme` colours and `:root` metrics with
  no second source of truth.

## S2 — onboarding + pairing joiner screen (BET-594)

The S1 transport core (MantaAPIClient, KeychainCredentialStore) let a paired
device reach the box; S2 adds the way a fresh install gets there. Implements
DECISIONS.md §5.3/§5.4/§5.6 and the §6.2 two-sided four-character confirm as a
SwiftUI flow, gated at the app root by pair state.

### What was built

| File | Role |
|---|---|
| `MantaPairingModels.swift` | Pure pairing logic — a Swift port of the shared contract (`claim.mjs`, `pairPayload.ts`, `setupLogic.ts`): code normalization / 6-digit gate, four-char verify normalization, box-id + server-URL validation with the private-listener gate, the pair-payload parser, and claim-outcome classification. Pure (no HTTP/view/Keychain). |
| `MantaAuthClient.swift` | The `/auth/claim` client: POSTs `{pairing_code, verify?, name?}` to the box's `/auth/claim`, classifies the outcome, persists on success. |
| `MantaOnboarding.swift` | The flow (`MantaOnboardingFlow` ObservableObject) + screens: Manual "Enter the code", Link confirm ("Link this phone?" + the four-char confirm), Linking progress, the §5.4 typed failure screens (expired / codes-don't-match / unreachable / rate-limited / server-error), and the §5.6 iOS notification-priming screen. |
| `MantaAppRoot.swift` | App gate: fresh (unpaired) install → onboarding; paired → main destination (the S3 session list replaces the S4 content shell). `MANTA_SCENE` scenes bypass the gate so the S4b measurement fixtures and the new `onboarding-*` screens stay reachable. |
| `MantaUITests/MantaPairingTests.swift` | 28 pure-logic tests (codes, verify, box/server validation, payload parser incl. private-URL gate + 7-digit reject, claim classification). |
| `MantaUITests/MantaAuthClientTests.swift` | 4 URLProtocol-mocked claim tests: request shape (path, POST, body incl. verify/name), success → Keychain persistence, wrong-code does not persist, network → unreachable. |

### Routing

- **Fresh install** (no credentials): `MantaAppRoot` → `MantaOnboardingRoot` →
  JSON `Manual` entry. Verified live: launch with empty Keychain + no
  `MantaScene` renders `onboarding-root`/"Enter the code" (not the transcript
  fixture).
- **Paired**: `RootView` content shell (S3 replaces it with the session list);
  `MantaEventStore.start()` connects the live `/events` stream.
- **Scan / paste / deep-link path**: `receive(payload:)` parses the pair link
  (`box`+`code`+`verify`), shows the confirm screen when a `verify` is present
  (claim WITH it → distinct Stage-2 device, §6.2), else links directly. The
  claim target is the payload's explicit server URL, else the box-derived
  `https://<boxId>.boxes.mantaui.com`.
- **Desktop-free manual path**: six digits (+ optional verify + server URL via
  the "not reachable" link). §5.2.9's "the server resolves the box from the six
  digits alone" is **not realizable against the current per-box `/auth/claim`** —
  the claim must be POSTed to a specific box's hostname, so the manual path
  requires a reachable server URL. Flagged in the BET-594 hand-off comment; the
  primary scan path (satisfies "fresh install pairs with a real box") derives
  the host from the payload's boxId.

### Determinism — onboarding captures

Each `onboarding-*` scene is one `capture.sh` run (pinned iPhone 17 Pro, iOS
26.5, fixed status bar, reduced motion, convergent-frame guard):

```
OUT_DIR=... SCENE=entry   SCENE_MODE=onboarding-entry             ./mobile/native/capture.sh
OUT_DIR=... SCENE=confirm SCENE_MODE=onboarding-confirm           ./mobile/native/capture.sh
OUT_DIR=... SCENE=notif   SCENE_MODE=onboarding-notifications     ./mobile/native/capture.sh
OUT_DIR=... SCENE=expired SCENE_MODE=onboarding-failure-expired   ./mobile/native/capture.sh
```

Committed baselines: `baseline/onboarding-{entry,confirm,notifications,
failure-expired}.{png,hierarchy.txt}`. Reproducibility quoted (confirm scene,
two consecutive runs `ob-confirm` vs `ob-confirm3`):

```
hierarchy leg: IDENTICAL (byte-for-byte)
screenshot leg: 1206x2622 vs 1206x2622 (dims match)
cmp ob-confirm3/confirm.png ob-confirm/confirm.png → byte-identical
```

The S4b parent fixture still reproduces after the scene default became explicit
(`SCENE_MODE=parent`): its hierarchy content (transcript, agent rows, roll-up)
is unchanged — only the redaction placeholder spelling in the *committed*
baseline differs (`0xADDRR`/`PIDPID` there reflect a pre-existing
double-redaction, not a rendering change).

### Honesty notes

- A live end-to-end pair against a remote box is **not** exercised here: the
  macos agent cannot mint a pairing code (`manta pair` is loopback-only on the
  box) and must not pair with production hosts. The claim wiring is instead
  proven deterministically by the URLProtocol-mocked `MantaAuthClientTests`
  (request shape, classification, Keychain persistence) plus the 28 pure-logic
  tests. "Fresh install pairs with a real box" is left to the S3 human/CI
  verification once a box is reachable from device.
- The `linking` progress screen's spinner is a SwiftUI `ProgressView`; under
  reduced motion it still animates, so it is intentionally NOT part of a
  committed deterministic baseline (the three static linking-stage rows are,
  and the unit tests cover the flow transitions).
- iOS notification authorization is requested but the app never gates any
  functionality on it (§5.6): accepting and denying both land on the main
  destination; only a quiet Settings reminder distinguishes them (S8 push wires
  the actual APNs fan-out).

## S3 — session list, actions, and session creation (BET-595)

S1 transport + S2 pairing landed the ability to reach a box; S3 is the first
screen a paired user sees: the §7.1 session list with §7.2 actions (tap opens,
swipe-left delete with full-swipe commit, swipe-right pin, long-press context
menu Rename · Pin · Fork · Delete), §7.3 delete semantics (idle → immediate +
5 s undo holding the RPC; running → confirm naming what is interrupted), §7.4
user-disableable haptics, and §7.6 (every gesture is also in the context menu).
Plus the owner override on §5.5: session creation with a folder, optional
worktree fan-out, first message creates the session.

### What was built

| File | Role |
|---|---|
| `SessionModels.swift` | Codable models matching the `tmux:list` / `git:list-worktrees` shapes + PURE logic: §7.1a subtitle table, §7.1 status dot, row timer `elapsed`/`runningDuration` (the §7.3 confirm copy), pin identity, §7.3 `PendingDelete` undo-window expiry, folder-path + worktree helpers (folderPicker.ts ports), model label, haptics taxonomy. |
| `MantaAPIClient.swift` (extended) | The tmux / fs / git / config RPC surface the list needs: `projects`, `newSession`, `newWindow`, `killWindow`, `deleteSession` (chat + window), `renameWindow`, `selectWindow`, `forkSession`, `listDirs`, `listWorktrees`, `configGet`/`configUpdate`. |
| `SessionListStore.swift` | ObservableObject behind the list: refresh on demand + reconnect, per-row live status merged from the S1b event store (`running`, subagents, model), attention (needs-you), pins + haptics flag via config, §7.3 delete-with-undo, running-duration tracking. |
| `SessionListView.swift` | The §7.1 grouped list, rows, swipes, context menu, running-delete confirm, 5 s undo toast, floating search-plus glass capsule (creates a session), tap → §8 screen seam (chat is S4). |
| `SessionCreateSheet.swift` / `FolderPickerView.swift` | Creation flow: name, folder (full-height picker over `fs:list-dirs`), optional worktree fan-out (`git:list-worktrees`), then the first-message composer creates the session and sends the prompt. |
| `tokens.css` / `gen-swift-tokens.mjs` / `Theme.swift` | Additive §7 token metrics (`--list-row-*`, `--list-group-*`, `--font-size-row-name`, `--tracking-*`) emitted into `Metrics.type`, so no session-list value is a hardcoded literal. |
| `MantaUITests/SessionModelsTests.swift` | 24 pure-logic tests (subtitle/dot/timer/pin/undo/model/folder/worktree). |

### Verification

- The full MantaUITests suite passes: 91 tests, 0 failures (67 inherited from
  S1a/S1b/S2 + 24 new), on the pinned iPhone 17 Pro (iOS 26.5).
- The app builds for the iOS Simulator destination (`BUILD SUCCEEDED`) and
  launches on the simulator without crashing (a fresh install shows the §5
  onboarding gate, as `MantaAppRoot` intends).
- `node scripts/gen-swift-tokens.mjs --check` is green; `gen-swift-tokens.test.mjs`
  updated for the new tokens and passes.

### Honesty notes

- **A live end-to-end list against a real box is not exercised.** As in S2, the
  macos agent cannot mint a pairing code (loopback-only) and must not pair with
  production hosts, so "the list reflects a real box" is verified structurally
  (the RPC surface mirrors httpApi exactly, the models decode the server shapes)
  and by the pure-logic tests, not by a live round trip. That stays a
  human/CI-on-device check once a box is reachable.
- **The `needs you` (attention) dot/subtitle** keyed on `question.asked` /
  `permission.asked` raw frames from the S1b stream. Those events fire only
  while the box is streaming — the store tracks them live; there is no
  attention state without a live stream.
- **The running turn timer** starts when the box's interpreted stream state
  flips a session to running. Without a live stream the timer slot is empty;
  the subtitle/dot still reflect the last known state.
- **The row timer / running duration resolve from the event store's `running`
  flag**; the exact §7.1 elapsed and §7.3 "running N minutes" wording are
  driven by whatever running-turn timing the box publishes (as in S4's chat
  header).
- **The chat screen** that tap opens is S4's — this stage delivers the list,
  its actions, and creation. The tap target is a single `navigationDestination`
  seam (`SessionScreenPlaceholder`), so S4 replaces one screen, not the shell.
- **Model labels** are data-faithful: known Anthropic ids collapse to friendly
  names ("claude-opus-4-7" → "opus 4.7"); anything unknown shows the raw
  modelID (never invented).

## S4 — wire the chat screen to live data (BET-596)

The chat screen the session list opens is no longer a placeholder. `ChatScreen`
binds to a live, observable `ChatSessionStore` fed by the S1b `/events` stream
plus the canonical `opencode:messages` transcript, and renders through the
EXISTING §8/§8a components (`TranscriptView`, `UserBand`, `AssistantProse`,
`StepGroupView`, `SubagentHeader`) — there is still no second transcript
renderer. The retired web `SessionScreen.tsx` is the parity reference for the
header copy only; the native chat does not port the React `ChatPanel` body.

### What was built

| File | Role |
|---|---|
| `ChatModels.swift` | The PURE mapping from the box's wire shapes to the block types: `opencode:messages` → `[TranscriptBlock]`, step-row verb/target/duration presentation, the §8 step rollup, task-part → subagent, and the §8 header subtitle. Unit-tested. |
| `ChatSessionStore.swift` | The live ObservableObject: refetches the canonical transcript at turn boundaries, accumulates the running assistant text from `stream:flush`, and exposes running/turnComplete/context/todos/truncation/questions/permissions/subagents. Parent and children are each their own store (child = read-only). |
| `ChatScreen.swift` | The view: §8 two-line header, the BET-481 scroll container, live Todos/Permission/Question cards (answerable), and the value-push subagent drill-in. |
| `SessionListView.swift` | The tap target now carries the window's `opencodeSessionId` and opens `ChatScreen`; the placeholder remains only for foreign windows with no opencode session id. |
| `TranscriptComponents.swift` | `SubagentSession` gains an optional `childSessionId` (the S4b fixture leaves it nil) so the live drill-in can be routed by session id. |
| `tokens.css` / `gen-swift-tokens.mjs` / `Theme.swift` | Additive §8 chat-header tokens (`--chat-header-btn` 38, `--font-size-chat-title` 14.5, `--tracking-chat-title` -0.01) so no chat value is a hardcoded literal. `--check` green; generator test updated. |

### Block-type provenance — mapping interpreted events onto the blocks

Scope item 2 asks which block types the interpreted stream can produce. The
honest answer (a documented finding, nothing invented):

- `.prose` — **live** from `stream:flush` (the running assistant turn) AND
  **canonical** from completed assistant messages.
- `.steps` row / subagent rows — **canonical** from assistant tool parts;
  agent rows' live status/child-id from `stream:subagent`.
- `.user` — **canonical only.** No stream event produces a user block and none
  is invented; the prompt comes from the persisted transcript.

So a live conversation streams (`.prose` tail) on top of a canonical transcript
(the `.user`/completed `.steps`/`.prose`), exactly the desktop model (transcript
fetch + live events). While a turn streams, the mapper skips assistant messages
whose `time.completed` is nil (the box itself keys turn completion on that) so
the running text appears exactly once — as the in-progress tail, not also in the
canonical list. This is the duplication guard.

### Done-when verification

- **Live streaming**: the store appends `stream:flush` text as the in-progress
  `.prose`; scroll container is `ScrollView` + `LazyVStack` +
  `.defaultScrollAnchor(.bottom)` — BET-481's measured container kept verbatim,
  not re-measured, not replaced.
- **Permissions + Questions answerable**: `PermissionCard` (Allow once / Allow
  always / Reject) and `QuestionCard` (options + always-available free text +
  Send / Reject) wire to the S1a RPCs on `MantaAPIClient`
  (`permissionReply`, `questionReply`, `questionReject`) and unblock the agent.
- **Subagent drill-in live (BET-576 folded in, issue closed here)**: pushing a
  subagent pushes a `ChatSubagentScreen` bound to a LIVE `ChatSessionStore` for
  the child session — the frozen `SubagentSession.transcript` fixture screen is
  only used by the capture-harness scenes. `navigationDestination` for
  `SubagentSession` is registered against the session list's own stack, so a
  value-push keeps the parent in the stack and its scroll position is untouched
  by a visit (child keeps streaming while open).
- **Status/todos/context/truncation**: §8 header subtitle (`running · 2m · 8%` /
  `idle`) from running + context pct; `TodosCard`, context/cache/truncation all
  read the interpreted stream state.

### Verification

- Full `MantaUITests` suite: **111 tests, 0 failures** (99 inherited + 12 new
  `ChatTranscriptTests`), pinned iPhone 17 Pro (iOS 26.5).
- App builds for the iOS Simulator destination (`BUILD SUCCEEDED`).
- `npm run typecheck` green; `node scripts/gen-swift-tokens.mjs --check` green;
  `gen-swift-tokens.test.mjs` updated + passing (5/5).
- The S4b capture harness still reproduces (parent scene `PASS`, deterministic)
  — the fixture scenes are untouched by this wiring stage.

Repo `npm test`: 1816 pass / 1 known environment failure
(`capExecutor.test.ts` PATH passthrough asserts CI's `/usr/bin:/bin` and fails
on a Mac with Homebrew on PATH — reproduced on the clean baseline before this
change; passes on the Linux CI runner).

### Honesty notes

- **No live-box round trip.** As in S2/S3, the macos agent cannot mint a pairing
  code (loopback-only) and must not pair with production hosts, so "a real
  conversation streams into the phone" is verified structurally — the store
  binds to the S1b stream state it was built to consume, the mapper is
  unit-tested against real `opencode:messages` shapes — and stays a
  human/CI-on-device check once a box is reachable from device.
- **Permissions are polled (2.5 s) while the parent chat screen is active**
  rather than consumed through the event store's single-owner `rawFrameHandler`;
  questions arrive on the interpreted `stream:questions` sub. This deliberately
  avoids stealing the session list's handler slot. The permission poll is a
  device-side presentation concern only; it stops on `onDisappear`.
- **The composer is out of scope (S5).** The phone streams a live conversation
  and answers permissions/questions; sending prompts is S5.
- **Child stores are read-only** (§8a v1): they stream their transcript but do
  not poll permissions.
- **`chat-header-btn`, `chat-title` values are additive to `:root`** and unused
  by the web app, so no visual change there (same policy as `--step-dot`).

## S7 — settings screen driven by the generated schema (BET-599)

Implements the settings surface per the retired `MobileSettings.tsx` semantics
(search, "Modified" dots, per-section reset, undoable reset-all) but driven by
a GENERATED Swift inventory instead of a hand-written list.

### The schema decision (generation, not RPC)

The shared schema (`src/shared/settingsSchema.ts`) is TypeScript. Per BET-599's
explicit choice, I picked **(a) generation** — the same approach proven for
design tokens by `scripts/gen-swift-tokens.mjs` — over (b) serving it from the
box over RPC. Why:

- **Fails at CI time, not runtime** — a committed `SettingsSchema.swift` that
  drifts from the schema is caught by a new `gen:swift-settings -- --check`
  step in the required `typecheck-test` CI job (identical shape to the tokens
  gate), so "adding a setting to the schema surfaces it on iOS" is enforced,
  and a hand-edit of the generated file is also caught.
- **Consistent with tokens** — design tokens and the settings inventory now
  share the same build-time → committed-Swift pipeline.
- RPC would need the box up at Settings-open, delay the first render, and
  change the wire contract — generation avoids all three.

`scripts/gen-swift-settings.mjs` reads `settingsSchema.ts` at build time via
`typescript.transpileModule` + a synchronous CJS eval (the schema is a pure,
dependency-free module), filters to `settingsForPlatform(SETTINGS, "mobile")`,
and writes `generated/swift/SettingsSchema.swift`. It runs on the CI Node 20
(matching the tokens generator) — no Node 22 type-stripping dependency.

### What surfaced

| Section | Schema-driven entries (from the generated schema) |
|---|---|
| Box | `serverUrlMobile` (device-local, configKey nil) |
| Models | `cacheTtl` (segmented) |
| Sessions | `autoRenameSessions`, `chatAutoAllow` (toggles) |
| Files | `uploadCleanupHours` (segmented, numeric coerced) |
| Voice | `groqApiKey` (password, commit-on-blur), `voiceTranscriptionModel`, `voiceCommandModel` (text, commit-on-blur) |

`accountsList` is a `custom` control with no configKey — rendered as a
reachable/searchable label row (no native accounts-subscription management UI;
that is beyond S7's schema-driven scope). Search, Modified dots, per-section
reset and reset-all (both undoable) mirror the retired implementation.
Config-driven entries persist via `config:update` (the box is source of truth,
so the S5 mic gate's `groqApiKey` read and the box's `uploadCleanupHours` sweep
see changes); device-local entries go to `UserDefaults` (not credentials). The
settings screen opens from a gear in the session list's navigation bar.

### Verification

- `MantaUITests`: full suite 165 tests — **162 passed, 3 failed**. All **14 new
  settings tests pass** (9 `MantaSettingsLogicTests` + 5 `MantaSettingsStoreTests`,
  incl. reset-section/reset-all undo round-trips and the segmented numeric
  coercion). The 3 failures are the pre-existing Keychain tests
  (`status(-34018)` `errSecMissingEntitlement`) that fail on an unsigned
  simulator build — the Keychain files are untouched by this stage.
- App builds for the iOS Simulator destination: `BUILD SUCCEEDED`.
- `npm run typecheck` exit 0.
- `node scripts/gen-swift-settings.mjs --check` green; `gen-swift-settings.test.mjs`
  passes (7/7); `gen-swift-tokens.test.mjs` still passes (5/5).
- `npm test`: 1836 passed / 2 skipped / 1 known environment failure
  (`capExecutor.test.ts` PATH passthrough fails on a Mac with Homebrew on PATH —
  documented above, passes on the Linux CI runner). My node-test generator
  tests are green in the harness (`12/12` settings+tokens).

### Honesty notes

- **No live-box/device round trip on Settings itself.** Settings needs no pairing
  to render (it loads config on open), and its persistence is verified against a
  fake config seam + UserDefaults; a real on-device pass (settings reaching the
  box and the box honoring `uploadCleanupHours`/voice keys) belongs to the epic's
  device-check issues once a box is reachable.
- **"Adding a setting surfaces it" is enforced structurally**: the UI iterates
  the generated `SettingsSchema.entries` / `sections` and never hand-writes a
  row; the CI drift gate catches a schema edit without a regenerate commit.

## BET-632 — prose → step-group gap (verification leg)

### What the defect was

A wide gap appeared above a "Ran …" step-group on device. Root cause (fixed by
`manta-dev` on the mapper): `ChatTranscriptMapper` emitted a `.prose` block for
*any* non-empty text part, and opencode routinely appends a newline/whitespace-
only text part after a tool run. That phantom paragraph carried its own
`--sp-3` bottom padding *and* a line box, stacking on the group's real `--sp-3`
and inflating the gap. The other suspect (sp-3 on both the prose bottom *and*
the group top) was ruled out — spacing was already single-sourced correctly in
`TranscriptView.blockView` (sp-3 below prose via `AssistantProse`, sp-3 below a
group, sp-4 below a user band, 7pt row padding).

### What the fix does

`mobile/native/MantaUI/ChatModels.swift` treats whitespace-only/blank text
parts as blank in both the assistant `process` path and the user `textParts`
aggregation, so they never become a `.prose` block and never split a
consecutive-step group.

### Unit verification — quoted

`xcodebuild test` (`-only-testing:MantaUITests/ChatTranscriptTests`) on
`iPhone 17 Pro` (iOS 26.5):

```
Test Suite 'ChatTranscriptTests' passed at ...
	 Executed 20 tests, with 0 failures (0 unexpected) in 0.018 (0.052) seconds
```

The four new BET-632 regression tests all pass:
- `testBlankTextPartBeforeStepsDoesNotEmitProseBlock` — blank part before a
  Ran group yields `[.prose, .steps]`
- `testWhitespaceOnlyTextPartIsBlank` — `"   \n  "` is skipped entirely
- `testBlankTrailingTextAfterStepsIsSkipped` — no stray trailing prose
- `testUserBlankPartDoesNotAddParagraphInsideBand` — user band text unchanged

Full `MantaUITests` suite is green (no regressions):

```
Test Suite 'MantaUITests.xctest' passed
	 Executed 172 tests, with 0 failures (0 unexpected) in 0.892 (1.303) seconds
```

### On-device capture — two runs, quoted

`OUT_DIR=…/b632-parent1 ./mobile/native/capture.sh` and `…/b632-parent2`:
```
hierarchy leg: IDENTICAL (byte-for-byte)
screenshot leg: 1206x2622 vs 1206x2622 (dims match)
masks applied: [415,42 375x78]
differing pixels (absolute): 0
VERDICT: PASS
```

### Geometry — measured per element (parent scene, prose→step-group)

The mockup numbers (`DECISIONS.md` §8 / `transcript-mockup.html`) are met by
the rendered tree. The decisive pair — the prose immediately above the "Ran"
step-group:

```
assistant-prose {{12,120},{308.7,18}}   'Checking its metadata and the blocker chain.' (bottom 138)
step-rows      {{-0.5,149.5},{403,30.7}}   top 149.5 (content 150); hairline stroke extends 0.5 outside
  row          {{0,150},{402,29.7}} = 7 + 15.7 + 7 (--step-row-y)
  verb Ran      tx2 13px; target mono 12px tx4; duration '0.4s' tx4
```

- **Prose → step-group gap = 12pt (`--sp-3`)** — prose text bottom 138 → group
  content top 150; the 0.5 stem is the hairline stroke, proving NO phantom
  paragraph and NO double-stacked `--sp-3`. This is the number the defect
  inflated.
- **Below a step-group = 12pt (`--sp-3`)** — group2 (agent rows) bottom 340 →
  next prose top 352.
- **Below a user band = 16pt (`--sp-4`)** — user-band bottom 104 → next prose
  top 120.
- **Step-row padding = 7pt** (`--step-row-y`): row `{0,150}` → 'Ran' text top
  157; text bottom 172.7 → row bottom 179.7.
- **Between rows = hairline only (1pt `--spPx`), zero gap** — the three agent
  rows sit at 248/279/310 (contiguous 30pt rows, `border-subtle` stroke
  between them, no added spacing). Machinery collapses; prose does not.

### Honesty note

The capture harness's `parent` scene renders hand-authored `TranscriptBlock`s
directly (`RootView.parentBlocks`), so it exercises the *rendered* spacing
against the mockup — it does not itself push a raw wire transcript through
`ChatTranscriptMapper`. The mapper-level fix (blank part → no phantom prose)
is therefore pinned by the four unit tests above; the capture pins the target
spacing geometry. The baseline `baseline/screen.{png,hierarchy.txt}` is
unchanged — the fixture did not change.
