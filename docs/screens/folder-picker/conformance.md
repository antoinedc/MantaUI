# Conformance — folder picker

App vs `docs/screens/folder-picker/mockup.html`, from `npm run visual:compare folder-picker`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-02 (8176518)

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

- **No explicit "Go" / discovery affordance — the design's headline.** §07
  frames the whole point of replacing the ghost-text cwd input as adding a
  *discovery* path, and the design adds a **Go** button beside the path field
  (plus home-icon + chevron breadcrumbs as the navigation frame). The app's
  modal already ships the folder **list** (`..` first, row badges, breadcrumbs,
  dimmed noise) — the discovery data is present — but there is **no Go button**:
  the only ways to move are clicking a folder row, clickable breadcrumbs, the
  up-arrow, or Enter. So the app is short exactly the explicit "Go" trigger the
  design uses to signpost the discovery path. Recorded, not fixed here — closing
  it is separate work with its own baseline review.
- **Header copy** — the app titles the modal "Choose a folder"; the design says
  "Select folder".
- **Breadcrumb treatment** — the design uses a home icon + inter-crumb chevrons
  with the current crumb at full weight; the app renders an up-arrow
  "Go up one level" button plus mono breadcrumb pills. Functionally
  equivalent (both go up a level per click); visually different.
- **Modal width** — the mockup is `min(540px, 100%)` (from the spec); the app is
  `w-[560px]`. Both on the 4px grid; ~20px apart.
- **Path field** — the design shows a plain full-width path + focus ring + Go;
  the app's path input keeps the existing ghost-text completion overlay
  (the spec explicitly preserves typed-path completion, so this is expected
  divergence, listed for completeness).

## Accepted divergences

_None recorded._

## Off-grid design values surfaced (reported, not transcribed)

The source's demo-only values were kept out of the mockup per
`docs/visual-verification.md`: `34px` path-field height → 36px, `9px` list-row
padding → 8px, `222px` list `max-height` → 208px, `12.5px` breadcrumb font →
13px. A real implementation should resolve these against the acceptance rules
rather than copying them.
