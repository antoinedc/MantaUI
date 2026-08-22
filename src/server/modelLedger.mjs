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
import { aggregateReliability } from "../shared/toolReliability.mjs";

// Turns longer than this are excluded from TIMING only (still counted for
// cost) — the spec cap is 600s of wall-clock.
const TIMING_MAX_MS = 600_000;

// Reliability and telemetry describe how an endpoint behaves NOW. A rolling
// window is what lets a provider that had a bad week recover on its own.
export const ROUTING_LEDGER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

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
 * I/O. Reads the raw assistant message rows over the rolling window via the
 * shared getDb() handle. Shared by `ledgerSummary` and `endpointSummary` so
 * the SQL + parse + role-filter lives in exactly one place. Returns the parsed
 * `data` object plus the joined session fields. Never throws.
 */
async function assistantRows(db, since) {
  const sql = `
    SELECT m.id AS msg_id,
           m.data AS msg_data,
           s.parent_id AS parent_id,
           s.agent AS agent,
           s.directory AS directory
    FROM message m
    JOIN session s ON s.id = m.session_id
    WHERE m.time_created >= ?`;
  const stmt = db.prepare(sql);
  const out = [];
  for (const row of stmt.all(since)) {
    let data;
    try {
      data = JSON.parse(row.msg_data);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || data.role !== "assistant") continue;
    out.push({
      // The message id is what joins a message to its parts in the `part`
      // table (opencode stores parts separately — see collectToolParts).
      id: row.msg_id != null ? String(row.msg_id) : null,
      data,
      parentId: row.parent_id != null ? String(row.parent_id) : null,
      agent: row.agent ?? null,
      directory: row.directory ?? null,
    });
  }
  return out;
}

// Collect the parsed `tool`-type parts for a set of message ids from the
// `part` table. opencode stores a message's parts — including its tool calls —
// in the separate `part` table, NOT in `message.data` (that row only carries
// the `finish` summary, e.g. "tool-calls"); `message.data.parts` does not
// exist, so reading it measured zero tool-call requests on every endpoint and
// made reliability uniformly 0. Returns a Map<message_id, object[]> of the raw
// parsed part.data rows. A missing/unqueryable `part` table degrades to "no
// tool parts" so latency/telemetry below still work — never the whole summary.
function collectToolParts(db, ids) {
  const map = new Map();
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) return map;
  const BATCH = 500;
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    let rows;
    try {
      const ph = chunk.map(() => "?").join(",");
      rows = db.prepare(`SELECT message_id, data FROM part WHERE message_id IN (${ph})`).all(...chunk);
    } catch {
      // No `part` table (older opencode schema) — degrades to "no tool parts",
      // matching the pre-existing behaviour, never a collapsed summary.
      return map;
    }
    for (const r of rows) {
      let d;
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      if (!d || typeof d !== "object" || d.type !== "tool") continue;
      if (!map.has(r.message_id)) map.set(r.message_id, []);
      map.get(r.message_id).push(d);
    }
  }
  return map;
}

/**
 * PURE. Fold raw assistant message `data` into the tool-call reliability,
 * speed, latency and mix figures, keyed per endpoint ("providerID/modelID").
 *
 * Each row may carry tool-call data: `toolCalls` (Array<{name, arguments}>)
 * and an optional `tools` list (Array of tool defs). A row with tool calls is
 * one request that ended in tool calls; per-endpoint reliability reuses the
 * same request-level aggregation as the rest of the app. Timing reuses the
 * existing percentile + timing-exclusion helpers — no second copy.
 *
 * Returns an object keyed by endpoint; the shape is what the routing issue
 * consumes. Never throws.
 */
export function aggregateEndpointStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byEndpoint = new Map();
  for (const r of list) {
    const key = `${r.providerID ?? ""}/${r.modelID ?? ""}`;
    let e = byEndpoint.get(key);
    if (!e) {
      e = {
        key,
        durations: [],
        speeds: [],
        toolRequests: [],
        mix: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      byEndpoint.set(key, e);
    }

    e.mix.input += num(r.input);
    e.mix.output += num(r.output);
    e.mix.cacheRead += num(r.cacheRead);
    e.mix.cacheWrite += num(r.cacheWrite);

    const durMs = timedDurationMs(r.startedMs, r.completedMs);
    if (durMs !== null) {
      e.durations.push(durMs);
      const out = num(r.output);
      e.speeds.push(safeDiv(out, durMs / 1000));
    }

    const calls = Array.isArray(r.toolCalls) ? r.toolCalls : [];
    if (calls.length > 0) {
      e.toolRequests.push({ toolCalls: calls, tools: Array.isArray(r.tools) ? r.tools : [] });
    }
  }

  const out = {};
  for (const key of [...byEndpoint.keys()].sort()) {
    const e = byEndpoint.get(key);
    const durs = e.durations.sort((a, b) => a - b);
    const speeds = e.speeds.sort((a, b) => a - b);
    out[key] = {
      reliability: aggregateReliability(e.toolRequests),
      speed: {
        p50TokensPerSec: speeds.length ? percentile(speeds, 0.5) : null,
        p90TokensPerSec: speeds.length ? percentile(speeds, 0.9) : null,
      },
      latency: {
        p50Ms: durs.length ? percentile(durs, 0.5) : null,
        p90Ms: durs.length ? percentile(durs, 0.9) : null,
      },
      mix: { ...e.mix },
    };
  }
  return out;
}

// Extract the tool calls from a single assistant message's parts (each part of
// type "tool" carries a name plus its arguments/input). No call follows into a
// second pass when the message stores none.
function extractToolCalls(data) {
  const parts = Array.isArray(data.parts) ? data.parts : [];
  const calls = [];
  for (const p of parts) {
    if (!p || typeof p !== "object" || p.type !== "tool") continue;
    const name = p.tool;
    const args = p.state && p.state.input;
    if (name == null) continue;
    calls.push({ name, arguments: args });
  }
  return calls;
}

// Best-effort source of the request's tool definitions from the stored message
// data. When absent (the common case — schemata aren't persisted), reliability
// degrades to the conservative invalid-json-only signal, matching the "schema
// absent ⇒ valid" rule in the classification. No new capture path is added.
function extractTools(data) {
  return Array.isArray(data.tools) ? data.tools : [];
}

/**
 * I/O. Per-endpoint measurement (reliability, speed, latency, mix) over a
 * rolling window of assistant rows, via the shared getDb() handle. Degrades
 * exactly like `ledgerSummary`: returns { supported:false } — never throws —
 * when getDb() yields null, and a failed query also degrades. Read-only.
 *
 * On success the flag is separated from the data: `{ supported: true,
 * endpoints: {…} }`. `endpoints` is 7a's map keyed by "providerID/modelID";
 * the flag being distinct is what lets a caller tell "no ledger"
 * ({supported:false}) from "a ledger with nothing measured" ({endpoints:{}}).
 */
export async function endpointSummary({ sinceMs = 0 } = {}) {
  const db = await getDb();
  if (!db) return { supported: false };

  try {
    const since = num(sinceMs);
    const assistant = await assistantRows(db, since);
    // Tool calls come from the `part` table (message.data has no parts array);
    // fall back to a data-embedded `parts` only where one exists so a message
    // format that carries them inline still works.
    const toolParts = collectToolParts(db, assistant.map((r) => r.id));
    const rows = [];
    for (const { id, data } of assistant) {
      const tokens = data.tokens ?? {};
      const cache = tokens.cache ?? {};
      const parts = toolParts.get(id) ?? [];
      rows.push({
        providerID: data.providerID ?? null,
        modelID: data.modelID ?? null,
        input: tokens.input,
        output: tokens.output,
        cacheRead: cache.read,
        cacheWrite: cache.write,
        startedMs: data.time?.created,
        completedMs: data.time?.completed,
        toolCalls: Array.isArray(data?.parts) && data.parts.length > 0 ? extractToolCalls(data) : extractToolCalls({ parts }),
        tools: extractTools(data),
      });
    }
    return { supported: true, endpoints: aggregateEndpointStats(rows) };
  } catch (e) {
    // Query error: log once, drop the handle so the next call reopens, and
    // degrade to { supported:false } — never an exception, never zeros (a card
    // full of 0.00 would read as "perfect reliability", which is a lie).
    console.error("[modelLedger] endpoint query failed:", e?.message ?? e);
    try {
      db.close();
    } catch {
      /* already closed */
    }
    return { supported: false };
  }
}

/**
 * I/O. Reads assistant rows via the shared getDb() handle, parses their JSON,
 * and folds them through aggregate(). Returns { supported:false } — never
 * throws — when getDb() yields null, mirroring searchMessages. Rows whose data
 * fails JSON.parse or whose role !== "assistant" are skipped silently.
 */
export async function ledgerSummary({ sinceMs = 0 } = {}) {
  const db = await getDb();
  if (!db) return { supported: false };

  try {
    const since = num(sinceMs);
    const rows = [];
    for (const { data, parentId, agent, directory } of await assistantRows(db, since)) {
      const tokens = data.tokens ?? {};
      const cache = tokens.cache ?? {};
      rows.push({
        providerID: data.providerID ?? null,
        modelID: data.modelID ?? null,
        agent,
        parentId,
        directory,
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
