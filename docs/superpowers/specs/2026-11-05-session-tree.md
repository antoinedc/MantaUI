# The session tree: rows are sessions, not windows

Status: DRAFT r1 (2026-11-05), for review. Scope: `src/server/` (session list, status, delegate), the desktop
sidebar, the iOS session list, the manta opencode plugin (one new tool).

## Problem

The sidebar tree is derived from **tmux windows**: a row exists only if a window exists, and a background row
nests only if the box can find a *window* for the session id recorded as its parent. Windows, however, are
created and destroyed as side effects of work:

- a busy subagent / API-driven session is "adopted" into a row by **creating a window** for it
  (`adoptExistingSession`), and that window is **closed when its turn ends** (`finishV2CleanupLocked`);
- a job's parent is very often a session that never has a window: a `task` subagent, a handed-off predecessor,
  the CTO conversation, a root session an orchestrator drives through opencode's API.

So nesting is re-derived from heuristics that look for *some* window to hang a row on: the nearest windowed
ancestor, then the handoff successor, then "the windowed session whose transcript mentioned this id in the last
24 h" (a DB scan), and since #1674 / today's branch "where the parent's own row used to sit". Each fix closed
one path and the next variant appeared: #1663 → #1674 → `fix/delegate-display-parent-manta-owned`.

Evidence (live box, workspace `cantina`, 2026-11-05 16:24–16:52): the orchestrator (window 16) drives two
windowless `task` subagents ("J early", "B: 3b integrator"); each calls `delegate`. Every turn of a subagent
creates an adopted window (indexes 1, 2, 6, 8 reused in turn) nested under window 16 by the transcript rule;
every turn end closes it. While the window exists the subagent's delegate jobs (windows 10, 12) nest under it
and are lifted under 16; the moment it closes they fall to top level. The tree flaps on every turn, and the
observed records pile up (10 records for one subagent in 2 h, each with a dead `windowIndex`).

The substrate is wrong, not the rules: **the structure we want to show is the session graph, which opencode
already has**; windows are a property of a row (the user opened it), not its identity.

## Goal

- The sidebar tree is a view over the **session graph** — opencode's `parentID` edges, handoff replacement
  chains (one conversation), and job records — and never depends on a window existing.
- A session that is running appears under its parent without anybody creating a window for it; nothing
  creates or closes windows as a side effect of work starting or ending.
- The user can still open any shown session (the holder window is made on demand) and still closes rows
  themselves.
- Delete the heuristics: `displayParentID`, `resolveDisplayParents`, the `sessionReferences` DB task, the
  reconciler's display-parent refresh, observed-session adoption windows.

Non-goals: changing what a background **job** is (worktree, branch, result delivery, caps, pause/resume);
changing terminal (claude-TUI) rows, which stay window-identified; multi-level rendering (the sidebar keeps
"top-level row + its children", flattened — unchanged).

## Design

### 1. The graph (server, one owner: `sessionStatus.mjs`)

`createSessionStatus` already holds the pieces: the running set (`listActiveSessionIds` + `running`/
`turnComplete` frames), parent edges (`childSession` frames + `resolveChain` reads of opencode's `parentID`),
job records, pending asks. It becomes the **one tree builder**; nothing else decides nesting.

Edges, in precedence (first that applies):

1. **Job record**: a record's `childSessionID` → `parentSessionID` (Manta-owned and subagent records; the
   field never changes). This is already authoritative for result routing and matches opencode's edge
   anyway (a V2 child is created under its parent).
2. **opencode `parentID`**: for every running session and every job child, read once and cached as today
   (`parentOf`); `session.created{parentID}` / `childSession` frames keep it fresh.
3. **Explicit link** (§5): `~/.manta/session-links.json`, `child → parent`, written by a tool.
4. **Handoff chain**: a session and its `replacedBy` successors are **one conversation node**; the node's
   identity is the chain's live member (the one stamped on a window, else the newest). An edge to any chain
   member is an edge to the node. (`handoffEngine.chainOf` / `successorOf`, as today.)

No transcript scanning. No stored display parent. A cycle (impossible from opencode, possible from a bad link
file) breaks at the repeated id: that child becomes a root.

### 2. Which sessions are rows

A session is **shown** when any of:

- it is stamped on a tmux window (the user opened it, or a job launch made it) — a *window row*;
- it is the child of a live job record (`running`/`paused`, or terminal with a pending/unposted result) — a
  *window row* if it has a window, else a *virtual row*;
- it is running, or has a pending question / permission, or ended within `LINGER_MS` (30 s; keeps a subagent
  that loops turn-after-turn from blinking) — a *virtual row*.

Everything else (idle subagents, finished adopted sessions, Manta-internal sessions —
`metadata.manta.internal`, routine runs) is not a row and is **collapsed**: edges pass through it.

**Nesting**: a shown session's parent in the tree is the nearest shown ancestor along the edges above. A shown
session with no shown ancestor is a **root** of the project that owns it: the tmux session of its window, else
the project whose directory contains the session's directory (`ownerByDirectory`), else it is not shown
(nowhere to put it; today's "none" case). A root with no window is labelled *driven from outside* (today's
"started outside Manta" wording).

The sidebar keeps its rendering: a root row, and beneath it every shown descendant flattened (today's lift to
the top-level ancestor), ordered by (depth, start time). iOS keeps hiding children and showing the parent's
count, as today.

### 3. Wire

`tmux:list` / `sync:snapshot` projects gain `tree: SessionNode[]`:

```ts
type SessionNode = {
  sessionId: string;              // the conversation node (handoff chain's live member)
  kind: "window" | "virtual";
  windowIndex: number | null;     // "window" only
  title: string;                  // window name, else opencode's session title
  job: { id: string; status: DelegateStatus; origin: string } | null;
  outside: boolean;               // a root with no window (driven from outside)
  children: SessionNode[];        // depth unlimited; clients flatten
};
```

`windows[].job.parentWindowIndex` is **kept during the transition**, now computed from `tree` (a child's
nearest *windowed* ancestor's index, as today's `computeJobNesting` output), so an older desktop / iOS keeps
nesting exactly as before. `windowStatus` frames are emitted for every shown session (today: windowed only);
their payload is unchanged. A `sessions.nesting` frame follows a `sync` delta whose tree changed, as today.

### 4. Opening a virtual row

Click → `sessions:materialize({ sessionId })` → the box creates the holder window stamped with that session in
the owning project (`newWindow({ chatMode:true, existingSessionId })`, exactly what adoption does today) and
answers `{ project, windowIndex }`; the client selects it. The row's kind flips to `window` on the next list.
This is the backlog's "Open subagent as its own chat-mode window" (AGENTS.md, open work) and makes it the ONLY
way a subagent gets a window. Keybinds (⌘1..9, ⌥⌘↑/↓) walk window rows only; a virtual row is reached by click.

### 5. Sessions driven from outside

An orchestrator that prompts a session through opencode's HTTP API (the cantina scripts) creates no edge, so
that session is a root labelled *driven from outside*. That is the honest state, and it is stable. To nest it
the driver says so: a manta plugin tool

`session_link({ sessionId })` — "nest `sessionId` under this conversation in the sidebar". Writes
`child → caller` to `session-links.json` (one parent per child; the newest write wins; a link to a session
that is a job child or has an opencode parent is refused — those edges are authoritative). `session_unlink`
removes it. The guidance blurb tells orchestrators that drive sessions by script to call it once per session.

### 6. What stops

- `adoptExistingSession` no longer creates windows; `origin:"observed"` adoption is **retired** (its only
  product was a row, which §2 now derives from the running set + graph). `origin:"subagent"` records stay
  (they carry the parent transcript's background card and result pairing) but are window-less until opened.
- `displayParentID`, `resolveDisplayParents`, `refreshDisplayParents`, `sessionReferences` (dbTasks), the
  reconciler's display-parent refresh and the `repointJobSessions` `displayParentID` branch are deleted.
  Existing records keep the field as dead data until retention prunes them.
- `finishV2CleanupLocked` keeps closing a *job's* window on finish (worktree removal is the reason it exists);
  it no longer has an observed branch. A finished subagent's virtual row simply disappears after `LINGER_MS`.
- The active-session reconciler stays for **lost-run** detection and subagent records only.

### 7. Stages

(a) **Server tree, no client change.** `sessionStatus` builds `tree`; `parentWindowIndex` is derived from it;
the display-parent machinery is bypassed (not yet deleted). Clients render exactly as before, minus the flapping
for every case where the parent is a windowless ancestor (nesting now goes through collapsed sessions).

(b) **Virtual rows + materialize.** Desktop sidebar renders `tree` (virtual rows styled as today's "started
outside Manta" rows, with the running dot / attention); `sessions:materialize`; adoption stops creating windows;
observed adoption retired. iOS: counts come from `tree`; a virtual child counts like a job child.

(c) **Delete** the heuristics and the `displayParentID` field; `session_link` tool + guidance.

(a) and (b) are each a PR; (c) follows once both clients have shipped (b) (compatibility matrix unchanged: the
wire only gains fields).

### 8. Tests

- `sessionStatus.test.mjs`: tree derivation — collapse through idle subagents; handoff chain as one node; a
  job child under a windowless subagent nests under the subagent's windowed ancestor regardless of any window;
  root placement by window then by directory; outside roots; linger; cycle from a bad link; `parentWindowIndex`
  derivation equals today's `computeJobNesting` for every windowed case (property test over the existing
  fixtures).
- `delegate*.test.mjs`: no window is created by adoption; records unchanged otherwise; `repointJobSessions`
  without the display branch.
- `rpc.test.mjs`: `sessions:materialize` (creates once; a second call for a session that now has a window
  returns it; refused for a session with no owning project).
- Renderer: Sidebar renders virtual rows from `tree`; click materializes and selects; keybinds skip virtual
  rows. iOS: `SessionJobWindows` counts from `tree`.
- Live check before (c): cantina's tree stable across 10 subagent turns (no `sessions.nesting` churn).

## Libraries considered

| Need | Chosen | Considered / why rejected |
|---|---|---|
| Session graph (edges) | opencode's own session records + `childSession` events, already read by `sessionStatus` | nothing external applies; the data is opencode's |
| Tree derivation (collapse, roots, flatten) | ~80 lines in `sessionStatus.mjs`, pure | `graphology` (3.6k★, MIT): general graph lib — we need one bounded walk over ≤ a few hundred edges; a dependency for this is weight, not value |
| Durable link store | existing `statePath` JSON store pattern (atomic write) | `conf`/`lowdb`: the box already has one pattern for every store; adding a second is the wrong direction |
| Sidebar rendering of nested rows | existing `Sidebar.tsx` rows (flattened children) | `@headless-tree/react` (already in the repo for the Explorer): built for deep expandable trees with keyboard nav; the sidebar is a flat list with an indented band and its own keybinds — adopting it means re-doing those for no visible gain. Revisit if a real expandable tree is wanted |
| Session title for a virtual row | opencode's session title (read once with `parentID`) | — |

## Open questions

1. Keep the transcript "driver" rule as a last resort during stage (a)? Proposal: no — a wrong nest is worse
   than an honest *driven from outside* root, and `session_link` covers the orchestrator case explicitly.
2. Should a finished `subagent` record's virtual row linger until its result is read in the parent transcript
   (like a job), or vanish after `LINGER_MS`? Proposal: vanish; the transcript card is the durable surface.
3. iOS: show virtual rows (tappable → materialize) or only count them? Proposal: count only in (b), rows later.
