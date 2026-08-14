# Conformance — welcome

App vs `docs/screens/welcome/mockup.html`, from `npm run visual:compare welcome`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-14 (bd38d73a)

## Open divergences

- None.

## Re-record (BET-813)

Baselines re-recorded with `npm run visual:update` after the deferred re-record
(BET-662 cancelled, BET-768 composer change) landed. The welcome screen now
renders the landed empty-repositories state ("Let's get some code on this box" /
Clone from GitHub / Browse for a folder) rather than the older desktop new-session
composer; the pixel + aria baselines were refreshed to the current build. No
registry or conformance-mechanism changes.

## Accepted divergences

- Ticking **worktree** turns the branch chip accent-toned (border, background,
  text and icon). The spec draws the worktree toggle as a second segment inside
  the branch chip; the implementation keeps it as a sibling `Checkbox` because
  the spec's own markup nests a fake checkbox inside a `<button>`, which is
  invalid HTML and inaccessible. The sibling checkbox stays exactly as it is.
- The composer box is not built from `Card` despite matching its chrome: it
  needs the `manta-composer-input-row` hook class for its focus ring and the
  `manta-recording` border state, and primitives accept no `className`
  (`docs/components.md` decision 3).
- The send button is hand-rolled rather than a primitive. It is the only
  bordered icon button in the app; at one call site it fails the two-adopter
  rule (`docs/components.md` decision 2). Revisit if a second one appears.
- Token snaps: the heading is 24px (`text-display`) where the spec draws 21px
  — 21px is not a type role; and the standalone icon buttons are 32px/16px
  (`IconButton` `xl`) where the spec draws 27px/14px — 32px is the spec's own
  default control height. Both are off-grid values the repo's token scale
  cannot express, so they snap to the nearest primitive chrome.

