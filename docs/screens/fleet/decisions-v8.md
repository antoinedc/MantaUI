# Fleet v8: only statuses the box records reliably

Mockup: `docs/screens/fleet/mockup-v8.html` (self-contained throwaway mockup; nothing talks to a box).
Everything else is as in v7 (`decisions-v7.md`); Needs you is unchanged from v6.

## Rule

A row shows a status only when the box records it deterministically. Anything inferred from timing or in-memory
signals is a follow-up, not part of this design.

## Running-task statuses now

| Status | Source | Row |
|---|---|---|
| **In progress** | the task record's status is running | green dot, "In progress" |
| **Paused by you** | the task record is saved as paused until resumed | grey dot, "Paused by you" + when, **Resume** (disabled with its reason while 5 tasks are already running; that cap is a fixed rule, not a guess) |

Ended keeps **Done / Didn't finish / Interrupted / Stopped by you**: those are recorded outcomes.

## Removed (follow-ups)

| Removed | Why |
|---|---|
| "Paused: usage limit reached · Resumes automatically", the "Usage limit reached" state, the usage line at the top | Usage limits stop new background work from starting; they don't pause running tasks, and nothing auto-resumes. |
| "Stuck" (row, project and agent headers, Details explanation) | Progress is tracked in memory only, a restart resets it, and it isn't measured the same way for every kind of task. |
| "Taking much longer than usual" (and the agent's usual-time line in Details) | Depends on the same timing history. |
| "Having trouble · Retrying on its own" (and the retries / refused-action lines in Details) | No deterministic source. |
| "Plan grew to N steps" in Details | Shown only inside the removed warnings block. The checklist itself stays. |

Headers count only what's left: "3 in progress · 1 paused"; the page header says "4 in progress · 1 paused". Groups list
in-progress tasks before paused ones; groups holding only paused tasks go last.

## State notes

- **One long-running task:** the row reads "In progress" like any other. The only difference is in Details ("Started
  08:36 · 2 h 40 min ago"). The design no longer judges whether that is too long.
- **Failed action:** the "Couldn't stop it" error (on the row and in Details) is kept. It reports a failed request,
  not an inferred status.
- **Many items:** 5 in progress and 4 paused by you, with Resume disabled and its reason.

## Checks

216 renders (4 views × 9 states × light/dark × 420/900/1280), all scripted:
- no script errors and no sideways scroll;
- none of the removed wording appears anywhere ("Stuck", "usage limit", "Resumes automatically", "longer than usual",
  "Having trouble", "Retrying", "On track");
- every project header contains only "N in progress" and/or "N paused".

Screenshots: `~/.manta/agents/product-designer/home/fleet-redesign/shots-v8/<view>-<state>-<width>-<theme>.png`.
