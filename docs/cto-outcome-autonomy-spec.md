# CTO outcome ownership and autonomous recovery

**Status:** Initial bounded-autonomy implementation landed; target-specific execution and long-running continuation remain
**Date:** 2026-09-24
**Depends on:** `docs/unified-cto-spec.md` (authoritative work, authorization, evidence, and delivery contracts)

## 1. Summary

When the CEO asks the CTO to achieve an outcome, that accepted request grants the CTO authority to perform ordinary, bounded work needed to reach and verify that outcome. The CTO owns the outcome across attempts, worker failures, retries, review changes, and server restarts. It does not need a fresh confirmation for each mutation that remains inside the accepted scope.

The CTO stops and asks only when it reaches a material ambiguity, needs authority outside the accepted contract, cannot safely resolve an unknown external effect, or exhausts an existing bound. A response, worker completion, merge, or artifact publication is not itself proof that the requested outcome is complete.

This is an authorization and orchestration extension to the existing durable work system. It does not create a second goals database, bypass delivery evidence, or authorize arbitrary production changes.

## 1.1 Implementation status

The initial bounded-autonomy slice is implemented in the CTO work flow:

- Clear, currently admitted CEO execution requests create a server-derived charter tied to the actual accepted message. Plan-only/ambiguous requests do not silently mint execution authority.
- Charters bind the work to its workspace, repository identity, objective, pinned spec and delivery target. Duplicate source-goals are atomically collapsed; charters preserve the existing per-stage attempt bound.
- The work tools report `goal` mode to the CTO. The server checks the central role, charter, target, permission, current revision and limits before allowing an operation; goal-mode tools ignore global `trustedActions`. The executor rechecks the grant and revision before invoking the operation.
- Routine state/stage updates, dispatch, retry, replacement, review, verification and completion proceed without another confirmation when covered by the charter. Pause/cancel require a current explicit instruction; resume requires an explicit resume instruction.
- A confirmed scope edit writes a new charter revision with its server confirmation receipt. A scope change without that receipt fails closed.
- Terminal correlated work outcomes are reconciled at startup and by a bounded watchdog, using the existing idempotent outcome-adoption path.
- The CTO operating prompt and hands-on doctrine now instruct it to continue through bounded recovery and ask only at actual authority boundaries.

The following remain deferred because they need additional domain wiring beyond the existing work/forge contracts:

- A first-class `checks_green` delivery target with a PR and head SHA pinned when the charter is accepted, plus an authoritative required-checks source. The existing `pr` target still performs live gate verification on its supplied PR at completion, but it does not itself pin that PR number in the charter.
- A deterministic multi-stage orchestrator that advances an outcome without a CTO reasoning turn. Current continuation remains event-driven through existing delegate outcome delivery/admission; the new watchdog repairs outcome adoption but does not decide the next engineering action.
- Goal-scoped charters for accepted ambient plans. This slice grants authority from explicit CEO execution instructions only; ambient plans continue to use their existing policy path.
- New global spend/time defaults. Existing attempt, delegate-capacity and service bounds remain in force; no unmeasured limits were invented.

## 2. Problem

The current CTO prompt describes outcome ownership, but server-side work mutations are individually confirmation-gated. An accepted execution request does not reliably authorize the routine steps needed to fulfil it. Failed-attempt bookkeeping, retry, handoff, review, verification, and completion can each ask for another approval. This makes the user supervise mechanics rather than decisions.

There is a second gap after authorization: worker results and other events can be recorded without a guaranteed durable advancement of the same work item. The conversation may finish while the objective remains incomplete, or a lost wakeup may leave eligible work idle.

Changing prompt wording alone is insufficient. Authorization, recovery, and advancement must be enforced by the server and represented durably.

## 3. Goals and non-goals

### Goals

1. An explicit execution request is accepted once and yields a durable, scoped authorization for ordinary completion work.
2. Routine retries, worker replacement, state reconciliation, review repairs, verification, and attempt bookkeeping proceed without repeated confirmation.
3. Each nonterminal work item has either a concrete eligible next action or a named wait condition and wake source.
4. Missed events and restarts do not abandon work or create duplicate side effects.
5. Completion is based on the declared outcome and current evidence for the exact target/revision.
6. Genuine authority boundaries and unresolved decisions produce one precise, actionable escalation.
7. The central CTO remains the accountable manager; project work remains isolated in the existing work/worker flow.

### Non-goals

- Removing the existing adaptive confidence/calibration gate for unsolicited ambient initiatives.
- Globally trusting all CTO mutating operation names or changing ordinary project-chat permissions.
- Allowing project workers to grant themselves authority, change the CEO's intent, or extend budgets.
- Automatically deploying to production, publishing releases, merging, changing required checks, rotating credentials, disclosing data externally, or deleting user-owned resources absent applicable standing authority.
- Replacing existing work envelopes, conversation admission, operation receipts, delegate capacity controls, evidence predicates, or notification routing with parallel services.
- Guaranteeing exactly-once effects across external HTTP services.

## 4. Terminology

- **Goal/outcome:** The user-requested result with a specific target and verifiable acceptance criteria.
- **Execution charter:** Server-validated authority attached to the existing work record, derived from a trusted CEO instruction or an accepted autonomous-plan decision.
- **Attempt:** One bounded worker/stage execution. A failed attempt does not fail the goal.
- **Advancement event:** A durable, idempotent record that a work transition needs deterministic reconciliation or CTO reasoning.
- **Wait condition:** A named external condition (for example, CI completion or dependency release), with a deadline or recheck policy and a registered wake source.
- **Verified completion:** All target-specific acceptance criteria pass on the current target/revision, with durable evidence.

## 5. User-visible contract

For a clear request such as “get CI green on this pull request,” the CTO resolves the target from the conversation and available evidence, records the goal and its scope, and starts the ordinary work flow without asking for permission to begin implementation or perform routine recovery.

The CTO reports material progress when state changes. It may continue across multiple workers and conversations without requiring a “continue” response. If it cannot continue, it identifies the exact boundary, evidence, attempted recovery, recommended choice, and safe waiting state. The user is never told a goal is complete solely because an assistant turn or worker ended.

An explicit “plan only,” “do not execute,” or equivalent instruction creates no execution charter. A subsequent explicit execution request may create one. An explicit stop/cancel revokes further dispatch after reconciling in-flight effects; it cannot claim to undo an external effect already accepted by a service.

## 6. Execution charter

Extend the existing work envelope. Do not introduce a separate goal store.

Illustrative shape (field names are design-level; exact schema follows repository conventions):

```ts
type ExecutionCharter = {
  id: string;
  revision: number;
  source: {
    kind: "ceo_instruction" | "accepted_plan";
    sessionId: string;
    messageId?: string;
    planId?: string;
    decisionId?: string;
  };
  acceptedAt: number;
  expiresAt?: number;
  scope: {
    projectId: string;
    repository?: string;
    targetRef?: string;
    baseRevision?: string;
    deliveryTarget: string;
    specHash: string;
  };
  permissions: string[]; // semantic capabilities, not arbitrary tool names
  exclusions: string[];
  limits: {
    attempts: number; // cumulative across worker replacement and restart
    spend?: number;
    elapsedMs?: number;
  };
  status: "active" | "paused" | "needs_decision" | "exhausted" | "revoked" | "completed";
};
```

### 6.1 Source and creation

- For CEO-requested work, the trusted origin is derived from the server-bound conversation admission record and the actual CEO message. A model-supplied session ID, message ID, work ID, or string saying “authorized” is not proof.
- For ambient work, the grant references the existing plan/policy decision and inherits its limits. Ambient confidence does not become CEO authorization.
- A plan-only request never creates an execution charter.
- Charter creation and accepted work creation are one idempotent operation. The source instruction identity is the deduplication anchor; repeating delivery of the same message cannot create a second goal.
- If project/target/outcome is materially ambiguous, do not create an executable charter. Create one linked `needs_decision` item and ask one question. Routine details are resolved from standing instructions and established project conventions, with the assumptions recorded.
- The server—not the model—sets accepted time, scope references, ceiling, limits, and initial status. It rejects unknown fields and invalid/out-of-scope values.

### 6.2 Scope and limits

The charter binds to project, repository, target, pinned spec revision/hash, and maximum delivery target. It inherits existing system and project policy. It must not silently widen when a worker suggests a broader fix or the CTO changes its plan.

Reuse existing attempt and spend limits where present; budgets must be cumulative across retries, replacement workers, resume, and server restart. Do not choose arbitrary new numeric defaults in the implementation. Any new spend/elapsed limit or default requires a configuration decision backed by measured usage and surfaced in Settings. Until configured, existing hard caps remain authoritative.

`permissions` represent bounded semantic capabilities required for this outcome (for example, isolated implementation, run checks, retry failed attempt, update the linked pull request). They are not raw endpoint names and do not include general shell, arbitrary repository selection, credential access, or production deployment by implication.

### 6.3 Lifecycle and revocation

- `active`: ordinary permitted progress/recovery may proceed.
- `paused`: no new dispatch; reconcile current effects and checkpoint running work.
- `needs_decision`: wait for a named CEO answer or new authority. No repeated prompts for the same boundary.
- `exhausted`: an existing attempt/time/spend bound is reached; report verified progress and remaining choices. No automatic limit extension.
- `revoked`: no new side effects; reconcile started operations and report uncancellable external effects.
- `completed`: acceptance predicate passed against current evidence.

Scope/acceptance changes require a new charter revision before dispatch. Revoke or supersede older authority atomically with the new revision. A new instruction can resume an exhausted or revoked outcome only by creating an explicit new authorization revision; it must retain prior evidence and attempts.

## 7. Authorization and confirmation policy

Retain one server-side authorization path. For each work mutation, the server resolves authority from the authenticated central CTO role, the work record, current charter state/revision, exact target, current evidence/preconditions, and cumulative limits.

Proceed without a confirmation when all are true:

1. The caller is the registered central CTO execution role.
2. The operation is linked to an active charter derived from a trusted source.
3. It is a declared semantic capability for the same project, spec revision, and delivery ceiling.
4. It preserves acceptance criteria and current standing policy.
5. Its preconditions and required evidence pass, its idempotency key is valid, and its cumulative limits remain.
6. The external side effect can be safely reserved/reconciled by the existing operation receipt protocol.

The server refuses or escalates only for:

- material target or product ambiguity that cannot be resolved from instructions/evidence;
- a proposed change to scope, acceptance, project, target or delivery ceiling;
- an operation outside the charter or standing authority;
- unresolved uncertainty about whether an external side effect occurred;
- exhausted attempt, spend, elapsed-time, provider, or capacity limits when no safe permitted alternative remains;
- a security policy prohibition or an unsupported delivery integration;
- an explicit CEO hold, cancellation, or plan-only boundary.

Questions are linked to the work and charter revision, deduplicated by unresolved decision, and contain a recommended choice, reason, evidence, impact and safe wait state. A user response applies only to that decision/charter revision; it does not become global trust for the same operation.

Do not use the global `trustedActions` list as a substitute for a charter. Do not remove existing tool schemas, revision checks, capacity limits, isolated-worktree requirements, review independence, target identity checks, or delivery-specific verification.

## 8. Outcome-driven execution loop

The work coordinator owns this loop. Deterministic reconciliation runs without a model turn; reasoning work enters through existing serialized CTO conversation admission.

1. **Reconcile:** load current work, charter, attempts, worker state, operation receipts, dependencies, review/checks and target evidence. Adopt an existing live worker; inspect unknown effects before retrying.
2. **Select:** determine whether acceptance is proven, a condition is waiting, a bounded recovery is available, or a real decision is needed.
3. **Reserve:** write the advancement identity, expected revision, attempt budget reservation, and any exclusive lease before an external side effect.
4. **Act:** invoke existing work/delegate/forge/release services only through typed operations, carrying the charter revision and stable operation identity.
5. **Observe:** record actual result and provenance; never interpret HTTP acknowledgement alone as a completed effect.
6. **Verify:** re-evaluate target-specific acceptance against current evidence. Evidence is tied to target, revision/artifact, verifier, environment, time and result.
7. **Continue/recover:** enqueue the next advancement durably, or record a named wait with wakeup and watchdog deadline. Retry only the smallest failed unit and retain all earlier evidence.
8. **Close/report:** complete the same work only when its acceptance predicate passes. Otherwise keep it active, waiting, needs-decision, or exhausted and report truthfully.

At every transition, a nonterminal item must have either:

- an eligible next action and a durable advancement record; or
- a concrete wait condition, wake source, next reconciliation time, and escalation deadline.

No “working” item may be left with neither. A final assistant response does not change work state.

### 8.1 Wakeups and watchdog

- Worker terminal results, check completion, review changes, dependency satisfaction, provider/capacity recovery, target probe changes, charter changes, and startup/restart enqueue advancement events.
- Event IDs derive from stable work/attempt/source-event identity. Duplicate delivery updates/reconciles the same event and cannot create duplicate work.
- Persist the advancement event atomically with the work transition that requires it, or use a transactional outbox in the existing envelope/write boundary.
- The existing runtime gets a bounded periodic reconciliation pass for nonterminal work. It identifies missed wakeups/stale states and enqueues the same stable event; it does not repeatedly prompt the model on a fixed timer.
- Coalesce nonmaterial events. One material unresolved decision produces at most one active escalation per charter revision.
- If the central CTO role/provider is unavailable, retain the event and surface manager-unavailable state; do not report the objective as blocked on CEO authority when the actual problem is service availability.

### 8.2 Progress and stall detection

Distinguish worker liveness from goal progress. Heartbeats prove a process exists, not that acceptance is nearer. Meaningful progress includes a new artifact/revision, a newly passing acceptance check, a resolved dependency, a validated diagnosis that narrows the failure, or a completed target verification.

After repeated attempts with no meaningful progress, the CTO changes the hypothesis/approach/worker within the charter and existing attempt limit. It must not repeatedly run the same failing operation and charge it as progress. A deterministic circuit breaker stops new attempts on provider-wide outage, unsafe uncertainty, exhausted budget, or repeated no-progress and produces one reasoned escalation. Thresholds reuse existing policy or are configurable; do not hardcode unmeasured values.

## 9. Outcome and delivery model

The goal is a durable work item, not a second “goal” service. Add a typed operational delivery target only where current delivery kinds cannot express the user’s actual requested outcome. Initial supported target: `checks_green` for a named repository/PR or branch at an exact revision with a forge-sourced required-check set.

For `checks_green`:

- Pin repository, pull request or branch, expected base, target head SHA, and authoritative required-check source.
- Reconcile against forge checks for that SHA; require every required check to be freshly successful. Pending, skipped-required, stale, missing, or checks for another SHA do not pass.
- Repairs may update an isolated repair branch or linked PR only within charter permissions. If target head changes, invalidate affected review and check evidence and re-evaluate.
- Completion does not imply merge, release, or deployment. Those require their own declared target and corresponding standing/charter authority.
- If CI recovery needs merge or production deployment to achieve the requested outcome, stop before that higher boundary unless the charter explicitly includes it.

Keep existing delivery targets (`spec`, `pr`, `merged`, `published`, `deployed`) distinct. `implementation_reported`, “assistant replied,” and “worker completed” remain intermediate facts, not terminal success.

Continuing goals such as “keep this branch healthy” are out of initial scope. A later design may use existing watch/event mechanisms to create linked, individually bounded recovery work; it must include expiry, aggregate budget, cancellation and deduplication semantics.

If production composition lacks forge/release/probe adapters for a requested target, reject or mark the target unsupported before dispatch. Do not simulate verification or fall back to broad shell access.

## 10. Data compatibility and migration

- Add charter and advancement fields optionally to current work envelopes; legacy work remains readable.
- Legacy records without a trusted origin cannot receive retroactive execution authority. They retain current policy until explicitly adopted by a CEO instruction or existing autonomous plan policy.
- Missing/malformed charter, missing referenced source, expired/revoked authority, or mismatched spec/target fails closed for new side effects; reads, reconciliation and safe checkpointing remain available.
- Migration is additive, atomic, and retains backup/recovery behavior. Never reset a corrupt work or receipt store to an empty healthy portfolio.
- Existing `trustedActions` remains a compatibility/admin policy but does not manufacture goal-scoped grants. Its meaning and precedence are documented before any deprecation.
- Ambient plans continue through the existing adaptive gate and executor. Their accepted decision becomes the charter source; retries do not rerun confidence classification or learn a new “acceptance” verdict for the same attempt.

## 11. Roles and responsibility

- **CEO:** defines outcome and boundaries; answers only genuine material decisions or grants extended authority.
- **Central CTO:** accountable for contract interpretation, orchestration, recovery, evidence review, escalation, and honest completion reporting.
- **Project worker:** performs scoped implementation and returns attributable artifacts/evidence; cannot alter charter or self-certify final outcome.
- **Deterministic server services:** reserve operations, enforce charter/limits, reconcile receipts, persist events, verify machine-checkable facts, and enforce idempotency.
- **Independent reviewer/target verifier:** provides evidence appropriate to the declared delivery target; never inherits implementation context as proof.

## 12. Failure behavior

| Condition | Required behavior |
|---|---|
| Worker reports failure | Record attempt failure; keep goal active; reconcile and retry/reassign within limits. |
| Worker appears missing | Search/adopt by operation identity; if conclusively absent, record missing attempt and continue within limits. |
| External operation outcome unknown | Inspect authoritative system using operation identity; do not blindly repeat or relabel failed. Ask only if reconciliation cannot resolve material risk. |
| Duplicate event/request | Return/reconcile original operation; no duplicate dispatch or notification. |
| Server restarts between result and wakeup | Startup watchdog finds durable pending advancement and resumes same work. |
| Provider unavailable | Record manager/worker service outage and wait/backoff; use only charter-permitted fallback; do not change a user-pinned model. |
| Review rejects current revision | Link findings and dispatch bounded repair; invalidate approval and affected evidence. |
| New work spec/target revision | Pause affected attempts, retain their results as superseded evidence, require new charter revision before further side effects. |
| Budget/attempt exhausted | Keep outcome incomplete/exhausted; summarize progress and propose a precise extension. |
| User pauses/cancels | Stop new work, reconcile started external effects, checkpoint and report what could not be cancelled. |
| Missing target adapter or acceptance data | Fail before promising dispatch, name the unsupported integration/data, and do not claim completion. |
| Goal is already satisfied | Verify authoritative evidence, record completion idempotently, do not create a worker. |

## 13. Acceptance criteria

### Authorization

1. A direct CEO execution request creates one durable charter tied to the trusted source message and one work item, without per-stage confirmations.
2. Replaying the accepted source message does not create a second charter or worker.
3. Plan-only creates no execution authority.
4. A worker/model-supplied origin ID, charter ID, project, or permission string cannot authorize a mutation.
5. An active charter permits retry, attempt failure recording, handoff, review repair, target checks and completion only inside its project/spec/delivery ceiling and limits.
6. A changed target, excluded operation, exhausted bound, expired/revoked charter, or plan-mode turn cannot initiate a side effect.
7. Genuine decision escalation is linked/deduplicated; repeated polling or worker events do not repeat the same question.
8. Existing safety gates—isolated worktree, receipt reconciliation, capacity, independent review, current-head checks, merge conditions, delivery-specific evidence—remain enforced.

### Durable continuation and recovery

9. Every transition to nonterminal work leaves an eligible action or durable wait condition with wake/deadline.
10. Worker completion immediately before server restart still advances once after restart.
11. Duplicate terminal events and repeated watchdog scans do not create duplicate attempts, operations, notifications, or spend reservations.
12. The watchdog distinguishes process liveness from meaningful acceptance progress and stops repeated no-progress attempts at an existing/configured bound.
13. Unknown HTTP/external outcomes are reconciled before retry; a late result from an old attempt cannot advance a newer spec revision.
14. Attempt/spend bounds are cumulative across replaced workers, server restart, and resume.

### Verified completion

15. For a `checks_green` work item, completion requires fresh authoritative success for every required check on the pinned current revision.
16. A passing PR check cannot imply merge/deploy; absent delivery adapters prevent claiming unsupported targets.
17. A completed conversational turn or implementation worker with failing/unavailable target evidence leaves the work nonterminal.
18. A newer target revision invalidates evidence that no longer matches.
19. User-visible status distinguishes active execution, named external wait, needs-decision, exhausted, verified complete, and manager/provider unavailable.

### Recovery evaluation

20. End-to-end tests inject worker crash, check failure, review rejection, duplicate event, lost wakeup, restart during wait, unknown external response, stale result, provider outage, revocation, and budget exhaustion.
21. A representative CI-repair scenario reaches the declared verified target across a routine failure without a confirmation request, while a merge/deploy attempt outside the charter is denied.
22. Reports count human interventions and verified outcomes separately; fewer questions with lower completion or more false-success claims is a regression.

## 14. Rollout and measurement

### Phase A — policy and schema

Define trusted-source binding, charter capabilities, fields, legacy behavior, and confirmation compatibility. Add pure policy tests and migration tests. Make no runtime autonomy default change until server enforcement can validate charter source and scope.

### Phase B — bounded work authorization

Enable charters for explicit CEO-requested work at the currently supported PR/verification ceiling. Automatically permit routine internal work mutations/retries under those charters. Keep ambient work on the existing adaptive gate. Log each allow/deny and the source/limit that decided it without logging secrets or unnecessary transcript content.

### Phase C — durable advancement

Add stable advancement records/outbox, event-triggered work reconciliation, startup recovery, and a bounded watchdog. Test crash windows, duplicate events, unknown outcomes, stale worker results and starvation with human submissions taking priority over background synthesis.

### Phase D — operational outcomes

Wire the required forge data into `checks_green`, then enable CI-repair completion only after actual target-SHA verification passes end-to-end. Add later delivery adapters only with target-specific contracts, standing authority, and recovery tests. Production deployment remains excluded by default.

### Metrics

Report by delivery target and difficulty:

- verified completion per accepted goal;
- human interventions and attention minutes per accepted/verified goal;
- unnecessary/duplicate escalations and missed required escalations;
- goal abandonment, false completion and reopening;
- routine-recovery success within limits;
- duration without an eligible action and external-wait age;
- duplicate effects/dispatch, authority violations, stale evidence accepted;
- model/tool spend and elapsed time including failed attempts.

The primary improvement criterion is fewer human interventions **without reducing verified completion or increasing authority violations/false completion**. Model confidence, tool-call count, and a successful final reply are not proxy success metrics.

## 15. Open decisions before implementation

1. Which existing configuration owns default per-goal active-time/spend limits, if any; do not invent defaults without measured data.
2. What exact CEO submission/admission record is the authoritative, non-forgeable charter source at the production RPC boundary.
3. What event/outbox mechanism can atomically share the existing work-envelope persistence boundary.
4. Which `checks_green` forge adapter and required-check source are available in production composition.
5. How a user-visible charter preview/status is exposed without adding an approval click to routine execution.
6. Whether autonomous merge is available under a separately persisted standing instruction; this spec's initial CI-repair ceiling excludes merge and deployment.
7. How explicit user stop interacts with accepted in-flight operations and workers that cannot be interrupted.
