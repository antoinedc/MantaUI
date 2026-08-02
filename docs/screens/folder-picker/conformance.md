# Conformance — folder picker

App vs `docs/screens/folder-picker/mockup.html`, from `npm run visual:compare folder-picker`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-02 (BET-567)

## Captured state

The picker is opened from the demo empty state's new-session welcome screen by
clicking the "Home" chip (`state=empty`, zero projects, one click, no session
setup), then descended one level into `~/projects`.

**Why the capture descends a level (a real story, not decoration):** the
empty-state path is literally `~`, which Playwright serialises as
`textbox: ~`; `~` is YAML's null literal, so Playwright's aria snapshot
rejects the structure with "Node value should be a string or a sequence" and
the gate cannot round-trip a picker rooted at `~`. Descending into `~/projects`
(a real user gesture — clicking a folder row) puts a real path in the field, so
the structure contract rooted at the modal no longer collides. The fixture
listings (`demoHomeDirs` / `demoProjectsDirs`) exist so both the captured state
and the mockup render the same words.

## Open divergences

- **Modal width** — the mockup is `min(540px, 100%)` (from the spec); the app is
  `w-[560px]`. Both on the 4px grid; ~20px apart.
- **Path field** — the design shows a plain full-width path + focus ring + Go;
  the app's path input keeps the existing ghost-text completion overlay
  (the spec explicitly preserves typed-path completion, so this is expected
  divergence, listed for completeness).

## Accepted divergences

_None recorded._

## Closed divergences (BET-567)

- **Go button** — the explicit `Go` trigger (§07) is now beside the path field,
  browsing into the typed path. Closed.
- **Header copy** — now "Select folder" (was "Choose a folder"). Closed.
- **Breadcrumb treatment** — now home icon + inter-crumb chevrons with the
  current crumb at full weight (was an up-arrow button + mono pills). Closed.
  The `..` list row and the footer's primary action keep their existing form.
- **Baseline** — `folder-picker` visual + aria baselines re-recorded to the new
  render.

## Off-grid design values surfaced (reported, not transcribed)

The source's demo-only values were kept out of the mockup per
`docs/visual-verification.md`: `34px` path-field height → 36px, `9px` list-row
padding → 8px, `222px` list `max-height` → 208px, `12.5px` breadcrumb font →
13px. A real implementation should resolve these against the acceptance rules
rather than copying them.
