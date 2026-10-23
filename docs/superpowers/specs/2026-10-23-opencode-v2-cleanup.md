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

**K1 — prompt delivery.** `opencode:prompt` and `opencode:run-command` inputs gain an
optional `delivery?: "steer" | "queue"`. For ordinary sessions the server passes it
straight to V2 (`POST /api/session/{id}/prompt` / `.../command` body `delivery`). For CTO
conversation sessions (the `ctoConversation.isConversationSession` branch in `rpc.mjs`)
the field is **dropped** before `admitDirect` / `admitCommand` — admission owns ordering
there. `src/shared/api.ts` input types gain the field.

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
`src/shared/types.ts`: `{ sub: "inbox", sessionId, payload: { items: OpencodeInboxItem[] } }`
— always the FULL current list of pending user items for that session, oldest first (an
empty list means "nothing pending"). The interpreter keeps a per-session snapshot and
re-emits it on every `session.inbox.enqueued` / `.delivered` / `.cancelled` /
`.delivery.changed` for that session, and on reconnect resync (re-read via
`GET /api/session/{id}/inbox`). It is additive: iOS ignores unknown subs (the implementer
must confirm every Swift `switch` over frame subs has a `default:`).

**K4 — inbox RPCs** (new channels in `rpc.mjs`, methods on `Api` + `httpApi.ts`):
- `opencode:inbox` `(sessionId)` → `{ items: OpencodeInboxItem[] }`
- `opencode:inbox-cancel` `({ sessionId, id })` → `{ cancelled: boolean, item?: OpencodeInboxItem }`
  `cancelled:false` when the item was already delivered or gone (V2's DELETE is a 204
  no-op in that case, so the server decides by reading the inbox BEFORE the DELETE: the
  item must be present, and must be absent afterwards). `item` is the pre-cancel copy so
  the client can restore its text.
Both are refused for CTO conversation sessions with a clear error (`"not available for the
CTO conversation"`), never a silent empty result.

**K5 — user interrupt resumes steered input.** `opencode:abort` (the user's Esc / stop
button) calls `POST /api/session/{id}/interrupt?resume=true`. V2 then runs pending
*steering* input as a fresh turn and keeps queued items parked — matching today's
behaviour, where Esc ends the turn and the queued message goes out next. Every
**internal** caller of `abortSession` (seat retry watch, delegate pause, admission, usage
stop, CTO) keeps `resume=false`: add `interruptSession(sessionId, { resume, signal })` and
leave `abortSession` as the `resume:false` wrapper.

**K6 — command origin on the message model.** User messages produced by a slash command
carry `info.command?: { name: string; arguments: string }` in the `{info, parts}` shape
returned by `opencode:messages` / `opencode:message`. The live `commandExecuted` frame
(existing sub, payload `{messageID, name, arguments}`) is emitted again, from the server.

**K7 — reclaim API** (served next to `/api/upgrade` in `upgradeV2.mjs`, auth required):
- `GET /api/upgrade/reclaim` →
  `{ available: boolean, reason: string | null, mode: "copy" | "in-place" | null, bytes: number | null }`
- `POST /api/upgrade/reclaim` → `{ ok: true, freedBytes: number } | { ok: false, error: string }`

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
  composer" gesture becomes: cancel the newest pending item; on `cancelled:true` put its
  text back in the composer; on `cancelled:false` say "Already sent to the agent" (never a
  silent no-op). If the item had attachments, the composer shows "Attachments weren't
  restored — re-attach them".
- Esc / stop while messages are pending: K5 — the turn stops, the pending steered message
  runs next.
- A pending **question** card when the user sends from the composer: today the drain
  rejects pending questions before resending. Keep that: reject the session's pending
  questions (existing `rejectAllPendingQuestions` path), then send with `steer`. A pending
  **permission** is left alone; the message stays pending until the permission is answered.
- Slash commands typed while running go through `opencode:run-command` with
  `delivery:"steer"`; attachments and @-mentions go through as today.

### Server (S1)
1. `sendPrompt` / `runCommand`: forward `delivery` (already plumbed in `sendPrompt`; add to
   `runCommand`). Thread it through `rpc.mjs` per K1.
2. `interruptSession` + `abortSession` wrapper per K5; `opencode:abort` uses `resume:true`.
3. `listInbox(sessionId)` and `cancelInboxItem(sessionId, id)` in `opencode.mjs` (V2
   `GET /api/session/{id}/inbox`, `DELETE /api/session/{id}/inbox/{inboxID}`); RPCs per K4.
4. `streamInterp.mjs`: per-session inbox snapshot + `inbox` frame per K3. The
   `session.inbox.enqueued` event carries the item (`data.item`); delivered / cancelled
   carry `inboxID`. Existing `messageChanged` emission on `delivered` stays. Resync
   (`resyncAfterReconnect` in `index.mjs`) re-reads the inbox for known sessions and emits
   the frame.
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
- `submit()` while `running`: send immediately with `delivery:"steer"` (prompt or command
  path), no optimistic transcript row (the pending card shows it until it is delivered).
  Idle submit is unchanged.
- The ambient card + pop-last + × per §2 behaviour. Both branches of every action are
  reported (AGENTS.md "never stub a control").
- The user's own Esc must still not show the "aborted" notice (existing behaviour — keep
  whatever mechanism handles it today; only the drain-specific suppression goes).
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
2. `runCommand` (the single chokepoint; the CTO `admitCommand` path also ends there):
   before the POST, register a **pending** entry `{sessionId, name, arguments, at}` in a
   per-session FIFO; drop it if the POST fails; pending entries expire after 15 s.
3. The event pump (`index.mjs`, raw V2 events, before the interpreter) on
   `session.inbox.enqueued` with `item.type === "user"`: if that session has a pending
   command entry, bind it to `inboxID` (= the future message id), persist, and have the
   interpreter emit `commandExecuted {messageID, name, arguments}` for the session.
4. Message mapper (`listMessages` / `getMessage` → `{info, parts}`): stamp `info.command`
   (K6) on user messages whose id is in the record.
5. Skills dispatched as prompts (PR #1607) already show `/skill args` as their text — they
   are NOT recorded.

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
1. `GET /api/upgrade/reclaim` (K7): `available` is true only when the migration state
   (`~/.manta/v2-migration.json`) is `completed`, `mode === "copy"`, `reclaimedAt` is
   unset, and `v1Db` exists. `bytes` = size of `v1Db` + its `-wal` / `-shm` + the kept
   `~/.opencode/bin/opencode-v1` if present. `reason` is a plain sentence when not
   available ("Nothing to reclaim", "Only available after the upgrade finishes", "This box
   migrated in place; reclaiming space isn't supported yet", "Already reclaimed").
2. `POST /api/upgrade/reclaim`: re-check availability; refuse if `v1Db` resolves to the
   same path as the live V2 DB (`targetDb` / `$OPENCODE_DB`) — a hard guard with its own
   test; delete the V1 DB files and the V1 binary; record `reclaimedAt` + `reclaimedBytes`
   in the state file; return `freedBytes`. Never stops opencode. Partial failure → `ok:false`
   with what was and wasn't deleted.
3. Rollback after a reclaim: `POST /api/upgrade/rollback` answers
   `{ok:false, error:"Rollback is no longer possible: the old history was deleted to free space."}`
   without touching anything.
4. Deps (fs, paths) injected like the rest of `upgradeV2.mjs`; tests cover every
   availability reason, the same-path guard, partial failure, and rollback-after-reclaim.

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
| **S1 server** | `src/server/opencode.mjs`, `streamInterp.mjs`, `rpc.mjs` (opencode channels), `index.mjs` (pump + resync only), `peers.mjs`, `push.mjs` (comments), `delegate.mjs` (comment), new `commandOrigins.mjs`, `src/shared/streamInterpretation.mjs` (+`.d.mts`), `src/shared/types.ts` (K2/K3/K6 types), `src/shared/api.ts` (K1/K4 signatures), `scripts/opencode-v2/c1-smoke.mjs`, their tests/fixtures | `src/renderer/**`, `mobile/**`, `upgradeV2*.mjs`, `AGENTS.md` |
| **S2 desktop** | `src/renderer/**` except Settings' reclaim row, `AGENTS.md` | `src/server/**`, `src/shared/**`, `mobile/**` |
| **S3 reclaim** | `src/server/upgradeV2.mjs` (+ test), the Settings reclaim row (+ any `httpApi.ts` / `api.ts` methods it needs — coordinate: S1 also edits `api.ts`, so S3 appends its methods in a separate block) | everything else |

S2 codes against K1–K6 as written; until S1 lands, S2's tests use fakes of those shapes.
S1 and S3 both append to `src/shared/api.ts`: each adds its methods as its own contiguous
block to keep the merge trivial.

## 8. Verification (each slice, before reporting done)

- `npm run typecheck` and `npm test` green (both suites). Any failing test must be shown to
  fail identically on `origin/main` in a throwaway worktree before it is called unrelated.
- S1 live: extend `scripts/opencode-v2/c1-smoke.mjs` (pinned 2.0.30 sandbox, Haiku,
  `ANTHROPIC_API_KEY="$(cat <path from secret_provide>)"`, never the live :4096/:8787) with:
  (a) steer mid-turn → `inbox` frame with 1 item → delivered within the same execution →
  `inbox` empty; (b) a `queue` item + cancel → `cancelled:true`, and cancel after delivery →
  `cancelled:false`; (c) Esc with a pending steer item → `interrupt?resume=true` → the item
  runs as the next turn; Esc with an empty inbox leaves the session idle; (d) a slash
  command → `commandExecuted` frame and `info.command` on refetch; (e) a pending question +
  composer send (reject then steer) → the turn continues and reads the message;
  (f) `listActiveSessionIds` true mid-turn, false after.
- S2: vitest for the new inbox reducer / pop-last / cancel branches; the renderer harness
  (`tests/visual/`) still passes; `npm run build` succeeds.
- S3: unit tests per §6; one manual run against a sandbox copy of a migration state file
  in a temp `MANTA_STATE_HOME` — never the real `~/.manta`.

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
