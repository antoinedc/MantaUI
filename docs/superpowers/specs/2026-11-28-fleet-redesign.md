# Fleet and Needs you redesign (mockup v10)

Status: approved design, being built. Source of truth for looks and behaviour: `docs/screens/fleet/mockup-v10.html`
(reasoning: `docs/screens/fleet/decisions-v10.md`; v10 wins over earlier rounds). This spec says how the real code gets there.
It replaces the Fleet part of `docs/superpowers/specs/2026-11-26-agents-screens.md` §2.1 (the agents × projects grid, the recap,
Needs you inside the Fleet page). Profile pages (§2.2) are untouched.

## 1. What changes for the user

- **Fleet** is a list of work, not a grid. Two views, **Projects** (default) and **Agents**, remembered per device
  (`localStorage` `manta:fleet:view`). Rows are `title | agent (Projects view) or project (Agents view) | status | Open session`,
  in aligned columns. No "asked by" on a row.
- **Statuses** are only what the box records: **In progress**, or **Paused by you** (with Resume). No Stuck, no "taking longer",
  no retrying / usage-limit pauses (`docs/agents/follow-ups.md`, "Fleet statuses that need reliable tracking first").
- **Top of Fleet:** a card "N decisions are waiting for you" (what the first one is, "Review →" to Needs you), or the calm line
  "Nothing needs you right now." Open questions are never mentioned there.
- **Ended today** (provisional, `follow-ups.md` "Fleet: iterate on Ended today"): every task that ended since local midnight on the
  box. Row: title, agent · project · when, one outcome sentence; the outcome badge (Done / Didn't finish / Interrupted / Stopped by
  you) sits in the status column; Open session on the right. No "New", no Undo, nothing is cleared by leaving the page (it is a pure
  read of today's tasks).
- **Details** (the task side panel, trimmed) opens beside the list (below 720 px it replaces the list): status, agent, project, who
  asked, now, started, branch, checklist with times, Open session, **Stop** behind a native `<dialog>` with "Keep running" focused,
  **Resume** on a task paused by you.
- **Needs you** is its own page (sidebar row), grouped under project headings. Decisions (`Waiting on you`, solid red label on its own
  line, red left edge) come first, then open questions (`Open question · keeps working`, blue, blue edge). A change shows
  "Manta recommends …" with Apply / Discard only; a question has the recommended option preselected, Submit, and "If no one answers,
  X goes with the recommended option, so it's fine to ignore this."
- **Gone everywhere:** "Branch ready to merge" items (unmerged finished branches never appear in Needs you), "Let Manta decide",
  "Let it guess", "Didn't need me", "Review branch", the recap, the agents × projects grid.
- **Sidebar:** Needs you shows one red number counting only decisions waiting on you; with only questions open, a small blue dot.
  Fleet shows the number in progress.
- **States** (all in the mockup's State switch): ideal, empty, loading (skeleton after 150 ms), load error (banner, earlier data
  kept), box unreachable (banner with the last report time, actions disabled with the reason), failed action (choice kept,
  "Submit again" / "Apply again" / "Try again"), many items (box full: Resume disabled with the reason), long-running.
- **Widths** 420 / 900 / 1280 by the list's own width (container queries on the page column and the page body), light and dark, no
  sideways scroll.

## 2. Server

### 2.1 Needs you stops listing branches (`agents:needs-you`)

`attentionOf` (src/server/agents.mjs) keeps one rule: a finished task that ended "needs a decision" (`endedBlocked`) and was not
marked done / opened. The "user's own task whose branch has not landed" rule (`isBranchCandidate`, "Branch ready to merge · N
files") is removed. `agents:fleet` (still read by the profile for each seat's current task) uses the same function, so a cell can no
longer say "Branch ready to merge" either. `NeedsYou` keeps its shape: `questions`, `changes`, `reviews` (now only `endedBlocked`
ones), `count`. Clients must not rely on the server for this: the renderer drops `reviews` with `endedBlocked !== true` too (an
older box still sends branch reviews).

Decisions that block = `changes.length + reviews.length`; open questions = `questions.length` (they never block the task).

`NeedsYou` also gains `changeProjects: { [changeId]: projectSlug | null }`: the registry project of the task that proposed each pending
change (via its origin job), so the page can put a change under a project heading. A change made in a chat has none (it is listed
under "Team"). Absent on an older box: every change reads as having no project.

Order on the page: decisions before questions, longest-waiting first inside each; project headings in the order their first item appears.

### 2.2 New read `agents:tasks` → `FleetTasks`

One read model for the Fleet page and the sidebar's Fleet count. Pure shaping in a new module `src/server/agentsFleetTasks.mjs`
(`shapeFleetTasks`, `endedOutcome`), I/O (jobs store, project names, git branch verdict, pending changes) in `agents.mjs`
(`fleetTasks()`), as `fleet()` / `needsYou()` do.

```ts
type FleetAskedBy = { by: "you" } | { by: "manta"; sessionId: string | null } | { by: "routine" };
interface FleetTask {            // newest round per task, specialist tasks only, status running or paused
  jobId: string; rootJobId: string;
  title: string;                 // job.name, as the chat's task card shows it
  agentSlug: string; project: string | null; projectName: string | null;
  status: "in-progress" | "paused-by-you";   // `paused` is only ever the user's pause (pauseJob is the single writer)
  pausedAt: number | null; startedAt: number; branch: string | null;
  askedBy: FleetAskedBy;
}
type FleetOutcome = "done" | "didnt-finish" | "interrupted" | "stopped";
interface FleetEnded {           // newest round per task, done / failed / stopped, finishedAt >= local midnight (box time), newest first, ≤ 50
  jobId: string; rootJobId: string; title: string;
  agentSlug: string; project: string | null; projectName: string | null;
  endedAt: number; startedAt: number; outcome: FleetOutcome;
  sentence: string;              // one plain sentence from recorded facts (below)
  facts: string;                 // the technical record, shown in Details ("Hit its time limit · 3 files changed · branch …")
  branch: string | null; askedBy: FleetAskedBy;
}
interface FleetTasks { asOf: number; running: FleetTask[]; ended: FleetEnded[]; cap: number; full: boolean }
```

`askedBy`: `deliverResult === false` → routine (the refresh / check-up tasks); `requestedBy === "manta"` → Manta (+ the parent chat's
session id; the renderer finds the window name); else the user. `full` = box-wide running jobs (all kinds, `countsTowardCap`) ≥ `cap`
(`MAX_RUNNING_JOBS`).

Outcome and sentence, from what the box recorded only (`endedOutcome`):

| Record | Outcome | Sentence |
|---|---|---|
| `stopped`, error "stopped by user" | stopped | "You stopped it. What it had done so far is kept." |
| `stopped`, anything else (paused over 7 days) | interrupted | "It was paused for over 7 days, so Manta stopped it." |
| `failed`, `endReason: "time-limit"` | didnt-finish | "It ran out of time." |
| `failed`, `endReason: "stalled"` | didnt-finish | "It stopped making progress." |
| `failed`, error `interrupted…` / cut off / upgrade | interrupted | "It was cut off when the box restarted." |
| `failed`, other | didnt-finish | "It hit a problem and stopped." |
| `done` + `endedBlocked` | didnt-finish | "It stopped to ask for your decision." (+ " It's in Needs you." while it still is) |
| `done`, a change it proposed is waiting | done | "It suggests a change that needs your approval." |
| `done`, branch landed | done | "Its changes are in the project." |
| `done`, branch not landed | done | "Its changes are on a branch, not in the project yet." |
| `done`, no branch work, routine | done | "It finished its scheduled work." |
| `done`, otherwise | done | "Its report is in the chat that asked." |

No new status is invented: Stuck / slow / retrying stay out. The branch verdict is the existing `branchVerdict` (cached 30 s, outside
locks; a failure is "unknown" → "It finished and changed N files.").

Hints: the delegate engine's `delegate.updated` publication also publishes `agentFleet` (src/server/index.mjs), so start, pause,
resume and stop refresh the page through the existing debounced hook; ending already did.

### 2.3 New channel `delegate:resume` (id)

`rpc.mjs` → `delegate.resumeJob(id)` (exists in the engine; no channel exposed it). Returns the engine's answer
`{ ok: true, job } | { ok: false, error, retriable? }`; a full box answers with the cap sentence and the job stays paused.
Wired in `IPC`, `Api`, `httpApi`, the demo coverage list. The Resume button shows the error under the row; nothing is silent.

### 2.4 Left alone

`agents:fleet`, `agents:fleet-seen` and the recap code stay (the profile reads `agents:fleet`; the Fleet page no longer calls
`fleet-seen` or shows the recap). Removing them is a follow-up (below).

## 3. Renderer

Under `src/renderer/agents/` (existing conventions: Tailwind classes, `manta-agents-*` hooks, `useAgentsRead`, tokens from
`tokens.css`; no new colours — `--danger`, `--accent`, `--ok`, `--warn`, `--need-edge-w` already exist).

| File | Role |
|---|---|
| `fleetView.ts` (+test) | Pure: `groupTasks(tasks, by)` (group order: any in-progress first, then paused-only; rows in-progress first), `groupSummary`, `taskStatusView`, `endedBadge`, `askedByText`, `needsCounts(data)` (decisions / questions, the `endedBlocked` filter), `needsTop(data)` (card text), `sidebarNeeds`, `questionAssumption`, `changeRecommendation`, `groupNeedsByProject`, `readBanner` (unreachable / refresh-failed / load-failed text and the last-update time). |
| `FleetPage.tsx` | Rewritten: header (title, Projects/Agents `Segmented`, counts), banner, top card / calm line, groups, Ended today, Details. |
| `FleetRows.tsx` | `TaskRow`, `EndedRow`, `Group`, `EndedSection` (native `<details>` "Show N more"). |
| `FleetDetails.tsx` | Details aside. Live checklist / now / times come from the store's job (`delegate.updated` keeps it live; `view.steps`); the server read supplies everything else. |
| `StopTaskDialog.tsx` | Native `<dialog>`, `showModal()`, "Keep running" has `autofocus`; `Esc` / backdrop = keep. |
| `NeedsYou.tsx` | Rewritten as the page body (`NeedsYouPage`): project headings, the item anatomy of the mockup; reuses `QuestionCard`, `AgentChangeView`, `BackgroundResultCard`. |
| `AgentsRoot.tsx`, `agentsView.ts`, `AgentsSection.tsx`, `Sidebar.tsx`, `App.tsx` | `AgentsView` gets `{ page: "needs" }` (the `focus` / `nonce` hack goes). The App holds the `tasks` read next to `needs` (one subscription each) and hands the sidebar `needsBadge {decisions, questionDot}` and `fleetCount` (these replace `needsYouCount`). Removed with the grid: `planUsagePercent`, `weekPill`, `recapLead`, `hasFleetRows`. |
| `useAgentsRead.ts` | Adds `refreshError` (a failed refetch that kept data) and `updatedAt` (when the data last arrived). |
| shared cards | `QuestionCard` gets optional `note` (the "If no one answers…" line between the options and Submit) and `AgentChangeView` an optional `note` ("Manta recommends …") rendered inside the card before the buttons. Nothing else about them changes. |

Behaviour rules (all from `AGENTS.md`, "NEVER STUB A CONTROL"): every button awaits its call and reports both branches
(Resume / Stop errors under the row and in Details, Apply / Discard / Submit through the existing cards' own error lines, "Open
session" through `useOpenTask`). No "Earlier days" link and no "Should have asked me" control: nothing backs them today, so they are
not rendered (they are in follow-ups). Controls that cannot work while the box is unreachable are `disabled` with a `title`
("Unavailable until the box is reachable").

- **Unreachable** = the store's `connectionState` is not `connected` / `idle`. The banner says "Can't reach your box right now. This
  is the last update, from HH:MM." with Try now (re-read); the data stays.
- **Load error** = a read that failed while connected: with data, "Couldn't refresh Fleet. Nothing was changed. Below is the last
  update, from HH:MM." + Try again; without data, the banner and an empty list.
- **Loading**: nothing for 150 ms (`useAfter`), then a skeleton.
- **Failed action**: Submit keeps the chosen option (the card owns its state and the item is not remounted by the refetch: items key
  on ids) and the button reads "Submit again" / "Apply again" after a failure. These labels live in the shared cards.
- **Many items**: groups scroll with the page; "Show N more" in Ended today is a `<details>`.

### Native elements and guides (modern-web-guidance, retrieved 2026-11-28)

| Need | Native element | Guide ids |
|---|---|---|
| Stop confirmation | `<dialog>` + `showModal()`; `aria-labelledby`; `autofocus` on the safe action; no `role="dialog"` / focus trap; `overscroll-behavior: contain` on `dialog:modal` and its backdrop; `returnValue` read in `close` and reset | `dialog`, `html` (§4 native overlays), `accessibility` (§12) |
| "Show N more", "Show the exact change" | `<details>` / `<summary>` (no JS) | `accordion`, `html` |
| Width-driven columns | `container-type: inline-size` on the page column (`col`) and on the page body (`body`); `@container` rules, safe stacked default | `size-aware-styling`, `responsive-design`, `css-layout` |
| Announcements | one polite live region for "Resumed / Stopped: …"; errors are `role="alert"`; no live region for "Loading…" | `accessibility` §8 |
| Status | text + dot (never colour alone), `aria-label` on the sidebar badge | `accessibility` |

Container queries are Baseline widely available (since 2023-02), `<dialog>` and `<details>` likewise; no fallback code is needed.

## 4. Libraries considered

| Need | Chosen | Considered, why not |
|---|---|---|
| Confirm dialog (Stop) | native `<dialog>` | `@radix-ui/react-alert-dialog` 1.2.1 (MIT, 5 deps, 54.6 M downloads/week, 19.6 k stars on radix-ui/primitives, pushed 2026-10-14): fine library, but the guide-backed native element gives focus containment, Esc and top layer for free; adding a dependency for one confirm is not justified, and the repo has no Radix. `@headlessui/react` 2.2.10 (MIT, 5 deps, 9.2 M/week, 28.9 k stars, last push 2026-04-13): same reasoning. |
| Disclosure ("Show more", "Show the exact change") | native `<details>` | Any accordion library: the platform does it. |
| Segmented Projects / Agents control | existing `Segmented` | A new one: the repo has one. |
| Width-driven layout | CSS container queries | A resize-observer hook / library: CSS does it, and the profile already uses the same pattern. |
| Grouping, sorting, counts | plain functions in `fleetView.ts` | Lodash and similar: a few `Map` loops; testing them as pure functions is the point. |
| Reads, hints, debounce | existing `useAgentsRead` | SWR / TanStack Query: the box's hint model is already wired here; replacing it is out of scope. |
| Questions, changes, results | existing `QuestionCard`, `AgentChangeView`, `BackgroundResultCard` | Rebuilding them: the brief says reuse. |
| Server shaping | plain module + `node:test` | Nothing to adopt. |

No dependency is added.

## 5. Tests

- `fleetView.test.ts`, `FleetPage.test.tsx`, `NeedsYou.test.tsx`, `StopTaskDialog` inside the page test, `useAgentsRead.test.tsx`,
  `AgentsSection` in `Sidebar.test.tsx`, `App.agents.test.tsx` (vitest, written first).
- `src/server/agentsFleetTasks.test.mjs` (outcome table, grouping inputs, midnight cut, caps) and `agentsScreens.test.mjs` (the
  branch rule is gone: `needsYou` lists no branch review, `endedBlocked` still does; `agents:tasks` through the engine), `rpc.test.mjs`
  (`delegate:resume`, `agents:tasks` channel).
- The visual gate row `agents-fleet` is repointed at the new page and the v10 mockup; baselines must be regenerated in CI
  (no browser here) — see the PR.

## 6. Follow-ups (not built)

- Decisions that ended a task (`endedBlocked`) keep the existing result card with its Done button. The mockup draws them as an option
  list with Submit; answering a finished task goes through the lead (`agent_handoff` + `continueJob`), which has no direct channel yet.
- "Should have asked me" and "Earlier days" (the mockup's links) need a signal / a history read first.
- Remove `agents:fleet-seen`, the recap and the grid fields of `agents:fleet` once the profile reads seats from its own channel.
- Stuck / slow / retrying / usage-limit statuses: `follow-ups.md`.
