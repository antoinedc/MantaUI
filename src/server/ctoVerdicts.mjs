// src/server/ctoVerdicts.mjs
// BET-1391 — Verdict ledger + counter mapping + estimator helpers (spec §9.5).
//
// Responsibilities:
//   - `VERDICT_COUNTERS` — the ONE normative mapping table (§9.5) from verdict
//     → which learner counters it feeds. Consumed by the router; there is no
//     per-caller logic deciding which verdicts feed which learner.
//   - `createVerdictEngine().recordVerdict` — appends a verdict to
//     `verdicts.json` (A1's atomic jsonStore, append-only; ctoStores' sweep
//     owns eviction) and routes the §9.5 counter effects through the counter
//     sink registry.
//   - Counter sinks — consumers (the facts sender-reliability counters now,
//     trust / tool `as_*` counters later) register here; `recordVerdict`
//     dispatches each entry's effects through every sink. Best-effort: a
//     throwing sink never breaks verdict recording.
//   - Estimator helpers (`betaMean`, `betaTailAbove`, `thompsonDraw`) — the
//     shared §9.5 math: Thompson sampling where the system *selects* under
//     exploration; Beta means / tail tests where it *gates*.
//
// Pure over injected stores + a now() clock — testable without a live box.

import { patchStore, verdictsStore } from "./ctoStores.mjs";

// ---------------------------------------------------------------------------
// §9.5 counter mapping (normative — one exported table, consumed by the router)
// ---------------------------------------------------------------------------
//
// | Verdict | Acceptance/trust Beta | Importance/retention | Note              |
// |---------|-----------------------|----------------------|-------------------|
// | accept,e| success               | access               | edit=accept+signal|
// | dismiss,| rejection             | —                    | veto=cancelled    |
// | veto,correct,never              |                      | veto-window       |
// | open    | —                     | access               | never->acceptance |
// | expire  | —                     | decay signal         | never->acceptance |
//
// `never` is both a verdict-affecting *flag* (a never-again judgment, §10.4)
// and, per the table, a rejection signal — `effectsForVerdict` folds it in on
// top of the verdict's own mapping.
export const VERDICT_COUNTERS = Object.freeze({
  accept: Object.freeze({ success: true, access: true }),
  edit: Object.freeze({ success: true, access: true }),
  dismiss: Object.freeze({ rejection: true }),
  veto: Object.freeze({ rejection: true }),
  correct: Object.freeze({ rejection: true }),
  open: Object.freeze({ access: true }),
  expire: Object.freeze({ decay: true }),
});

export const VERDICT_VERDICTS = Object.freeze([
  "accept",
  "dismiss",
  "edit",
  "veto",
  "expire",
  "correct",
  "open",
]);

// Combine a verdict's table effects with the `never` flag's rejection signal
// into one effects object for the sink router. Effect flags: `success`,
// `rejection` (Acceptance/trust Beta) and `access`, `decay` (Importance/
// retention) — grouped, not per-verdict, so a sink reacts to the counter
// class it owns rather than to individual verdicts.
export function effectsForVerdict(verdict, never = false) {
  const base = VERDICT_COUNTERS[verdict] ?? {};
  const effects = { ...base };
  if (never === true) {
    effects.rejection = true; // a never-again judgment is a rejection (§9.5 table)
  }
  return effects;
}

// ---------------------------------------------------------------------------
// Estimator helpers (§9.5 policy)
// ---------------------------------------------------------------------------

// Beta mean — the acceptance-rate point estimate E[X] = a / (a+b).
export function betaMean(a, b) {
  const aa = a || 0;
  const bb = b || 0;
  const n = aa + bb;
  return n === 0 ? 0 : aa / n;
}

// Standard-normal CDF via the Abramowitz–Stegun erf 7.1.26 rational
// approximation. The approximation is monotonic and good to ~1e-3 in the
// z-range these gates use; exactness is not required at ledger counts.
function standardNormalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Gate test — the probability that the Beta(a,b) *mean* exceeds `p` (via a
// normal approximation of the mean: μ=a/(a+b), σ²=ab/((a+b)²(a+b+1))), then
// `prob >= conf`. Used where the tail gates (trust promotion, sender
// reliability): promote only once the tail clears the confidence threshold —
// never on a noisy mean. A degenerate Beta (no counts yet) never passes.
export function betaTailAbove(a, b, p, conf = 0.95) {
  const aa = a || 0;
  const bb = b || 0;
  const n = aa + bb;
  const mu = betaMean(aa, bb);
  const sigma = n > 0 ? Math.sqrt((aa * bb) / (n * n * (n + 1))) : 0;
  if (!(sigma > 0)) return false;
  const z = (mu - p) / sigma;
  return standardNormalCdf(z) >= conf;
}

// One standard-normal deviate from uniform numbers (Box–Muller).
function standardNormal(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Gamma(k,1) deviate via the Marsaglia–Tsang algorithm (shape k ≥ 1), with the
// k < 1 case reduced through Gamma(k) = Gamma(k+1) · U^(1/k). `rng` supplies
// the uniform numbers (default Math.random).
function gammaSample(shape, rng) {
  let k = Math.max(shape, 0);
  if (k < 1) {
    return gammaSample(k + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / k);
  }
  if (k === 0) return 0;
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// One Thompson draw from Beta(a,b): x ~ Gamma(a), y ~ Gamma(b), return
// x/(x+y). `rng` injectable for deterministic tests. Used where the system
// *selects* under exploration (portfolio categories, tool-as-source).
export function thompsonDraw(a, b, rng = Math.random) {
  const aa = a || 0;
  const bb = b || 0;
  if (aa <= 0 && bb <= 0) return 0.5;
  if (aa <= 0) return 0;
  if (bb <= 0) return 1;
  const x = gammaSample(aa, rng);
  const y = gammaSample(bb, rng);
  const total = x + y;
  return total > 0 ? x / total : betaMean(aa, bb);
}

// One-sided lower confidence bound of the Beta(a,b) mean, using the same
// normal approximation as `betaTailAbove` (μ = a/(a+b), σ² = ab/((a+b)²(a+b+1))):
// L = μ + σ·Φ⁻¹(1-conf), so P(μ > L) ≈ conf. With §9.4's 0.95 convention this
// is the "Beta lower bound" the dismissal-decay gates test (spec §7.6: trip
// when the as_source lower bound drops below 0.3). Degenerate Beta → 0.
// Φ⁻¹ is bisected on the existing `standardNormalCdf` — monotone, and the
// ~1e-3 CDF accuracy is far finer than any ledger-count decision.
export function betaLowerBound(a, b, conf = 0.95) {
  const aa = a || 0;
  const bb = b || 0;
  const n = aa + bb;
  if (!(n > 0)) return 0;
  const mu = betaMean(aa, bb);
  const sigma = Math.sqrt((aa * bb) / (n * n * (n + 1)));
  if (!(sigma > 0)) return mu; // a or b is 0: the mean is known exactly
  const target = 1 - (conf || 0.95);
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (standardNormalCdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return mu + sigma * ((lo + hi) / 2);
}

// ---------------------------------------------------------------------------
// Tool as-source counters (spec §7.6) — the counter sink for data-source
// analyses
// ---------------------------------------------------------------------------

// The verdict subject class report reviews use: `{type: "tool", id: <toolId>,
// class: AS_SOURCE_SUBJECT_CLASS}`. A verdict on this subject is a judgment
// of a data-analysis REPORT the CTO produced from that tool's data (the
// §7.6 experiment-first verdict seeds the same counters).
export const AS_SOURCE_SUBJECT_CLASS = "tool-as-source";

// Counter sink factory (§9.5 sink registry): folds tool-as-source verdict
// effects into the tool registry's `as_source` Beta counters. Effects map per
// the §9.5 table — accept/edit (`success`) → accepted+1 & reports+1;
// dismiss/veto/correct/never (`rejection`) → reports+1; `access`/`decay`
// (open/expire) never enter the acceptance counters. Best-effort like every
// sink: a failing counter write never breaks verdict recording.
export function createAsSourceSink({ registry } = {}) {
  if (!registry || typeof registry.applyAsSource !== "function") {
    throw new Error("createAsSourceSink requires a tool registry with applyAsSource()");
  }
  return (effects, entry) => {
    const subject = entry?.subject;
    if (subject?.type !== "tool" || subject?.class !== AS_SOURCE_SUBJECT_CLASS) return;
    void Promise.resolve(registry.applyAsSource(subject.id, effects ?? {})).catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Counter sink registry
// ---------------------------------------------------------------------------

// A small registry of counter sinks. Each sink is called with
// `(effects, entry)` after a verdict is recorded. `register` returns an
// unregister thunk. Dispatches are best-effort (a throwing sink is swallowed),
// so one consumer failing its counter update can never break verdict recording.
export function createCounterRegistry() {
  const sinks = [];
  return {
    register(sink) {
      sinks.push(sink);
      return () => {
        const i = sinks.indexOf(sink);
        if (i >= 0) sinks.splice(i, 1);
      };
    },
    dispatch(effects, entry) {
      for (const sink of sinks) {
        try {
          if (typeof sink === "function") sink(effects, entry);
          else if (sink && typeof sink.onEffects === "function") sink.onEffects(effects, entry);
        } catch {
          /* best-effort */
        }
      }
    },
    size: () => sinks.length,
  };
}

// ---------------------------------------------------------------------------
// The verdict engine
// ---------------------------------------------------------------------------

// Validate a verdict subject per §9.5: `{type, id, class?, sender?}`. `sender`
// is a session-stable identity — a non-empty string or `{sessionID}`.
export function isValidVerdictSubject(subject) {
  if (!subject || typeof subject !== "object") return false;
  if (typeof subject.type !== "string" || subject.type.length === 0) return false;
  if (typeof subject.id !== "string" || subject.id.length === 0) return false;
  if (subject.class !== undefined && (typeof subject.class !== "string" || subject.class.length === 0)) {
    return false;
  }
  if (subject.sender !== undefined) {
    const s = subject.sender;
    const okString = typeof s === "string" && s.length > 0;
    const okSession = s && typeof s === "object" && typeof s.sessionID === "string";
    if (!okString && !okSession) return false;
  }
  return true;
}

export function createVerdictEngine(deps = {}) {
  const { verdicts = verdictsStore, now = () => Date.now(), registry = createCounterRegistry() } = deps;

  async function loadEntries() {
    const payload = await verdicts.load().catch(() => null);
    return Array.isArray(payload?.entries) ? payload.entries : [];
  }

  // Appends a verdict entry to `verdicts.json` (append-only; the ctoStores
  // retention sweep owns eviction) and routes its §9.5 counter effects through
  // every registered sink. Rejects invalid input with `{ok:false, error}` —
  // never throws.
  async function recordVerdict({ subject, verdict, never } = {}) {
    if (!VERDICT_VERDICTS.includes(verdict)) {
      return { ok: false, error: `invalid verdict "${verdict}" (expected one of: ${VERDICT_VERDICTS.join(", ")})` };
    }
    if (!isValidVerdictSubject(subject)) {
      return { ok: false, error: "invalid subject (expected {type, id, class?, sender?})" };
    }
    if (never !== undefined && typeof never !== "boolean") {
      return { ok: false, error: "`never` must be a boolean" };
    }

    const entry = {
      ts: now(),
      subject: {
        type: subject.type,
        id: subject.id,
        ...(subject.class !== undefined ? { class: subject.class } : {}),
        ...(subject.sender !== undefined ? { sender: subject.sender } : {}),
      },
      verdict,
      ...(never === true ? { never: true } : {}),
    };

    // BET-1492: append through the verdicts store's patchStore mutex — two
    // concurrent recorders (this engine and the ctoSuggest fallback) each
    // re-derive from the other's committed entries instead of both loading
    // the same array and dropping one verdict on save.
    await patchStore(verdicts, (fresh) => ({
      entries: [...(Array.isArray(fresh?.entries) ? fresh.entries : []), entry],
    }));

    const effects = effectsForVerdict(verdict, never);
    registry.dispatch(effects, entry);
    return { ok: true, effects };
  }

  async function listVerdicts() {
    return loadEntries();
  }

  return {
    recordVerdict,
    listVerdicts,
    registerCounterSink: registry.register,
    _registry: registry,
  };
}
