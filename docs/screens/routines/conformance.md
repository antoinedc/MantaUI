# Routines — conformance notes

Compared with `npm run visual:compare -- <id>` (app left, `mockup.html` right) at
1440×900 against `docs/screens/routines/mockup.html`. Baselines recorded for the
seven `routines-*` rows only. Differences left on purpose or open:

Last reviewed: 2026-10-30 (0223498a)

## Deliberate

- **Demo clock is Thu 30 Oct 2025 10:01** (not the shared 2023 `DEMO_T0`) so the
  mockup's weekday labels ("Thu 30", "Fri 24", "Wed 5 Nov") hold. Only the
  `routines*` demo states use it.
- **"Next" column rule** (same day `H:MM` · tomorrow `Tomorrow H:MM` · within 6 days
  `Ddd H:MM` · later `Ddd D Mmm`): "Daily analytics digest" reads `Tomorrow 9:00`
  where the mockup says `Fri 9:00`.
- **"Your routines" count** is the real row count (8).
- **Eyebrow** is the Eyebrow primitive's accent colour with `mb-3`; the mockup's is
  quieter and tighter. **Modal surface** is the Modal primitive's `bg-bg-elev`
  (the mockup's is the lighter card colour). Both come from primitives and are not
  overridden.
- **Run bar prev/next** read `‹ Previous` / `Next ›` (the mockup shows weekday names
  `‹ Wed` / `Fri ›`); the run view only carries neighbour ids, not their dates.
- **No artifacts toggle** in a run's header (there is no artifacts panel for a run;
  a dead button is not shipped). The mockup shows one.
- **Memory tool lines** of the mockup ("Memory read · 14 lines", "Memory updated · +2
  lines") are not drawn: they are ordinary tool calls and the demo transcript has
  generic ones, so the transcript shows the collapsed tool group instead.
- **Queued/running detail lines** are built from the run itself (the wire only
  carries the latest run per routine); "starts in ~1m" estimates are not shown.
- **Convert modal** "When" is read-only (cadence is the follow-up's); "Allowed to"
  switches on click. Memory field is a 4-row textarea.
- **Routine → chat modal** shows the fixture's real memory size (10 lines), where the
  mockup says 14; the "Another chat…" row opens a picker instead of an inline list.
- **Created-from-chat card** takes its memory line count from the tool input, so the
  fixture's input has 4 lines to match the mockup.
- **No "Follow-ups in a chat" section** on the Routines page (owner request,
  2026-10-30: too cluttered). "Make it a routine" moved to the chat's ⏰ card, so the
  `routines-convert` row opens the modal from there.
- **Run header has a Close (×)** beside "Keep in sidebar" that returns to the list;
  the mockup relies on the crumb only.
- **Instructions and memory are clamped** (5 / 6 lines) with Show more / Show less
  on the routine page and in a run.
- **Run rows have no title of their own** when the outcome pill already says it all
  (no "Running" / "Done" twice).
- **Create editor** is typed into with real gestures by the registry row (the mockup
  is pre-filled); Folder shows the first project's folder, Model "Default".

## Open

- `routines-create` / `-convert` capture the inner `manta-routines-*` hook, not the
  Modal panel's border/rounded corners (Modal takes no hook prop).
- The Callout `note` size caps at 62ch, narrower than the mockup's full-width note.
- 22 other visual rows fail identically on `origin/main` (header context pill,
  environment); not re-baselined. Rows showing the sidebar will also gain the new Routines nav row when the environment issue is fixed and they are re-recorded.
