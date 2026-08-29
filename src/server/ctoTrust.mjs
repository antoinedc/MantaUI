// src/server/ctoTrust.mjs
// BET-1403 — Earned-trust promotion ladder + act-and-report bookkeeping
// (spec §9.2 verbs, §9.3 reversibility eligibility, §9.4 promotion math).
//
// Responsibilities:
//   - `eligibilityOf` — the §9.3 class → reversibility map. Only read-only,
//     worktree-isolated, or trivially-reversible classes may climb past the
//     ask verb; anything touching user session, protected refs, production,
//     money, config, or secrets is capped at ask permanently. Unknown class
//     = capped (fail-closed).
//   - `evaluateTier` — the §9.4 ladder math for one class: promotion on the
//     Beta tail bar (P(acceptance > 0.9) > 0.95 with ≥ 8 observations, via
//     B3's `betaTailAbove`), demotion on any 2 rejections in a rolling 10,
//     the §10.6-4 global cold-start gate dominating every promotion.
//   - `createCtoTrust` — the stateful engine over its OWN store file
//     (`trust.json` via ctoStores): per-class tiers + Beta counters + rolling
//     outcome window, the B3 verdict-sink target (`noteVerdictEffects`), the
//     veto-window record (`noteVetoOutcome`), and the act-and-report ledger +
//     digest announcement queue (`recordAct` / `listAnnouncements` /
//     `markAnnounced`). Tier changes and acts are ledgered (A1 rows) AND
//     queued as pending progress asides for the next digest (§9.4). A legacy
//     `es.trust` payload is migrated once on first load (review cycle 4:
//     shared-file writers could revert trust keys — trust now lives where no
//     snapshot-spreading writer can reach it).
//
// Pure over injected stores + a now() clock — testable without a live box.

import { betaTailAbove } from "./ctoVerdicts.mjs";
import { appendLedgerBestEffort, engineStateStore, ledgerStore, trustStore, verdictsStore } from "./ctoStores.mjs";

// The §3.5 ladder rungs, lowest → highest. `ask` covers the ask verbs
// (silent-log / inbox card / notify — ctoSuggest picks within the rung);
// `veto-window` and `act` are the promoted verbs of §9.2.
export const TIER_ASK = "ask";
export const TIER_VETO_WINDOW = "veto-window";
export const TIER_ACT = "act";
export const TIERS = Object.freeze([TIER_ASK, TIER_VETO_WINDOW, TIER_ACT]);

// §9.4 promotion bar — P(acceptance > 0.9) > 0.95 with ≥ 8 observations.
export const PROMOTE_MIN_OBS = 8;
export const PROMOTE_TAIL_P = 0.9;
export const PROMOTE_TAIL_CONF = 0.95;

// §9.4 demotion rule — any 2 rejections in a rolling 10 → one step down.
export const REJECT_WINDOW = 10;
export const REJECT_DEMOTE = 2;

// §10.6-4 cold-start gate: no class leaves ask verbs before the global
// verdict ledger holds at least this many verdicts. Moved here from
// ctoSuggest (which re-exports it) so the gate has one owner.
export const VERDICT_MIN = 15;

// §9.3 reversibility eligibility map (normative per class; unknown = capped).
//  - record-decision: a fact on the CTO's own blackboard — trivially
//    reversible (a later fact supersedes it).
//  - queue-tonight: a planning-only queue entry — trivially reversible
//    (removed from the queue; nothing ran).
//  - start-job: delegate work — worktree-isolated by construction (own git
//    worktree + branch; never touches the user's checkout).
//  - config-change: touches config → §9.3 says capped at ask permanently.
//  - tool-write: writes external tool state — not read-only, not isolated,
//    not reversible → capped.
export const ELIGIBILITY = Object.freeze({
  "record-decision": "eligible",
  "queue-tonight": "eligible",
  "start-job": "eligible",
  "config-change": "ask-capped",
  "tool-write": "ask-capped",
});

export function eligibilityOf(cls) {
  return ELIGIBILITY[cls] === "eligible" ? "eligible" : "ask-capped";
}

// The §9.4 tail gate for one Beta record: ≥ 8 observations AND
// P(mean > 0.9) ≥ 0.95. A degenerate Beta (all successes, b = 0) never
// passes — the estimator refuses zero-variance records on purpose.
export function betaPasses(a, b) {
  const n = (a || 0) + (b || 0);
  return n >= PROMOTE_MIN_OBS && betaTailAbove(a, b, PROMOTE_TAIL_P, PROMOTE_TAIL_CONF);
}

// The §9.4 ladder evaluation for ONE class. Pure: reads the tier + the
// per-tier Beta records + the rolling outcome window; returns the target
// tier. Demotion is evaluated first (rejection pressure is the newer
// signal — never promote a class whose recent record is bleeding). A
// demotion consumes the rolling window (the caller resets it on change), so
// the same evidence cannot re-demote forever.
export function evaluateTier({
  tier = TIER_ASK,
  eligible = false,
  coldStart = false,
  ask = {},
  veto = {},
  recent = [],
} = {}) {
  const t = TIERS.includes(tier) ? tier : TIER_ASK;
  if (!eligible) return { tier: t, changed: false };
  const rejects = recent.filter((r) => r && r.ok === false).length;
  if (rejects >= REJECT_DEMOTE) {
    const to = TIERS[Math.max(0, TIERS.indexOf(t) - 1)];
    return { tier: to, changed: to !== t, reason: "demote-rolling-rejects" };
  }
  if (t === TIER_ASK && coldStart) return { tier: t, changed: false };
  if (t === TIER_ASK && betaPasses(ask.a, ask.b)) {
    return { tier: TIER_VETO_WINDOW, changed: true, reason: "promote-ask-tail" };
  }
  if (t === TIER_VETO_WINDOW && betaPasses(veto.va, veto.vb)) {
    return { tier: TIER_ACT, changed: true, reason: "promote-veto-tail" };
  }
  return { tier: t, changed: false };
}

function announcementText(cls, from, to, reason) {
  const n = `${reason}`.startsWith("demote")
    ? `${REJECT_DEMOTE} rejections in the last ${REJECT_WINDOW} judgments`
    : `acceptance tail cleared (${PROMOTE_MIN_OBS}+ observations)`;
  return from === TIER_ASK
    ? `Trust promoted: the "${cls}" class may now use the ${to} verb (${n}).`
    : `Trust demoted: the "${cls}" class stepped back to ${to} (${n}).`;
}

function actReportText(cls, text) {
  return `Acted on my own (${cls}): ${text}`;
}

// ---------------------------------------------------------------------------
// The trust engine
// ---------------------------------------------------------------------------

export function createCtoTrust(deps = {}) {
  const {
    store = trustStore, // the trust ladder's own file — no other writer touches it
    legacy = engineStateStore, // one-time migration source: the old `es.trust` payload
    ledger = ledgerStore,
    verdicts = verdictsStore,
    now = () => Date.now(),
  } = deps;

  const PENDING_CAP = 50;

  function blankStats() {
    return { a: 0, b: 0, va: 0, vb: 0, recent: [] };
  }

  async function ledgerAppend(entry) {
    return appendLedgerBestEffort(ledger, now(), entry);
  }

  async function loadState() {
    let st = null;
    try {
      st = (await store.load()) ?? null;
    } catch {
      st = null;
    }
    // One-time migration (review cycle 4): trust used to live under the
    // shared engine-state file's `trust` key. If the dedicated store is
    // still fresh and a legacy payload exists, adopt it — after the first
    // write the dedicated store is authoritative and `es.trust` becomes a
    // harmless fossil no reader consults. Idempotent: the store being
    // non-empty short-circuits the legacy read entirely.
    if (!st || typeof st !== "object" || (!st.v && !st.tiers && !st.stats && !st.pending)) {
      let es = {};
      try {
        es = (await legacy?.load?.()) ?? {};
      } catch {
        es = {};
      }
      if (es.trust && typeof es.trust === "object" && (es.trust.tiers || es.trust.stats || es.trust.pending)) {
        st = es.trust;
        await store.save(st).catch(() => {});
      } else {
        st = {};
      }
    }
    return {
      st,
      tiers: (st.tiers && typeof st.tiers === "object") ? st.tiers : {},
      stats: (st.stats && typeof st.stats === "object") ? st.stats : {},
      pending: Array.isArray(st.pending) ? st.pending : [],
    };
  }

  async function saveState(_snapshot, st) {
    // Trust persists to its OWN file — the durability invariant (review
    // cycle 4): no engine-state writer shape (snapshot-spread or otherwise)
    // can revert tiers/counters/pending, because no engine-state writer
    // touches this file. Callers pass a legacy snapshot for compatibility;
    // it is never spread. `v` stamps the payload so a later load treats the
    // store as authoritative even when it only holds the pending queue.
    try {
      await store.save({ ...(st ?? {}), v: st?.v ?? 1 });
    } catch {
      /* best-effort */
    }
  }

  async function countVerdicts() {
    try {
      const payload = await verdicts.load();
      return Array.isArray(payload?.entries) ? payload.entries.length : 0;
    } catch {
      return 0;
    }
  }

  // READ path for verb selection (§9.4): the class's current tier, gated by
  // the §10.6-4 cold-start dominance — while the global verdict ledger is
  // under VERDICT_MIN, every class reads as ask regardless of its counters.
  async function consult(cls, { coldStart = false } = {}) {
    const { tiers } = await loadState();
    const tier = TIERS.includes(tiers?.[cls]) ? tiers[cls] : TIER_ASK;
    const eligible = eligibilityOf(cls) === "eligible";
    return {
      tier: coldStart ? TIER_ASK : tier,
      eligible,
      capped: coldStart && tier !== TIER_ASK,
    };
  }

  // Apply one outcome for a class: bump the Beta counter the outcome feeds,
  // push the rolling window, re-evaluate the tier; ledger + announce a change.
  // `field` is which Beta counter the outcome feeds — "a"/"b" for the ask
  // record, "va"/"vb" for the veto-window record. `countRecent` keeps a
  // non-counter outcome (e.g. a veto cancel when already at act) in the
  // rolling window without touching either Beta.
  async function applyOutcome(cls, { field = null, ok }) {
    const { st, tiers, stats, pending } = await loadState();
    const tier0 = TIERS.includes(tiers[cls]) ? tiers[cls] : TIER_ASK;
    const s = stats[cls] && typeof stats[cls] === "object" ? { ...blankStats(), ...stats[cls] } : blankStats();
    if (field) s[field] = (s[field] || 0) + 1;
    s.recent = [...(Array.isArray(s.recent) ? s.recent : []), { ok: ok === true, ts: now() }].slice(-REJECT_WINDOW);

    const eligible = eligibilityOf(cls) === "eligible";
    const coldStart = (await countVerdicts()) < VERDICT_MIN;
    const ev = evaluateTier({
      tier: tier0,
      eligible,
      coldStart,
      ask: { a: s.a, b: s.b },
      veto: { va: s.va, vb: s.vb },
      recent: s.recent,
    });

    let nextPending = pending.slice();
    if (ev.changed) {
      tiers[cls] = ev.tier;
      s.recent = []; // the rolling window is consumed by the transition
      // Ladder direction by RUNG order (never lexical — "act" < "veto-window"
      // as strings), so an act promotion is never mislabeled a demotion.
      const promoted = TIERS.indexOf(ev.tier) > TIERS.indexOf(tier0);
      nextPending.push({
        id: `trust-${now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: now(),
        kind: promoted ? "promoted" : "demoted",
        text: announcementText(cls, tier0, ev.tier, ev.reason),
        refs: [],
      });
      await ledgerAppend({
        kind: promoted ? "trust.promoted" : "trust.demoted",
        cls,
        from: tier0,
        to: ev.tier,
        reason: ev.reason,
      });
    }
    stats[cls] = s;
    await saveState(null, { ...st, tiers, stats, pending: nextPending.slice(-PENDING_CAP) });
    return { tier: ev.tier, changed: ev.changed === true };
  }

  // The B3 verdict-sink target (§9.5). Only suggestion verdicts attributed
  // with an action class feed trust counters. A `veto` verdict IS the
  // veto-window record (a cancelled window, §9.5 table) — it feeds the
  // veto-tier Beta, never the ask Beta. open/expire/access/decay outcomes
  // never enter acceptance counters (§9.5 mapping is normative).
  async function noteVerdictEffects(effects, entry) {
    if (entry?.subject?.type !== "suggestion") return { changed: false };
    const cls = entry?.subject?.class;
    if (!cls || typeof cls !== "string") return { changed: false };
    if (entry?.verdict === "veto") {
      return applyOutcome(cls, { field: "vb", ok: false });
    }
    if (effects?.success) return applyOutcome(cls, { field: "a", ok: true });
    if (effects?.rejection) return applyOutcome(cls, { field: "b", ok: false });
    return { changed: false };
  }

  // The veto-window record (§9.4): a window that elapsed and executed is an
  // acceptance; a cancel is a rejection. The veto-window verb machinery
  // (BET-1419's card flow) calls this when a window resolves — either way.
  async function noteVetoOutcome(cls, { accepted = false } = {}) {
    if (!cls || typeof cls !== "string") return { changed: false };
    return applyOutcome(cls, accepted ? { field: "va", ok: true } : { field: "vb", ok: false });
  }

  // act-and-report bookkeeping (§9.2): the execution is ledgered AND queued
  // as a pending digest announcement — the mandatory report (spec §9.2
  // invariant 1: an act must appear in the next digest). No counters: an
  // act-tier execution is the top rung, not an acceptance input.
  async function recordAct({ cls, text, refs = [], action = null } = {}) {
    if (!cls || typeof cls !== "string") return { ok: false };
    const { st, pending } = await loadState();
    const t = now();
    const row = {
      id: `act-${t}-${Math.random().toString(36).slice(2, 8)}`,
      ts: t,
      kind: "act",
      cls,
      text: actReportText(cls, typeof text === "string" && text.trim() ? text.trim() : (action?.type ?? "action")),
      refs: Array.isArray(refs) ? refs.filter((r) => typeof r === "string") : [],
      actionType: action?.type ?? null,
    };
    await ledgerAppend({ kind: "trust.act", cls, text: row.text, refs: row.refs, actionType: row.actionType });
    await saveState(null, { ...st, pending: [...pending, row].slice(-PENDING_CAP) });
    return { ok: true, id: row.id };
  }

  // The digest announcement queue: pending rows (acts + tier changes), then
  // mark consumed so each appears in exactly one digest.
  async function listAnnouncements() {
    const { pending } = await loadState();
    return pending.slice();
  }

  async function markAnnounced(ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) return { removed: 0 };
    const { st, pending } = await loadState();
    const keep = pending.filter((r) => !ids.includes(r?.id));
    await saveState(null, { ...st, pending: keep });
    return { removed: pending.length - keep.length };
  }

  // Diagnostics (tests / cto panel later): tiers + counters + queue depth.
  async function getState() {
    const { tiers, stats, pending } = await loadState();
    return {
      tiers: { ...tiers },
      stats: JSON.parse(JSON.stringify(stats)),
      pending: pending.length,
      thresholds: {
        promoteMinObs: PROMOTE_MIN_OBS,
        promoteTailP: PROMOTE_TAIL_P,
        promoteTailConf: PROMOTE_TAIL_CONF,
        rejectWindow: REJECT_WINDOW,
        rejectDemote: REJECT_DEMOTE,
        verdictMin: VERDICT_MIN,
      },
    };
  }

  return {
    consult,
    noteVerdictEffects,
    noteVetoOutcome,
    recordAct,
    listAnnouncements,
    markAnnounced,
    getState,
    _applyOutcome: applyOutcome,
  };
}
