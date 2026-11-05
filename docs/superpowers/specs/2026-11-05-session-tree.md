# The session tree: rows are sessions, not windows

Status: DRAFT r2 (2026-11-05), after Astra review round 1
(`reviews/2026-11-05-session-tree-astra.md`). Scope: `src/server/` (session list, status, delegate, push labels),
the desktop sidebar, the iOS session list, the manta opencode plugin (two new tools).

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

- The sidebar tree is a view over the **session graph** — job records, opencode's `parentID` edges, explicit
  links, handoff replacement chains (one conversation) — and never depends on a window existing.
- **Stable-placement invariant**: the *root* a shown session sits under changes only when an edge changes
  (a handoff commits, a link is written/removed) or that root's window is closed by the user. Turns starting
  and ending, windows being made on demand, records finishing: none of these move a row to another root.
- A running session appears under its parent without anybody creating a window for it; nothing creates or
  closes windows as a side effect of work starting or ending, except a job's own launch window (unchanged).
- The user can open any shown session (the holder window is made on demand) and closes rows themselves.
- Delete the heuristics: `displayParentID`, `resolveDisplayParents`, the `sessionReferences` DB task, the
  reconciler's display-parent refresh, observed-session adoption windows.

Non-goals: changing what a background **job** is (worktree, branch, result delivery, caps, pause/resume, lost-run
detection); terminal (claude-TUI) rows, which stay window-identified; showing inline foreground `task` children
as rows (they stay transcript-only, AGENTS.md TERMINOLOGY); multi-level rendering (the sidebar keeps "root row +
its descendants flattened" — unchanged).

## Design

### 1. The graph (server, one owner: `sessionStatus.mjs`)

`createSessionStatus` already holds the pieces: the running set (`listActiveSessionIds` + `running`/
`turnComplete` frames), parent edges (`childSession` frames + `resolveChain` reads of opencode's `parentID`),
job records, pending asks. It becomes the **one tree builder**; nothing else decides nesting, busy-beneath or
child counts (`sessionsWithActiveWork` / `runningChildCounts` read the same graph — `displayParentID` leaves
them too).

**Conversation nodes first.** A handoff chain is one node. `handoffEngine.chainOf(sid)` returns the chain as a
set; the **canonical member** is chosen deterministically: the member stamped on a window (lowest window index
when several, same project); else the chain's live end (follow `replacedBy` from the oldest member; a cycle
stops at the first repeat). Every session id below is canonicalised to its node before edges are read and
before cycle detection. A committed handoff therefore never moves a row: the predecessor's descendants were
already the node's.

**Edges** (child node → parent node), first that applies:

1. **Manta-owned job record** (`origin:"delegate"`, the current attempt — the record nothing supersedes):
   `childSessionID → parentSessionID`. This is the caller; `repointJobSessions` moves it onto a handoff
   successor at commit, which is the same node. (Adopted records are NOT an edge source: their
   `parentSessionID` holds the *display* ancestor resolved at adoption and their `sessionParentID` a copy of
   opencode's parent — rule 2 reads the source instead.)
2. **opencode `parentID`**: read once per candidate and cached (`parentOf`), kept fresh by
   `session.created{parentID}` / `childSession` frames. A `task` child, a job's V2 child, a resumed attempt.
3. **Explicit link** (§5): `child → parent` from `~/.manta/session-links.json`.
4. **Inferred (transition only, roots only)**: a node that would otherwise be a *windowless root* may take the
   windowed session whose transcript most recently named it within 24 h (today's `sessionReferences` task, same
   throttle). It exists so the cantina-style orchestrator keeps its nesting between stage (a) and the day its
   scripts call `session_link`; it is deleted in stage (c). It never applies to a session that has a rule-1/2/3
   parent, never to a job child, and its result is cached per node for the life of the process (a different
   answer later does not move the row).

No stored display parent. A cycle (impossible from rules 1–2, possible from a bad link file or two inferred
edges) breaks at the first repeated node on the walk from the child: that child becomes a root.

### 2. Which sessions are rows

**Exclusions come first.** A session is never a row, and edges pass through it, when it is: marked internal
(`metadata.manta.internal`: routine runs, title/compaction helpers, CTO inference sessions), the CTO
conversation (`isCtoConversationSession`), a provenance-internal session (`isInternalSession`), an uncommitted
handoff successor (`handoffEngine.isSuccessor`), or an **inline foreground `task` child** — a session whose
parent's current turn holds a non-background `task` tool block for it (the reconciler's existing rule (e),
`toolBlockFor`; an unreadable timeline keeps the session excluded, never shows it). These are exactly today's
adoption exclusions (`consider`, `delegate.mjs` ~4640–4680), applied before anything else.

Then a session is **shown** when any of:

- it is stamped on a tmux window — a *window row* (terminal windows have no session and are window rows too);
- it is the child of a live job record — `running`/`paused`, or terminal with `completionDelivery:"pending"` /
  `launchState:"uncertain"` — a *window row* if it has a window, else a *virtual row*;
- it is running, has a pending question / permission, or ended within `LINGER_MS` (30 s) — a *virtual row*;
- **structural retention**: it is an ancestor (by the edges above) of a shown session. A windowless root that
  went idle stays as a virtual row for as long as any descendant is shown, so the descendants are never
  promoted to roots and demoted again on its next turn.

Everything else is collapsed: edges pass through it.

**Nesting**: a shown session's parent in the tree is its nearest shown ancestor. A shown session with no shown
ancestor is a **root** of exactly one project: the tmux session of its window; else, for a job child, the
record's `tmuxSession` (`targetProject` is honoured); else the project whose directory contains the session's
directory (`ownerByDirectory`, its directory read with `parentID` and refreshed on `session.updated`); else it is
not shown. Nesting is **within one project**: a parent whose root lies in another project (a job sent to
`targetProject` by a caller elsewhere) makes the child a root of its own project. A root with no window is
labelled *driven from outside* (today's "started outside Manta").

**Ordering** (stable): roots keep today's order (window index; windowless roots after windowed ones, by first
time seen in this process). Beneath a root, descendants are flattened as today (`computeJobNesting`'s lift)
and ordered by window index for window rows, then virtual rows by first time seen; a row keeps its slot when
it is materialised (its first-seen time, not its new index, orders it until the list is rebuilt from a restart).
iOS keeps hiding descendants and showing the root's count (§3).

### 3. Wire

`tmux:list` / `sync:snapshot` projects gain `tree: SessionNode[]` (roots, in order):

```ts
type SessionNode = {
  key: string;                    // sessionId, or `win:<index>` for a terminal window
  sessionId: string | null;       // the conversation node's canonical member; null for a terminal window
  kind: "window" | "virtual";
  windowIndex: number | null;     // "window" only
  title: string;                  // window name, else opencode's session title
  job: { id: string; status: DelegateStatus; origin: string } | null;
  outside: boolean;               // a root with no window (driven from outside)
  children: SessionNode[];        // depth unlimited; clients flatten under the root
};
```

**Legacy projection, kept through (b):** `windows[].job.parentWindowIndex` is computed FROM the tree as the
index of the node's **root** when that root is a window row in the same project (exactly today's
`computeJobNesting` output — the top-level ancestor, not the nearest; a three-window chain A → B → C yields A
for both B and C), else `null`. Old desktop / iOS keep nesting as before. `windowStatus` frames are emitted
for every shown node with a session (today: windowed only); payload unchanged. `sessions.nesting` follows a
`sync` delta whose tree changed, as today.

**Client fallback:** a new client renders `tree` when present and falls back to `windows` +
`parentWindowIndex` when absent (old box). The compatibility matrix is untouched (wire major 1; fields only
added). What an OLD client loses against a new box, from stage (b): rows for running subagents that no longer
get adoption windows (it still sees job windows, nesting, counts of job children). That is accepted; the desktop
auto-updates and iOS ships (b) before (c). Tested in both directions (§8).

**Counts** (desktop badge, iOS "N background"): a root's count = its shown descendants that are running or have
a pending ask (window or virtual; lingering and pending-result nodes do not count). `busy` = any running
descendant (unchanged semantics, new graph).

### 4. Opening a virtual row

Click → `sessions:materialize({ sessionId })`:

- under the session's resource lock (`withSessionResources`, the same lock the launch / cleanup / handoff
  paths take), the box re-reads the tree; if the node already has a window it answers that one; otherwise it
  creates the holder window in the node's **root's project** (`newWindow({ chatMode:true, existingSessionId })`)
  and stamps it `@manta-owner=user`;
- it refreshes the project list (`syncState.refreshNow()`) BEFORE answering `{ project, windowIndex }`, so the
  client's `setActive` finds the window; the row keeps its tree slot (§2 ordering), pins and focus use the
  returned index.

Concurrent clicks resolve to one window (the lock + the re-read). A job finishing while a materialisation is in
flight sees `@manta-owner=user` on the window and leaves it (below).

**Who closes windows.** `finishV2CleanupLocked` / `cleanupTerminalJob` close only windows stamped
`@manta-owner=job` (a job's launch window — a worktree row, or a subagent/background-command record's window
made by a launch); a `user`-owned window is never closed by the box. Closing a `user` window of a session that
is still running (`sessions:close`) kills the window; the session is still running, so its row returns as a
virtual row (running work is never hidden). Closing a job row keeps today's semantics (`deleteJob`).

Keybinds (⌘1..9, ⌥⌘↑/↓, `flatSessions`) walk window rows only; a virtual row is reached by click.

### 5. Sessions driven from outside

An orchestrator that prompts a session through opencode's HTTP API creates no edge, so that session is a root
labelled *driven from outside*. To nest it the driver says so, with a manta plugin tool:

- `session_link({ sessionId })` — "nest `sessionId` under this conversation". Writes `child → caller` (both
  canonicalised) to `~/.manta/session-links.json` through `jsonStore.writeJsonAtomic` under its `createMutex`
  (serialised writers, atomic file). One parent per child, newest write wins. Refused when the child already has
  a rule-1/2 parent (those edges are authoritative) or when the link would close a cycle (walk from the caller
  to a root; the child must not be on it). `session_unlink({ sessionId })` removes it. A link whose parent or
  child session no longer exists is dropped on the next hydration.
- The guidance blurb tells orchestrators that drive sessions by script to call it once per session. The
  inferred rule (§1.4) covers them until they do, through stage (b).

### 6. What stops, and what happens to what exists

- `adoptExistingSession` no longer creates windows and `origin:"observed"` adoption is **retired** (its only
  product was a row, now derived). `origin:"subagent"` records stay (they carry the parent transcript's
  background card and result pairing) and are window-less until opened.
- **Existing records**: observed/subagent records already on a box keep settling through the V2 settlement
  (`reconcileV2Jobs` / `judgeLostRun` — lost-run detection is that sweep's, not the adoption reconciler's, and is
  unchanged); their windows are `job`-owned and close at finish as today; an inherited worktree they still hold
  keeps the record from pruning, as today. Their `parentSessionID`/`displayParentID` are dead data until
  retention prunes them. The active-session reconciler keeps only subagent adoption.
- `displayParentID`, `resolveDisplayParents`, `refreshDisplayParents`, the `displayParentID` branch of
  `repointJobSessions`, `sessionsWithActiveWork`/`runningChildCounts`' use of it, and (in (c)) the
  `sessionReferences` DB task are deleted.
- **Push labels**: `buildSessionLabel` resolves a stamped window; for a virtual session it falls back to
  `<workspace> / <root window name> › <session title>` from the tree, so a question in a subagent is still
  attributed to the conversation the user knows.

### 7. Hydration and invalidation

**Candidates** = every windowed session + every live job child + the running set + sessions with a pending ask
+ every link endpoint. `hydrate()` resolves the ancestry of every candidate (today it seeds only the running
set and running job children), reading `parentID`, `directory` and `title` once per session and caching them.

**Unknown is not root.** A failed/unknown read leaves the session's last-known placement; a candidate never read
successfully is placed by its job record (rule 1) or, failing that, as a root. Before the first hydration
completes, the tree is the windows + job-record projection (exactly today's output), never a confident
"everything is a root". Reads retry on the existing 1/2/5/10 s backoff; the live-during-hydration guard stays.

**Recompute** (coalesced, one tick) on: `running`/`turnComplete`/`attention` frames, `childSession` frames,
`delegate.updated` with a changed job signature, a handoff commit (`handoff.committed`), a link write, a window
list change (`sync` projects delta), `session.updated` carrying a directory move, and linger expiry (one timer
per lingering node). A recompute that changes the tree publishes the `sync` delta + `sessions.nesting`; status
frames go out for nodes whose payload changed.

### 8. Stages

(a) **Server tree + legacy projection + `session_link`.** `sessionStatus` builds `tree`;
`parentWindowIndex` is derived from it; the display-parent machinery is bypassed (not deleted); edges 1–4 live;
the tool and its guidance ship. Clients render as before. This alone removes the flapping: a job child's root is
its windowed ancestor whether or not the subagent between them has a window, and a windowless root is retained
while its descendants are shown. Acceptance includes the cantina scenario: a windowless API-driven root with a
`task` subagent that delegates, across ≥ 10 subagent turns — no `sessions.nesting` frame with a changed root.

(b) **Virtual rows + materialize; no adoption windows.** Desktop sidebar renders `tree` (fallback to
`windows`); `sessions:materialize`; `@manta-owner=user` rule; observed adoption retired; iOS counts from
`tree`, virtual roots shown as rows (tap → materialize).

(c) **Delete** `displayParentID`, the resolver, the refresh, the inferred edge and `sessionReferences`; the
record field is removed from the wire types.

(a) and (b) are one PR each; (c) after (b) has shipped on both clients.

### 9. Tests

- `sessionStatus.test.mjs` (pure tree): collapse through an idle subagent; an inline foreground `task` child
  is never a row and edges pass through it; a chain is one node and the canonical member is stable across a
  commit; a job child under a windowless subagent has its windowed ancestor as root with or without a window
  for the subagent; structural retention (root idle > `LINGER_MS`, child running → root retained; both gone
  after the child ends + linger); root placement by window, then job `tmuxSession`, then directory; cross-project
  parent → own root; cycle from a bad link → root; stable ordering across materialisation; `parentWindowIndex`
  equals today's `computeJobNesting` for every windowed case (A → B → C yields A for both) — property test
  over the existing fixtures; counts and busy from the graph.
- Hydration: cold boot before any read (projection only), a failed read keeps placement, reconnect, a
  handoff successor never shown while uncommitted.
- `delegate*.test.mjs`: adoption creates no window; `repointJobSessions` without the display branch; cleanup
  never closes a `user`-owned window; subagent records unchanged.
- `rpc.test.mjs`: `sessions:materialize` — creates once under the lock; two concurrent calls → one window; a
  session that gained a window returns it; refused with no owning project; the list is refreshed before the
  answer. `session_link` / `session_unlink`: refusals (authoritative edge, cycle), newest-wins.
- Renderer: `tree` rendering, fallback to `windows`, click materializes and selects, keybinds skip virtual
  rows, pins survive materialisation. iOS: counts from `tree`; virtual roots as rows.
- Compat: new client × old box (fallback), old client × new box (job rows + nesting unchanged).
- Live, before (c): cantina's tree across 10 subagent turns, no changed-root frames.

## Libraries considered

| Need | Chosen | Considered / why rejected |
|---|---|---|
| Session graph (edges) | opencode's own session records + `childSession` events, already read by `sessionStatus` | nothing external applies; the data is opencode's |
| Tree derivation (canonicalise, collapse, roots, flatten, cycle break) | ~120 lines in `sessionStatus.mjs`, pure | `graphology` 0.26.0 (2025-01-26, MIT, 1 dep, 2.4M weekly downloads, 1.8k★, pushed 2026-11-05): a general graph model + algorithms. We need one bounded parent-walk over ≤ a few hundred edges with domain rules (exclusions, retention, project ownership) at every step; the algorithms it offers (traversal, components) are not the hard part and the rules would still be ours. Not worth a runtime dependency on the box |
| Durable link store | `src/server/jsonStore.mjs` (`readJsonSync` / `writeJsonAtomic`: temp-file + rename, parent dir created; `createMutex` for serialised writers) — the repo's one store primitive, used by every `~/.manta/*.json` store | `lowdb` 7.0.1 (2023-12-26, MIT, 1 dep, 2.2M/wk): same temp-file write, no cross-call mutex, adds an adapter layer for a ~20-line file; `conf` 16.0.0 (2026-10-12, MIT, 9 deps, 25M/wk): Electron-oriented, schema/migrations/encryption we don't need. The existing primitive already gives atomicity + serialisation; a second store library would mean two write paths on the box |
| Sidebar rendering of nested rows | existing `Sidebar.tsx` rows (flattened children) | `@headless-tree/react` 1.8 (already in the repo for the Explorer): built for deep expandable trees with its own keyboard model; the sidebar is a flat list with an indented band and app-level keybinds (⌘1..9, ⌥⌘↑/↓); adopting it means re-doing those for no visible gain. Revisit if a real expandable tree is wanted |
| Session title / directory for a virtual row | opencode's session record (read once with `parentID`) | — |

## Decisions (r2)

- The transcript-inference edge survives through (b) as a roots-only, cached, lowest-precedence rule, and is
  deleted in (c) once `session_link` is in use (Astra #4).
- Inline foreground `task` children stay transcript-only; the tree reuses the adoption exclusions (Astra #8).
- iOS shows virtual roots as rows in (b) (count-only had nowhere to put the count) (Astra #11).
- A finished `subagent` record's virtual row vanishes after `LINGER_MS`; the transcript card is the durable
  surface.

## Open questions

1. `LINGER_MS` = 30 s: enough for the loop-prompted subagent case? (Retention makes it cosmetic for anything
   with running descendants.)
2. Should `session_link` be callable by the CTO work tools (`work_dispatch`) to nest a worker under the work
   item's conversation? Out of scope here; noted.
