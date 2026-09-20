// ctoOpClassReplay.test.mjs — BET-1533 acceptance: replay the REAL box
// ledger from 2026-09-14 through the watcher. It MUST raise a blocker within
// the first hour of that data — the ledger contains 300+ model-error rows per
// segment-summary/segment-one-liner with zero oks (the outage).
//
// The real file is read directly at ~/.manta/cto/ledger.jsonl (deliberately
// NOT the sandboxed statePath — the sandbox has no real history). When the
// file is absent (CI, other machines) or the 2026-09-14 window has rotated
// out of the ledger, the test SKIPS — it can only run where the data lives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateOpClass, OP_CLASS_LOOKBACK_MS, OP_CLASS_OUTCOME_KIND } from "./ctoOpClassWatcher.mjs";

const REAL_LEDGER = join(homedir(), ".manta", "cto", "ledger.jsonl");
// 2026-09-14T00:00:00Z — the day the outage data starts.
const SEP_14_MS = 1_789_344_000_000;
const FIRST_HOUR_MS = 3_600_000;

async function readOutcomeRows() {
  let text;
  try {
    text = await readFile(REAL_LEDGER, "utf-8");
  } catch {
    return null;
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.kind === OP_CLASS_OUTCOME_KIND) rows.push(row);
    } catch {
      /* malformed line — skip */
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

test("real-ledger replay (2026-09-14): a blocker raises within the first hour", async (t) => {
  const rows = await readOutcomeRows();
  if (rows === null) return t.skip(`no real ledger at ${REAL_LEDGER}`);
  const sep14 = rows.filter((r) => typeof r.ts === "number" && r.ts >= SEP_14_MS);
  if (sep14.length === 0) return t.skip("ledger no longer contains 2026-09-14 outcome rows");
  const t0 = sep14[0].ts;
  // The window must still be materially present (rotation guard), and the
  // acceptance's precondition — the outage pattern — must be intact history:
  // the first-hour slice contains enough attempts for a threshold to fire.
  const firstHour = sep14.filter((r) => r.ts <= t0 + FIRST_HOUR_MS);
  if (firstHour.length < 20) {
    return t.skip(`only ${firstHour.length} outcome rows in the first hour — outage window rotated out`);
  }
  assert.equal(
    firstHour.some((r) => r.code === "ok"),
    false,
    "precondition changed: the first hour of 2026-09-14 data now contains successes",
  );

  // Replay simulating the engine's real read cadence: every evaluation
  // re-reads the full lookback window as of that moment (the fold is
  // stateless per call — attempts accumulate through the re-read, and the
  // latch map carries the incident state forward).
  let alarms = {};
  let firstRaise = null;
  for (let i = 0; i < sep14.length && !firstRaise; i++) {
    const t = sep14[i].ts;
    let lo = i;
    while (lo > 0 && sep14[lo - 1].ts >= t - OP_CLASS_LOOKBACK_MS) lo--;
    const window = sep14.slice(lo, i + 1);
    const out = evaluateOpClass(window, { nowMs: t, alarms });
    if (out.raised.length > 0) firstRaise = { at: t, alarm: out.raised[0] };
    alarms = out.alarms;
  }
  assert.ok(firstRaise, "the replay never raised — the watcher misses the real outage");
  assert.ok(
    firstRaise.at - t0 <= FIRST_HOUR_MS,
    `first raise ${Math.round((firstRaise.at - t0) / 60_000)}min after the first row — acceptance demands ≤60min`,
  );
  assert.ok(
    firstRaise.alarm.taskClass && firstRaise.alarm.code,
    "the raised alarm names a task class and a failure code",
  );
});
