// Seat-placement replay harness (spec 2026-11-03-seat-placement-weekly-deadline §8).
//
// Runs a seat-placement POLICY — the real pure `decideSeat` of some commit — over
// a committed demand trace and reports served share, weekly headroom that expired
// unused, moves and re-sent tokens. Replaces replay-draft.mjs.
//
//   node scripts/seats/replay.mjs --scale 0.6 --policy baseline
//   node scripts/seats/replay.mjs --scale 0.6 --policy all --seeds 5 --lag 10
//   node scripts/seats/replay.mjs --scenario edf-counterexample --policy baseline
//
// Flags: --scale <demand multiplier, default 1>  --policy baseline|after|both (all = both)
//        --sensitivity (streams 2/6/12, K 6/7.5/9, lag 0/10, both policies)  --no-retry
//        --seeds <n of the 5 fixed seeds, default 5>  --streams <mean concurrent
//        conversations, default 6>  --lag <minutes the provider reading lags: 0|10>
//        --k <true K, default the trace's>  --believed-k <K the policy is told>
//        --json  --scenario edf-counterexample
//
// POLICIES. A policy is `{ name, decideSeat(args), recordMove?(rec, decision,
// existing, nowMs) }`. `decideSeat` is called exactly as `place()` calls it
// (`{existing, mode:"auto", activeSeatId, seats, seatSnapshots, nowMs, model}`)
// plus `kFor` (provider-bound K reader; ignored by the baseline). The harness
// reproduces place()'s record updates (`left`, `crossOrgMovedAt`, `movedAt`,
// `model`) once, for every policy; `recordMove` lets a policy stamp its own
// fields (the weekly-deadline policy's `lastAutoMoveAt`).
//   • baseline — the pre-change code, vendored at a pinned commit
//     (scripts/seats/baseline/PINNED.md; a test proves it unmodified).
//   • after    — the live src/server/seatAssignment.mjs `decideSeat`, with the same
//     `kFor`/`nowMs` the server threads. The acceptance test is
//     src/server/seatReplayAcceptance.test.mjs (scripts/ is outside the test globs).
//
// MODEL. Units are "5h-points" (percent of one seat's 5h window). A seat has a 5h
// window (opens at first use, resets 5h later; reports no resetsAt while idle) and
// a weekly window worth K 5h-windows. Demand per 10-minute bin comes from the
// trace; it is split over the conversations active in that bin by shares drawn
// once per seed (Poisson arrivals, exponential durations — the whole offered
// workload is generated before any policy runs, so every policy sees IDENTICAL
// work for a seed). Each active conversation decides once per bin ("a request"),
// then consumes min(its demand, what its seat can still serve). A simulated
// poller reports per-seat windows every bin, optionally lagging the real state,
// with `stale` set the way the real poller sets it. The first 7 days are warm-up
// and excluded; headroom still unexpired at the end is NOT counted as waste.
//
// RETRY ON FULL (default on, `--no-retry` to turn off). A request that fills its seat
// leaves the rest of its work unserved; the real system answers that with a limit
// error, re-reads usage and re-decides (`reconsider`) before the retry. The harness
// does the same once, on fresh readings, for every policy. Without it a request that
// overflows a 5h window is simply lost, which charges a policy that packs the 5h
// window (the weekly-deadline rule) for a loss the live system does not have.
//
// SIMPLIFICATIONS: observed usage is a lower bound on offered demand; transfers
// are instantaneous; the trace's weekly-reset phases are this box's; a cross-org
// move costs `--resend-points-per-mtok` (default 1.46, from the one measured case:
// ≈ 890k tokens ≈ 1.3 5h-points) on the target seat; no per-model windows.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const TRACE_PATH = join(here, "..", "..", "src", "server", "fixtures", "seat-demand-trace.json");
export const SEEDS = [11, 23, 37, 41, 59];
const H5 = 5 * 3_600_000;
const WEEK = 7 * 86_400_000;
const WARMUP_MS = 7 * 86_400_000;
const MOVE_BACK_BLOCK_MS = 5 * 3_600_000; // as seatAssignment.mjs
const CROSS_ORG_CAP_MS = 5 * 3_600_000;
const MODEL = "claude-opus-5-5";
// median 290k / p90 594k tokens of conversation context → lognormal
const CONTEXT_MEDIAN_TOKENS = 290_000;
const CONTEXT_SIGMA = Math.log(594 / 290) / 1.2816;

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export const POLICY_LOADERS = {
  baseline: async () => {
    const m = await import("./baseline/seatAssignment.mjs");
    return { name: "baseline", decideSeat: m.decideSeat, recordMove: null };
  },
  // The live module. `decideSeat` reads the stamps place() writes (movedAt / reason /
  // assignedAt → when the conversation last moved), which applyDecision already
  // records; `lastAutoMoveAt` is stamped too so a record reads the same in a dump.
  after: async () => {
    const m = await import("../../src/server/seatAssignment.mjs");
    return {
      name: "after",
      decideSeat: m.decideSeat,
      recordMove: (rec, _decision, _existing, nowMs) => {
        rec.lastAutoMoveAt = nowMs;
      },
    };
  },
};

export async function loadPolicy(name) {
  const load = POLICY_LOADERS[name];
  if (!load) throw new Error(`unknown policy "${name}"`);
  return load();
}

// ---------------------------------------------------------------------------
// Seeded randomness (mulberry32) — a 10-line PRNG instead of a dependency
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const expDraw = (rng, mean) => -Math.log(1 - rng()) * mean;
function normalDraw(rng) {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Workload: the offered work, generated before any policy runs
// ---------------------------------------------------------------------------

/**
 * @returns {{bins:number, requestsByBin: Array<Array<{conv:number, d:number}>>, convs: Map<number,{id:number, context:number}>}}
 */
export function buildWorkload(trace, { seed, scale = 1, streams = 6, meanDurationH = 3 }) {
  const rng = mulberry32(seed);
  const bins = trace.demand.length;
  const binH = trace.binMs / 3_600_000;
  const meanDur = meanDurationH / binH; // bins
  const minDur = 2;
  const lambda = streams / meanDur; // arrivals per bin
  const convs = new Map();
  let nextId = 1;
  let active = [];
  const spawn = (b) => {
    const c = { id: nextId++, end: b + minDur + expDraw(rng, Math.max(1, meanDur - minDur)), weight: 0.25 + expDraw(rng, 1), context: CONTEXT_MEDIAN_TOKENS * Math.exp(CONTEXT_SIGMA * normalDraw(rng)) };
    convs.set(c.id, { id: c.id, context: c.context });
    active.push(c);
  };
  let nextArrival = expDraw(rng, 1 / lambda);
  const requestsByBin = new Array(bins);
  for (let b = 0; b < bins; b++) {
    while (nextArrival <= b) {
      spawn(b);
      nextArrival += expDraw(rng, 1 / lambda);
    }
    active = active.filter((c) => c.end > b);
    const demand = trace.demand[b] * scale;
    if (demand > 0 && active.length === 0) spawn(b);
    if (demand <= 0 || active.length === 0) {
      requestsByBin[b] = [];
      continue;
    }
    const total = active.reduce((s, c) => s + c.weight, 0);
    requestsByBin[b] = active.map((c) => ({ conv: c.id, d: (demand * c.weight) / total }));
  }
  return { bins, requestsByBin, convs };
}

// ---------------------------------------------------------------------------
// The simulation core
// ---------------------------------------------------------------------------

/** place()'s record update for one decision (assigned / moved), shared by every policy. */
export function applyDecision(existing, decision, nowMs, { model = MODEL, policy = null } = {}) {
  if (decision.reason === "assigned") return { seatId: decision.seatId, assignedAt: nowMs, lastUsedAt: nowMs, model };
  if (decision.reason !== "moved") return existing;
  const why = decision.why ?? "exhausted";
  const left = {};
  for (const [id, at] of Object.entries(existing.left ?? {})) if (nowMs - at < MOVE_BACK_BLOCK_MS) left[id] = at;
  if (why !== "reset-soon") left[decision.from] = nowMs; // an optional reset-soon move leaves no block
  const rec = { seatId: decision.seatId, assignedAt: nowMs, lastUsedAt: nowMs, movedFrom: decision.from, movedAt: nowMs, reason: why, left, model };
  if (decision.trigger) rec.trigger = decision.trigger;
  rec.crossOrg = decision.crossOrg === true;
  if (decision.crossOrg) rec.crossOrgMovedAt = nowMs;
  else if (typeof existing.crossOrgMovedAt === "number" && nowMs - existing.crossOrgMovedAt < CROSS_ORG_CAP_MS) rec.crossOrgMovedAt = existing.crossOrgMovedAt;
  policy?.recordMove?.(rec, decision, existing, nowMs);
  return rec;
}

function firstResetAfter(anchor, t0) {
  let rw = anchor;
  while (rw - WEEK > t0) rw -= WEEK;
  while (rw <= t0) rw += WEEK;
  return rw;
}

const emptyMetrics = () => ({ offered: 0, served: 0, expiredWeeklyPct: 0, seatWeeks: 0, moves: {}, crossMoves: 0, sameMoves: 0, resentMTok: 0 });

/**
 * One policy over one workload.
 * @param {object} cfg
 * @param {{startMs:number, binMs:number, K:number}} cfg.clock
 * @param {Array<{id:number|string, org:string, s5?:number, r5?:number|null, w?:number, rw:number, closedAfterReset?:boolean}>} cfg.seats
 * @param {ReturnType<typeof buildWorkload>} cfg.workload
 * @param {object} cfg.policy
 * @param {number} [cfg.warmupMs] @param {number} [cfg.lagBins] @param {number} [cfg.believedK] @param {number} [cfg.resendPointsPerMTok]
 * @param {boolean} [cfg.retryOnFull] a request that fills its seat is re-decided once on fresh readings (default true; see the header)
 * @param {((snapshots: object[], info: {nowMs:number, measured:boolean, model:string}) => void)|null} [cfg.probe] sees every bin's reported snapshots
 */
export function simulate({ clock, seats: seatDefs, workload, policy, warmupMs = WARMUP_MS, lagBins = 0, believedK = clock.K, resendPointsPerMTok = 1.46, retryOnFull = true, probe = null }) {
  const { startMs, binMs, K } = clock;
  const seats = seatDefs.map((d) => ({ id: `seat-${d.id}`, org: d.org, s5: d.s5 ?? 0, r5: d.r5 ?? null, w: d.w ?? 0, rw: d.rw, closed: d.closedAfterReset === true }));
  const seatRecords = seats.map((s) => ({ seatId: s.id, usable: true, accountId: `acct-${s.org}`, orgId: `org-${s.org}`, label: s.id }));
  const byId = new Map(seats.map((s) => [s.id, s]));
  const cap = (s) => Math.max(0, Math.min(100 - s.s5, (100 - s.w) * K));
  const use = (s, x, t) => {
    if (x <= 0) return;
    if (s.r5 == null) s.r5 = t + H5;
    s.s5 += x;
    s.w += x / K;
  };
  const kFor = (kind) => (kind === "weekly" ? believedK : typeof kind === "string" && kind.startsWith("weekly_scoped") ? 0.5 * believedK : null);

  const m = emptyMetrics();
  const assignments = new Map(); // conv id → record
  const history = []; // seat states at the start of each recent bin (for provider lag)
  const copyState = () => seats.map((s) => ({ s5: s.s5, r5: s.r5, w: s.w, rw: s.rw }));
  // What the provider reports at `t` for the given seat states: a 5h window with no
  // resetsAt while idle, a weekly one, `stale` once a reported reset is in the past.
  const snapshotsOf = (states, t) =>
    seats.map((s, i) => {
      const st = states[i];
      const win = (kind, label, pct, resetsAt) => ({ kind, label, pct: Math.round(pct), ...(resetsAt != null ? { resetsAt } : {}), ...(resetsAt != null && resetsAt <= t ? { stale: true } : {}) });
      return { seatId: s.id, provider: "claude", fetchedAt: t, windows: [win("session", "5h", st.s5, st.r5), win("weekly", "7d", st.w, st.rw)] };
    });
  let snapshots = [];

  /** One placement decision for `conv` on `snaps`, recorded the way place() records it; returns the seat to serve from. */
  const decideAndApply = (conv, snaps, t, measured) => {
    const existing = assignments.get(conv) ?? null;
    const decision = policy.decideSeat({ existing, mode: "auto", activeSeatId: seats[0].id, seats: seatRecords, seatSnapshots: snaps, nowMs: t, model: MODEL, kFor });
    if (!decision.seatId) return null;
    assignments.set(conv, applyDecision(existing, decision, t, { policy }));
    const seat = byId.get(decision.seatId);
    if (decision.reason === "moved") {
      const context = (workload.convs.get(conv)?.context ?? 0) / 1e6;
      if (measured) {
        const why = decision.why ?? "exhausted";
        m.moves[why] = (m.moves[why] ?? 0) + 1;
        if (decision.crossOrg) {
          m.crossMoves += 1;
          m.resentMTok += context;
        } else m.sameMoves += 1;
      }
      if (decision.crossOrg) use(seat, Math.min(cap(seat), context * resendPointsPerMTok), t);
    }
    return seat;
  };

  for (let b = 0; b < workload.bins; b++) {
    const t = startMs + b * binMs;
    const measured = t - startMs >= warmupMs;
    for (const s of seats) {
      if (s.r5 != null && t >= s.r5) {
        s.s5 = 0;
        s.r5 = null;
      }
      if (t >= s.rw) {
        if (measured) {
          m.expiredWeeklyPct += 100 - s.w;
          m.seatWeeks += 1;
        }
        s.w = s.closed ? 100 : 0; // a closed seat is gone after its reset (scenario worlds without replenishment)
        s.rw += WEEK;
      }
    }

    history.push(copyState());
    if (history.length > lagBins + 1) history.shift();
    snapshots = snapshotsOf(history[0], t); // what the provider reports now: the state `lagBins` ago
    probe?.(snapshots, { nowMs: t, measured, model: MODEL });

    for (const { conv, d } of workload.requestsByBin[b]) {
      if (measured) m.offered += d;
      const seat = decideAndApply(conv, snapshots, t, measured);
      if (!seat) continue;
      const x = Math.min(d, cap(seat));
      use(seat, x, t);
      if (measured) m.served += x;
      // The seat filled up under this request. The real system answers the next call
      // with a limit error, re-reads usage and re-decides (`reconsider`) before the
      // retry — fresh readings, no provider lag. One re-decision, same for every policy.
      if (retryOnFull && d - x > 1e-9 && cap(seat) <= 1e-9) {
        const seat2 = decideAndApply(conv, snapshotsOf(copyState(), t), t, measured);
        if (seat2) {
          const x2 = Math.min(d - x, cap(seat2));
          use(seat2, x2, t);
          if (measured) m.served += x2;
        }
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Runs over seeds, and statistics
// ---------------------------------------------------------------------------

export const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));

export function loadTrace(path = TRACE_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Reduce one seed's metrics to the reported numbers. */
export function summarise(m, { K }) {
  const weeks = m.seatWeeks || 1;
  const expiredPerSeatWeekPct = m.expiredWeeklyPct / weeks;
  return {
    servedPct: m.offered > 0 ? (100 * m.served) / m.offered : 0,
    expiredPerSeatWeekPct,
    expiredPerSeatWeekPts: expiredPerSeatWeekPct * K,
    moves: Object.values(m.moves).reduce((s, n) => s + n, 0),
    crossMoves: m.crossMoves,
    resentMTok: m.resentMTok,
    byReason: m.moves,
  };
}

/** One policy at one scale over `seeds`; the seed's offered work is identical across policies. */
export function runSeeds({ trace, policy, scale, seeds = SEEDS, streams = 6, lagMin = 0, K = trace.K, believedK = K, resendPointsPerMTok = 1.46, retryOnFull = true, probe = null }) {
  const seats = trace.seats.map((s) => ({ id: s.id, org: s.org, rw: firstResetAfter(s.weeklyResetAt, trace.startMs) }));
  return seeds.map((seed) => {
    const workload = buildWorkload(trace, { seed, scale, streams });
    const m = simulate({ clock: { startMs: trace.startMs, binMs: trace.binMs, K }, seats, workload, policy, lagBins: Math.round((lagMin * 60_000) / trace.binMs), believedK, resendPointsPerMTok, retryOnFull, probe });
    return { seed, ...summarise(m, { K }) };
  });
}

export function aggregate(rows) {
  const stat = (f) => ({ mean: mean(rows.map(f)), sd: sd(rows.map(f)) });
  return { servedPct: stat((r) => r.servedPct), expiredPerSeatWeekPct: stat((r) => r.expiredPerSeatWeekPct), expiredPerSeatWeekPts: stat((r) => r.expiredPerSeatWeekPts), moves: stat((r) => r.moves), crossMoves: stat((r) => r.crossMoves), resentMTok: stat((r) => r.resentMTok) };
}

// ---------------------------------------------------------------------------
// Scripted scenario: the §2.5 counter-example (earliest deadline vs most slack)
// ---------------------------------------------------------------------------
//
// Seat A: 300 points of weekly room but only 200 spendable before its weekly reset
// in 6 h (slack 100); seat B: 50 points expiring in 1 h. Same org (moves are free).
// Demand: 50 at t0, 100 at hour 2, 100 at hour 5 — three requests of three
// conversations. A seat is gone after its reset (no replenishment), as in the
// abstract pool the example describes. A correct policy serves 250; spending A
// first loses B's 50 and serves 200.
export function edfCounterexample({ policy }) {
  const K = 7.5;
  const startMs = Date.UTC(2026, 10, 3, 0, 0, 0);
  const binMs = 10 * 60_000;
  const bins = 8 * 6;
  const requestsByBin = Array.from({ length: bins }, () => []);
  const convs = new Map();
  for (const [id, hour, d] of [[1, 0, 50], [2, 2, 100], [3, 5, 100]]) {
    requestsByBin[hour * 6].push({ conv: id, d });
    convs.set(id, { id, context: 0 });
  }
  const seats = [
    { id: "A", org: "X", s5: 0, r5: startMs + H5, w: 100 - 300 / K, rw: startMs + 6 * 3_600_000, closedAfterReset: true },
    { id: "B", org: "X", s5: 0, r5: null, w: 100 - 50 / K, rw: startMs + 3_600_000, closedAfterReset: true },
  ];
  const m = simulate({ clock: { startMs, binMs, K }, seats, workload: { bins, requestsByBin, convs }, policy, warmupMs: 0 });
  return { offered: m.offered, served: m.served, expiredWeeklyPct: m.expiredWeeklyPct };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const fmt = (s, d = 1) => `${s.mean.toFixed(d)} ± ${s.sd.toFixed(d)}`;
const fmtSigned = (s, d = 1) => `${s.mean >= 0 ? "+" : "−"}${Math.abs(s.mean).toFixed(d)} ± ${s.sd.toFixed(d)}`;

/** mean ± sd of the per-seed paired difference `after − baseline` of one metric. */
export function pairedDiff(baselineRows, afterRows, f) {
  const d = baselineRows.map((r, i) => f(afterRows[i]) - f(r));
  return { mean: mean(d), sd: sd(d) };
}

/** The side-by-side table: one column per policy (+ the paired difference when both baseline and after ran). */
export function formatComparison(out) {
  const base = out.find((r) => r.policy === "baseline");
  const after = out.find((r) => r.policy === "after");
  const diff = base && after;
  const reasons = [...new Set(out.flatMap((r) => r.rows.flatMap((x) => Object.keys(x.byReason))))].sort();
  const lines = [];
  const row = (label, cells, delta = "") => lines.push(`${label.padEnd(34)}${cells.map((c) => c.padEnd(16)).join("")}${delta}`);
  row("", out.map((r) => r.policy), diff ? "after − baseline (paired, mean ± sd)" : "");
  const metric = (label, f, agg, d = 1) => row(label, out.map((r) => fmt(agg(r), d)), diff ? fmtSigned(pairedDiff(base.rows, after.rows, f), d) : "");
  metric("served %", (r) => r.servedPct, (r) => r.servedPct);
  metric("expired weekly, % per seat-wk", (r) => r.expiredPerSeatWeekPct, (r) => r.expiredPerSeatWeekPct);
  metric("expired weekly, 5h-pts/seat-wk", (r) => r.expiredPerSeatWeekPts, (r) => r.expiredPerSeatWeekPts, 0);
  metric("moves", (r) => r.moves, (r) => r.moves, 0);
  for (const k of reasons) {
    const per = (r) => r.byReason[k] ?? 0;
    row(`  ${k}`, out.map((o) => fmt({ mean: mean(o.rows.map(per)), sd: sd(o.rows.map(per)) }, 0)), diff ? fmtSigned(pairedDiff(base.rows, after.rows, per), 0) : "");
  }
  metric("cross-org moves", (r) => r.crossMoves, (r) => r.crossMoves, 0);
  metric("re-sent Mtok", (r) => r.resentMTok, (r) => r.resentMTok, 1);
  return lines.join("\n");
}

async function main(argv) {
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const has = (name) => argv.includes(`--${name}`);
  const policyArg = opt("policy", "baseline");
  const names = policyArg === "both" || policyArg === "all" ? ["baseline", "after"] : [policyArg];

  if (opt("scenario", null)) {
    if (opt("scenario") !== "edf-counterexample") throw new Error(`unknown scenario "${opt("scenario")}"`);
    for (const name of names) {
      const r = edfCounterexample({ policy: await loadPolicy(name) });
      console.log(`edf-counterexample  policy=${name.padEnd(8)} served ${r.served.toFixed(0)} of ${r.offered.toFixed(0)} (a correct policy serves 250)`);
    }
    return;
  }

  const trace = loadTrace();
  const scale = Number(opt("scale", 1));
  const seeds = SEEDS.slice(0, Number(opt("seeds", SEEDS.length)));
  const K = Number(opt("k", trace.K));
  const common = { trace, scale, seeds, streams: Number(opt("streams", 6)), lagMin: Number(opt("lag", 0)), K, believedK: Number(opt("believed-k", K)), resendPointsPerMTok: Number(opt("resend-points-per-mtok", 1.46)), retryOnFull: !has("no-retry") };
  const policies = await Promise.all(names.map(async (name) => [name, await loadPolicy(name)]));
  const runAll = (over = {}) => policies.map(([name, policy]) => {
    const rows = runSeeds({ ...common, ...over, policy });
    return { policy: name, scale: over.scale ?? scale, rows, ...aggregate(rows) };
  });

  if (has("sensitivity")) {
    // Printed, not gated. K varies the TRUE weekly size while the policy keeps believing the trace's K
    // (how wrong can the calibration be); the Fable row is not implemented — the model has no per-model windows.
    const rows = [["streams 2", { streams: 2 }], ["streams 6", { streams: 6 }], ["streams 12", { streams: 12 }], ["K 6", { K: 6, believedK: trace.K }], ["K 7.5", { K: 7.5, believedK: trace.K }], ["K 9", { K: 9, believedK: trace.K }], ["lag 0 min", { lagMin: 0 }], ["lag 10 min", { lagMin: 10 }]];
    console.log(`sensitivity at scale=${scale} seeds=${seeds.length} (served % and expired % per seat-week, mean over seeds; Fable 20 % row: not implemented)`);
    console.log("row".padEnd(12) + "served% base".padEnd(14) + "served% after".padEnd(15) + "Δ".padEnd(9) + "expired% base".padEnd(15) + "expired% after".padEnd(16) + "Δ");
    for (const [label, over] of rows) {
      const [b, a] = runAll(over);
      const dS = pairedDiff(b.rows, a.rows, (r) => r.servedPct).mean;
      const dE = pairedDiff(b.rows, a.rows, (r) => r.expiredPerSeatWeekPct).mean;
      console.log(label.padEnd(12) + b.servedPct.mean.toFixed(1).padEnd(14) + a.servedPct.mean.toFixed(1).padEnd(15) + `${dS >= 0 ? "+" : "−"}${Math.abs(dS).toFixed(1)}`.padEnd(9) + b.expiredPerSeatWeekPct.mean.toFixed(1).padEnd(15) + a.expiredPerSeatWeekPct.mean.toFixed(1).padEnd(16) + `${dE >= 0 ? "+" : "−"}${Math.abs(dE).toFixed(1)}`);
    }
    return;
  }

  const out = runAll();
  if (has("json")) return console.log(JSON.stringify(out, null, 2));
  console.log(`scale=${scale} seeds=${seeds.length} streams=${common.streams} lag=${common.lagMin}min K=${K} retry-on-full=${common.retryOnFull}  (mean ± sd over seeds; 7-day warm-up excluded)`);
  console.log(formatComparison(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
