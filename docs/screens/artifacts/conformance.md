# Conformance — artifacts

App vs `docs/screens/artifacts/mockup.html`, from `npm run visual:compare artifacts-empty`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-05 (6c17cb8)

## Artifacts panel shell + empty Links tab (BET-659)

This issue ships the panel chrome — header (title / search / close), the
segmented Links / Images / Files tab bar, and the empty state — with body rows
deliberately left as plain-text placeholders (BET-660 renders them real). The
`artifacts-empty` SCREENS row compares the live panel against the mockup's
`.mk-empty` region on an empty Links tab.

## Resolved against the mockup

The tab bar was aligned to the design's `.mk-tabs`: an inset track
(`bg-inset`, `--border-subtle`, `--r-md`), equal-width tabs with `--r-sm`
radius, the active tab on `--raised` with `--shadow-sm`, and count pills
(`--r-full`, `--fill`, active `--accent-bg`/`--accent-tx`). Tokens now match
the mockup (Section A: color `--tx3`/`--tx1`/`--accent-tx`, background
`--inset`/`--raised`/`--fill`, border `--border-subtle`, radius `--r-sm`/
`--r-full`/`--r-md`, gap `--sp-px`). The empty state matches `.empty`: the
leading line (`.big`) plus the other tabs' counts (`.sub`), centred.

## Accepted divergences

- **Live panel is an edge-to-edge window strip, not a standalone card.** The
  mockup draws `.mk-panel` as a 340px rounded card (full `--border` + `--r-md`)
  floating on the canvas; the app panel is `shrink-0 border-l bg-bg-elev` and
  runs the full viewport height. Outer border-radius / per-side border widths /
  background-on-card are therefore absent in the live build — the panel fills
  its window edge, as the sidebar family does. The panel's 340px default width
  (the one literal the design marks as component-owned) matches.
- **Header icon buttons use the shared `IconButton` primitive**, not the
  mockup's bespoke 26px `--r-sm` `.ico`: the primitive is 24px `--r-xs`,
  `--tx3`, Inter — the same standardized chrome as every other header (the
  session header's own controls). The mockup `.ico`/`.tab` buttons also inherit
  a browser-default font (Arial, no token) where the app uses `--font-sans`.
- **Day-group / sub-label letter-spacing.** The app's day-sticky headers and
  empty-state sub-line use `text-micro`, whose token carries `0.08em`
  letter-spacing; the mockup's `.dgrp`/`.sub` use normal. Minor, tokenized on
  the app side.
- **Body rows are placeholders.** Each row is a single `label` text line, per
  the issue's explicit scope; BET-660 owns the real link/image/file rows and
  their own three SCREENS rows against this mockup's `.mk-links`/`.mk-images`/
  `.mk-files`.
