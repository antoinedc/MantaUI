// ctoProfile.mjs — the Adaptive CTO's internal model of the user (§8, BET-1393).
//
// Numerically maintained, conservatively consumed. This module is the pure
// engine + persistence wiring; it holds no UI and no model calls of its own:
//
//   - The DETERMINISTIC layer (§8.2 "Deterministic per event") is updated per
//     evidence event for free: incremental circular stats (running S,C sums →
//     mean hour + resultant length R̄), a 24-bin activity histogram whose local
//     maxima give the von Mises workday components (the spec's "cheap method,
//     no EM needed"), timezone inference from the activity trough, EWMAs, a
//     reservoir-median session length, and correction-rate counters.
//   - EVIDENCE ATOMS (§8.2 "Per closed segment") are produced in the SAME
//     model pass as the A6 segment summary (never a second call). Binary atoms
//     apply a BKT-style update (§8.2's four constants, pinned below); graded
//     atoms apply a TrueSkill-style μ ± (σ²/c)·v(t) update with topic
//     difficulty, approximated by the dimension's own μ prior, as the opponent.
//   - DECAY is numeric (§8.2): σ' = √(σ² + c²·weeks_idle) on a weekly tick;
//     repo familiarity erodes ∝ log of others'/agents' edits.
//
// Consumption follows the §8.3 anti-assumption rule: anything conditioned on
// expertise uses μ − 2σ. Interaction stats (prompt frequency, question mix,
// correction rate, verbosity/depth prefs) are OBSERVED preferences and are
// consumed raw (§8.4 scope rule) — they get no conservatism.
//
// Persistence reuses the atomic jsonStore pattern via profileStore
// (ctoStores.mjs) under the sandboxed state path. All mutable entry points set
// a dirty flag; flush() (called by the engine tick + decayWeekly) persists so
// writes are coalesced and never interleave.
//
// Spec: docs/adaptive-cto-spec.md §8.1 (schema), §8.2 (updates), §8.3 (μ−2σ),
// §8.4 (consumption incl. scope rule). Pure functions are exported for
// `ctoProfile.test.mjs`; I/O is injected like ctoDigest/ctoFacts.

import { profileStore } from "./ctoStores.mjs";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

// --- §8.1 skill-dimension prior / bounds -----------------------------------
// mu is a real-valued proficiency BELIEF on [0,1]; sigma is uncertainty on
// [MIN_SIGMA, SIGMA_MAX]. mu starts at MU0 (neutral), sigma at SIGMA0. The
// μ−2σ conservative bound (expertiseOf) is clamped to [0,1].
export const MU0 = 0.5;
export const SIGMA0 = 1.0;
export const MIN_SIGMA = 0.1;
export const SIGMA_MAX = 2.0;
export const SIGNAL_ALPHA = 0.05; // EWMA smoothing for interaction rates

// --- §8.2 BKT constants (pinned as specified) ------------------------------
export const BKT = Object.freeze({
  pL0: 0.3, // initial learning probability
  pT: 0.15, // probability of transit (learning) per evidence step
  pS: 0.1, // slip — answer wrong despite knowing
  pG: 0.2, // guess — answer right despite not knowing
});

// --- §8.2 TrueSkill-style graded update -------------------------------------
// μ' = μ ± (σ²/c)·v(t) with topic difficulty as opponent. Per BET-1393 the
// difficulty is approximated by the dimension's own μ prior (documented
// simplification — it preserves "hard-topic evidence moves estimates more": a
// higher-μ topic is being handled at higher demand, so new evidence about it
// is more informative). c scales σ² down to a reasonable movement size.
export const TRUESKILL_C = 2.0;
export const DIFF_PRIOR = 0.5; // (0.5 + mu): hard-topic information weighting

// --- §8.2 decay --------------------------------------------------------------
// σ' = √(σ² + c²·weeks_idle). c is chosen so a dimension converged to
// MIN_SIGMA regresses back to the default prior SIGMA0 after ~26 idle weeks:
// c²·26 = SIGMA0² − MIN_SIGMA² → c ≈ 0.196.
export const REGRESS_WEEKS = 26;
export const WEEKLY_DECAY_C = Math.sqrt((SIGMA0 * SIGMA0 - MIN_SIGMA * MIN_SIGMA) / REGRESS_WEEKS);

// Repo-familiarity erosion: doa' = max(0, doa − c·ln(1+Δothers_edits)) (§8.2).
export const REP_ERODE_C = 0.12;
export const REP_OWN_MARGIN = 0.1; // own edit: doa += margin·(1−doa)

// --- retention --------------------------------------------------------------
export const SKILL_DIM_MAX = 40; // §8.1: dimensions capped, displacement like facts
export const PROVENANCE_MAX = 500; // append-only provenance, capped
export const RESERVOIR_CAP = 200; // session-length reservoir (§8.2)
export const TZ_MIN_DAYS = 14; // §8.2: TZ flagged low-confidence until 14 days
export const TZ_NIGHT_HOUR = 4; // activity trough is assumed to be local ~4:00
export const TZ_CONF_HIGH = 0.65; // digest's inferred-TZ branch threshold
export const SUPPRESSION_MS = 90 * DAY_MS; // §8.5 sensitive-inference suppression TTL

// --- consumers (μ−2σ) --------------------------------------------------------
export const EXPERTISE_NOVICE = 0.33;
export const EXPERTISE_BALANCED = 0.66;
export const RISING_MARGIN_KAPPAS = 1.5; // rising edge sits margin hours before the peak
export const RISING_MARGIN_MIN_H = 0.25;
export const RISING_MARGIN_MAX_H = 2.0;

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function boxUtcOffsetHoursOf(ts) {
  return -new Date(ts).getTimezoneOffset() / 60;
}

// ---------------------------------------------------------------------------
// Pure circular / histogram / von Mises math (§8.2 deterministic layer)
// ---------------------------------------------------------------------------

// Incremental circular accumulator over hour-of-day fractions in [0,24).
export function accumulateCircular(acc = { S: 0, C: 0, n: 0 }, hourFraction) {
  const theta = (2 * Math.PI * hourFraction) / 24;
  return {
    S: acc.S + Math.sin(theta),
    C: acc.C + Math.cos(theta),
    n: acc.n + 1,
  };
}

// Mean hour + resultant length R̄ from an accumulator. R̄ ∈ [0,1] — the
// concentration of the user's activity around a single time of day.
export function circularStats({ S, C, n }) {
  if (!n) return { meanHour: null, rBar: 0 };
  const rBar = Math.hypot(S, C) / n;
  const meanHour = (((Math.atan2(S, C) * 24) / (2 * Math.PI)) % 24 + 24) % 24;
  return { meanHour, rBar };
}

// Add one activity sample to a 24-bin histogram (box-local hour in [0,24)).
export function addHistogram(freqs = new Array(24).fill(0), hourFraction) {
  const f = freqs.slice();
  const i = Math.min(23, Math.max(0, Math.floor(hourFraction % 24)));
  f[i] += 1;
  return f;
}

// Von Mises components from the histogram's LOCAL MAXIMA (§8.2 cheap method).
// A bin is a peak when its count strictly exceeds both circular neighbours and
// clears `minRelative` of the global max. weight = share of total activity;
// kappa ≈ concentration, derived from how sharply the peak towers over its own
// shoulders (monotonic with sharpness). mu_hour = the peak bin's centre.
export function histogramPeaks(freqs, { minRelative = 0.4 } = {}) {
  const n = 24;
  const total = freqs.reduce((s, f) => s + f, 0);
  const max = Math.max(...freqs, 1);
  const components = [];
  for (let i = 0; i < n; i++) {
    const prev = freqs[(i - 1 + n) % n];
    const next = freqs[(i + 1) % n];
    const f = freqs[i];
    if (f <= prev || f < next) continue; // not a local max
    if (f < minRelative * max) continue; // not prominent
    const shoulder = Math.max((prev + next) / 2, 1);
    const kappa = Math.max(1, Math.round((f / shoulder) * 10) / 10);
    components.push({ mu_hour: i + 0.5, kappa, weight: total ? f / total : 0 });
  }
  if (components.length === 0 && total > 0) {
    const i = freqs.indexOf(max);
    components.push({ mu_hour: i + 0.5, kappa: 1, weight: max / total });
  }
  return components;
}

// TZ inference from the activity trough (§8.2: "activity trough = local night").
// value = inferred UTC offset (hours); confidence is low until `minDays` of
// data exist, scaled by R̄ (a strong circular trough → more confidence).
export function inferTz({
  freqs = new Array(24).fill(0),
  dayCount = 0,
  rBar = 0,
  boxUtcOffsetHours = 0,
  nightHour = TZ_NIGHT_HOUR,
  minDays = TZ_MIN_DAYS,
} = {}) {
  let troughHour = -1;
  let trough = Infinity;
  for (let i = 0; i < 24; i++) {
    if (freqs[i] < trough) {
      trough = freqs[i];
      troughHour = i;
    }
  }
  const value = boxUtcOffsetHours + (nightHour - troughHour);
  const confidence = dayCount >= minDays ? Math.min(1, Math.max(0.2, 0.4 + rBar)) : 0.1;
  return { value, confidence };
}

// ---------------------------------------------------------------------------
// EWMA + reservoir median (§8.2)
// ---------------------------------------------------------------------------

export function ewma(prev, x, alpha = SIGNAL_ALPHA) {
  if (prev == null) return x;
  return prev + alpha * (x - prev);
}

// Reservoir with MEDIAN sampling — the "simplest correct" 200-sample sketch.
// push() drops a uniform sample once full; median() is stable over the window.
export function createReservoir(cap = RESERVOIR_CAP, rng = Math.random) {
  const buf = [];
  let n = 0;
  return {
    get size() {
      return n;
    },
    push(x) {
      n += 1;
      if (buf.length < cap) buf.push(x);
      else {
        const j = Math.floor(rng() * n);
        if (j < cap) buf[j] = x;
      }
    },
    median() {
      if (!buf.length) return null;
      const s = [...buf].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    },
    _seed(entries) {
      buf.length = 0;
      for (const e of entries) if (e != null && Number.isFinite(e)) buf.push(e);
      n = buf.length;
    },
    _snapshot(meta) {
      meta.reservoir = buf.slice(0, cap);
      meta.reservoirN = n;
    },
  };
}

// ---------------------------------------------------------------------------
// Atom application (§8.2) — BKT (binary) + TrueSkill (graded)
// ---------------------------------------------------------------------------

// A binary atom moves the latent proficiency belief with BKT's Bayes step,
// blended by `weight` (weight < 1 interpolates toward the prior, so weak
// evidence moves the belief less). `direction` ∈ {"up","down"}.
export function bktUpdate(
  belief,
  direction,
  { weight = 1, pT = BKT.pT, pS = BKT.pS, pG = BKT.pG } = {},
) {
  const b = belief + pT * (1 - belief); // transit before the observation
  let post;
  if (direction === "up") {
    post = (b * (1 - pS)) / (b * (1 - pS) + (1 - b) * pG);
  } else {
    post = (b * pS) / (b * pS + (1 - b) * (1 - pG));
  }
  return b + weight * (post - b);
}

// A graded atom moves mu with TrueSkill's μ ± (σ²/c)·v(t) shape. `dir` is a
// signed magnitude in [-1,1]. `diff` = the topic-difficulty opponent, which
// per BET-1393 IS the dimension's own μ prior: difficulty = diff + mu. Because
// the difficulty scales the move, a higher-μ (harder, more-demanded) topic
// receives LARGER evidence moves — the required "harder-evidence-moves-more"
// property (§8.2). sigma shrinks on evidence (uncertainty → confidence).
export function trueSkillUpdate(
  mu,
  sigma,
  { dir = 0, weight = 1, c = TRUESKILL_C, diff = DIFF_PRIOR, minSigma = MIN_SIGMA } = {},
) {
  if (!dir || !weight) return { mu, sigma };
  const difficulty = diff + mu; // opponent = own-μ prior (harder topic ⇒ moves more)
  const magnitude = Math.min(1, Math.abs(dir) + 0.0001);
  const move = ((sigma * sigma) / c) * Math.sign(dir) * magnitude * weight * difficulty;
  const sigma2 = Math.sqrt(Math.max(minSigma * minSigma, sigma * sigma - weight * 0.5 * Math.min(0.25, sigma)));
  return {
    mu: clamp01(mu + move),
    sigma: Math.min(SIGMA_MAX, sigma2),
  };
}

// General atom application. `atom = {dimension, direction, weight, ref}`.
//   - direction STRING "up"|"down" → binary BKT update;
//   - direction NUMBER (signed magnitude in [-1,1]) → graded TrueSkill.
// Returns an updated dimension state {mu, sigma, evidence, updated}.
export function applyAtom(dim, atom) {
  if (!atom || !atom.dimension) return dim;
  const { direction, weight = 1, ref } = atom;
  const w = typeof weight === "number" ? clamp01(weight) : 1;
  let mu = dim.mu;
  let sigma = dim.sigma;
  if (typeof direction === "string") {
    mu = clamp01(bktUpdate(dim.mu, direction === "up" ? "up" : "down", { weight: w }));
    sigma = Math.max(MIN_SIGMA, dim.sigma * (1 - 0.15 * w)); // evidence → confidence
  } else if (typeof direction === "number" && direction !== 0) {
    const r = trueSkillUpdate(dim.mu, dim.sigma, { dir: direction, weight: w });
    mu = r.mu;
    sigma = r.sigma;
  }
  return {
    ...dim,
    mu,
    sigma,
    updated: atom.updated ?? dim.updated,
    evidence: dim.evidence
      ? [...dim.evidence, ref].filter(Boolean).slice(-8)
      : ref
        ? [ref]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Decay (numeric, never LLM-judged) — §8.2
// ---------------------------------------------------------------------------

// σ' = √(σ² + c²·weeks_idle). c defaults so a converged dimension regresses
// back to SIGMA0 after REGRESS_WEEKS idle weeks.
export function sigmaDecay(sigma, weeksIdle, { c = WEEKLY_DECAY_C } = {}) {
  const w = Math.max(0, weeksIdle);
  return Math.min(SIGMA_MAX, Math.sqrt(sigma * sigma + c * c * w));
}

// Repo familiarity erosion ∝ log of others'/agents' edits (§8.2).
export function repFamErode(doa, othersDelta, { c = REP_ERODE_C } = {}) {
  return Math.max(0, doa - c * Math.log(1 + Math.max(0, othersDelta)));
}

// Repo familiarity gain from the user's own edit.
export function repFamOwn(doa, { margin = REP_OWN_MARGIN } = {}) {
  return doa + margin * (1 - clamp01(doa));
}

// ---------------------------------------------------------------------------
// Consumers — μ−2σ (§8.3/§8.4)
// ---------------------------------------------------------------------------

// The conservative expertise bound. High mu + low sigma → strong expertise.
export function expertiseOf({ mu, sigma }) {
  return clamp01(mu - 2 * sigma);
}

export function expertiseLabel(exp) {
  if (exp < EXPERTISE_NOVICE) return "novice";
  if (exp < EXPERTISE_BALANCED) return "balanced";
  return "technical";
}

// The §8.4 digest `audience` block: technicality per topic from μ−2σ, blended
// with the user's explicit depth preference (explicit profile beats implicit
// history — §8.4). `dimensions` = the skill map; `topics` may be empty. The
// returned `text` is the block injected into the digest compose prompt.
export function computeAudience({ dimensions = {}, topics = [], depthPref = 0 } = {}) {
  const seen = new Set();
  const perTopic = (topics || [])
    .slice(0, 8)
    .map((t) => {
      const key = String(t ?? "").trim();
      if (!key || seen.has(key)) return null;
      seen.add(key);
      const d = dimensions[key] || dimensions[String(t)];
      return { topic: key, exp: d ? expertiseOf(d) : 0.35 };
    })
    .filter(Boolean);
  const base = perTopic.length
    ? perTopic.reduce((s, p) => s + p.exp, 0) / perTopic.length
    : 0.35;
  const tech = clamp01(base * 0.85 + clamp01(depthPref) * 0.15);
  const label = expertiseLabel(tech);
  const text =
    `Audience for the receiving user (adapt per-item technicality to this — do not ` +
    `over-explain to a technical user, do not assume jargon for a non-expert): ` +
    `${label}${perTopic.length ? ` (topics: ${perTopic.map((p) => p.topic).join(", ")})` : ""}. ` +
    `Blockers stay non-technical regardless.`;
  return { tech, label, topics: perTopic.map((p) => p.topic), text };
}

// The dominant workday component (highest weight) or null.
export function dominantComponent(components = []) {
  if (!components.length) return null;
  return components.reduce((a, b) => (b.weight > a.weight ? b : a));
}

// Rising edge, in box-local ms-into-day: the dominant component's peak
// translated to box-local clock, minus a margin proportional to its spread
// (1/kappa) — activity ramps up as it approaches the peak.
export function risingEdgeMsIntoDay({
  components = [],
  tzOffset = 0,
  boxUtcOffsetHours = 0,
  marginKappas = RISING_MARGIN_KAPPAS,
} = {}) {
  const dom = dominantComponent(components);
  if (!dom) return null;
  const muBoxHour = ((dom.mu_hour - tzOffset + boxUtcOffsetHours) % 24 + 24) % 24;
  const margin = Math.min(RISING_MARGIN_MAX_H, Math.max(RISING_MARGIN_MIN_H, marginKappas / dom.kappa));
  const edgeHour = ((muBoxHour - margin) % 24 + 24) % 24;
  return Math.round(edgeHour * HOUR_MS);
}

// Deviation-from-own-baseline: activity far outside the user's typical workday
// (e.g. a 3am session for a 10–18h user) → {type,text}. Surfaced ONLY as a
// digest progress-tier aside, never in any shared artifact (§8.4).
export function offHoursDeviation({ hour, components = [], thresholdHours = 5 } = {}) {
  const dom = dominantComponent(components);
  if (!dom) return null;
  const spread = Math.min(8, Math.max(1, 24 / dom.kappa / 2));
  const lo = (dom.mu_hour - spread + 24) % 24;
  const hi = (dom.mu_hour + spread) % 24;
  let away;
  if (lo <= hi) away = hour < lo || hour > hi;
  else away = hour > hi && hour < lo; // wrapped window across midnight
  if (!away) return null;
  const gap = Math.min(Math.abs(hour - dom.mu_hour), 24 - Math.abs(hour - dom.mu_hour));
  if (gap < thresholdHours) return null;
  return {
    type: "off-hours",
    text: `You're active unusually late/night (≈${Math.round(hour)}:00 box-local, typical ${Math.round(dom.mu_hour)}:00) — noted here only for you.`,
  };
}

// ---------------------------------------------------------------------------
// Dimension cap displacement (§8.1: ≤40, same retention discipline as facts)
// ---------------------------------------------------------------------------

// Keep the `max` most RECENTLY updated dimensions; drop the stalest. Pure.
export function capDimensions(skills = {}, { max = SKILL_DIM_MAX } = {}) {
  const entries = Object.entries(skills);
  if (entries.length <= max) return { ...skills };
  entries.sort((a, b) => (a[1]?.updated ?? 0) - (b[1]?.updated ?? 0));
  return Object.fromEntries(entries.slice(entries.length - max));
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function defaultProfile() {
  return {
    v: 1,
    identity: { stated: {}, suppressed: {} },
    skills: {},
    repo_familiarity: {},
    temporal: {
      tz_offset: { value: null, confidence: 0 },
      workday: { components: [], r_bar: 0, weekend_ratio: 0 },
      dayCount: 0,
      lastDayKey: "",
      circ: { S: 0, C: 0, n: 0 },
      histogram: new Array(24).fill(0),
    },
    interaction: {
      prompt_freq_ewma: null,
      session_len_median: null,
      question_mix: {},
      correction_rate: { corrected: 0, total: 0 },
      verbosity_pref: { value: 0, source: "inferred" },
      depth_pref: { value: 0, source: "inferred" },
    },
    provenance: [],
    _meta: { reservoir: [], reservoirN: 0 },
  };
}

/**
 * Create the profile engine. Deps:
 *   store  — { load, save } (default profileStore)
 *   now    — () => epoch ms
 *   rng    — () => [0,1) for the reservoir (inject for deterministic tests)
 *
 * Mutable entry points set a dirty flag; flush() persists (called by the
 * engine tick and decayWeekly). Best-effort — never throws into the caller.
 */
export function createCtoProfile(deps = {}) {
  const { store = profileStore, now = () => Date.now(), rng = Math.random } = deps;

  let state = defaultProfile();
  let dirty = false;
  let booted = false;
  const sessionLenReservoir = createReservoir(RESERVOIR_CAP, rng);
  const pendingOthersDelta = new Map();

  async function load() {
    if (booted) return;
    try {
      const raw = await store.load();
      if (raw && typeof raw === "object") {
        state = { ...defaultProfile(), ...raw };
        state.interaction = { ...defaultProfile().interaction, ...(raw.interaction || {}) };
        state.temporal = { ...defaultProfile().temporal, ...(raw.temporal || {}) };
        state.identity = { stated: {}, suppressed: {}, ...(raw.identity || {}) };
        sessionLenReservoir._seed(raw._meta?.reservoir || []);
      }
    } catch {
      state = defaultProfile();
    }
    booted = true;
  }

  async function flush() {
    if (!dirty) return;
    sessionLenReservoir._snapshot(state._meta);
    try {
      await store.save(state);
    } catch {
      /* best-effort */
    }
    dirty = false;
  }

  function markDirty() {
    dirty = true;
  }

  function boxLocalHour(ts) {
    const d = new Date(ts);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  function recordTemporal({ kind, ts }) {
    const t = state.temporal;
    const hour = boxLocalHour(ts);
    t.circ = accumulateCircular(t.circ, hour);
    t.histogram = addHistogram(t.histogram, hour);
    const dayKey = new Date(ts).toISOString().slice(0, 10);
    if (dayKey !== t.lastDayKey) {
      t.lastDayKey = dayKey;
      t.dayCount += 1;
    }
    t.r_bar = circularStats(t.circ).rBar;
    t.workday.components = histogramPeaks(t.histogram);
    t.tz_offset = inferTz({
      freqs: t.histogram,
      dayCount: t.dayCount,
      rBar: t.r_bar,
      boxUtcOffsetHours: boxUtcOffsetHoursOf(ts),
    });
  }

  function ensureSkill(dimension) {
    if (!state.skills[dimension]) {
      state.skills[dimension] = { mu: MU0, sigma: SIGMA0, evidence: [], updated: now() };
    }
    return state.skills[dimension];
  }

  function applyAtoms(atoms, project) {
    atoms = Array.isArray(atoms) ? atoms : [];
    for (const atom of atoms.slice(0, 20)) {
      if (!atom || typeof atom.dimension !== "string" || !atom.dimension) continue;
      const dim = ensureSkill(atom.dimension);
      state.skills[atom.dimension] = applyAtom(dim, { ...atom, updated: now() });
      state.provenance.push({
        field: `skills.${atom.dimension}`,
        delta: { direction: atom.direction, weight: atom.weight },
        evidence: atom.ref ?? null,
        ts: now(),
      });
    }
    if (state.provenance.length > PROVENANCE_MAX) {
      state.provenance = state.provenance.slice(state.provenance.length - PROVENANCE_MAX);
    }
    state.skills = capDimensions(state.skills);
    if (project) repoEdit({ repo: project, own: true });
    markDirty();
  }

  function repoEdit({ repo, own = false }) {
    if (!repo) return;
    const r = (state.repo_familiarity[repo] =
      state.repo_familiarity[repo] ?? { doa: 0.2, doi: 0, updated: now() });
    if (own) {
      r.doa = repFamOwn(r.doa, { margin: REP_OWN_MARGIN });
      r.updated = now();
    } else {
      r.doi += 1;
      pendingOthersDelta.set(repo, (pendingOthersDelta.get(repo) || 0) + 1);
    }
    markDirty();
  }

  function recordSessionLength(minutes) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return;
    sessionLenReservoir.push(minutes);
    state.interaction.session_len_median = sessionLenReservoir.median();
    markDirty();
  }

  return {
    init: load,
    get booted() {
      return booted;
    },

    get() {
      return state;
    },

    async flush() {
      await flush();
    },

    observeEvent({ kind, ts = now(), project } = {}) {
      if (kind === "prompt" || kind === "busy" || kind === "touch" || kind === "activity") {
        recordTemporal({ kind, ts });
      }
      if (kind === "prompt") {
        state.interaction.prompt_freq_ewma = ewma(state.interaction.prompt_freq_ewma, 1, SIGNAL_ALPHA);
        state.interaction.question_mix.prompt = (state.interaction.question_mix.prompt || 0) + 1;
      }
      if (kind === "abort") {
        state.interaction.correction_rate.corrected += 1;
        state.interaction.correction_rate.total += 1;
      } else if (kind === "idle") {
        state.interaction.correction_rate.total += 1;
      }
      if (project) repoEdit({ repo: project, own: true });
      markDirty();
    },

    // Apply a closed A6 segment summary: its evidence atoms + session length +
    // project (repo familiarity). Same host pass, no extra model call (§8.2).
    async applySegmentSummary(summary) {
      if (!summary || typeof summary !== "object") return;
      applyAtoms(summary.atoms, summary.project);
      if (Array.isArray(summary.window) && summary.window.length === 2) {
        recordSessionLength((summary.window[1] - summary.window[0]) / 60000);
      }
      await flush();
    },

    async recordRepoEdit(info) {
      repoEdit(info);
      await flush();
    },

    // §8.2 numeric decay — weekly tick (called by the engine). Tracks actual
    // per-dimension idle: weeks_idle = weeks since that dimension's last
    // evidence (d.updated), so a dimension untouched for many weeks decays
    // that many weeks' worth on the tick. `d.updated` is reset to `t` each
    // tick so the next tick measures fresh idle (an evidence update midway
    // between ticks correctly restarts that dimension's decay clock).
    async decayWeekly() {
      const t = now();
      const weekMs = 7 * DAY_MS;
      for (const d of Object.values(state.skills)) {
        if (!d) continue;
        const last = typeof d.updated === "number" ? d.updated : t;
        const weeksIdle = Math.max(0, (t - last) / weekMs);
        d.sigma = sigmaDecay(d.sigma, weeksIdle, { c: WEEKLY_DECAY_C });
        d.updated = t;
      }
      for (const [repo, r] of Object.entries(state.repo_familiarity)) {
        const delta = pendingOthersDelta.get(repo) || 0;
        r.doa = repFamErode(r.doa, delta, { c: REP_ERODE_C });
        r.doi = Math.max(0, r.doi - delta);
        pendingOthersDelta.delete(repo);
        r.updated = t;
      }
      markDirty();
      await flush();
    },

    // ---- consumers (mwired in ctoDigest / ctoEngine) ----
    getAudience({ topics = [] } = {}) {
      return computeAudience({
        dimensions: state.skills,
        topics,
        depthPref: state.interaction.depth_pref?.value ?? 0,
      });
    },

    getInferredTz() {
      const t = state.temporal.tz_offset;
      if (t?.value == null) return null;
      return { utcOffsetHours: t.value, confidence: t.confidence };
    },

    getRisingEdgeMsIntoDay() {
      return risingEdgeMsIntoDay({
        components: state.temporal.workday.components,
        tzOffset: state.temporal.tz_offset?.value ?? 0,
        boxUtcOffsetHours: boxUtcOffsetHoursOf(now()),
      });
    },

    getDeviations({ hour } = {}) {
      const h = hour != null ? hour : boxLocalHour(now());
      const flag = offHoursDeviation({ hour: h, components: state.temporal.workday.components });
      return flag ? [{ ...flag }] : [];
    },

    // §8.5 stated wins: an inline edit writes `source: stated`, which beats
    // every inferred value for that dimension until it is re-edited (the render
    // model resolves `source` + `value` here, nothing client-side decides it).
    // `value` is the displayed value (a number for skills, or any label).
    async setStated({ dimension, value, label } = {}) {
      if (typeof dimension !== "string" || !dimension.trim()) {
        return { ok: false, error: "dimension is required" };
      }
      if (value == null || value === "") {
        return { ok: false, error: "value is required" };
      }
      state.identity = { stated: {}, suppressed: {}, ...(state.identity || {}) };
      state.identity.stated = state.identity.stated || {};
      state.identity.stated[dimension] = { value, label: label ?? null, ts: now() };
      markDirty();
      await flush();
      return { ok: true };
    },

    // §8.5 sensitive-inference suppression: deleting a sensitive inference (in
    // this drill-down) suppresses that inference CLASS for 90 days, server-side
    // — the render model omits a suppressed class entirely until it expires.
    async suppressInference(cls) {
      if (typeof cls !== "string" || !cls) {
        return { ok: false, error: "inference class is required" };
      }
      state.identity = { stated: {}, suppressed: {}, ...(state.identity || {}) };
      state.identity.suppressed = state.identity.suppressed || {};
      state.identity.suppressed[cls] = now() + SUPPRESSION_MS;
      markDirty();
      await flush();
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// §8.5 sensitive inferences + the render model — pure, server-side composition.
// The renderer does NO math: GET /api/cto/profile returns exactly this.
// ---------------------------------------------------------------------------

export function boxLocalHourOf(ts) {
  const d = new Date(ts);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

// A sensitive inference class is suppressed while its tombstone is in the
// future (90d TTL). Server-enforced: the render model never emits a suppressed
// class, so the client cannot show what the user asked to hide.
export function isSuppressed(profile, cls, { nowMs = Date.now() } = {}) {
  const suppressed = profile?.identity?.suppressed ?? {};
  return (suppressed[cls] ?? 0) > nowMs;
}

// The currently-surfaceable sensitive inferences (sleep window, overwork).
// Both derive from EXISTING stored signal (tz inference + the §8 deviation
// flag) — this is presentation, never new inference (B5 owns that).
export function sensitiveInferences(profile = {}, { nowMs = Date.now() } = {}) {
  const out = [];
  const tz = profile.temporal?.tz_offset;
  if (tz?.value != null && !isSuppressed(profile, "sleep_window", { nowMs })) {
    const off = tz.value;
    const sign = off >= 0 ? "+" : "-";
    out.push({
      class: "sleep_window",
      label: "Sleep window",
      text: `Inferred timezone UTC${sign}${Math.abs(off)}:00 from your activity trough (confidence ${Math.round((tz.confidence ?? 0) * 100)}%).`,
      confidence: tz.confidence ?? 0,
    });
  }
  const dev = offHoursDeviation({
    hour: boxLocalHourOf(nowMs),
    components: profile.temporal?.workday?.components ?? [],
  });
  if (dev && !isSuppressed(profile, "overwork", { nowMs })) {
    out.push({ class: "overwork", label: "Overwork pattern", text: dev.text, confidence: null });
  }
  return out;
}

// The full render model the drill-down draws from: σ bands + top-3 evidence
// refs per skill (stated wins resolved HERE), the 24-bin rhythm histogram +
// TZ, interaction stats, repository familiarity, and the sensitive-inference
// flags (suppressed classes already omitted).
export function composeProfileRender(profile = {}, { nowMs = Date.now() } = {}) {
  const stated = profile.identity?.stated ?? {};
  const skills = Object.entries(profile.skills ?? {})
    .map(([dimension, d]) => {
      const st = stated[dimension];
      const exp = expertiseOf(d);
      return {
        dimension,
        mu: d.mu,
        sigma: d.sigma,
        expertise: exp,
        label: expertiseLabel(exp),
        source: st ? "stated" : "inferred",
        statedValue: st ? st.value : null,
        updated: d.updated ?? null,
        topEvidence: Array.isArray(d.evidence) ? d.evidence.slice(0, 3) : [],
      };
    })
    .sort((a, b) => b.expertise - a.expertise);
  const temporal = profile.temporal ?? {};
  const tz = temporal.tz_offset ?? { value: null, confidence: 0 };
  return {
    compiledAt: nowMs,
    skills,
    rhythm: {
      tzOffset: tz.value,
      tzConfidence: tz.confidence,
      lowConfidence: (temporal.dayCount ?? 0) < TZ_MIN_DAYS,
      dayCount: temporal.dayCount ?? 0,
      histogram: Array.isArray(temporal.histogram) ? temporal.histogram : new Array(24).fill(0),
      components: temporal.workday?.components ?? [],
      rBar: temporal.workday?.r_bar ?? 0,
      weekendRatio: temporal.workday?.weekend_ratio ?? 0,
    },
    interaction: {
      promptFreqEwma: profile.interaction?.prompt_freq_ewma ?? null,
      sessionLenMedian: profile.interaction?.session_len_median ?? null,
      questionMix: profile.interaction?.question_mix ?? {},
      correctionRate: profile.interaction?.correction_rate ?? { corrected: 0, total: 0 },
      verbosityPref: profile.interaction?.verbosity_pref ?? { value: 0, source: "inferred" },
      depthPref: profile.interaction?.depth_pref ?? { value: 0, source: "inferred" },
    },
    repository: Object.entries(profile.repo_familiarity ?? {})
      .map(([repo, r]) => ({ repo, doa: r.doa ?? 0, doi: r.doi ?? 0 }))
      .sort((a, b) => b.doa - a.doa),
    sensitive: sensitiveInferences(profile, { nowMs }),
  };
}
