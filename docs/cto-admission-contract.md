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
| `reconcile` | `reconcile() → void` | Recovery only: receipt read-backs for `dispatching`/`unknown` records; transcript-based completion for accepted records whose terminal event was missed (spaced ≥10s per record). NEVER resends. |
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
- **Receipts retained forever (human) — tombstoned at a bound (background)**: terminal HUMAN
  receipts are never evicted; growth is bounded by refusing NEW submissions at `MAX_ENTRIES`
  (500) with `at-cap`. Terminal BACKGROUND receipts (P3a3-review) are evicted into compact
  durable TOMBSTONES (`{id, payloadHash, status}`) once they exceed
  `MAX_TERMINAL_BACKGROUND` (200) — oldest first, inline at the cap and via the shared CTO
  store sweeper (`admission.trimTerminalBackground()`). The tombstone keeps the dedup
  identity: a genuine same-id retry still replays (never double-sends); occurrence identities
  never recur (schedule keys embed the full-date minute key; webhook/delegate ids are unique),
  so eviction cannot resurrect a turn. A human submit is NEVER refused because background
  receipts filled the store — the cap path tombstones to make room first and refuses only
  when nothing evictable remains.

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
3. **Turn-completion reconcile needs `listMessages`** (or the event tap). Without either, an
   accepted record waits for a terminal event that a restart may have swallowed, and
   event-driven settlement is impossible (the barrier holds).
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
