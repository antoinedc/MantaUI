# Fleet v7: what changed from v6 and why

Mockup: `docs/screens/fleet/mockup-v7.html` (self-contained throwaway mockup; nothing talks to a box).
Needs you is unchanged from v6, as asked. Tokens are copied verbatim from `src/renderer/tokens.css`; no new tokens.

## Changes

| User feedback | v7 |
|---|---|
| Remove the optional-question line; keep only blocking alerts | The top shows only the red-edged card "N decision(s) waiting for you". There's no question line, and "optional question" is gone from rows, project headers and Details. Questions appear only in Needs you (plus the sidebar's small blue dot, which is part of the Needs you entry). When nothing blocks, one green line: "Nothing needs you right now." |
| Rows: just title and agent name, organised properly | Drop "asked by Manta in …" and "asked by you" (still in Details as "From"). Rows are a grid with aligned columns: **title · agent · status · actions** at 850 px and up. Between 560 and 849 px: title with the agent under it, then status, then actions. Under 560 px it stacks. Scripted check: every status starts at the same x on the page. |
| "Stuck": how is it defined? | **Stuck = no progress for 5 min.** Progress is what the server already measures (any output, reasoning or tool step; a running command counts as alive until its own timeout). The row shows "Stuck" with the subline "No progress for 6 min". It clears as soon as the task moves. Details explains: "Progress means any output, reasoning or tool step; a running command counts as progress until its own timeout." and "Stops automatically after 15 min without progress." |
| "Taking much longer than usual" | Only shown when the agent has 10+ finished runs to compare against. Subline: "Dev usually finishes in under 40 min". Otherwise the row stays "On track". |
| Paused section: what does it mean? | **The section is removed.** Paused is a row status inside its project or agent group, with the reason: **"Paused by you"** (subline: when) with a **Resume** button, or **"Paused: usage limit reached"** (subline: "Resumes automatically at 15:00") with no button. Headers count them ("1 in progress · 1 paused"); the page header says "4 in progress · 1 paused". |
| Undo in Ended today | **Removed**, together with its dialog and the Undo in Details. Ended rows: Done / Didn't finish / Interrupted / Stopped by you, title, agent · project · when, one outcome sentence, Open session. |
| Agents view | Same rows grouped by agent: title · project · status · actions. |

## States checked

Ideal, empty, loading, load error, box unreachable, failed action, many items with the box full, one long-running task, after acting, and a **new "Usage limit reached" state**: every running task shows "Paused: usage limit reached · Resumes automatically at 15:00", with one calm line at the top saying the same. 240 renders (4 views × 10 states × light/dark × 420/900/1280): no script errors, no sideways scroll. Screenshots: `~/.manta/agents/product-designer/home/fleet-redesign/shots-v7/<view>-<state>-<width>-<theme>.png`.

## Defaults I chose (unsure; easy to change)

1. **The Stuck subline counts up** ("No progress for 6 min") rather than always saying "5 min". It appears at 5 min, and the real number tells you how close it is to the automatic stop at 15.
2. **"Resumes automatically at 15:00" assumes the box knows when the usage limit resets** and resumes the task by itself. If it can't, the row should say "Paused: usage limit reached" with Resume instead. This needs confirming with @dev before building.
3. **A usage limit pauses every running task**, so the usage state shows them all. If limits are per model, only the tasks on that model would pause.
4. **"Having trouble · Retrying on its own"** stays for retries and refused actions. It wasn't in the feedback, and it's still a plain sentence.
5. **Paused tasks stay in their project group**, sorted after running ones, and groups holding only paused work go last. With many paused tasks in different projects (the "many items" state), that gives several small groups. The alternative is a "Paused" group at the end, which is what was just removed.
6. **The Weekly tag on routine runs is gone**: rows are now title and agent only. Details still says it came from a routine.
7. **Stop stays only in Details**, as in v6.

## Unchanged from v6

Needs you, the sidebar badge (one red count for decisions; a blue dot when only questions are open), Details as the place for the technical record (branch, checklist, time per step, plan changes, retries), "Should have asked me" in Details, and plain Ended outcomes.
