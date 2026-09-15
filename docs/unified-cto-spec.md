# Unified CTO: Conversation, Context and Delivery

Status: implementation specification; not implemented by this document.
Date: 2026-09-15.
Verified source baseline: `9f0756caa67fc2a9105649bed76e181d16c155d8` on main.
Intended implementer: `voskaai/default`; independent reviewer: `gpt-6-astra`.

## 1. Product contract

The user is the CEO. They direct one CTO through one conversation in the existing CTO tab. The CTO discovers context across projects, develops ideas with the user, maintains specifications, organizes background work, verifies delivery and reports outcomes. Projects, sessions, model selection and cleanup become the CTO's working tools, not responsibilities pushed back onto the user.

Example acceptance journey:

> Brainstorm onboarding for Project X. Write the spec, implement it, have it reviewed, and ship it to staging. Leave production alone.

The CTO researches without waking Project X's agents, discusses alternatives in its own conversation, records the chosen scope, dispatches workers into the correct repository, handles review/fix rounds, publishes to staging and verifies the staging result. If a genuine decision is required, it asks in the same conversation. The user may discuss Project Y while Project X continues in the background.

### 1.1 Normative decisions

- One CTO conversation per box, shared across paired clients. No second Electron window, separate chat pane, or conversation per project.
- Reuse opencode for agent execution and transcript persistence. Do not build another model loop, provider client, transcript database or agent framework.
- Reuse Manta's project/session/job/forge/release operations. Do not maintain a second project list or execute a second implementation of those operations.
- The secret store remains the single full-access grant for matching services, as shipped in #1505. No connect asks, imported-secret distinction, read/write split, or new consent ladder.
- Access is not intent: possessing a credential enables a service; it does not itself request a deployment or destruction of data.
- Explicit user instructions and autonomous actions use the existing action-policy paths. Preserve the current calibrated autonomy rule, rather than introducing action-tier permissions.
- Retrieving project context never sends a project prompt, creates a worker, or brings a project agent into memory.
- Background jobs do not interrupt an active CTO response. Routine outcomes do not require a model turn merely to appear.
- Project identity, spec revision and source references are carried explicitly with work. Never infer the target from the CTO conversation's current directory or the first open project.
- Completing a worker is not completing the work. The declared delivery target determines completion.
- Archive conversations before considering history deletion. Never delete evidence merely to reduce sidebar clutter or obtain a fresh prompt cache.
- The central CTO owns management capabilities. Worker children do not automatically inherit authority to reorganize the box.

### 1.2 Not in scope

- A new task-board product, permanent agent per project, general workflow language, vector database, or event-sourcing framework.
- Migration from opencode to OpenAI Agents API.
- Automatic restoration of unknown historical facts, or claiming lost/deleted evidence can be recovered.
- New billing integrations, exact provider cache control, or assumed large-context model support.
- A second voice conversation. Existing voice entry points must eventually address the same CTO identity; replacing the Realtime voice transport is not a prerequisite for text chat.
- Automatic destructive cleanup of user-created resources or permanent deletion of conversation history.
- Implicit permission to publish this specification or deploy its implementation. Each implementation work order states its delivery target.

## 2. Existing architecture and reuse map

Paths below refer to the verified baseline, not the older documentation branch holding this spec. Before implementation, fetch main and confirm these seams still exist. If a seam changed, update the implementation map; do not implement against a stale checkout.

| Concern | Existing source | Required integration |
| --- | --- | --- |
| CTO UI | `src/renderer/CtoPanel.tsx`, `ChatPanel.tsx`, `App.tsx` | Replace primary CTO dashboard surface with the existing transcript/composer presentation; keep details secondary |
| Native client | `mobile/native/AGENTS.md` and native CTO/chat screens | Same server contracts and conversation; read native guide before selecting exact files |
| Session transport | `src/server/opencode.mjs`, `tmux.mjs`, `rpc.mjs` | Existing session creation, directory binding, SSE readiness and lifecycle operations |
| Read-only history | `opencodeDb.mjs`, `messageSearch.mjs` | All-session discovery, ranked search and message-neighborhood reads |
| Facts and summaries | `ctoSegments.mjs`, `ctoRollups.mjs`, `ctoFacts.mjs`, `ctoBackfill.mjs` | Retrieval hints with source evidence and freshness, not substitutes for live verification |
| Provenance | `internalSessions.mjs`, `topology.mjs` | Distinguish CEO conversation, workers and ephemeral ambient inference |
| Policy and actions | `ctoGate.mjs`, `ctoAct.mjs`, `ctoTriage.mjs` | One policy decision and generic execution path; do not create a parallel autonomy engine |
| Background execution | `delegate.mjs`, `ctoSessions.mjs` | Worktree/session creation, job control, terminal events and boot reconciliation |
| Storage | `ctoStores.mjs`, `src/shared/paths.mjs` | Serialized versioned stores; all new state participates in test sandboxing |
| Delivery | `promptDelivery.mjs`, `cto.mjs`, `push.mjs` | Durable, deduplicated CTO events; preserve existing notification routing |
| Forge | `forge/index.mjs`, `rpc.mjs` | Existing PR, check, review and SHA-bound merge operations |
| Resource policy | `ctoBudget.mjs`, `ctoOvernight.mjs`, model routing | Shared capacity admission and current budgets, not another scheduling universe |
| Service access | `secrets.mjs`, `ctoToolRegistry.mjs`, `ctoProbes.mjs` | Preserve store-derived grants and single identity/credential/destination boundary |
| Releases | `.github/workflows/`, `codemagic.yaml`, release scripts | Invoke existing project-declared pipelines; no guessed universal deploy command |

Known integration hazards that MUST be verified, not assumed fixed:

- `promptDelivery` deferral is currently memory-only. Submission acknowledgment is not completion of a model turn.
- Current CTO inbound behavior is oriented around the voice-call window, not a durable text conversation.
- Some search/list operations enumerate live tmux windows rather than all historical database sessions.
- Background job cleanup may remove a clean worktree before later review stages need it; explicit deletion and automatic cleanup have different failure ordering.
- Existing delegation resolves a workspace through its parent's tmux window, can fall back to the original directory after a worktree failure, and allocates its job ID after resource creation. A headless CTO cannot use those assumptions unchanged; section 8.1 specifies the shared-service extension.
- Worktree isolation must be explicit for an implementation stage. Inferring writes solely from permission names misses shell commands that write.
- Existing `session-ok` or worker-authored `CHECK:` text is not independent proof of successful tests, review, or deployment.
- Model switching that only emits renderer state cannot configure a headless worker.
- Existing rollup readers need project filtering, deterministic newest-first ordering and reference drill-down before they can be the chat's retrieval foundation.

## 3. UX and conversation identity

### 3.1 One durable role session

Create or recover one durable opencode session bound to the box's CTO role. It is displayed in the existing CTO tab, not as a second sidebar chat or new window. The role session uses normal opencode session, message and SSE services. It does not need a tmux holder: those remain the representation for ordinary project worker windows.

Its directory is a stable server-owned CTO control directory under the state home, not a project repository. This directory is never an implicit target for implementation. Creating the role session must not create a repository or duplicate a user project.

Persist a small role binding with current session ID, previous session IDs, generation and creation/recovery operation ID. Concurrent opens from desktop and phone return the same binding. Record creation intent before the external create; a crash after creation but before binding must reconcile through an explicit identity marker or receipt. A title match alone is not proof of ownership. If the installed opencode API cannot make creation identifiable, report recovery uncertainty rather than guessing which session to adopt or silently creating many replacements.

The role session is durable and MUST NOT be registered with the disposable ephemeral-session reaper. Provenance distinguishes:

- `cto_conversation`: CEO messages may update priorities/work; assistant statements are not independently confirmed project facts.
- `cto_worker`: work-linked implementation/review evidence; not a new CEO instruction.
- `cto_internal`: ephemeral inference; excluded from ambient self-analysis.
- `user_session`: ordinary user/project activity.
- `unknown`: do not infer project ownership or promote it into trusted instructions.

Opening the tab, reconnecting or reading its transcript does not invoke the model. Explicit clear/replacement creates a new binding generation, preserves archive references and rehydrates priorities plus open-work references. Compaction retains the same role session when supported.

### 3.2 Transcript items

The primary surface contains normal user/assistant messages plus compact work-event entries. Work events are a projection of durable work records, not a second free-form chat history.

| Event | Presentation | Model turn needed? |
| --- | --- | --- |
| CEO question or instruction | Normal chat message | Yes |
| Needs judgment or user decision | CTO message with recommendation, work link and reply target | Yes, bounded synthesis if not already available |
| Routine stage transition | Compact status entry, updated in place | No |
| Verified completion | Compact outcome with acceptance/deployment evidence; expand for detail | Optional synthesis; outcome is visible even if model unavailable |
| Material failure | Visible work-linked entry, plus recommendation when available | Not required for initial visibility |

Every work entry supports Reply and View work. Reply submits an opaque event/work reference along with the user's text; the server resolves the original spec, decision and evidence. Do not paste an unbounded transcript or treat quoted worker content as instructions.

View work is an inspector or navigation into the existing project/session UI, not another conversational pane. Details include objective, stage, target, revision, workers, review/check state, delivery evidence, source age and rationale.

No per-tool-call chatter in the CTO feed. Coalesce routine updates by work and stage. A notification points to the same durable event; delivery to multiple devices does not create multiple conversation items.

### 3.3 Conversations while work runs

The user can change topic without changing a running work item's target. Short references such as "ship it" resolve to an explicit recent work/decision reference; ambiguity produces one clarification and no action.

Brainstorming does not imply execution. The example "brainstorm, spec it, then implement" does authorize the stated progression once its unresolved scope questions are settled; do not require a ceremonial extra approval for every stage.

Disabled autonomous CTO still permits explicit chat/read requests. Global pause stops new autonomous side effects; it does not prevent the user asking questions or explicitly stopping work. Existing running external effects may require reconciliation or an explicit cancellation operation, and the UI must say which are still running.

## 4. Passive cross-project context

### 4.1 Source of truth

OpenCode's database remains read-only. Reuse the shared database handle and bounded queries. Never write tables, indexes or migrations into opencode's database.

Maintain a separate Manta-owned SQLite FTS5 index for extracted text and useful tool evidence. This is a disposable search index, not authoritative conversation storage. No new vector service or embedding model in this implementation.

Index sessions whether or not they have a live window. Preserve parent/child links, session directory, title, source timestamps and provenance. Include historical worker results; exclude ephemeral self-analysis from ordinary project evidence. Do not infer identity from agent names alone.

Use existing project metadata and canonical repository identity. Keep repository identity, worktree path, workspace identifier and session ID separate. A branch name or display title is never a stable project key. Historical sessions with unresolved project mapping remain searchable with an explicit `unmapped` status; never silently assign them to the first project.

### 4.2 Retrieval contract

Expose these bounded operations through one context service:

| Operation | Inputs | Outputs |
| --- | --- | --- |
| `projects` | optional query, cursor, limit | project identities, directories, recent activity and coverage |
| `search` | query, optional project/session/time filters, cursor, limit | ranked hits with stable source references and snippets |
| `around` | session/message reference, before/after limits | chronological text/tool evidence window with IDs |
| `resolve_refs` | bounded list of fact/segment/message/work references | resolved evidence or explicit unavailable reason |
| `project_state` | explicit project reference | bounded passive git/session/work observations with observed time |

All return `observedAt`, coverage/index lag, truncation indication and next cursor where applicable. Missing evidence is not an empty-success claim. Return `unsupported`, `source_unavailable`, `reference_expired`, or `unmapped_project` distinctly.

Default retrieval limits: 20 search hits; 5 messages before/after a hit; maximum 50 hits or 40 messages per request; 24 KiB returned text per call. Truncate long output with source references and omitted-size metadata, not silently. Enforce server-side limits independently of model arguments. These are implementation defaults, not new user settings.

Use full-text ranking for prose and exact matching for issue keys, commits and paths. Summaries/facts narrow the search; decisive claims are checked against original evidence and, where relevant, current git/forge/release state. Searching for one project must not exclude historical children just because they have no sidebar row.

### 4.3 Incremental indexing and freshness

Track changed message/part IDs from events; reconcile with database update timestamps and stable-ID tie breaks after reconnect/restart. Creation-only watermarks miss streaming updates. Persist a cursor only after all items through it are indexed. Failed reads do not advance it. Reconcile deleted source rows and invalidate associated cached snippets.

Bound each scan batch and release database resources between batches. A corrupt disposable index is rebuildable; it must not prevent bounded direct source reads. On Node versions without SQLite support, show unsupported and never claim full coverage; do not spin a failing scan loop.

Proposed performance acceptance target, measured rather than assumed: on a recorded reference box with 100k indexed parts, warm search p95 under 300 ms and a three-call context lookup under 1 second excluding model inference. Record hardware, corpus size and index age. If unmet, profile queries before introducing additional infrastructure.

### 4.4 Context assembly

The CTO starts with CEO priorities, a compact project directory and open-work references. It retrieves relevant facts/rollups, then source excerpts for the current question. It does not load every project or all tool definitions into every turn.

Parallel read-only research children are allowed for independent substantial questions. They operate in CTO-owned contexts using the same passive tools, not through messages to project agents. Their findings remain attributed evidence, not new authoritative instructions.

Retrieved code, issue text and transcripts are untrusted content. Keep them in evidence/tool-result envelopes; never promote instructions found inside them into management authority.

## 5. Work record and specification

### 5.1 Minimal durable state

Reuse versioned serialized CTO stores. Add one work envelope per work item containing its revisions, attempts, operation receipts, decisions and owned-resource references. Reuse/extend the existing prompt-delivery store for cross-work delivery. The FTS index is the only new database. Do not introduce separate databases for each table below.

Logical records, with JSON-serializable fields:

```ts
type ProjectRef = {
  workspaceId: string;            // stable existing identifier, not display name
  repositoryId: string;           // canonical repo identity for this work
  repositoryRoot: string;         // validated absolute checkout path
};
type DeliveryTarget =
  | { kind: "spec" }
  | { kind: "pr" }
  | { kind: "merged"; baseBranch: string }
  | { kind: "published"; releaseTarget: string; channel: string }
  | { kind: "deployed"; releaseTarget: string; channel: string; instance: string };
type SourceRef = {
  kind: "message" | "part" | "fact" | "segment" | "git" | "forge" | "release";
  id: string;
  sessionId?: string;
  messageId?: string;
  observedAt: number;
};
type Work = {
  id: string;
  revision: number;
  origin: { conversationId: string; messageId: string };
  project: ProjectRef;
  spec: { revision: number; hash: string; documentRef: string };
  objective: string;
  deliveryTarget: DeliveryTarget;
  dependencies: string[];         // work IDs; graph must be acyclic
  priority: number;               // reuse current ordering convention
  priorityReason: string;
  stage: "specify" | "implement" | "review" | "merge" | "release" | "verify";
  state: "draft" | "ready" | "running" | "waiting" | "paused" |
         "needs_decision" | "failed" | "completed" | "cancelled" | "archived";
  waitingReason?: "dependency" | "capacity" | "provider" | "external" | "reconcile";
  attempts: Attempt[];
  operations: OperationReceipt[];
  decisions: Decision[];
  resources: OwnedResource[];
  evidence: SourceRef[];
  createdAt: number;
  updatedAt: number;
};
```

These names are proposed contracts, not claims that existing exported types have these names. Phase 0 maps existing stable project identifiers into `ProjectRef`; if the existing system lacks one, extend its metadata once rather than inventing a second project registry. A work item has one execution repository; cross-project initiatives consist of linked work items.

`Attempt` records stage, attempt number, spec hash, delegate/session ID, resolved model ID, repository/worktree reference, base/head SHA, status and result references. Delegate job storage remains authoritative for low-level job state; do not duplicate its logs.

`OperationReceipt` records caller idempotency key, canonical request hash, expected work revision, stage/spec hash, status, external identity, lease owner/expiry, result code and timestamps. Valid statuses are `pending`, `in_flight`, `succeeded`, `failed`, `unknown`. Unknown is not safe to retry without reconciliation.

`Decision` records question, recommendation, allowed response shape, originating work/spec revision, state, response reference and answered timestamp. Accepted responses change the work once. Old/spec-incompatible responses fail visibly rather than starting a second attempt.

`OwnedResource` records exact resource ID/path, creator work/attempt, `owned` or `borrowed`, active references, preservation evidence and cleanup status. Never infer ownership from a title, branch prefix or directory name alone.

### 5.2 Specification format

Each work spec has a stable ID, monotonically increasing revision and content hash. Required sections:

1. Goal and user-visible outcome.
2. Target project/repository and relevant baseline commit.
3. Context and evidence references.
4. In scope and explicitly out of scope.
5. Behavior and interface contracts, including failure behavior.
6. Acceptance criteria with executable verification where possible.
7. Delivery target and target-specific verification.
8. Dependencies, unresolved decisions and constraints.

Drafting is permitted in the CTO's control directory; a final project spec is stored in the target project's normal documentation location through the ordinary worktree flow. The work record points to the exact revision; workers never consume a mutable "latest spec" halfway through an attempt.

Spec revisions invalidate incompatible results. Reprioritization alone does not change the spec hash. A meaningful scope/acceptance change pauses advancement, checkpoints running work and creates a new revision before dispatch resumes.

## 6. State transitions and action semantics

| Transition | Preconditions | Durable result |
| --- | --- | --- |
| draft -> ready | explicit target, complete spec, no unresolved blocking decisions, delivery target known | spec hash and policy/instruction reference |
| ready -> running | dependencies met, capacity claimed, target revalidated, operation reserved | one stage attempt linked before prompt dispatch |
| implementation ends | actual job terminal event and attributable result | candidate commit or visible failure; not work completion |
| review starts | candidate commit and acceptance criteria fixed | independent review attempt for exact SHA/spec hash |
| review requests changes | actionable findings | repair attempt linked to same work; prior approval invalidated |
| review approves -> merge | exact head approved; required checks pass; target branch verified | SHA-bound merge operation and observed merge SHA |
| merge -> release | delivery target requires it; release contract exists | one pipeline/tag operation with run/artifact identity |
| release -> verify | intended artifact exists | live verification against intended instance/channel |
| -> completed | declared delivery target and acceptance criteria satisfied | completion evidence, not merely worker prose |
| -> needs_decision | genuine ambiguity, exhausted bounded recovery, or user-only dependency | one work-linked question with recommendation |
| -> cancelled | cancellation intent persisted; running effects reconciled | no further dispatch; unfinished effects explicitly reported |

For `spec`, completion follows a settled spec; for `pr`, independent review and required checks must pass on an open PR, but merge is not required. Stages not needed for the declared target are explicitly skipped, not recorded as successful executions.

Pause stops new stage admission and requests a safe checkpoint from running workers. It must not claim an already-started external deployment stopped. Stop/cancel uses existing abort/job controls, preserves partial work and reports external effects that could not be cancelled. Resume reconciles existing resources before deciding whether to reuse or replace an attempt.

"Do this first" changes scheduling priority and pauses lower-priority admission. Do not kill an in-progress external release merely to reorder a queue.

### 6.1 One policy path

Every side-effect operation is associated with either a specific CEO instruction or an existing autonomous plan-policy decision. The work coordinator orchestrates stages; it does not implement a competing confidence classifier. Existing budget, provider availability, target integrity and explicit standing instructions apply at dispatch time.

The intended central CTO has full Manta management capabilities. At the supported tool boundary, management tools are withheld from workers, caller session identity comes from runtime tool context rather than model arguments, and the server checks the registered role binding. Supplying `role:"cto"` or copying a work ID in tool arguments does not confer the role.

This is NOT strong process isolation from an agent with unrestricted same-user shell/file access. Existing custom tools authenticate with a shared box credential and carry session identity in a request body; they do not cryptographically attest which agent sent that body. A worker able to read the box owner's files or execute arbitrary commands may reach the same APIs. Do not describe role checks as preventing that attack. Stronger operating-system/runtime isolation would be a separately designed prerequisite, not an implicit deliverable here. U25 covers forged content and supported-tool arguments, not a hostile process already holding box-owner execution.

Do not surface new per-stage access questions. A failed correctness check returns a clear error for the CTO to repair. Ask the user only when its intent is genuinely unclear or available policy cannot resolve a material decision.

## 7. Manta control tools

Expose a small typed tool family. Use action-specific schemas/discriminated unions; no shell-like expression language, arbitrary RPC forwarding or unvalidated `args` bag. Exact public names can follow existing tool naming conventions, but operation names and semantics must match this table.

| Family | Read operations | Mutating operations |
| --- | --- | --- |
| projects | list, inspect | create, update, archive, remove |
| sessions | list, inspect, usage | create, configure, fork, compact, archive, remove |
| context | projects, search, around, resolve_refs, project_state | none |
| work | list, inspect, evidence, capacity | create, revise, prioritize, dispatch, pause, resume, cancel, retry, answer_decision, archive, cleanup |
| memory | priorities, decisions | set_priority, supersede_instruction, record_decision |

Review/merge/release/verify are work-stage operations using existing forge/release services, not generic commands that skip work preconditions. Session configuration supports server-owned model/effort selection and cwd at creation; it never depends on a renderer receiving a model-switch event.

All mutations accept a stable idempotency key; updates accept expected revision. Successful responses include operation ID, resource/work ID, resulting revision/state and visible summary. Errors use stable codes, an actionable message and whether retry is safe:

`target_not_found`, `target_ambiguous`, `target_changed`, `revision_conflict`, `capacity_wait`, `policy_blocked`, `provider_unavailable`, `unsupported`, `dirty_resource`, `borrowed_resource`, `active_resource`, `evidence_missing`, `external_outcome_unknown`.

Do not return success for a no-op stub. "Already applied" is a successful replay of a known operation, with its original result. The same idempotency key with different arguments is an error.

Read tools have no reference to prompt dispatch/worker creation in their dependency graph. Test this by wiring throwing send/create spies at the production composition boundary.

Project/session tools delegate to the same server operations used by the UI. Preserve protections against deleting borrowed resources; destructive removal is a different request from archive. No new authorization ladder is introduced by returning `dirty_resource` rather than losing work.

## 8. Durable orchestration and delivery

### 8.1 Operation protocol

Extend the existing shared delegate service, rather than wrap its current caller-directory assumptions. Separate `completionParentSessionId` (the headless CTO conversation) from the validated execution target: project/workspace, repository/base revision and `isolationRequired`. Accept a preallocated operation/job identity and persist its reservation before creating any worktree, window or opencode session. Correlate each created resource with that identity for adoption after a crash. Ordinary delegate callers retain their existing behavior unless they request this explicit contract.

For implementation work, `isolationRequired` is true. A worktree failure must fail before prompting, never fall back to the original repository directory. A headless completion parent does not require its own tmux holder. Target workspace resolution uses the explicit project reference, not parent lookup. Reserve this contract in P2; implement and test the actual shared creation path in P4.

1. Validate caller, target, revision, policy and request shape.
2. Under the existing serialized store mechanism, reserve an operation and any exclusive resource lease.
3. Release the lock before external calls or model work.
4. Execute through existing services with the operation correlation ID.
5. Persist the observed result and stage transition.
6. Enqueue a stable work event for the CTO conversation.

Never hold a store lock while awaiting a model, forge API, shell process or another store operation. Capacity admission across work items must be serialized at one shared admission seam. Reuse existing caps (currently five delegate jobs, two CTO executor plans); do not bypass either by creating sessions manually.

The atomic-write boundary is the work envelope, not several independently saved JSON files. Cross-store/external effects are reconciled through receipts; do not claim transactional exactly-once behavior across HTTP.

### 8.2 Crash and retry behavior

| Crash/uncertainty point | Required recovery |
| --- | --- |
| Before external dispatch | reserved operation can be resumed after lease recovery |
| After worker creation, before result save | adopt the matching operation-correlated worker; never create another blindly |
| After merge/tag/deploy request times out | inspect exact PR head/tag/run before retrying |
| Worker disappears | preserve references and report missing attempt; recover checkpoint or retry stage under a new attempt |
| Completion event repeats | same event/attempt advances work at most once |
| Old attempt completes after spec change | preserve evidence, mark superseded, do not advance current work |
| Provider quota exhausted | wait with reason/provider state; use only an allowed fallback, never silently substitute a user-requested reviewer |
| State file corrupt | visible unhealthy state; preserve file and stop unsafe dispatch, not reset to an empty healthy portfolio |

Reuse existing retry budgets. Human-facing behavior must be bounded: repeated failure produces one actionable escalation, not endless reviewer/repair turns. A configurable-by-existing-policy attempt limit may govern runtime work; do not hardcode the lengthy review loop of this spec's authoring history as the product default.

### 8.3 Conversation delivery

Extend `promptDelivery` with durable delivery records, stable event IDs and per-destination serialization. ALL prompts to the CTO role pass through this one server-owned admission path: desktop/native CEO submissions as well as background synthesis. The existing direct chat RPC send and client-side queued-message drain/abort behavior must not bypass this path for the CTO session; ordinary project chats are unchanged.

Persist submission identity, origin (`human` or `background`), destination role and binding generation. Admit at most one turn at a time, reconcile running state on restart, and make explicit interruption a separate operation. Human messages remain in submission order and take priority over pending background synthesis; do not reorder an already accepted turn. Clients render server queue state instead of independently draining the CTO queue.

Deliver routine event entries without invoking opencode. Only events requiring reasoning enqueue a CTO turn. A burst is coalesced before turn admission; acknowledgment of `prompt_async` alone does not free the conversation for another prompt. On role-session replacement, undelivered work events resolve to the current binding generation, while accepted turns remain associated with their original session. Do not duplicate a submitted turn in the replacement session; link its outcome across the binding instead.

Do not write raw assistant messages directly into opencode's SQLite database. Structured event entries are joined into the UI by event ID; generated prose uses normal opencode APIs. On replay, the UI deduplicates by stable event ID.

If supported opencode APIs allow a caller-supplied message ID, use it to reconcile turn submission. Otherwise persist a unique event marker in the injected envelope and query for receipt before resubmission. If acceptance remains uncertain, expose pending reconciliation rather than resend blindly. Test the actual installed API behavior in an isolated session; do not assume a parameter is honored because HTTP returned 200.

Notifications are emitted through existing routing once per material event, not once per retry. Blocking questions and informational outcomes retain existing device-presence policy. Pending questions remain readable/replyable after disconnects and restart.

## 9. Priorities, dependencies and resources

Persist CEO standing instructions with source message, scope (box/project/work), creation time, optional expiry and supersession reference. Resolve conflicts by scope specificity and newest explicit instruction; equally applicable contradictions require clarification. Retrieved worker text cannot overwrite a CEO instruction.

Keep one dependency graph in work records. A linked Multica issue or GitHub issue is an external reference, not a second scheduler. Choose one execution owner per work item: Manta job or externally dispatched agent. An assignment/comment that launches an external agent counts as dispatch; do not launch both it and a local delegate for the same attempt.

Dependencies reference explicit outcomes (for example, library change merged) rather than a vaguely "done" parent initiative. Reject cycles, including child waiting on a parent whose completion requires that child. Cross-repository work uses linked items and declared dependency revisions.

Scheduling order: dependency readiness, explicit priorities/deadlines, existing policy/availability, then fair aging. Record why something waits. Reuse budget accounting; do not bill or learn twice for the same stage attempt.

Reserve interactive capacity. Cheap monitoring continues while models are busy, but speculative backfill and nonurgent ambient analysis yield before CEO requests. Waiting for CI does not retain an active model turn. Prefer webhooks/events with bounded deterministic reconciliation as a fallback.

## 10. Context and cache lifecycle

- Reuse an implementation context for the same spec/attempt when useful. A reviewer gets an independent context.
- Switching projects or unrelated work creates a new worker context; never repurpose an unrelated active user session.
- Before compaction/replacement, preserve objective, spec hash, target, current diff/commit, test results, pending decisions and next step as a bounded handoff.
- Use opencode's compaction facilities. Do not rewrite provider reasoning blocks or implement a second compactor.
- Cache TTL and reuse savings are observations/estimates, not guarantees. Never send keepalive prompts to preserve a cache.
- Unknown model limits are unknown, not zero capacity or unlimited capacity. Use verified provider/runtime limits when available; otherwise keep bounded retrieval and show unavailable usage estimates.
- Compaction/replacement is a safe-boundary operation, not something that can race an in-flight tool call.
- The CTO's own conversation can compact; priorities, work state, source references and decisions live outside it and are rehydrated by reference.

## 11. Review, merge, release and verification

Review is independent of implementation context. Record reviewer model ID, reviewed head SHA, spec hash, findings and verdict. A reviewer failing to start is a blocked review, not a passed review or permission to switch to another requested model.

When head SHA changes, invalidate approval. If only nonbehavioral material changed, an independent reviewer can explicitly confirm the new head; do not preserve old approval silently. Required checks are queried from the forge and must correspond to that head. Merge uses a matching-head precondition.

Each project release contract identifies its existing pipeline, allowed target/channel, source revision mechanism, artifact identity and verification procedure. It is data referencing existing workflows, not an arbitrary executable DSL. Missing contract -> spec/PR/merge work can finish at its declared target; requested deployment is visibly blocked rather than guessed.

Distinguish these observations:

- implementation reported complete;
- tests executed and passed;
- independent review approved exact head;
- merged commit exists;
- release artifact published;
- target instance runs expected artifact;
- acceptance checks passed on that instance.

Production verification never trusts a green build alone. Check expected SHA/artifact digest/version against the actual target as supported. Secrets stay in existing service clients; do not put tokens into work records or logs. Before an authorized configuration/infrastructure mutation, preserve a recovery reference. Rollback is an explicit operation with its own result, not assumed possible for every migration.

## 12. Ownership and cleanup

The CTO may create normal projects and sessions, but completing a task generally retires workers, not the project. Projects are durable unless created as explicitly temporary CTO-owned workspaces.

Archive marks work/sessions inactive in the existing UI while preserving transcript and evidence access. Do not implement archive by calling an API that deletes the opencode session. Add minimal archive metadata to existing session/project ownership storage if needed.

Cleanup eligibility requires all of:

- Explicit ownership record says CTO-created, not borrowed.
- No active job, open question, pending reconciliation or reference requiring the live resource.
- Worktree is clean; all work is preserved in a retained branch/commit with a resolvable repository.
- Review/release stages no longer need that checkout.
- Evidence and durable work record remain available after removal.

Cleanup order: validate and record intent; preserve evidence/refs; remove disposable worktree through existing non-forced operation; remove holder window if appropriate; record success. Failure at any step retains enough metadata to retry and remains visible. Never drop a job/resource record just because removal threw.

Do not automatically delete remote branches or permanent conversation history. User-created resources require an explicit user instruction for removal. Automatic cleanup can archive a terminal CTO worker at the end of its work; physical removal uses the existing retention cadence after eligibility checks. Do not introduce a new aggressive timer.

## 13. Migration and rollout

- Additive versioned stores; idempotent initialization; no live resets.
- Existing facts, priorities, jobs, tool grants and action policy remain in place. Existing connect-card retirement stays as shipped.
- Bind an existing known role session if available; otherwise create once using the recoverable binding protocol. Do not import every project transcript into it.
- Old cards/inbox entries can appear as dated history with source references, but must not become fresh execution instructions.
- Existing active CTO work is reconciled and linked where provenance is authoritative. Unattributed jobs remain visible as unmanaged; do not invent ownership or delete them.
- Migrate the CTO dashboard into conversation plus detail inspector. During staged implementation, unsupported capabilities are visibly unavailable, never no-op controls.
- Desktop and native clients share service contracts. Read the native agent guide and verify Swift changes on the supported Mac build path; Linux typecheck is not iOS verification.
- Release with normal pipeline, verify the installed commit, then run the live acceptance journey on a disposable project. A merged PR is not rollout completion.
- Rollback preserves the new data files and does not erase work history. Older clients may not render new entries; server-side work and safety checks must remain intact.

## 14. Acceptance and evaluation suite

Use deterministic fixtures with source IDs, two distinct repositories, multiple worktrees, closed sessions, child sessions, duplicate events and crash points. Inject external services and use `MANTA_STATE_HOME` sandboxing. That variable does NOT redirect OpenCode's source database: every database integration fixture must set `MANTA_OPENCODE_DB` to its fixture database before the shared handle opens, and assert that its resolved path cannot fall back to the production home directory. No test reads production credentials, private transcripts or mutates the maintainer's running box.

| ID | Scenario | Required observation |
| --- | --- | --- |
| U01 | Two clients open CTO concurrently, then server restarts | one durable conversation, no duplicate window/session, no model invocation on open |
| U02 | Ask about Project B while Project A is running | answer uses B evidence; A target/revision unchanged |
| U03 | Historical decision exists only in a closed child session | retrieval finds and resolves the original message |
| U04 | Read/search all projects | zero prompt sends, worker creates, window creates or project agent wakes |
| U05 | Tool result contradicts worker's "done" message | CTO distinguishes claim from verification, cites result |
| U06 | Streaming part changes after initial indexing | updated result searchable; failed scan does not advance cursor |
| U07 | Ambiguous project name / renamed workspace / stale cwd | clarify or fail explicitly; never use first project/home |
| U08 | Brainstorm only | no implementation dispatch |
| U09 | Brainstorm -> settled spec -> implement -> review -> staging | exact project/spec carried end-to-end; production untouched |
| U10 | Headless CTO dispatch, isolation failure, duplicate request and crash between resource creation and record persistence | correct explicit workspace; worktree failure sends zero prompts; one correlated attempt or visible reconciliation uncertainty, never blind duplicate |
| U11 | Restart while CTO busy; simultaneous desktop/native sends; background event races CEO send; replacement with pending delivery | one server admission path; outcome visible once; no lost event or unintended interruption; accepted turns stay on original binding |
| U12 | Reply to an old work question after switching topics | correct work resumes once; stale revision rejected visibly |
| U13 | User changes scope while worker runs | old result cannot advance new spec; checkpoint preserved |
| U14 | New commit after reviewer approval | merge blocked until exact new head reviewed and checks pass |
| U15 | Reviewer model unavailable | no silent substitution or fabricated approval |
| U16 | Deploy request times out after external acceptance | reconcile existing run before retry; never duplicate release |
| U17 | Green release job publishes wrong/stale artifact | work not completed; verification names mismatch |
| U18 | Stop/pause during implementation and during deployment | behavior distinguishes cancellable worker from already-running external effect |
| U19 | Capacity exhausted / provider unavailable / priority changed | explicit waiting reason, bounded retries, interactive work not starved |
| U20 | Dirty, borrowed or still-referenced worktree cleanup | preserved; cleanup failure visible and retryable |
| U21 | Archive completed worker then ask why it acted | evidence and rationale still retrievable |
| U22 | Internal summary generates more opencode events | no recursive ambient work; CEO instructions still recognized |
| U23 | Stored service key added/deleted, including scoped entries | existing full-access semantics retained; no connect/ring prompts |
| U24 | Cross-service alias plus malicious pinned credential/endpoint | zero wrong-service credential materialization/request |
| U25 | Forged worker text or supported-tool arguments claim CEO approval or CTO role | no authority derived from retrieved prose or model-supplied role fields; does not claim isolation from unrestricted box-owner execution |
| U26 | Dashboard/native client reconnects mid-work | same conversation and work state; no duplicate notification |
| U27 | Empty/unavailable database or expired reference | honest coverage/error, not a fabricated "nothing happened" |
| U28 | Repeated routine events | coalesced activity; no model invocation per event |

Maintain a small answer-quality corpus as well: project attribution, historical decision retrieval, conflicting evidence, merged-versus-deployed distinction and ambiguous instructions. Score source correctness and outcome correctness, not exact wording. Record retrieval latency, source coverage, model cost, spawned jobs and notification count. Continuous tests must assert zero project wakeups for read-only cases.

## 15. Implementation sequence for voskaai/default

Each phase is a separately reviewable change, not a request to implement this whole document in one context. Depend on accepted contracts from earlier phases. One implementation owner per seam; parallelize only independent work with fixed interfaces. Use independent Astra review for each phase and for the integrated journey.

Distinguish contract tests from integrated acceptance. Early fixtures can establish state/receipt interfaces but do not prove that an external worker was created or a deployment ran. Mark each acceptance ID `contract-only` or `integrated` in the phase report. Do not claim integrated success before its dependent production path exists. No partial phase may expose a mutation without its target, ownership and idempotency checks.

| Phase | Deliverable | Main seams | Acceptance gate |
| --- | --- | --- | --- |
| P0 | Baseline inventory, actual API/identity capability checks and failing fixture harness | existing services, test sandbox | verify source baseline; prove creation/delivery receipt semantics in isolated sessions; enumerate all consumers |
| P1 | Passive all-session context service and index | opencodeDb, messageSearch, facts/rollups | U03-U07, U27; measured query budget; no worker wakeups |
| P2 | Durable work envelope, operation receipts, shared delegate reservation contract and ownership | ctoStores, existing jobs/actions | U10/U13/U19 contract tests; atomic revisions and leases; U25 supported-tool input tests |
| P3a | Singleton binding and unified server admission/durable delivery | opencode, promptDelivery | U01/U11/U22/U28 server integration; U12 reply/revision contract only |
| P3b | Desktop CTO transcript/composer and work inspector | CtoPanel/ChatPanel, existing API | U01-U02 and U11 through UI; U12 stale reply display; no second window |
| P4 | Typed management tools, shared headless-parent delegate extension and scoped dispatch | rpc/tmux/delegate/ctoAct | U08-U10/U12-U13/U18 integrated against actual creation/control composition; not mocks standing in for dispatch |
| P5a | Independent review and SHA-bound forge integration | forge/work coordinator | U14-U15 integrated; required checks and review on exact candidate |
| P5b | Release invocation and target verification | existing release adapters/work coordinator | U16-U17 integrated for one disposable staging target; no claim of full portfolio journey yet |
| P6 | Priorities/dependencies, cache handoffs and safe lifecycle cleanup | budget/overnight/ownership/session APIs | U18-U21; no data loss or cache keepalives |
| P7 | Native parity, migration, integrated evals and staged rollout | native client, notification routing, release | U09, U23-U26 plus full end-to-end acceptance on disposable project |

P1 and P2 may proceed independently after P0. P6 closes integrated U19 priority/dependency acceptance; P7 closes the complete U09 portfolio journey. Other phases follow table order unless a reviewed interface permits a narrower parallel task. Do not expose partial management controls before their server operations work.

### 15.1 Required per-phase work order

```text
Goal: one observable outcome from phase Px.
Baseline: exact main SHA and already-accepted prerequisite commits.
Context: relevant spec sections, source files and evidence IDs only.
Scope: files/services likely to change; name all consumers of changed contracts.
Constraints: existing shared services; no new runtime/permission ladder; no live state.
Contracts: inputs/outputs, identity rules, revisions, errors and retry semantics.
Done when: named acceptance IDs pass at the phase's declared contract-only or integrated level; integrated gates exercise production composition.
Verification: exact commands and expected outcome; Mac checks where applicable.
Stop conditions: unsupported API behavior, conflicting ownership, failing invariant.
Delivery: draft PR / reviewed PR / merge / rollout, explicitly stated.
```

The implementer first verifies the map and proposes a short implementation approach. It then writes a failing regression/acceptance test, implements the smallest shared change, tests, inspects the complete diff, and submits for independent review. For a changed identity or access contract, the consumer sweep is part of completion, not a reviewer discovery task.

Do not "fix" a failing test by changing its expected output to match an unsafe behavior. In particular, wrong-project execution, cross-service credentials and duplicate dispatch tests must assert absence of the side effect, not simply a returned error after it occurred.

Required completion artifact, at most one page per phase: changed contracts, consumer sweep, actual test results, head SHA, unresolved risks and rollout status. Keep full command logs as artifacts instead of pasting them into the CTO conversation.

### 15.2 Verification commands

Use the current checkout's package scripts and sandbox configuration. Baseline commands:

```bash
npm run typecheck
npm test
bash scripts/check-duplication-gate.sh origin/main
git diff --check
git status --short
```

Run focused tests during development; run the full required gates before phase completion. Inspect generated/unrelated changes after tests, including website timestamps. Do not commit artifacts accidentally. Verify supported CI Node versions; SQLite tests must explicitly report unsupported runtime rather than crashing at import, while supported-runtime coverage remains mandatory.

No real service restart, secret-store mutation, live deployment or destructive filesystem test without a separately declared rollout/test target. The disposable staging environment is appropriate for end-to-end validation; the user's working box is not a test fixture.

## 16. Model research and execution guidance

### 16.1 What was actually verified

On 2026-09-15 the running opencode `/provider` metadata, filtered to non-secret fields, reports:

```json
{
  "provider": "voskaai",
  "model": "default",
  "displayName": "default",
  "limit": { "context": 0, "output": 0 },
  "capabilities": {
    "toolcall": true,
    "reasoning": false,
    "temperature": false,
    "attachment": false
  }
}
```

This is client/provider configuration metadata, not proof of the underlying checkpoint or actual capabilities. Zero limits mean unreported here, not unlimited. The endpoint does not identify GLM-5.2 versus GLM-5.3. No authoritative public mapping for `voskaai/default` was found. "Uncensored" is an unverified label, not an engineering capability or reason to relax tool validation.

Both GLM-5.2 and GLM-5.3 exist in official Z.ai documentation. Their advertised limits do not establish the limits of this alias. Asking a model to identify itself would not resolve that uncertainty, so no self-report is used as evidence. Proceed using the working opencode model binding and bounded tasks, not speculative provider changes.

### 16.2 Documented guidance and applicability

| Finding | Source | Application here |
| --- | --- | --- |
| Goal, Context, Constraints, Done when; plan complex changes; implement/test/check/review | Z.ai coding-agent best practices [R1] | Per-phase work orders and acceptance IDs in section 15 |
| Separate task contexts and preserve handoffs | [R1] | Small implementation phases; independent reviewer; durable brief before context replacement |
| GLM-5.3 requires thinking enabled and supports low/high/max; recommends max for complex coding | [R2] | Only configure if the actual provider/model supports this. Current alias metadata does not establish it |
| Preserved thinking requires intact ordered reasoning content/tool history | [R3] | Leave protocol history to opencode; do not hand-edit reasoning or inject GLM-specific fields into Manta |
| Tool arguments/results require correct IDs and streaming assembly | [R4] | Verify the installed model integration handles a two-step tool exchange; application tools retain typed validation |
| Official model cards advertise 1M context and 128K output | [R2], [R5] | Not used as alias capacity; bounded retrieval and short phases remain required |

Do not tune temperature or inject `reasoning_effort`, `thinking` or `clear_thinking` solely from these docs. A gateway can expose a different protocol. Provider integration changes, if required, are a separately scoped prerequisite and use opencode's supported configuration API, never a hand-edited live config file.

A minimal optional compatibility probe uses a fresh isolated CTO-owned test session: one harmless read tool, follow-up reasoning using its result, then a second harmless read with a known expected answer. Verify tool-call/result IDs, terminal completion and continuation; report alias and observed behavior only. No project sessions, secret values or prompt-based identity claims. Do not attempt to discover true context size by flooding the provider.

### 16.3 Guidance from this implementation history

The preceding access PR required repeated review because shared identity rules were implemented differently in list views, credential lookup, aliases and endpoint selection. This is observed project history, not evidence of a universal GLM weakness. The corrective workflow is explicit shared contracts plus a complete consumer sweep and real composition tests.

The spec therefore gives one invariant per shared boundary, concrete negative tests, defined failure outcomes and precise stopping points. Favor removing duplicate policies over adding more aliases, caches or compatibility branches. Do not assume a longer prompt or larger advertised context fixes missing integration tests.

## 17. Research references

Retrieved 2026-09-15. Vendor performance statements are not independent benchmark validation.

- [R1] Z.ai, Coding-agent best practices: https://docs.z.ai/devpack/resources/best-practice
- [R2] Z.ai, GLM-5.3 model documentation: https://docs.z.ai/guides/llm/glm-5.3
- [R3] Z.ai, Thinking mode/history preservation: https://docs.z.ai/guides/capabilities/thinking-mode
- [R4] Z.ai, Function calling: https://docs.z.ai/guides/capabilities/function-calling and streaming tools: https://docs.z.ai/guides/capabilities/stream-tool
- [R5] Z.ai, GLM-5.2 documentation: https://docs.z.ai/guides/llm/glm-5.2; official cards: https://huggingface.co/zai-org/GLM-5.2 and https://huggingface.co/zai-org/GLM-5.3
- [R6] Z.ai release notes (GLM-5.2: June 16, 2026; GLM-5.3: August 18, 2026): https://docs.z.ai/release-notes/new-released
- [R7] OpenAI, Agents API announcement, September 10, 2026: https://openai.com/index/introducing-the-agents-api/
- [R8] OpenAI, Internal data agent, January 29, 2026: https://openai.com/index/inside-our-in-house-data-agent/
- [R9] OpenAI, Codex agent loop, January 23, 2026: https://openai.com/index/unrolling-the-codex-agent-loop/

OpenAI inspiration: durable sessions, bounded independent contexts, selective tools, precomputed contextual navigation plus live evidence, and evaluations of actual answers. These do not require adopting its managed runtime. The Agents API uses an open-source Codex foundation; no claim is made that a wholly closed-source product named "OpenAI Agent Loop" was identified.

## 18. Definition of complete

The feature is complete only when a CEO can perform U09 from the CTO tab, continue discussing another project during execution, answer a work-linked question after reconnect, and receive a verified staging outcome without managing a worker window. The system must also pass the passive-read, restart, wrong-target, duplicate-action and safe-cleanup cases.

Shipping a composer, dispatching one successful job, passing unit tests, merging a PR, and publishing a release are each milestones. None alone satisfies this specification.
