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
  `metadata` column on the `session` SQLite table). opencode source stores the caller-supplied
  object verbatim (`createNext(..., metadata: input?.metadata)`) and `session.ts:108` returns
  `metadata: row.metadata ?? undefined` on read. This is the correlation seam for the role
  binding: creation intent can be stamped as an identity marker on the session itself
  (`cto_role_binding` generation + operation id), satisfying "explicit identity marker or
  receipt" for the crash-between-create-and-bind recovery. **[UNPROVEN]** as behavior —
  metadata round-trip must be exercised in an isolated session before P3a relies on it
  (the write path is a normal HTTP call, but honoring/visibility of arbitrary keys through the
  running server has not been observed on this box).
- **Client-supplied message ID for prompt admission reconciliation (spec §8.3).** The installed
  `POST /session/{id}/prompt_async` body (`Session.PromptInput`) includes
  `messageID: optional, pattern ^msg`. opencode source creates the user message as
  `id: input.messageID ?? MessageID.ascending()` (`session/prompt.ts:657`, plus the shell /
  command paths at :471) — i.e. the client ID is **honored, not ignored**. **[PROVEN-SRC]**.
  The HTTP response is `204 Prompt accepted` with **no echo of the messageID** [PROVEN], so
  receipt verification still requires a read-back (`GET /session/{id}/message`) or an SSE
  `message.updated` observation; a `messageID` accepted on the wire is not yet proven to appear
  in the transcript on this box **[UNPROVEN]**. Note the guard rails: the same pattern is
  `^msg_`-free (`^msg`), and Manta's own auto-rename path (AGENTS.md) shows opencode rejects
  unknown structured `format` bodies with a permanent 400 — treat any new request-shape use as
  needing an isolated-session probe (spec: "do not assume a parameter is honored because HTTP
  returned 200").
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

## 4. Project stable ID (spec §4.1 / §5.1 `ProjectRef`)

**Seams:** `src/server/tmux.mjs` (`parseSessions`, `listProjects`), `~/.manta/tmux-sessions.json`
store, `src/server/local.mjs` (`listProjects` config store), `src/server/projectsRoute.mjs`.

- **Manta-side project identity today is the tmux session NAME. [PROVEN]** A "project" is a
  tmux session (`projects[].tmuxSession`) with `defaultCwd` derived from its first window's
  `paneCurrentPath`. Names are user-renameable; renames break correlation. No stable project ID
  exists in Manta's config (`~/.manta/config.json` `projects[]` = `{tmuxSession, defaultCwd}`),
  no archive metadata, no ownership store. Window-level stamps exist as tmux user options:
  `@manta-session-id` (window → opencode session), `@manta-worktree-path`, `@manta-owner`
  (`"user"` / `"job"` today; `"cto"` unclaimed).
- **opencode already persists a stable project ID. [PROVEN]** The live `opencode.db` (read via
  a read-only schema dump, 2026-09-15) has a `project` table — `id` PRIMARY KEY (40-hex,
  content-derived), `worktree` (the repo root path), `vcs`, `name`, `time_created/updated` —
  plus `project_directory (project_id, directory)` and `workspace (id, project_id, directory,
  branch, …)`. `session` rows carry `project_id NOT NULL` and `workspace_id` (nullable; the
  Session API schema exposes `projectID`/`workspaceID`). A special `"global"` project row
  (`worktree = "/"`) holds non-repo directories. This is the natural `ProjectRef.workspaceId`
  the spec asks P0 to map — stable across session creation, keyed to the checkout root.
  **[UNPROVEN]**: stability across directory *moves* (rows observed stable per absolute path;
  no rename/rehash behavior observed), and whether `workspace_id` is reliably populated on
  this box (column nullable; values seen null in sampled rows).
- **Manta has no second project registry today** — `listProjects` composes live tmux state +
  the `tmux-sessions.json` reconciliation (`mantaOwned` stamp). Spec §5.1's "extend its
  metadata once rather than inventing a second project registry" therefore means: map
  tmux-project ⇄ opencode `project.id` via directory (pane path / `defaultCwd` matching the
  `project.worktree`/`project_directory.directory`), and persist only the mapping edge if
  needed. Branch names and titles are never keys — matches current behavior (nothing derives
  identity from branch names except `worktreeName()` in the Sidebar, which is display-only).

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
  `homedir()/.local/share/opencode/opencode.db`. Registered as
  `src/server/ctoP0Fixture.test.mjs`.
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
| Client-assignable message ID on `prompt_async`? | Yes — `messageID: ^msg`, honored in oc-src `id: input.messageID ?? ascending()` | PROVEN-SRC / behavior UNPROVEN (204 has no echo; read-back required) |
| Correlation marker for crash recovery? | `metadata` on create + `setMetadata` after | PROVEN schema / round-trip UNPROVEN |
| `promptDelivery` durable? | No — memory-only Map, FIFO defer | PROVEN-ABSENT |
| Direct RPC bypass exists? | Yes — `rpc.mjs` `opencode:prompt` → `sendPrompt` unwrapped; client drain/abort is renderer-side | PROVEN |
| Headless parent dispatch? | Not supported: `resolveOwner` requires parent tmux window | PROVEN (failure path) |
| `isolationRequired`? | No — worktree failure silently falls back to parent dir | PROVEN (fallback path) |
| Job ID ordering? | `genId()` after worktree + window creation, inside store lock | PROVEN |
| Stable project ID? | Manta: tmux session name only; opencode: `project.id` 40-hex keyed to worktree, `session.project_id NOT NULL` | PROVEN (schema + live rows) / move-stability UNPROVEN |
| `MANTA_STATE_HOME` redirects opencode DB? | No — only `MANTA_OPENCODE_DB`/`XDG_DATA_HOME`/`$HOME/.local/share` | PROVEN |
| Read-only DB invariant? | `DatabaseSync(path, {readOnly:true})`, `null` on unsupported/missing | PROVEN + regression-pinned by this PR |

## 7. What this PR changes (P0)

1. `docs/unified-cto-spec.md` — the spec itself, landed verbatim (byte-identical to the
   authoring copy, md5-verified).
2. `docs/cto-implementation-map.md` — this file.
3. `src/server/fixtures/opencodeDbFixture.mjs` — reusable synthetic-DB fixture per spec §14:
   builds the verified `message`/`part`/`session` schema, arms `MANTA_OPENCODE_DB` **before**
   the shared handle opens, resets the handle, restores the environment, and exports
   `assertNoLiveDbFallback()` proving the resolved path is the fixture and never the
   production home path.
4. `src/server/ctoP0Fixture.test.mjs` — the deterministic acceptance-regression fixture tests
   for the *existing* passive-read seams (U04-shaped, contract-only): `searchMessages` over the
   synthetic DB returns correct hits; the production accessor cannot write (`SQLITE_READONLY`);
   a search leaves the source byte/row-identical; and no HTTP/prompt dispatch occurs during a
   read (fetch spy wired at the process boundary throws if the read path ever sends).

No feature is asserted to exist: nothing here claims the CTO role session, admission path,
headless delegate or context service — P1a/P2a build those. Contract-only per spec §15.
