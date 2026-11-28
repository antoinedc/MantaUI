# Fleet v10: outcome badge moves to the status column

Mockup: `docs/screens/fleet/mockup-v10.html` (self-contained throwaway mockup; nothing talks to a box).
Only the **Ended today** rows changed. Everything else is exactly as in v9 (`decisions-v9.md`, which builds on v8).

> Ended today is still provisional and will be iterated on later (carried over from v9).

## Change

User: "can you put the status of the Ended Today line in the second column, rather than in the first one?"

- **The title comes first.** Title, agent · project · when, and the outcome sentence form the first column.
- **The outcome badge** (Done / Didn't finish / Interrupted / Stopped by you, colours unchanged from v9) moves into
  **the same column as the running rows' status**, so "Done" sits directly under "In progress" / "Paused by you" in
  the rows above. Open session stays in the action column, also shared with the running rows.
- Ended rows use the running rows' grid:
  - **List 850 px and wider** (1280 window): title and details span the title and agent columns (Ended rows have no
    separate agent column, so the text gets that width back); badge in the status column; Open session in the action
    column.
  - **List 560–849 px** (900 window): the running rows' three columns (title, status, actions); badge in the status
    column.
  - **Narrow, under 560 px (420 window), my choice:** title, agent · project · when and the outcome sentence on top,
    then the badge on the left of one line with Open session on the right. This mirrors how running rows stack at that
    width (status on the left, actions on the right), so the badge sits where "In progress" sits above it, and every
    title starts at the same left edge.

## Checks

144 renders: Fleet · Projects, Fleet · Agents and Details × every state that shows Ended today (ideal, empty, load
error, box unreachable, failed action, many items, long-running, after acting) × light/dark × 420/900/1280, with
"Show more" opened. Scripted results:
- no script errors and no sideways scroll;
- in every render where the list is shown, all Ended badges start at one x and all titles start at one x;
- from a list width of 560 px, the badge x equals the running rows' status x.

Screenshots: `~/.manta/agents/product-designer/home/fleet-redesign/shots-v10/<view>-<state>-<width>-<theme>.png`.

## Noted, not changed

At a 900 px window the Ended text column is narrow (about 190 px, the same as the running rows' title column), so the
outcome sentence wraps to two lines. Giving the badge its own wider column would break the alignment the user asked for.
