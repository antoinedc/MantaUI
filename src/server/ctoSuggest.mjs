// src/server/ctoSuggest.mjs
// BET-1392 — the suggestion engine (spec §9.1) + the §14.3 silence audit.
//
// Responsibilities:
//   - Candidate generator: for each high-salience finding, ONE gated `suggest`
//     model call MAY emit ≤3 candidates. Each candidate is stable-keyed
//     `id = hash(findingId, class)` (regeneration upserts the card, never
//     duplicates), carries the finding text + refs, and ≤3 options whose
//     `action` type comes from a closed enum (`ACTION_TYPES`). The generator is
//     told which option types are reachable by data so it cannot propose what
//     the data forbids: `tool-write` only for tools holding the write ring
//     (empty ring = branch unreachable), `queue-tonight` only at High tier.
//   - Worthiness gate: a `worthiness` class call returns a 0..1 score; the
//     candidate probability is `score × class prior × sender reliability`
//     (§9.1 calibration). A per-class salience floor (`p_ask` from
//     `defaultThresholds()`, flat engine-state override wins) sits BELOW the
//     surface verbs: under it a candidate is SILENT-LOGGED (a ledger row
//     {id, score, reason}) for the §14.3 silence audit. Above it, the §9.3
//     gate (ctoGate.mjs, BET-1518) decides act vs ask:
//     `effective = p × calibration(class)` (§9.5); `effective ≥ τ` acts
//     through the executeAction seam (refusal → ask card, never a silent
//     no-op), `effective < τ` surfaces the decision card. The v2 verb ladder
//     (trust tiers, veto-window verb, cold-start pin, p_act) is deleted
//     (D22 supersedes v2 §9.4 and §10.6-4); `notify` is a delivery property
//     of ask (steep-decay kinds), not a verb.
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
  appendLedgerBestEffort,
  ledgerStore,
  engineStateStore,
  patchEngineState,
  patchStore,
  verdictsStore,
  digestsStore,
  factsStore,
} from "./ctoStores.mjs";
import { collectWatcherHitsFromLedger } from "./ctoWatchers.mjs";
// BET-1518 (§9.3/§9.5): the gate replaces the verb ladder — act vs ask on
// effective = p × calibration(class) vs τ; the suggest flow's candidate
// confidence is its worthiness p.
import { DEFAULT_TAU, evaluateGate } from "./ctoGate.mjs";

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

// BET-1465: bound `es.suggest.usedKeys` so it cannot become the next
// unbounded engine-state store — the `ctoStores.mjs` sweep does not cover
// engine-state. Plain trailing slice — unlike `ctoBudget.mjs`'s ROI pending
// cap (BET-1487), these keys carry no counted-fingerprint semantics, so a
// blind bound is safe here.
const USED_KEYS_CAP = 200;

// §9.1 per-class salience floors (BET-1471 — implements the BET-1470
// decision; do not re-litigate). `p_ask` is the worthiness bar a candidate
// must clear before it may surface at all; below it the candidate is a
// silent-log row for the §14.3 audit. With reliability at 1.0 a candidate's
// p ceiling IS its class prior, so the floor derives from that ceiling:
// `p_ask = 0.8 × ceiling`. The v2 `p_act` half of the pair is dead under the
// gate (the act/ask split is `effective = p × calibration ≥ τ`, ctoGate.mjs)
// but stays in the pair shape so the persisted engine-state override
// (`suggest.thresholds {p_ask, p_act}`) round-trips; only `p_ask` is read.
// The engine-state override, when present, applies globally to every class.
export function defaultThresholds() {
  return {
    "record-decision": { p_ask: 0.48, p_act: 0.57 },
    "config-change": { p_ask: 0.4, p_act: 0.48 },
    "start-job": { p_ask: 0.32, p_act: 0.38 },
    "queue-tonight": { p_ask: 0.28, p_act: 0.33 },
    "tool-write": { p_ask: 0.24, p_act: 0.29 },
  };
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

// (BET-1518) `decideVerb` — the v2 verb ladder (per-class p_act, trust-tier
// ceilings, veto-window verb, cold-start pin) — is deleted. The act/ask
// split is the §9.3 gate (ctoGate.mjs: evaluateGate on effective = p ×
// calibration vs τ); the salience floor above is the only threshold left.

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
    executeAction = null, // BET-1403: async ({cls, action, candidate}) => {ok, ...} — act-and-report executors; refusal → ask card
    // BET-1518 (§9.3/§9.5): the gate's two inputs. `calibrationOf` is async
    // (cls) => (0,1] — index.mjs wires it to the engine's calibration
    // instance; a missing/unreadable class → 0.5 (fresh). `tau` is the τ
    // source (the ctoAutonomyThreshold Settings control, default 0.7).
    calibrationOf = async () => 0.5, // async cls => (0,1]; index.mjs wires the calibration engine
    tau = async () => DEFAULT_TAU, // async () => 0..1 — the ctoAutonomyThreshold setting
    recordAct = null, // async ({cls, text, refs, action, score}) — act-and-report queue + ledger row
  } = deps;

  const priors = { ...DEFAULT_CLASS_PRIORS, ...classPriors };

  async function ledgerAppend(entry) {
    return appendLedgerBestEffort(ledger, now(), entry);
  }

  // The decision card branch shares one upsert core (duplication-gate fix,
  // was a 10-line intra-file clone): call the writer if wired, swallow a
  // throw into null, and read the BET-1477 `ok !== false` / `isNew` /
  // `changed` contract off the result.
  async function upsertCardRes(upsert, card) {
    let res = null;
    if (cards && typeof upsert === "function") {
      try {
        res = await upsert({ ...card, ts: now() });
      } catch {
        res = null;
      }
    }
    return {
      res,
      wrote: !!res && res.ok !== false,
      isNew: res?.isNew === true,
      changed: res?.changed === true,
    };
  }

  async function loadState() {
    let es = {};
    try {
      es = (await engineState.load()) || {};
    } catch {
      es = {};
    }
    const st = (es.suggest && typeof es.suggest === "object") ? es.suggest : {};
    // BET-1471: `suggest.thresholds` keeps its flat `{p_ask, p_act}` override
    // shape and is returned raw — per-class salience floors are resolved per
    // candidate inside processFinding, not baked in here.
    const th = (st.thresholds && typeof st.thresholds === "object") ? st.thresholds : {};
    const used = st.usedKeys || [];
    return { es, st, thresholds: th, used };
  }

  // BET-1465 (defect 1): persist processed keys into `es.suggest.usedKeys` via
  // the same per-key read-modify-write path every other engine-state writer
  // uses (`patchEngineState`) — a snapshot-spread save here would silently
  // revert whatever another writer (thresholds, trust migration, …) committed
  // to `es.suggest` between our load and save. Best-effort: a failed write
  // means the dedupe misses next pass, not that this pass's work is lost.
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

  // BET-1471: the flat override only (in-memory dep + engine-state) —
  // per-class salience floors are resolved per candidate in processFinding.
  async function getThresholds() {
    const { thresholds: th } = await loadState();
    return { ...(thresholds || {}), ...th };
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
  async function processFinding(finding, { tier } = {}) {
    if (!finding || !finding.id) return { finding: finding?.id, surfaced: 0, silent: 0 };

    // BET-1465 (defect 1): a finding recurs on every pass for as long as its
    // source digest/fact is retained (up to 30 digests) — without this gate
    // the SAME finding re-pays the suggest + worthiness model calls, the
    // ledger row, and (for steep-decay kinds) the notify push every 30
    // minutes. `finding.id` is already the stable, content-derived identity
    // the P2 collectors compute (collectFailuresFromDigests /
    // collectAnomaliesFromFacts / collectWatcherHitsFromLedger) — reused
    // as-is here, no new id scheme. Gating BEFORE the generator call (rather
    // than only per-candidate) is what actually avoids "identical work
    // already done": we cannot know a finding's candidate classes without
    // calling `runSuggest`, so a candidate-level check alone would still
    // re-pay that call every pass.
    // BET-1465 review (nit): loadState() is the single engine-state read for
    // this finding — its `thresholds` feeds the same merge getThresholds()
    // does, so we don't pay a second engine-state load per finding per pass.
    const { used, thresholds: stateThresholds } = await loadState();
    if (used.includes(finding.id)) {
      return { finding: finding.id, surfaced: 0, silent: 0 };
    }

    const th = { ...(thresholds || {}), ...stateThresholds };
    const writeToolIds = await getWriteRingTools();
    const reliability = await senderReliability(finding);

    // BET-1465 review (Block 1): the §3.3 ephemeral gate refuses by RETURNING
    // `{ok:false, gated:true}`, not by throwing — so a budget-closed pass (or
    // a transient model error / unparseable response) must NOT be treated as
    // "the generator ran and legitimately said zero candidates". Only mark a
    // finding used once we've confirmed the generator actually completed and
    // returned parseable output; a gated/failed/unparseable pass falls
    // through untouched so the finding is reconsidered next pass, exactly as
    // it was before this dedupe existed.
    let candidates = [];
    let generated = false;
    if (runSuggest) {
      try {
        const res = await runSuggest({
          taskClass: "suggest",
          context: buildSuggestContext({ finding, writeToolIds, tier, capabilities }),
          deps: { validate: (out) => normalizeCandidates(parseSuggestionText(out?.text), finding.id).length >= 0 },
        });
        if (res?.ok === false) {
          // Ephemeral rate/budget gate refused — the generator never ran.
          generated = false;
        } else {
          const parsed = parseSuggestionText(res?.text);
          if (parsed === null) {
            // Ran, but returned unparseable output — a transient quality
            // failure, not a legitimate "no suggestion" answer.
            generated = false;
          } else {
            candidates = normalizeCandidates(parsed, finding.id);
            generated = true;
          }
        }
      } catch {
        generated = false;
      }
    }
    if (!candidates.length) {
      if (generated) {
        await ledgerAppend({ kind: "suggest.generated", findingId: finding.id, sourceKind: finding.sourceKind, candidates: 0 });
        await markUsed([finding.id]);
      }
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
      // §9.1 salience floor: under the class's p_ask the candidate is a
      // silent-log row (the §14.3 audit counts it). The per-class floor
      // resolves here (BET-1471); `th` is the flat engine-state override
      // that applies globally when present. p_act is dead under the gate.
      const perClass = defaultThresholds()[c.class] || defaultThresholds()["config-change"];
      const thMerged = { ...perClass, ...th };
      const pAsk = Number.isFinite(thMerged.p_ask) ? thMerged.p_ask : perClass.p_ask;
      if (p < pAsk) {
        await ledgerAppend({ kind: "suggest.silent", id: c.id, class: c.class, score: p, reason: "below-p_ask", sourceKind: finding.sourceKind, text: c.finding.text });
        silent += 1;
        continue;
      }

      // BET-1518 (§9.3): the gate decides act vs ask on
      // effective = p × calibration(class) ≥ τ. The candidate's worthiness p
      // is its stated confidence; the class's calibration comes from the
      // §9.5 estimator (0.5 fresh). notify is a delivery property of ask
      // (steep-decay kinds), evaluated up front.
      const notify = NOTIFY_RECURRENCE_KINDS.includes(finding.sourceKind);
      let cal = 0.5;
      try {
        const cRaw = await calibrationOf(c.class);
        cal = Number.isFinite(cRaw) ? Math.min(1, Math.max(0, cRaw)) : 0.5;
      } catch {
        cal = 0.5;
      }
      let tauNow = DEFAULT_TAU;
      try {
        const tRaw = await tau();
        if (Number.isFinite(tRaw)) tauNow = Math.min(1, Math.max(0, tRaw));
      } catch {
        tauNow = DEFAULT_TAU;
      }
      const decision = evaluateGate({
        plans: [{ id: c.id, class: c.class, confidence: p }],
        tau: tauNow,
        calibration: { [c.class]: cal },
      });

      const baseCard = {
        id: c.id,
        title: c.finding.text || "CTO suggestion",
        why: `Suggested as "${c.class}": ${c.finding.text}`,
        sourceKind: finding.sourceKind,
        cls: c.class,
        refs: c.finding.refs,
        evidence: c.finding.refs,
        options,
        score: p,
      };
      // BET-1465 (defect 1, belt-and-braces): whether the card write that
      // actually surfaced was a genuinely NEW card (`isNew`), not a re-upsert
      // of one already on the board. Gates `fireNotify` below so a re-surfaced
      // suggestion never re-pushes even if the (1) dedupe above somehow missed.
      let cardIsNew = false;

      // §9.2 act-and-report: the bound action of the primary option executes
      // immediately; the ledger row + the digest announcement are written
      // through recordAct. An unexecutable action (no executor wired,
      // executor refused, no primary option) degrades to the ask card —
      // never silently acts, never a veto-window (the veto-window verb is
      // deleted with the ladder).
      if (decision.verb === "act") {
        const action = options[0]?.action ?? null;
        let exec = { ok: false, reason: "no-executor" };
        if (action && typeof executeAction === "function") {
          try {
            exec = (await executeAction({ cls: c.class, action, candidate: c })) ?? { ok: false };
          } catch {
            exec = { ok: false };
          }
        }
        if (exec?.ok === true) {
          if (typeof recordAct === "function") {
            await recordAct({ cls: c.class, text: c.finding.text, refs: c.finding.refs, action, score: decision.effective }).catch(() => {});
          }
          await ledgerAppend({ kind: "suggest.acted", cardId: c.id, class: c.class, actionType: action?.type, score: p, sourceKind: finding.sourceKind });
          surfaced += 1;
          continue;
        }
        // fall through to the decision card
      }

      // ask verb (or degraded act) → write (or upsert) the decision card.
      // BET-1477: `ok !== false` is the "card path worked" test — a
      // byte-identical regeneration of an unchanged decision card is
      // "already surfaced, still current" (surfaced, no new ledger row, no
      // re-push), NOT a `suggest.silent` no-card-path hold. Only a missing
      // writer, a thrown write, or an explicit `ok: false` is a hold.
      {
        const up = await upsertCardRes(cards?.upsertDecision, { ...baseCard, variant: "decision" });
        cardIsNew = up.isNew;
        if (up.wrote) {
          if (up.changed) {
            await ledgerAppend({ kind: "suggest.presented", cardId: c.id, class: c.class, variant: "decision", score: p, sourceKind: finding.sourceKind });
          }
          surfaced += 1;
        } else {
          // No card machinery (or it failed) → hold instead of acting.
          await ledgerAppend({ kind: "suggest.silent", id: c.id, class: c.class, score: p, reason: "no-card-path", sourceKind: finding.sourceKind, text: c.finding.text });
          silent += 1;
          continue;
        }
      }

      // notify variant: informational-tier router call when the decay rule
      // matches AND a decision card was actually surfaced. Also require
      // `cardIsNew` (belt-and-braces, defect 1): a re-surfaced suggestion
      // (upsert of an existing card) must never re-push, even if it somehow
      // reached here despite the (1) dedupe gate above.
      if (notify === true && cardIsNew) {
        try {
          await fireNotify({
            title: "CTO suggestion",
            message: `Consider "${c.class}": ${c.finding.text}`,
            urgent: false,
            // BET-1465 (defect 2, review fix): every session-less AI `notify`
            // call previously collided on the SAME "notify-global" tag and
            // silently overwrote its predecessor in the notification shade.
            // `sessionID` is NOT a private tag input — it travels to the
            // phone and the native app deep-links a tap to that session, so
            // synthesizing one here (as the first cut of this fix did) opens
            // a tap onto a session that doesn't exist. `tag` is the caller
            // override push.mjs now exposes for exactly this case; sessionID
            // stays unset, so a tap just opens the app, as it always did for
            // a session-less notify.
            tag: `cto-suggest:${c.id}`,
          });
        } catch {
          /* best-effort */
        }
      }
    }
    // BET-1465 review (Question 1): only `finding.id` is ever read back by the
    // dedupe gate above — per-candidate keys were write-only and, at ~2
    // candidates/finding, were eating the 200-entry cap ~3x faster than the
    // cap implies. Persist only what's actually consulted.
    await markUsed([finding.id]);
    return { finding: finding.id, surfaced, silent };
  }

  // The full pass: collect findings from P2 sources, then process each.
  // Returns `{findings, surfaced, silent}` for diagnostics/tests.
  async function runPass({ nowMs = now() } = {}) {
    const cfg = await configGet();
    const tier = String(cfg?.ctoTier ?? "low").toLowerCase();
    const [digestsArr, factsArr, ledgerRows] = await Promise.all([loadDigests(), loadFacts(), loadLedgerRows()]);
    const findings = collectFindings(digestsArr, factsArr, { nowMs, ledgerRows });
    let surfaced = 0;
    let silent = 0;
    for (const f of findings) {
      const r = await processFinding(f, { tier });
      surfaced += r.surfaced;
      silent += r.silent;
    }
    await publish({ kind: "suggestState", payload: { findings: findings.length, surfaced, silent, ts: nowMs } });
    return { findings: findings.length, surfaced, silent };
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
  // an accept verdict (calibration success); `dismiss` records a dismiss
  // (calibration failure). The held row's action class is stamped onto the
  // subject so the §9.5 calibration fold can attribute the verdict. Returns
  // {ok} — a missing verdicts path degrades.
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
    // Fallback: append directly through the shared verdicts store — the same
    // patchStore section as recordVerdict (BET-1492), so a concurrent
    // recorder's verdict survives this write.
    const entry = { ts: now(), subject, verdict, ...(never === true ? { never: true } : {}) };
    await patchStore(verdicts, (fresh) => ({
      entries: [...(Array.isArray(fresh?.entries) ? fresh.entries : []), entry],
    }));
    return { ok: true };
  }

  return {
    runPass,
    processFinding,
    listHeld,
    verdictHeld,
    getThresholds,
    // exposed for tests / diagnostics
    _priors: priors,
    _filterOptionsByData: filterOptionsByData,
  };
}
