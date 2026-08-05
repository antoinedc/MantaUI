# Conformance — artifacts

App vs `docs/screens/artifacts/mockup.html`, from `npm run visual:compare artifacts-empty`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-05 (a281400)

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

## preview overlay (BET-661)

This issue ships the preview overlay — a centred card over a canvas-tinted
backdrop with a header (filename + attach/download/close), a per-type body
(image / PDF / text via the shared CodeBlock), and a metadata footer. The
`artifacts-preview` SCREENS row captures `.manta-artifact-preview` against the
mockup's `.mk-preview`, which shows the image renderer — the one under pixel
conformance; the PDF and text renderers are covered by the unit tests + manual
checks. The row opens the overlay from the Images tab's first row on the
isolated `artifacts` demo state (which seeds one image via a data: URL).

### Resolved against the mockup

The overlay uses the same contract tokens as the design: canvas-tinted
backdrop (`bg-bg/[0.82]` = `--canvas-rgb`), the card on `--panel` with `--border`
+ `--r-lg` + `--shadow-lg`, the image body recessed on `--inset` (`.pvbody`),
the header name `--font-mono` `--tx1`, and the footer `--tx4`
`--font-size-2xs` with a `--border-subtle` divider. Section A of the style
report matches the mockup family-by-family.

### Accepted divergences

- **Header actions use the shared `IconButton` primitive**, not the mockup's
  26px `--r-sm` `.ico` (which also inherits a browser-default Arial). Same
  accepted divergence as the panel header (BET-659): the app standardizes on
  the 24px `--r-xs` `IconButton` chrome, wrap it in the overlay header.
- **The mockup's `.pvbody` placeholder is a filled `--fill-hover` box**; the
  app renders the real image (or PDF embed / code block) on the recessed
  `--inset` surface — the placeholder is design furniture, not a token to copy.
- **Geometry width.** The app overlay covers the full 1440×900 window; the
  `--mk-preview` region is a 720×460 stage, so the layout-dependent padding /
  gap values differ for that reason alone (the report's geometry preamble).
  Colour, border, radius, weight and size are unaffected.
- **Footer letter-spacing.** The app uses `text-micro` (its `0.08em` tracking)
  for the `--font-size-2xs` footer line — the same accepted tracking divergence
  as the panel's day-group headers (BET-659).
