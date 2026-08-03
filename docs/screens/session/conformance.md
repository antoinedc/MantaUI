# Conformance — session

App vs `docs/screens/session/mockup.html`, from `npm run visual:compare session`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-03 (PLACEHOLDER)

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
