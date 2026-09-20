# Endpoint health — spec

**Status:** proposed (v3, after two adversarial review rounds) · **Written:**
2026-09-20 · **Extends:** Automatic Manta Routing (BET-1219 / 1236 / 1240 /
1241 / 1252)

An endpoint that has **never once worked** is indistinguishable, to every
routing decision on this box, from a healthy one. Marking it unusable would not
stop traffic reaching it. And on the path where this actually happened, health
is not consulted at all.

This spec fixes all three. It adds no new model calls on any hot path, no
background polling, and no network service.

---

## 1. The outage

The CTO's session-summary layer — its cross-session memory — has run **363 times
since 2026-09-14 and succeeded zero times.** 23,387 digested-session records
exist on disk and every one is an empty shell. The CTO answers from the
filesystem because its memory is an index of blank pages.

Cause: the fast tier routes `ambient-summarize` to a Chutes-hosted endpoint whose
account is overdrawn. The surviving evidence is explicit —

```
APIError · statusCode 402 · "Payment Required: Quota exceeded and account
balance is $-0.5721427999999972"
```

A provider-health tracker exists whose entire purpose is to exclude a 402
provider. It never fired, across ~650 consecutive failures, for six weeks, with
no alarm.

---

## 2. What is actually wrong

Nine defects. **D0 alone would have caused this outage even if the other eight
did not exist**, which is why it leads.

### D0 — The CTO's routing consumes no health

`defaultResolveModel` — the resolver that chose the dead endpoint 363 times —
builds its routing services with `providerHealthState: null`, `snapshots: []`
and `endpointSummary: null`. Health, account state and reliability telemetry are
all explicitly absent. The router then routes on "no context", which is
permissive by design.

So the tracker being broken was never the whole story: **on this path nothing
would have read it anyway.** Fixing the producer without fixing the consumer
fixes nothing.

*`ctoSessions.mjs:343-352`*

### D1 — Fail-open routing nullifies every exclusion

When no candidate survives, `chooseModel` returns the **incumbent**
(`changed:false`); for the CTO path the incumbent is `null`, which callers
translate to "let opencode pick its default". Both wrappers also restore the
incumbent when routing throws, and `routing:choose` promises never to throw.

So excluding a dead endpoint routes straight back into it, or into an unrouted
default. Until this is fixed, nothing else in this spec has any effect.

*`modelRouter.mjs:478-486` · `delegate.mjs:711-725` · `rpc.mjs:1303-1354` ·
`ctoSessions.mjs:377-379`*

### D2 — Attribution requires a prior success

`providerHealth.observeEvent` resolves the failing provider from a cache fed
**only by `session.next.step.ended`**. A turn failing on its first request never
produces a step, so attribution returns `null` and the failure is dropped.

> The tracker sees a provider that worked and then broke. It is blind to one that
> never worked — the more serious condition, and the only one it cannot detect.

*`providerHealth.mjs:169,226` · `usageStopEnroll.mjs:150`*

### D3 — Health is provider-keyed; everything else is endpoint-keyed

`endpointKey(m) → "providerID/modelID"` is the established identity and already
keys the endpoint ledger's reliability and telemetry. Provider health is the sole
outlier: one state per provider, shared by every model it serves.

*`shared/endpointKey.mjs` · `providerHealth.mjs:117-127` · `routingServices.mjs:143-150`*

### D4 — Absent evidence reads as healthy

`state()` defaults to `ok`. Zero attempts and forty-attempts-zero-successes both
report `ok`.

### D5 — A hard endpoint failure does not fail over

`runEphemeral` escalates a tier only on a **quality** failure — `empty-output`,
`model-output-cap`, `schema-invalid`. `model-error` is not among them.

*`ctoSessions.mjs:230-243` · `ctoRunOutcome.mjs:26-28`*

> Re-confirmed twice. A first-round review claimed the opposite, citing the
> closed code *taxonomy* at `ctoRunOutcome.mjs:3-8` and mistaking it for the
> quality set at `:26`.

### D6 — The cause is discarded where it is in hand

`runSynchronousSession` detects failure by finding an assistant message with
`info.error` — carrying `name`, `data.statusCode`, `data.isRetryable`,
`responseHeaders` — and returns bare `model-error`, keeping none of it.

*`opencode.mjs:1144-1145`*

### D7 — The evidence is then deleted

The session is deleted in `finally`. The failing message goes with it. Of ~650
failures **51 survive**, and only because cleanup leaked.

*`opencode.mjs:1158-1169`*

### D8 — Nobody was told

~650 failures, 16 days, zero notifications. Nothing watches for "an operation
class is at a 0% success rate" — which needs no attribution at all.

**Silence is what made the other eight expensive.**

---

## 3. Principles

1. **Liveness is observed, never inferred.** No model judges another model.
2. **A local failure is not a provider failure.** The box talking to its own
   opencode is a different fact from opencode talking to a provider. Conflating
   them lets a local outage exclude every healthy model.
3. **Attribution is a stated confidence, not an assumption.** An attempt whose
   endpoint is unknown says so and is excluded from health.
4. **Narrow scope by default.** A failure is endpoint-scoped unless there is
   positive evidence it is account-wide.
5. **Authoritative failures are declarations, not samples** — but only when
   their scope is certain.
6. **Fail closed per operation; never brick the box.** No healthy endpoint is an
   explicit, surfaced outcome. There is always a deterministic one-action
   recovery.
7. **Never mutate a written terminal record.** Later facts are new records.
8. **Routing never throws.**

---

## 4. The attempt lifecycle contract

This is the blocking primitive; everything else is a projection of it. Two record
kinds, deliberately separate.

### 4.1 Operation record — the local lifecycle

Written for every dispatched operation, whether or not a provider was ever
reached.

```
{ attemptId, operation, startedAt, deadlineAt,
  intendedEndpointKey | null,      // null when no model was pinned
  attribution: "not-dispatched" | "intended" | "dispatched-unattributed" | "observed",
  terminal: { at, code, stage } }  // stage: create | prompt | poll | model | cleanup
```

| Attribution | Meaning | Health |
|---|---|---|
| `not-dispatched` | no request left for a provider — `create-http`, `create-invalid`, `provenance-error` | never |
| `intended` | dispatched with a pinned model; no assistant message confirms what ran | only via §4.1a |
| `dispatched-unattributed` | dispatched **unpinned**, opencode chose the model, and no assistant message exists — `timeout` or `read-http` on an unpinned run. The endpoint is genuinely unknown | never |
| `observed` | an assistant message exists; the concrete endpoint is known | yes |

**Operation records never affect endpoint health**, with the single explicit
exception below. They otherwise feed operational telemetry and the
infrastructure watcher (W7.3).

### 4.1a — The prompt boundary IS provider evidence

A non-2xx on the `prompt_async` POST is **not** purely local. The codebase
already treats it as a provider refusal: `sendPrompt` preserves `err.status` and
the parsed `Retry-After`, and a dedicated bridge
(`_transportRefusalBySession`) carries that status to provider health precisely
because it "surfaces to the box as a THROWN error rather than a `session.error`
SSE event — so the Retry-After never reaches providerHealth".

`runSynchronousSession` is the outlier: it calls `discardBody(promptRes)` and
returns a bare `prompt-http`, throwing the status away.

*`opencode.mjs:651-659,737-751` vs `opencode.mjs:1127-1129`*

Therefore:

- `runSynchronousSession` must preserve the prompt response's status and
  `Retry-After`, mirroring `sendPrompt`.
- A prompt-boundary refusal produces a provider attempt (`attribution:
  "intended"`) **only** for **402 and 429**, and **only** on a **pinned** model.
  Those two statuses have no local meaning at this boundary: the box's own
  opencode neither bills nor rate-limits it, so the status can only have come
  from upstream. The pinned model supplies the endpoint identity.
- **401, 403 and 404 at this boundary are ambiguous and are NOT provider
  evidence.** A 404 in particular is at least as likely to be a missing session
  or a route mismatch in the local API as a provider's "no such model". They
  produce an operation record and may only affect health if corroborated by an
  `observed` attempt (§4.2) or a matching `session.error`.
- Everything else (connection failure, opencode's own 5xx, any status on an
  **unpinned** run) stays a local operation record and never touches endpoint
  health.

This deliberately mirrors the existing bridge's caution: it stashes the status
and waits for a matching `session.error` to enrich rather than acting on the POST
failure alone. Where `runSynchronousSession` has no SSE stream to correlate
against, only the two unambiguous statuses are trusted standalone.

### 4.2 Provider attempt — the observed model response

Derived **from the persisted assistant message**, which is the only artefact that
states what actually ran:

```
{ attemptId, endpointKey, accountKey, at,
  outcome: "success" | "failure",
  errorName | null,        // APIError, ContentFilterError, UnknownError, …
  httpStatus | null,       // error.data.statusCode
  retryable  | null }      // error.data.isRetryable
```

Measured against the live store: of **778** assistant error rows, **0** lack
`providerID`/`modelID` — identity is always present — and **410** lack
`statusCode`. Those 410 are almost entirely errors that have no HTTP status by
nature: 373 `MessageAbortedError`, 24 `ContentFilterError`, 12 `UnknownError` —
plus exactly **1** status-less `APIError`, which is why §4.4 carries a row for
that shape rather than assuming every `APIError` is classifiable.

**The causative message, not the latest.** The runner today fails the whole run
when *any* assistant message carries an error, while separately reading the
*last* assistant message for text. The provider attempt must be built from the
causative row — and that is defined per failure kind: for an error-object
failure it is the message carrying `info.error`; for a finish-derived failure
(content filter, refusal, a cap) it is the terminal row `assistantCompletion`
classified. Those can differ, and attributing a failure to the wrong message
attributes it to the wrong endpoint.

*`opencode.mjs:1143-1147`*

**Only provider attempts feed endpoint health**, plus the §4.1a prompt-boundary
case.

### 4.3 Finalization — two writes, never a mutation

`runSynchronousSession` today calls `finish()` and then lets its `finally` block
mutate an already-returned success into `cleanup-error`. A record written in
`finish()` would therefore contradict what the caller saw.

The contract:

1. Capture the provider attempt (§4.2) from the causative assistant message
   **before** deletion — this is the evidence D7 currently destroys.
2. Run cleanup.
3. Append the operation record (§4.1) **after** cleanup, so it can state the
   cleanup outcome truthfully.

Two records, each written once, neither contradicting the other. Cleanup failure
never rewrites a model result.

Each of the three steps is **independently guarded**, and the returned result is
constructed once at the end from values already in hand — never from a store
read:

```
let attempt = captureAttempt(causativeMessage)   // pure, no I/O
try { await appendAttempt(attempt) }   catch { markPersistFailure() }  // never skips cleanup
try { await cleanup() }                catch { cleanupCode = "cleanup-error" }
try { await appendOperation({…, cleanupCode}) } catch { markPersistFailure() }
return result   // built from locals, unaffected by any of the above
```

A failed persistence write must never skip cleanup, never change what the caller
sees, and never be silent — it sets the flag the infrastructure watcher (W7.3)
reads.

**Also fix the pre-`try` throw.** `trackCreation()` is invoked on the line
*before* the enclosing `try` (`opencode.mjs:1084-1085`), so a synchronous throw
there escapes with no `finish()`, no record and no cleanup. Move it inside.

**Idempotency.** Terminal writes are first-writer-wins on `attemptId`; a
duplicate delivery (events arrive on both the global and per-directory streams)
is dropped, not merged.

**Self-terminalizing.** A record past `deadlineAt + 60s` with no terminal is
closed as `abandoned` by the existing CTO sweep. Expiry derives from the
request's own deadline, never a fixed wall clock. `abandoned` is an outcome, not
a deletion, and — being unattributed — excludes nothing.

### 4.4 Classification — every error name, explicitly

| Error | Health effect | Why |
|---|---|---|
| `MessageAbortedError` | **ignored entirely** | a user abort or queued-message drain is not a failure. The push router already carries this exact exception |
| `APIError` + `statusCode` | classify by status (§4.5) | a real provider HTTP outcome |
| `APIError`, no `statusCode` | transient, one sample | shape unknown; never authoritative |
| `ContentFilterError` | **not a health signal** | the endpoint worked and answered; the content was refused |
| `UnknownError` | transient, one sample | |
| success | clears streaks, sets `lastSuccessAt` | |

An unrecognised error name is transient. Health never treats an unknown as
authoritative.

**Finish-derived outcomes carry no error object and must be classified
separately.** `assistantCompletion` returns `model-error` for a finish reason of
`content_filter`, `error` or `refusal` even when `info.error` is absent — so
without an explicit rule those fall through to "transient", and a heavily
content-filtered but perfectly healthy endpoint would eventually be marked dead.
The `finish` reason is therefore persisted on the provider attempt and
classified:

| Finish / code | Health effect |
|---|---|
| `content_filter`, `refusal` | **not a health signal** — the endpoint answered |
| `error` (no error object) | transient, one sample |
| `model-output-cap`, `model-context-cap` | **not a health signal** — our request's size, not the endpoint's state |
| `empty-output` | **not a health signal** — a quality outcome, already handled by the tier cascade |
| `stop`, `end_turn`, `stop_sequence` | success |

*`ctoRunOutcome.mjs:14-23` · `opencode.mjs:1147-1153`*

### 4.5 Status → scope, narrow by default

| Status | Scope | Rule |
|---|---|---|
| 402 | **account** | the observed body states an account balance; billing is account-wide by construction |
| 401 | account, **on the second consecutive 401** (§4.5a) | the box auto-recovers expired credentials; excluding on the first would fight its own refresh |
| 403 | **endpoint** | entitlement, region and policy are usually model-specific; promote to account only on corroborating account evidence |
| 404 | **endpoint** | a missing model or deployment |
| 429 | **endpoint** | rate limits are commonly per-model/deployment; existing deadline path, promote to account only from response metadata |
| 5xx / timeout / transport | **endpoint**, transient | |

Promotion to account scope requires positive evidence — account-meter data or
response metadata — never a guess. Account precedence (§5) means a
misclassification here takes out every sibling, so the default must be narrow.

### 4.5a — The 401 rule, made implementable

"Defer one refresh cycle" is not implementable as stated: there is no
provider-agnostic refresh marker. Credential recovery exists for **Claude only**
(`doRefresh` / `maybeRecoverCredentials` / `startCredentialRefreshPoller`, kept
Claude-specific on purpose), and every other provider has no refresh at all — so
a rule phrased in refresh cycles is undefined for most of the box.

The rule is therefore counted, not scheduled:

- **Exclude on the second consecutive `observed` 401 on the same account with no
  intervening success.** One 401 arms; two confirm. Only `observed` attempts
  count — a prompt-boundary 401 is ambiguous (§4.1a) and does not arm the
  counter.
- **Additionally, for a provider with credential recovery:** if a recovery
  *succeeded* between the two 401s, the counter resets — the second 401 is then a
  first.

**This needs a new timestamp; the existing one cannot serve.** `_lastRecoveryAt`
is an **attempt** marker: it is assigned immediately *before* an un-awaited
`refreshClaudeCredentials()` and exists purely as a cooldown gate, so it advances
even when the refresh fails, and a successful *proactive* refresh never touches
it at all. Gating on it would reset the 401 counter on failed refreshes and miss
successful ones — precisely backwards.

Add `_lastRecoverySuccessAt`, set inside `refreshClaudeCredentials` on its
`outcome === "ok"` branch. That function is the single entry point for **both**
the reactive path (`maybeRecoverCredentials`) and the proactive poller
(`createCredentialRefreshSweep` injects it as `refresh`), so one assignment
covers both, and it already classifies its own success.

*`opencode.mjs:2106-2115` (attempt marker) · `:2165-2176` (outcome classified) ·
`:2212-2231` (proactive path shares the same function)*

---

## 5. Work items

### W0 — Make the CTO consume health (fixes D0)

`defaultResolveModel` must pass real `providerHealthState`, `endpointHealthState`
and `endpointSummary` into `buildRoutingServices` instead of `null`. Without
this, every other item is invisible on the path that broke.

Keep the existing degradation contract: a failing reader degrades to absent
(permissive), never to an exception.

**Acceptance:** with an endpoint excluded, a CTO ephemeral run does not select
it. This test fails today for reasons unrelated to the tracker.

### W1 — Fail closed, end to end (fixes D1)

A discriminated result, not a nullable model:

```
{ kind: "selected", model }
{ kind: "no-healthy-endpoint", reason, excluded: [...] }
{ kind: "unrouted", model }        // off-path / routing inactive — today's behaviour
```

**`no-healthy-endpoint` is defined causally, not by an empty survivor set.** A
survivor set empties for many reasons — price ceiling, context headroom,
modality, quality floor, identity resolution — and only some are health.

Two invariants, and **one is strictly prior to the other**:

> **I1 — never hand back an excluded endpoint.** Whatever the verdict, the
> returned model is never one that health has excluded. This includes the
> fallback paths: an excluded incumbent is not returned.
>
> **I2 — the verdict names the true cause.** Alongside the eligible set, track
> the **health-neutral** survivors in the same assessment pass (the set that
> would have survived had health exclusions not applied — no second filter run,
> no duplicated work). If it is non-empty, health is the binding constraint.

Resolved into one ordered rule, which removes the ambiguity two separate rules
created:

1. A healthy model qualifies → `selected`.
2. Otherwise, if the value today's code would return is health-excluded →
   `no-healthy-endpoint` (forced by I1 — we may not return it).
3. Otherwise, if the health-neutral survivor set is non-empty →
   `no-healthy-endpoint` (I2 — health is why there is nothing).
4. Otherwise → today's behaviour (`unrouted` / the incumbent). An ordinary
   constraint miss, unchanged.

So an incumbent that is merely unqualified — context too small, wrong modality —
but healthy still takes path 4 exactly as now. Only health can produce the new
verdict.

**Widen constraints; never widen health.** When a tier comes up empty the router
already widens to a neighbouring band (`modelRouter.mjs:341,524`), and that
behaviour is deliberately untouched: a price ceiling, a quality floor or a tier
boundary is a *preference*, and relaxing a preference to get work done is
correct. A health exclusion is a *fact about what will fail*, and relaxing it is
the precise bug this spec exists to remove — a forced fallback onto an excluded
endpoint is fail-open with extra steps. So the escalation ladder is: narrow tier
→ widen the band → widen price/quality → **stop**. Health is never a rung on
that ladder.

The CTO path passes `incumbent: null`, so "return the incumbent" there means
returning `null`, which callers read as "let opencode choose its default". That
is the fail-open in D1, and it is why the distinction must be carried in the
result *kind* and never inferred from a null model.
- **Every caller is updated in the same change**: `delegate`'s spawn path,
  `rpc routing:choose`, and `defaultResolveModel`. `no-healthy-endpoint` must not
  collapse into the same `null` that means "let opencode choose". Their
  never-throw contracts are preserved: a routing *exception* still falls back to
  the incumbent; a routing *verdict* of no-healthy-endpoint does not.
- A caller receiving it fails the operation with that typed reason and raises the
  W7 alarm — it does not fall through to the provider default.

**This is the single most important item.** Without it every exclusion is
decorative. It ships before exclusions are enabled (§8).

### W2 — Attempt lifecycle

Implement §4. Persist to `statePath("endpoint-attempts.json")`: per endpoint, a
`lastSuccessAt` timestamp, a consecutive-failure streak, and a bounded ring
(200 entries **or** 30 days, whichever binds first).

**Read-modify-write must be serialized.** `writeJsonAtomic` makes the *write*
atomic, not the load-append-save sequence; two concurrent completions can
otherwise both read the same ring and one overwrites the other. Use the existing
per-store patch/mutex pattern (`ctoStores` `patchStore`), not a bare atomic
write.

Versioned schema. A corrupt or unreadable file is quarantined aside, rebuilt
empty, and **alarmed** (W7.3) — never silently swallowed, never kept as live
state.

**Acceptance:** every taxonomy code produces exactly one operation record;
observed model failures additionally produce one provider attempt; duplicate
delivery produces one, not two; a killed server leaves a record the next sweep
terminalizes as `abandoned`; concurrent completions both survive.

### W3 — Preserve the cause (fixes D6)

At `opencode.mjs:1144`, carry `error.name`, `error.data.statusCode` and
`error.data.isRetryable` into the outcome. Extend the closed code set —
`model-error-402/401/403/404/429/5xx` — keeping bare `model-error` for the
unclassifiable. The taxonomy stays closed; no exception text crosses the
persistence boundary.

### W4 — Two health registers (fixes D3)

| Register | Key | Holds |
|---|---|---|
| **Account** | `accountKey` (providerID) | `out-of-credit`, `unauthorized` |
| **Endpoint** | `endpointKey` | `unproven`, `dead`, `degraded`, `not-found`, `forbidden`, rate-limit deadline |

Account state takes precedence when present — but §4.5 keeps almost everything
out of it, so precedence is safe rather than amplifying.

Routing consumes both: `services.health` (provider-keyed) stays for
compatibility; `services.endpointHealth` is added. An absent entry is permissive.

**Known bound, accepted:** `endpointKey` does not encode base URL, credential or
region. On a single-user box with one credential per provider that is
sufficient. A configuration change clears the affected keys (W8).

### W5 — Statistics that survive eviction

Three separate measures, because one window cannot answer all three questions:

- **`unproven`** — derived from a durable `lastSuccessAt` **timestamp**, not from
  the ring. A ring-derived "never" is a lie the moment an old success is evicted.
- **`dead`** — a **consecutive-failure streak** of ≥5 health-eligible failures,
  reset to zero by any success. Not a rate: a single old success must not keep an
  endpoint alive through 199 consecutive failures.
- **`degraded`** — success rate <50% over the bounded window (≥10 attempts), with
  both a count and an age bound so a quiet endpoint is not judged on stale data.

Authoritative failures (§4.5) exclude on their first occurrence regardless of
counts, subject to the 401 deferral.

**Clearing:** any health-eligible success clears the streak and the derived
state immediately. Nothing clears on a timer. A process restart is not evidence.

**Everything here persists.** `lastSuccessAt`, the consecutive-failure streak,
the bounded window and the authoritative states all live in the one durable
store; health is a projection of it and there is no process-local state to lose.
(v2 kept a "soft streak" that died on restart, inherited from the current
provider-health module. On a box that restarted 13 times in a day that is not a
meaningful distinction, and having two durability classes was the source of a
contradiction between two sections of this spec.)

### W6 — Failover to a *different* endpoint (fixes D5)

Split the retry decision in `runEphemeral`:

- **quality failure** → escalate tier, as today.
- **provider failure** → re-resolve with an exclusion set built from this
  operation's prior attempts, and retry **only if the resolution yields a
  different `endpointKey`**. Identical → stop with `no-alternate-endpoint`.
- **local lifecycle failure** (`create-http`, `provenance-error`, and a
  `prompt-http` that is *not* a §4.1a provider refusal) → retry the *same*
  endpoint if at all; it is not evidence against the provider.
- **a §4.1a prompt-boundary refusal** → treated as a provider failure, exactly
  like an observed one.
- Never retry a non-retryable failure (`retryable === false`, or an authoritative
  status). Retrying a 402 is guaranteed waste.

**Two model calls per operation, total.** The endpoint failover and the existing
nano→mid quality cascade share one budget; they must not compose into four.

### W7 — Say something (fixes D8)

1. **Operation-class watcher.** Any CTO task class with 0 successes in its last
   10 attempts and ≥1h elapsed raises a blocker naming the class, dominant code
   and endpoint. Degraded variant: <50% over 20. *Reads only `operation` and
   `code`, which the ledger already records — implementable today, depends on
   nothing else here.*
2. **Endpoint watcher.** An endpoint or account entering an excluding state
   raises a blocker. Depends on W2-W5.
3. **Infrastructure watcher.** Persistence failure, quarantined state file, a
   sustained rate of `not-dispatched`/`abandoned` outcomes, or
   `no-healthy-endpoint`. A health system that is itself broken must not be
   quiet — this document's thesis applied to its own implementation.

Alarm state is stored separately from health, keyed by
`(subject, incidentGeneration)`. An incident re-arms only after demonstrated
recovery, so a flapping endpoint yields one alarm per incident. Recovery emits a
closing notification.

**Acceptance:** watcher 1, replayed against the real CTO ledger from 2026-09-14,
raises a blocker within the first hour of that data.

### W8 — Recovery, and the anti-brick rule

Exclusions must never leave the box unable to work with no way back.

- **Manual reset is authoritative.** A user-invoked reset on an endpoint or
  account clears that exclusion and immediately runs one bounded real test,
  **reporting the result**. A user-requested probe success **does** clear an
  authoritative exclusion — the user is the evidence, and a control that cannot
  perform the recovery it offers is a dead control (`NEVER STUB A CONTROL TO DO
  NOTHING`).
- **Automatic admission probe** on first registration, re-enable, or
  configuration change: one cheap call (≤200 tokens, 10s), off every hot path,
  scheduled with jittered backoff 5m → 15m → 1h → 6h → 24h cap. Probe evidence is
  recorded separately and is weaker than production evidence: it clears
  `unproven` and transient `dead`, and never clears an authoritative state on its
  own.
- **Self-doubt rule.** If health would exclude every endpoint of a tier, it
  excludes them and the operation fails closed — but simultaneously raises W7.3
  with "health may be wrong", because "everything is broken" is more often a bug
  in the detector than in the world.
- **Last-resort probe — force a probe, never a payload.** Before an operation
  fails with `no-healthy-endpoint`, the engine may probe (W8's cheap ≤200-token
  call) the **least-recently-failed** excluded endpoint, once, subject to that
  endpoint's own backoff. A pass clears the exclusion and the operation proceeds
  normally; a fail is recorded and the operation fails closed as before.

  This is the honest answer to "shouldn't it just force something through". A
  totally-excluded pool means one of two things, and forcing helps in neither:
  if the world really is broken, a forced dispatch fails anyway and merely costs
  more; if the detector is wrong, a forced dispatch *hides* the bug — which is
  exactly how six weeks were lost. A probe distinguishes the two cheaply and
  self-heals a stale exclusion without re-opening the fail-open path. Bounded,
  evidence-producing, and it can never send real work to a known-bad endpoint.
- **Configuration change** to an endpoint or credential clears its health and
  re-runs admission, so stale failures are never inherited by a re-pointed
  endpoint.

Probe calls are recorded as probe evidence and **excluded** from budget
accounting, operation statistics and the W7.1 class watcher.

**This is the only model call this spec adds**, and it is what stops an unfunded
key ever entering the pool.

### W9 — Surface it

Per endpoint on the existing Accounts / Models surface: state, last success,
attempts and success rate in the window, and the exclusion reason. Read-only,
plus the W8 reset action. `no-healthy-endpoint` gets user-visible copy naming
what was excluded and why, with the reset affordance inline.

### W10 — Agent / tool registry

The registry scan fails 141 of its last 143 runs, reported as `db-unavailable` —
a label applied to *every* scan exception, so the true cause is unknown. D6's
shape in a second place.

- Distinguishable failure codes (W3's treatment).
- `unproven` / `dead` semantics for a registered agent, from observed dispatch
  outcomes.
- Covered by watcher 1.

*`ctoToolRegistry.mjs:786-790`*

### W11 — Backfill what the outage lost

**Restoring the endpoint does not restore the memory.** A segment whose
summarization fails is persisted with a *degraded* (empty) summary and an
outcome marker, and nothing ever revisits it: `summaryOutcome` is written at
`ctoSegments.mjs:561` and **read by no consumer anywhere in the codebase.** There
is no retry, no backfill, no expiry. The failure is recorded as a permanent
result.

So without this item, fixing the endpoint gives the CTO memory from that moment
forward and leaves **23,391 blank pages** behind it — the entire period the
outage covered.

**Do NOT build a new sweep — one already exists.** `ctoBackfill.mjs` is a
one-time cold-start backfill that replays up to 30 days of stored opencode
history (read-only, through the same DB handle ⌘F search uses) into the same
segmentation + summary pipeline, oldest-first, with a spend cap (default $3), a
presence-aware batch priority, a resumable cursor, and a once-per-box marker. It
is constructed and ticked by the engine (`ctoEngine.mjs:803,2366`). Everything a
backfill needs is there.

So the one-time cleanup is **operational, not code**:

1. Restore a working endpoint (fund the account, or re-route the tier).
2. Delete the 23,393 empty segment files (94 MB). They hold no source text —
   only a window marker and an empty summary — and the content they summarise is
   still in the opencode store. There are **no rollups to clear**; none were ever
   produced.
3. Let the existing backfill rebuild from history.

**Two preconditions to verify before relying on step 3:**

- **It has never run on this box.** `engine-state.json` has no
  `backfillStartInstant`, `backfillProgress` or `backfillDone`, and the ledger
  contains zero backfill rows. Since `ctoEnabled` is true, the only early return
  that writes no state is the **batch-priority presence gate** — it yields on
  every tick where presence reads `present`. Establish why that gate has never
  opened before assuming the backfill will run; if unknown presence resolves to
  `present`, it never will. *(Separate ticket — this is not an endpoint-health
  defect.)*
- **The $3 default cap will not cover 23k segments.** It stops at the depth
  reached and records `{reason:"budget", stoppedAtDepthDays}`. Raise it
  deliberately for the recovery run, or accept partial depth.

**The code change that remains is only the durable half:** give `summaryOutcome`
a reader. It is written at `ctoSegments.mjs:561` and read **nowhere**, so a
failed segment is a permanent empty shell. A failed segment must become eligible
for retry on a later sweep, bounded by an attempt count so a genuinely
unsummarizable one does not retry forever. Without it, the next endpoint outage
leaves the same silent hole and needs the same manual rescue.

*(Note for whoever runs the cleanup: select on an **empty summary**, not on the
outcome marker. Only 366 of the 23,393 segments carry `summaryOutcome` at all —
326 `model-error`, 27 `create-http`, 13 `gated` — the other 23,027 predate the
field, so keying on `ok === false` would miss 98% of them.)*

---

## 6. Non-goals

- **No model judges routing.** Evaluating a structured-decision model for the
  *fit* half is out of scope: fit was not wrong here, eligibility was blind.
- **No background liveness polling.** W8 is admission control.
- **No new network dependency** on the routing path.
- **No change to manual selection.** Every exclusion is automatic-routing only.
- **Not in scope, still live:** the summarizer needs a funded endpoint; the CTO
  search index needs its 250ms provenance barrier fixed. Separate tickets.
- **Deliberately not hardened for:** clock rollback, multi-process writers (one
  server owns this state), cross-machine health sharing, and endpoint growth
  beyond the bounded ring. Single-user box; revisit if that changes.

---

## 7. Verification

**Unit** — pure or injected I/O, sandboxed per the repo's live-box rules
(`statePath()` everywhere, injected writers, `MANTA_STATE_HOME` honoured):

- 402 on a first request with no prior step → account excluded (D2).
- **A local opencode failure (`create-http`, `provenance-error`, a connection
  failure at the prompt boundary) never touches endpoint health** — the
  regression that would otherwise exclude every model when opencode restarts.
- **A 402/429 at the prompt boundary on a pinned model DOES count** (§4.1a), with
  its `Retry-After` preserved — the mirror-image regression, where the evidence
  an existing bridge deliberately rescues is thrown away again.
- A **404** at the prompt boundary does **not** exclude anything on its own —
  the local-missing-session case must not be mistaken for a provider's "no such
  model".
- The same status at the prompt boundary on an **unpinned** run counts for
  nothing and is recorded `dispatched-unattributed`.
- A failed refresh does **not** reset the 401 counter; a successful one does,
  including a successful *proactive* refresh (§4.5a).
- An excluded incumbent is never returned, and a healthy-but-unqualified
  incumbent still takes today's path (W1 rule 4).
- `MessageAbortedError` is ignored; `ContentFilterError` does not degrade health.
- A finish of `content_filter`/`refusal` with no error object does not degrade
  health; twenty of them in a row do not mark an endpoint dead.
- An output/context cap does not degrade health.
- An error row with no `statusCode` is transient, never authoritative (there is
  exactly one such `APIError` in the live store — the shape is real).
- One 401 arms, two consecutive exclude; an intervening credential recovery
  resets the count.
- A provider attempt is built from the **causative** assistant message, not the
  latest, when they differ.
- `no-healthy-endpoint` fires for **either** of W1's two causes, and a test for
  each: (a) the value today's code would return is health-excluded (rule 2 —
  forced by I1 even when the health-neutral set is also empty), or (b) the
  health-neutral survivor set is non-empty (rule 3). An ordinary constraint miss
  with a healthy incumbent still returns today's result (rule 4).
- A persistence write failure skips neither cleanup nor the caller's result, and
  raises the infrastructure watcher.
- A synchronous `trackCreation()` throw still yields a record.
- Cleanup failure cannot contradict a written provider attempt.
- Terminal write is idempotent under duplicate delivery.
- Concurrent completions both persist (RMW serialization).
- `unproven` survives ring eviction of an old success; 199 failures after one old
  success still mark `dead`.
- Exclusions **and** failure streaks survive a store reload — there is no
  process-local health state (W5).
- All candidates excluded → `no-healthy-endpoint`; the excluded incumbent is
  **not** returned; **every caller** honours it (one test per caller).
- Failover resolves a different `endpointKey` or stops; total model calls per
  operation ≤2 including the quality cascade.
- A user-requested reset clears an authoritative exclusion and reports the probe
  result.
- A corrupt health file is quarantined, rebuilt, and alarmed.
- Watcher fires once per incident and re-arms only after recovery.

**Fixtures** — the acceptance test, honestly scoped:

> The CTO ledger records `operation` and `code` but **not** provider, model or
> HTTP status, so a full endpoint-level replay of the 363 failures is impossible:
> the evidence was never written (D6) and the sessions holding it were deleted
> (D7). Two tests instead:
>
> 1. **Class watcher, real data.** Replay the actual CTO ledger from 2026-09-14.
>    Watcher 1 must raise a blocker within the first hour of it. Needs only
>    fields that exist.
> 2. **Endpoint detector, synthetic fixture.** A committed, **synthetic**
>    SQLite fixture — not a copy of production rows, which carry prompts,
>    response bodies and headers — covering both shapes seen live: `APIError`
>    with `statusCode`, and the status-less `MessageAbortedError` /
>    `ContentFilterError` / `UnknownError` rows that are 410 of the 778 real
>    ones. Point `MANTA_OPENCODE_DB` at it **before** the shared handle opens,
>    reset the handle between tests, and restore the environment after.
>    `MANTA_STATE_HOME` does **not** sandbox opencode's database; a test that
>    opens the live one is a bug.

**Live deck entry** (real box, not `npm test`, per the routing-deck convention):
force the nano primary to 402 → a summary completes on an alternate, the account
is excluded, a blocker appears, the exclusion survives a server restart, and the
reset action brings it back.

---

## 8. Sequencing

Two gates, both load-bearing: **nothing may exclude anything until W1 has landed
and every caller honours it**, and **nothing may feed health until W2
distinguishes local failures from provider failures.** Violating either turns a
detector into an outage.

1. **W7.1** — the class watcher. Smallest item, reads only fields that exist,
   depends on nothing, and alone converts a silent outage into a loud one.
2. **W2 + W3** — the attempt lifecycle and its cause. One change at the transport
   boundary; everything downstream is a projection.
3. **W1** — fail closed, with all callers. *Gate: before any exclusion exists.*
4. **W0** — make the CTO consume health. Pointless before W1; mandatory before
   any of this is observable on the path that broke.
5. **W4 + W5 + W8 — one atomic step.** Registers, scope rules, statistics **and**
   recovery/admission ship together. W5 is where the first excluding state comes
   into existence, and W8's gate says recovery must not lag it: an exclusion with
   no recovery path is a brick. They are therefore not separable, and neither may
   merge alone.
6. **W7.2 + W7.3**, then **W6**, then **W9**.
7. **W10** tracks separately.

The round-1 objection to alarm-first was that an alarm without attribution is
placebo. True of watcher 2, which sits at step 7. Watcher 1 needs no attribution
at all — and it is the one that would have caught this.
