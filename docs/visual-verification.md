# Visual verification

How a screen gets from a design to shipped pixels without anyone eyeballing it
at the end. Written because the opposite happened: the new-session composer
shipped with roughly the right elements in visibly the wrong arrangement, and
nothing in CI had ever looked at a pixel.

## The three layers, and what each one is for

They fail for different reasons. Do not collapse them.

| Layer | Question | Deterministic? | Blocks a merge? |
|---|---|---|---|
| 1. Structure | Are the right controls there, in the right order, correctly labelled? | yes | **yes** |
| 2. Pixels | Did anything change that nobody meant to change? | yes | **yes** |
| 3. Conformance | Does it look like the design? | no — judgement | no, advisory |

**Layer 1 (structure)** snapshots the accessibility tree as YAML. A diff is
readable in a PR: *"the model picker moved above the input"*, *"the attach
button lost its label"*. It ignores pixels entirely, so it never flakes on font
rendering. This is the layer that catches the defect class that started all of
this.

**Layer 2 (pixels)** compares a screenshot against the screen's own committed
baseline. It answers "did this change?", never "is this right?". Baselines are
this app's approved past, **not** the design.

**Layer 3 (conformance)** captures the implementation and its mockup under
identical conditions and asks a reviewer — human or vision model — to report
the differences. It is advisory on purpose: judgement gates are
non-deterministic, and a flaky blocking gate is one people learn to bypass.

### Why layer 2 does not diff against the mockup

A mockup is a different DOM. Even a pixel-perfect implementation differs from
it in thousands of pixels, so the diff is noise and the signal is lost. Pixel
diffing only works against a baseline produced by the same renderer, at the
same viewport, from the same DOM — which is what the app's own baseline is.

## Adding a screen

Three steps, and only one of them is code.

1. **Write the mockup**: `docs/screens/<id>/mockup.html`.
2. **Add a row** to `SCREENS` in `scripts/visual/screens.mjs`.
3. **Record the baseline**: `npm run visual:update`, then commit the generated
   files in `tests/visual/screens.visual.ts-snapshots/`.

There is deliberately **one** visual spec file, and it loops the registry. If
you are adding a second spec file, what you actually want is another row.

### Mockup rules

A mockup is a contract, not a picture. Two rules make it one:

- **It loads `/src/renderer/tokens.css`** — the app's real token stylesheet.
  Every colour, spacing step, radius and shadow is the same variable the app
  resolves at runtime. A mockup that hardcodes `#2E6BFF` keeps looking correct
  after the token is retuned and the app has moved on.
- **It carries `data-screen` on its root**, so the harness can wait on it.

Write the markup to read like the target DOM — the closer it is, the more
useful the side-by-side. But nothing in `docs/screens/` is imported by the app;
it is throwaway HTML.

End the mockup with a short **spec-notes** paragraph covering what a picture
cannot express: what is centred vs left-aligned to what, which element is meant
to be the loudest, what grows when content grows. Those are the decisions
implementers get wrong.

### Reaching a state

Every capture must be reachable by **pasting a URL into a browser**, so a human
reviewer can see exactly what the machine saw. Demo mode makes states
addressable:

- `?demo&desktop` — the desktop shell, fixture-backed, no box and no network.
- `&empty` — a box with no projects (a real product state: a freshly-paired
  box, and the only way to reach the zero-project screens).

If a state needs internal poking to reach, make it URL-addressable instead of
teaching the harness a special case. `actions` in the registry exists for real
user gestures — a click a person could make — not for reaching into internals.

## Definition of done for a UI issue

1. A mockup exists at `docs/screens/<id>/mockup.html` and the issue links it.
   **An issue without one is not ready to implement** — that is the actual root
   cause of the composer defect, and no tooling substitutes for it.
2. The screen is a row in `scripts/visual/screens.mjs`.
3. `npm run visual` is green, with the baselines committed.
4. `npm run visual:compare` has been run and its findings addressed or
   explicitly deferred in the PR description.

## Commands

```
npm run visual           # layers 1+2 — the gate. Builds first.
npm run visual:update    # re-record baselines after an intended change.
npm run visual:compare   # layer 3 — writes .visual-out/<id>.{app,mockup}.png
npm run visual:compare welcome     # one screen
```

`.visual-out/` is generated and gitignored.

## Determinism — why the gate can be trusted

Every rule below exists because a capture was flaky without it. They live in
one place, `scripts/visual/harness.mjs`, and both the gate and the compare
script import them.

- **Version-pinned browser.** Playwright's bundled Chromium, pinned by
  `package-lock.json`. Not system Chrome: a baseline is a hash of a specific
  renderer, so a browser that auto-updates can invalidate every baseline
  without a commit.
- **Selector-gated waits, never `waitForTimeout`.** A timeout trades a
  deterministic failure for an intermittent one.
- **Animations, transitions and carets disabled** after first paint, so the
  override applies to the captured frame.
- **`document.fonts.ready` awaited** — a webfont that lands after the capture
  changes every glyph.
- **Two rAFs** so style overrides and in-flight layout reach the framebuffer.
- **Fixed viewport per screen**, declared in the registry. Changing it
  invalidates that screen's baseline, on purpose.
- **Staleness guard.** The suite serves `mobile/www/`, a build artifact.
  Running the Playwright project without rebuilding would verify the *previous*
  bundle and pass for the wrong reason — so the harness compares the newest
  renderer source against the built entry point and refuses to run if the build
  is behind. This is not hypothetical; it happened the first time the harness
  was exercised.
- **No retries** on the visual project. A retry on a deterministic gate only
  converts a real regression into an intermittent one.

## The marketing-shot drift gate (BET-341 / BET-444)

`scripts/shots.mjs` captures the `website/shot-*.webp` marketing assets from the
demo-mode build, exactly like the visual gate's baselines. Its drift gate lives
in the REQUIRED `typecheck-test` job, so it must be both runnable **and**
byte-deterministic — a flaky or dead capture would block every open PR.

It broke on 2026-07-31, twice, and is now fixed:

- **Chrome 148 killed the capture outright.** `shots.mjs` pinned
  `/usr/bin/google-chrome`, which began refusing every loopback navigation on
  the runner with `ERR_ACCESS_DENIED`. The script exits 1 on a failed capture,
  so the required job went red and **every open PR** blocked on a step unrelated
  to its changes. Fixed by routing `shots.mjs` through the shared
  `LAUNCH_OPTIONS` from `scripts/visual/harness.mjs` — Playwright's bundled
  Chromium, pinned by `package-lock.json` — the same one-browser recipe the
  visual gate always used. A baseline is a hash of a specific renderer; pinning
  the browser via the lockfile is what stops a browser release from
  invalidating every committed image with no commit.
- **Captures were not byte-deterministic under the new browser.** Once the
  pinned Chromium ran, two consecutive captures of an unchanged UI differed in
  bytes, so the diff could not be a gate. This went away with the pinned browser
  too: running `npm run shots` twice in a row against an unchanged tree now
  leaves `git diff --exit-code website/` clean (the workflow's two-run step
  asserts exactly this and fails loudly if a determinism regression ever
  returns). The offending assets — the xterm-like terminal shot and the
  composite that consumes it — were the ones most sensitive to the renderer
  difference; the pinned browser produces stable output for all of them.

The drift-gate step now runs `npm run shots` twice, then diffs against the
committed set, and **blocks** on any difference (no more
`continue-on-error: true`). A determinism regression fails loudly as itself
instead of as a mystery diff on someone's unrelated PR.
