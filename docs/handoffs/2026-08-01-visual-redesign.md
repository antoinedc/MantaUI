# HANDOFF — visual verification + the 2.0 redesign rollout (2026-08-01)

You are picking this up cold. Everything below is verified, not assumed.

## 0. Two traps that will waste your time

**The repo checkout is SHARED.** `/home/dev/projects/better-ui` currently sits on
`chore/agent-instructions-drift` with other agent sessions working in it. A peer
once switched the branch mid-edit and silently discarded uncommitted work.
**Never `git checkout` there.** Use a private worktree:

```
git worktree add /tmp/opencode/<name> main
ln -s /home/dev/projects/better-ui/node_modules /tmp/opencode/<name>/node_modules
cd /tmp/opencode/<name>
# ...work, commit, push...
cd /home/dev/projects/better-ui && git worktree remove /tmp/opencode/<name> --force
```

Do NOT `git add -A` in that worktree — it stages the `node_modules` symlink.

**System Chrome is broken on this box.** `/usr/bin/google-chrome` (v148) refuses
every loopback navigation with `ERR_ACCESS_DENIED`. Anything needing a browser
must use `LAUNCH_OPTIONS` from `scripts/visual/harness.mjs` (Playwright's bundled
Chromium, pinned by `package-lock.json`).

## 1. What this epic is

The desktop UI was shipping visibly different from its designs and nothing in CI
had ever rendered a pixel. `docs/visual-verification.md` is the spec — read it,
it is short. Three layers:

| Layer | Question | Blocks a merge |
|---|---|---|
| 1. Structure — accessibility-tree YAML | right controls, right order, right labels? | **yes** |
| 2. Pixels — vs the screen's own baseline | did anything change nobody meant to? | **yes** |
| 3. Conformance — app vs mockup | does it look like the design? | no, advisory |

Adding a screen is a data edit in `scripts/visual/screens.mjs` plus a mockup HTML
that links the app's real token stylesheet. One spec file loops the registry; a
second spec file means someone misunderstood.

```
npm run visual            # layers 1+2, the gate (builds first)
npm run visual:update     # re-record baselines after an intended change
npm run visual:compare    # layer 3 → .visual-out/<id>.{app,mockup}.png
```

**The hard-won lesson, and the reason two rules exist:** layers 1 and 2 compare
the app to its OWN record, so both are green when the record itself is wrong. A
baseline recorded from a broken render locks the breakage in and defends it. That
is not hypothetical — it happened for a full day (see §3). So the definition of
done now says: run layer 3 whenever a baseline **moves**, and put the regenerated
baseline **in the PR body as an image**. A reviewer who cannot see the picture is
approving a hash.

## 2. Where things are

`origin/main` = `b9b21cf`. Everything below is merged and deployed unless stated.

Three screens are under verification: `welcome`, `session`, `settings`.

**The design source of truth** is the MantaUI 2.0 redesign spec (v2, decisions
locked), served at
`https://0d5784a7a43451f4ad70dd3d9ee5cf72.boxes.mantaui.com/pages/manta-redesign`.
The repo's two new mockups are **lifted from it** — markup and CSS intact — so
they cannot drift from it. Do not redraw them; if the design is wrong, raise it
against the spec.

Preview pages served for 7 days from 2026-08-01 (same box, `/pages/`):
`manta-mock-session`, `manta-mock-settings`, `manta-mock-compare` (app vs mockup
side by side).

## 3. What was found and fixed this session — do not regress these

- **`w-full` / `h-full` compiled to nothing** (BET-447). `tailwind.config.js` set
  `theme.width`/`height` to a numeric-only scale with no `full` key, so 90 usages
  across 40 files silently emitted no rule. The sidebar filled 449px of a 900px
  window and the transcript stopped being a scroll container. Nothing failed —
  an unknown Tailwind scale key produces no rule and no error. Guard:
  `src/renderer/tailwindScale.test.ts` (pure; fails naming every affected file).
- **Demo mode ran on the live clock** (BET-450). Fixture timestamps are relative
  to `DEMO_T0`, so labels rendered the distance to *today* ("990d") and grew
  daily — which expired every committed capture at each midnight and made the
  drift gate fail on unrelated PRs. That misdiagnosis is what got the gate
  weakened in the first place. `bootDemo()` now pins the clock via
  `pinDemoClock()`; real transports still fall back to `Date.now()`.
- **The drift gate is blocking again** (BET-444, merged with admin bypass —
  CODEOWNERS makes `.github/**` a human-tier merge). It runs `npm run shots`
  twice and diffs **only** `website/shot-*.webp` + `hero-poster.webp` — never the
  whole `website/`, because `npm test` regenerates `sitemap.xml` and that failed
  the gate on an unrelated generator.
- **`ready` was rooting the structure snapshot** as well as gating boot. For a
  screen reached by a click that is the wrong element — the settings "contract"
  recorded as ONE line, a gate that would accept any regression. Screens can now
  declare `snapshot`; it defaults to `ready`.
- **Installer**: BET-440/441/442 all merged AND deployed (`web-v19`).
  `mantaui.com/install.sh` is byte-identical to main. Re-installing is safe.

## 4. The live work — six conformance issues, all assigned to `manta-pm`

All UI-only: restyle, removal, de-duplication. Each carries an explicit
"NOT in scope" list, the exact tokens to use, the files to touch, and a
definition of done. They were written for a weaker implementer — **no design
decision is left open**. Do not loosen that.

| Issue | Surface | Status |
|---|---|---|
| BET-457 | Transcript — one block rhythm (`--block-gap`/`--turn-gap`), capped `--measure` | in_progress |
| BET-458 | Ask cards — one shared shell for permission+question, fix the button ladder | blocked on 457 |
| BET-459 | Session header — one row, drop the cwd, mode `<select>` → icon button | blocked on 458 |
| BET-460 | Composer — short model pill + separate effort pill, icon-only resources | blocked on 459 |
| BET-462 | Sidebar rows — one line, one dot, delete the trailing badge | blocked on 460 |
| BET-461 | Settings — finish pass (icons, quiet selection, cards, danger zone) | todo, parallel |

**The chain is deliberate.** BET-457/458/459/460/462 all regenerate the same two
binary session baselines; they cannot be merged by hand, so they land one at a
time and each rebases + re-records. The `waiting_on` metadata names the blocker,
which the hourly unblock sweep reads — the chain is self-driving, no babysitting.
BET-461 owns the settings baselines and runs in parallel.

**Both mockups carry a CONFORMANCE SCOPE block** listing what is drawn for design
completeness but is NOT implementable as a restyle: the ⌘K command palette, the
pinned section, the account footer, the composer's attach/voice buttons, the
instant-apply Undo toast. The user's instruction was **UI changes only — do not
file or build features.** If an implementer proposes building one of those, that
is a rejection, not a discussion.

**Settings is further along than the redesign spec assumes** — dialog semantics,
the eight sections in the right order and grouping, the search field and the
modified-dots already ship. BET-461 says so explicitly so nobody rebuilds them.

## 5. Your job

1. Review each conformance PR against `docs/visual-verification.md`'s definition
   of done — in particular that the regenerated baseline image is **in the PR
   body**, and that the added/removed line counts show removal dominating.
2. Keep the chain moving: when one merges, the sweep unblocks the next within the
   hour. If it stalls, check `multica issue get BET-4NN` before assuming slowness.
3. When the six are done, the next screens are the mobile session list and the
   folder picker (the redesign spec has a mockup for the picker; the current cwd
   ghost-text input has no discovery path at all).

## 6. Open, not started

- **BET-448** — `visual:compare` emits two bare PNGs and no locator; the BET-443
  implementer reported that finding *which* control moved meant eyeballing two
  images. Wants one annotated composite. Would make every conformance issue
  cheaper, so it is worth doing before the next batch.
- **BET-451/452/453** — a native visual-verification PoC. Relevant to you because
  one of its sub-issues is "delete the transcribed design tokens; generate them
  instead". The tokens added this session (`--r-*`, `--measure`, row metrics,
  `--shadow-lg`, `--ease`, type stacks) are hand-maintained; if that PoC lands a
  generator they become generated output rather than source. Do not invest in
  hand-maintaining more tokens until that is decided.
- **E2E Smoke Test is red on main** and has been for a while — `no built renderer
  at mobile/www` — the job doesn't build the mobile bundle before its screenshot
  test. Non-required, unrelated to any PR it appears on. Nobody owns it.

## 7. Traceability wart

Commit `b9b21cf` and PR #390 reference **BET-451**, which is a different issue
(the native PoC). The key was used before the real issue existed. The work is
**BET-463**, which is filed, marked done, and carries the correction. `git log
--grep BET-451` will surface one commit that does not belong to it.

## 8. Environment cheat sheet

- **Multica**: project `5a215c07`, workspace `264c89bb-4659-4570-af7b-5f8daaf87985`,
  `manta-pm` = `df781c72-9408-47e3-be9e-cfa317ed6bc9`,
  `manta-dev` = `ab49c3e2-0239-43cb-81cf-32d3ee9102f2`.
  Read with `multica issue get BET-NNN` (**not** `show`). Comments list:
  `multica issue comment list BET-NNN --output json`.
  **A comment on an agent-assigned issue DISPATCHES A RUN** — use
  `multica issue metadata set` for notes instead.
- **CI is ONE self-hosted runner.** Jobs queue; every extra job is wall-clock time
  every other open PR waits behind. Only `typecheck-test` is required.
  A full CI pass is ~4 min once it starts, but the queue is often 5+ deep.
- **Merging**: `gh pr merge <n> --squash --admin --delete-branch`. Four PRs were
  merged this way with the user's explicit approval; they asked to be told when
  it happens rather than for it to be avoided.
- **Release = a tag, and merged ≠ deployed.** `web-v*` publishes the website +
  `install.sh`; verify with `curl -fsS https://mantaui.com/install.sh | sha256sum`
  against `git show origin/main:scripts/install.sh | sha256sum`.
  **Push release tags ONE AT A TIME** — GitHub silently drops the push event when
  a single push creates more than three tags.
- **Local gates before pushing** (the runner is congested, and this catches more):
  `npm run typecheck && npm test && npm run visual`, then the drift gate exactly
  as CI runs it: `npm run shots` twice, then
  `git diff --exit-code -- 'website/shot-*.webp' website/hero-poster.webp`.
