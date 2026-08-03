# Conformance — session

App vs `docs/screens/session/mockup.html`, from `npm run visual:compare session`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-03 (80a29e0)

## Open divergences

The prior transcript tool rendering — a text bullet plus a floating monospace
line at the 15px reading size — did NOT match the spec and was left unrecorded
here as "none". BET-636 fixes it: a tool call now renders as a bordered,
rounded card on the raised surface (`.tool`), with a header strip (`.tool-h`)
holding the real status dot, bold name, gap, truncating muted argument and a
right-aligned `+38 −4` summary, and — when there is output — a recessed well
(`.tool-b`) at 12.5px mono. The permission card's command block shares the
same well. No tool-call chrome divergences remain open after this change; the
deliberate tail-gaps are recorded as accepted divergences below.

## Accepted divergences

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
