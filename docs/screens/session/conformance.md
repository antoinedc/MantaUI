# Conformance — session

App vs `docs/screens/session/mockup.html`, from `npm run visual:compare session`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-01 (18c240b, BET-524)

## Open divergences

_None recorded._

## Accepted divergences

- **Pinned vs inline ask card** — the app pins a pending permission card above
  the composer, while the mockup draws the ask inline in the scrollback (PR
  #392). The pinned placement is deliberate and will not be changed.

### Session header (BET-524, from the style-diff report)

- **Zero-width top/right/left edges** — the header only carries a visible
  bottom edge (`--border-subtle`, now matching the mockup's `.topb`); its
  top/right/left edges are 0-width, so their border-colour never paints.
  The style-diff reports them against the mockup's full edge; accepted as a
  no-op.
- **Pill shape** — the branch chip and context pill use Tailwind
  `rounded-full` (a sanctioned component-code utility per `tokens.css`),
  which renders fully round; the mockup names `--r-full` (999px). Both read
  as full pills; accepted, no visible distinction.
- **Icon-button hit target** — the mode toggle and session menu keep `p-1`
  (24px) with `--r-sm` radius rather than the mockup's fixed 28×28. 28px is
  not on the 4px spacing grid as pure padding, so reaching it would need an
  off-grid value; accepted.
- **Header height** — app `h-11` (44px) vs mockup 46px; layout-dependent
  (the mockup region is a different width).
- **Segment track background** — the context pill's mini segmented bar uses a
  `--card` track with `--ok`/`--info` usage-colour segments; the mockup uses a
  `--fill-active` track. Accepted: the segments paint usage stage colours by
  design.
- **Type** — the header renders `--font-sans`/`--font-mono` (correct tokens)
  where the mockup's unset elements fall back to the browser default
  Arial / 13.33px. Mockup defect: raw browser defaults, not expressible on
  the token grid.
