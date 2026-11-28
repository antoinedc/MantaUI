# Fleet + Needs you v6: what changed from v5 and why

Mockup: `docs/screens/fleet/mockup-v6.html` (self-contained throwaway mockup; nothing talks to a box).
v5 and its decisions stay in `mockup-v5.html` / `decisions-v5.md`. Tokens are copied verbatim from `src/renderer/tokens.css`; no new tokens
(the left edge uses the existing `--need-edge-w`).

## The user's feedback, and the change

| Feedback | v6 |
|---|---|
| "Waiting on you" isn't clearly labelled or urgent enough | Solid **red** label (`--danger` fill, canvas-coloured text, warning icon). The blue "Open question · keeps working" label is unchanged. |
| Labels have different lengths, so items don't line up | The label sits **on its own line** above the title, with the age right-aligned on the same line, plus a coloured **left edge** (red or blue). Title, agent line and card start at the same x for every item. |
| "Let Manta decide" duplicates the shown recommendation | Removed. A change shows "Manta recommends approving it." and only **Apply / Discard**. |
| "Let it guess" is unclear | Removed. The recommended option is **preselected**, so Submit sends it. One line under the options: "If no one answers, Dev goes with the recommended option, so it's fine to ignore this." A decision that has no default (retry or drop) says "Nothing happens until you choose." instead. |
| Sidebar "1 +1" badge | **One red count, decisions only.** Optional questions aren't counted. When only questions are open, a small blue dot shows instead (tooltip: "1 optional question; nothing waits on you"). Why: a number on a red badge means "you have to act", the convention people know from phone and mail apps. Adding questions to it would raise a false alarm, and showing two numbers made people work out what each one meant. |
| Top alert strip on Projects is dense | Replaced by a **card that only appears when a decision waits**: "1 decision is waiting for you", the item in plain words, and Review →. Optional questions get one calm line under it ("Dev has a question for you. Optional: work carries on either way."). When nothing waits: a single green line "Nothing needs you right now." |
| Projects tab still has too much; it should be a manager's overview | Each row is now **what** (plain-language title), **who** (agent, and who asked), and **how it's going** (a dot plus one sentence: "On track", "Stuck: no progress for a while", "Taking much longer than usual", "Having trouble, still trying", or "On track · optional question for you"). Project headers: "3 in progress · 1 stuck · 1 optional question". |

## Moved off the default rows, into Details (one click on the title)

Branch names, step bars and the checklist with time per step, "plan grew", retries, refused actions, minute counters and the time limit. Details also says **why** a row shows a warning ("Why it says 'Stuck': no activity for 9 min · last: reading the Vitest 4 release notes"), plus the technical task name where the plain title differs. Stop moved to Details too: a manager doesn't need a red button on every troubled row, and Stop still asks first.

Paused and Ended use the same plain language:
- **Paused:** title, who, project, "paused 3 h ago", Resume. When the box is full, Resume is disabled with the reason "Can't resume yet: 5 tasks are already running. It can start when one finishes."
- **Ended:** Done / Didn't finish / Interrupted / Stopped by you, then one plain outcome sentence ("Manta checked it and added it to the project.", "It ran out of time. Manta told you in Release prep."). File counts, checks and branches are in Details ("Technical record").
- "Undo merge" is now **"Undo"**: "Takes this work back out of the project. Offered for 24 hours." The dialog has the same plain wording.

## v5 decisions, revisited

1. Checklist bar: now **only in Details**; not on rows. (v5: on rows, no "N of M".)
2. "Let Manta decide": **removed** (see above).
3. Undo on Manta-merged work for 24 h: kept, renamed "Undo".
4. Ended keeps today, with "New" and "Earlier days": kept.
5. Resume disabled with its reason when full: kept, in plain words.
6. No Manta group; "asked by Manta in <chat>": kept.
7. Usual-time range only past its upper bound with 10+ runs: kept, but **only in Details**. The row says "Taking much longer than usual".
8. A failed task goes to Ended unless a decision is needed: kept.
9. Fleet count "5" with "box full" in the header: **changed**. The header says "5 in progress". "Box full" now appears only where it changes what you can do: the disabled Resume and the Paused summary ("can resume when a running task finishes").

## Defaults I chose (unsure; easy to change)

- **Red, not amber, for "Waiting on you".** In the light theme the app's warn colour is olive (#6E6200) and didn't read as urgent in the render. Red keeps three clear levels: red = you must act, amber = something's off but it isn't your move, blue = optional. Cost: red is also used for "Didn't finish" on Ended rows. If you prefer amber, it's a one-token swap, but light theme would need a warmer warn value, which is a token change.
- **Stop only in Details.** If you want Stop on stuck rows too, it fits in the action column.
- **"Open session" kept on rows** as the one way into the conversation. It's the app's established name for that action.
- **The routine tag says "Weekly"**, not "Routine", because it tells a manager more.
- **Row titles are plain rewrites** of what the agent was asked (e.g. "Upgrade the file tree in the explorer" instead of "Move the explorer tree to headless-tree v2"). This assumes Manta writes a plain title per task; Details keeps the original.

## Checks

- 216 renders (4 views × 9 states × light/dark × 420/900/1280): no script errors, no sideways scroll. Screenshots: `~/.manta/agents/product-designer/home/fleet-redesign/shots-v6/<view>-<state>-<width>-<theme>.png`.
- Interactions scripted: no "Let …" buttons left; the recommended option is preselected; Submit and Apply clear the sidebar badge; Stop asks with "Keep running" focused, then the count drops and the task appears in Ended; Undo asks, then marks the row; Resume is disabled with its reason when the box is full.
- Not checked: real fonts (Inter isn't bundled), contrast by script (tokens only; red label = `--danger` on `--canvas`), a screen reader.
