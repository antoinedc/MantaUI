// modelLedger.mjs — read-only spend/latency ledger over opencode's store.
//
// BET-1219: the measurement half of model routing. Nobody can see where model
// spend actually goes; on this box ~90% of it is prompt cache, not output
// tokens, and subagents silently run on the most expensive model available.
// This module adds the MEASUREMENT only — no routing, no behaviour change.
// Later routing decisions are tuned from these numbers, so this ships first.
//
// Split strictly into pure (`aggregate`) and I/O (`ledgerSummary`):
//   • aggregate — all arithmetic. Pure; no DB. Exported for tests.
//   • ledgerSummary — SQL via getDb() + JSON.parse, then aggregate().
//
// Degradation: mirrors messageSearch.mjs — when getDb() yields null (no Node
// 24 runtime, or no opencode.db at the resolved path) ledgerSummary returns
// { supported:false } and never throws. Read-only is a hard invariant; the
// shared handle from opencodeDb.mjs is opened read-only and stays so.

import { getDb } from "./opencodeDb.mjs";

// Turns longer than this are excluded from TIMING only (still counted for
// cost) — the spec cap is 600s of wall-clock.
const TIMING_MAX_MS = 600_000;

// Coerce an arbitrary JSON value to a finite number, else 0. Value-missing
// or a NaN/Infinity anywhere in the ledger is a bug; every division must
// yield 0, never NaN/Infinity.
function num(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

// Divide with a hard divide-by-zero guard: 0/0 and n/0 both yield 0.
function safeDiv(n, d) {
  const dd = num(d);
  return dd === 0 ? 0 : num(n) / dd;
}

// Percentile of an ascending-sorted array (linear-approach index). Caller
// gates on the minimum sample count; safe on empty input (returns 0).
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

// Timing duration (ms) for a row, or null when the row is excluded from
// timing: either boundary missing/zero, a zero/negative duration, or a
// duration over TIMING_MAX_MS. Excluded rows still count toward cost.
function timedDurationMs(startedMs, completedMs) {
  const s = num(startedMs);
  const c = num(completedMs);
  if (s <= 0 || c <= 0) return null;
  const d = c - s;
  if (!(d > 0) || d > TIMING_MAX_MS) return null;
  return d;
}

/**
 * PURE. Fold raw (already-parsed) rows into the spend/latency ledger.
 *
 * `rows` is Array<{ providerID, modelID, agent, parentId, directory, cost,
 * input, output, reasoning, cacheRead, cacheWrite, startedMs, completedMs }>.
 * `ledgerSummary` builds that shape; `aggregate` does all arithmetic.
 *
 * Every array in the result is sorted by `cost` descending. Never throws and
 * never emits NaN/Infinity — empty input yields all-zeros.
 */
export function aggregate(rows) {
  const list = Array.isArray(rows) ? rows : [];

  const totals = { turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Group accumulators, keyed so undefined/null collapse to one bucket each.
  const modelMap = new Map(); // "providerID/modelID" -> { … }
  const agentMap = new Map(); // agent string (or null marker) -> { … }
  const projectMap = new Map(); // directory (or empty marker) -> { … }

  for (const r of list) {
    const cost = num(r.cost);
    const input = num(r.input);
    const output = num(r.output);
    const cacheRead = num(r.cacheRead);
    const cacheWrite = num(r.cacheWrite);

    totals.turns += 1;
    totals.cost += cost;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;

    // ---- byModel ----
    const modelKey = `${r.providerID ?? ""}/${r.modelID ?? ""}`;
    let m = modelMap.get(modelKey);
    if (!m) {
      m = { key: modelKey, turns: 0, cost: 0, outTotal: 0, outTimed: 0, durSec: 0, durations: [] };
      modelMap.set(modelKey, m);
    }
    m.turns += 1;
    m.cost += cost;
    m.outTotal += output;

    const durMs = timedDurationMs(r.startedMs, r.completedMs);
    if (durMs !== null) {
      m.outTimed += output;
      m.durSec += durMs / 1000;
      m.durations.push(durMs);
    }

    // ---- byAgent ----
    const agent = r.agent ?? null;
    const agentKey = agent === null ? "__null__" : agent;
    let a = agentMap.get(agentKey);
    if (!a) {
      a = { agent, isChild: false, turns: 0, cost: 0 };
      agentMap.set(agentKey, a);
    }
    a.turns += 1;
    a.cost += cost;
    // A subagent/child session is one whose parentId is set. isChild is true
    // if any contributing row came from a child session.
    if (r.parentId != null) a.isChild = true;

    // ---- byProject ----
    const directory = r.directory ?? "";
    const projectKey = directory === "" ? "__empty__" : directory;
    let p = projectMap.get(projectKey);
    if (!p) {
      p = { directory, turns: 0, cost: 0 };
      projectMap.set(projectKey, p);
    }
    p.turns += 1;
    p.cost += cost;
  }

  // ---- byModel ----
  const byModel = [];
  for (const m of modelMap.values()) {
    byModel.push({
      key: m.key,
      turns: m.turns,
      cost: m.cost,
      costPerTurn: safeDiv(m.cost, m.turns),
      outPerTurn: safeDiv(m.outTotal, m.turns),
      // Timing only: sum(output) / sum(durationSeconds) across timed turns.
      tokensPerSec: safeDiv(m.outTimed, m.durSec),
      p50Ms: m.durations.length >= 5 ? percentile(m.durations, 0.5) : null,
      p90Ms: m.durations.length >= 5 ? percentile(m.durations, 0.9) : null,
    });
  }
  byModel.sort(byCostDesc);

  // ---- byAgent ----
  const byAgent = [];
  for (const a of agentMap.values()) {
    byAgent.push({ agent: a.agent, isChild: a.isChild, turns: a.turns, cost: a.cost, costPerTurn: safeDiv(a.cost, a.turns) });
  }
  byAgent.sort(byCostDesc);

  // ---- byProject ----
  const byProject = [];
  for (const p of projectMap.values()) {
    byProject.push({ directory: p.directory, turns: p.turns, cost: p.cost });
  }
  byProject.sort(byCostDesc);

  // ---- cacheShare ----
  // Fractions of the summed billed token cost proxy
  // (input + output + cacheRead + cacheWrite); the four sum to ~1.
  const proxy = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const cacheShare = {
    output: safeDiv(totals.output, proxy),
    cacheRead: safeDiv(totals.cacheRead, proxy),
    cacheWrite: safeDiv(totals.cacheWrite, proxy),
    input: safeDiv(totals.input, proxy),
  };

  return { totals, cacheShare, byModel, byAgent, byProject };
}

function byCostDesc(a, b) {
  return num(b.cost) - num(a.cost);
}

/**
 * I/O. Reads assistant rows via the shared getDb() handle, parses their JSON,
 * and folds them through aggregate(). Returns { supported:false } — never
 * throws — when getDb() yields null, mirroring searchMessages. Rows whose
 * data fails JSON.parse or whose role !== "assistant" are skipped silently.
 */
export async function ledgerSummary({ sinceMs = 0 } = {}) {
  const db = await getDb();
  if (!db) return { supported: false };

  try {
    const since = num(sinceMs);
    const sql = `
      SELECT m.data AS msg_data,
             s.parent_id AS parent_id,
             s.agent AS agent,
             s.directory AS directory
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE m.time_created >= ?`;
    const stmt = db.prepare(sql);
    const rows = [];
    for (const row of stmt.all(since)) {
      let data;
      try {
        data = JSON.parse(row.msg_data);
      } catch {
        continue;
      }
      if (!data || typeof data !== "object" || data.role !== "assistant") continue;
      const tokens = data.tokens ?? {};
      const cache = tokens.cache ?? {};
      rows.push({
        providerID: data.providerID ?? null,
        modelID: data.modelID ?? null,
        agent: row.agent ?? null,
        parentId: row.parent_id != null ? String(row.parent_id) : null,
        directory: row.directory ?? null,
        cost: data.cost,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: cache.read,
        cacheWrite: cache.write,
        startedMs: data.time?.created,
        completedMs: data.time?.completed,
      });
    }
    return { supported: true, ...aggregate(rows) };
  } catch (e) {
    // Query error: log once, drop the handle so the next call reopens, and
    // degrade to { supported:false } — never an exception.
    console.error("[modelLedger] query failed:", e?.message ?? e);
    try {
      db.close();
    } catch {
      /* already closed */
    }
    return { supported: false };
  }
}
