# Agents — Phase 6: Agent screens

Status: draft for review (2026-11-26). Owner: Antoine. Builds on Phases 1–5A (`2026-11-22-agents-phase1.md` …
`2026-11-24-agents-phase5-builder.md`), the question tool (`2026-11-24-ask-user-tool.md`) and the research library
(`2026-11-24-research-library.md`). Absorbs the old "5B" (history + restore, the refresh routine).

Screens: `docs/screens/agents/mockup.html` (looks), `contract.md` (components, tokens, constants, states),
`conformance.md` (what differs from the mockup on purpose).

**Speed rule: smallest usable version; edge cases go to `docs/agents/follow-ups.md`.** Ship to `main`, no release tags.

## 0. Binding decisions (from the user)

1. Scope, in order: agent profile → fleet → create-an-agent as a chat task → `@` mention polish → seats as a real
   concept → history + restore in the profile → the refresh routine's proposals in Needs you.
2. Manta leads every chat and hands off by itself; it is the chief of staff. The CTO stays frozen. Reviewer agent,
   budgets, deadlines/defaults on questions and VMs are **later**.
3. **No new component where one exists.**
   - A question is OpenCode's `question` tool, shown with the existing `QuestionCard` (`Cards.tsx`). No new tool, no new
     question component. The mockup's old "agent question" restyle is a later idea.
   - Confirming an agent change at "Ask" uses the existing `AgentChangeView` (`AgentChangeCard.tsx`) buttons.
   - Undo exists in one place: the change card. History renders the same records with the same card.
4. **Questions don't block the task** (§4). No deadline, no default.
5. Autonomy settings are unchanged.
6. No agent-design opinion in any prompt or tool text (the guard test in `agents.test.mjs` stays green). The create
   view shows the Architect's own reported steps (progress_report / todo list → `jobProgress`), its fit check, its
   Outcome lines and its research basis. There is no fixed pipeline in the UI.

## 1. What the user gets

1. **Sidebar.** Two rows above the Agents section: **Needs you** (count badge) and **Fleet**. Clicking an agent row opens
   its **profile** (no longer its direct chat; the direct chat moves to a profile button). The "+" (New agent) opens a
   new-chat draft with Manta, prefilled "Create an agent that ", in the active project (§3.3).
2. **Fleet page:** Needs you first (each item is the existing card it belongs to, under a one-line context), then a
   recap since the last visit, then the agents × projects grid with this week's task counts. Header: tasks this week and
   plan usage (the existing usage reading). No dollar budgets.
3. **Agent profile:** header (name, description, facts, actions), the agent's pending change cards, then tabs
   **Overview · Research · Seats · History · Tests (later)**.
4. **Creating an agent is a task in the chat it was asked from.** Manta hands it to the Architect; the task card shows
   its progress; "Details" opens the **task side panel** (what happened, research it relied on, the brief, Close).
   Questions arrive as question cards in the same chat; the result card carries the change cards.
5. **`@` mention polish.** The picker rows show the agent's colour badge, description and a seat hint; agents seated in
   this project come first; mentioning an unseated agent seats it here (said on the task card).
6. **Seats:** an agent placed in specific projects, each with a brief and a memory scope (§5.1).
7. **History + Restore** in the profile (§5.2). **Refresh** (monthly, opt-in per agent) proposes updates that wait in
   Needs you (§5.4).

## 2. Screens (behaviour; looks are the mockup's)

### 2.1 Fleet (`agents:fleet`, `agents:needs-you`)

- **Needs you** lists, newest first:
  1. open task questions (`QuestionCard`, answered in place — §4);
  2. pending agent changes box-wide, whatever chat or routine made them (`AgentChangeView`);
  3. finished specialist tasks with changes on a branch that nobody has opened yet (`BackgroundResultCard`, built from
     the job: its "Open session →" is the existing action; a "Done" ghost button dismisses the item).

  Each item sits under one context line: agent badge + name, project, task name, age, and "still working on the rest"
  while the task runs. Count = the sum, also the sidebar badge. Empty → "Nothing needs you."
- **Recap** "Since <last visit>": server-written plain lines, no model (§6.4). "Seen" is recorded when the page is left
  (`agents:fleet-seen`), so a reload doesn't eat the recap.
- **Grid**: rows = team agents (lead and Architect excluded: they work everywhere), columns = projects that have at least
  one seat or a task in the last 7 days. A cell = the agent's latest task in that project (running first): title + state
  line (Working · N/M · 1 question / Needs you / Done · … / Failed · <first line of the error> / Idle · last task Nd ago).
  "—" = no seat. Clicking a cell with a task opens its session (`delegate:open-session`). Last column: tasks this week.
- Header pills: "All projects" (no filter in v1, a static label) and "This week: N tasks · plan usage P%" (P = the
  highest `used` percentage of the current plan windows from `usageList()`; omitted when unknown).

### 2.2 Agent profile (`agents:profile`)

- Breadcrumb `Agents / <Name>`. Header: colour badge, name, facts line (built by / last changed / model / isolation),
  description. Buttons: **Change via Manta** (new chat draft "Change @slug: "), **Chat** (the existing direct chat,
  `agents:open-chat`; hidden for the Architect, as today), **Mention in a chat** (primary: puts `@slug ` into the
  active chat's composer, or a new draft when no chat is active).
- **Pending change cards** for this agent (`AgentChangeView`, one per pending record) above the tabs.
- **Tabs** (Overview default; the tab is in the URL-less view state, not persisted):
  - **Overview:** Charter (the agent's description, use when, not for, edits code or read-only, model; instructions in
    a `<details>`), Research it relies on (first 4 of the Research tab), History (first 3 rows), Seats (list), memory
    map for the first seat, Tests "Coming later".
  - **Research · N:** library entries the agent's applied changes rest on (their `basis`), resolved live through
    `researchLibrary.lookup` in each seat's project scope: topic, sources, age, fresh / stale, thin. "From the shared
    research library. Thin means fewer than 3 independent sources." Missing entries show "no longer in the library".
  - **Seats · N:** one row per seat: project, brief (first line), notes count (knowledge pages of that project),
    current task. Row actions: **Edit brief** (inline `<textarea>`, Save / Cancel), **Remove** (`ConfirmInline`).
    "Add a seat in another project" (a `<select>` of registry projects without a seat + Add). The memory map of the
    selected seat (§5.1) below.
  - **History · N:** §5.2.
  - **Tests — later:** a disabled tab with the title "Trial runs on sample tasks come later".
- The lead and the Architect: Seats tab says "Works in every project"; no seat actions.

### 2.3 Chat & @mention

- A **running specialist task's question** appears as a `QuestionCard` in the chat that owns the task (the task's parent
  session), in the transcript tail with the session's own question cards, title "<Agent> asks you" (§4.4).
- The task card shows "· 1 question" while a question is open; its "Details" toggle opens the task side panel for agent
  tasks (other background jobs keep the inline details).
- **Picker** (`TypeaheadPopup` in `ComposerParts.tsx`, agent rows): badge in the agent's colour, name, description
  (one line, ellipsis), a right pill: "seated here" or "adds to <Project>"; sort: lead first, then seated here, then the
  rest by name; footer "Seated in this project first · ⏎ mention". The Architect stays in the list (it is reached by a
  mention like any agent; mention dispatch gives its round mode "unknown", unchanged).
- A dispatch into a project where the agent has no seat creates the seat (§5.1); the task card's request line gets
  " · added @slug to <Project>".

### 2.4 Create an agent

- **New agent** (sidebar, Fleet empty state) → `createDraft("chat")` + `updateDraft(id, {input: "Create an agent that ",
  folder: <active project's folder>})` and focus the composer. Nothing is created until the user sends; Manta writes the
  charter and hands off to @architect (Phase 5A, unchanged). The old `CreateAgentDialog` (name + description) is
  removed; `agents:create` stays for the box API.
- The Architect's task card, its questions, its result card with the change cards, and the side panel are all the
  generic pieces above. Nothing in the UI names Architect steps: the side panel shows whatever it reported.

### 2.5 Task side panel (new)

Opened by an agent task card's **Details** (run card and result card). One panel per chat, in the session's right slot
(the slot the Explorer and Artifacts share; opening it closes them and vice versa). Content, top to bottom:

- Top bar (h-11): agent badge, "<Agent> · <task name>", state text (Working · N questions / Done · 6 min / Failed),
  Close (the only action).
- **What happened:** the existing `JobDetails` (checklist, milestones, live tool, quiet time, files, usage, time left)
  for the job's view — exported from `BackgroundCards.tsx`, unchanged. The server adds two milestones itself: "Asked you:
  <question>" when a question is captured and "You answered: <answer>" when it is delivered.
- **Research it relied on:** the library entries this task found or saved (`agents:task-research`, §6.5), plus the
  `basis` of its proposals; "None yet" while empty.
- **Brief** (collapsed `<details>`): the task's request text as Manta wrote it.

The panel follows the job across rounds (`continueJob` successors: the newest record with the same root).

## 3. Not changed

Autonomy levels and their decisions; `agent_change`/`agent_propose` validation (except §4.6); the Architect's
containment; release precedence; the change card's states and buttons.

## 4. Non-blocking questions

### 4.1 What happens today

A specialist task may call OpenCode's `question` tool. `handleQuestion` (`delegate.mjs`) captures the form of a running
specialist's root session (`decisionFromForm` → `recordDecision`: `decision`, `askedUser`, modelState `blocked`),
interrupts the turn (`abortSession`) and rejects the form. The task ends `done` + `endedBlocked`, its result carries the
server-written "Question for the user" block (`decisionLines`), the lead re-asks the user with its own question tool and
sends the answer back with `agent_handoff` + `continueJob`. Asking ends the task.

**OpenCode's question tool blocks the calling turn:** the tool call waits until its form is replied to or cancelled.
That can't be changed from Manta. So "non-blocking" is built by **answering the form at once with a placeholder** and
delivering the user's real answer later as a message.

### 4.2 The new flow

1. **Capture** (`handleQuestion`, same trigger: a question form in the ROOT session of a RUNNING, Manta-owned specialist
   task):
   - Map it with `decisionFromForm` (unchanged) and store an **open task question** (§6.1) in the new question store.
   - Reply to the form (`replyQuestion`) with the **placeholder** for every field:
     > `Not answered yet: the user sees your question and can answer at any time. Keep working on everything that
     > doesn't depend on it; the answer will arrive as a new message from the user. If all remaining work depends on it,
     > finish what you can, say what is left, and end your turn.`
   - No interrupt, no `decision`, no `modelState: "blocked"`. Set `askedUser` only when the user **answers** (§4.6).
   - Add the milestone "Asked you: <first question, ≤ 120 chars>". Publish `taskQuestion`.
   - **Fallback to today's path** (interrupt + "needs a decision") when any field can't take free text
     (`custom === false`), when the reply fails, or when the task already has 3 open questions (the third limit is a
     constant, `QUESTIONS_OPEN_MAX = 3`).
2. **The question waits** in the parent chat (question card) and in Needs you. The task keeps running.
3. **Answer** (`agents:question-answer {id, answers}` → `taskQuestions.answer`):
   - Text sent to the task (server-written, never model text): `Answer from the user to your question "<question>":
     <labels and typed text, joined with ", ">` (one line per question for a multi-question form).
   - Under the delegate's per-session lock for the task's child session (`withSessionResources`), read the LIVE root's
     newest round:
     - **running**, its child session in `listActiveIds()` → `sendPrompt({sessionId: child, text, delivery: "steer",
       messageID})` with a minted, persisted message id. Delivered "steer".
     - **finished** (done, failed, stopped) → `continueJob(roundId, {prompt: text, sessionID: job.parentSessionID,
       requestedBy: "manta"})`. Delivered "continue". A refusal (cap, autonomy changed, session busy, legacy task) is
       returned to the card as its sentence and the question stays open.
     - **paused** → refused: "This task is paused; resume it first, then answer."
     - **running but not active** (between launch and the first turn, or settling) → wait 2 s once and re-read; still
       not active → treat as finished.
   - Then mark the question `answered` (answer, answeredAt, delivery), add the milestone "You answered: <short answer>",
     publish.
4. **Dismiss** (`agents:question-dismiss {id}`): mark `dismissed`; if the task is running and active, steer "The user
   dismissed your question "<question>". Decide yourself, or say what is left undecided." A finished task is left as is.

### 4.3 The round ends with a question open

- `settleV2Job` is unchanged. A task that ends while one of its questions is open ends `done` (not `endedBlocked`);
  `buildCompletionText` appends, server-written: `Waiting for the user's answer to: "<question>" (the answer will
  continue this task).` The lead brief says not to ask it again.
- **Race:** an answer steered just as the turn ends may sit unconsumed in the child session's inbox. At settle, the
  delegate reads `listInbox(child)`; any pending item whose message id is a delivered answer's is cancelled
  (`cancelInboxItem`) and the answer is re-delivered with `continueJob` (the question's delivery becomes "continue").
  A failed read is retried by the 60 s sweep; the question keeps `delivery: "steer-unconfirmed"` until resolved.
- Records whose job is gone (pruned, deleted) can still be dismissed; answering says "That task no longer exists; ask
  in a chat instead."

### 4.4 Showing it (no new component)

- `ChatPanel` merges `agentsQuestions({sessionID})` into the list it passes to the transcript tail as `QuestionRequest`s:
  `{ id: tq.id, sessionID: tq.parentSessionID, questions: tq.questions.map(q => ({ ...q, header: "<Agent> asks you" })) }`.
  `onReply` → `agentsQuestionAnswer`, `onReject` (Dismiss) → `agentsQuestionDismiss`; both awaited, a refusal shown as the
  existing send-error line (never swallowed). Freshness: subscribe to `taskQuestion` before the first read, refetch on a
  hint for this session and on `resync`.
- The option labels and "(Recommended)" suffix convention are the tool's own; the card already strips the suffix,
  badges and preselects it.

### 4.5 Instructions (process only; no design opinion)

- Specialist task footer (`delegate.mjs`, the `specialist` branch of the progress paragraph) becomes:
  "If you need the user to decide, use the question tool. It returns at once with a note that the question is waiting;
  keep working on what doesn't depend on the answer. The answer arrives later as a message from the user. Put what you
  found and what you recommend in the question itself (mark the option you recommend "(Recommended)")."
- Lead brief `MECHANICS`: the `DECISION_MARKER` line stays for the fallback path, and one line is added: "A teammate's
  question is shown to the user as a card in this chat; never ask it again or answer it. The server sends the answer to
  the task." `RESEARCH_GUIDANCE`'s last line is unchanged.

### 4.6 Interaction with the Architect's fit check

`askedUser` now means "the user answered a question in this task" (set at answer time on the newest round; inherited by
successors as today). `agent_propose` additionally refuses while the root task has an open question: "Your question to
the user is still open. Finish what doesn't depend on it; propose after the answer arrives." (Process only.)

### 4.7 Honest limits

- **The model sees a tool result that is not the answer.** A model may treat the placeholder as an answer or stop
  anyway. The wording is fixed and tested on the pinned binary with a scripted model, not with real models; a real-model
  probe is a follow-up. If it stops, the answer still arrives through `continueJob`, so nothing is lost; it only costs a
  round.
- **Steered answers arrive at the next step boundary** (OpenCode's steer semantics), not mid-tool.
- **A question raised by a subagent of a task** is still rejected (unchanged).
- **Questions pending across a server restart** were already replied to (placeholder), so nothing is lost; a capture
  whose reply never happened (crash between store and reply) leaves the form pending: the reconstruction rejects it as
  today and the stored question is marked `failed` ("The task's question was lost in a restart").
- **Fallback path** (no free-text field, 4th question, reply failure) still ends the task "needs a decision".

## 5. Data model

### 5.1 Seats

- **A seat is the file `~/.manta/agents/<slug>/seats/<project>.md`** (existing; `<project>` = the knowledge registry
  slug). An existing file stays valid unchanged: its whole text is the brief.
- **Optional frontmatter** (new; only Manta writes it): `added_at` (ISO), `added_by` (`user` | `mention` | `handoff`).
  Absent → the file's mtime and `user`.
- **Brief** = the body, ≤ 4000 chars, plain Markdown (still appended to the dispatch prompt by `seatFor`, which now
  strips the frontmatter).
- **Memory scope** is derived, not stored: what the knowledge tools give a task in that project
  (`readableProjects` / `readsCommons` in `knowledge/sharing.mjs`): this project's wiki read + write, the user wiki,
  commons if enabled, other projects only if they share. The profile shows exactly that, plus "agent know-how: read-only,
  changed through change cards" and "research library: shared, read-only except through research tools". No new
  enforcement; nothing claims a filesystem boundary.
- **Created** by `agents:seat-add` (user), or implicitly by `dispatch` / `handoff` into a project the agent has no seat in
  (empty brief, `added_by` mention / handoff). Lead and Architect never get seats.
- **Removed** by `agents:seat-remove` (the file is moved to `seats/.removed/<project>-<epoch>.md`, never deleted).
- `AgentInfo.seats: string[]` (project slugs, from a `readdir` during `scan`).
- Slug check: `/^[a-z0-9-]+$/` (as `seatFor` today); writes go through `writeFileAtomic` under the agents `syncLock`.

### 5.2 History + Restore

- **Source:** the change store (`.changes.json`, ≤ 200 records). `agents:history {slug}` = records whose `slug` is the
  agent (creates included once applied), newest first, all states, ≤ 50. One strict-free read of one file: bounded.
- **Retention change:** `undone` records are no longer pruned after 7 days; they share `applied`'s rule (kept until the
  200 cap, terminal-first eviction otherwise unchanged). Discarded / expired keep 7 days.
- **Row:** date, who (`origin.kind`: `chat` → "Manta" with "for you"; `job` → "Architect"; `restore` → "You"), the
  summary or title, the Outcome line (`describeProposalOutcome`), and actions:
  - **Details / Hide**: expands the row into `AgentChangeView` for that record (its own Apply / Discard / Undo — the only
    Undo).
  - **Restore before this** (update records that are `applied` or `undone`, only when the agent's current snapshot
    differs from the record's `before`): `agents:change-restore {id}`.
- Hand edits to `agent.md` are not in history (said under the list).

**`agents:change-restore {id}`** (agents engine, under `syncLock`):
1. `requireChangeAllowed()` (Never refuses with its sentence).
2. The source record must be `kind: "update"` with `before`; the target must resolve; snapshot ≠ `before`, else "Already
   at that version".
3. Create a record `{kind:"update", origin:{kind:"restore", fromChangeId}, before: <current snapshot>, after:
   source.before, sessionID:"", messageID:"", callID:"", reason:null, needsClick:false}` and apply it with
   `applyLocked(rec, "click")` (the user's press is the approval; a lead / Architect target applies the same way because
   the user clicked). Returns the record; its card shows Undo.
4. A restore that would change the Architect's `sources` is allowed (the user is restoring their own earlier file).

### 5.3 Fleet read model

All reads are cheap: one jobs-store read, one change-store read, the question store, `readdir` of seats, and a small
counters file.
- `~/.manta/agents/.fleet.json` (`writeJsonAtomic`, mutex): `{ version: 1, counts: { "<isoWeek>": { "<slug>": { "<project>":
  n } } }, lastSeenAt: number | null, reviewed: string[] /* job ids, ≤ 200 */ }`. `counts` keeps the current and previous
  ISO week; incremented by `dispatch` / `handoff` after a successful launch (best effort, failures logged).
- Cells come from the jobs store (`loadJobs`): specialist jobs (`specialist === true`) grouped by `agent` key → slug and
  by `registry.identify(parentDirectory)` (cached per directory for the call), newest round per root, running first.
  Retention of finished jobs (7 days / 50) bounds what a cell can show; older → "Idle".
- No opencode DB reads.

### 5.4 Refresh (the old 5B monthly refresh)

- Profile Overview: "Refresh with new research: Off | Monthly" (`Segmented`), for team agents only.
- On: `agents:refresh-set {slug, enabled}` creates (or deletes) a routine in the routines engine with
  `kind: "agent-refresh", agentSlug, cron: "0 9 1 * *"` (box-local), `rollUp: true`, `access: "read"`.
- At fire, the routines engine, instead of prompting a model in its run session, calls `agents.refresh(slug, {runId})`,
  which dispatches an Architect task (`dispatch` with the run session as parent; charter text: "Refresh @<slug>: check the
  research it rests on and propose only changes your research supports.") and records the job id on the run. The run
  completes when the task does; its report is the task's result text.
- Release: a dispatch round is mode `"unknown"`, so its proposals are always `pending` (reason `plan`) — they wait for a
  click, appear in Needs you and on the profile. Nothing applies by itself.
- `checkAgent`'s Architect refusal is untouched (this routine kind doesn't run the Architect as the routine's agent).

## 6. Contracts (committed first, before implementers start)

### 6.1 Types (`src/shared/types.ts`)

```ts
export type TaskQuestionState = "open" | "answered" | "dismissed" | "failed";
export interface TaskQuestion {
  id: string;                       // "tq_<16 hex>"
  rootJobId: string;                // the task (continuations share it)
  jobId: string;                    // the round that asked
  parentSessionID: string;          // the chat that owns the task (where the card shows)
  agentSlug: string | null; agentName: string;
  project: string | null;           // registry slug of the task's folder
  taskName: string;
  questions: { question: string; options: { label: string; description: string }[]; multiple: boolean }[];
  state: TaskQuestionState;
  askedAt: number; answeredAt: number | null;
  answer: string[][] | null;        // as the card sent it
  delivery: "steer" | "steer-unconfirmed" | "continue" | null;
  error: string | null;             // the last refusal, shown under the card
}
export interface AgentSeat {
  project: string; projectName: string; brief: string;
  addedAt: number; addedBy: "user" | "mention" | "handoff";
  notes: number | null;             // knowledge pages of that project, null when unknown
  memory: { label: string; access: "read" | "read-write" | "none"; note: string }[];
}
export interface AgentProfile {
  info: AgentInfo; seats: AgentSeat[];
  lastChangedAt: number | null; builtBy: "architect" | "manta" | "user" | "built-in";
  refresh: { enabled: boolean; routineId: string | null };
  research: { id: string; topic: string; sourceCount: number | null; ageDays: number | null; status: "fresh" | "stale" | "missing"; thin: boolean }[];
}
export interface FleetCell {
  jobId: string; title: string; at: number;
  state: "working" | "needs-you" | "done" | "failed" | "idle";
  detail: string;                   // "4/7 · 1 question", "11 issues", "Gmail token", "last task 3d ago"
}
export interface AgentFleet {
  asOf: number;
  projects: { slug: string; name: string }[];
  rows: { slug: string; name: string; color: string | null; seats: string[];
          cells: Record<string, FleetCell | null>; tasksThisWeek: number }[];
  week: { tasks: number };
  recap: { since: number | null; lines: string[] };
}
export interface NeedsYou {
  questions: TaskQuestion[];
  changes: AgentChange[];           // pending, box-wide
  reviews: { jobId: string; agentSlug: string; project: string | null; name: string; finishedAt: number;
             filesChanged: number; branch: string | null; resultText: string }[];
  count: number;
}
// AgentInfo gains: seats: string[]   (absent on an older box → [])
// AgentChangeOrigin gains: { kind: "restore"; fromChangeId: string }
```

### 6.2 RPC channels (`src/shared/api.ts` + `src/renderer/api/httpApi.ts`; server in `rpc.mjs`)

| `window.api` | channel | in → out | notes |
|---|---|---|---|
| `agentsQuestions` | `agents:questions` | `{sessionID?}` → `TaskQuestion[]` | open ones for a chat; without `sessionID`: all open |
| `agentsQuestionAnswer` | `agents:question-answer` | `{id, answers: string[][]}` → `TaskQuestion` | throws the refusal sentence |
| `agentsQuestionDismiss` | `agents:question-dismiss` | `{id}` → `TaskQuestion` | |
| `agentsNeedsYou` | `agents:needs-you` | `()` → `NeedsYou` | |
| `agentsReviewDone` | `agents:review-done` | `{jobId}` → `{ok:true}` | adds to `reviewed` |
| `agentsFleet` | `agents:fleet` | `()` → `AgentFleet` | |
| `agentsFleetSeen` | `agents:fleet-seen` | `()` → `{ok:true}` | sets `lastSeenAt` |
| `agentsProfile` | `agents:profile` | `{slug}` → `AgentProfile` | |
| `agentsHistory` | `agents:history` | `{slug}` → `AgentChange[]` | ≤ 50, newest first |
| `agentsChangeRestore` | `agents:change-restore` | `{id}` → `AgentChange` | applied or refused (throws) |
| `agentsSeatAdd` | `agents:seat-add` | `{slug, project, brief?}` → `AgentSeat` | |
| `agentsSeatSet` | `agents:seat-set` | `{slug, project, brief}` → `AgentSeat` | |
| `agentsSeatRemove` | `agents:seat-remove` | `{slug, project}` → `{ok:true}` | |
| `agentsRefreshSet` | `agents:refresh-set` | `{slug, enabled}` → `AgentProfile["refresh"]` | team agents only |
| `agentsTaskResearch` | `agents:task-research` | `{jobId}` → `AgentProfile["research"]` | library entries found/saved by the task + its proposals' basis |
| `agentsProjects` | `agents:projects` | `()` → `{slug, name}[]` | registry projects, for "Add a seat" |

Errors follow the existing `agents:*` style: an `AgentError` sentence thrown → the renderer shows it (class-1 safe
literals for anything unexpected).

**Bus kinds** (on `/events`): `taskQuestion` `{id, parentSessionID, rootJobId, state}`; `agentFleet` `{}` (a hint: jobs,
changes, seats or questions changed; the Fleet page refetches, debounced 1 s). `agentChange` is unchanged.

### 6.3 Server interfaces between the two server implementers

`src/server/taskQuestions.mjs` (S1) exports `createTaskQuestions({ fs, now, publish, delegate, oc, root })` →
`{ capture(form, job), answer(id, answers), dismiss(id), listOpen({ sessionID }), openCountFor(rootJobId),
hasOpen(rootJobId), onRoundSettled(job), sweep() }`. Store: `~/.manta/agents/.questions.json` (`{version:1,
questions:[]}`, `writeJsonAtomic` + mutex; strict read for mutations; open questions never evicted; others kept 7 days,
cap 300). `delegate.mjs` (S1) exports `deliverToTask(rootJobId, text, { messageID })` →
`{ delivery: "steer" | "continue" } | { error }`.

The agents engine (S2) receives `taskQuestions` as a dependency and uses only `hasOpen` (for §4.6), `listOpen`
(Needs you) and `answer`/`dismiss` (rpc pass-through).

### 6.4 Recap lines (pure, `fleetRecap(jobs, changes, since)` in `agents.mjs`)

Counted since `lastSeenAt` (or the last 24 h when never seen), at most 6 lines, fixed templates only:
"Manta handed N requests to agents", "<Agent> finished N task(s) in <Project>", "<Agent> failed N task(s)",
"<Agent> was changed (your setting: <level>)" / "… is waiting for your click", "N questions answered". No model call.

### 6.5 Task research (S2, `researchLibrary.mjs`)

`find` and `save` record, per bound task (`rootJobId` from the binding), the entry ids returned (top 5) and saved, in
`~/.manta/research-library/used/<rootJobId>.json` (≤ 50 ids, atomic write, swept with entries older than 30 days).
`agents:task-research` resolves them with `lookup` in the task's project scope, then appends its proposals' `basis`.

## 7. Security

- Answers are user text delivered to the task as a user message (steer or continuation); nothing else crosses. Question
  text is model text: shown as plain text by `QuestionCard` (already), never as Markdown links or HTML.
- Only the owning box's authenticated clients can answer (all `/rpc` is behind the box token). An answer is applied once:
  the store transition `open → answered` happens under its mutex before delivery is attempted; a second press gets the
  record back unchanged. Delivery and the state write share the per-session lock with the settle path.
- Seat writes: slug and project validated (`SLUG_RE`, registry slug pattern), paths built with `join` under the agent's
  real folder (`resolveTarget`), `lstat` refuses symlinked `seats/` or seat files, atomic writes, size cap.
- Restore writes only through the existing apply path (snapshot check, journal, activation, rollback).
- Fleet / Needs-you reads expose only what the sidebar already shows (job names, agent names, change records).
- The placeholder and every server-written line are constants; no model text is ever inserted into an instruction.

## 8. Libraries considered

UI guides consulted (modern-web-guidance, telemetry off): `tabs`, `responsive-table`, `breadcrumbs`,
`defer-rendering-heavy-content`, plus `html` (`<details>`) and `accessibility`.

| Need | Chosen | Considered / why not |
|---|---|---|
| Asking the user from a task | OpenCode's `question` tool + the existing `QuestionCard` | a custom tool or card (rejected by the user; duplicates the platform) |
| Delivering an answer to a running task | OpenCode V2 `delivery: "steer"` (already used for busy sends) | aborting the turn (today's path: loses the work in flight) |
| Profile tabs | hand-written `role="tablist"` buttons + `role="tabpanel"` with `hidden` (the `tabs` guide; same markup family as `ArtifactsPanel` / `Settings`) | `focusgroup` (guide's preference) is Limited availability — Chromium 150; Electron 31 ships Chromium 126; `@microsoft/focusgroup-polyfill` 1.6.0 (MIT, 0 deps, 2026-07-30, ~31k/week): a dependency for 4 tabs whose arrow-key handler is ~15 lines; `@radix-ui/react-tabs` 1.2.1 (MIT, 8 deps, ~81M/week) and `react-aria-components` 1.22.1 (Apache-2.0, ~9.2M/week): a component library for one tab strip |
| Fleet grid | native `<table>` (`responsive-table` guide: `<th scope>`, sticky row header, wrapper `role="region"` + `tabindex=0`) | `@tanstack/react-table` 9.3.1 (MIT, ~38M/week): sorting/filtering we don't need for ≤ 20 × 10 cells; `ag-grid-react` 36.3.0: far too heavy |
| Task side panel | the existing right slot (`setRightPanel`, fixed-width sibling like `ArtifactsPanel`) | `vaul` 1.1.2 (MIT, last release 2024-12): a drawer for mobile overlays, not an in-layout panel; a `<dialog>`: the panel is not modal |
| Long lists (history ≤ 50, needs-you, fleet rows) | plain lists; `content-visibility: auto` on history rows (`defer-rendering-heavy-content`) | `react-virtuoso` 4.18 (already a dependency) / `@tanstack/react-virtual` 3.14: virtualization isn't worth it under ~100 rows |
| Collapsibles (brief, instructions, evidence) | native `<details>` | accordion libraries |
| Breadcrumb `Agents / SEO` | `<nav aria-label="Breadcrumbs"><ol>` (`breadcrumbs` guide) | — |
| Relative ages ("3d ago") | the existing `relativeAgo` (`jobProgress.ts`) / `clock.ts` | `date-fns` 4.4.0 (MIT, ~125M/week): not needed for one formatter that exists |
| Seat files | the existing frontmatter reader (`splitFrontmatter` in `agents.mjs`) | `gray-matter`: a second YAML front-matter parser |
| Stores (questions, fleet counters) | JSON + `writeJsonAtomic` + `createMutex` (as the change store) | SQLite: one more store format for a few hundred records |
| Recap | fixed templates (pure function) | a model summary: cost + non-determinism for a 6-line list |

Rows where we write our own code: the tab key handler (~15 lines; the polyfill/library alternatives above are heavier than
the code), the recap templates (domain text), the stores (existing pattern).

## 9. Tests (targeted while fixing; the full check once at the end — this box has no Freestyle budget for this phase,
run the full suite on the CI `typecheck-test` job)

- **`taskQuestions.test.mjs`** (new): capture stores + replies with the placeholder (fake `replyQuestion`); fallback on
  `custom:false`, on a reply failure, on the 4th open question; answer → steer when running+active, → `continueJob` when
  finished, refused when paused, sentence returned on a `continueJob` refusal (question stays open); double answer;
  dismiss running vs finished; settle with an unconsumed steered answer → cancelled + continued; store strict-read
  refusal; open questions never evicted.
- **`delegateV2Jobs.test.mjs`**: `handleQuestion` no longer interrupts on the new path; a task ending with an open
  question is `done` (not `endedBlocked`) and its completion text carries the waiting line; the fallback path unchanged.
- **`taskDecision.test.mjs`**: answer-text formatting (single, multi, typed text).
- **e2e `scripts/opencode-v2/question-capture.e2e.mjs`** (pinned binary, scripted model): the model's question tool call
  returns the placeholder, the turn continues (a second tool call happens), a steered answer arrives in the same run
  (a user message with the answer text appears before the turn ends), and a finished task is continued by an answer.
- **`agents.test.mjs`**: seats (legacy file reads as brief; frontmatter round-trip; implicit seat on dispatch/handoff;
  remove moves the file; symlink refused); history (filter, order, cap, `undone` retention); restore (applies with
  `click`, refuses at Never, refuses "already at that version", undo of a restore); fleet (cells from fake jobs, counters,
  week roll-over, recap templates); needs-you (pending box-wide, reviews minus `reviewed`); `agent_propose` refused with an
  open question; `askedUser` set at answer time; the guard test still passes with the new lead / footer text.
- **`researchLibrary.test.mjs`**: used-ids recorded per root, capped, swept.
- **`routines.test.mjs`**: an `agent-refresh` routine dispatches the Architect via `agents.refresh` and never prompts the
  run session; its proposals are `pending` (`plan`).
- **Renderer**: question merge in ChatPanel (reply / dismiss / refusal shown); Fleet page (needs-you groups, empty state,
  grid cells, click opens the session); profile tabs (keyboard: arrows, Home/End; `aria-selected`; hidden panels);
  history row expand renders `AgentChangeView`; restore button visibility; seats edit/remove/add; side panel open/close
  and right-slot exclusivity; picker sort + pills; New agent creates a prefilled draft. Visual registry rows for Fleet,
  profile and the side panel against the mockup.

## 10. Implementation split (by file ownership; nobody edits another's paths)

**Committed first by the lead:** this spec, the screen docs, §6.1 types in `src/shared/types.ts`, the §6.2 `Api` members
in `src/shared/api.ts` (signatures only) and channel names.

- **S1 — server, questions** (Sonnet 5.5): `src/server/taskQuestions.mjs` (+test, new), `src/server/delegate.mjs`
  (capture, `deliverToTask`, footer text, completion line, settle inbox check) + `delegateV2Jobs.test.mjs`,
  `src/server/taskDecision.mjs` (+test), `scripts/opencode-v2/question-capture.e2e.mjs`.
- **S2 — server, agents** (Sonnet 5.5): `src/server/agents.mjs` (seats, history, restore, fleet, needs-you, recap,
  refresh, lead brief, §4.6) + `agents*.test.mjs`, `src/server/researchLibrary.mjs` (+test), `src/server/routines.mjs`
  (+test), `src/server/rpc.mjs` and `src/server/index.mjs` (ALL wiring, including the question channels and bus kinds,
  against §6.3), `docs/opencode-plugins-v2/**` only if a tool text changes (none planned).
- **R1 — renderer, pages** (Sonnet 5.5): `src/renderer/agents/**` (new: `FleetPage.tsx`, `NeedsYou.tsx`,
  `AgentProfile.tsx`, `AgentHistory.tsx`, `AgentSeats.tsx`, `agentsView.ts` + tests), `src/renderer/AgentsSection.tsx`,
  `src/renderer/Sidebar.tsx`, `src/renderer/App.tsx` (page routing like `routinesView`, sidebar rows, and mounting R2's
  `TaskSidePanel` exactly like `ArtifactsPanel`).
- **R2 — renderer, chat** (Sonnet 5.5): `src/renderer/ChatPanel.tsx` (question merge), `src/renderer/BackgroundCards.tsx`
  (export `JobDetails`, "· N questions", Details → side panel for agent tasks), `src/renderer/TaskSidePanel.tsx` (new),
  `src/renderer/explorer/explorerStore.ts` (`RightPanel` gains `"task"` + the job id), `src/renderer/ComposerParts.tsx` and
  `src/renderer/agentDispatch.ts` (picker), `src/renderer/api/httpApi.ts` (all §6.2 methods + `onTaskQuestion` /
  `onAgentFleet`), `src/renderer/newAgentDraft.ts` (new: `openNewAgentDraft()` / `openChangeAgentDraft(slug)`, used by R1).

Seams: R1 imports `openNewAgentDraft` and `TaskSidePanel` from R2's files by the names above; R2 imports nothing from R1.
S2 wires S1's module by §6.3. Every implementer follows `modern-web-guidance` for UI (R1, R2), the no-stub rule (every
control reports its outcome), and runs targeted tests while iterating.

## 11. Later

Restyling the question card and the change card to the earlier mockup look; built-in agent updates (template vs
installed with user edits — needs a three-way merge); Tests tab (trial runs); a Reviewer agent; budgets; question
deadlines/defaults; VMs; Fleet filters ("All projects" is static); multi-project seats; per-seat model/permission
overrides; a library browser; a real-model probe of the placeholder wording; Needs-you push notifications per item;
showing hand edits in History (needs file watching).
