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

## 4. Project stable ID (spec §4.1 / §5.1 `ProjectRef`) — RESOLVED + ADOPTED (probe 2026-09-18, adoption 2026-09-19)

**Seams:** `src/server/tmux.mjs` (`parseSessions`, `listProjects`), `~/.manta/tmux-sessions.json`
store, `src/server/local.mjs` (`listProjects` config store), `src/server/projectsRoute.mjs`.

Label vocabulary: **SOURCE** = schema fact (read-only dump of the live `opencode.db`); **OBSERVATION**
= row sample at an instant (a sample is not a rule); **PROVEN** = established by the repeatable
probe pass of 2026-09-18 (log at the end of this section), corroborated by opencode **v1.18.29**
source (the installed binary's version): the derivation rule lives in
`packages/core/src/project.ts` (`resolve()` → `Project.fromDirectory()` migration + upsert),
`packages/core/src/git.ts` (`repo.discover` = `rev-parse --show-toplevel` / `--git-common-dir`;
`remote.get-url origin`; `rev-list --max-parents=0 HEAD`), `packages/core/src/util/hash.ts`
(`Hash.fast` = sha1), `packages/opencode/src/session/session.ts` (sessions stamp
`ctx.project.id`, resolved at instance boot), and
`packages/core/src/control-plane/workspace.sql.ts` (the `workspace` table).

- **Manta-side project identity today is the tmux session NAME. [PROVEN]** A "project" is a
  tmux session (`projects[].tmuxSession`) with `defaultCwd` derived from its first window's
  `paneCurrentPath`. Names are user-renameable; renames break correlation. No stable project ID
  exists in Manta's config (`~/.manta/config.json` `projects[]` = `{tmuxSession, defaultCwd}`),
  no archive metadata, no ownership store. Window-level stamps exist as tmux user options:
  `@manta-session-id` (window → opencode session), `@manta-worktree-path`, `@manta-owner`
  (`"user"` / `"job"` today; `"cto"` unclaimed).
- **`project.id` is a REPOSITORY-identity hash — not a path hash, not random. [PROVEN]**
  SOURCE: `project` columns `id` (TEXT PRIMARY KEY, 40-hex), `worktree` (TEXT NOT NULL), `vcs`,
  `name`, `icon_url`, `time_created`/`time_updated`/`time_initialized`, `sandboxes` (JSON),
  `commands`; the only unique index is the PK autoindex — **`worktree` carries NO unique
  constraint**, and the probe pass produced a live counter-example to uniqueness (two project
  rows sharing one worktree path, below). Derivation, resolved when an opencode instance boots
  for a directory, in precedence order (each step PROVEN by a predicted-hash match in the live
  probe pass, and by upstream v1.18.29 `resolve()`):
  1. no git repo at or above the directory → the literal id `"global"`;
  2. git repo with a usable `origin` remote (non-`file://` URL) → `sha1("git-remote:" + host +
     "/" + path)` with the host lowercased and `.git` stripped. Probe repo with
     `origin git@fake.example:cto/identity-remote-probe.git` got id `2fe13b47495607a4c6150e1a37c906ca077fc747`
     = exactly sha1("git-remote:fake.example/cto/identity-remote-probe"); production rows match
     the same function (`afe412f7…` = sha1("git-remote:github.com/antoinedc/MantaUI"),
     `4ad07051…` = sha1("git-remote:github.com/antoinedc/drone-ai"));
  3. no remote → the cached id in the file `<git-common-dir>/opencode`, which opencode itself
     writes at resolve time (OBSERVATION: the file appeared during the probe with the id inside);
  4. no cache → sha1 of the first root commit (`git rev-list --max-parents=0 HEAD`); a probe
     repo without a remote got id = its root commit exactly.
  `project.worktree` holds the FIRST-seen worktree root for that id and the upsert never
  overwrites it for non-global rows (source); later checkouts land in `project_directory` and
  the `sandboxes` JSON instead.
- **Two worktrees of one repository share ONE project row. [PROVEN — decisive for the CTO]**
  Probe: one repo + two `git worktree add` checkouts → sessions in both worktrees carried the
  SAME `projectID`; exactly one `project` row existed for that id; each worktree ROOT got a
  `project_directory` row and was appended to the row's `sandboxes` JSON; a session in a
  SUBDIRECTORY also mapped to the repo project with NO new `project_directory` row (the recorded
  directory is the resolved repo root, not the session's subdir — the session row's own
  `directory` column keeps the subdir). opencode's "project" is therefore REPOSITORY-grained:
  N worktrees = N directory rows under 1 project. (OBSERVATION: production rows mark linked
  worktrees `strategy="git_worktree"` in `project_directory`; the probe's hand-made worktrees
  got `strategy=null` and the marker's writer is UNVERIFIED — not load-bearing here.)
- **Moves keep the id; deletes/recreates split it; one migration path. [PROVEN]**
  - MOVE a repo dir → the id FOLLOWS the repo (remote, cache file, and history all move with
    `.git`): same project row, same id. `project_directory` ACCUMULATES the new path and KEEPS
    the stale old rows (no pruning observed across the probe window); the `sandboxes` JSON
    self-prunes to existing dirs on every resolve; `project.worktree` keeps the stale
    first-seen path. Production rows show the same residue (e.g. the drone project still lists
    a moved-away directory).
  - DELETE + RECREATE at the same path WITHOUT a remote → the fresh repo resolves to its NEW
    root commit → a NEW project row; the old row LINGERS. One directory can map to MULTIPLE
    project rows over time — an identity fork, observed live (two probe sessions in the same
    path carried different project ids; `project_directory` PK is `(project_id, directory)`, so
    the same directory legitimately appears under two projects).
  - DELETE + RECREATE WITH the same remote → the SAME id returns (it is remote-derived) and the
    same row is reused.
  - ATTACH a remote LATER → opencode MIGRATES: the id becomes the remote hash (predicted value
    matched), the old project row is DELETED, and existing sessions are re-pointed to the new
    id in the DB. Identity migration is a first-class opencode behavior, not a guess.
  - `git init` in a formerly non-repo dir retroactively CLAIMS that directory's existing
    `global` sessions (probe: the earlier `global` session row was re-pointed to the new
    project id).
  - **Instance-cache caveat [PROVEN]:** within ONE opencode server process, a directory's
    project id is pinned by the per-directory instance cache — a session created in a recreated
    directory was stamped with the OLD id until the instance was disposed
    (`POST /instance/dispose?directory=…`) or the service restarts. Observed ids can be stale
    w.r.t. on-disk reality until the next fresh resolve.
- **The `workspace` identifier class is DEAD on this box. [SOURCE + OBSERVATION]** SOURCE:
  `workspace` columns `id` (PK), `type` NOT NULL, `name`, `branch`, `directory`, `extra`,
  `project_id` NOT NULL FK→project (ON DELETE CASCADE), `time_used` NOT NULL; no unique
  constraint on `directory`. Upstream, rows are created ONLY by the experimental workspaces
  feature (`Workspace.create`, gated behind `OPENCODE_EXPERIMENTAL_WORKSPACES`) and
  `session.workspace_id` is stamped only for sessions created through a workspace. OBSERVATION
  (2026-09-18): 0 rows in `workspace`; 0 of 1143 sessions carry a non-null `workspace_id`.
  Whether experimental workspaces are per-branch or per-directory is **UNVERIFIED** (feature
  inactive here; enabling a global experimental flag was out of scope). Practical statement:
  `ProjectRef.workspaceId` cannot be sourced from opencode today.
- **Repository identity is derivable — for remote-backed repos `project.id` IS it. [PROVEN]**
  No column carries a remote URL (SOURCE: the column list above; OBSERVATION: `vcs` holds only
  the kind string, e.g. `"git"`). But for repos with a usable origin, `project.id =
  sha1("git-remote:" + normalized)` — a deterministic function of repository identity, identical
  on any machine cloning the same repo (verified against three independent live rows + the
  probe). For remote-less repos the id is the root-commit hash — history identity, fork-prone
  (see above). `file://` remotes are excluded by the normalizer (source; not probed separately).
- **`project.id="global"` (worktree `"/"`) is the non-git bucket. [PROVEN]** Sessions in
  directories with no git repo resolve to `global`; NO `project_directory` row is ever created
  for it (probe + source: the directory-save step skips global). Manta's own CTO control
  directory (`~/.manta/cto/…`, deliberately non-git) therefore resolves to the `global`
  project — the CTO conversation session lives in the synthetic row.
- **Manta has no second project registry today** — `listProjects` composes live tmux state +
  the `tmux-sessions.json` reconciliation (`mantaOwned` stamp). Branch names and titles are
  never keys — matches current behavior (nothing derives identity from branch names except
  `worktreeName()` in the Sidebar, which is display-only).

### 4.1 Decision — durable project key and the persisted mapping edge

**The durable project key is a Manta-minted id persisted ONCE on the Manta project record; no
opencode identifier may serve as the key. Concretely: add `projectId` (minted once, at project
creation or first sight) to each `~/.manta/config.json` `projects[]` entry, plus one optional
cache field `opencodeProjectId`. Nothing else — no new store, no second registry.**

Why not opencode's ids — against the four failure modes that matter:

1. **User renames a tmux session** — the name is Manta's only project identity today [PROVEN],
   and renames break it. A minted id survives renames provided Manta treats a rename as a
   REBIND of the same record (rename is observable in tmux); never mint a new project on rename.
2. **A repo with multiple worktrees** — opencode `project.id` is repository-grained [PROVEN],
   while Manta's "project" is checkout/window-grained. Adopting opencode's id as the Manta key
   would fuse all worktrees of a repo into one Manta project — exactly the class conflation
   spec §4.1 forbids.
3. **A directory move** — path keys break; opencode's id follows the repo [PROVEN]; a minted id
   is indifferent.
4. **A worktree deleted then recreated** — remote-backed repos keep the same opencode id
   [PROVEN]; remote-less repos fork it [PROVEN]. A minted id is stable in both cases.
   Re-attaching a recreated record to the old key must key on REPOSITORY identity (opencode
   project id / normalized remote), never on path or name.

**`ProjectRef` mapping (spec §5.1)** — ADOPTED 2026-09-19: `workspaceId` is the minted key on
every new work envelope; legacy envelopes keyed by the tmux name still resolve (see §4.1a):

- `workspaceId` ← the Manta `projectId`. opencode's workspace class is dead on this box
  [SOURCE + OBSERVATION]; do not pre-adopt experimental workspaces — extend the mapping only
  if that feature ships for real.
- `repositoryId` ← opencode `project.id`: for remote-backed repos it IS the repository identity
  (deterministic, machine-stable) [PROVEN]; for remote-less repos mark `repositoryId` UNMAPPED
  (spec §4.1's explicit-unmapped state) rather than persisting the fork-prone root-commit id.
  Remote-backed but unobservable (no readable opencode DB) also degrades to UNMAPPED — never a
  guess. The remote-backed classification reads the checkout's origin URL (`file://` remotes
  excluded, matching opencode's normalizer); a caller-supplied `repositoryId` always wins.
- `repositoryRoot` ← the validated checkout path at use time; never persisted as identity
  (moves are normal). Dispatch/review validate the LIVE session's path, not the create-time
  snapshot. The delegate job's `targetProject` stays the LIVE tmux name (the window-placement
  handle, revalidated at dispatch); the durable key lives only in the ProjectRef.

**`opencodeProjectId` cache semantics:** the last OBSERVED opencode project id for the record's
directory — a cache, never authoritative. It changes legitimately (remote attach migrates it
[PROVEN]; remote-less recreation forks it [PROVEN]; the per-directory instance cache can serve
a stale value until dispose/restart [PROVEN]). On mismatch, adopt the new id — opencode has
already migrated its sessions; Manta follows, it does not fight. Live re-resolution paths: the
session object's `projectID` field, or a read-only `project_directory` lookup by directory
(same read path as `opencodeDb.mjs` — note a directory lookup can return MULTIPLE projects
after a fork; disambiguate by liveness, not by ordering).

#### 4.1a The rebind-on-rename rule — SETTLED (2026-09-19, adoption PR)

§4.1 said a rename must REBIND the existing record but deliberately left open HOW Manta
recognises one: Manta's config keys projects by tmux session NAME, so after a rename the only
surviving signal is the checkout DIRECTORY. The settled rule (`resolveProjectIdentity` in
`src/server/ctoMantaTools.mjs` — the one identity surface; `createProjectIdentityAdapter` is its
single I/O wrapper):

**A live tmux session that matches no record under its name is the RENAME of an existing
project — and its record is REBOUND (keeps its minted `projectId`, moves its name, refreshes
its cwd) — iff ALL of:**

1. **Unique orphan**: exactly ONE orphaned record (its name matches no live session) is
   anchored at the same checkout directory (`defaultCwd` equality — both sides come from the
   same tmux reporting; `"~"`/empty anchors never match). The anchor must be UNCONTESTED: two
   orphaned records on one directory is undecidable — no rebind for either.
2. **Unclaimed live target**: the live session carries no record of its own (a session already
   claimed by another record belongs to that identity), and is the only unclaimed live session
   at the anchor.
3. **Repository identity does not CONTRADICT**: when the record's cached `opencodeProjectId`
   AND a live observation for the directory both exist and differ, the path now hosts a
   different repository (remote-less recreation forks the id [PROVEN]; a remote attach migrates
   it [PROVEN]) — a rename observed together with an identity change is not separable, so the
   rebind is REFUSED and the live session is minted as a NEW project (the old record stays
   orphaned). When either side is unobservable, the directory match stands alone.

Resolution order: exact live name → durable `projectId` / stale record name (a legacy
name-keyed work envelope resolves through its record the same way) → the historical
case-insensitive guards (`target_changed` / `target_ambiguous`) → `target_not_found`. On every
rebind the record's `opencodeProjectId` cache is adopted from the live observation. Mints
happen at creation (`projects_create`) and on first sight of an existing project; an id-less
record (desktop-era) is migrated IN PLACE — never re-keyed as a new project. Reads resolve
identically but persist nothing.

**What the rule CANNOT recover — fail-closed outcomes, each visible as an error naming the
stored key and checkout, never a guess:**

- **Rename + directory move observed together.** The orphan's anchor no longer matches any
  live session's directory; the key resolves to nothing until a human re-points it.
- **Rename + repository-identity change observed together** (remote attach, or remote-less
  recreation with no intervening touch to refresh the cache). Refused by rule 3; the live
  session gets a NEW key. Any write-path touch between the two changes refreshes the cache
  (adoption) and makes the later rename rebind normally.
- **Two orphaned records sharing one directory** (two sessions over one checkout, both
  renamed). Contested anchor — undecidable which one the new session is.
- In every refused case the old record keeps its key; work records keyed by it fail
  `target_not_found` / `target_ambiguous` and recover by re-issuing against the live session
  name. A silently-wrong rebind (dispatching a worker into the wrong repository) is worse than
  a refused one — the rule prefers failing closed (spec §1.1).

**Still forbidden (unchanged):** branch names, display titles, tmux names, and paths as keys;
settling any observed id into `ProjectRef` without the semantics above.

#### Probe log (re-runnable, 2026-09-18)

Zero-model, loopback-only (`http://127.0.0.1:4096`), DB read via `node:sqlite`
`DatabaseSync(path, {readOnly: true})` at `$HOME/.local/share/opencode/opencode.db` (same
resolution as `src/server/opencodeDb.mjs`). All sessions carried
`metadata:{probe:"cto-identity-probe"}` and titles `cto-idprobe-*` (deliberately NOT the
`manta-*` ephemeral-reaper prefix); every probe session was DELETEd and verified 404 afterward,
and every throwaway directory removed. `opencode-serve` was never restarted; the only
per-directory side effect was `POST /instance/dispose?directory=…` on the probe's own
directories.

```
1. mkdir /home/dev/projects/cto-probe-nonrepo                (no .git)
   POST /session?directory=…  → projectID="global"; no project row, no project_directory row
2. git init cto-probe-remote + 1 commit + remote origin git@fake.example:cto/identity-remote-probe.git
   POST /session  → projectID == sha1("git-remote:fake.example/cto/identity-remote-probe")
                    (predicted, matched); row created; .git/opencode cache file written with the id
3. git init cto-probe-local + 1 commit, NO remote
   POST /session  → projectID == root commit sha (predicted, matched)
4. git worktree add cto-probe-local-wt1 / -wt2
   POST /session ×2 → both SAME projectID as step 3; 1 project row; project_directory rows per
                      worktree root; sandboxes JSON grew to both worktrees
5. POST /session in cto-probe-local/sub → same projectID; NO new project_directory row
6. worktree remove ×2; mv cto-probe-local → cto-probe-local-moved
   POST /session → SAME projectID (id follows the repo); project_directory gained the new path
                   and kept the stale ones; sandboxes pruned to existing dirs
7. rm -rf moved dir; git init fresh at the ORIGINAL path + new commit
   POST /session → STALE old id (instance cache) …
   POST /instance/dispose?directory=… → POST /session → NEW projectID = new root commit;
                   NEW project row; old row lingers (identity fork; same directory under 2 projects)
8. git remote add origin git@fake.example:cto/identity-local-probe.git; dispose; POST /session
   → projectID == sha1("git-remote:fake.example/cto/identity-local-probe") (predicted, matched);
   old row DELETED; probe sessions re-pointed in the DB (migration proven live)
9. git init in cto-probe-nonrepo + commit; dispose; POST /session
   → the earlier "global" session of that directory was RE-POINTED to the new project id
10. rm -rf cto-probe-remote; recreate at the same path with the SAME remote; dispose; POST /session
   → SAME id as step 2 (remote-derived ids survive delete+recreate)
Cleanup: DELETE /session/{id} ×12 (metadata-guarded), verify 404; rm -rf all probe dirs.
```

**Residue disclosure:** opencode-managed rows created BY OPENCODE during the probes remain in
`opencode.db` — four inert `project` rows (`2fe13b47…`, `dc99338c…`, `d2727c1b…`, `c4eb0fe0…`)
plus their `project_directory` rows, naming the removed `cto-probe-*` paths. Removing them
would require writing to opencode's DB, which the read-only invariant forbids; they are the
same class as pre-existing stale rows for dead directories. All probe SESSIONS and DIRECTORIES
are gone (verified). `~/.manta` state was never touched.

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
| Stable project ID? | Manta: a minted `projectId` on the config `projects[]` record (§4.1 decision) — ADOPTED 2026-09-19 with the §4.1a rename-rebind rule. opencode: `project.id` is a repository-identity hash — sha1 of the normalized git remote (else cached `<common-dir>/opencode`, else root commit, else `"global"`); N worktrees share ONE project row; moves keep the id; remote-less recreate forks it; remote attach migrates it; `workspace` table unused (0 rows). **ProjectRef mapping RESOLVED + ADOPTED — §4 + decision §4.1 + §4.1a** | derivation + lifecycle PROVEN (probe pass 2026-09-18, §4 probe log) / experimental-workspace semantics UNVERIFIED |
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
  the `previousSessionIds` archive (deduped, newest kept, capped at
  `MAX_PREVIOUS_SESSION_IDS=20` since the P3a3 review — the seams' classification scans it —
  and `getBinding` paginates what the store keeps),
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
BOUNDED bookkeeping (P3a3 review): tombstoned past `MAX_TERMINAL_BACKGROUND` (200, oldest
first — the dedup identity survives in the tombstone list), the submit cap path drops the
oldest QUEUED BACKGROUND records for a human submit, and a background submit with nothing
evictable is refused at `MAX_ENTRIES` (500). `interrupt` is the explicit abort op
(`queued`/`unknown` → cancelled, `accepted` → one bounded `abortSession`); submit never
aborts.

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

Final round (P1/P2): (P1) automatic abort retries are REMOVED entirely — one bounded attempt
per interrupt request; an uncertain attempt (deadline/network) downgrades to a PERMANENT
fail-closed barrier with `abortOutcomeReason: "abort_outcome_unknown"`: no retry ever runs (a
new attempt's response can never settle the ORIGINAL request's uncertainty — monotonic — and a
late original abort could kill the next admitted turn), the record never self-settles even
when the transcript proves the turn ended (`turnEndedAt` recorded for visibility only), the
same-session admission barrier persists across restarts, and resolution is a future EXPLICIT
management operation (not built in this phase). A crash BEFORE the first attempt (state
"pending") still gets exactly one attempt from reconcile. (P2) the dispatch claim's priority
re-validation (unresolved gate, human FIFO, selected-still-queued CAS) moved INSIDE the same
admission-mutex section that reserves — the round-3 verification read outside the mutex could
miss a commit landing between it and the reservation; the binding claim lock stays OUTER and
the locks still release before the external POST. Pinned by latches: human-commits-before-
claim wins via the in-mutation re-validation, and a commit during the reservation mutation
queues behind the mutex (atomic verify+reserve, no interleave).
Final P1 correction (offline repro): the round-4 "pending" state was only a LOCAL marker
written before the await — an HTTP abort could already be outstanding when the store still
said "never attempted", so a restart could issue a SECOND abort. Fixed by ordering: the
attempt is RESERVED durably BEFORE the HTTP — one admission-lock section writes the atomic
token (abortState "claimed" + attemptId + attemptStartedAt + attemptCount), the lock releases,
and only then is the POST issued (local active-operation lease, no lock across the external
await). The live owner settles ONLY its own matching attemptId (a recovery downgrade or any
newer state is never overwritten — monotonic). Recovery treats ANY attempted-but-unsettled
("claimed" without its owner) AND any "pending" as uncertain: reconcile NEVER issues aborts,
no retries exist, and the same-session barrier persists until a future explicit management
operation. Pinned by a crash snapshot taken INSIDE the abort mock (proving the token precedes
the HTTP), a restart asserting zero aborts + zero next sends, the original request released
afterward with the barrier persisting (the matching-attempt guard rejects the dead owner's
late response), and concurrent interrupt+reconcile claiming at most one attempt.

CAPO-352 settlement round (live incident: the box's queue wedged 96h): both gaps are the same
family — recovery required an event (or a linked assistant row) that never comes. The incident's
exact transcript shape (modeled in the fixtures, not imagined): the user row persisted, ZERO
assistant rows after it — on which BOTH the strict completion reader and the weak turn-ended
reader return not-settled forever. (1) `accepted` now settles from the PERIODIC reconcile with
no event: the messageID receipt is read back from the transcript — absent ⇒ stays accepted with
stamped `lastReceiptCheckAt`/`receiptChecks` bookkeeping (the same semantics as the unknown
path, never resent); a terminal linked row ⇒ completed (strict reader, unchanged); the no-row
shape ⇒ interrupted (outcome via "transcript-no-row") once the record has sat rowless past
`ACCEPTED_NO_ROW_GRACE_MS` (15 min from `acceptedAt` — a live turn produces its first linked row
in seconds, so rowless-past-the-grace is the proof the turn died). (2) `interrupt_pending`
settles the no-row shape when — and only when — the abort is DEFINITIVELY "ok" (the server
confirmed nothing is running), the user row IS present, and `INTERRUPT_NO_ROW_GRACE_MS` (30s,
measured from `abortSettledAt` — one bounded-read window plus slack, ≥2 recheck cycles) has
passed since the abort settled: interrupted with outcome via "abort-no-row", reachable from BOTH
triggers through one decision point (`settleInterruptPending`; the event tap no longer
pre-filters the no-row shape away). A claimed/uncertain/refused abort keeps the barrier in every
shape (the general rule is NOT weakened), and a receipt that is absent settles nothing. Shared
reader `turnEndShapeFromTranscript` extracts receipt-presence + linked-row-presence + weak
ended-ness (the weak reader's contract is unchanged); graces pinned in the published-contract
test. Every settlement has fail-first tests plus counterfactual controls (young accepted,
linked running row, absent receipt, uncertain abort, within-grace), and both new settlement
branches were broken in source and watched RED before landing.
