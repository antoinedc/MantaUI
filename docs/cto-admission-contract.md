# CTO conversation admission — stable service contract (P3a2)

`src/server/ctoAdmission.mjs` — `createCtoAdmission(deps)`. Spec: `docs/unified-cto-spec.md`
§8.3. This is the ONE server-owned admission path for every prompt to the CTO role session
(desktop/native CEO submissions and background synthesis alike). Ordinary project delivery is
UNTOUCHED (`promptDelivery.mjs` keeps its own engine for webhooks/schedules/peers/capability
jobs). No routes, no UI, no poller are wired yet — that is the parent integration's job, using
exactly the recipe below. Do not add a second admission path for the CTO session.

## Production composition (the parent wiring)

```js
import { createCtoAdmission } from "./ctoAdmission.mjs";
import { createPromptDelivery } from "./promptDelivery.mjs";
import * as oc from "./opencode.mjs";
import { createCtoBinding } from "./ctoBinding.mjs";

const promptDelivery = createPromptDelivery({ sendPrompt: (args) => oc.sendPrompt(args) });
const binding = createCtoBinding({ oc });                    // P3a1 service
const admission = createCtoAdmission({
  binding,                          // dispatch resolves the CURRENT binding
  sendPrompt: (args) => oc.sendPrompt(args),  // messageID-capable (P3a2, P0-proven)
  getMessage: (sid, mid) => oc.getMessage(sid, mid),   // receipt read-back
  listMessages: (sid) => oc.listMessages(sid),         // turn-completion reconcile
  abortSession: (sid) => oc.abortSession(sid),         // explicit interrupt only
  isBusy: promptDelivery.isBusy,       // SHARED busy view — one truth for both engines
});

// ONE firehose tap feeds both engines (same event shapes):
onOpencodeEvent((evt) => {
  promptDelivery.observeEvent(evt);
  admission.observeEvent(evt);
});
// A poller drives recovery + admission without events (30s is fine):
setInterval(() => admission.tick().catch(() => {}), 30_000).unref();
```

Constraint: compose ONE admission engine per box (single-writer-process, like ctoBinding).

## Operations

| Op | Signature | Notes |
|---|---|---|
| `submit` | `submit({ text, origin, id?, model?, agent?, expectedGeneration? }) → { id, status, persisted, payloadHash, submitGeneration, ... }` | Validates, dedups by `id`, persists durably, THEN kicks dispatch. Throws only contract errors (below). `origin` is `"human"` or `"background"`. Omitting `id` mints `evt_<uuid>` — the STABLE EVENT ID (persisted before any send; clients dedup replays by it). |
| `list` | `list() → { submissions, counts }` | The queue projection clients render. Text payloads are stripped; each record carries its status, timestamps, generation fields, and for unknown records `unknownMs` + `staleUnknown`. Order = submission order; human FIFO is the filtered order. |
| `tick` | `tick() → void` | Poller entry: `reconcile()` then admit (at most one turn). |
| `reconcile` | `reconcile() → void` | Recovery only: receipt read-backs for `dispatching`/`unknown` records; transcript-based completion for accepted records whose terminal event was missed (spaced ≥10s per record). NEVER resends. |
| `interrupt` | `interrupt(id, { reason? }) → { ok, id, status }` | The EXPLICIT interruption op. `queued` → `cancelled` (safe, never dispatched); `unknown` → `cancel_requested` (VISIBLE request, barrier retained — the POST may still be landing; reconcile settles by receipt); `accepted` → ONE bounded, signal-propagated abort attempt → `interrupt_pending` with the abort's own durable state (`abortState`). The record terminalizes only when the abort is settled AND the transcript proves the turn ended (`"ok"` → `interrupted`, `"refused"` → `completed`). An `uncertain` abort NEVER retries and NEVER settles — `abortOutcomeReason: "abort_outcome_unknown"` + permanent barrier. Idempotent re-requests return the current request-marker status. `submit` NEVER aborts. |
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
   abortState: "pending" → ONE bounded attempt → "ok" (2xx, settled)
                                      | "refused" (4xx, settled)
                                      | "uncertain" (deadline/network) ⇒
                                        PERMANENT fail-closed barrier with
                                        reason abort_outcome_unknown
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
       yet). A crash before the FIRST attempt (state "pending") gets exactly
       one attempt from reconcile; after that, uncertainty is final.
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
- **Receipts retained forever**: terminal records are never evicted; growth is bounded by
  refusing NEW submissions at `MAX_ENTRIES` (500) with `at-cap`.

## Store

`ctoStores.admissionStore` (`~/.manta/cto/admission.json`, atomic 0600, sandbox-aware). Payload:
`{ v: 1, submissions: [...] }`, validated strictly by `normalizeAdmissionPayload` (corruption
throws; never silently reinterpreted). All writes go through `patchStore`'s per-path mutex with
sync mutators — no store lock is ever held across an opencode await.

## Known limitations (honest scope)

1. **Nonterminal request markers hold the gate**: an `unknown` / `cancel_requested` /
   `interrupt_pending` record blocks admission until reconcile resolves it (receipt found, or
   the abort settles + the turn is proven ended) or — for unknown — a caller cancels it. This
   is the conservative no-duplicate/no-late-abort trade; surface `list()` state, don't work
   around it.
1a. **An uncertain abort is a PERMANENT, non-self-healing barrier** (`abortState: "uncertain"`,
   `abortOutcomeReason: "abort_outcome_unknown"`): no automatic retry ever runs, the record
   never settles on its own, and same-session admission stays blocked. The CURRENT resolution
   is external and explicit only (a future management operation on the queue — not built in
   this phase). The UI must present it as "abort outcome unknown — admission held for this
   session", never as transient.
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
