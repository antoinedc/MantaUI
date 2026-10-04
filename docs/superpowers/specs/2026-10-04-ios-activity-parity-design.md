# iOS: tool activity parity, session list ordering, background jobs, task status, todo card

**Date:** 2026-10-04
**Branch:** `feat/ios-activity-parity`
**Status:** Draft. Waiting for user approval.
**Scope:** native iOS app (`mobile/native`) only. No server changes are needed: every signal used below is already sent by the box.

## Problems

| # | What the user sees | Root cause |
|---|---|---|
| P1 | The phone still shows tool calls the old way, while desktop now shows one-line "activity" rows | Desktop PR #1555/#1556 (`src/renderer/toolActivity.ts`, `ToolGroup.tsx`) were never ported. iOS groups steps per message, only rolls up runs of 3 or more, uses verb counts ("Ran 3, Search 1"), and its working line has no tool headline |
| P2 | Some background jobs appear as normal sessions in the main list | The phone tucks a job under its parent only when it can match a live job record **and** a parent window in the same project. It ignores the box's own `owner: "job"` tag on each window. Jobs whose parent is gone, in another project, or whose record was pruned therefore leak. If the job list fails to load or decode, every job leaks |
| P3 | No way to order the list by recent activity | The list is always tmux order with pinned windows first. `lastActivity` is only used for the age chip, and it is missing for older sessions: the unscoped session list returns at most 100 sessions |
| P4 | The session menu has no list of background jobs | Not built |
| P5 | Subagent tasks always show "done", even while they are still working | For background subagents, opencode marks the task tool call **completed** as soon as the job starts. The real result arrives later. iOS believes the tool call status and never checks whether the child session is still busy. Desktop does check (`TaskCard.tsx:96-106`). Separately, an errored task shows as "running" (`ChatModels.swift:149`) |
| P6 | The todo card can't be expanded, and it floats over the transcript | `TodosCard` has no tap handling. It is forced to one line while a turn runs, and shows at most 5 items. It lives in the composer overlay rather than in the transcript, and it never auto-dismisses |

## 1. Tool activity rows (P1)

### 1.1 Grouping: same rules as desktop

Port `layoutTranscript` from `src/renderer/toolActivity.ts:346-403` as-is:

- A **run** is any consecutive sequence of tool parts and patch parts. A run **can span assistant messages**. It belongs to the message it starts in, and the messages it absorbs draw nothing.
- What ends a run:
  - visible text
  - non-empty reasoning, but only when thinking is shown
  - media, file or unknown parts
  - a user message that renders
- Todo-list writes never appear as tool calls.
- **Run id** is the id of its first part, so it stays stable while the run grows. The row's scroll id must derive from this id (see §7, row identity).
- While a turn is running, the run at the very end of the transcript is shown in the working line (§1.4) instead of inline.

### 1.2 Wording: same strings as desktop

Port `describeActivity` (running / done / failed labels per tool kind) and `summarizeToolGroup`:

- One call: that call's done or failed label ("Edited ChatScreen.swift").
- Several calls: category counts in order of first appearance, first letter capitalised ("Read 3 files, ran a command").
- More than 3 categories: "Used N tools".
- Patch parts join a run but are not counted when it contains any real tool call.
- Bash uses the call's own description, cut to 60 characters.
- Unknown tools read "Used <humanized name>".

**Parity contract.** A fixture file `src/shared/fixtures/tool-activity-cases.json` lists input tool parts and the expected label/summary strings. It is generated from, and asserted by, a vitest test against `toolActivity.ts`, and read by a Swift unit test against the port. If one client's wording changes without the fixture, a suite goes red.

### 1.3 The collapsed row

Each run renders as **one line**: status dot · summary (truncated, one line) · red "· N failed" when any call failed · chevron.

Dot colour follows desktop's `groupTone`:
- running: accent, animated
- any failure: warn
- otherwise: ok

The whole line is the tap target, at least 44pt tall. This replaces the rounded `StepGroupView` panel and the 3+ roll-up.

### 1.4 The working line

This replaces the content of `RunningIndicator` while a turn runs. It keeps the same slot: the list's typing indicator.

| Situation | Headline | Faint meta after it |
|---|---|---|
| A tool is running | "<running label>…" (e.g. "Reading ChatScreen.swift…") | "· N tools · elapsed" |
| Between tools in a run | "<random verb>…" | "· <run summary> · elapsed" |
| No tool run yet | Today's "<verb>… · elapsed" | (none) |

- A red failed count is shown when relevant.
- When there is a trailing run, the line is tappable and opens the same sheet as §1.5.

### 1.5 Tap opens a sheet

Tapping a run row, or the working line, opens the **Activity sheet**. It has medium and large heights and a grabber.

**Header:** the run summary, and "running" or the total duration.

**Body:** one row per call, in order. Each row shows:
- the status glyph
- the label: running, done or failed form
- the target in monospace, middle-truncated
- the duration

**Tapping a call row** expands its detail inline in the sheet:
- bash: the command and an output tail
- edit, write and patch: the file path and a diff when present
- read, grep and similar: the arguments and an output tail
- error: the error text, and the row starts expanded

A run with **exactly one call** opens with that call expanded (desktop's `defaultExpanded`).

**Subagent (task) rows** inside the sheet push the child transcript *within the sheet's own navigation stack*, using the existing `ChatSubagentScreen`. This is the one change to DECISIONS.md §8a (subagents push a full screen). Subagent rows that appear in a run outside the sheet are reached through the sheet too.

**Live updates:** while open, the sheet follows the live run. New calls append, running rows flip to done, and the sheet does not close when the run settles. The sheet is keyed by run id, so it survives the transcript re-rendering.

### 1.6 Out of scope

- Reasoning display (iOS keeps skipping reasoning).
- Desktop's retry card.

## 2. Hide background jobs from the main list (P2)

A window is a **job window** when either of these holds:

1. its `owner == "job"` (from `tmux:list`; decode the field into `MantaWindow`), or
2. it matches the existing nesting rule (`SessionJobNesting.compute`), which still covers jobs created before the `owner` tag existed.

Placement:

- **Job windows are never top-level rows** under any ordering.
- A job window whose parent window is visible is counted in that parent's subtitle ("N background jobs"), as today, and listed in the parent's Background jobs sheet (§4).
- A job window with **no visible parent** goes into one collapsed group, **"Background jobs (N)"**, at the bottom of the list (both orderings). This covers a parent that is closed, in another project, headless (CTO), or a pruned job record. The group's rows behave like normal session rows: tap opens, and swipe gives the existing actions. Without this group those windows would be unreachable from the phone.
- If the job list fails to load or decode, rule 1 alone still hides tagged windows. A single bad job record must no longer drop the whole list: decode records leniently and skip only the bad one.
- The store listens for the `delegate.updated` event and refetches the job list. Today it only refreshes on pull, foreground, and so on.

## 3. Ordering toggle (P3)

A two-state toggle in the session list's navigation bar menu (the existing toolbar, not a new floating control):

| Mode | Label | Behaviour |
|---|---|---|
| **Created** (default) | "Created" | Today's behaviour: grouped by project in tmux order. Inside a project, pinned windows first, then window index (≈ creation order) |
| **Latest activity** | "Latest activity" | **Flat list, no project grouping.** All visible windows sorted by last activity, newest first. Pinned windows are *not* lifted to the top. The row shows the **project name** as a leading caption on the subtitle line ("better-ui · running · opus") |

Details:

- **Persistence:** the choice is device-local (`@AppStorage("sessionListOrder")`), values `created` | `activity`.
- **Interaction with other features:** search and the Recent filter still apply in both modes. The job group from §2 stays at the bottom in both modes.
- **Last activity** for a window is the latest of:
  - the opencode session's `time.updated`, fetched **per window directory** (one `opencode:list-sessions(directory)` per distinct directory, as desktop's `backfillLastMessageTimes` does). This fixes the 100-session cap.
  - the live running→idle and idle→running transitions from the event stream (`runningSince` / idle time).
  - for terminal (non-chat) windows, which have no opencode session, nothing is available. They sort last, by window index.
- **Stable sort:** ties break on project order, then window index, so rows don't jump between refreshes. Re-sorting happens on data refresh and on running-state changes, not on a timer.

## 4. "Background jobs" in the session menu (P4)

A new entry in `ChatOverflowSheet`, in the first group after Artifacts: **"Background jobs"**, with a count of running jobs.

- **Data:** `delegate:list(sessionId)` for the current session. The entry is hidden when the session has never had a job.
- It opens a sheet in the same way as Scheduled tasks, Secrets and Artifacts.

Each row in that sheet shows:
- status dot and status (running / done / failed / stopped / paused)
- job name
- origin badge: "subagent" when `origin == "subagent"`, otherwise nothing
- branch, when present
- elapsed time, or the finish time
- one line of `activity` / progress

Row actions:

| Action | Behaviour |
|---|---|
| **Tap** | Opens the job's own session (`childSessionID`) in a normal chat screen. If the job's window is gone, the row is not tappable and shows "window closed" (no dead tap) |
| **Stop** (swipe or context menu, running jobs only) | Calls `delegate:stop(id)` with a confirmation. Success and failure are both shown as a toast |

Freshness: the sheet refetches when it opens, on `delegate.updated`, and every 10s while open (the same pattern as the Scheduled tasks card).

## 5. Correct subagent task status (P5)

A task row's status is resolved in this order. The first rule that applies wins.

1. The tool call status is **error** → **failed**. This fixes "errors show as running".
2. The child session (`state.metadata.sessionId`) is **busy** in the event store's per-session state → **running**.
3. A job record with `childSessionID == child` exists and its status is running or paused → **running**.
4. The tool call status is pending or running → **running**.
5. The tool call status is completed and the call is a background task, i.e. its output starts with `<task … state="running">` and none of rules 2–3 has said idle or done → **running ("started in background")**. The row is upgraded once rule 2 or 3 reports idle or done.
6. Otherwise → **done**.

Plumbing this needs:

- **Keep live task rows that are complete but still running.** Live task rows that report completed are no longer dropped (`ChatModels.swift:384-391`) while rules 2–5 still say running. This removes the mid-turn disappearance.
- **Feed the job list into the chat screen.** The chat screen already loads it for §4; pass it to the transcript mapper.
- **Refresh on the child going idle.** The child session's idle event triggers a refetch of the parent transcript, so the row flips to done promptly.
- **Fixture:** the capture fixture in `RootView.swift:78` uses the same resolver.

## 6. Todo card in the transcript, expandable (P6)

**Placement.** The card moves out of the composer overlay and becomes the **last row of the transcript** (after queued prompts). It scrolls with the content, so the user can scroll away from it. The composer overlay's bottom padding no longer includes it.

**Collapsed** (default while a turn runs):
- header "Todo" · "3/7" · two-colour progress bar · chevron
- one line underneath: the current in-progress item, or else the next pending one

**Expanded** (tap the header):
- **every** item, with no 5-item cap
- the existing glyphs: in progress, pending, done struck through, cancelled
- each item may wrap to 3 lines
- the expanded/collapsed choice persists per session for the app's lifetime; it is not reset by running/idle

**Auto-dismiss**, matching desktop: when the user sends a prompt while every item is completed or cancelled, the card hides until the next todo update. It also falls back to the transcript's last todo write when no live todo frame has arrived (for example, after reopening a session).

## 7. Constraints and risks

**Row identity (high risk).** The transcript list crashes on duplicate or unstable ids (`mobile/native/AGENTS.md` §6, `TranscriptRow.swift:58,100`). Two changes touch identity:

- runs spanning messages: the id is `"run-" + firstPartId`, and absorbed messages emit **no** row
- the new todo row: a fixed id `"todos"`, present at most once

Both must pass `uniqueTranscriptRows`, and the existing crash regression tests must stay green.

**No Swift toolchain on the Linux box.** Builds and tests run on the Mac through the `ios-mantaui` plugin / `mobile/native/verify.sh`. The Swift unit tests for the wording port, task-status resolver, ordering/sort, job filtering and todo dismissal are pure model tests.

**"No dead controls".** Every new tap target either does its action and shows the result, shows a reason it failed, or is not rendered (AGENTS.md).

## 8. Implementation split (parallel agents, disjoint paths)

**Agent A: transcript** (§1, §5, §6). Owns:
- `ChatModels.swift`, `TranscriptComponents.swift`, `TranscriptRow.swift`, `RunningIndicator.swift`, `ChatSessionStore.swift`
- the todo-card and overlay parts of `ChatScreen.swift`
- new `ActivitySheet.swift`
- the fixture plus its vitest test

**Agent B: list and jobs** (§2, §3, §4). Owns:
- `SessionListView.swift`, `SessionListStore.swift`, `SessionModels.swift`, `ChatOverflowSheet.swift`
- the `MantaAPIClient` job decoding
- new `BackgroundJobsSheet.swift`

**The one seam.** Wiring the Background jobs destination into `ChatScreen.swift`'s sheet switch, and passing the job list to the mapper for §5. Agent B exposes a `BackgroundJobsStore`. Agent A consumes it in `ChatScreen.swift`. B does not edit `ChatScreen.swift`.

## 9. Decisions to confirm

1. **Latest-activity mode ignores pins.** Alternative: keep pinned windows on top.
2. **Orphaned job windows go in a collapsed group at the bottom** instead of disappearing. Alternative: hide them entirely.
3. **Subagents open inside the activity sheet** (pushed within it), rather than pushing a full screen from the transcript.
4. **Todo card is collapsed by default while running and expanded by default when idle.** Alternative: always collapsed until tapped.
5. **Background jobs sheet includes Stop.** Alternative: read-only plus open.
