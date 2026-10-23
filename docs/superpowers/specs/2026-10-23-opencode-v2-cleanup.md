# OpenCode V2 — the cleanup phase (master plan Phase 6 + 7.2)

Status: **draft 2026-10-23** · Base: `origin/main` @ `03d2e2c6` · opencode pinned **2.0.30**
Supersedes the "Phase 6 deletions" paragraph at the end of
`docs/superpowers/specs/2026-10-16-opencode-v2-cutover.md`.

The cutover (C1–C4) put the box on V2 but deliberately kept several V1-era workarounds
running on top of it. This spec replaces them with V2's own features and deletes the dead
code. It also adds the "reclaim disk space" action from master plan §7.2.

## 0. What was checked, and what is NOT in scope

Verified on `main` before writing this (code reads + live probes against the box's 2.0.30):

| Master-plan Phase 6 item | State on main | This spec |
|---|---|---|
| Abort-based queue drain | **Still live** on desktop (`useSseBus.ts` drain-abort at tool boundaries + idle-drain effect) | §2 replace with native steer + server inbox |
| Delta flush buffer | **Already gone** from the live path (`streamInterp.mjs`: "V2 deltas are phrase-level: no buffering"). `findFlushBoundary` / `FLUSH_MAX_AGE_MS` survive as dead exports | §5 delete dead code |
| Per-device model override | **Already done** (BET-1281: box-backed `modelPrefs`; Auto is desktop-local by design, BET-1287) | none |
| Status guessing | Server observers use the lifecycle adapter (fine). `peers.mjs` `classifyChatStatus` still guesses "working" from the transcript tail | §4 use `GET /api/session/active` |
| Slash-command display | **Broken.** V2 emits no `command.executed`; `GET /api/command` returns no `template`, so the template-prefix fallback can't match either. A `/review` turn shows the full expanded template as the user's message (probed live 2026-10-23) | §3 server-side command-origin record |
| Reclaim disk space (§7.2) | Not built | §6 copy-mode only |

Out of scope (follow-ups, listed in §9): iOS adopting native steer/inbox; server-originated
deliveries (`promptDelivery`, schedules, webhooks, peers) using `delivery:"queue"`; removing
the V1-compat lifecycle adapter; the CTO admission engine; in-place-mode reclaim.

**Open PR to coordinate with:** #1607 (`fix/skill-slash-commands`) edits `sendPrompt` /
`runCommand` / `listCommands` in `src/server/opencode.mjs`. If it merges first, rebase onto
it; if not, keep edits to those functions minimal and additive so either order merges.

---

## 1. Pinned contracts (code against these, not against each other's code)

**K1 — prompt delivery.** The RPC inputs of `opencode:prompt` and `opencode:run-command`
gain an optional `delivery?: "steer" | "queue"`. Client signatures (`src/shared/api.ts`):
- `opencodePrompt(sessionId, text, model?, attachments?, mentions?, agent?, opts?: { delivery?: "steer" | "queue" })`
  — a new 7th positional param; every existing caller is untouched. `httpApi.ts` packs it
  as `{ ..., delivery: opts?.delivery }`.
- `opencodeRunCommand(input)` — `input` gains `delivery?: "steer" | "queue"`.

Server: for ordinary sessions `delivery` goes straight to V2 (`POST /api/session/{id}/prompt`
/ `.../command` body field `delivery`). **When `delivery` is set, `sendPrompt` /
`runCommand` skip `syncSessionControls` entirely** — a steered message never switches the
session's model or agent mid-turn (today's omitted-agent rule would otherwise flip a plan
turn back to build). The composer's model/agent choice applies from the next idle send.
For CTO conversation sessions (the `ctoConversation.isConversationSession` branch in
`rpc.mjs`) `delivery` is **dropped** before `admitDirect` / `admitCommand` — admission owns
ordering there.

`sendPrompt` must always post a message `id`: the caller's `messageID` when given, else a
freshly minted one (V2 requires `^msg_`; reuse whatever generator the composer's
optimistic messageID / the admission path already uses — `ctoAdmission.mjs` mints
`msg_${randomUUID()}`). It registers the id in a per-session set ("our prompt ids")
**before** the POST, and the id stays there until its `session.inbox.enqueued` is observed
(then it is retired) or the POST fails with a definitive 4xx (removed). There is no time
expiry; an id still unobserved after 10 minutes is retired with a log line AND marks the
session ineligible for command correlation (§3) until it next goes idle. The smoke (§8)
must confirm transcript order is unchanged with minted ids.

**K2 — inbox item shape** (shared type `OpencodeInboxItem` in `src/shared/types.ts`):
```ts
type OpencodeInboxItem = {
  id: string;                 // the inbox id === the user message id it will become
  text: string;               // payload.text
  delivery: "steer" | "queue";
  createdAt: number;          // time.created (ms)
  attachmentCount: number;    // payload.files.length (0 when absent)
};
```
Only `type: "user"` inbox entries are surfaced. Synthetic / compaction / move entries are
never shown to clients.

**K3 — `inbox` stream frame.** New sub `"inbox"` added to the stream sub union in
`src/shared/types.ts`:
`{ sub: "inbox", sessionId, payload: { epoch: string, rev: number, items: OpencodeInboxItem[] } }`
— always the FULL current list of pending user items for that session, oldest first (empty
list = nothing pending). `epoch` is a random id minted once per manta-server process; `rev`
is a per-session counter within that epoch that increases on every change.

**Client acceptance rule** (S2, pure + tested): for each session keep `{epoch, rev}` of the
payload shown, plus a client-wide set of **retired epochs**. A frame or RPC result with the
SAME epoch replaces it only if its `rev` is higher. One with a new, non-retired epoch
replaces it (a restarted server is newer by definition) and the previous epoch is added to
the retired set; a payload from a retired epoch is always dropped. An RPC response is also
dropped if it was requested before the most recent
`resync` (the client-synthesised events-reconnect frame) — that is what stops a late
answer from a dead server overwriting the new one. On `resync` the client refetches with
`opencode:inbox`.

The **interpreter is the single source of truth**; clients never build the list from raw
events. Server algorithm (pure, unit-tested in isolation):
- A session's snapshot is either `unknown` or `known`. It becomes `known` only by
  **hydration**: `GET /api/session/{id}/inbox`. Hydration is triggered by the first inbox
  event for an unknown session, by `opencode:inbox` for an unknown session, and for every
  known session on reconnect resync (`resyncAfterReconnect`), which resets them to
  `unknown` first. One hydration in flight per session (shared promise).
- While a hydration is in flight, inbox events for that session are appended, **in
  arrival order**, to a window log. When the GET returns: start from its items (V2 orders
  them by enqueue sequence), then replay the window log in order with the same rules as
  the `known` state below. Replay is idempotent: an `enqueued` id already present is
  ignored; removing an absent id is a no-op; `delivery.changed` sets the value (last one
  wins). Then `rev++` and emit.
- A disconnect of the event stream while a hydration is in flight invalidates it: its
  result is discarded and the session stays `unknown` (the reconnect resync re-hydrates).
- Once `known`: `enqueued` (user items, from `data.item`) appends to the end;
  `delivered` / `cancelled` (by `data.inboxID`) remove; `delivery.changed` sets the
  item's delivery — each `rev++` + emit.
- A failed hydration leaves the session `unknown`, emits nothing, and is retried on the
  next trigger.
It is additive for iOS: the implementer must confirm every Swift `switch` over frame subs
falls through to a `default:` that ignores unknown subs (`MantaEventStore.swift`,
`ChatSessionStore.swift`).

**K4 — inbox RPCs** (new channels in `rpc.mjs`, methods on `Api` + `httpApi.ts`):
- `opencode:inbox` `(sessionId)` → `{ epoch: string, rev: number, items: OpencodeInboxItem[] }` — the
  interpreter snapshot (hydrating first if `unknown`), never a raw pass-through.
- `opencode:inbox-cancel` `({ sessionId, id })` →
  `{ outcome: "cancelled" | "delivered" | "unknown", item?: OpencodeInboxItem }`.
  V2's DELETE is a 204 no-op for an item that is no longer pending, so "absent afterwards"
  proves nothing. The outcome is decided from **authoritative evidence only**:
  `cancelled` iff the interpreter observes `session.inbox.cancelled` for that id (wait up
  to 3 s after the DELETE returns); `delivered` iff it observes `session.inbox.delivered`
  for that id, or `GET /api/session/{id}/message/{id}` finds the message; otherwise
  `unknown`. `item` (the pre-cancel copy from the snapshot) is returned only with
  `cancelled`. Only `cancelled` lets a client restore text.
Both are refused for CTO conversation sessions with a clear error (`"not available for the
CTO conversation"`), never a silent empty result.

**K5 — user interrupt resumes steered input.** `opencode:abort` (the user's Esc / stop
button) calls `POST /api/session/{id}/interrupt?resume=true`. Per the V2 API description,
V2 then runs pending *steering* input and keeps *queued* prompts parked — matching today,
where Stop ends the turn and the queued message goes out next. Every **internal** caller of
`abortSession` (seat retry watch, delegate pause, admission, usage stop, CTO) keeps
`resume=false`: add `interruptSession(sessionId, { resume, signal })` and keep
`abortSession` as the `resume:false` wrapper. The desktop's existing "Aborted" notice on a
user Stop is unchanged (it is shown today and stays shown).

**K6 — command origin on the message model.** User messages produced by a slash command
carry `info.command?: { name: string; arguments: string }` in the `{info, parts}` shape
returned by `opencode:messages` / `opencode:message`. The live `commandExecuted` frame
(existing sub, payload `{messageID, name, arguments}`) is emitted again, from the server.

**K7 — reclaim API** (served next to `/api/upgrade` in `upgradeV2.mjs`, auth required):
- `GET /api/upgrade/reclaim` →
  `ReclaimStatus = { available: boolean, reason: string | null, mode: "copy" | "in-place" | null, bytes: number | null, state: "none" | "running" | "failed" | "done" }`
- `POST /api/upgrade/reclaim` → `ReclaimResult = { ok: true, freedBytes: number } | { ok: false, error: string }`
- Client (`src/shared/api.ts` + `httpApi.ts`, next to the existing `upgradeStatus` /
  `upgradeAction`): `upgradeReclaimStatus(): Promise<ReclaimStatus | null>` (`null` when
  the box answers 404 — it predates the route) and `upgradeReclaim(): Promise<ReclaimResult>`
  (never rejects on a refusal or network error, same rule as `upgradeAction`; a 401 throws
  `AuthRequiredError` like the rest).

---

## 2. Native steer + server inbox (replaces the abort drain)

### Behaviour (what the user sees — must match today unless stated)
- Sending while the agent is working delivers the message **into the running turn** at its
  next step (V2 `steer`), instead of aborting the turn at a tool boundary and resending.
  Net effect for the user is the same "the agent reads my message without waiting for the
  whole turn", minus the hidden abort.
- Pending messages are listed in the existing "⏳ queued" ambient card, now sourced from
  the `inbox` frame (so they survive a reload and appear on a second desktop). Each row has
  an **×** that cancels it (K4). The existing "pop the last queued message back into the
  composer" gesture becomes: cancel the newest pending item; on `outcome:"cancelled"` put
  its text back in the composer; on `"delivered"` say "Already sent to the agent"; on
  `"unknown"` say "Couldn't confirm it was cancelled — it may still be sent" and restore
  nothing (restoring could make the user send it twice). If a cancelled item had
  attachments, the composer also shows "Attachments weren't restored — re-attach them".
- Esc / stop while messages are pending: K5 — the turn stops ("Aborted" notice as today),
  the pending steered message runs next.
- A pending **question** card when the user sends from the composer: today the drain
  rejects pending questions before resending. Keep that, but awaited: a new
  `rejectPendingQuestions(): Promise<{ ok: boolean; error?: string }>` rejects the CURRENT
  session's pending questions only (same filter as today's helper), awaits every request,
  and removes a card only once its rejection succeeded. On any failure the message is NOT
  sent, the composer keeps its text and attachments, and the error is shown. A question
  that arrives after the rejection pass is left for the user. A pending **permission** is
  left alone; the message stays pending until the permission is answered.
- **Busy send is its own path**, not today's idle `submit()` (which optimistically sets
  running, clears the composer and sets running false on failure):
  - text / attachments / @-mentions → `opencodePrompt(..., { delivery: "steer" })`;
    `/name args` for an opencode command → `opencodeRunCommand({ ..., delivery: "steer" })`.
  - **Local** slash commands (`/clear`, `/fork`, `/compact` and every other command the
    composer handles itself) are refused while running with a visible message ("Stop the
    agent or wait for it to finish before /clear") — never run mid-turn, never dropped
    silently.
  - It never changes `running`. Send is disabled while a busy send is in flight (one
    in flight per panel; a second Enter is ignored with no side effect). The submitted
    draft (text + attachment list) is captured at submit; on success the composer is
    cleared only if it still holds exactly that draft — otherwise only the submitted
    attachments are removed and the user's newer text is left alone. On failure nothing is
    cleared and the error is shown.
  - No optimistic transcript row: the pending card shows the message until delivery.
  - Model / agent pickers are not applied to a steered message (K1); they apply from the
    next idle send.

### Server (S1)
1. `sendPrompt` / `runCommand`: forward `delivery`, skip `syncSessionControls` when it is
   set, always post an id + record "our prompt ids" (K1). Thread `delivery` through
   `rpc.mjs` per K1.
2. `interruptSession` + `abortSession` wrapper per K5; `opencode:abort` uses `resume:true`.
3. `listInbox(sessionId)` and `cancelInboxItem(sessionId, id)` in `opencode.mjs` (V2
   `GET /api/session/{id}/inbox`, `DELETE /api/session/{id}/inbox/{inboxID}`); RPCs per K4.
4. `streamInterp.mjs`: the K3 snapshot state machine (hydration via an injected
   `listInbox`, window log, `rev`) + `inbox` frame + the K4 cancel-outcome wait. Event
   fields: `session.inbox.enqueued` → `data.inboxID`, `data.item`; `.delivered` /
   `.cancelled` → `data.inboxID`; `.delivery.changed` → `data.inboxID`, `data.delivery`
   (from `docs/opencode-v2/spikes/round1-b.md` B1/B2 — confirm against the recorded corpus
   in `src/server/fixtures/opencodeV2Events/` and the smoke; correct the spec if V2 differs).
   Existing `messageChanged` emission on `delivered` stays. `resyncAfterReconnect` resets
   known sessions' inbox to `unknown` and hydrates them.
5. `src/server/push.mjs`: the `MessageAbortedError` early-return stays (the lifecycle
   adapter still emits it for interrupts); only fix comments that cite the deleted renderer
   drain.

### Desktop renderer (S2)
Delete, with their tests: `messageQueue` / `setMessageQueue` / `messageQueueRef`,
`drainAbortRef`, `maybeDrainQueuedPrompt`, the `[running, messageQueue]` drain effect,
`shouldAbortForQueuedDrain`, renderer `isToolStepBoundary`, `isDrainAbortError` and every
call site (`chatUtils.ts`, `useSseBus.ts`, `ChatPanel.tsx`). Replace with:
- `inboxItems` state per session, set from the `inbox` frame, seeded by `opencode:inbox`
  on open and on `resync`.
- `inboxItems` follows the K3 client acceptance rule; a response or frame for a session
  that is no longer the panel's session is dropped.
- The busy-send path per §2 behaviour; idle submit is unchanged.
- `rejectPendingQuestions` (awaited) replaces the fire-and-forget drain call.
- The ambient card + pop-last + × per §2 behaviour. Every branch of every action is
  reported (AGENTS.md "never stub a control").
- The "Aborted" notice on a user Stop stays exactly as today; only the drain-generated
  abort suppression (`isDrainAbortError`) goes, because nothing issues that abort any more.
`src/server/delegate.mjs` keeps its own `isToolStepBoundary` (delegate pause uses it via the
lifecycle adapter) — update its "mirrors the renderer" comment only. That file is S1's.

---

## 3. Slash-command origin (server-side record)

Problem (probed live): `POST /api/session/{id}/command {name:"review", text:"HEAD~1"}`
stores a plain user message whose `text` is the expanded template, with no metadata, and
`Command.Info` has only `{name, description}`. Nothing on V2 says "this came from /review".

### Server (S1)
1. New module `src/server/commandOrigins.mjs` (pure core + injected I/O, own test):
   durable map `messageID → { name, arguments, sessionId, at }` in
   `statePath("command-origins.json")`, atomic writes, capped at 5,000 entries and 90 days
   (oldest evicted first).
2. **Why correlation is sound here — a closed set of writers.** A `user`-type inbox item
   can only be created by an HTTP client holding the opencode password (`OPENCODE_PASSWORD`,
   loopback-only, known to manta-server and the service). Plugins' subagent results arrive
   as `synthetic` items and are excluded. So every user enqueue on the box comes from
   manta-server, and manta-server knows the id of every one it creates — except the one a
   `/command` POST creates. This holds only if **every** manta-server `/prompt` POST carries
   an id recorded in "our prompt ids": `sendPrompt`, the second prompt POST in
   `opencode.mjs` (~line 1161, the generate/throwaway path) and the upgrade verify turn in
   `upgradeV2.mjs` (runs only in upgrade mode, before cutover — it is exempt, but the
   window logic must not run during upgrade mode). S1 adds a test that greps
   `src/server/**/*.mjs` for `/prompt` POST sites and fails if a new one appears outside
   the recording helper. If the user opens opencode's own web UI with the password, the
   heuristic can mis-tag a message typed there during a command window — accepted, stated
   in a code comment.

   **Correlation rule — tag only when unambiguous, otherwise leave untagged** (an untagged
   command message just shows its full text, i.e. today's behaviour). `runCommand` (the
   single chokepoint; the CTO `admitCommand` path also ends there) opens a **command
   window** for the session when its POST starts and closes it 3 s after the POST returns.
   The pump (`index.mjs`, raw V2 events, before the interpreter) collects every
   `session.inbox.enqueued` user item for that session during the window whose id is NOT
   one of our prompt ids. At window close: exactly one such id → record it; zero or more
   than one → record nothing and log one line.

   **Eligibility — a window may only tag if nothing earlier is unresolved.** A session is
   *eligible* when it has no registered-but-unobserved prompt ids from before the window
   opened and no earlier command window that closed with zero unexplained enqueues (a
   late enqueue from that command could land in this window). An earlier zero-result
   command keeps the session ineligible until the session next goes idle (lifecycle
   `session.idle`), at which point every earlier submission has necessarily been enqueued.
   An ineligible window records nothing. Tests: delayed enqueue of command A arriving in
   command B's window (B untagged); a prompt whose enqueue is still unobserved when a
   command starts (command untagged); a prompt retired at 10 minutes (session ineligible
   until idle).

   **Empirical check required before relying on it:** the smoke runs 20 commands (each interrupted as soon as it starts, to keep cost down) and
   records, for each, whether its user enqueue arrived before the POST's 204 and how many
   user enqueues it produced. If any run shows more than one enqueue, or an enqueue later
   than 3 s after the response, stop and report — do not ship the tagging.

   Additionally record nothing if:
   - two command windows overlap on the same session (both stay untagged);
   - the event stream disconnected at any point during the window;
   - the POST failed.
   On a successful tag, the interpreter emits `commandExecuted {messageID, name, arguments}`.
   The smoke must confirm the command's user message actually passes through
   `session.inbox.enqueued` (if V2 writes it some other way, stop and report — do not
   invent a different correlation).
3. Message mapper (`listMessages` / `getMessage` → `{info, parts}`): stamp `info.command`
   (K6) on user messages whose id is in the record.
4. Skills dispatched as prompts (PR #1607) already show `/skill args` as their text — they
   are NOT recorded.
5. Tests: concurrent prompt + command on one session (tag only the command), a foreign
   enqueue in the window (untagged), overlapping commands (untagged), failed POST, event
   arriving after the POST returns but inside the 3 s, event arriving after the window
   (untagged), disconnect during the window (untagged).

### Desktop renderer (S2)
`userCommandInfo` in `ChatPanel.tsx`: prefer `info.command`, then the live
`commandByMessageId` map (unchanged). Delete `detectCommandFromText` / `commandPrefixKey` /
`MIN_COMMAND_PREFIX_LEN` and the template-prefix fallback (dead on V2: no templates), and
the `template` field's "retroactive detection" comment on `OpencodeCommand`.

---

## 4. Running state from V2 (S1)

`peers.mjs`: `classifyChatStatus(messages, permissions, questions, active)` — `active` is
`true | false | undefined`. Blocked states still win. When `active` is a boolean it decides
working vs idle; when `undefined` (the active-set read failed) fall back to today's
transcript heuristic. `listPeers` / `inspectPeer` read `oc.listActiveSessionIds()` ONCE per
call (injected dep, failure → `undefined`). Update the "server keeps no live running flag"
comment.

---

## 5. Dead-code deletion

- S1: `src/shared/streamInterpretation.mjs` (+ `.d.mts`, tests): `findFlushBoundary`,
  `FLUSH_MAX_AGE_MS` and their comment block. `mergeBufferedDeltas` stays (used by
  `applyStreamFlush`).
- S2: their re-exports + tests in `src/renderer/chatUtils.ts` / `chatUtils.test.ts`.
- S2: `AGENTS.md` — rewrite the "Queued message drain", "Buffered text-delta streaming"
  and the `command.executed` bullets to describe the V2 behaviour (steer + inbox,
  phrase-level deltas, server-side command origin). Delete the "do NOT duplicate the drain
  effect" and "ordering inside the drain effect" paragraphs (the code is gone).

---

## 6. Reclaim disk space (copy mode only) — S3

After a copy-mode migration the untouched V1 history (tens of GB on real boxes) and the
kept V1 binary exist only for rollback. Deleting them is a one-way, user-initiated choice.

### Server
The state file supplies the deletion targets, so it is NOT trusted to also prove they are
safe to delete. Safety comes from independent checks, and every uncertainty fails closed.

1. **Live DB identity, taken from the RUNNING opencode process** — not from the state file
   and not from the service definition (which can be edited without a restart, and launchd
   can run a stale loaded copy). Find the running opencode PID: systemd →
   `systemctl --user show opencode-serve -p MainPID`; launchd → `launchctl list` for the
   opencode label; nohup → unavailable (no reliable PID; reason "Couldn't confirm which
   database is in use"). Read the set of files that process has open: Linux →
   `/proc/<pid>/fd` symlinks; macOS → `lsof -Fn -p <pid>`. The live DB is the open file
   whose basename matches `opencode*.db` (exactly one, else unavailable). Any failure → not
   available. The reclaim **also** refuses if any allowed target (by `dev, ino`) appears in
   that open-file set.
2. **Allowed targets — a closed list, nothing else is ever deleted:** `V`, `V-wal`, `V-shm`
   where `V = realpath(state.v1Db)`, and `realpath(~/.opencode/bin/opencode-v1)`. Each target
   must: have basename exactly `opencode.db` / `opencode.db-wal` / `opencode.db-shm` /
   `opencode-v1`; for the DB files, live in the same directory as the live DB (after
   realpath); be a regular file (`lstat` of the unresolved path is not a symlink, and the
   resolved path is a regular file); and differ from the live DB and its `-wal` / `-shm`
   both by realpath AND by `(dev, ino)`. Any check failing → not available, nothing
   deleted. These checks run when building the manifest (step 4); a resumed reclaim uses
   the manifest and never re-resolves deleted paths.
3. **Availability** (`GET`): migration `state === "completed"`, `mode === "copy"`, no
   upgrade/retry/rollback in progress, `reclaim.state` not `done`, at least one allowed
   target present. `bytes` = sum of present targets. `reason` is a plain sentence when not
   available ("Only available after the upgrade finishes", "This box migrated in place;
   reclaiming space isn't supported yet", "Already reclaimed", "Nothing to reclaim",
   "Couldn't confirm which database is in use"). `state` mirrors `reclaim.state` (`none`
   when absent).
4. **Durable, resumable reclaim** (`POST`): serialized with the upgrade engine's own lock
   (no reclaim while retry/rollback runs, and vice versa). First run (`reclaim` absent):
   run steps 1–2, then persist a **manifest** BEFORE the first deletion:
   `reclaim: { state: "running", startedAt, targets: [{ path /* canonical */, dev, ino, size, removed: false }] }`.
   Delete targets one by one; after each, set `removed: true` and persist. All removed →
   `state: "done"`, `doneAt`, `freedBytes`. Any error → `state: "failed"`.
   **Resume** (`reclaim.state` is `running` from a crash, or `failed`): never re-derive
   targets. The persisted manifest is as untrusted as the rest of the state file. For each
   not-yet-removed manifest entry: missing (`lstat` ENOENT) → mark removed; present → it
   must pass ALL of step 2's allowlist checks again against a freshly determined live DB
   (step 1; if step 1 fails, stop with `failed`) — basename, same directory as the live DB
   (or the exact `~/.opencode/bin/opencode-v1` path), regular non-symlink file, not the live
   DB or its sidecars by realpath or `(dev, ino)`, not in opencode's open-file set — AND
   still have the manifest's `(dev, ino)`; otherwise stop with `failed` and a message
   naming the file. Add a forged-manifest test (an unrelated file with its real inode
   written into the manifest → refused). When every entry is
   removed → finalize `done`. On load, a `running` reclaim is reported as `failed` (so the
   user sees Retry), and `GET` stays `available` while `state` is `failed` with remaining
   entries — or with every entry removed but `done` not yet recorded, so a retry finalizes.
   Never stops opencode.
5. **Rollback is refused from the first destructive step**: once `reclaim` exists in any
   state, `POST /api/upgrade/rollback` answers
   `{ok:false, error:"Rollback is no longer possible: the old history was deleted to free space."}`
   without touching anything.
6. Deps (fs incl. realpath/lstat/stat/unlink, running-PID lookup, open-file reader, home
   dir, paths) injected like the rest of `upgradeV2.mjs`. Tests: every availability reason;
   state file pointing `v1Db` at the live DB (same path, symlinked parent, hard link / same
   inode); a target with a wrong basename or outside the DB dir; a symlink target; PID or
   open-file set undeterminable (incl. nohup); a target held open by opencode; configured
   service env disagreeing with the running process (the running process wins); partial
   failure then retry; crash after the last unlink but before `done`; a manifest entry
   replaced by a different file (different inode → refused); rollback refused in each
   reclaim state; reclaim refused while a rollback runs. One integration test on the REAL
   filesystem inside a temp dir with home, PID lookup and open-file reader injected to
   point only at fixture files; before every unlink the test-mode deps assert the path is
   inside that temp root.

### Desktop (Settings)
A "Old conversation history (from before the OpenCode 2 upgrade)" row in Settings →
About, under the box update rows, shown only when `available` (AGENTS.md outcome 3 — no
dead control). Text shows the size ("34 GB"). Button **Delete to free space** → confirm
dialog: "This frees 34 GB. Your conversations are already in the new format and are not
affected. You will no longer be able to roll the box back to the old version." On success
a confirmation naming the freed size and the row disappears; on failure an error with the
server's message. Reaches the server the same way the renderer already reaches
`/api/upgrade` (follow the existing upgrade-gate client; add `Api` methods if that is the
pattern).

---

## 7. Slices and ownership

| Slice | Owns | Must not touch |
|---|---|---|
| **S1 server** | `src/server/opencode.mjs`, `streamInterp.mjs`, `rpc.mjs` (opencode channels), `index.mjs` (pump + resync only), `peers.mjs`, `push.mjs` (comments), `delegate.mjs` (comment), new `commandOrigins.mjs`, `src/shared/streamInterpretation.mjs` (+`.d.mts`), `src/shared/types.ts` (K2/K3/K6 types + IPC channel names), `src/shared/api.ts` (K1/K4 signatures), `scripts/opencode-v2/c1-smoke.mjs`, their tests/fixtures | `src/renderer/**`, `mobile/**`, `upgradeV2*.mjs`, `AGENTS.md` |
| **S2 desktop** | `src/renderer/**` (incl. `httpApi.ts` for K1/K4) except the reclaim pieces below, `AGENTS.md` | `src/server/**`, `src/shared/**`, `mobile/**` |
| **S3 reclaim** | `src/server/upgradeV2.mjs` (+ test), `upgradeV2Service.mjs` (read-only helper additions only), the K7 types + `Api` methods in `src/shared/api.ts` (one block next to `upgradeStatus`), the two K7 functions in `httpApi.ts` (one block next to `upgradeAction`), the Settings reclaim row | everything else |

Implementers run in parallel in separate worktrees off `feat/opencode-v2-cleanup`; the
orchestrator merges S1 → S3 → S2. The shared files touched by two slices (`api.ts`,
`httpApi.ts`) are edited in disjoint, pinned blocks only. S2 codes against K1–K6 as
written; its tests use fakes of those shapes, and it may not edit `src/shared/**` — if a
shape it needs is missing, it reports that instead of adding it.

## 8. Verification (each slice, before reporting done)

- `npm run typecheck` and `npm test` green (both suites). Any failing test must be shown to
  fail identically on `origin/main` in a throwaway worktree before it is called unrelated.
- S1 live: extend `scripts/opencode-v2/c1-smoke.mjs` (pinned 2.0.30 sandbox, Haiku,
  `ANTHROPIC_API_KEY="$(cat <path from secret_provide>)"`, never the live :4096/:8787) with:
  (a) steer mid-turn → `inbox` frame with 1 item → delivered within the same execution →
  `inbox` empty; (b) a `queue` item + cancel → `outcome:"cancelled"`, and cancel after
  delivery → `outcome:"delivered"`; (c) Esc with a pending steer item →
  `interrupt?resume=true` → the item runs as the next turn; Esc with an empty inbox leaves
  the session idle; (d) a slash command → its user message passes through
  `session.inbox.enqueued`, `commandExecuted` frame, `info.command` on refetch; a plain
  prompt sent during the same window is NOT tagged; (e) a pending question + composer send
  (reject then steer) → the turn continues and reads the message; (f)
  `listActiveSessionIds` contains the session mid-turn and not after; (g) a steered send
  after a plan-agent turn does not switch the agent; (h) transcript order with minted
  prompt ids matches send order.
  If any V2 behaviour the spec assumes turns out different, stop and report it rather than
  working around it silently.
- S2: vitest for the new inbox reducer / pop-last / cancel branches; the renderer harness
  (`tests/visual/`) still passes; `npm run build` succeeds.
- S3: the unit + temp-dir integration tests in §6.6. **No manual run against this box's
  real files**: never call the reclaim route on the dev box, never point any dependency at
  the real `~/.manta`, `~/.local/share/opencode` or `~/.opencode`. A read-only
  `GET /api/upgrade/reclaim` against a sandboxed manta-server is fine.

## 9. Follow-ups (not this spec)

1. iOS (`mobile/native`): adopt `delivery:"steer"` + the `inbox` frame instead of its
   client-side outbox + idle drain. iOS keeps working unchanged meanwhile: it never posts
   mid-turn.
2. Server-originated prompts (`promptDelivery` defer-until-idle, schedules, webhooks,
   peers, delegate completion notices) could send with `delivery:"queue"` and drop the
   defer machinery.
3. Retire the V1-compat lifecycle adapter (`createLifecycleAdapter`) by moving each
   observer onto V2 events directly.
4. Reclaim for in-place migrations (drop V1 tables + `VACUUM`, needs opencode stopped and
   free space ≈ DB size).
5. V2 "saved permissions" (`GET/DELETE /api/permission/saved`) management in Settings.
