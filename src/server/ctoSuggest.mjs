// src/server/ctoSuggest.mjs
// BET-1392 — the suggestion engine (spec §9.1) + the §14.3 silence audit.
//
// Responsibilities:
//   - Candidate generator: for each high-salience finding, ONE gated `suggest`
//     model call MAY emit ≤3 candidates. Each candidate is stable-keyed
//     `id = hash(findingId, class)` (regeneration upserts the card, never
//     duplicates), carries the finding text + refs, and ≤3 options whose
//     `action` type comes from a closed enum (`ACTION_TYPES`). The generator is
//     told which verbs are reachable by data so it cannot propose what the
//     data forbids: `tool-write` only for tools holding the write ring
//     (empty ring = branch unreachable), `queue-tonight` only at High tier.
//   - Worthiness gate: a `worthiness` class call returns a 0..1 score; the
//     decision probability is `score × class prior × sender reliability`
//     (§9.1 calibration). Per-class thresholds (`p_ask`, `p_act`) live in
//     engine-state; below `p_ask` a candidate is SILENT-LOGGED (a ledger row
//     {id, score, reason}) for the §14.3 silence audit, above it a DECISION
//     card is written. The `notify` variant (informational-tier router call)
//     fires only when the finding's decay is steep — the deterministic rule
//     `sourceKind ∈ {failure-recurrence}`. `p_act` exists but NOTHING acts in
//     P2: the act branch throws if reached.
//   - Global cold-start gate: until ≥ VERDICT_MIN (15) verdicts exist, every
//     candidate is capped at the ask verbs regardless of scores ($9.1).
//   - Silence audit (§14.3): silent-log rows are re-readable; a held item
//     takes a verdict (accept → the fact/going-forward branch, dismiss → the
//     rejection counter) through the B3 verdict route.
//
// Pure logic + injected I/O in the style of ctoDigest.mjs / ctoEngine.mjs —
// no live tmux/opencode/network in tests. The model, store, card, config,
// facts and notify seams are all injectable (`runSuggest`, `runWorthiness`,
// `cards`, `ledger`, `engineState`, `verdicts`, `digests`, `facts`,
// `configGet`, `fireNotify`, `now`, `publish`).

import { createHash } from "node:crypto";
import {
  ledgerStore,
  engineStateStore,
  verdictsStore,
  digestsStore,
  factsStore,
} from "./ctoStores.mjs";
import { collectWatcherHitsFromLedger } from "./ctoWatchers.mjs";

export const SUGGEST_VERSION = 1;

// The closed enum of bound-action option types (§9.1, §10.3).
export const ACTION_TYPES = Object.freeze([
  "config-change",
  "queue-tonight",
  "start-job",
  "tool-write",
  "record-decision",
]);

// Steep-decay source kinds that earn the `notify` (informational router call)
// variant alongside the decision card. Deterministic rule, not a learned flag.
// BET-1398: a watcher whose predicate was rate-threshold carries sourceKind
// `watcher-hit-rate` and earns the notify variant (a burst-trip is a steep
// signal); a plain `watcher-hit` (event-pattern / usage-burn) does not.
export const NOTIFY_RECURRENCE_KINDS = Object.freeze(["failure-recurrence", "watcher-hit-rate"]);

// §9.2 class priors — the per-class `p(want | class)` used in worthiness
// calibration. Flat defaults; callers may override per class via config.
export const DEFAULT_CLASS_PRIORS = Object.freeze({
  "config-change": 0.5,
  "queue-tonight": 0.35,
  "start-job": 0.4,
  "tool-write": 0.3,
  "record-decision": 0.6,
});

// Cold-start: below this many verdicts every candidate is capped at ask verbs.
export const VERDICT_MIN = 15;

// §9.1 default gate thresholds (engine-state overrides).
export function defaultThresholds() {
  return { p_ask: 0.4, p_act: 0.95 };
}

// Stable, collision-resistant candidate id: regeneration of the same
// (findingId, class) yields the same id → the card upserts, never duplicates.
export function stableSuggestionId(findingId, cls) {
  return createHash("sha256")
    .update(`${String(findingId)}\u0000${String(cls)}`)
    .digest("hex")
    .slice(0, 24);
}

// The pure `sha` used for finding ids derived from digest/fact signals.
export function sha(input) {
  return createHash("sha256").update(String(input)).digest("hex").slice(0, 24);
}

// §9.1/7.4 option filtering — the generator emits from the full enum, but the
// DATA decides which branches are reachable: `tool-write` only for tools whose
// registry entry holds the `write` ring (an empty list = the branch is
// unreachable by data); `queue-tonight` only at High tier. Callers pass the
// P2 `capabilities` so the tonight-queue (P3) and tool-registry (P2-later)
// subsystems can be off while the pure rule stays faithful to the spec.
export function filterOptionsByData(options, { writeToolIds = [], tier = "low", capabilities = {} } = {}) {
  const writeRing = new Set(Array.isArray(writeToolIds) ? writeToolIds : []);
  const allowQueueTonight = capabilities.queueTonight === true && String(tier).toLowerCase() === "high";
  const allowToolWrite = capabilities.toolWrite === true;
  return (Array.isArray(options) ? options : []).filter((o) => {
    const t = o?.action?.type;
    if (t === "tool-write") {
      if (!allowToolWrite) return false;
      const tool = o.action?.payload?.tool || o.tool;
      if (!tool || !writeRing.has(tool)) return false;
    } else if (t === "queue-tonight") {
      if (!allowQueueTonight) return false;
    }
    return true;
  });
}

// §9.1 worthiness calibration: p(want|E) = nano-model score × class prior ×
// sender reliability, clamped to [0,1]. `score` is the model's 0..1 estimate.
export function worthinessProbability(score, prior = 0.5, senderReliability = 0.5) {
  const s = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  const p = Number.isFinite(prior) ? Math.max(0, prior) : 0;
  const r = Number.isFinite(senderReliability) ? Math.min(1, Math.max(0, senderReliability)) : 0;
  return Math.min(1, s * p * r);
}

// §9.1 surface-verb selection for one candidate. NOTHING acts in P2.
//   - coldStart (`verdicts < VERDICT_MIN`): capped at the ask verb regardless
//     of score — the act branch is simply never considered.
//   - p >= p_act (outside cold-start): the act branch is reached → throw
//     (the guard that nothing acts in P2; unreachable by a correct pipeline).
//   - p >= p_ask: DECISION card; `notify` true when the decay rule matches.
//   - else: SILENT-LOG (ledger row for the §14.3 audit).
export function decideVerb({
  p,
  thresholds = defaultThresholds(),
  coldStart = false,
  sourceKind = null,
} = {}) {
  const th = { ...defaultThresholds(), ...(thresholds || {}) };
  const pAct = Number.isFinite(th.p_act) ? th.p_act : 0.95;
  const pAsk = Number.isFinite(th.p_ask) ? th.p_ask : 0.4;
  const notify = NOTIFY_RECURRENCE_KINDS.includes(sourceKind);
  if (p < pAsk) return { verb: "silent-log" };
  // p >= p_ask → ask verb (decision card). Cold-start CAPS the ceiling at ask
  // "regardless of scores": the act branch is never considered (no throw).
  if (coldStart) return { verb: "decision", capped: true, notify };
  if (p >= pAct) {
    throw new Error("suggest: act branch reached — nothing acts in P2");
  }
  return { verb: "decision", notify };
}

// ---------------------------------------------------------------------------
// Generator output normalization (§9.1 schema)
// ---------------------------------------------------------------------------

export function validateOption(opt) {
  if (!opt || typeof opt !== "object") return false;
  if (typeof opt.label !== "string" || opt.label.trim().length === 0) return false;
  const type = opt.action?.type;
  if (!ACTION_TYPES.includes(type)) return false;
  if (!opt.action.payload || typeof opt.action.payload !== "object") return false;
  return true;
}

export function validateCandidate(c) {
  if (!c || typeof c !== "object") return false;
  if (!ACTION_TYPES.includes(c.class)) return false;
  if (!c.finding || typeof c.finding !== "object" || typeof c.finding.text !== "string" || !c.finding.text.trim()) return false;
  if (c.finding.refs !== undefined && (!Array.isArray(c.finding.refs) || !c.finding.refs.every((r) => typeof r === "string"))) return false;
  if (!Array.isArray(c.options) || c.options.length === 0 || c.options.length > 3) return false;
  return c.options.every(validateOption);
}

// Tolerant JSON extractor (a model may wrap the JSON in prose/fences).
export function parseSuggestionText(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// Normalize generated output into a validated, capped, id-bound candidate
// list (≤3). `findingId` stamps each candidate's stable id.
export function normalizeCandidates(parsed, findingId) {
  const raw = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const valid = raw.filter(validateCandidate).slice(0, 3);
  return valid.map((c) => ({
    id: stableSuggestionId(findingId, c.class),
    class: c.class,
    finding: {
      text: c.finding.text,
      refs: Array.isArray(c.finding.refs) ? c.finding.refs : [],
    },
    options: c.options,
  }));
}

// ---------------------------------------------------------------------------
// P2 findings sources — digest-detected recurrences + fact anomalies
// + watcher hits (BET-1398).
// ---------------------------------------------------------------------------

// A failure-tier digest item that recurs across digests is a high-salience
// finding (steep decay → earns the notify variant).
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
    // evidence rows. `sourceKind` is `watcher-hit`, or `watcher-hit-rate` for a
    // rate-threshold watcher (which earns the steep-decay notify variant).
    ...collectWatcherHitsFromLedger(opts?.ledgerRows),
  ];
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildSuggestContext({ finding, writeToolIds = [], tier = "low", capabilities = {} } = {}) {
  const opts = [];
  opts.push("- `config-change`: change a box config value (halts if a value is sensitive)");
  if (capabilities.queueTonight === true && String(tier).toLowerCase() === "high") {
    opts.push("- `queue-tonight`: enqueue for tonight's overnight batch");
  } else {
    opts.push("- `queue-tonight`: NOT available at the current tier");
  }
  if (capabilities.toolWrite === true) {
    opts.push(`- "tool-write": grant a tool a one-shot "write" ring action — eligible tools: ${writeToolIds.length ? writeToolIds.join(", ") : "(none — branch unreachable)"}`);
  } else {
    opts.push("- \"tool-write\": NOT available (no tool holds the write ring)");
  }
  opts.push("- `start-job`: launch a background delegate job");
  opts.push("- `record-decision`: write a decision fact to the facts store");
  return [
    {
      priority: "high",
      text:
        `You are the Adaptive CTO's suggestion generator. For the finding below, output at most 3 ` +
        `candidate suggestions, or nothing if none are warranted. Output ONLY JSON of the form ` +
        `{"candidates":[{"class":"<action-class>","finding":{"text":"<short restatement>","refs":["<ref>"]},` +
        `"options":[{"label":"<short human button label>","action":{"type":"<action-type>","payload":{...}}}]}]}. ` +
        `Each candidate's "class" must be an action-class and each option's action.type one of the available ` +
        `action-types below. A candidate with zero viable options should simply be omitted. Keep finding.text ` +
        `a faithful one-line restatement of the evidence, and refs to evidence ids. Currently-available action ` +
        `types:\n${opts.join("\n")}`,
    },
    {
      priority: "medium",
      text: `Finding (${finding.sourceKind ?? "unknown"}):\n${finding.text || ""}${Array.isArray(finding.refs) && finding.refs.length ? `\nRefs: ${finding.refs.join(", ")}` : ""}`,
    },
  ];
}

export function buildWorthinessContext({ candidate, sourceKind } = {}) {
  return [
    {
      priority: "high",
      text:
        `You are the gatekeeper deciding whether to surface one CTO suggestion to the user. ` +
        `Rate how much the user would WANT this suggestion surfaced RIGHT NOW on a 0..1 scale. ` +
        `Output ONLY a JSON number, e.g. 0.7. Consider relevance, urgency, and the cost of interrupting ` +
        `the user. 0 = not worth surfacing; 1 = surface immediately.`,
    },
    {
      priority: "medium",
      text:
        `Suggestion (class ${candidate.class}, source ${sourceKind ?? "unknown"}):\n` +
        `${candidate.finding?.text || ""}\n` +
        `Options: ${(candidate.options || []).map((o) => `[${o.action?.type}] ${o.label}`).join(" | ") || "none"}`,
    },
  ];
}

// Parse a worthiness model number (tolerant: "0.7", " 0.7", "score: 0.7").
export function parseWorthinessScore(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// The suggestion engine — injected store/ledger/cards/model/config/now.
// ---------------------------------------------------------------------------

export function createCtoSuggest(deps = {}) {
  const {
    now = () => Date.now(),
    publish = () => {},
    ledger = ledgerStore,
    engineState = engineStateStore,
    verdicts = verdictsStore,
    digests = digestsStore,
    facts = factsStore,
    configGet = async () => ({}),
    cards = null, // ctoCards manager exposing upsertDecision (D20; may be null → decisions become silent-logs)
    runSuggest = null, // gated runEphemeral for `suggest`; null → no generation
    runWorthiness = null, // gated runEphemeral for `worthiness`; null → worthiness score 0.5
    getWriteRingTools = async () => [], // §7.4 write ring (P2: empty → tool-write unreachable)
    capabilities = { queueTonight: false, toolWrite: false }, // P2 subsystems off
    fireNotify = async () => {}, // informational-tier router call (notify variant)
    senderReliability = async () => 0.5, // async (finding) => [0,1]
    classPriors = {}, // overrides for DEFAULT_CLASS_PRIORS
    thresholds = null, // in-memory engine-state thresholds (lazy)
    recordVerdict = null, // async ({subject, verdict, never}) => {ok} — B3 verdict route
  } = deps;

  const priors = { ...DEFAULT_CLASS_PRIORS, ...classPriors };

  async function ledgerAppend(entry) {
    try {
      await ledger.append({ actor: "cto", ts: now(), ...entry });
    } catch {
      /* best-effort — a ledger failure never takes suggestions down */
    }
  }

  async function loadState() {
    let es = {};
    try {
      es = (await engineState.load()) || {};
    } catch {
      es = {};
    }
    const st = (es.suggest && typeof es.suggest === "object") ? es.suggest : {};
    const th = { ...defaultThresholds(), ...(st.thresholds || {}) };
    const used = st.usedKeys || [];
    return { es, st, thresholds: th, used };
  }

  async function saveState(es, st) {
    try {
      await engineState.save({ ...es, suggest: st });
    } catch {
      /* best-effort */
    }
  }

  async function getThresholds() {
    const { thresholds: th } = await loadState();
    return { ...(thresholds || {}), ...th };
  }

  async function countVerdicts() {
    try {
      const payload = await verdicts.load();
      return Array.isArray(payload?.entries) ? payload.entries.length : 0;
    } catch {
      return 0;
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

  // Run the generator + worthiness gate for ONE finding and route the result.
  async function processFinding(finding, { coldStart, tier } = {}) {
    if (!finding || !finding.id) return { finding: finding?.id, surfaced: 0, silent: 0 };
    const th = await getThresholds();
    const writeToolIds = await getWriteRingTools();
    const reliability = await senderReliability(finding);

    let candidates = [];
    if (runSuggest) {
      try {
        const res = await runSuggest({
          taskClass: "suggest",
          context: buildSuggestContext({ finding, writeToolIds, tier, capabilities }),
          deps: { validate: (out) => normalizeCandidates(parseSuggestionText(out?.text), finding.id).length >= 0 },
        });
        candidates = normalizeCandidates(parseSuggestionText(res?.text), finding.id);
      } catch {
        candidates = [];
      }
    }
    if (!candidates.length) {
      await ledgerAppend({ kind: "suggest.generated", findingId: finding.id, sourceKind: finding.sourceKind, candidates: 0 });
      return { finding: finding.id, surfaced: 0, silent: 0 };
    }

    let surfaced = 0;
    let silent = 0;
    for (const c of candidates) {
      const options = filterOptionsByData(c.options, { writeToolIds, tier, capabilities });
      if (!options.length) {
        // Every option was data-excluded → nothing to show; log the hold.
        await ledgerAppend({ kind: "suggest.silent", id: c.id, class: c.class, score: 0, reason: "data-excluded", sourceKind: finding.sourceKind, text: c.finding.text });
        silent += 1;
        continue;
      }
      let score = 0.5;
      if (runWorthiness) {
        try {
          const w = await runWorthiness({
            taskClass: "worthiness",
            context: buildWorthinessContext({ candidate: c, sourceKind: finding.sourceKind }),
            deps: { validate: (out) => parseWorthinessScore(out?.text) != null },
          });
          score = parseWorthinessScore(w?.text) ?? 0.5;
        } catch {
          score = 0.5;
        }
      }
      const p = worthinessProbability(score, priors[c.class], reliability);
      let decision;
      try {
        decision = decideVerb({ p, thresholds: th, coldStart, sourceKind: finding.sourceKind });
      } catch {
        // act branch is unreachable in P2 — log as a held item, never act.
        await ledgerAppend({ kind: "suggest.silent", id: c.id, class: c.class, score: p, reason: "act-unreachable-p2", sourceKind: finding.sourceKind, text: c.finding.text });
        silent += 1;
        continue;
      }

      if (decision.verb === "silent-log") {
        await ledgerAppend({ kind: "suggest.silent", id: c.id, class: c.class, score: p, reason: "below-p_ask", sourceKind: finding.sourceKind, text: c.finding.text });
        silent += 1;
        continue;
      }

      // decision verb → write (or upsert) the decision card.
      const card = {
        id: c.id,
        variant: "decision",
        title: c.finding.text || "CTO suggestion",
        why: `Suggested as "${c.class}": ${c.finding.text}`,
        sourceKind: finding.sourceKind,
        cls: c.class,
        refs: c.finding.refs,
        evidence: c.finding.refs,
        options,
        score: p,
        capped: decision.capped === true,
      };
      let wrote = false;
      if (cards && typeof cards.upsertDecision === "function") {
        try {
          wrote = (await cards.upsertDecision({ ...card, ts: now() })).changed === true;
        } catch {
          wrote = false;
        }
      }
      if (wrote) {
        await ledgerAppend({ kind: "suggest.presented", cardId: c.id, class: c.class, score: p, sourceKind: finding.sourceKind });
        surfaced += 1;
      } else {
        // No card machinery (or it failed) → hold instead of acting.
        await ledgerAppend({ kind: "suggest.silent", id: c.id, class: c.class, score: p, reason: "no-card-path", sourceKind: finding.sourceKind, text: c.finding.text });
        silent += 1;
        continue;
      }

      // notify variant: informational-tier router call when the decay rule
      // matches AND a decision card was actually surfaced.
      if (decision.notify === true) {
        try {
          await fireNotify({
            title: "CTO suggestion",
            message: `Consider "${c.class}": ${c.finding.text}`,
            urgent: false,
          });
        } catch {
          /* best-effort */
        }
      }
    }
    return { finding: finding.id, surfaced, silent };
  }

  // The full pass: collect findings from P2 sources, then process each.
  // Returns `{findings, surfaced, silent}` for diagnostics/tests.
  async function runPass({ nowMs = now() } = {}) {
    const cfg = await configGet();
    const tier = String(cfg?.ctoTier ?? "low").toLowerCase();
    const coldStart = (await countVerdicts()) < VERDICT_MIN;
    const [digestsArr, factsArr, ledgerRows] = await Promise.all([loadDigests(), loadFacts(), loadLedgerRows()]);
    const findings = collectFindings(digestsArr, factsArr, { nowMs, ledgerRows });
    let surfaced = 0;
    let silent = 0;
    for (const f of findings) {
      const r = await processFinding(f, { coldStart, tier });
      surfaced += r.surfaced;
      silent += r.silent;
    }
    await publish({ kind: "suggestState", payload: { findings: findings.length, surfaced, silent, coldStart, ts: nowMs } });
    return { findings: findings.length, surfaced, silent, coldStart };
  }

  // ---- §14.3 silence audit ----
  // The held (silent-log) rows the monthly digest's "I held back N items —
  // review?" aside links to. Reverse-chron, with an optional cursor.
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
  // an accept verdict (success/access counters); `dismiss` records a dismiss
  // (rejection counter). Returns {ok} — a missing verdicts path degrades.
  async function verdictHeld({ id, verdict, never } = {}) {
    const subject = { type: "suggestion", id: String(id || "") };
    if (typeof recordVerdict === "function") {
      const r = await recordVerdict({ subject, verdict, never });
      return { ok: r?.ok === true, error: r?.error };
    }
    // Fallback: write directly through the shared verdicts store.
    const payload = await verdicts.load().catch(() => null);
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const entry = { ts: now(), subject, verdict, ...(never === true ? { never: true } : {}) };
    await verdicts.save({ ...(payload ?? {}), entries: [...entries, entry] });
    return { ok: true };
  }

  return {
    runPass,
    processFinding,
    listHeld,
    verdictHeld,
    getThresholds,
    countVerdicts,
    // exposed for tests / diagnostics
    _priors: priors,
    _filterOptionsByData: filterOptionsByData,
  };
}
