# Conformance — settings

App vs `docs/screens/settings/mockup.html`, from `npm run visual:compare settings`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-01 (18c240b, BET-524)

## Open divergences

- **Extensions launcher card** — the heading text and card ordering of the
  launcher card differ between `Settings.tsx` and the mockup's `.ext` panel.
  `tracked: BET-473`

## Accepted divergences

_None recorded._

### General panel (BET-524, from the style-diff report)

- **Group-card chrome** — the app renders each settings group as a bordered
  `--card`-style box (`rounded-xl border border-border bg-bg-soft px-4 py-3`),
  while the mockup draws flat `.setgrp` groups with divider rows. This is
  shared `GroupCard` chrome used by the Box / Accounts / Extensions panels
  too; closing it in the General panel would edit a shared primitive used
  outside the two BET-524 surfaces, so it is recorded here and flagged for the
  generalisation decision, not applied.
- **Danger-zone box edge** — the app draws the box with a solid `--danger`
  edge; the mockup's `.danger-z` uses a 35%-alpha `--danger` edge. The solid
  edge lives in the shared `GroupCard` danger branch (also used by the Box
  panel's Danger zone), so it is recorded, not applied (same shared-primitive
  boundary).
- **Reset-all button** — updated to `--danger/40` edge + `--r-md` radius to
  match the mockup's `.btn danger`; remaining size/spacing is layout-dependent.
- **Card inner spacing & type** — the padding (`--sp-3`/`--sp-4`) and
  label/body type differ from the mockup partly because the mockup region is
  ~1.8× wider (layout-dependent) and partly shared `--card` inner rhythm;
  accepted.
- **Micro-caps headings** — the app renders headings as `text-micro`
  (0.275px tracking); the mockup uses a raw 0.88px letter-spacing. Mockup
  defect: 0.88px is off-grid and contradicts the `--micro` spec; accepted as-is.
