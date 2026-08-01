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

> **Layers 1 and 2 are self-referential.** Both compare the app to its own
> committed record, so both are green when the record itself is wrong. If a
> baseline is first recorded from a broken render, the gates lock the breakage
> in and defend it against every later fix. Only layer 3 compares against
> something external — which is why running it is mandatory at record time even
> though its *result* is advisory. See "What the first run taught us" below;
> this is not hypothetical.

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

### Registering a region

A screen can also declare two optional fields that scope its capture to a
single element:

- **`region`** (CSS selector) — capture this element instead of the full page.
  The pixel assertion renders `page.locator(region)` against its own small
  baseline, and the structure root becomes `snapshot ?? region ?? ready`.
- **`mockupRegion`** (CSS selector) — the matching element inside the mockup,
  used by `compare.mjs`. Defaults to `region`; it usually differs because the
  mockup is a different DOM (e.g. app `nav[role="tablist"]` vs mockup `.snav`).
- **`mockupActions`** (async fn, optional) — actions run on the mockup page
  before `compare.mjs` captures it, for when the target element is not visible
  in the mockup's default state (e.g. clicking a section-rail tab to reveal a
  hidden panel). Only `compare.mjs` honours it; the app-run `actions` still
  drive the visual test project.

A region row is a **separate row** in the registry that reuses its screen's
`url`, `ready`, `final` and `actions` and only changes what gets cropped. The
screen's own full-page row stays and remains the composition gate, so a region
baseline is byte-identical between runs where the component is unchanged — two
issues touching different components touch different baseline files and can
land in parallel.

**Regions crop the real page. They are not an isolated-component harness.** A
component rendered on its own can be perfect while the page it lives on is
broken — the [full-height collapse](#what-the-first-run-taught-us) that
slugged every vertical chain in BET-447 kept every element present and
correctly named, so only a capture of the real page, region or full, would
show it. A region deliberately inherits the screen's `url`, `ready`, `final`
and `actions`, doing nothing but narrowing what is captured. The screenshot is
taken from the page as a real user reaches it, so a page-level regression
inside the region is visible even though the rest of the screen is cropped
out.

### Mockup rules

A mockup is a contract, not a picture. Two rules make it one:

- **It loads `/src/renderer/tokens.css`** — the app's real token stylesheet.
  Every colour, spacing step, radius and shadow is the same variable the app
  resolves at runtime. A mockup that hardcodes `#2E6BFF` keeps looking correct
  after the token is retuned and the app has moved on.
- **It carries `data-screen` on its root**, so the harness can wait on it.
- **It never specifies a value the acceptance rules forbid.** A UI issue is
  rejected for an off-grid spacing value or a raw hex, so a mockup that
  hardcodes `border-radius: 14px` puts the implementer between two rules and
  they will guess. If a design genuinely needs a value the scale lacks, the
  scale changes first — the mockup is not the place to introduce one.
- **Its placeholder content matches the state the registry captures.** The
  side-by-side is only readable if both sides show the same words. A mockup
  showing `leasebot / main` against a capture of a non-git `~` that reads
  `no branch` forces the reviewer to mentally subtract the content difference
  before they can judge layout, and real differences hide in that subtraction.

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
5. **Any baseline this PR creates or re-records is in the PR body as an
   image.** Not a filename, not "regenerated" — the picture. A baseline is
   committed *evidence*, and a reviewer who cannot see it is approving a hash.
   This is the only step that can catch a baseline recorded from a broken
   render, and it is cheap: paste the PNG.

   **Paste the image as an upload, never as a link into the PR branch.** A
   `raw.githubusercontent.com/<owner>/<repo>/<pr-branch>/…png` URL resolves
   while the PR is open and dies the moment it merges, because PRs here are
   merged with `--delete-branch`. The picture is the evidence for the *record*,
   which outlives the branch by definition — a review trail that 404s six weeks
   later cannot be re-read when someone asks why a baseline looks like that.
    Drag the PNG into the GitHub comment box (it rewrites to a
    `github.com/user-attachments/…` URL, hosted independently of any ref), or
    link a permalink pinned to the merge commit SHA. Either survives; a branch
    path does not.
6. **If the control you are changing renders data-driven content — a list, a
   menu, a set of options — state in the PR which fixture state it was
   specified against, and whether that state is representative.** A control
   that renders a variable number of items looks fixed-size when the fixture
   supplies zero or one, and the mockup, the structure snapshot and the pixel
   baseline will all agree with the fixture. This is how the AI-CLI launcher
   options were specified away in BET-459 and had to be restored in BET-467.

Steps 4 and 5 apply **whenever a baseline moves**, not only when the issue is a
design issue. A refactor that shifts a pixel is exactly the case where nobody
thinks to look.

## Commands

```
npm run visual           # layers 1+2 — the gate. Builds first.
npm run visual:update    # re-record baselines after an intended change.
npm run visual:compare   # layer 3 — writes .visual-out/<id> compare.png (side-
                         # by-side composite) + the two raw app/mockup PNGs.
npm run visual:compare settings-general     # one region row
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

It broke on 2026-07-31, three times, and is now fixed:

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
- **Re-arming exposed a `sitemap.xml` false positive, not shot drift.** Once the
  pinned Chromium ran and the gate was made blocking, the runner kept failing
  with an identical error but at byte-identical shot sizes. The captured shots
  were **byte-for-byte equal to the committed set on the runner** — the failure
  was the gate's diff target. Re-arming the gate initially widened the diff from
  the original `website/shot-*.webp` to the whole `website/` directory, which
  also swept in `website/sitemap.xml`. That file is regenerated by the `npm test`
  step (`scripts/build-website-assets.test.mjs` → `build-website-sitemap.mjs`)
  from git `%ct` history, which on the runner diverges from the stale committed
  copy — so the gate failed on an unrelated generator, not on the renderer.
  Fixed by scoping the gate back to exactly the shot artifacts it owns:
  `website/shot-*.webp` + `website/hero-poster.webp`.
- **`browser.version()` is not a Promise on the runner's playwright-core build.**
  A best-effort version log added while debugging used `.catch()`, which threw
  `TypeError` and aborted `shots.mjs` before any capture. Version detection is
  now wrapped in try/catch and can never affect the run.

The drift-gate step now runs `npm run shots` twice, diffs the **shot artifacts
only** (`website/shot-*.webp` + `website/hero-poster.webp`) against the
committed set, prints the post-capture shot diff (name-status + stat) so any
drift names the offending file, and **blocks** on any difference (no more
`continue-on-error: true`). A determinism regression fails loudly as itself
instead of as a mystery diff on someone's unrelated PR.

## What the first run taught us (BET-443 → BET-447)

BET-443 (the welcome screen) was the deliberate first run of this process: one
screen, to shake the process out before applying it to the rest. Everything
below is a change already made, or an issue already filed, in response to it.

### 1. The system verified a broken render for a full day, green throughout

While BET-443 was being implemented and reviewed, `w-full` and `h-full` were
compiling to nothing (BET-447 — a Tailwind scale key had been dropped, which
produces no rule and no error). Every full-height flex chain in the app had
collapsed to content height: the sidebar filled 449px of a 900px window and the
transcript container was not a scroll container at all.

Nothing caught it. The gate was green the whole time, because the baseline had
been **recorded during the broken window** — layer 2 was faithfully defending a
collapsed layout, and layer 1's accessibility tree is identical either way (the
elements are all present; they are just the wrong size). The marketing shots
were re-recorded in the same window, which is how `shot-hero` and
`shot-approvals` came to be byte-identical files: "scroll to the approval cards"
is a no-op when nothing scrolls.

So BET-443's implementer built and its reviewer approved a screen neither could
see correctly, and both were diligent.

**What changed:** definition-of-done items 4 and 5 above — layer 3 is mandatory
to *run* whenever a baseline moves, and the baseline image goes in the PR body.
The one thing that would have caught this is a person looking at the picture
once. Also `src/renderer/tailwindScale.test.ts`, which makes this specific
failure mode (a utility class that compiles to nothing) fail as a fast unit
test naming the affected files, rather than as pixels nobody re-examines.

**The general lesson, worth stating plainly:** a drift gate is only as good as
the first record. Recording a baseline is the moment of judgement in this
system; everything after it is bookkeeping.

### 2. The structure snapshot is the load-bearing layer — and has three blind spots

The implementer's report was unambiguous: the layer-1 diff is what they worked
from. The stray `│` separator, the standalone `Start` button, the resolved model
name where the design wanted a short `Auto`, the missing attach button — all
visible as a text diff, actionable without looking at pixels.

It cannot see:

- **alignment** — left-aligned vs centred is invisible in an accessibility tree;
- **emphasis** — which element is meant to be the loudest;
- **absent vs merely restyled** — an element missing entirely reads the same as
  one that was never in the design.

All three come only from the mockup's spec-notes paragraph, which is why that
paragraph is required. Do not treat a clean layer-1 diff as "matches the
design"; it means "the right controls exist, named correctly, in order".

### 3. `visual:compare` gives you two pictures and no locator

It writes `app.png` and `mockup.png` and a checklist. Deciding *which* control
moved versus resized means eyeballing two images side by side, and the content
mismatch (see the mockup rule added above) has to be subtracted by hand first.
Filed as BET-448: a composite output with per-region annotation, so the
reviewer is told where to look instead of hunting.

### 4. A mockup that breaks the acceptance rules costs the implementer real time

The welcome mockup specified raw radii (`14px`, `10px`, `9px`) while the issue
rejected off-grid values on sight. The implementer mapped them to the nearest
on-grid utility and flagged the conflict, which was the right call — but they
had to make a judgement the spec should have made. Hence the new mockup rule:
a mockup never specifies a value the acceptance rules forbid.

### 5. The welcome screen needs a second pass

BET-443's judgements about alignment, width and vertical rhythm were all made
against the collapsed render. The screen is structurally right and its baseline
is now recorded from a correct one, but the design questions it answered were
answered blind. BET-449 is the honest second pass on the corrected substrate.
