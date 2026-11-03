// Trace-driven fluid simulation of seat policies. Units: "5h-pct of one Max 5x seat".
const h = require(process.env.HOME + "/.manta/usage-history.json");
const K = Number(process.env.K ?? 7.5);          // full 5h windows per weekly window
const SCALE = Number(process.env.SCALE ?? 1);    // demand multiplier
const CROSS_COST = Number(process.env.CC ?? 1.3); // 5h-pct re-send cost of a cross-org move
const DT = 10 * 60e3, H5 = 5 * 3600e3, WK = 7 * 864e5;
const T0 = Date.parse("2026-10-12T12:00Z"), T1 = Date.parse("2026-11-02T12:00Z");
const nb = Math.floor((T1 - T0) / DT);
const demand = new Array(nb).fill(0);
for (const [k, a] of Object.entries(h)) {
  if (!/^claude:seat-\d+:session$/.test(k)) continue;
  let prev = null;
  for (const p of a) {
    if (p.ts < T0 || p.ts >= T1) { prev = null; continue; }
    if (prev != null && p.pct > prev) demand[Math.floor((p.ts - T0) / DT)] += (p.pct - prev) * SCALE;
    prev = p.pct;
  }
}
// weekly reset phases observed live on 2026-11-03 (UTC)
const resets = { 1: "11-05T11:00", 2: "11-04T05:00", 3: "11-05T17:00", 4: "11-07T10:00", 5: "11-07T19:00", 6: "11-05T03:00", 8: "11-03T22:59", 9: "11-05T19:00", 10: "11-08T07:00", 11: "11-07T16:00" };
const NSTREAM = 6;

function run(policy) {
  const seats = Object.entries(resets).map(([id, r]) => {
    let rw = Date.parse("2026-" + r + "Z"); while (rw > T0) rw -= WK; rw += WK; // first reset after T0
    return { id: +id, org: +id <= 5 ? "A" : "B", s5: 0, r5: null, w: 0, rw };
  });
  const streams = Array.from({ length: NSTREAM }, () => ({ seat: null, left: {} }));
  let served = 0, want = 0, wasteW = 0, cross = 0, same = 0, stalledBins = 0;
  for (let b = 0; b < nb; b++) {
    const t = T0 + b * DT;
    for (const s of seats) {
      if (s.r5 != null && t >= s.r5) { s.s5 = 0; s.r5 = null; }
      if (t >= s.rw) { wasteW += 100 - s.w; s.w = 0; s.rw += WK; }
    }
    const cap = (s) => Math.max(0, Math.min(100 - s.s5, (100 - s.w) * K)); // in 5h-pct
    const load = (s) => Math.max(s.s5, s.w);
    const d = demand[b] / NSTREAM;
    let unmet = 0;
    for (const st of streams) {
      if (d <= 0) continue;
      want += d;
      const cur = st.seat;
      const target = policy(seats, cur, st, t, cap, load);
      if (target && target !== cur) {
        if (cur) { (cur.org === target.org ? same++ : cross++); st.left[cur.id] = t; }
        st.seat = target;
        if (cur && cur.org !== target.org) { use(target, Math.min(CROSS_COST, cap(target)), t); }
      }
      const s = st.seat; if (!s) { unmet += d; continue; }
      const x = Math.min(d, cap(s)); use(s, x, t); served += x; unmet += d - x;
    }
    if (unmet > 0.01) stalledBins++;
  }
  function use(s, x, t) { if (x <= 0) return; if (s.r5 == null) s.r5 = t + H5; s.s5 += x; s.w += x / K; }
  const weeks = (T1 - T0) / WK;
  return { servedPct: (100 * served / want).toFixed(1), stallHours: (stalledBins * DT / 3600e3).toFixed(0), weeklyWastedPerSeatWeek: (wasteW / seats.length / weeks).toFixed(0), cross, same };
}

const servable = (s, cap) => cap(s) > 0.5;
// Approximation of today's rules (seatAssignment.mjs): load = max(5h, weekly); stay < 95;
// move same-org < 95 else other-org < 70; "reset-soon" toward a same-org seat whose 5h resets within 1h.
function current(seats, cur, st, t, cap, load) {
  const ok = seats.filter((s) => servable(s, cap) && !(t - (st.left[s.id] ?? -1e15) < H5));
  const least = (arr) => arr.sort((a, b) => load(a) - load(b))[0];
  if (!cur) return least(ok.filter((s) => load(s) < 70)) ?? least(ok);
  if (!servable(cur, cap)) return least(ok.filter((s) => s.org === cur.org)) ?? least(ok.filter((s) => load(s) < 70)) ?? least(ok) ?? cur;
  if (load(cur) >= 95) return least(ok.filter((s) => s.org === cur.org && load(s) < 95)) ?? least(ok.filter((s) => load(s) < 70)) ?? cur;
  const curReset = cur.r5 ?? Infinity;
  if (curReset > t + 3600e3) {
    const soon = ok.filter((s) => s.org === cur.org && s.r5 != null && s.r5 <= t + 3600e3 && load(s) < 70);
    if (soon.length) return soon.sort((a, b) => a.r5 - b.r5)[0];
  }
  return cur;
}
// Proposal: earliest weekly deadline first (EDF), hysteresis expressed as a time handicap.
function edf(seats, cur, st, t, cap) {
  const ok = seats.filter((s) => servable(s, cap) && s.s5 < 95);
  const pool = ok.length ? ok : seats.filter((s) => servable(s, cap));
  const key = (s) => s.rw + (cur && s !== cur ? (s.org === cur.org ? 1 : 12) * 3600e3 : 0);
  if (cur && servable(cur, cap) && cur.s5 < 95 && !pool.some((s) => key(s) < cur.rw)) return cur;
  return pool.sort((a, b) => key(a) - key(b))[0] ?? cur;
}
for (const [name, p] of [["current", current], ["edf", edf]]) console.log(`K=${K} scale=${SCALE}`, name.padEnd(8), JSON.stringify(run(p)));
// Proposal v2: org-sticky EDF. Cross-org only when the conversation's org cannot serve it.
function edfOrg(seats, cur, st, t, cap) {
  const can = (s) => servable(s, cap) && s.s5 < 95;
  const byDeadline = (arr) => arr.sort((a, b) => a.rw - b.rw)[0];
  if (!cur) return byDeadline(seats.filter(can)) ?? byDeadline(seats.filter((s) => servable(s, cap)));
  const sameOrg = seats.filter((s) => s.org === cur.org && can(s));
  if (sameOrg.length) { const best = byDeadline(sameOrg); return can(cur) && cur.rw <= best.rw ? cur : best; }
  if (servable(cur, cap)) return cur; // 95-99: finish the window before re-sending elsewhere
  return byDeadline(seats.filter(can)) ?? byDeadline(seats.filter((s) => servable(s, cap))) ?? cur;
}
const tot = demand.reduce((a, b) => a + b, 0) / ((T1 - T0) / WK);
console.log(`demand/week=${tot.toFixed(0)} 5h-pct; weekly-capped capacity=${(10 * 100 * K).toFixed(0)}; 5h-capped max=${(10 * 100 * WK / H5).toFixed(0)}`);
console.log(`K=${K} scale=${SCALE}`, "edfOrg  ", JSON.stringify(run(edfOrg)));
