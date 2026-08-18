# BET-1089 — native verification (macos)

Fix implemented by manta-dev on PR #1093 (`multica/BET-1089-composer-glass-swap`,
commit `fcb6bdee`). iOS-native verification run by `macos` on the pinned
simulator (iPhone 17 Pro / iOS 26.5) against the local capture-fixture box
(`127.0.0.1:8787`, code `123456`).

## Result: PASS

- **Build** — Debug, simulator destination: `** BUILD SUCCEEDED **`. Touches
  `ComposerView.swift`, `VoiceRecordingSurface.swift`, `MantaVoiceRecordingUITests.swift`;
  calls `.glassEffectID(_:in:)` + `@Namespace` (iOS 26 Liquid Glass).
- **UI tests** — all three required pass, 0 failures:
  - `testMicHoldSlideUpLocks` (extended) — the structural-swap guard passes:
    while `voice-recording-locked` is up, `send-button`, `mic-button` and
    `usage-dot` do not exist (composer genuinely unmounted).
  - `testMicHoldSlideLeftCancels` — still passes (mic keeps its in-flight touch).
  - `testMicHoldAndReleaseSends` — still passes.
- **One glass box** — confirmed structurally + via the accessibility tree
  (`bet1051-locked-hierarchy.txt`): while locked the composer's
  `composer-input` / `mic-button` / `send-button` / `attach-button` /
  `model-picker` are entirely absent and only `voice-recording-locked` is
  mounted. Exactly one `BoxChrome`/glass shape, so the `GlassEffectContainer`
  has nothing to blend. No overlap.
- **held→locked transition** — screen-recording frame analysis (30 fps) shows
  the lock lands over ~0.22 s with a settling difference profile (frames 601–608),
  consistent with the `.animation(.smooth(duration: 0.22), value: recorder.phase)`
  glass morph — it animates, it does NOT hard-cut.

## Evidence files

- `bet1051-locked.png` — the locked take (single bar). For human eyes; the
  agent that produced this report cannot display images, so the functional
  proof above (AX tree + passing swap-guard tests) carries the gate.
- `bet1051-composer.png` — idle composer for comparison.
- `bet1051-locked-hierarchy.txt` — accessibility tree at the locked state.
