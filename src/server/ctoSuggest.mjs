// src/server/ctoSuggest.mjs
// BET-1392 — the suggestion-engine finding COLLECTOR (spec §9.1) + the §14.3
// silence audit. BET-1520: the bespoke surface path is retired — findings no
// longer generate candidates, worthiness scores, or decision cards here.
//
// Responsibilities:
//   - Collectors: high-salience findings from the P2 evidence sources —
//     digest-detected failure recurrences, fact anomalies, and watcher hits
//     (BET-1398). Each collector returns a stable, content-derived `id`.
//   - Enqueue (BET-1520): every collected finding is normalized into the
//     pending-findings row shape (findingFromSuggestion in ctoCards.mjs) and
//     queued through the injected `queueFinding` seam — the SAME producer
//     queue inbox notes, promoted asks and health escalations ride. The
//     engine's ONE pipeline takes over from there: drain → triage (§9.2,
//     0–3 plans; MAY output none) → gate (§9.3 act/ask) → executor (§9.4/§9.5).
//     The old in-module path — the suggest generator, worthiness probability,
//     per-class salience floors, the verb decision, bound-action execution
//     and direct decision-card emission — is deleted: the §9.2 triage call
//     IS the "0–3 plans or none" step and the §9.3 gate's ask card is the
//     only card surface. A plan-less finding is silent-logged by the gate
//     (`suggest.silent`), so the §14.3 audit still counts the holds.
//   - Dedupe (BET-1465, kept): a finding recurs on every pass for as long as
//     its source digest/fact stays in the retained window (up to 30 digests);
//     `es.suggest.usedKeys` marks findings already enqueued so the SAME
//     finding does not re-pay a triage model call every pass. Keys are the
//     collectors' content ids, bound at 200, persisted via patchEngineState.
//   - Silence audit (§14.3): silent-log rows are re-readable; a held item
//     takes a verdict (accept → the fact/going-forward branch, dismiss → the
//     rejection counter) through the B3 verdict route.
//
// Pure logic + injected I/O in the style of ctoDigest.mjs / ctoEngine.mjs —
// no live tmux/opencode/network in tests. The store, ledger and queue seams
// are all injectable (`queueFinding`, `ledger`, `engineState`, `digests`,
// `facts`, `now`, `publish`).

import { createHash } from "node:crypto";
import {
  ledgerStore,
  engineStateStore,
  patchEngineState,
  digestsStore,
  factsStore,
} from "./ctoStores.mjs";
import { collectWatcherHitsFromLedger } from "./ctoWatchers.mjs";
import { findingFromSuggestion } from "./ctoCards.mjs";

// BET-1465: bound `es.suggest.usedKeys` so it cannot become the next
// unbounded engine-state store — the `ctoStores.mjs` sweep does not cover
// engine-state. Plain trailing slice — unlike `ctoBudget.mjs`'s ROI pending
// cap (BET-1487), these keys carry no counted-fingerprint semantics, so a
// blind bound is safe here.
const USED_KEYS_CAP = 200;

// ---------------------------------------------------------------------------
// P2 findings sources — digest-detected recurrences + fact anomalies
// + watcher hits (BET-1398).
// ---------------------------------------------------------------------------

// A failure-tier digest item that recurs across digests is a high-salience
// finding (steep decay → historically earned the notify variant; the notify
// delivery rides the §9.3 ask card since BET-1520).
export function collectFailuresFromDigests(digests, { minRecurrence = 2 } = {}) {
  const groups = new Map();
  for (const d of digests || []) {
    for (const it of d?.items || []) {
      if (it?.tier !== "failure") continue;
      const text = typeof it?.text === "string" ? it.text.trim() : "";
      if (!text) continue;
      const g = groups.get(text) || { text, refs: new Set(), seen: 0 };
      g.seen += 1;
      for (const r of it.refs || []) if (typeof r === "string") g.refs.add(r);
      groups.set(text, g);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.seen < minRecurrence) continue;
    out.push({
      id: "rec:" + sha(g.text),
      sourceKind: "failure-recurrence",
      text: g.text,
      refs: [...g.refs].sort(),
    });
  }
  return out;
}

// Fact anomalies: `anomaly`-kind facts, active facts below the confidence
// floor, and recently superseded facts — each a high-salience finding.
export function collectAnomaliesFromFacts(facts, { lowConfidence = 0.4, overturnDays = 14, nowMs = Date.now() } = {}) {
  const out = [];
  const cutoff = nowMs - overturnDays * 24 * 3_600_000;
  for (const f of facts || []) {
    if (!f || typeof f.statement !== "string" || !f.statement.trim()) continue;
    let reason = null;
    if (f.kind === "anomaly") reason = "anomaly-kind fact";
    else if (typeof f.confidence === "number" && f.confidence < lowConfidence && !f.superseded_by) reason = `low-confidence fact (${f.confidence})`;
    else if (f.superseded_by && typeof f.updated === "number" && f.updated >= cutoff) reason = "recently superseded fact";
    if (!reason) continue;
    out.push({
      id: "anom:" + sha(`${f.id ?? ""}|${f.statement}`),
      sourceKind: "fact-anomaly",
      text: f.statement,
      reason,
      refs: Array.isArray(f.refs) ? f.refs : [],
    });
  }
  return out;
}

export function collectFindings(digests = [], facts = [], opts = {}) {
  return [
    ...collectFailuresFromDigests(digests, opts),
    ...collectAnomaliesFromFacts(facts, opts),
    // BET-1398 watcher hits as a candidate source: high-salience `watcher.hit`
    // evidence rows. `sourceKind` is `watcher-hit`, or `watcher-hit-rate` for
    // a rate-threshold watcher (a burst-trip is a steep signal).
    ...collectWatcherHitsFromLedger(opts?.ledgerRows),
  ];
}

// Stable, collision-resistant candidate id: regeneration of the same
// (findingId, class) yields the same id → the card upserts, never duplicates.
// Used by the §9.2 plan id (ctoTriage) since BET-1517.
export function stableSuggestionId(findingId, cls) {
  return createHash("sha256")
    .update(`${String(findingId)}\u0000${String(cls)}`)
    .digest("hex")
    .slice(0, 24);
}

// The pure `sha` used for finding ids derived from digest/fact signals
// (collectors above) and finding ids derived from queue rows (ctoTriage).
export function sha(input) {
  return createHash("sha256").update(String(input)).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// The finding-collector engine — injected store/ledger/queue/now.
// ---------------------------------------------------------------------------

export function createCtoSuggest(deps = {}) {
  const {
    now = () => Date.now(),
    publish = () => {},
    ledger = ledgerStore,
    engineState = engineStateStore,
    digests = digestsStore,
    facts = factsStore,
    // BET-1520: the pending-findings queue writer — the engine's `queueFinding`
    // seam (index.mjs wires it to the SAME queue the cards funnel uses).
    // null → findings are collected but never queued, and are never marked
    // used, so the first wired pass picks them up.
    queueFinding = null,
    recordVerdict = null, // async ({subject, verdict, never}) => {ok} — B3 verdict route
  } = deps;

  async function loadState() {
    let es = {};
    try {
      es = (await engineState.load()) || {};
    } catch {
      es = {};
    }
    const st = (es.suggest && typeof es.suggest === "object") ? es.suggest : {};
    const used = Array.isArray(st.usedKeys) ? st.usedKeys : [];
    return { es, st, used };
  }

  // BET-1465 (defect 1): persist processed keys into `es.suggest.usedKeys` via
  // the same per-key read-modify-write path every other engine-state writer
  // uses (`patchEngineState`) — a snapshot-spread save here would silently
  // revert whatever another writer (trust migration, …) committed to
  // `es.suggest` between our load and save. Best-effort: a failed write means
  // the dedupe misses next pass, not that this pass's work is lost.
  async function markUsed(keys) {
    const fresh = [...new Set((keys || []).filter((k) => typeof k === "string" && k))];
    if (!fresh.length) return;
    try {
      await patchEngineState((freshState) => {
        const st = (freshState?.suggest && typeof freshState.suggest === "object") ? freshState.suggest : {};
        const prior = Array.isArray(st.usedKeys) ? st.usedKeys : [];
        return { suggest: { ...st, usedKeys: [...prior, ...fresh].slice(-USED_KEYS_CAP) } };
      }, { engineState });
    } catch {
      /* best-effort */
    }
  }

  async function loadDigests({ count = 30 } = {}) {
    try {
      const names = await digests.list?.() ?? [];
      const out = [];
      for (const name of names) {
        const id = String(name).endsWith(".json") ? String(name).slice(0, -5) : String(name);
        let d;
        try {
          d = await digests.load(id);
        } catch {
          continue;
        }
        if (d && Array.isArray(d.items)) out.push(d);
      }
      return out.sort((a, b) => (b?.generated ?? 0) - (a?.generated ?? 0)).slice(0, count);
    } catch {
      return [];
    }
  }

  // BET-1398: the raw A1 ledger rows so the watcher-hit candidate source can
  // be collected from them. Best-effort — an unreadable ledger yields [].
  async function loadLedgerRows() {
    try {
      return (await ledger.read()) ?? [];
    } catch {
      return [];
    }
  }

  async function loadFacts() {
    const out = [];
    try {
      const names = await facts.list?.() ?? [];
      for (const name of names) {
        const id = String(name).endsWith(".json") ? String(name).slice(0, -5) : String(name);
        let p;
        try {
          p = await facts.load(id);
        } catch {
          continue;
        }
        for (const f of Array.isArray(p?.facts) ? p.facts : []) out.push(f);
      }
    } catch {
      /* best-effort */
    }
    return out;
  }

  // The full pass: collect findings from the P2 sources, dedupe against
  // usedKeys, and enqueue each fresh finding on the pending-findings queue
  // (BET-1520). Returns `{findings, enqueued}` for diagnostics/tests.
  async function runPass({ nowMs = now() } = {}) {
    const [digestsArr, factsArr, ledgerRows] = await Promise.all([loadDigests(), loadFacts(), loadLedgerRows()]);
    const findings = collectFindings(digestsArr, factsArr, { nowMs, ledgerRows });
    const { used } = await loadState();
    const usedSet = new Set(used);
    let enqueued = 0;
    const enqueuedKeys = [];
    for (const f of findings) {
      if (!f || typeof f.id !== "string" || !f.id || usedSet.has(f.id)) continue;
      const row = findingFromSuggestion(f, { ts: nowMs });
      if (!row) continue;
      if (typeof queueFinding !== "function") break;
      try {
        await queueFinding(row);
      } catch {
        // The enqueue failed — do NOT mark this finding used; the next pass
        // retries it. The rest of the findings still attempt their enqueue.
        continue;
      }
      enqueued += 1;
      enqueuedKeys.push(f.id);
    }
    // Mark used only after the enqueues that actually happened (the same
    // confirm-then-commit order the old flow used for its model calls): a
    // wrongly-consumed key loses the finding until its source leaves the
    // retained window, a missed stamp costs one redundant triage call.
    await markUsed(enqueuedKeys);
    await publish({ kind: "suggestState", payload: { findings: findings.length, enqueued, ts: nowMs } });
    return { findings: findings.length, enqueued };
  }

  // ---- §14.3 silence audit ----
  // The held (silent-log) rows the monthly digest's "I held back N items —
  // review?" aside links to. Reverse-chron, with an optional cursor. Since
  // BET-1520 the rows are written by the gate (plan-less / no-card-path
  // holds) — this stays the single read surface.
  async function listHeld({ before, limit = 100 } = {}) {
    let rows = [];
    try {
      rows = (await ledger.read()) ?? [];
    } catch {
      return [];
    }
    return rows
      .filter((r) => r?.kind === "suggest.silent")
      .filter((r) => (before == null || !(typeof r?.ts === "number" && r.ts < before)))
      .sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0))
      .slice(0, limit);
  }

  // A judgment on a held item → the B3 verdict route (§9.5). `accept` records
  // an accept verdict (calibration success); `dismiss` records a dismiss
  // (calibration failure). The held row's action class is stamped onto the
  // subject so the §9.5 calibration fold can attribute the verdict. Returns
  // {ok} — an unwired verdict route degrades (BET-1518: the old direct-store
  // fallback is deleted — a fallback-appended entry bypasses the verdict
  // sink registry, so its counter effects would never fold anywhere).
  async function verdictHeld({ id, verdict, never } = {}) {
    const sid = String(id || "");
    let cls;
    try {
      cls = (await listHeld({ limit: 500 })).find((r) => r?.id === sid)?.class;
    } catch {
      /* best-effort attribution */
    }
    const subject = { type: "suggestion", id: sid, ...(cls ? { class: cls } : {}) };
    if (typeof recordVerdict === "function") {
      const r = await recordVerdict({ subject, verdict, never });
      return { ok: r?.ok === true, error: r?.error };
    }
    return { ok: false, error: "no-verdict-route" };
  }

  return {
    runPass,
    listHeld,
    verdictHeld,
  };
}
