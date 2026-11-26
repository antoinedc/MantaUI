# Agents — Phase 6: Agent screens

Status: draft, self-reviewed (2026-11-26; the requested OpenAI review could not run — every OpenAI model on the box
answered "usage limit reached"; see §12). Owner: Antoine. Builds on Phases 1–5A (`2026-11-22-agents-phase1.md` …
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
7. **History + Restore** in the profile (§5.2). **Refresh** (monthly, ON by default for every team agent, can be turned off per agent) proposes updates that wait in
   Needs you (§5.4).

## 2. Screens (behaviour; looks are the mockup's)

### 2.1 Fleet (`agents:fleet`, `agents:needs-you`)

- **Needs you** lists, newest first:
  1. open task questions (`QuestionCard`, answered in place — §4);
  2. pending agent changes box-wide, whatever chat or routine made them (`AgentChangeView`);
  3. finished specialist tasks with changes on a branch that nobody has opened yet (`BackgroundResultCard`, fed a
     `BackgroundResultPart` built from the review item by a pure `reviewPart()` in `agents/agentsView.ts`; its "Open
     session →" is the existing action; a "Done" ghost button in the context line dismisses the item).

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
  `agents:open-chat`; hidden for the Architect, as today), **Mention in a chat** (primary: a new chat draft prefilled
  `@slug ` in the agent's first seat's project, else the active project; no reach into an open chat's composer).
- **Pending change cards** for this agent (`AgentChangeView`, one per pending record) above the tabs.
- **Tabs** (Overview default; the tab is in the URL-less view state, not persisted):
  - **Overview:** Charter (the agent's description, use when, not for, edits code or read-only, model; instructions in
    a `<details>`), Research it relies on (first 4 of the Research tab), History (first 3 rows), Seats (list), memory
    map for the first seat, "Refresh with new research: Monthly | Off" (§5.4; Monthly by default; not shown for the lead
    or the Architect), Tests "Coming later".
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
  (one line, ellipsis), a right pill: "seated here" or "adds to <Project>" for specialists, and **no pill** for the lead
  and the Architect (they have no seats, §5.1); sort: lead first, then seated here, then the rest by name; footer "Seated
  in this project first · ⏎ mention". The Architect stays in the list (it is reached by a mention like any agent; mention
  dispatch gives its round mode "unknown", unchanged).
- A dispatch into a project where the agent has no seat creates the seat (§5.1) and stamps the job with
  `seatAdded: { project, projectName }` (§6.1). `RunCard` shows it as its own line under the request, outside the
  quotes: "Added @slug to <Project>". The request text is never modified.
- The open-question count on the run card comes from `ChatPanel`'s own `agentsQuestions({sessionID})` state, passed to
  `BackgroundRunCards` as `openQuestionsByJob: ReadonlyMap<string /* rootJobId */, number>` (both files are R2's); the card
  shows "· N question(s)" when its job's `rootJobId` has a count > 0. No server view change.

### 2.4 Create an agent

- **New agent** (sidebar, Fleet empty state) → `createDraft("chat")` + `updateDraft(id, {input: "Create an agent that ",
  folder: <active project's folder>})` and focus the composer. Nothing is created until the user sends; Manta writes the
  charter and hands off to @architect (Phase 5A, unchanged). The old `CreateAgentDialog` (name + description) is
  removed; `agents:create` stays for the box API.
- The Architect's task card, its questions, its result card with the change cards, and the side panel are all the
  generic pieces above. Nothing in the UI names Architect steps: the side panel shows whatever it reported.

### 2.5 Task side panel (new)

Opened by an agent task card's **Details**: the run card's existing Details toggle (agent tasks only) and a new
**Details** text button on `BackgroundResultCard`, shown only when `part.agent` starts with `agent-` and a job id is known.
Both call `openTaskPanel(sessionId, jobId)` (§6.6). One panel per chat, in the session's right slot (the slot the
Explorer and Artifacts share; opening it closes them and vice versa). Content, top to bottom:

- Top bar (h-11): agent badge, "<Agent> · <task name>", state text (Working · N questions / Done · 6 min / Failed),
  Close (the only action).
- **What happened:** the existing `JobDetails` (checklist, milestones, live tool, quiet time, files, usage, time left)
  for the job's view — exported from `BackgroundCards.tsx`, unchanged. The server adds two milestones itself: "Asked you:
  <question>" when a question is captured and "You answered: <answer>" when it is delivered.
- **Research it relied on:** the library entries this task found or saved (`agents:task-research`, §6.5), plus the
  `basis` of its proposals; "None yet" while empty.
- **Brief** (collapsed `<details>`): the task's request text as Manta wrote it.

The panel follows the job across rounds: it resolves the newest record with the same `rootJobId` (§6.1).

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
   - Check the RAW form first with the new pure `acceptsFreeText(form)` (`taskDecision.mjs`, S1): true only when
     `form.fields` is a non-empty array and every field has `custom !== false` (the same flag `questionFromForm` reads,
     `opencodeV2.mjs`). False → the fallback below. Then map it with `decisionFromForm` (unchanged) and store an **open
     task question** (§6.1) in the new question store.
   - Reply to the form (`replyQuestion`) with the **placeholder** for every field:
     > `Not answered yet: the user sees your question and can answer at any time. Keep working on everything that
     > doesn't depend on it; the answer will arrive as a new message from the user. If all remaining work depends on it,
     > finish what you can, say what is left, and end your turn.`
   - No interrupt, no `decision`, no `modelState: "blocked"`. Set `askedUser` only when the user **answers** (§4.6).
   - Add the milestone "Asked you: <first question, ≤ 120 chars>". Publish `taskQuestion`.
   - **Fallback to today's path** (`recordDecision` + interrupt + reject: "needs a decision") when
     `acceptsFreeText(form)` is false, when the reply fails (the stored question is then deleted, not left open), or when
     the task already has `QUESTIONS_OPEN_MAX = 3` open questions.
2. **The question waits** in the parent chat (question card) and in Needs you. The task keeps running.
3. **Answer** (`agents:question-answer {id, answers}` → `taskQuestions.answer`), in three steps (§4.8 has the lock
   rules):
   1. **Claim** (question-store mutex, no I/O): the question must be `open` and have no `delivering`; else return it
      unchanged ("Already sending your answer" when `delivering` is set). Persist `delivering: { messageID, at }` (a
      minted `msg_…` id) and the answer. Release the mutex.
   2. **Deliver** (`deliverToTask(rootJobId, text, { messageID })`, delegate). It first sets `askedUser: true` on the
      newest round (jobs lock), so a continuation inherits it. Then, under `withSessionResources(child)`, it reads the LIVE
      newest round with that `rootJobId` and decides; it steers under that lock, but for the continue branch it RELEASES
      the lock first and then calls `continueJob` (which takes `withSessionResources(child)` itself and re-checks
      everything; the lock is not re-entrant, so it is never nested):
      - `running`, not `ending` (§4.3), child in `listActiveIds()` → `sendPrompt({ sessionId: child, text,
        delivery: "steer", messageID })` → `{ delivery: "steer" }`.
      - `running` but `ending`, or not active after one 2 s re-read → `{ delivery: "continue-pending" }` (sent by
        `onRoundSettled`, §4.3).
      - finished (done / failed / stopped) → `continueJob(roundId, { prompt: text, sessionID: job.parentSessionID,
        requestedBy: "manta" })` → `{ delivery: "continue" }`, or its refusal → `{ error }`.
      - `paused` → `{ error: "This task is paused; resume it first, then answer." }`; gone → `{ error: "That task no
        longer exists; ask in a chat instead." }`.
   3. **Record** (question-store mutex, no I/O): success → `answered` (answeredAt, delivery), clear `delivering`, add the
      milestone "You answered: <short answer>", publish. (`askedUser` was set in step 2.) `{ error }` → the question STAYS `open`
      with `error` set and `delivering` cleared; the RPC throws the sentence.
   - Text sent to the task (server-written, never model text): `Answer from the user to your question "<question>":
     <labels and typed text, joined with ", ">` (one line per question for a multi-question form).
   - **Crash between claim and record:** the boot pass and the 60 s sweep look at questions with `delivering`: if the
     child session holds a message with that id (`getMessage`) → `answered` (`steer`); a newer round created with that
     prompt message id → `answered` (`continue`); else clear `delivering` (still `open`; the user can press again).
4. **Dismiss** (`agents:question-dismiss {id}`): mark `dismissed`; if the task is running and active, steer "The user
   dismissed your question "<question>". Decide yourself, or say what is left undecided." A finished task is left as is.

### 4.3 The round ends with a question open

- A task that ends while one of its questions is open ends `done` (not `endedBlocked`); `buildCompletionText` appends,
  server-written: `Waiting for the user's answer to: "<question>" (the answer will continue this task).` The lead brief
  says not to ask it again.
- **Ending gate (closes the steer race).** When `settleV2Job` has decided a round is terminal, BEFORE `finishV2Job`:
  1. under `withSessionResources(child)`: patch the record `ending: true` (jobs lock), then `listInbox(child)`; every
     pending item that is one of our steered answers (matched by message id when the item carries one, else by exact
     text — S1 checks which on the pinned binary in the e2e first) is cancelled with `cancelInboxItem`, and its question
     becomes `delivery: "continue-pending"`. Release the lock.
     Step 1 also sets `continueAfter: true` on the record (same jobs-lock patch) when the root has any
     `continue-pending` answer at that moment (from this inbox check, or from `deliverToTask` having returned
     `continue-pending` while the round was `ending`).
  2. `finishV2Job`, in this exact order (it takes `withSessionResources` only in its own cleanup, after step 1 released
     it: no nesting):
     a. **Terminal write** (jobs lock). `completionDelivery` = `null` when not Manta-owned; else `"not-needed"` when the
        record has `deliverResult: false` (§5.4); else **`"deferred"`** when the LIVE record has `continueAfter`; else
        `"pending"` (today). `"deferred"` is a new value: the result-retry sweep (`completionDelivery === "pending"`) and
        `continueRefusal`'s 409 ("its result is still being delivered") both ignore it, so `continueJob` is not refused.
     b. `onJobTerminal` (unchanged), then `notifyJobEnded` (unchanged, `agents.reconcile` for Architect jobs), then the
        new `afterJobEnded` hook (§5.4), then `clearProgress` (unchanged).
     c. **If `"deferred"`:** `await taskQuestions.onRoundSettled(updated)` — it sends every `continue-pending` answer of
        that root with ONE `continueJob` (answers joined into one prompt) and records the outcome as in step 3 of §4.2.
        - `continueJob` ok → patch this round `completionDelivery: "not-needed"` (`onlyIf` still `"deferred"`). Its
          result is never posted (the successor's result is the one the chat gets) and `finishV2Cleanup` is **skipped**:
          the window and worktree belong to the successor (same child session / worktree).
        - `continueJob` refused or threw → the answers' questions go back to `open` with the sentence as `error`, patch
          `completionDelivery: "pending"` (`onlyIf` `"deferred"`), then fall through to d.
     d. `if (completionDelivery === "pending") deliverJobResult(...)`, then `finishV2Cleanup` — exactly today's tail.
  - **Crash / restart:** a terminal record left at `"deferred"` (crash inside c) is picked up by the 60 s sweep and the
    boot pass, which run c and d for it. An inbox read that fails in step 1 leaves `ending` set and the questions as they
    are; the sweep retries step 1 for terminal `ending` rounds with `continue-pending` / `delivering` questions.
  - `deliverToTask` never steers into a round marked `ending`; while `ending` is set it returns `continue-pending` and
    sets `continueAfter` on the round (jobs lock), so step 2a sees it.
- **Held proposals never release while a question is open.** `decideRelease` (`agents.mjs`) rule 4 gains
  `|| taskQuestions.hasOpen(rootJobOf(job))` (open, `delivering` or `continue-pending` all count) → `pending`,
  reason `"unfinished"`. The click then decides; nothing auto-applies under a pending question.
- Records whose job is gone (pruned, deleted) can still be dismissed; answering says "That task no longer exists; ask
  in a chat instead."

### 4.4 Showing it (no new component)

- `ChatPanel` merges `agentsQuestions({sessionID})` into the list it passes to the transcript tail as `QuestionRequest`s:
  `{ id: tq.id, sessionID: tq.parentSessionID, questions: tq.questions.map(q => ({ ...q, header: "<Agent> asks you" })) }`.
  `onReply` / `onReject` are routed by id prefix: `tq_…` → `agentsQuestionAnswer` / `agentsQuestionDismiss`; anything
  else → the existing `opencodeQuestionReply` / `opencodeQuestionReject`, unchanged. `QuestionCard` stays unchanged and
  synchronous: `ChatPanel` awaits the call itself, keeps the card mounted, and shows a refusal with the existing
  send-error line (`setSendError`), never swallowed. The card disappears when the `taskQuestion` hint refetch no longer
  lists it. The parent chat's Stop / busy-send `rejectPendingQuestions` only sees the session's own questions
  (`questionsRef` in `useSseBus.ts`), so it never dismisses a task question — intended.
- In Needs you (R1), the same routing; a refusal shows as a `role="alert"` line in the item's context row (the
  `NeedsYou` wrapper is new, so it may carry it). Freshness: subscribe to `taskQuestion` before the first read, refetch on a
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

Owners: S1 sets the mark (delegate record patch, on the finished record BEFORE `continueJob` so the successor inherits it
through `inherited`, or with `mutateJobProgress` on a running round); S2 adds the refusal in `agent_propose` through
`taskQuestions.hasOpen(rootJobId)`.

`askedUser` now means "the user answered a question in this task" (set at answer time on the newest round; inherited by
successors as today). `agent_propose` additionally refuses while the root task has an open question: "Your question to
the user is still open. Finish what doesn't depend on it; propose after the answer arrives." (Process only.)

### 4.7 Lock discipline (one order, no I/O under the store mutex)

- Lock order, outermost first: `withSessionResources(child)` (delegate) → `jobsLock` (delegate) → question-store mutex.
  Nothing acquires them in another order, and `withSessionResources(child)` is never re-entered (`continueJob`,
  `finishV2Job`'s cleanup and the ending gate each take it on their own, never inside each other).
- The question-store mutex guards only reads and writes of `.questions.json`: never a network call (`sendPrompt`,
  `continueJob`, `listInbox`, `replyQuestion`) under it.
- `taskQuestions.capture` runs from the pump (`handleQuestion`): it writes the question (mutex), then replies to the
  form (no lock), then writes the outcome (mutex).
- A refusal at any step leaves the question `open` with `error` set; nothing is marked answered before delivery
  succeeded.

### 4.8 Honest limits

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
- **Notes count** (`AgentSeat.notes`): `createAgentsEngine` gains an optional dependency `countProjectPages(projectSlug)
  → Promise<number | null>`, wired in `index.mjs` to the knowledge engine's page listing for that project's area
  (`pages.mjs` area of the project; a count only, no page text). Absent, throwing or slower than 500 ms → `null` ("—").
- Slug check: `/^[a-z0-9-]+$/` (as `seatFor` today); writes go through `writeFileAtomic` under the agents `syncLock`.

### 5.2 History + Restore

- **Source:** the change store (`.changes.json`, ≤ 200 records). `agents:history {slug}` = records whose `slug` is the
  agent (creates included once applied), newest first, all states, ≤ 50. One strict-free read of one file: bounded.
- **Retention change** (`pruneChanges`, exact):
  - **Age prune** (older than `CHANGE_KEEP_MS` = 7 days since `decidedAt ?? createdAt`): `discarded`, `expired`,
    `conflict` only. `undone` leaves that set (`TERMINAL_STATES` is split: `AGE_PRUNED = {discarded, expired,
    conflict}`); `applied`, `undone`, `pending`, `failed` are never age-pruned (as today for the last three).
  - **Cap eviction** (`CHANGE_MAX` = 200), lowest rank first, oldest first within a rank, never a journal record
    (`isJournal`: `held`, `applying`, claimed `failed`): rank 0 = `discarded` / `expired` / `conflict` / unclaimed
    `failed`; 1 = `undone`; 2 = `applied`; 3 = `pending`.
- **Undone entries are listed** with their change card's "Undone" chip (`agentChangeChip`) and the row's outcome line
  "Undone" (plus who undid it when known: `decidedBy`), so the list shows the change and its reversal.
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
4. **Re-validate the file before writing** (it is old data): `parseAgentMd(source.before)` must parse (refused: "That
   version can't be read any more"); for the Architect, its `sources` must pass the §4.3a source validation and
   `checkSourceCredentials` (fail-closed, as `planChange`); YAML aliases are refused for the whole file, as today.
   A restore may change the Architect's `sources` only after those checks (the user is restoring their own earlier file).
   Steps 1–4 run under `syncLock` before the record is created; a refusal creates no record.

### 5.3 Fleet read model

All reads are cheap: one jobs-store read, one change-store read, the question store, `readdir` of seats, and a small
counters file.
- `~/.manta/agents/.fleet.json` (`writeJsonAtomic`, mutex): `{ version: 1, counts: { "<isoWeek>": { "<slug>": { "<project>":
  n } } }, lastSeenAt: number | null, reviewed: string[] /* job ids, ≤ 200 */, refresh: { "<slug>": "<routineId>" } /* §5.4 */ }`. `counts` keeps the current and previous
  ISO week; incremented by `dispatch` / `handoff` after a successful launch (best effort, failures logged).
- Cells come from the jobs store (`loadJobs`): specialist jobs (`specialist === true`) grouped by `agent` key → slug and
  by `registry.identify(parentDirectory)` (cached per directory for the call), newest round per root, running first.
  Retention of finished jobs (7 days / 50) bounds what a cell can show; older → "Idle".
- No opencode DB reads.

### 5.4 Refresh (the old 5B monthly refresh) — ON by default

- **Default: ON, monthly, for every team agent** (valid, not the lead, not the Architect). Built-in and user-made agents
  alike, including agents that exist when this ships and agents created later.
- **Provisioning (agents engine, idempotent):** after every `sync` (boot included), each team agent with no entry in
  `.fleet.json` `refresh: { "<slug>": "<routineId>" }` gets one routine in the routines engine:
  `{ kind: "agent-refresh", agentSlug, name: "Refresh @<slug>", cron: "0 9 <day> * *", enabled: true, rollUp: true,
  access: "read" }`, where `<day>` = 1 + (sha256(slug) mod 28), so agents don't all refresh on the same day (the 5-task
  cap). The routine id is recorded in the same save. An agent that already has an entry is never provisioned again.
- **Off per agent:** the routine's own `enabled` flag IS the setting. Profile Overview: "Refresh with new research:
  Monthly | Off" (`Segmented`, Monthly selected by default) → `agents:refresh-set {slug, enabled}` →
  `routines.update(routineId, { enabled })`. Disabling or deleting it on the Routines page counts as Off too: a missing
  routine for a recorded slug reads as Off and is NOT recreated (`agents:refresh-set {enabled:true}` recreates it and
  records the new id).
- **Agent deleted / invalid / became lead or Architect:** its refresh routine is deleted and its entry removed by the
  same reconcile.
- **The routine record** (`routines.mjs`, S2): `cleanInput` accepts `kind: "prompt" | "agent-refresh"` (absent =
  `"prompt"`, unchanged validation). For `"agent-refresh"`: `agentSlug` must be a team agent (`agents.find`, valid, not
  lead / Architect); `prompt` is set by the engine to the fixed charter (never user text); `directory` = the agent's
  `~/.manta/agents/<slug>/home` (exists: `installBuiltIns` / create make it; `isDirectory` still checked); `agent` stays
  null. Only the agents engine creates them (`routines.createInternal`); the `routine_create` tool and the editor refuse
  `kind`; the editor allows only `enabled` and `cron` on them; deleting is allowed (= Off).
- **The run** (`startRun`, branch on `kind`): reserve and create the headless run session exactly as today
  (`oc.createSession` in `directory`, internal marker, `metadata.manta.routineId/runId`), but send **no prompt**. Then call
  `agents.refresh(slug, { runId, runSessionId })`.
- **`agents.refresh`** does not use the user-facing `dispatch` (which needs an open chat and a tmux owner). It calls
  `delegate.startJob` with the same prompt-building as dispatch (`buildDispatchPrompt` + research guidance + Architect
  context), `parentSessionID: runSessionId`, `parentDirectory: <agent home>`, `targetProject: AGENTS_TMUX_SESSION` (the
  hidden `manta-agents` tmux session; created if missing with the same helper `openChat` uses), `architect: { mode:
  "unknown" }`, `deliverResult: false` (new `startJob` input, S1). It is **persisted on the record** as
  `deliverResult: false`, **inherited** by `continueJob` and resume (it is not in the stripped-field list, and S1 adds
  it to resume's copied fields), and **respected at every terminal write**: `finishV2Job` (step 2a of §4.3) and `stopJob`
  both compute `completionDelivery = !manta ? null : job.deliverResult === false ? "not-needed" : …`, and `stopJob`
  only calls `deliverJobResult` when that is `"pending"`. So N7 never posts into the headless session and no model turn
  runs there. Returns the job id, stored on the run
  (`run.jobId`, persisted under the routines lock).
- **Settling the run from the task — one hook, every terminal path.** The delegate gets a new dependency
  `afterJobEnded(job)`, called **unconditionally** (not only for Architect jobs) at the end of `notifyJobEnded`, i.e.
  right after `agents.reconcile` has released the round's records. `notifyJobEnded` already runs on BOTH terminal paths
  that end a Manta-owned round: `finishV2Job` (done / failed / timed out / stalled / lost run — all go through it) and
  `stopJob` (user stop, CTO stop) — so a stopped refresh task settles its run too. (`onJobTerminal` is NOT used: it runs
  before `agents.reconcile` and `stopJob` never calls it.) `index.mjs` wires `afterJobEnded` → `routines.settleFromJob(job)`:
  for the live run whose `jobId === job.id` (else nothing): `terminate(runId, job.status === "done" ? "done" : "failed")`
  with a synthesized report (`outcome: "findings"` when any of `changesForJob(job.id)` is `pending`, else `"nothing"`;
  body = the job's result or error text + `outcomeLinesForJob(job.id)`). Idempotent (a run already terminal is left
  alone).
- **The safety net (`reconcileRun`, every 60 s sweep and on reconnect/boot) branches on `run.jobId` FIRST**, before any
  session read:
  - `run.jobId` set → read that job (`delegate.getJob(id)`, a jobs-store read, injected). Running or paused → return
    (nothing else: no session read, no prompt). Terminal → `settleFromJob(job)`. Missing → `terminate(runId, "failed",
    "the refresh task is no longer on the box")`.
  - an `agent-refresh` run with NO `jobId` (crash between creating the session and recording the job) → never prompted;
    if older than 2 min, `terminate(runId, "failed", "the box restarted before the refresh could start")`. A task that
    did start in that window still runs and its proposals still land pending; only its run report is lost
    (follow-up).
  - `startRun` for `agent-refresh` persists `submittedAt` together with `jobId`, so the `submittedAt == null` resend branch
    (`oc.sendPrompt` into the run session) can never run for it; the `run.jobId` branch above returns before it anyway.
  - The 30-minute `RUN_TIMEOUT_MS` sweep skips runs that have a `jobId` (the task has its own 4 h ceiling and the net
    above settles it).
- **Charter text** (fixed, server-written): "Refresh @<slug>: check the research it rests on and propose only changes your
  research supports."
- Release: a dispatch round is mode `"unknown"`, so its proposals are always `pending` (reason `plan`) — they wait for a
  click, appear in Needs you and on the profile. Nothing applies by itself.
- `checkAgent`'s Architect refusal is untouched (this routine kind doesn't run the Architect as the routine's agent).
- A dispatch refused at fire time (5 tasks already running, "Change an agent" = Never, Architect missing) ends the run
  `failed` with that sentence as its report; the next month tries again. No retry loop.

## 6. Contracts (committed first, before implementers start)

### 6.1 Types (`src/shared/types.ts`)

```ts
// DelegateJob (src/shared/types.ts + the server record) gains:
//   rootJobId: string;               // the first round's job id; every job gets it at launch (startJob: its own id),
//                                    // continueJob / resume copy it (old.rootJobId ?? old.architect?.rootJobId ?? old.id).
//                                    // Readers of older records use rootJobOf(job) = job.rootJobId ?? job.architect?.rootJobId ?? job.id.
//   seatAdded?: { project: string; projectName: string };   // set when this launch created the seat
//   ending?: true;                   // the settle gate is running (§4.3); server-only, stripped from the wire
//   continueAfter?: true;            // a continue-pending answer exists for this round (§4.3); server-only
//   deliverResult?: false;           // never post this job's result (refresh tasks, §5.4); inherited by continuations
//   completionDelivery gains: "deferred" (§4.3) and "not-needed" (§4.3, §5.4); the sweep and continueRefusal only treat
//                                    // "pending" as in flight (unchanged code paths).
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
  delivery: "steer" | "continue" | "continue-pending" | null;
  delivering: { messageID: string; at: number } | null;   // claim of an answer in flight (§4.2 step 3)
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
  refresh: { enabled: boolean; routineId: string | null };   // enabled defaults to true (provisioned on sync)
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
| `onTaskQuestion` | bus `taskQuestion` | `(cb) → off` | subscription, like `onAgentChange` |
| `onAgentFleet` | bus `agentFleet` | `(cb) → off` | subscription |

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
`{ delivery: "steer" | "continue" | "continue-pending" } | { error }`, `rootJobOf(job)`, and accepts the new `startJob`
input `deliverResult: false`. It runs the §4.3 ending gate, the exact `finishV2Job` order of §4.3 step 2 (calling
`taskQuestions.onRoundSettled(job)` only for a `"deferred"` round, before any result post or cleanup), applies
`deliverResult` in `finishV2Job` AND `stopJob`, and calls the new `deps.afterJobEnded(job)` at the end of
`notifyJobEnded` for every job. `routines.mjs` (S2) exports `settleFromJob(job)` and takes an injected
`getJob(id)`; `index.mjs` (S2) wires both. **Everything is keyed by `rootJobId`** (questions, research usage, the side panel, `hasOpen`), never by
`childSessionID`.

**Research binding (S2):** `bindResearcher` returns `rootJobId: rootJobOf(job)` next to `childSessionID`, and
`researchLibrary.bound()` forwards `rootJobId: r.rootJobId ?? null`; usage is not recorded when it is null.

The agents engine (S2) receives `taskQuestions` as a dependency and uses only `hasOpen` (for §4.6), `listOpen`
(Needs you) and `answer`/`dismiss` (rpc pass-through).

### 6.4 Recap lines (pure, `fleetRecap(jobs, changes, since)` in `agents.mjs`)

Counted since `lastSeenAt` (or the last 24 h when never seen), at most 6 lines, fixed templates only:
"Manta handed N requests to agents", "<Agent> finished N task(s) in <Project>", "<Agent> failed N task(s)",
"<Agent> was changed (your setting: <level>)" / "… is waiting for your click", "N questions answered". No model call.

### 6.5 Task research (S2, `researchLibrary.mjs`)

`find` and `save` record, per bound task (`rootJobId` from the binding, §6.3), the entry ids returned (top 5) and saved, in
`~/.manta/research-library/used/<rootJobId>.json` (≤ 50 ids, atomic write, swept with entries older than 30 days).
`agents:task-research` resolves them with `lookup` in the task's project scope, then appends its proposals' `basis`.

### 6.6 Renderer seams (pinned)

`src/renderer/explorer/explorerStore.ts` (R2):
```ts
export type RightPanel = "explorer" | "artifacts" | "task" | "none";
export function openTaskPanel(sessionId: string, jobId: string): void;      // sets the slot to "task" + remembers jobId (in memory)
export function useTaskPanelJobId(sessionId: string | null): string | null; // null unless the slot is "task"
// setRightPanel(sessionId, "none" | "explorer" | "artifacts") also clears the remembered job id.
// useShownRightPanel(sessionId) may now return "task".
```
`src/renderer/TaskSidePanel.tsx` (R2): `export function TaskSidePanel({ sessionId }: { sessionId: string }):
JSX.Element | null` — reads `useTaskPanelJobId`, renders nothing when null, Close = `setRightPanel(sessionId, "none")`.
R1 mounts it in `App.tsx` beside `ArtifactsPanel`: `{isChatPaneActive && !routinesView && shownRight === "task" &&
<TaskSidePanel sessionId={activeChatSessionId} />}`.
`src/renderer/BackgroundCards.tsx` (R2): `BackgroundRunCards({ cards, openQuestionsByJob? })`; `export { JobDetails }`.

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

## 9. Tests

**Where checks run:** while iterating, run only the targeted tests locally (the files you changed, `vitest related
<files>`, the touched module's `node --test` file, the affected typecheck). The **full check before merge runs on GitHub
CI only** (the required `typecheck-test` job on the PR). **No Freestyle VMs** for this phase. A failing CI test is
fixed, never waved through.

- **`taskQuestions.test.mjs`** (new): claim → deliver → record ordering (a refusal keeps it `open` with `error`;
  no network call under the mutex — the fake store mutex asserts it); crash with `delivering` resolved by the sweep both
  ways; ending gate (steered answer left in the inbox → cancelled, `continue-pending`, continued once after the terminal
  write; inbox read failure retried); `deliverToTask` never steers into an `ending` round; capture stores + replies with the placeholder (fake `replyQuestion`); fallback on
  `custom:false`, on a reply failure, on the 4th open question; answer → steer when running+active, → `continueJob` when
  finished, refused when paused, sentence returned on a `continueJob` refusal (question stays open); double answer;
  dismiss running vs finished; settle with an unconsumed steered answer → cancelled + continued; store strict-read
  refusal; open questions never evicted.
- **`delegateV2Jobs.test.mjs`**: a round ending with a `continue-pending` answer writes `"deferred"`, posts NO result,
  skips cleanup, and the successor starts (no 409); a refused continuation reopens the questions, posts the result and
  cleans up; a crash at `"deferred"` is finished by the sweep; `deliverResult:false` → `"not-needed"` on finish AND on
  stop (no post either way) and survives `continueJob` and resume; `afterJobEnded` fires after `onJobEnded` on finish
  and on stop, for non-Architect jobs too; every launched job has `rootJobId`; `continueJob` and resume copy it; an old
  record without it resolves via `rootJobOf`; `deliverResult:false` never posts N7; `handleQuestion` no longer interrupts on the new path; a task ending with an open
  question is `done` (not `endedBlocked`) and its completion text carries the waiting line; the fallback path unchanged.
- **`taskDecision.test.mjs`**: answer-text formatting (single, multi, typed text); `acceptsFreeText` (no fields,
  one `custom:false` field, all custom).
- **e2e `scripts/opencode-v2/question-capture.e2e.mjs`** (pinned binary, scripted model): the model's question tool call
  returns the placeholder, the turn continues (a second tool call happens), a steered answer arrives in the same run
  (a user message with the answer text appears before the turn ends), and a finished task is continued by an answer.
- **`agents.test.mjs`**: refresh provisioning (every team agent gets one routine on sync; lead and Architect don't;
  days spread by slug; idempotent across syncs; a disabled or deleted routine is NOT recreated; `refresh-set` toggles the
  routine's `enabled` and recreates a missing one; a deleted agent's routine is removed); seats (legacy file reads as brief; frontmatter round-trip; implicit seat on dispatch/handoff;
  remove moves the file; symlink refused); history (filter, order, ≤ 50; `undone` records listed with the "Undone" chip; an `undone` record older than 7 days is
  kept; at the 200 cap discarded/expired go first, then the oldest `undone`, then the oldest `applied`; journal records
  never evicted); restore (applies with
  `click`, refuses at Never, refuses "already at that version", undo of a restore); fleet (cells from fake jobs, counters,
  week roll-over, recap templates); needs-you (pending box-wide, reviews minus `reviewed`); `decideRelease` keeps held proposals `pending`/`unfinished`
  while the root has an open / delivering / continue-pending question, even at Auto in build mode; restore refuses an
  unparsable version and an Architect version whose sources hold a credential (no record created); `bindResearcher`
  returns `rootJobId`; the exact prune set and cap rank (a 201st record evicts in rank order); `countProjectPages`
  absent → `notes: null`; seat creation stamps `seatAdded`; `agent_propose` refused with an
  open question; `askedUser` set at answer time; the guard test still passes with the new lead / footer text.
- **`researchLibrary.test.mjs`**: used-ids recorded per root, capped, swept.
- **`routines.test.mjs`**: `cleanInput` accepts `agent-refresh` only from `createInternal`, with a team-agent slug and
  the agent home dir; the tool / editor can't set `kind`; the run creates the headless session without prompting it,
  stores `jobId` + `submittedAt`, is skipped by the 30-min timeout, settles from `settleFromJob` (done → report with
  Outcome lines; failed → failed; stopped → failed), `reconcileRun` with `jobId` never reads the session or prompts it
  (running job → no-op; terminal → settled; missing → failed), an `agent-refresh` run without `jobId` is failed after 2 min
  and never prompted; an `agent-refresh` routine dispatches the Architect via
  `agents.refresh` and never prompts the run session; its proposals are `pending` (`plan`) whatever the "Change an agent" level (Auto included); a refused
  dispatch ends the run `failed` with the sentence.
- **Renderer**: question routing by id prefix (task vs session question) and a task refusal on the send-error line;
  `openQuestionsByJob` count on the run card; Details button on an agent result card opens the panel; "Added @slug to
  <Project>" line from `seatAdded`; no seat pill on the lead / Architect picker rows; refresh control shows Monthly by default and Off after the toggle (and reports a refusal); history
  shows undone rows; question merge in ChatPanel (reply / dismiss / refusal shown); Fleet page (needs-you groups, empty state,
  grid cells, click opens the session); profile tabs (keyboard: arrows, Home/End; `aria-selected`; hidden panels);
  history row expand renders `AgentChangeView`; restore button visibility; seats edit/remove/add; side panel open/close
  and right-slot exclusivity; picker sort + pills; New agent creates a prefilled draft. Visual registry rows for Fleet,
  profile and the side panel against the mockup.

## 10. Implementation split (by file ownership; nobody edits another's paths)

**Checks for every implementer (put this in each brief):** run targeted tests locally while iterating (changed files,
`vitest related`, the module's `node --test`, the affected typecheck). The full check before merge is GitHub CI's
`typecheck-test` on the PR — no Freestyle VMs, no full suite on the dev box. Report the targeted commands you ran and the
CI result.

**Committed first by the lead:** this spec, the screen docs, §6.1 types in `src/shared/types.ts`, the §6.2 `Api` members
in `src/shared/api.ts` (signatures only) and channel names.

- **S1 — server, questions** (Sonnet 5.5): `src/server/taskQuestions.mjs` (+test, new), `src/server/delegate.mjs`
  (`rootJobId` on every job, `rootJobOf`, `seatAdded` passthrough, `deliverResult:false`, capture, `deliverToTask`, the
  ending gate, `onRoundSettled` call, footer text, completion line) + `delegateV2Jobs.test.mjs`,
  `src/server/taskDecision.mjs` (+test), `scripts/opencode-v2/question-capture.e2e.mjs`.
- **S2 — server, agents** (Sonnet 5.5): `src/server/agents.mjs` (seats, `seatAdded`, `bindResearcher.rootJobId`,
  `decideRelease` open-question rule, `countProjectPages` dep, history + exact prune/rank, restore re-validation, fleet,
  needs-you, recap,
  refresh provisioning + toggle (§5.4), lead brief, §4.6) + `agents*.test.mjs`, `src/server/researchLibrary.mjs` (+test), `src/server/routines.mjs`
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
  `onAgentFleet`), `src/renderer/newAgentDraft.ts` (new: `openNewAgentDraft()`, `openChangeAgentDraft(slug)`,
  `openMentionDraft(slug, folder)`, used by R1), `src/renderer/ResearchRows.tsx` (new: the topic / sources / age / fresh /
  thin rows, used by the side panel AND by R1's profile, so there is one rendering of library entries).

Seams: R1 imports `openNewAgentDraft`, `openChangeAgentDraft`, `openMentionDraft`, `ResearchRows`, `TaskSidePanel` and
`useShownRightPanel` (now able to return `"task"`) from R2's files by the names above; R2 imports nothing from R1. R2 lands
those exports first (stubs that render nothing are NOT allowed on `main`; land them in the same PR train or R1 waits).
S2 wires S1's module by §6.3. Every implementer follows `modern-web-guidance` for UI (R1, R2), the no-stub rule (every
control reports its outcome), and runs targeted tests while iterating.

## 11. Later

Restyling the question card and the change card to the earlier mockup look; built-in agent updates (template vs
installed with user edits — needs a three-way merge); Tests tab (trial runs); a Reviewer agent; budgets; question
deadlines/defaults; VMs; Fleet filters ("All projects" is static); multi-project seats; per-seat model/permission
overrides; a library browser; a real-model probe of the placeholder wording; Needs-you push notifications per item;
showing hand edits in History (needs file watching).

## 12. Review log

- **OpenAI review: still pending.** Requested with `openai/gpt-6-astra`, then `openai/gpt-6-sol` (and `gpt-6-luna` as a probe) through
  the box's OpenCode; all three refused with "The usage limit has been reached". It must be re-run (Must/Should findings applied) before implementation starts.
- **Self-review round (Opus), applied:** inbox items may not carry the message id (match by id, else text; verify in the
  e2e first); `askedUser` owner and timing pinned (set before `continueJob` so the successor inherits it); "Mention in a
  chat" no longer reaches into another component's composer (a draft instead); one shared `ResearchRows` for the panel
  and the profile; the review item feeds `BackgroundResultCard` a built part; the bus subscriptions are in the `Api`
  table; R2's exports land before R1 uses them.

### Round 2 — Gemini 4 Argon (OpenCode Go), at 560f6182; verdicts (each checked against the code at `ba05c45e`)

1. **MUST — `rootJobId` only on Architect jobs.** Confirmed (`delegate.mjs` sets `architect.rootJobId` only; plain
   continuations link by `childSessionID` / `continues`). **Applied:** `rootJobId` is stamped on EVERY job at launch and
   copied by `continueJob` and resume; `rootJobOf(job)` covers older records; everything is keyed by `rootJobId` (§6.1,
   §6.3).
2. **MUST — `bindResearcher` doesn't expose the root.** Confirmed (returns `childSessionID, agent, architect, project`;
   `bound()` forwards only `child, project, agent`). **Applied** (§6.3, §6.5).
3. **MUST — fallback can't see `custom`.** Confirmed (`decisionFromForm` keeps question/options/multiple only).
   **Applied:** pure `acceptsFreeText(form)` on the RAW form before mapping (§4.2).
4. **MUST — answer/settle ordering, settle lock, release while a question is open.** Confirmed: `settleV2Job` /
   `finishV2Job` don't take `withSessionResources` (only the cleanup does); `decideRelease` rule 4 would apply a `done`
   round's held proposals. **Applied:** claim → deliver → record with no I/O under the store mutex and a refusal keeping
   the question open; crash recovery via `delivering`; the ending gate before `finishV2Job` + `onRoundSettled` after it;
   `deliverToTask` never steers into an `ending` round and never nests the session lock (`continueJob` takes it itself —
   a deadlock the review's fix 3 would have caused); `decideRelease` rule 4 holds while a question is open (§4.2, §4.3,
   §4.7).
5. **MUST — ChatPanel routing / QuestionCard states.** Confirmed (`QuestionCard` is synchronous, no busy/error props).
   **Applied:** route by `tq_` prefix, `QuestionCard` stays unchanged, refusals on the send-error line; contract states
   fixed; the Stop / busy-send rejection only sees the session's own questions, which is intended (§4.4, contract).
6. **MUST — refresh mechanics in `routines.mjs`.** Confirmed (`cleanInput` needs prompt + an existing directory; dispatch
   needs a tmux owner via `resolveOwner`; runs settle on their own session's execution and time out at 30 min).
   **Applied** end to end: `kind` validation and internal-only creation, agent-home directory, a headless session with no
   prompt, `agents.refresh` → `startJob` with `targetProject: manta-agents` and `deliverResult: false` (so N7 never wakes
   the headless session — not in the review, found while applying it), `run.jobId`, settle from `onJobTerminal`, timeout
   skip, boot settle (§5.4).
7. **MUST — prune set / rank.** Confirmed. **Applied** with the exact sets (§5.2).
8. **MUST — restore skips validation.** Confirmed (`planChange` parses and credential-checks; `applyLocked` writes
   `after` as is). **Applied:** parse + source validation + `checkSourceCredentials` before any record (§5.2).
9. **SHOULD — tokens.** Confirmed (`text-micro` has 0.08em tracking; no `content-visibility` utility). **Applied:**
   arbitrary property `[content-visibility:auto]` (+ `contain-intrinsic-size`), `tracking-normal` on lowercase micro text
   (contract).
10. **SHOULD — seams.** Confirmed (no Details on `BackgroundResultCard`; store exports unpinned). **Applied:** §2.5 and the
    pinned §6.6 (`RightPanel`, `openTaskPanel`, `useTaskPanelJobId`, `TaskSidePanel({sessionId})`, the App mount line).
11. **SHOULD — open-question count.** **Applied:** `openQuestionsByJob` from ChatPanel to `BackgroundRunCards`, keyed by
    `rootJobId` (§2.3, §6.6).
12. **SHOULD — seat-added line / Architect pill.** **Applied:** `seatAdded` on the job, rendered as its own line; no seat
    pill for lead / Architect (§2.3, §6.1).
13. **COULD — notes source.** **Applied** (cheap): injected `countProjectPages`, `null` fallback (§5.1).

No finding was rejected. The OpenAI review (above) remains pending; a second review round is next.

### Round 3 — Gemini 4 Argon (review2), verdicts (checked against the code at `ba05c45e`)

Round 2 itself: 11 of 13 round-1 findings resolved; R1-4 and R1-6 partially, completed by the items below.

1. **MUST — the ending gate vs the result post.** Confirmed: `finishV2Job` writes `completionDelivery: "pending"` and
   then posts (`deliverJobResult`) and cleans up (`finishV2Cleanup`) in its tail; `continueRefusal` returns 409 on
   `"pending"`. **Applied:** new `"deferred"` value when a continue-pending answer exists; the exact order (terminal write →
   `onJobTerminal` → `notifyJobEnded` → `afterJobEnded` → `clearProgress` → `onRoundSettled` → post/cleanup only when not
   continued); a refused continuation reopens the questions and falls back to posting the result and cleaning up; crash
   recovery through the sweep (§4.3).
2. **MUST — hook order and `stopJob`.** Confirmed: `finishV2Job` calls `onJobTerminal` before `notifyJobEnded`
   (`agents.reconcile` runs in `onJobEnded`, Architect jobs only), and `stopJob` calls `notifyJobEnded` but never
   `onJobTerminal`. **Applied:** a new `afterJobEnded` hook at the end of `notifyJobEnded`, unconditional, so it runs after
   reconcile on both the finish and stop paths; `onJobTerminal` is not used (§5.4). The `reconcileRun` net (item 3)
   settles any path that still slips through, so no run stays running.
3. **MUST — `reconcileRun` resends the prompt.** Confirmed: with `submittedAt == null` and no user message it calls
   `oc.sendPrompt` into the run session; a missing session fails the run. **Applied:** `reconcileRun` branches on
   `run.jobId` before any session read (running → no-op, terminal → settle, missing → fail); `submittedAt` is persisted
   with `jobId`; a refresh run without `jobId` is never prompted and fails after 2 min (§5.4).
4. **SHOULD — `deliverResult:false` overwritten.** Confirmed: `finishV2Job` and `stopJob` both set
   `completionDelivery: manta ? "pending" : null`. **Applied:** persisted on the record, inherited by continuations and
   resume, respected by both terminal writes and by `stopJob`'s post (§5.4, §6.1).
5. **COULD — stale duplicate bullet in §5.4.** Confirmed. **Applied:** deleted; its charter text kept as its own bullet.

None rejected. The OpenAI review remains pending (above).
