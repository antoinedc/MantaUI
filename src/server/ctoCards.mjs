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
// Source (3): an inbox note of kind `blocker` sent via send_to_cto (BET-1397 /
// spec §4.4). It becomes an A8 blocker-card source — the blocking-tier
// notification fires IMMEDIATELY through the existing router (the same one
// source 1 relies on), and the card appears at > 10 min via promoteDue.
export const INBOX_SOURCE_KIND = "inbox";
// Connect-ask cards (BET-1395 / §7.4): one §7.2 tool identity per card, keyed
// by the tool id.
export const CONNECT_SOURCE_KIND = "tool";
// Probe-failure blocker cards (BET-1396 / §10.6-7): an auth-shaped probe
// failure that degraded the digest. Keyed by `<tool>/<probe>`; the body
// deep-links (in copy) to the secrets surface — the fix is a rotated key.
export const PROBE_SOURCE_KIND = "probe";

// §10.6-7 probe-auth-failure card copy (3 consecutive auth failures — the
// runner's AUTH_FAIL_ESCALATE). `secretKey` is the vault KEY NAME (not a
// value) when the spec declared one — naming the exact key the user should
// update is the deep-link to the secrets surface in words. The body keeps the
// literal phrase "on the secrets surface" — the renderer's probeSecretKey
// parse anchor (ctoView.ts) — and names the REAL surface after the dash: the
// 🔑 SecretsCard in the chat session (BET-1437 deep-link target), never
// "Settings → Secrets" (that Settings section does not exist).
export function probeBlockerCopy(tool, probeName, secretKey = null) {
  const secret = secretKey
    ? ` If the key was rotated, update "${secretKey}" on the secrets surface — the 🔑 secrets card in your chat session.`
    : " Check the tool's credential on the secrets surface — the 🔑 secrets card in your chat session.";
  return {
    title: `Probe failing — ${tool} key may have been rotated`,
    body: `The "${probeName}" probe for ${tool} failed auth 3 times in a row (HTTP 401/403 or the credential is gone), so the digest's view of ${tool} is degraded.${secret}`,
  };
}

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
  if (kind === "inbox") return "Blocker flagged for CTO";
  return "Health check";
}

export function blockerBody(kind, text) {
  if (kind === "permission") return text || "Claude needs permission to run a tool.";
  if (kind === "question") return text || "Claude is waiting on an answer.";
  if (kind === "inbox") return text || "A session flagged a blocker for the CTO.";
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
    // Source (3) router (BET-1397): the existing blocking-tier notification
    // router (push.mjs fireNotify). Only `onInboxBlocker` uses it — worker-ask
    // and health cards keep the "no notification path" invariant.
    fireNotify = async () => {},
    now = () => Date.now(),
  } = deps;

  // In-flight worker asks: sessionID -> { sourceKind, sourceId, sessionID,
  // body, askedAt }. Kept in memory (derived from the live event stream); once
  // promoted, the card itself is durable in cards.json.
  const pendingAsks = new Map();

  // Source (3): a `blocker` inbox note (BET-1397 / spec §4.4). This is the ONE
  // notification path for inbox notes: fires the blocking-tier notify through
  // the injected router exactly once, and registers a pending blocker so the
  // card timer (promoteDue) promotes it at > 10 min like any ask. Read-only on
  // the inbox itself — the inbound funnel already persisted the entry.
  async function onInboxBlocker({ message, title, refs = [], tag, sessionID, ts = now() } = {}) {
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) return { changed: false, notified: false };
    // Blocking-tier notification — exactly one, via the shared router.
    try {
      await fireNotify({
        message: text,
        title: typeof title === "string" && title ? title : undefined,
        urgent: true,
        sessionID: typeof sessionID === "string" ? sessionID : undefined,
      });
    } catch (e) {
      console.warn("[cto] inbox blocker notify failed:", e?.message ?? e);
    }
    // Register a pending blocker so the card appears at > 10 min. Key by the
    // sending session when known, else by a stable hash of the tag/message;
    // the card id stays stable across re-reports of the same note (upsert).
    const sourceId = stableCardId(INBOX_SOURCE_KIND, tag || text);
    const key = typeof sessionID === "string" && sessionID ? sessionID : sourceId;
    pendingAsks.set(key, {
      sourceKind: INBOX_SOURCE_KIND,
      sourceId,
      sessionID: typeof sessionID === "string" ? sessionID : undefined,
      body: text,
      refs: Array.isArray(refs) ? refs : [],
      askedAt: ts,
    });
    return { changed: true, notified: true };
  }

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

  // Shared close-path for resolve/dismiss: remove one open card by id, save,
  // and write the ledger row with the close kind (resolved vs dismissed).
  async function closeOpenCard(id, kind, reason, ts = now()) {
    const { payload, cards } = await openCards();
    const idx = cards.findIndex((c) => c?.id === id && c?.state === "open");
    if (idx < 0) return { changed: false };
    const [card] = cards.splice(idx, 1);
    await cardStore.save({ ...payload, cards });
    await ledgerAppend({
      kind,
      cardId: id,
      variant: card.variant,
      sourceKind: card.sourceKind,
      refs: card.refs,
      sessionID: card.sessionID,
      reason,
    });
    return { changed: true, card };
  }

  // Resolve one open card by id → `resolved` state + a card.resolved ACTIVITY
  // entry (never a verdict), and move it out of cards.json into the ledger.
  async function resolveById(id, { reason, ts = now() } = {}) {
    const r = await closeOpenCard(id, CARD_RESOLVED, reason, ts);
    if (!r.changed) return r;
    return { changed: true, card: { ...r.card, state: "resolved", resolvedAt: ts, resolvedReason: reason } };
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
        refs: Array.isArray(ask.refs) && ask.refs.length ? ask.refs : ask.sessionID ? [ask.sessionID] : [],
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
    const r = await closeOpenCard(id, CARD_DISMISSED, reason, ts);
    if (!r.changed) return r;
    return { changed: true, card: { ...r.card, state: "dismissed", dismissedAt: ts, dismissedReason: reason } };
  }

  // Decision-card writer (BET-1392 / §9.1 decision cards, §10.3). Upserts by
  // the candidate's stable id (hash(findingId, class)) — a regeneration
  // updates the existing open card in place (title/why/options/evidence
  // refresh; created + carried-forward open-verdict count preserved), never
  // duplicates. Option `action` types use the closed ACTION_TYPES enum; RPC is
  // deliberately out of scope for the server — option execution is the
  // renderer's job (§9.1 "option buttons execute a bound action").
  async function upsertDecision({ id, title, why, options = [], refs = [], evidence = [], sourceKind, cls, score, capped = false, ts = now() } = {}) {
    if (!id || typeof id !== "string") return { changed: false, isNew: false };
    return upsertOpenCard({
      id,
      variant: "decision",
      sourceKind,
      ts,
      ledger: { cls, score: typeof score === "number" ? score : undefined },
      build: ({ existing }) => ({
        title: typeof title === "string" && title ? title : "CTO suggestion",
        why: typeof why === "string" && why ? why : title ?? "",
        refs: Array.isArray(refs) ? refs : [],
        evidence: Array.isArray(evidence) && evidence.length ? evidence : Array.isArray(refs) ? refs : [],
        options: Array.isArray(options) ? options : [],
        cls,
        score: typeof score === "number" ? score : undefined,
        capped: capped === true,
        // openness count carried forward on regeneration (§9.1 never-dup).
        openCount: existing?.openCount ?? 0,
      }),
    });
  }

  // Shared card-writer core: ONE load/find/merge-or-push/save/ledger path
  // for every variant writer (decision/veto/connect). `build` returns the
  // variant-specific fields given { existing, created, ts }; the helper adds
  // the identity/lifecycle envelope, upserts by stable id (regeneration
  // updates in place, never dups), saves, and writes the CARD_CREATED row.
  async function upsertOpenCard({ id, variant, sourceKind = null, sourceId = null, ts = now(), ledger = {}, build }) {
    const { payload, cards: list } = await openCards();
    const existing = list.find((c) => c?.id === id && c?.state === "open");
    const created = existing?.created ?? ts;
    const card = {
      ...build({ existing, created, ts }),
      id,
      variant,
      sourceKind,
      sourceId,
      created,
      updatedAt: ts,
      state: "open",
    };
    if (existing) {
      const idx = list.indexOf(existing);
      list[idx] = { ...existing, ...card, created, updatedAt: ts };
    } else {
      list.push(card);
    }
    await cardStore.save({ ...payload, cards: list });
    await ledgerAppend({
      kind: CARD_CREATED,
      cardId: id,
      variant,
      sourceKind,
      sourceId,
      refs: card.refs,
      ...ledger,
    });
    return { changed: true, isNew: !existing };
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

  // BET-1419 (§9.2/§10.3): the veto-window card — announce tonight's run 30
  // min ahead with a live countdown. One open veto card at a time (the
  // overnight countdown is unique per window): re-arming upserts by id so the
  // countdown updates in place, never dups. `dueMs` is the open the countdown
  // points at; the engine resolves the card when the window opens (fulfilled),
  // cancels it (veto verdict) or abandons it (missed, §11.6).
  async function upsertVeto({ id, title, body, dueMs, options = [], refs = [], ts = now() } = {}) {
    if (!id || typeof id !== "string") return { changed: false, isNew: false };
    return upsertOpenCard({
      id,
      variant: "veto",
      sourceKind: "overnight",
      sourceId: null,
      ts,
      ledger: { dueMs: Number.isFinite(dueMs) ? dueMs : null },
      build: ({ existing }) => ({
        title: typeof title === "string" && title ? title : "Overnight run planned",
        body: typeof body === "string" && body ? body : "",
        dueMs: Number.isFinite(dueMs) ? dueMs : null,
        options: Array.isArray(options) ? options : [],
        sessionID: null,
        pendingSince: existing?.pendingSince ?? ts,
        refs: Array.isArray(refs) ? refs : [],
      }),
    });
  }

  // Connect-ask card writer (BET-1395 / §7.4 one connect ask, §10.3
  // connect-ask variant). Upserts by the tool's stable id — re-raising the
  // same tool's ask (re-arm path) updates the card in place, never dups.
  // The three-way answer is bound at generation time to the tool identity;
  // resolution runs through the registry (POST /api/cto/tools/connect),
  // which writes the consent ring + the §9.5 verdict and calls
  // resolveConnectCards. No notification path — like decision cards, this is
  // a resting needs-you surface.
  async function upsertConnect({ toolId, title, body, evidence = [], refs = [], ring = "metadata", ts = now() } = {}) {
    if (!toolId || typeof toolId !== "string") return { changed: false, isNew: false };
    const deep = ring === "deep_read";
    const sourceId = deep ? `${toolId}:deep` : toolId;
    return upsertOpenCard({
      id: stableCardId(CONNECT_SOURCE_KIND, sourceId),
      variant: "connect",
      sourceKind: CONNECT_SOURCE_KIND,
      sourceId,
      ts,
      build: () => ({
        title: typeof title === "string" && title ? title : `Connect ${toolId} (read-only)?`,
        body: typeof body === "string" ? body : "",
        evidence: Array.isArray(evidence) ? evidence : [],
        options: [
          { label: "Connect read-only", answer: "connect" },
          { label: "Not now", answer: "not-now" },
          { label: "Never for this tool", answer: "never" },
        ].map((o) => ({
          ...o,
          action: { type: "tool-connect", payload: { tool: toolId, answer: o.answer, ring } },
        })),
        refs: Array.isArray(refs) && refs.length ? refs : [toolId],
        sessionID: null,
      }),
    });
  }

  // Resolve every open connect-ask card for one tool (the registry's
  // three-way answer is the resolution predicate's only false-path). Returns
  // `{changed}` for tests/diagnostics.
  async function resolveConnectCards(toolId, reason, ts = now()) {
    const { payload, cards: list } = await openCards();
    const open = list.filter(
      (c) => c?.state === "open" && c?.variant === "connect" && (c?.sourceId === toolId || c?.refs?.includes(toolId)),
    );
    let changed = false;
    for (const card of open) {
      const idx = list.indexOf(card);
      list.splice(idx, 1);
      await ledgerAppend({
        kind: CARD_RESOLVED,
        cardId: card.id,
        variant: card.variant,
        sourceKind: card.sourceKind,
        sourceId: card.sourceId,
        refs: card.refs,
        reason,
      });
      changed = true;
    }
    if (changed) await cardStore.save({ ...payload, cards: list });
    return { changed };
  }

  async function listOpen() {
    const { cards } = await openCards();
    return cards.filter((c) => c && c.state === "open");
  }

  return {
    onAskStart,
    onAskResolved,
    onInboxBlocker,
    promoteDue,
    ingestHealthEscalations,
    onHealthRecovered,
    resolveById,
    dismissById,
    upsertDecision,
    upsertVeto,
    upsertConnect,
    resolveConnectCards,
    countOpen,
    listOpen,
  };
}
