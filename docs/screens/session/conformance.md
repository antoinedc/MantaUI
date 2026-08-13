# Conformance — session

App vs `docs/screens/session/mockup.html`, from `npm run visual:compare session`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-05 (f3f5dce)

## Artifacts toggle added to the header (BET-659)

The header's right `.topb`/`.sp` group gains an Artifacts toggle button
(panel-right glyph) between the context pill and the session menu — the header
in the mockup and the app were updated together, and the three registry rows
that share this record (`session`, `session-header`, `session-composer`) were
re-baselined at that commit. No other header geometry changed.

## Floating chat chrome (this change)

#558 applied a mobile treatment to the desktop chrome: a floating
translucent header with no breadcrumb, and a floating composer with the
model chip moved above the input. Both were reverted — the header bar in
4f1f85e, the composer meta row in 3a51961 — so the screen matches the
reference again: a bordered header carrying **workspace / session**, and a
composer whose meta row sits BELOW the input box.

Baselines regenerated in 33dc528 for the three registry rows that share this
record (`session`, `session-header`, `session-composer`), pixels and aria
structure together.

Fixed here, and visible in the new `session` baseline:

- **The context bar fills from its left edge.** The segments were inline
  content, so they inherited `text-align` from the `<button>` hosting the pill,
  which the UA stylesheet centres — a 19% reading was computed correctly and
  then painted as a 19%-wide block floating at ~40% of the track, dead space on
  both sides. The track is a flex row now, which packs from the main-start edge
  and cannot inherit that.
- **Every session-menu row shows its hover.** All three variants painted their
  hover fill with the token `Dropdown` paints its own panel with, so hovering a
  row drew card-on-card. Only `danger` looked interactive, because `--danger-bg`
  happens to differ from the panel — and with no radius on the row, that single
  visible fill was a square block inside a 12px-rounded panel. Now `--fill-hover`
  + `--r-md`, matching `MenuOption` in the model and effort menus.
- **The context popover is a sibling of its trigger, not a child of it.** It was
  rendered inside the trigger `<button>`, which put the "Clear session"
  `<button>` inside a `<button>` — invalid markup browsers repair by splitting
  the element, and the reason every control in the panel needed a
  `stopPropagation` to survive its own click.

## Open against the mockup

Recorded from `npm run visual:compare session` at 33dc528. These are app-vs-
mockup deltas, all of them the app moving ahead of the drawing:

- **Mode-toggle glyph dropped.** The mockup keeps a `>_` glyph beside the ⋯
  button. Removed by owner direction: it was a second control for a decision
  the ⋯ menu's own Mode section already owns, and it could only ever express
  the Chat ↔ Terminal half of a list that also holds every AI-CLI launcher.
- **Branch chip sizing.** The mockup draws it as a bordered inline tag; the app
  draws `Tag` at the new `sm` density (20px, `--tx3`) on the glass surface, with
  `plain` suppressing Tag's own edge so it does not double the pill's. Owner
  direction was "slightly smaller"; it had been the tallest element in the row.
- **Composer attach + voice buttons not wired (BET-620).** The stage-6 composer
  migration (PR #525) closed the composer's `--measure` cap (72ch, `mx-auto`),
  the send button, the placeholder copy and the meta-row/mbtn densities onto the
  spec — but the mockup's `Attach` (paperclip) and `Voice` (mic) `.mbtn`s are
  still not rendered by the session composer. Recorded as open, not a defect:
  upload plumbing (drag-drop / paste / `⌘V`) and `MicButton` (inline desktop
  mic) both exist and work, but surfacing them as composer controls is a
  feature, not a restyle — the mockup itself says so
  (`docs/screens/session/mockup.html:44`).

## Resolved

BET-637 fixed the initial transcript-frame divergences against the mockup: the
user message is a right-aligned rounded bubble capped at 88% (`.umsg`),
assistant text blocks are plain paragraphs flush with the column (`.amsg`), and
the reading column shares the primitive's 28px side inset.

BET-646 supersedes part of that: the transcript column now runs the panel's
**full width** (28px inset, no measure cap, no centring) by owner decision,
while the composer stack and the user bubble keep the 72ch measure. The user
bubble caps at `min(88%, var(--measure))` so a long message stops at the
reading measure instead of spanning the window. The mockup and the app were
updated together; the session baselines were regenerated and re-conformed to
this record.

**Every tool body now sits in the card's recessed well.** BET-636 boxed the
tool call but left three of its bodies outside the well: the bash/read/grep
connector output (unboxed, with the `⎿` corner glyph and a 16px gutter column
that was blank on every row but one) and Glob/WebFetch (which drew their OWN
`bg-bg-soft` bordered box, so a frame sat flush inside the card's frame). All
three now render into `OutputWell variant="attached"`, so output shares the
header's `px-3` inset, sits on the inset surface, and is separated from the
header by the well's top border — one silhouette for collapsed and expanded
cards alike. The `⎿` gutter is dropped with them: it existed to tie output to
its header in the pre-card flat list, a job the card now does, and it left
every output line misaligned with the header above it. It survives in the two
places still drawn flat — the patch/file parts in `ToolCall.tsx` and
`ActiveTodos`.

**The hover timestamp clears the row instead of overlapping it.** At `-top-2`
the 12px stamp ran from −8px to +4px relative to the row, i.e. its bottom 4px
sat inside the row's first block. Invisible while that block was bare text;
a visible collision once it became a bordered tool card (BET-636) or a user
bubble (BET-637). It is now `-top-[18px]` — 6px of air on both sides inside
the 24px `--turn-gap`.

## Accepted divergences

- **Slash-command bar keeps its own bar treatment** — the collapsed `/name args`
  row that expands to the full template keeps its `›` gray-bar chrome; it is a
  different object from a typed message and the spec does not draw it (BET-637).
- **Reasoning block keeps its `✻` gutter** — the `✻` is italic, muted and
  visually distinct on purpose; the spec does not draw a reasoning block
  (BET-637).
- **Pinned vs inline ask card** — the app pins a pending permission card above
  the composer, while the mockup draws the ask inline in the scrollback (PR
  #392). The pinned placement is deliberate and will not be changed.
- **Tool pulse cadence** — `StatusDot`'s running tone uses Tailwind's
  `animate-pulse` (1s ease-in-out) instead of the spec's `.tool-h .g.run` 1.4s
  ease-in-out keyframe (BET-636). Intentional: the primitive layer does not add
  a bespoke keyframe for one cadence.
(The bash/read/grep connector output was listed here as an accepted divergence
by BET-636 — kept unboxed with its `⎿` gutter at 12px. That is now resolved;
see below.)
- **Menu secondary text uses --tx3 instead of --tx4** — the model/effort
  dropdown proposal puts `--tx4` on the group label, the sub-line, the context
  number and the search placeholder, but `text-text-quiet` (--tx4) is
  decorative-only under the contrast rule (BET-410 — tailwind.config.js forbids
  it for labels, placeholders and paths, and `src/shared/contrast.mjs` gates
  it). BET-644 substitutes `--tx3` (`text-text-faint`) at all four sites: the
  hierarchy is preserved (name at --tx1, everything secondary one step down),
  only the tier changes. Deliberate, rule-driven divergence — not an open gap.
