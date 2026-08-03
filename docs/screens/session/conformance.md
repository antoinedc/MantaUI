# Conformance — session

App vs `docs/screens/session/mockup.html`, from `npm run visual:compare session`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-03 (c274d90)

## Resolved

BET-637 fixes the remaining transcript-frame divergences against the mockup:
the user message was a full-width left-aligned tinted bar with a `›` marker that
bled outside the column; it is now a right-aligned rounded bubble capped at 88%
(`.umsg`). Assistant text blocks carried a `●` bullet in a left gutter; they are
now plain paragraphs flush with the column (`.amsg`). And the reading column
was padded 16px (inherited from the scroll container) while the composer and
the working indicator sat at a different inset; all three now share one 28px
left/right edge inside the 72ch measure (`.wrap` / `.comp-in`).

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
- **Unboxed connector output** — the bash/read/grep connector output keeps its
  `⎿` shape unboxed at 12px size, deliberately NOT the recessed well
  (BET-636). Only the generic tool output body and the unified diff sit in the
  well.
- **Menu secondary text uses --tx3 instead of --tx4** — the model/effort
  dropdown proposal puts `--tx4` on the group label, the sub-line, the context
  number and the search placeholder, but `text-text-quiet` (--tx4) is
  decorative-only under the contrast rule (BET-410 — tailwind.config.js forbids
  it for labels, placeholders and paths, and `src/shared/contrast.mjs` gates
  it). BET-644 substitutes `--tx3` (`text-text-faint`) at all four sites: the
  hierarchy is preserved (name at --tx1, everything secondary one step down),
  only the tier changes. Deliberate, rule-driven divergence — not an open gap.
