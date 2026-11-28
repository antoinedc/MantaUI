# Fleet + Needs you v5: decisions applied in the mockup

Mockup: `docs/screens/fleet/mockup-v5.html` (self-contained, a throwaway mockup; nothing talks to a box).
Base: the v4 mockup (`~/.manta/agents/product-designer/home/fleet-redesign/fleet-options.html`) and the v5 text spec
(critique of v4 plus the v5 design). Tokens copied verbatim from `src/renderer/tokens.css`.

## The nine defaults (the user asked for the recommendations to be applied without asking again)

| # | Decision | How the mockup shows it |
|---|---|---|
| 1 | Keep the checklist bar; no "N of M" text, no project sums | Rows show the segmented bar (current step = outlined segment) and "18 min so far". Group headers say "3 running · 1 quiet", never step counts. Screen readers get "2 steps done, on step 3 of its checklist". |
| 2 | "Let Manta decide" takes the recommended option, with Undo | Change card says "Manta recommends: Apply"; pressing Let Manta decide leaves a "Manta decided: applied the change…" row with Undo. Same on the "retry or drop" decision. |
| 3 | "Undo merge" on Manta-merged Ended rows for 24 h | Only rows with "Manta merged it" carry Undo merge (tooltip says 24 h). It asks first in a native `<dialog>` ("Keep it merged" focused); the row then reads "Merge undone by you just now. The branch is kept." |
| 4 | Ended keeps today, with "New" markers and "Earlier days" | Section is "Ended today · 6 tasks · 2 new since you last looked"; 4 rows then "Show N more"; footer link "Earlier days". It never clears on leave. |
| 5 | Resume disabled, with its reason, when the box is full | In "Many items · box full": every Resume is disabled with the title "The box is full (5 of 5). Resume when a task ends."; the collapsed Paused header also says "Resume is off while the box is full". |
| 6 | No Manta group; "asked by Manta in <chat>" | Agents view groups only Dev, Architect, Product Designer. Meta lines say "asked by Manta in Limits cleanup". Manta stays in the sidebar Team list. |
| 7 | Usual-time range only past its upper bound, and only with 10+ runs | Only the long-running state shows "Running 2 h 40 min · Dev usually finishes in under 40 min" (Dev has 24 runs in the sample data). Product Designer (8 runs) would get "Running N" only. |
| 8 | A failed task goes to Ended and the asking chat, not Needs you, unless a decision is needed | "Update the changelog" failed: Ended row, "Manta reported it in Release prep", not in Needs you. "Run the export tests" failed AND needs a decision ("retry with a longer limit, or drop it?"), so it appears in Needs you as "Waiting on you" with Let Manta decide. |
| 9 | Sidebar Fleet count "5", "box full" in the header | Sidebar shows the plain number; the Fleet header shows "5 running · box full" and the page shows "The box is full: 5 of 5 slots in use. New tasks wait until one ends." |

## Kept from the v5 spec

- No "Review branch" item anywhere; Needs you holds only changes waiting on you, open questions and decisions.
- Questions are blue (accent), never warning yellow: "Open question · keeps working" pill, the blue "?" line on the row, and a blue "+1" next to the ringed decision count.
- "Waiting on you" replaces "Stopped until you decide"; "Let it guess" replaces "Didn't need me" on questions.
- Healthy rows: title, what it's doing now, who and where, bar, time so far. Warning lines only when true (quiet, long, time limit, plan grew, retrying, refused, question).
- Stop only on rows in trouble plus in Details; always a native dialog with "Keep running" focused, Esc cancels.
- "Should have asked me" lives in the Details of an ended task, not on every Ended row.
- Details: status, Agent / Project / From / Running time / Branch, question block with "Answer in Needs you", "Needs a look" (only what's true), checklist with per-step times, Open session + Stop task. No "Usual" row, no list of things that didn't happen.
- Failed answer keeps the choice selected and reads "Submit again"; failed Apply reads "Apply again" with the reason.
- Unreachable: yellow banner with the last report time; every action disabled with "Unavailable until the box is reachable".
- Load error (box reachable): red banner with the reason, "Try again", earlier data stays visible.
- Loading: nothing for 150 ms, then a skeleton.
- One polite live region announces state changes (stopped, resumed, decided), never clock ticks.

## Changes and deviations from the v5 text

1. **Sample data rewritten for the current team** (Manta, Architect, Dev, Product Designer). The v5 text used Security and Conversion (CRO) examples; those agents were deleted. The change waiting on you is now the Architect's proposal to add the impeccable skill to Product Designer; the open question is Dev's type-ahead question on the headless-tree migration.
2. **Details at 900 px takes the whole pane.** At a 900 px window the list is about 690 px wide (after the sidebar), under the 720 px threshold the spec set, so Details replaces the list instead of sitting beside it. At 1280 it is a 400 px side panel. Lowering the threshold would squeeze the list to about 290 px; kept as specified.
3. **Middle layout (list 560–849 px) uses fixed 150 px progress and action columns** so the bars line up whether or not a row shows Stop. Not in the spec, found in the render.
4. **Change card shows "Manta recommends: Apply"** so "Let Manta decide" has a visible outcome before you press it, not only in the tooltip.
5. **"Retry or drop" decision uses the question card's shape** (options, Recommended, free text) with "Let Manta decide" instead of "Let it guess", because nothing happens until you choose.
6. **A Routine pill sits next to the title** of routine runs (the v5 text listed "routine label buried in the meta line" as a minor issue; this is the fix).
7. **Paused rows at 420 px stack** the actions under the title instead of beside it.

## Not checked

- Real fonts: the mockup names Inter but bundles no font (no network), so renders use the system fallback.
- Contrast was not re-measured by script in this round; colours are the app's own tokens, and the v4 check (no text under 4.5:1) used the same tokens and badge-ink rule.
- Keyboard order and screen-reader output were checked only by reading the markup, not with a screen reader.
