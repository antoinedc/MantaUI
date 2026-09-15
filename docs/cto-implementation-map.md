# CTO P0 implementation map — source seams, current behavior, capability checks

Companion to `docs/unified-cto-spec.md` (P0 deliverable, spec §15 P0: "Baseline inventory,
actual API/identity capability checks and failing fixture harness"). Baseline:
`9f0756caa67fc2a9105649bed76e181d16c155d8` (origin/main, fetched 2026-09-15).
Installed opencode binary: **1.18.29** (`~/.opencode/bin/opencode`); schemas below were read
from its live `GET /doc` OpenAPI response. Field checks against opencode source snapshot
1.18.26 (`packages/opencode/src/session/{session,prompt}.ts`) agree with the installed schema.

Every fact is labeled:

- **[PROVEN]** — read from the installed API schema / opencode source / this repo's source.
- **[PROVEN-SRC]** — additionally confirmed in opencode's source that the schema field is
  honored at runtime (source-verified, not yet exercised against a live model session).
- **[UNPROVEN]** — schema-supported but behavior not yet demonstrated; must be probed in an
  isolated session before any phase depends on it.

## 1. Role session creation & correlation (spec §3.1)

**Seams:** `src/server/opencode.mjs:467` (`createSession`), `src/server/opencode.mjs:654`
(`sendPrompt`), `src/server/ctoSessions.mjs` (`runEphemeralSession` user, reaper wired at
`src/server/index.mjs:1878`).

- **Session ID is server-generated, not client-assignable. [PROVEN]** The installed
  `POST /session` request body (`CreateInput`) is
  `{parentID?, title?, agent?, model?, metadata?, permission?, workspaceID?}` with
  `additionalProperties:false` — there is no client `id` field. opencode source generates the
  id in `createNext` (`SessionID` `^ses`); `GET /session/{id}` reads it back. There is also a
  `PATCH /session/{id}` / `POST /session/{id}` family and `session.setMetadata`
  (`SetMetadataInput {sessionID, metadata}`) for later mutation of `metadata`.
- **`POST /session` accepts a free-form `metadata` object and the Session schema persists it.**
  [PROVEN] Live `/doc`: body property `metadata: object`, `Session.metadata: object` (also a
  `metadata` column on the `session` SQLite table); oc-src `Metadata = Schema.Record(String, Any)`.
  **Behavior verified on the installed binary (P0 live probe, 2026-09-15, isolated disposable
  session, zero model turns — see §8):** a metadata object stamped at create round-trips
  verbatim through `GET /session/{id}`. This is the correlation seam for the role binding:
  creation intent can be stamped as an identity marker on the session itself
  (`cto_role_binding` generation + operation id), satisfying "explicit identity marker or
  receipt" for the crash-between-create-and-bind recovery.
- **Client-supplied message ID for prompt admission reconciliation (spec §8.3).** The installed
  `POST /session/{id}/prompt_async` body (`Session.PromptInput`) includes
  `messageID: optional, pattern ^msg`. opencode source creates the user message as
  `id: input.messageID ?? MessageID.ascending()` (`session/prompt.ts:657`, plus the shell /
  command paths at :471). **Behavior verified on the installed binary (P0 live probe, see §8):**
  the client `messageID` is persisted verbatim as the user message id and readable back via
  `GET /session/{id}/message` — delivery receipt is provable without resubmission. The HTTP
  response is `204 Prompt accepted` with **no echo of the messageID** [PROVEN], so receipt
  verification requires the read-back (or an SSE observation); 204 alone is not a receipt.
  Additionally `noReply: true` (prompt.ts:1069: `if (input.noReply === true) return message`
  before the model loop) was verified to record the user message with **zero model turn** —
  the receipt probe needs no voska call. Note the guard rails: Manta's own auto-rename path
  (AGENTS.md) shows opencode rejects unknown structured `format` bodies with a permanent 400 —
  treat any new request-shape use as needing an isolated-session probe (spec: "do not assume a
  parameter is honored because HTTP returned 200").
- **Ephemeral machinery is the wrong vehicle for the role session.** `runEphemeralSession`
  (opencode.mjs) creates → prompts → **deletes**; `createEphemeralReaper` (ctoSessions.mjs:436,
  wired index.mjs:1878) sweeps `manta-*`-titled sessions box-wide. A durable role session MUST
  NOT carry the ephemeral title prefix (it would be reaped) and MUST NOT be registered with the
  reaper. Today nothing stamps `@manta-owner: "cto"` (tmux.mjs `resolveOwner` comments: "nothing
  stamps 'cto' yet" — only delegate.mjs stamps `"job"`). Provenance classification today is
  `internalSessions.mjs` (`EPHEMERAL_TITLE_PREFIX`-matching + engine-state store) — the four-way
  provenance vocabulary in spec §3.1 (`cto_conversation` / `cto_worker` / `cto_internal` /
  `user_session`) does not exist yet and P0 asserts nothing about it.
- **Consumer sweep for role-session lifecycle (who else touches session identity):**
  `opencode.mjs` (`sessionDirectoryCache` + `rememberSessionDirectory` — every cache write must
  go through it or the per-directory SSE stream never opens), `ctoSessions.mjs` (ephemeral
  runner + reaper), `delegate.mjs` (worker sessions via `newWindow`), `tmux.mjs`
  (`@manta-session-id` stamp, `restampSessionId`), `internalSessions.mjs` (provenance), and the
  bootstrap `listSessions` priming loop in `index.mjs`.

## 2. Unified prompt admission / direct RPC bypass (spec §8.3)

**Seams:** `src/server/promptDelivery.mjs` (`createPromptDelivery`, `deliver`, `observeEvent`),
`src/server/index.mjs:418` (the single instance), `src/server/rpc.mjs:1512`
(`"opencode:prompt"` channel → `sendPrompt`).

- **One instance exists and most server callers already go through it.** In `index.mjs`,
  `promptDelivery.deliver` is injected as: the scheduler's `sendPrompt` (index.mjs:433), the
  RPC `sendPrompt` shim (:491), `notifyCapSession` (:633), delegate completion delivery (:652,
  :681), and the multica send (:4450). **All server-side prompt sends funnel through the shared
  `deliver` gate** (busy-deferral queue, FIFO).
- **The bypass is the renderer's direct chat path.** `POST /rpc/opencode:prompt` →
  `oc.sendPrompt` — *not* wrapped in `promptDelivery` for chat windows (index.mjs passes the
  shim at :491 but the chat composer's `opencode:send-prompt`-equivalent call path reaches
  `sendPrompt` directly; the queued-message drain/abort behavior lives client-side in
  `src/renderer/ChatPanel.tsx` / `useSseBus.ts` — abort-on-drain, submit-on-idle). This is the
  "existing direct chat RPC send and client-side queued-message drain/abort" the spec says must
  not bypass admission **for the CTO session**; ordinary project chats stay unchanged. P3a owns
  the server-side admission seam; P0 does not change either path.
- **Current `promptDelivery` is memory-only [PROVEN]:** the defer queue is an in-process
  `Map`; restart loses queued prompts; `deliver` returns `{delivered, queued, rejected}` with
  no durable record, no stable event IDs, no origin field, no binding generation. Matches the
  spec's hazard list ("deferral is currently memory-only. Submission acknowledgment is not
  completion of a model turn"). `deliver` defers until the target session is idle
  (`observeEvent` busy/idle detection on the shared firehose tap, index.mjs:2793).
- **No durable store backs prompt admission today.** The closest durable analogues: Manta's
  `~/.manta/schedule.json` (fires via `oc.sendPrompt`), delegate's job store
  (`~/.manta/cto-jobs.json`, serialized via `ctoStores.mjs`), and opencode's own
  `session_input` SQLite table (see §5 below). Spec §8.3's durable delivery records are a P3a
  extension, not present at baseline. **[PROVEN-ABSENT]**.

## 3. Headless delegate: target, isolation, ID ordering (spec §8.1)

**Seams:** `src/server/delegate.mjs` — `startJob` (:727), the jobs-store lock wrapper
(:795-876), `resolveOwner` (:260), `resolveForgeOwner` (:283), `registerJob` (:351),
`genId` (:104), `MAX_RUNNING_JOBS = 5` (:67).

- **Target resolution requires the parent's tmux window. [PROVEN]** `resolveOwner` finds the
  project whose window carries `opencodeSessionId === parentSessionID`; no window ⇒ null ⇒
  `startJob` fails with `could not resolve the tmux session owning <id>`. A headless completion
  parent (no tmux holder, spec §3.1) cannot dispatch through this path unchanged.
  `resolveForgeOwner` (:283) is the existing directory-based precedent (forge events have no
  parent session; it resolves the project that owns the repo checkout) — the shape a headless
  target resolver must generalize, but it still *derives* a `parentSessionID` from an existing
  window for the job record.
- **Worktree isolation is best-effort, not required. [PROVEN]** `startJob` step 4: on
  `gitAddWorktree` throw it catches and continues with `worktree = branch = baseSha = null`,
  `cwd = parentDirectory` — the job silently runs in the parent repository. There is no
  `isolationRequired` input; spec §8.1 ("a worktree failure must fail before prompting") is a
  contract to add in P2/P4, and the current rollback (window-creation failure removes the
  worktree, `registerJob:408-420`) is the only cleanup.
- **Job ID is allocated AFTER resource creation. [PROVEN]** Order inside the jobs-store lock:
  worktree created → baseSha recorded → `newWindow` (chat-mode tmux window + opencode session,
  `@manta-session-id` stamped) → `stampOwner("job")` → **`const id = genId()`** → job record
  appended. A crash between window creation and record append leaves an adopted-nothing
  window/session with no reservation to reconcile from — exactly the crash point spec §8.2
  row 2 covers. The opening prompt is sent *outside* the lock (`reg.ok` → `deliver`), so a
  deliver failure can leave a `running` job that never received its prompt.
- **The jobs-store lock already encodes the reservation discipline** (nested check + cap check
  + creation + record append inside one serialized section; `MAX_RUNNING_JOBS = 5` checked
  read-then-act inside the lock). What §8.1 adds: persist a reservation *including a
  preallocated identity* and create resources correlated to it (undo-on-failure already exists
  for worktrees; correlation fields `worktree/branch/baseSha/childSessionID/tmuxSession` are
  already on the job record).
- **CTO executor sub-cap** lives separately in `ctoAct.mjs:48` (`MAX_IN_FLIGHT = 2`) — the
  "five delegate jobs, two CTO executor plans" caps in spec §8.1 map to `delegate.MAX_RUNNING_JOBS`
  and `ctoAct.MAX_IN_FLIGHT` respectively. **[PROVEN]** Both must be reused, not bypassed.
- **Consumer sweep:** `startJob` callers (tool `delegate.ts` → `/api/delegate` →
  `index.mjs`), `adoptSubagentJob` (backgrounded `task` tool), forge-triggered jobs via
  `resolveForgeOwner`, `observeEvent` completion (sawBusy/idle), sweeper (30-min timeout,
  `delegate.mjs` sweeper), boot reconciliation in `index.mjs`.

## 4. Project stable ID (spec §4.1 / §5.1 `ProjectRef`) — UNRESOLVED

**Seams:** `src/server/tmux.mjs` (`parseSessions`, `listProjects`), `~/.manta/tmux-sessions.json`
store, `src/server/local.mjs` (`listProjects` config store), `src/server/projectsRoute.mjs`.

- **Manta-side project identity today is the tmux session NAME. [PROVEN]** A "project" is a
  tmux session (`projects[].tmuxSession`) with `defaultCwd` derived from its first window's
  `paneCurrentPath`. Names are user-renameable; renames break correlation. No stable project ID
  exists in Manta's config (`~/.manta/config.json` `projects[]` = `{tmuxSession, defaultCwd}`),
  no archive metadata, no ownership store. Window-level stamps exist as tmux user options:
  `@manta-session-id` (window → opencode session), `@manta-worktree-path`, `@manta-owner`
  (`"user"` / `"job"` today; `"cto"` unclaimed).
- **opencode persists TWO distinct identifier tables plus path mappings, and the spec's
  `ProjectRef` mapping is UNRESOLVED until the identity semantics are verified.** Evidence
  split below into SOURCE (column definitions, from the read-only schema dump of the live
  `opencode.db`, 2026-09-15) and OBSERVATION (row samples at that instant — a sample is not a
  rule; the id-derivation rule was NOT probed and no further live probing is planned):
  - SOURCE `project` — columns `id` (PRIMARY KEY, 40-hex-shaped), `worktree` (path string),
    `vcs`, `name`. OBSERVATION: rows seen include one with `id="global"`, `worktree="/"`
    (a synthetic row), and rows pairing 40-hex ids with distinct absolute worktree paths.
    **UNVERIFIED (do not infer):** how the id is derived; whether two worktrees of the same
    repository share or split a project row; what happens to the row on a directory move;
    whether `worktree` is unique per row. The earlier draft of this map asserted per-checkout
    uniqueness from the sample — retracted; the sample is consistent with several rules.
  - SOURCE `workspace` — columns `id`, `project_id`, `directory`, `branch`. OBSERVATION:
    sampled sessions left `workspace_id` null. **UNVERIFIED:** workspace identity semantics
    (per-branch? per-directory? lifecycle?), whether ids are populated or unique — do not
    infer "unique workspace" from the table's existence.
  - SOURCE `project_directory (project_id, directory)` — a directory→project mapping table.
    OBSERVATION: one row per observed directory, including the synthetic `global` project.
  - SOURCE `session` — `project_id NOT NULL`, `workspace_id` nullable; the Session API schema
    exposes `projectID`/`workspaceID`. OBSERVATION: the probe session (map §8, non-repo dir)
    carried `projectID="global"`, `workspaceID` absent.
  - **Mapping status: UNRESOLVED.** The spec's `ProjectRef = {workspaceId, repositoryId,
    repositoryRoot}` has no verified counterpart: no DB field observed so far carries
    *repository* identity (`project.vcs` holds only the VCS kind string, not a remote URL —
    source fact about one column, not proof the rest of the row cannot yield one, but nothing
    observed does). `project.id` / `workspace.id` semantics are unverified as above. P2a/P3a
    must NOT settle any observed id into `ProjectRef.workspaceId` or conflate the three
    identifier classes: verify actual semantics first (row creation for worktrees/global,
    move behavior, `workspace_id` population), then extend Manta metadata once with the
    explicit mapping — a branch name or display title is never the key (spec §4.1).
- **Manta has no second project registry today** — `listProjects` composes live tmux state +
  the `tmux-sessions.json` reconciliation (`mantaOwned` stamp). Spec §5.1's "extend its
  metadata once rather than inventing a second project registry" therefore means: map
  tmux-project ⇄ opencode identifiers via directory (pane path / `defaultCwd` matching
  `project.worktree`/`project_directory.directory`), and persist only the mapping edge if
  needed — after the semantics above are verified. Branch names and titles are never keys —
  matches current behavior (nothing derives identity from branch names except `worktreeName()`
  in the Sidebar, which is display-only).

## 5. DB source sandbox path (spec §14)

**Seams:** `src/server/opencodeDb.mjs` (whole file, 71 lines), consumers
`messageSearch.mjs` (`searchMessages`, RPC `opencode:search-messages` at rpc.mjs:1512) and
`modelLedger.mjs` (`endpointSummary`), tests `opencodeDb.test.mjs`, `modelLedger.test.mjs`.

- **`MANTA_STATE_HOME` does NOT redirect opencode's DB [PROVEN].** `resolveDbPath()`
  (opencodeDb.mjs:26) resolves in strict order: `MANTA_OPENCODE_DB` verbatim →
  `$XDG_DATA_HOME/opencode/opencode.db` if it exists → `$HOME/.local/share/opencode/opencode.db`
  if it exists → `null` (box cannot search). The state-home sandbox redirects only
  `stateHome()`-derived stores (`src/shared/paths.mjs`). A fixture that forgets
  `MANTA_OPENCODE_DB` therefore reads the maintainer's real opencode.db — the exact hazard
  spec §14 calls out. New fixture helper:
  **`src/server/fixtures/opencodeDbFixture.mjs`** — creates a synthetic SQLite DB
  (schema below), arms `MANTA_OPENCODE_DB`, resets the cached handle, and
  `assertNoLiveDbFallback()` pins the resolved path to the fixture and away from
  `homedir()/.local/share/opencode/opencode.db`. On teardown it CLOSES the fixture-owned
  connection before `_resetDbHandle()` (which only nulls the module reference) so no fd leaks
  and the temp dir can be removed; a borrowed/live or already-closed handle is never closed.
  Registered as `src/server/ctoP0Fixture.test.mjs`.
- **Read-only is a hard invariant [PROVEN].** `getDb()` opens
  `new DatabaseSync(path, { readOnly: true })` with a bounded
  `PRAGMA busy_timeout = 5000` (BET-1360). Writes through the handle raise
  `SQLITE_READONLY` (pinned by the new regression test on the production accessor — the
  strongest available deterministic proof that the read path cannot mutate the source).
  Degradation: no `node:sqlite` (Node < 22.5/24 runtime) or missing file ⇒ `getDb()` returns
  `null`, never throws; consumers must treat `null`/`supported:false` as honest unsupported.
- **Handle is module-cached; fixtures must reset before open.** `_resetDbHandle()` is the
  documented test-only reset; a handle cached before the env override would pin the fixture to
  the wrong DB. The fixture therefore arms the env + resets the handle *before* any `getDb()`
  call (existing tests in `modelLedger.test.mjs:374-443` already follow this shape by hand —
  the fixture is the reusable extraction, not a behavior change; existing tests are left
  untouched in this PR).
- **The live DB schema observed (read-only dump, no content read):** legacy pair
  `message (id, session_id, time_created, time_updated, data JSON)` +
  `part (id, message_id, session_id, time_created, time_updated, data JSON)` (what
  `searchMessages` joins), plus v2 tables `session (id, project_id NOT NULL, workspace_id,
  parent_id, slug, directory, path, title, metadata, tokens_*, time_created, time_updated,
  time_archived, …)` and **`session_input (id, session_id, prompt, delivery, admitted_seq,
  promoted_seq, time_created)`** — an opencode-side prompt-admission ledger schema
  (`delivery`/`admitted_seq`/`promoted_seq` columns). **[PROVEN-SCH]** Observed empty on this
  box — schema present, v2 admission behavior unproven **[UNPROVEN]**; worth a P3a probe but
  nothing may read it as production evidence yet.

## 6. P0 capability check summary

| Question (spec) | Answer | Evidence level |
| --- | --- | --- |
| Client-assignable session ID? | No — server-generated; `POST /session` accepts `metadata` object | PROVEN (live /doc + oc-src) |
| Metadata marker round-trips? | Yes — stamped at create, read back verbatim via `GET /session/{id}` | PROVEN (live probe §8, zero model) |
| Client-assignable message ID on `prompt_async`? | Yes — `messageID: ^msg` persisted verbatim as the user message id, readable back | PROVEN (oc-src + live probe §8, zero model) |
| Zero-model receipt probe possible? | Yes — `noReply: true` records the message with no model turn | PROVEN (oc-src + live probe §8) |
| `promptDelivery` durable? | No — memory-only Map, FIFO defer | PROVEN-ABSENT |
| Direct RPC bypass exists? | Yes — `rpc.mjs` `opencode:prompt` → `sendPrompt` unwrapped; client drain/abort is renderer-side | PROVEN |
| Headless parent dispatch? | Not supported: `resolveOwner` requires parent tmux window | PROVEN (failure path) |
| `isolationRequired`? | No — worktree failure silently falls back to parent dir | PROVEN (fallback path) |
| Job ID ordering? | `genId()` after worktree + window creation, inside store lock | PROVEN |
| Stable project ID? | Manta: tmux session name only. opencode DB: `project(id, worktree, vcs, name)` incl. a synthetic `"global"` row and 40-hex ids paired with worktree paths (OBSERVED sample); id-derivation rule, worktree/repo sharing, and `workspace.id` semantics UNVERIFIED; no repository-identity field observed. **ProjectRef mapping UNRESOLVED (§4)** | schema PROVEN / row semantics UNVERIFIED |
| `MANTA_STATE_HOME` redirects opencode DB? | No — only `MANTA_OPENCODE_DB`/`XDG_DATA_HOME`/`$HOME/.local/share` | PROVEN |
| Read-only DB invariant? | `DatabaseSync(path, {readOnly:true})`, `null` on unsupported/missing | PROVEN + regression-pinned by this PR |

## 8. P0 live receipt probes — run 2026-09-15 (zero model turns)

The user-authorized isolated-session probes (spec P0 gate: "prove creation/delivery receipt
semantics in isolated sessions"). Method: loopback-only `http://127.0.0.1:4096`, one dedicated
disposable fixture session in a non-repo temp directory (`/tmp/opencode/cto-p0-probe`, so
`projectID="global"`), title `manta-cto-p0-receipt-probe`, metadata operation marker
`{role:"cto_p0_probe", operation:"cto-p0-receipt-probe", ...}`. No project session, no live
secret, no existing session touched. **`noReply: true` kept the whole probe model-free** (the
prompt records without a model loop), so no voska turn ran at all.

1. **Creation receipt (A):** `POST /session` with a `metadata` marker → `GET /session/{id}`
   returned the metadata object **verbatim** (deep-equal verified), the server-generated id
   matched `^ses`, and `directory`/`projectID` were as expected (`workspaceID` absent/null).
2. **Delivery receipt (B):** `POST /session/{id}/prompt_async` with a client
   `messageID: "msg_…"` + `noReply: true` → `204`; within 2s `GET /session/{id}/message`
   showed exactly one message whose id **is the client-supplied messageID verbatim**
   (role `user`, one text part); no assistant message ever appeared (zero model turn).
3. **Cleanup:** the session was deleted by id (guarded by the metadata marker before the
   `DELETE`) and `GET /session/{id}` then 404'd — only the positively created fixture session
   was removed.

Consequence for the map: metadata correlation and messageID receipt are **behavior-proven on
the installed binary**, satisfying the P0 gate. Remaining prerequisite (explicitly a P3a
prerequisite, not a P0 gap): exercising these through Manta's own admission path and the
running server's SSE (`message.updated` with the client id) rather than raw read-back.

## 9. What this PR changes (P0)

1. `docs/unified-cto-spec.md` — the spec itself, landed verbatim (byte-identical to the
   authoring copy, md5-verified).
2. `docs/cto-implementation-map.md` — this file.
3. `src/server/fixtures/opencodeDbFixture.mjs` — reusable synthetic-DB fixture per spec §14:
   builds the verified `message`/`part`/`session` schema, arms `MANTA_OPENCODE_DB` **before**
   the shared handle opens, resets the handle, restores the environment, and exports
   `assertNoLiveDbFallback()` proving the resolved path is the fixture and never the
   production home path. Cleanup CLOSES the fixture-owned connection (the one the shared
   accessor opened while armed) before dropping the module reference — `_resetDbHandle` alone
   only nulls it — and never closes a borrowed/live or already-closed handle; the close runs
   under exception restoration too.
4. `src/server/ctoP0Fixture.test.mjs` — the deterministic acceptance-regression fixture tests
   for the *existing* passive-read seams (U04-shaped, contract-only): `searchMessages` over the
   synthetic DB returns correct hits; the production accessor cannot write (`SQLITE_READONLY`);
   a search leaves the source **row counts** unchanged; the **fetch seam is observed with zero
   calls** during a read (a throwing fetch spy — the tested coverage; not a claim about every
   conceivable side-effect channel); missing DB degrades to `supported:false`; and the fixture
   closes its own connection on success, on callback exception (env + handle restored), and
   when the callback closed it first.

No feature is asserted to exist: nothing here claims the CTO role session, admission path,
headless delegate or context service — P1a/P2a build those. Contract-only per spec §15.

## 10. P3a1 addendum — the durable singleton conversation binding is now a service

`src/server/ctoBinding.mjs` (`createCtoBinding({ oc, store, controlDir, requestDeadlineMs, ... })`)
implements spec §3.1 step 1 (create-or-recover ONE durable session) as an injectable service:
`ensure()` (singleflight get-or-create-or-replace), `recover()` (explicit reconcile pass —
ensure AND recover share one store-keyed flight across engine instances), and `getBinding()`
(store read only, full archive + optional pagination — opening the tab never invokes the
model). Not wired to any route yet; the future UI caller composes it.

Additive seams this PR lands on top of the P0 receipts:

- `opencode.createSession(...)` forwards a plain-object `metadata` option onto `POST /session`
  (P0 §8 receipt: metadata round-trips verbatim through `GET /session/{id}`); its rejection
  errors carry the numeric `status`, so a 4xx is a DEFINITIVE "nothing landed".
- `opencode.readSession(sessionId, { signal })` — NEW three-state read (`found` with the full
  record incl. `metadata` / `missing` on definitive 404 / `unknown` on 5xx+network), so callers
  can apply the spec rule "timeout is not absence". `sessionExists` is unchanged.
  `listSessions(directory, { signal })` now takes a signal too.
- `ctoStores.bindingStore` — strict store for the versioned binding record: `generation`,
  `currentSessionId` + `currentOperation` (the exact identity marker to verify against),
  the FULL `previousSessionIds` archive (never capped, never dropped; `getBinding` paginates),
  and `pendingOperation` (reserved BEFORE the remote create with the expected pre-create state;
  recovery matches sessions by EXACT `metadata.bindingOperation` — never by title). Strict
  stores treat a top-level null/array/string payload as CORRUPTION — only a missing file
  initializes the default.

Role-session discipline (all pinned by `ctoBinding.test.mjs`): the role session's opencode
directory is a server-owned control directory under the state home (`~/.manta/cto/conversation`,
0700 enforced, marker file, no `.git` in it or any ancestor up to the state home, realpath
containment so no symlink can redirect the session's cwd outside the state home); its title
deliberately avoids the ephemeral reaper's `cto:` prefix. Provenance is DISTINCT from the
generic internal-session tombstones: the conversation is recognized via the binding record
(`readConversationRole`, checked first in `resolvePipelineSession` → `{owner:"cto",
role:"cto_conversation"}` vs `role:"cto_internal"` for ephemeral tombstones), so the engine can
recognize a human CEO instruction (presence/preempt) while the conversation still never
produces evidence rows or segmentation input — the CTO never summarizes its own assistant
output recursively.

Unknown-outcome discipline (review blockers 1-3): concurrent `ensure()`/`recover()` calls —
across engine instances over the same store — join ONE flight; the reservation CAS
(`expectedCurrentSessionId`/`expectedGeneration`) and the bind CAS stop a stale "missing"
lookup from replacing a session a prior bind already replaced; every oc call (list/read/create)
is bounded by an AbortSignal deadline through the actual transport (hung headers/body →
explicit failure); a create with an UNKNOWN outcome (network/deadline/5xx) RETAINS its
reservation and fails explicitly — never blind-retried, and a marker scan that finds nothing
NEVER clears the reservation (an in-flight create can land after the snapshot; a malformed
list response is never read as absence). Only a definitive 4xx rejection clears its own
reservation. A create whose response lacks the identity marker persists the created sid plus a
terminal `unsupportedIdentity` failure — never a create-loop.

Round-2 review corrections: ensure/recover serialize through a per-store task
queue where every caller completes its own postcondition (ensure still creates
when queued behind a no-create recover); the create's returned sid is persisted
BEFORE receipt verification and recovery settles by a DIRECT read of that sid
first (the marker scan runs only when no sid was persisted); control-directory
validation (textual + realpath containment, repository walk including the state
home) precedes every mkdir/chmod so a refused path is never modified; the DB
scanner tags rows with distinct provenance (`cto_internal` from tombstones,
`cto_conversation` from the binding record — never in the tombstones) and the
conversation's assistant/tool content is excluded from ordinary evidence while
its user rows (CEO instructions) stay consumable under their role path; strict
stores never read a top-level null/array/string as default; the archive is
uncapped with query pagination; and the service states its single-writer-
process requirement — no fake cross-process CAS guarantee.
Round-3: an EXISTING controlDir symlink is refused outright (spec — symlink
redirects are refused; ancestor symlinks remain fine under realpath
containment), and an existing controlDir that resolves to the state home
itself is refused — equality with the state home is valid only as the
existing ancestor of a not-yet-created controlDir, so chmod can never follow
a link onto the state home or any other target.

## 11. P3a2 addendum — the durable conversation admission queue is now a service

`src/server/ctoAdmission.mjs` (`createCtoAdmission({ binding, sendPrompt, getMessage,
listMessages?, abortSession?, isBusy?, store, ... })`) implements spec §8.3 as an injectable
service: `submit` / `list` / `tick` / `reconcile` / `interrupt` / `observeEvent`. ALL CTO-role
prompts (human + background) are meant to enter through it once the parent wires it; ordinary
project delivery keeps promptDelivery unchanged — admission shares only its busy view
(production passes `promptDelivery.isBusy`) and sits on the same firehose tap. The stable
integration recipe, lifecycle diagram, error codes and honest limitations live in
**`docs/cto-admission-contract.md`** (the contract for the next UI/API worker). Not wired to any
route or poller here.

Durability shape (all pinned by `ctoAdmission.test.mjs`): a submission's stable event id +
canonical payload hash + origin + expected binding generation persist BEFORE any send; dispatch
persists the resolved `sessionId` + allocated opencode `messageID` (status `dispatching`) BEFORE
the `prompt_async` POST; every store transition is a sync-mutator `patchStore` section — no lock
is held across an opencode await; the pump is single-flight AND joinable (event-driven and
poller-driven pumps join one run). Ack is not completion: 204 + messageID receipt yields
`accepted` only, and completion requires the real terminal event (`session.idle`/`session.error`
via `observeEvent`) or a transcript proof (assistant row with `time.completed`/`error` after our
user message — `turnCompletionFromTranscript`). The P0-proven caller messageID is the restart
receipt: a crash-window `dispatching` record is reconciled by read-back (found → adopted, never
resent; absent → `unknown`, surfaced with a stale flag after 60s, still never resent); only a
definitive 4xx observed live is `failed`. Human FIFO outranks queued background at ONE pick
point (never reorders an accepted turn); pending work retargets the CURRENT binding at dispatch
(`retargeted` recorded) while accepted turns keep their original sid. Terminal receipts are
retained forever — growth is bounded by refusing new submissions at `MAX_ENTRIES` (500), never
by eviction. `interrupt` is the explicit abort op (`queued`/`unknown` → cancelled, `accepted` →
one bounded `abortSession`); submit never aborts.

Additive seams this PR lands on top of P3a1/P0: `opencode.sendPrompt` forwards an optional
`messageID` onto the `prompt_async` body (P0 §8: persisted verbatim as the user message id,
readable back; omitted → byte-identical pre-P3a2 behavior) and `ctoStores.admissionStore`.

Round-2 review blockers (same service, same scope): (1) completion is receipt-specific —
only the LAST assistant row whose `parentID` equals the submitted messageID with a TERMINAL
finish via the shared `assistantCompletion` helper completes a turn; `session.idle`/`error`
EVENTS trigger that transcript check and never blindly complete (a stale/unrelated idle cannot
release the queue), and intermediate tool-step rows never do. (2) interrupt is a two-phase
request: `accepted` → `interrupt_pending` (nonterminal barrier) → abort once → terminal
`interrupted` only when the session is confirmed idle (terminal event or transcript proof);
unsupported/failed/timed-out aborts RETAIN `interrupt_pending` with `abortError`; cancelling an
`unknown` marks visible `cancel_requested` and retains the barrier — a late-landing POST is
adopted (receipt found → `accepted` with `cancelRequested` retained), never erased. (3)
reconcile is joinable-single-flight, takes an active-operation lease BEFORE the dispatch claim
so it never races the send its own instance is awaiting, and mutations are serialized by the
store mutex + from-status CAS. `opencode.sendPrompt` now propagates the caller's bounded signal
through the per-directory readiness gate AND the actual POST (the wrapper used to drop it);
an aborted client request stays uncertainty (unknown), never a refusal. (4)
`ctoStores.admissionStore` is strict: top-level null/array/scalar and unparsable JSON fail
loudly and never reset/overwrite the file. (5) the priority pick is re-verified AT CLAIM TIME
under the store mutex, so a human arriving while the pump awaited the binding wins before the
dispatch commits (no locks across the binding await). (6) the canonical hash binds agent + text
+ model + origin with key-order-canonical serialization, and dedup precedes generation
validation — a same-payload id replay succeeds even after a binding replacement.

Round-3 review blockers (offline repro, same service): (1) events are TRIGGERS for the
receipt-specific transcript check, never proof — an `interrupt_pending` record can no longer be
terminalized by a stale `session.idle`/`session.error`, and even a finished turn does not settle
it while its abort is unresolved (`turnEndedAt` is recorded separately from the abort state).
(2) the ABORT is its own active + durable uncertain state (`abortState`: pending/ok/refused/
uncertain on the record): `interrupt_pending` settles ONLY when the abort has a DEFINITIVE
server response ("ok" → interrupted, "refused" → completed) AND the finish-agnostic transcript
reader (`turnEndedFromTranscript`) proves the turn ended; an uncertain (deadline/network) abort
keeps the same-session admission barrier, is re-issued by reconcile across restarts (idempotent,
bounded, signal-propagated into `opencode.abortSession`), and the timeout waiter is never
treated as proof — so a late session-wide abort can never kill the next admitted turn. (3) the
dispatch claim is LINEARIZABLE against binding generation changes via the additive
`binding.claimGeneration(reserve)` operation (ctoBinding.mjs): the reserve callback runs under
the SAME serialized store seam as ensure()/recover(), reads the binding FRESH inside that
section, re-verifies gate/priority/CAS there, and reserves the admission record against that
exact generation — lock order binding → admission, all locks released BEFORE the external POST;
a change before the claim is observed (pending targets current), a change after the claim
serializes behind it (claimed delivery stays on its own session). All timings are proven with
latches, including both generation-change placements and the real ctoBinding service.
