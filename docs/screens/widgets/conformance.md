# Conformance — widgets

Mockup vs `docs/screens/widgets/mockup.html`, registered by BET-1322.
These rows are **mockup-only**: both renderers (desktop React, iOS Swift) are
stage 2, so there is no app screen to compare against yet — the registry rows
capture the design itself so the conformance regions exist, are captured and
reviewed before any implementation.

Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-23 (1dd3ce6a)

## Register (BET-1322)

Added the five conformance regions declared in the mockup's header comment
(`.mk-desktop`, `.mk-anatomy`, `.mk-ios-live`, `.mk-ios-sheet`,
`.mk-ios-degraded`) as mockup-only rows in `scripts/visual/screens.mjs` and
recorded structure + pixel baselines with `npm run visual:update` (scoped to
the new rows — no existing baseline was touched). The mockup's stopgap `:root`
token block was removed; both `--inline-max-w` and `--widget-dormant-opacity`
now resolve from the linked `src/renderer/tokens.css`.

When a renderer lands, switch the rows from the mockup to the app's real demo
state and re-review — tracked as BET-1327.
