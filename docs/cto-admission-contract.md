# CTO conversation admission — stable service contract (P3a2)

`src/server/ctoAdmission.mjs` — `createCtoAdmission(deps)`. Spec: `docs/unified-cto-spec.md`
§8.3. This is the ONE server-owned admission path for every prompt to the CTO role session
(desktop/native CEO submissions and background synthesis alike). Ordinary project delivery is
UNTOUCHED (`promptDelivery.mjs` keeps its own engine for webhooks/schedules/peers/capability
jobs). Wired since P3a3 (`src/server/ctoConversation.mjs` + `src/server/index.mjs`): the four
authenticated `cto:conversation-*` RPC channels, the direct-send seams, the event tap and the
bounded tick poller all use exactly the recipe below. Do not add a second admission path for
the CTO session.

## Production composition (as wired)

```js
import { createCtoAdmission } from "./ctoAdmission.mjs";
import { createPromptDelivery } from "./promptDelivery.mjs";
import { createCtoBinding } from "./ctoBinding.mjs";
import { createCtoConversationService } from "./ctoConversation.mjs";
import { CTO_AGENT_NAME } from "./providers.mjs";
import * as oc from "./opencode.mjs";

const promptDelivery = createPromptDelivery({
  sendPrompt: (args) => oc.sendPrompt(args),
  redirect: (args) => ctoConversation.redirectDelivery(args), // background seam
});
const binding = createCtoBinding({ oc });                    // P3a1 service (LAZY — no oc calls at boot)
const admission = createCtoAdmission({
  binding,                          // dispatch resolves the CURRENT binding
  sendPrompt: (args) => oc.sendPrompt(args),  // messageID-capable (P3a2, P0-proven)
  getMessage: (sid, mid) => oc.getMessage(sid, mid),   // receipt read-back
  listMessages: (sid, opts) => oc.listMessages(sid, opts), // turn-completion reconcile
  abortSession: (sid, opts) => oc.abortSession(sid, opts), // explicit interrupt only
  isBusy: promptDelivery.isBusy,       // SHARED busy view — one truth for both engines
});
const ctoConversation = createCtoConversationService({
  binding, admission,
  agentName: CTO_AGENT_NAME,          // server-owned agent; callers never choose one
});
// A bounded tick poller drives recovery + admission without events (30s);
// startPoller surfaces failures via warn — never swallowed as healthy.
const { stop } = startPoller(() => admission.tick(), { intervalMs: 30_000, label: "cto-admission" });
```

Constraint: compose ONE admission engine per box (single-writer-process, like ctoBinding).
The ONE firehose tap in index.mjs feeds BOTH engines (`promptDelivery.observeEvent(evt)` then
`admission.observeEvent(evt)`) — same event shapes, no second stream. The RPC surface
(`rpc.mjs`): `cto:conversation-open` → `{sessionId, generation}` (first open creates the role
session, no model invocation, singleflight under concurrency); `cto:conversation-state` →
`{binding:{sessionId|null, generation}, submissions, counts}` (pure store read); 
`cto:conversation-submit {id?, text, expectedGeneration?, model?}` → the durable submit
receipt (origin "human" and the `cto` agent are stamped server-side); 
`cto:conversation-interrupt {id}` → `{ok, id, status}`. The `opencode:prompt` /
`opencode:run-command` routes redirect/reject conversation-targeted sends through the same
seam (plain text routed with a stable id; slash commands and file parts rejected with the
"not supported yet" copy), and `promptDelivery.deliver` redirects conversation-targeted
background deliveries into this queue with a stable content-mapped id (`bg_*`).

## Operations

| Op | Signature | Notes |
|---|---|---|
| `submit` | `submit({ text, origin, id?, model?, agent?, expectedGeneration? }) → { id, status, persisted, payloadHash, submitGeneration, ... }` | Validates, dedups by `id`, persists durably, THEN kicks dispatch. Throws only contract errors (below). `origin` is `"human"` or `"background"`. Omitting `id` mints `evt_<uuid>` — the STABLE EVENT ID (persisted before any send; clients dedup replays by it). |
| `list` | `list() → { submissions, counts }` | The queue projection clients render. Text payloads are stripped; each record carries its status, timestamps, generation fields, and for unknown records `unknownMs` + `staleUnknown`. Order = submission order; human FIFO is the filtered order. |
| `tick` | `tick() → void` | Poller entry: `reconcile()` then admit (at most one turn). |
| `reconcile` | `reconcile() → void` | Recovery only: receipt read-backs for `dispatching`/`unknown` records; transcript-based settlement for accepted records whose terminal event was missed (spaced ≥10s per record) — terminal linked row → `completed` (strict reader); receipt absent → stamped bookkeeping, barrier held; the degenerate NO-LINKED-ROW crash shape (CAPO-352) → `interrupted` after `ACCEPTED_NO_ROW_GRACE_MS`. Transcript-based settlement for `interrupt_pending` incl. the abort-ok + no-row grace (below). NEVER resends. |
| `interrupt` | `interrupt(id, { reason? }) → { ok, id, status }` | The EXPLICIT interruption op. `queued` → `cancelled` (safe, never dispatched); `unknown` → `cancel_requested` (VISIBLE request, barrier retained — the POST may still be landing; reconcile settles by receipt); `accepted` → the attempt is RESERVED durably BEFORE the HTTP (`abortState: "claimed"` + `attemptId` + `attemptStartedAt` + `attemptCount`, written under the admission lock — exactly once, claimed by THIS call) → ONE bounded, signal-propagated abort → the owner settles only its matching attemptId → `interrupt_pending` throughout. Terminalization needs the abort settled AND the transcript proving the turn ended (`"ok"` → `interrupted`, `"refused"` → `completed`). An `uncertain` abort NEVER retries and NEVER settles — `abortOutcomeReason: "abort_outcome_unknown"` + permanent barrier. Idempotent re-requests return the current request-marker status. `submit` NEVER aborts. |
| `observeEvent` | `observeEvent(evt) → void` | Same firehose tap as promptDelivery. Tracks busy (fallback when no shared `isBusy`) and completes accepted turns on their ACTUAL terminal event (`session.idle` / `session.error`). |

Contract error codes (`CtoAdmissionError.code`): `invalid-argument`, `duplicate-id-different-payload`,
`at-cap`, `stale-generation`, `binding-unavailable`, `not-found`, `already-terminal`,
`dispatch-in-flight`, `abort-unsupported`, `store-unavailable`, `invalid-state`, `deadline-exceeded`.

## Submission lifecycle (explicit state matrix)

```
queued ──dispatch──▶ dispatching ──204+receipt──▶ accepted ──transcript proof──▶ completed
   │                     │                            │
   │              4xx refusal ─▶ failed               │
   │                     │                            │
   │        deadline/network/5xx/receipt invisible       │
   │                     ▼                            │
   │                  unknown ──receipt found──▶ accepted
   │                     │        (reconcile keeps checking)
   ├─interrupt─▶ cancelled                ▲
   │  (never dispatched: safe)            │ receipt found
   │                                      │
   └── (restart / uncertain send) ──▶ cancel_requested ───┘
        (NONTERMINAL: the POST may still be landing; barrier held; a found
         receipt flips it to accepted with cancelRequested retained)

accepted ──receipt-specific reconciliation──▶ completed
   (ONLY transcript proof: our user message + the LAST assistant row whose
   parentID == our messageID carrying a TERMINAL finish via the shared
   assistantCompletion helper. tool-step finishes and unlinked rows are never
   proof.)

accepted ──periodic reconcile──▶ completed | interrupted (CAPO-352)
   The reconcile ALSO settles accepted records with no event at all. It reads
   the messageID receipt back from the transcript:
     receipt absent          ⇒ stays accepted + stamped receipt-check
                               bookkeeping (lastReceiptCheckAt / receiptChecks,
                               the same semantics as the unknown path) — never
                               resent;
     terminal linked row     ⇒ completed (the strict reader, as above);
     NO linked row (crash)   ⇒ interrupted (outcome via "transcript-no-row")
                               once the record has sat rowless past
                               ACCEPTED_NO_ROW_GRACE_MS (15 min from acceptedAt).
   The no-row shape is the incident's exact shape (CAPO-352): a restart
   between message-persist and turn completion leaves the user row with ZERO
   assistant rows, so the strict reader can never fire and an accepted record
   held the whole queue for 96h. A live turn produces its first linked row
   within seconds of the user row persisting, so persisting rowless past the
   grace is itself the proof the turn died. No blind resend, no blind
   completion — the transcript decides.

accepted ──interrupt──▶ interrupt_pending (NONTERMINAL barrier)
   abortState: "pending" (durable request, no attempt marker) --claim under
                the admission lock: "claimed" + attemptId + attemptStartedAt
                + attemptCount persisted BEFORE the HTTP--
   → ONE bounded, signal-propagated attempt issued exactly once by the live
     interrupt call → "ok" (2xx) | "refused" (4xx) | "uncertain" (deadline /
     network) — the owner settles ONLY its own matching attemptId (a stale or
     late response can never overwrite a newer state — monotonic)
    settle needs BOTH facts: the transcript proves the turn ENDED
    (finish-agnostic: the last linked assistant row is no longer running —
    an aborted row qualifies) AND the abort is settled:
      "ok"      + turn ended ⇒ interrupted
      "refused" + turn ended ⇒ completed (natural finish)
      "uncertain" + turn ended ⇒ the turn end is RECORDED (turnEndedAt) but the
        record stays interrupt_pending FOREVER: there are NO automatic abort
        retries (a new attempt's response can never settle the ORIGINAL
        request's uncertainty — monotonic — and a late original abort could
        kill the next turn), so the same-session admission barrier persists
        until a future EXPLICIT management operation resolves it (not built
        yet). AT RECOVERY (restart) BOTH "claimed"-without-a-live-owner
        (attempted-but-unsettled — the HTTP may still land) and "pending"
        downgrade to "uncertain": reconcile NEVER issues an abort.
    degenerate no-row case (CAPO-352): the turn can die BEFORE any linked
    assistant row ever exists, so the finish-agnostic reader can never see an
    end. Then — ONLY when the abort is DEFINITIVELY settled "ok" (the server
    confirmed nothing is running) AND the user row IS present in the
    transcript AND INTERRUPT_NO_ROW_GRACE_MS (30s) has passed since the abort
    settled (a post-abort row can legitimately land late) — the record
    settles interrupted with outcome via "abort-no-row". A claimed /
    uncertain / refused abort keeps the barrier in every shape, and a
    receipt that is absent settles nothing.
   events (session.idle/error) are TRIGGERS for the transcript check — they
   never terminalize an unresolved abort, and a stale/unrelated event cannot
   release the queue.
```

- **Durable before send**: id + canonical payload hash (sha256 over origin/text/model/agent,
  key-order canonical — reordered model-object keys replay idempotently) + origin + expected
  binding generation persist at submit; the dispatched `sessionId` + allocated opencode
  `messageID` (`msg_*`) persist BEFORE the `prompt_async` POST. A crash can never lose the
  reconciliation identity.
- **Dedup precedes generation validation**: a same-id same-payload replay returns the existing
  record even after the binding was replaced; a same-id different-payload (different agent,
  different text, different model) refuses with `duplicate-id-different-payload`. Generation
  validation (`stale-generation`) applies to NEW records only.
- **One turn at a time**: no dispatch while any record is `dispatching` / `accepted` /
  `unknown` / `cancel_requested` / `interrupt_pending`. Human FIFO outranks queued background —
  re-verified AT CLAIM TIME under the store mutex, so a human arriving while the pump awaited
  the binding still wins before the dispatch commits. An accepted turn is never reordered.
- **Linearizable claim (vs binding generations)**: the dispatch claim runs through the binding
  service's `claimGeneration(reserve)` — the reserve callback executes under the SAME
  serialized store seam as `ensure()`/`recover()`, reads the binding FRESH inside that section,
  and reserves the admission record against that exact generation (lock order binding →
  admission; all locks release BEFORE the external POST; the callback does no external awaits).
  A generation change BEFORE the claim is observed (pending work targets current); a change
  AFTER the claim serializes behind it and the claimed delivery stays on its own session. No
  outside snapshot is ever compared against itself.
- **Ack ≠ completion (receipt-specific reconciliation)**: 204 + messageID receipt yields
  `accepted` only. A `session.idle`/`session.error` EVENT triggers a transcript check for THIS
  record — it never blindly completes, and a stale/unrelated idle cannot release the queue.
  Completion proof = our user message + the LAST assistant row whose `parentID` equals our
  messageID carrying a TERMINAL finish via the shared `assistantCompletion` helper (tool-step
  finishes and unlinked rows are never proof).
- **No blind resend**: acceptance can only be PROVEN (receipt found). Unprovable → `unknown`,
  surfaced (stale after 60s), retried by `reconcile()` — never resent. Aborting the client
  request (deadline) does NOT prove the server didn't accept → stays unknown. Only a definitive
  4xx observed live proves non-acceptance (`failed`). There is deliberately NO resend/resubmit
  op; a caller that decides otherwise submits a NEW id.
- **Reconcile never races an in-flight send**: each dispatch holds an active-operation lease
  taken BEFORE its store claim; reconcile skips leased records.
- **Binding generations**: dispatch resolves the CURRENT binding (P3a1 `getBinding()`), so
  pending work retargets a replacement role session automatically (recorded: `retargeted: true`,
  `dispatchGeneration`); an accepted turn keeps its original `sessionId` forever. A caller may
  pin `expectedGeneration` — mismatch refuses with `stale-generation` (new records only).
- **Terminal receipts are bounded bookkeeping (P3a3 review round 3)**: terminal receipts of
  EITHER origin are evicted into compact durable TOMBSTONES (`{id, payloadHash, status}`)
  once they exceed `MAX_TERMINAL_BACKGROUND` (200) — oldest first, inline at the cap and via
  the shared CTO store sweeper (`admission.trimTerminal()`). They are queue bookkeeping, not
  conversation history — the real transcript lives in opencode. The tombstone keeps the dedup
  identity: a genuine same-id retry still replays (never double-sends); occurrence identities
  never recur (schedule keys embed the full-date minute key; webhook/delegate ids are unique),
  so eviction cannot resurrect a turn. **A human submit is NEVER refused at the cap**: the
  cap path evicts terminal receipts first, then — for a HUMAN submit only — drops the OLDEST
  QUEUED BACKGROUND deliveries (tombstoned as `cancelled`: cancelled-by-policy, never
  dispatched, so a replay does not resurrect them; human FIFO outranks background synthesis).
  Only a store full of UNRESOLVED records still refuses, and the refusal says so.

## Store

`ctoStores.admissionStore` (`~/.manta/cto/admission.json`, atomic 0600, sandbox-aware). Payload:
`{ v: 1, submissions: [...], tombstones: [...] }`, validated strictly by
`normalizeAdmissionPayload` (corruption throws; never silently reinterpreted). All writes go
through `patchStore`'s per-path mutex with sync mutators — no store lock is ever held across an
opencode await.

## Known limitations (honest scope)

1. **Nonterminal request markers hold the gate**: an `unknown` / `cancel_requested` /
   `interrupt_pending` record blocks admission until reconcile resolves it (receipt found, or
   the abort settles + the turn is proven ended). A caller cancel does NOT release an
   `unknown` — interrupting it only converts it to `cancel_requested`, which is still a
   nonterminal barrier that reconcile must prove out of (Operations table above). This
   is the conservative no-duplicate/no-late-abort trade; surface `list()` state, don't work
   around it.
1a. **An uncertain abort is a PERMANENT, non-self-healing barrier** (`abortState: "uncertain"`,
   `abortOutcomeReason: "abort_outcome_unknown"`): no automatic retry ever runs, the record
   never settles on its own, and same-session admission stays blocked. Recovery downgrades
   BOTH a `claimed` attempt whose owner died (attempted-but-unsettled — the HTTP may still
   land) and a `pending` request to `uncertain`; reconcile NEVER issues aborts. The CURRENT
   resolution is external and explicit only (a future management operation on the queue — not
   built in this phase). The UI must present it as "abort outcome unknown — admission held for
   this session", never as transient.
2. **`interrupt` of an accepted turn aborts the whole role session** (opencode abort is
   session-wide). The gate holds until the abort settles, so the blast radius cannot reach the
   NEXT admitted turn — but a foreign turn running on the session during the abort is hit too.
2a. **Abort seaming is DELIBERATELY DEFERRED to its own PR (parent decision, P3a3 round 3).**
   Routing `opencode:abort` of the bound role session onto admission's tracked interrupt was
   built and REVERTED in this PR: a session-wide raw abort is inherently unsafe once the
   admission barrier can release (a stray abort on a parked-unknown record reconciles to
   accepted, the barrier releases, and the LATE abort lands on the NEXT admitted turn —
   invariant 7's exact exclusion), and every seam variant either reported silent success on a
   marker or cancelled the wrong turn. This PR ships main's plain raw abort; nothing consumes
   admission's `interrupt` yet. The seam returns in its own PR with the design settled first
   (likely: a session-level barrier reference so an abort can be scoped to the admitted turn).
3. **Turn-completion settlement needs `listMessages`** (or the event tap). Without either, an
   accepted record waits for a terminal event that a restart may have swallowed, and
   event-driven settlement is impossible (the barrier holds). With `listMessages` wired, the
   periodic reconcile now also settles the two CAPO-352 degenerate shapes without any event:
   accepted + no linked assistant row (interrupted after `ACCEPTED_NO_ROW_GRACE_MS`) and
   interrupt_pending + definitive abort-ok + no linked assistant row (interrupted after
   `INTERRUPT_NO_ROW_GRACE_MS`). An accepted record whose transcript shows a linked row that
   NEVER reaches a terminal finish is still not distinguishable from a live turn by the
   transcript alone — that barrier holds by design.
4. **An abort with no transport never settles**: with no `abortSession` wired, an
   interrupt_pending record keeps its barrier (surfaced `abortError`) — production must wire
   the signal-capable abortSession. No idempotency is assumed or relied upon: after one
   uncertain attempt the service stops issuing aborts entirely.
5. **Single-writer-process**: one manta-server per box composes one engine (patchStore CAS
   narrows, never guarantees, cross-process races). The binding claim is linearizable only
   through the shared ctoBinding service on the same box.
6. **No resend operation, no per-subscription routing, no UI card** — later phases build on
   `list()`; nothing here talks to clients directly.
7. **Routine work-event entries** (spec §3.2 rows that need no model turn) do NOT pass through
   admission — this service is for turns only.
8. **Webhook redelivery outside the hook's dedupe window double-prompts** (P3a3-review):
   manta hooks carry no stable delivery id (GitHub hooks route to forge ingest before any
   delivery), so each accepted webhook delivery mints a UNIQUE admission id — a redelivery
   that falls outside the hook store's own `seenDeliveryIds` window (and its HMAC replay
   guard) becomes a NEW occurrence and sends again. The hook store's window is the designed
   redelivery dedupe; admission cannot recognize the repeat. Callers WITH stable identities
   (schedule job+minute, capability job+status) dedup exactly once per occurrence.
