// ctoCards.mjs — the durable needs-you card machinery (BET-1382 / spec §10.3,
// §9.2-blockers, D20) and its first population: blocker cards.
//
// One code path / no dead copy: `cards.json` carries all four variants
// (blocker | decision | veto | connect) so later issues add writers without a
// migration (§13.1), but ONLY `blocker` is written here — the decision/veto/
// connect writers and all rendering are later issues, explicitly out of scope.
//
// Two timers by design (spec §10.3, D20): the blocking-tier NOTIFICATION fires
// IMMEDIATELY through the EXISTING router (push.mjs firePush) and is NOT
// re-fired or duplicated here; the CARD appears only once the ask stays
// pending > 10 min (BLOCKER_AFTER_MS). This module is the card half only — it
// deliberately has NO notification code path, and its tests assert that.
//
// Stable ids: id = hash(sourceKind, sourceId); re-detection upserts the
// existing card in place, never duplicates (spec §9.1: a regeneration updates
// the existing card — age, counts, carried-forward open state — never
// re-creates it).
//
// Liveness (spec §10.3): every card holds a resolution predicate re-checked on
// the relevant bus events — question replied/rejected, permission replied,
// session aborted, health recovered. Predicate false → `state:"resolved"` plus
// a `card.resolved` ACTIVITY-LEDGER entry — explicitly NOT a verdict, so
// self-resolution never pollutes acceptance stats. Resolved/dismissed cards
// move OUT of cards.json (which holds open cards only) into the ledger.
//
// Sources (P1): (1) worker question/permission pending — registered from the
// existing ask events, promoted at > 10 min by the engine's card timer;
// (2) health escalations — the watchdog's blocker-card requests that A2
// (ctoEngine) already writes to `engine-state.json` `pendingBlockers`.
//
// Determinism + testability: pure helpers are exported (stableCardId, ask
// event classification, blocker copy); the stateful card manager is
// `createCtoCards` with injected store/ledger/clock exactly like the other
// server engines. No live tmux/opencode; every durable path resolves under
// ctoPath() (test-sandbox rule).

import { createHash } from "node:crypto";
import {
  cardsStore,
  engineStateStore,
  ledgerStore,
} from "./ctoStores.mjs";

export const ACTOR = "cto";

// The card appears when an ask stays pending >= this long (spec §10.3: card at
// > 10 min). The blocking-tier notification already fired immediately via the
// router (D20) — this is the *second* timer, the card.
export const BLOCKER_AFTER_MS = 10 * 60_000;

export const VARIANTS = Object.freeze(["blocker", "decision", "veto", "connect"]);
export const CARD_STATES = Object.freeze(["open", "resolved", "dismissed"]);

// ACTIVITY-ledger row kinds for the card lifecycle. Resolution/dismissal write
// these to the A1 activity ledger — a resolved row is explicitly NOT a verdict
// (spec §10.3), so these never reach the verdicts store and cannot pollute
// acceptance stats.
export const CARD_CREATED = "card.created";
export const CARD_RESOLVED = "card.resolved";
export const CARD_DISMISSED = "card.dismissed";

// Blocker source discriminator for health/watchdog escalations (distinct from
// the question|permission worker-ask source kinds).
export const HEALTH_SOURCE_KIND = "health";

// Stable, collision-resistant card id. Re-detection of the same (sourceKind,
// sourceId) yields the same id → upsert in place, never a duplicate.
export function stableCardId(sourceKind, sourceId) {
  return createHash("sha256")
    .update(`${sourceKind}\u0000${String(sourceId)}`)
    .digest("hex")
    .slice(0, 24);
}

// ----- Ask-event classification (pure) -----

export const ASK_START_TYPES = Object.freeze(["question.asked", "permission.asked"]);
export const ASK_RESOLVE_TYPES = Object.freeze([
  "question.replied",
  "question.rejected",
  "permission.replied",
  "permission.rejected",
]);

// The blocker-card source kind for a worker-ask event type.
export function askSourceKind(type) {
  return type === "permission.asked" ? "permission" : "question";
}

export function isAskStartEvent(evt) {
  return !!evt && ASK_START_TYPES.includes(evt.type);
}

export function isAskResolveEvent(evt) {
  return !!evt && ASK_RESOLVE_TYPES.includes(evt.type);
}

// Reduce a `question.asked` / `permission.asked` event to the pending-ask
// identity `{sourceKind, sourceId, sessionID}` used to key the card. The ask's
// request id (`properties.id`) is the stable sourceId; a session is blocked on
// at most one ask, so it also keys the in-flight registry.
export function askStartInfo(evt) {
  if (!isAskStartEvent(evt)) return null;
  const props = evt?.properties ?? {};
  const sessionID = typeof props.sessionID === "string" ? props.sessionID : null;
  const sourceId = typeof props.id === "string" && props.id ? props.id : sessionID;
  return { sourceKind: askSourceKind(evt.type), sourceId, sessionID };
}

// Reduce a reply/reject event to the session whose ask just cleared.
export function askResolveInfo(evt) {
  if (!isAskResolveEvent(evt)) return null;
  const props = evt?.properties ?? {};
  return { sessionID: typeof props.sessionID === "string" ? props.sessionID : null };
}

// Human blocker copy for a worker-ask event (title/body). Pure.
export function blockerTitle(kind) {
  if (kind === "permission") return "Permission needed";
  if (kind === "question") return "Question waiting";
  return "Health check";
}

export function blockerBody(kind, text) {
  if (kind === "permission") return text || "Claude needs permission to run a tool.";
  if (kind === "question") return text || "Claude is waiting on an answer.";
  return text || "The CTO paused itself — review the health state.";
}

// Extract the human question text from a `question.asked` payload.
export function askQuestionText(evt) {
  const props = evt?.properties ?? {};
  if (isAskStartEvent(evt) && askSourceKind(evt.type) === "question") {
    const q = Array.isArray(props.questions) && props.questions[0];
    return (q && (q.question || q.header)) || "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// The card manager — injected store/ledger/clock.
// ---------------------------------------------------------------------------

export function createCtoCards(deps = {}) {
  const {
    cardStore = cardsStore,
    engineState = engineStateStore,
    ledger = ledgerStore,
    now = () => Date.now(),
  } = deps;

  // In-flight worker asks: sessionID -> { sourceKind, sourceId, sessionID,
  // body, askedAt }. Kept in memory (derived from the live event stream); once
  // promoted, the card itself is durable in cards.json.
  const pendingAsks = new Map();

  async function ledgerAppend(entry) {
    try {
      await ledger.append({ actor: ACTOR, ts: now(), ...entry });
    } catch {
      /* best-effort — a ledger failure never takes the card machinery down */
    }
  }

  async function openCards() {
    let payload;
    try {
      payload = await cardStore.load();
    } catch {
      payload = {};
    }
    return {
      payload,
      cards: Array.isArray(payload?.cards) ? payload.cards : [],
    };
  }

  function buildBlockerCard({ id, sourceKind, sourceId, sessionID, title, body, refs, pendingSince, created }) {
    return {
      id,
      variant: "blocker",
      title,
      body,
      refs: Array.isArray(refs) ? refs : [],
      sourceKind,
      sourceId,
      // blocker-variant fields
      sessionID,
      pendingSince,
      created,
      updatedAt: created,
      state: "open",
    };
  }

  // Upsert one blocker card by its stable id. Idempotent on re-detection: the
  // existing open card is updated in place (title/body/refs/age preserved),
  // never duplicated. Returns `{ changed, isNew }`.
  async function upsertBlocker({ sourceKind, sourceId, sessionID, title, body, refs, ts = now(), pendingSince = ts }) {
    const id = stableCardId(sourceKind, sourceId);
    const { payload, cards } = await openCards();
    const existing = cards.find((c) => c?.id === id && c?.state === "open");
    const created = existing?.created ?? ts;
    const card = buildBlockerCard({
      id,
      sourceKind,
      sourceId,
      sessionID,
      title,
      body,
      refs,
      pendingSince,
      created,
    });
    if (existing) {
      const idx = cards.indexOf(existing);
      cards[idx] = { ...existing, ...card, created, updatedAt: ts };
    } else {
      cards.push(card);
    }
    await cardStore.save({ ...payload, cards });
    await ledgerAppend({
      kind: CARD_CREATED,
      cardId: id,
      variant: "blocker",
      sourceKind,
      sourceId,
      sessionID,
      refs: card.refs,
    });
    return { changed: true, isNew: !existing };
  }

  // Resolve one open card by id → `resolved` state + a card.resolved ACTIVITY
  // entry (never a verdict), and move it out of cards.json into the ledger.
  async function resolveById(id, { reason, ts = now() } = {}) {
    const { payload, cards } = await openCards();
    const idx = cards.findIndex((c) => c?.id === id && c?.state === "open");
    if (idx < 0) return { changed: false };
    const [card] = cards.splice(idx, 1);
    await cardStore.save({ ...payload, cards });
    await ledgerAppend({
      kind: CARD_RESOLVED,
      cardId: id,
      variant: card.variant,
      sourceKind: card.sourceKind,
      refs: card.refs,
      sessionID: card.sessionID,
      reason,
    });
    return { changed: true, card: { ...card, state: "resolved", resolvedAt: ts, resolvedReason: reason } };
  }

  // Register a worker is now blocked on an ask. No card yet — the card appears
  // only once promoteDue sees the ask past BLOCKER_AFTER_MS (or via a health
  // escalation). Re-registration (global + scoped duplicate) is a no-op upsert.
  async function onAskStart({ sourceKind, sourceId, sessionID, body, ts = now() }) {
    if (!sessionID) return;
    pendingAsks.set(sessionID, { sourceKind, sourceId, sessionID, body, askedAt: ts });
  }

  // The ask was answered/rejected, or the owning session aborted → liveness
  // predicate false: resolve any open blocker card for that session.
  async function onAskResolved({ sessionID, ts = now() } = {}) {
    if (!sessionID) return { changed: false };
    pendingAsks.delete(sessionID);
    return resolveForSession(sessionID, "ask answered", ts);
  }

  async function resolveForSession(sessionID, reason, ts) {
    const { cards } = await openCards();
    const open = cards.filter((c) => c?.state === "open" && c?.variant === "blocker" && c?.sessionID === sessionID);
    let changed = false;
    for (const card of open) {
      changed = (await resolveById(card.id, { reason, ts })).changed || changed;
    }
    return { changed };
  }

  // The 10-min card timer: promote every in-flight ask past BLOCKER_AFTER_MS
  // into its blocker card. `{changed, promoted}` for diagnostics/tests.
  async function promoteDue({ nowMs = now() } = {}) {
    let changed = false;
    let promoted = 0;
    for (const ask of pendingAsks.values()) {
      if (nowMs - ask.askedAt < BLOCKER_AFTER_MS) continue;
      const r = await upsertBlocker({
        sourceKind: ask.sourceKind,
        sourceId: ask.sourceId,
        sessionID: ask.sessionID,
        title: blockerTitle(ask.sourceKind),
        body: blockerBody(ask.sourceKind, ask.body),
        refs: ask.sessionID ? [ask.sessionID] : [],
        ts: nowMs,
        pendingSince: ask.askedAt,
      });
      changed = changed || r.changed;
      if (r.isNew) promoted += 1;
    }
    return { changed, promoted };
  }

  // Source (2): read the watchdog's blocker-card requests that A2 already
  // writes to engine-state.json `pendingBlockers` and turn the unresolved ones
  // into health blocker cards. `{changed}` for tests/diagnostics.
  async function ingestHealthEscalations({ ts = now() } = {}) {
    let payload;
    try {
      payload = await engineState.load();
    } catch {
      return { changed: false };
    }
    const pending = Array.isArray(payload?.pendingBlockers) ? payload.pendingBlockers : [];
    let changed = false;
    for (const b of pending) {
      if (b?.resolved === true) continue;
      const r = await upsertBlocker({
        sourceKind: HEALTH_SOURCE_KIND,
        sourceId: b.id,
        sessionID: undefined,
        title: blockerTitle(HEALTH_SOURCE_KIND),
        body: blockerBody(HEALTH_SOURCE_KIND, b?.reason),
        refs: [],
        ts,
        pendingSince: typeof b?.ts === "number" ? b.ts : ts,
      });
      changed = changed || r.changed;
    }
    return { changed };
  }

  // Health recovered (e.g. the user resumed the engine) → resolve every open
  // health card. `{changed}` for diagnostics/tests.
  async function onHealthRecovered({ ts = now() } = {}) {
    const { cards } = await openCards();
    const open = cards.filter((c) => c?.state === "open" && c?.sourceKind === HEALTH_SOURCE_KIND);
    let changed = false;
    for (const card of open) {
      changed = (await resolveById(card.id, { reason: "health recovered", ts })).changed || changed;
    }
    return { changed };
  }

  // Explicit user dismissal → same ledger discipline as resolution, but the
  // state is `dismissed` (a user choice, distinct from self-resolution).
  async function dismissById(id, { reason, ts = now() } = {}) {
    const { payload, cards } = await openCards();
    const idx = cards.findIndex((c) => c?.id === id && c?.state === "open");
    if (idx < 0) return { changed: false };
    const [card] = cards.splice(idx, 1);
    await cardStore.save({ ...payload, cards });
    await ledgerAppend({
      kind: CARD_DISMISSED,
      cardId: id,
      variant: card.variant,
      sourceKind: card.sourceKind,
      refs: card.refs,
      sessionID: card.sessionID,
      reason,
    });
    return { changed: true, card: { ...card, state: "dismissed", dismissedAt: ts, dismissedReason: reason } };
  }

  // needs-you surface: only open cards count (§10.3 — resolved/dismissed cards
  // left cards.json for the ledger).
  async function countOpen() {
    try {
      const { cards } = await openCards();
      return cards.filter((c) => c && c.state === "open").length;
    } catch {
      return 0;
    }
  }

  async function listOpen() {
    const { cards } = await openCards();
    return cards.filter((c) => c && c.state === "open");
  }

  return {
    onAskStart,
    onAskResolved,
    promoteDue,
    ingestHealthEscalations,
    onHealthRecovered,
    resolveById,
    dismissById,
    countOpen,
    listOpen,
  };
}
