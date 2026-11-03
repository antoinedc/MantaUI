// Builds src/server/fixtures/seat-demand-trace.json — the anonymised workload the
// seat replay (scripts/seats/replay.mjs) runs on — from THIS box's
// ~/.manta/usage-history.json. Run by hand when the trace should be refreshed:
//
//   node scripts/seats/build-trace.mjs [--out <file>] [--history <file>] [--bin-minutes 10]
//
// Demand is the sum, over the box's seats, of the positive 5h-window percentage
// increments per time bin (a drop is a window reset and is not demand). It is a
// LOWER BOUND on offered demand: a seat that was full served nothing more. Seat
// identities, session ids and emails are not in the output — only per-bin demand
// numbers and the seats' weekly-reset phases. Seats are renumbered 1..10, org A =
// 1–5, org B = 6–10.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = opt("out", join(root, "src/server/fixtures/seat-demand-trace.json"));
const HISTORY = opt("history", join(homedir(), ".manta", "usage-history.json"));
const BIN_MS = Number(opt("bin-minutes", "10")) * 60_000;
const START = Date.parse("2026-10-12T12:00Z");
const END = Date.parse("2026-11-02T12:00Z");
const K = 7.5;

// Weekly reset instants observed live on 2026-11-03 (UTC). The 10 entries are the
// 10 seats of this box (the box's seat ids skip 7, which is why they are renumbered).
const OBSERVED_RESETS = ["11-05T11:00", "11-04T05:00", "11-05T17:00", "11-07T10:00", "11-07T19:00", "11-05T03:00", "11-03T22:59", "11-05T19:00", "11-08T07:00", "11-07T16:00"];

const history = JSON.parse(readFileSync(HISTORY, "utf8"));
const bins = Math.floor((END - START) / BIN_MS);
const demand = new Array(bins).fill(0);
let sourceSeats = 0;
for (const [key, series] of Object.entries(history)) {
  if (!/^claude:seat-\d+:session$/.test(key)) continue;
  sourceSeats++;
  let prev = null;
  for (const p of series) {
    if (p.ts < START || p.ts >= END) {
      prev = null;
      continue;
    }
    if (prev != null && p.pct > prev) demand[Math.floor((p.ts - START) / BIN_MS)] += p.pct - prev;
    prev = p.pct;
  }
}

const trace = {
  version: 1,
  note:
    "Anonymised seat-demand trace for scripts/seats/replay.mjs. demand[i] = 5h-window points (percent of one Max 5x seat's 5h window) " +
    "consumed in bin i, summed over the box's seats — a lower bound on offered demand. weeklyResetAt = the instant (epoch ms, UTC) at which " +
    "each seat's weekly window was observed to reset next on 2026-11-03; add multiples of 7 days. K = 5h windows per weekly window (7.5).",
  startMs: START,
  endMs: END,
  binMs: BIN_MS,
  K,
  seats: OBSERVED_RESETS.map((r, i) => ({ id: i + 1, org: i < 5 ? "A" : "B", weeklyResetAt: Date.parse(`2026-${r}Z`) })),
  demand: demand.map((d) => Math.round(d * 100) / 100),
};

writeFileSync(OUT, JSON.stringify(trace) + "\n");
const total = demand.reduce((a, b) => a + b, 0);
console.log(`wrote ${OUT}: ${bins} bins of ${BIN_MS / 60_000} min from ${sourceSeats} source seats, ${total.toFixed(0)} 5h-points total (${((total * 7 * 864e5) / (END - START)).toFixed(0)}/week)`);
