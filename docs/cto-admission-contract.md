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
| `interrupt` | `interrupt(id, { reason? }) → { ok, id, status }` | The EXPLICIT interruption op. `queued`/`unknown` → `cancelled`; `accepted` → aborts the session once → `interrupted`. `submit` NEVER aborts. |
| `observeEvent` | `observeEvent(evt) → void` | Same firehose tap as promptDelivery. Tracks busy (fallback when no shared `isBusy`) and completes accepted turns on their ACTUAL terminal event (`session.idle` / `session.error`). |

Contract error codes (`CtoAdmissionError.code`): `invalid-argument`, `duplicate-id-different-payload`,
`at-cap`, `stale-generation`, `binding-unavailable`, `not-found`, `already-terminal`,
`dispatch-in-flight`, `abort-unsupported`, `store-unavailable`, `invalid-state`, `deadline-exceeded`.

## Submission lifecycle

```
queued ──dispatch──▶ dispatching ──204+receipt──▶ accepted ──terminal event/status──▶ completed
   │                     │                            │
   ├─interrupt─▶ cancelled   │ 4xx refusal ─▶ failed     ├─interrupt─▶ interrupted
   │                     │                            │
   └── (restart / uncertain send / receipt invisible) ─┴────▶ unknown ──receipt found──▶ accepted
```

- **Durable before send**: id + canonical payload hash (sha256 over origin/text/model) + origin +
  expected binding generation persist at submit; the dispatched `sessionId` + allocated opencode
  `messageID` (`msg_*`) persist BEFORE the `prompt_async` POST. A crash can never lose the
  reconciliation identity.
- **One turn at a time**: no dispatch while any record is `dispatching`/`accepted`/`unknown`.
  Human FIFO outranks queued background; an accepted turn is never reordered.
- **Ack ≠ completion**: 204 + messageID receipt (`GET /session/{id}/message/{messageID}` — the
  P0-proven receipt) yields `accepted` only. `completed` requires the real terminal event or a
  transcript proof (an assistant row with `time.completed`/`error` after our user message).
- **No blind resend**: acceptance can only be PROVEN (receipt found). Unprovable → `unknown`,
  surfaced (stale after 60s), retried by `reconcile()` — never resent. Only a definitive 4xx
  observed live proves non-acceptance (`failed`). There is deliberately NO resend/resubmit op;
  a caller that decides otherwise submits a NEW id.
- **Binding generations**: dispatch resolves the CURRENT binding (P3a1 `getBinding()`), so pending
  work retargets a replacement role session automatically (recorded: `retargeted: true`,
  `dispatchGeneration`); an accepted turn keeps its original `sessionId` forever. A caller may pin
  `expectedGeneration` — mismatch refuses with `stale-generation`.
- **Receipts retained forever**: terminal records are never evicted; growth is bounded by
  refusing NEW submissions at `MAX_ENTRIES` (500) with `at-cap`.

## Store

`ctoStores.admissionStore` (`~/.manta/cto/admission.json`, atomic 0600, sandbox-aware). Payload:
`{ v: 1, submissions: [...] }`, validated strictly by `normalizeAdmissionPayload` (corruption
throws; never silently reinterpreted). All writes go through `patchStore`'s per-path mutex with
sync mutators — no store lock is ever held across an opencode await.

## Known limitations (honest scope)

1. **`unknown` holds the gate**: admission stalls behind an unresolved unknown until its receipt
   appears (`reconcile`) or a caller cancels it (`interrupt`). This is the conservative
   no-duplicate-send trade — surface `list()` state, don't work around it.
2. **`interrupt` of an accepted turn aborts the whole role session** (opencode abort is
   session-wide). If some other path prompted the session, that turn aborts too.
3. **Turn-completion reconcile needs `listMessages`** (or the event tap). Without either, an
   accepted record waits for a terminal event that a restart may have swallowed.
4. **No multi-writer safety**: one manta-server per box composes one engine (patchStore CAS
   narrows, never guarantees, cross-process races).
5. **No resend operation, no per-subscription routing, no UI card** — later phases build on
   `list()`; nothing here talks to clients directly.
6. **Routine work-event entries** (spec §3.2 rows that need no model turn) do NOT pass through
   admission — this service is for turns only.
