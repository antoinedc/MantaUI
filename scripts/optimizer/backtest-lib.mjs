// backtest-lib.mjs — the PURE half of the sticky-trims backtest (spec §9).
// No I/O: sessions arrive as plain rows, the clock is simulated from message
// timestamps, prices arrive as a lookup function. The CLI (backtest-trims.mjs)
// owns the read-only SQLite access and the report printing.
//
// WHAT IT DOES: reconstructs every session's history request by request (each
// assistant message = one model call; its prompt = all earlier messages and
// parts, restarting at the latest completed compaction summary), runs the real
// planner (src/shared/maskPlan.mjs: planRequest — the same code the plugins
// inline) over it exactly as the V1 plugin would, and prices three scenarios at
// list prices with a prompt-cache model:
//   none     — the history as opencode sent it, simulated by the cache model
//   recorded — the cache read / write tokens the ledger actually recorded
//   sticky   — the history with the planner's sticky trims applied, simulated
//
// CACHE MODEL (per request): the prefix of this request that is byte-identical
// (per unit: kind, call id, text) to the previous request's sent history is a
// cache READ iff the gap since the previous request finished is ≤ the TTL and the
// model did not change; everything else is a cache WRITE. Every prompt token is
// either read (at the cache-read rate) or written (at the cache-write rate) — the
// small uncached tail Anthropic bills as plain input is priced as a write in
// every column, so the three are comparable. OUTPUT tokens are identical across
// scenarios and are excluded.
//
// CALIBRATION: token counts are the planner's own estimate (chars / 4). The
// system prompt + tool definitions are not in the ledger rows' parts, so each
// session carries a constant overhead: (recorded prompt tokens of its first
// priced request) − (the estimate of that request's history), floored at 0. The
// report prints how the simulated no-trim prompt compares with the recorded one.

import {
  adaptV1,
  boundaryOf,
  estInputTokens,
  estTokens,
  planRequest,
  resolveRates,
} from "../../src/shared/maskPlan.mjs";

export const DEFAULT_WINDOW = Object.freeze({
  from: Date.UTC(2026, 9, 17, 9, 0, 0),
  to: Date.UTC(2026, 9, 17, 13, 0, 0),
});
export const MAX_GROWTHS_PER_SESSION = 3;

const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Group raw rows into the plugin's [{info, parts}] shape, sorted (time_created, id). */
export function buildHistory(messageRows, partRows) {
  const msgs = [...messageRows]
    .sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({ info: { ...(typeof r.data === "string" ? JSON.parse(r.data) : r.data), id: r.id, sessionID: r.session_id }, parts: [] }));
  const byId = new Map(msgs.map((m) => [m.info.id, m]));
  let orphanParts = 0;
  const sortedParts = [...partRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sortedParts) {
    const m = byId.get(r.message_id);
    if (!m) {
      orphanParts++;
      continue;
    }
    const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    m.parts.push({ ...data, id: r.id });
  }
  return { messages: msgs, orphanParts };
}

/**
 * A session is unusable when its parts are missing: parts pointing at unknown
 * messages, or a completed assistant turn that produced output but has no parts.
 */
export function hasMissingParts(history) {
  if (history.orphanParts > 0) return true;
  for (const m of history.messages) {
    const i = m.info;
    if (i.role !== "assistant" || i.error) continue;
    const done = typeof i.time?.completed === "number";
    if (done && m.parts.length === 0 && num(i.tokens?.output) > 0) return true;
  }
  return false;
}

/** Index of the first message of request `i`'s prompt: restarts at the latest completed compaction summary. */
export function historyStart(messages, i) {
  for (let j = i - 1; j >= 0; j--) {
    const info = messages[j].info;
    if (info.role === "assistant" && info.summary === true && typeof info.time?.completed === "number") {
      const p = messages.findIndex((m) => m.info.id === info.parentID);
      return p >= 0 && p < j ? p : j;
    }
  }
  return 0;
}

const unitTokens = (u, text) => estTokens(text) + estInputTokens(u.input);

/**
 * Tokens of the sent history and the length (in tokens) of the prefix shared with
 * the previous sent history. `real` is the committed sticky map ({} = untrimmed).
 */
export function sentStats(units, real, prevSent) {
  const sent = new Array(units.length);
  let total = 0;
  let common = 0;
  let matching = prevSent !== null;
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    const text = u.kind === "tool" && u.id !== null && Object.hasOwn(real, u.id) ? real[u.id] : u.text;
    const tok = unitTokens(u, text);
    sent[k] = { id: u.id, kind: u.kind, text };
    total += tok;
    if (matching) {
      const p = prevSent[k];
      if (p && p.kind === u.kind && p.id === u.id && p.text === text) common += tok;
      else matching = false;
    }
  }
  return { sent, total, common };
}

const emptyState = () => ({
  version: 1,
  renderVersion: 1,
  real: {},
  shadow: {},
  reqCount: 0,
  nextGrowthAllowedAt: 0,
  shadowNextGrowthAllowedAt: 0,
  lastModel: null,
  updatedAt: 0,
});

/** $ for `read` + `write` tokens at $/Mtok rates. */
export const dollars = (read, write, rates) => (read * rates.cacheRead + write * rates.cacheWrite) / 1e6;

const zeroCol = () => ({ usd: 0, read: 0, write: 0 });
const add = (col, usd, read, write) => {
  col.usd += usd;
  col.read += read;
  col.write += write;
};

/**
 * Simulate ONE session. `lookupPrice({providerID, modelID})` returns a price
 * record (see resolveRates) or null. Only requests whose creation time is inside
 * [window.from, window.to) are counted; earlier ones are warm-up (the optimizer
 * runs during them, so the sticky map carries over exactly as in production).
 */
export function simulateSession({ history, lookupPrice, policy, window = DEFAULT_WINDOW, ttlMs = 300_000 }) {
  const messages = history.messages;
  const out = {
    none: zeroCol(),
    recorded: zeroCol(),
    sticky: zeroCol(),
    requests: 0,
    unpricedRequests: 0,
    growths: 0,
    growthsInWindow: 0,
    clears: 0,
    simPromptTokens: 0,
    recordedPromptTokens: 0,
    overhead: null,
  };
  let state = emptyState();
  let boundary = null;
  let prevNone = null; // { sent, total, finished, model }
  let prevSticky = null;
  let overhead = null;

  for (let i = 0; i < messages.length; i++) {
    const info = messages[i].info;
    if (info.role !== "assistant") continue;
    const created = num(info.time?.created);
    const model = { providerID: info.providerID, modelID: info.modelID };
    const modelKey = `${model.providerID}/${model.modelID}`;
    const start = historyStart(messages, i);
    const slice = messages.slice(start, i); // strictly before this assistant message
    const adapted = adaptV1(slice);
    const record = lookupPrice(model);
    const rates = record ? (pt) => resolveRates(record, pt, { oneHour: false }) : null;

    // ---- the optimizer, exactly as the V1 plugin runs it
    const counted = { ...state, reqCount: state.reqCount + 1 };
    const plan = planRequest({
      messages: adapted,
      policy,
      authoritative: true,
      rates,
      state: counted,
      boundary,
      model,
      now: () => created,
      lastCompletedMs: adapted.lastCompletedMs,
    });
    state = plan.nextState; // the maps are unchanged when the plan is not dirty; the counters advance
    if (plan.decision === "grow") out.growths++;
    if (plan.decision === "clear") out.clears++;
    boundary = boundaryOf(adapted);

    const inWindow = created >= window.from && created < window.to;
    if (inWindow && plan.decision === "grow") out.growthsInWindow++;

    // ---- the three scenarios' sent histories
    const none = sentStats(adapted.units, {}, prevNone && prevNone.model === modelKey ? prevNone.sent : null);
    const sticky = sentStats(adapted.units, state.real, prevSticky && prevSticky.model === modelKey ? prevSticky.sent : null);

    // calibration constant: the session's first priced request with a recorded prompt
    const tk = info.tokens ?? {};
    const recRead = num(tk.cache?.read);
    const recWrite = num(tk.cache?.write) + num(tk.input);
    const recPrompt = recRead + recWrite;
    if (overhead === null && recPrompt > 0 && record) {
      overhead = Math.max(0, recPrompt - none.total);
      out.overhead = overhead;
    }
    const ovh = overhead ?? 0;

    const gapOf = (prev) => (prev ? Math.max(0, created - prev.finished) : Infinity);
    const sim = (cur, prev) => {
      const P = ovh + cur.total;
      const warm = prev && gapOf(prev) <= ttlMs && prev.model === modelKey;
      const read = warm ? Math.min(ovh + cur.common, prev.P) : 0;
      return { P, read, write: P - read };
    };
    const sNone = sim(none, prevNone);
    const sSticky = sim(sticky, prevSticky);
    const finished = typeof info.time?.completed === "number" ? info.time.completed : created;
    prevNone = { sent: none.sent, P: sNone.P, finished, model: modelKey };
    prevSticky = { sent: sticky.sent, P: sSticky.P, finished, model: modelKey };

    if (!inWindow) continue;
    out.requests++;
    const r = record ? resolveRates(record, sNone.P, { oneHour: false }) : null;
    if (!r) {
      out.unpricedRequests++;
      continue;
    }
    out.simPromptTokens += sNone.P;
    out.recordedPromptTokens += recPrompt;
    add(out.none, dollars(sNone.read, sNone.write, r), sNone.read, sNone.write);
    add(out.recorded, dollars(recRead, recWrite, resolveRates(record, recPrompt || sNone.P, { oneHour: false }) ?? r), recRead, recWrite);
    const rs = resolveRates(record, sSticky.P, { oneHour: false }) ?? r;
    add(out.sticky, dollars(sSticky.read, sSticky.write, rs), sSticky.read, sSticky.write);
  }
  return out;
}

/** Sum per-session results into the report's totals + the pass/fail verdict (spec §9). */
export function summarize(sessions) {
  const total = { none: zeroCol(), recorded: zeroCol(), sticky: zeroCol(), requests: 0, unpricedRequests: 0, growths: 0, growthsInWindow: 0, simPromptTokens: 0, recordedPromptTokens: 0 };
  let maxGrowths = 0;
  for (const s of sessions) {
    for (const k of ["none", "recorded", "sticky"]) add(total[k], s[k].usd, s[k].read, s[k].write);
    for (const k of ["requests", "unpricedRequests", "growths", "growthsInWindow", "simPromptTokens", "recordedPromptTokens"]) total[k] += s[k];
    maxGrowths = Math.max(maxGrowths, s.growthsInWindow);
  }
  const cheaper = total.sticky.usd < total.none.usd;
  const calm = maxGrowths <= MAX_GROWTHS_PER_SESSION;
  return { total, maxGrowths, cheaper, calm, pass: cheaper && calm };
}

const usd = (v) => `$${v.toFixed(2)}`.padStart(10);
const mt = (v) => `${(v / 1e6).toFixed(1)}M`.padStart(8);

/** The report: a three-column table per session and in total, plus the verdict line. */
export function formatReport({ sessions, summary, window, skipped, ttlMs, label = (id) => id }) {
  const lines = [];
  const iso = (t) => new Date(t).toISOString().replace(".000Z", "Z");
  lines.push(`Sticky-trims backtest — window ${iso(window.from)} .. ${iso(window.to)}  (TTL ${Math.round(ttlMs / 1000)}s, list prices, output tokens excluded)`);
  lines.push("");
  lines.push(`${"session".padEnd(26)} ${"reqs".padStart(5)} ${"no trimming".padStart(11)} ${"recorded".padStart(10)} ${"sticky (sim)".padStart(12)} ${"growths".padStart(8)}`);
  for (const s of sessions) {
    lines.push(`${label(s.id).padEnd(26)} ${String(s.requests).padStart(5)} ${usd(s.none.usd).padStart(11)} ${usd(s.recorded.usd).padStart(10)} ${usd(s.sticky.usd).padStart(12)} ${`${s.growthsInWindow}/${s.growths}`.padStart(8)}`);
  }
  const t = summary.total;
  lines.push("-".repeat(78));
  lines.push(`${"TOTAL".padEnd(26)} ${String(t.requests).padStart(5)} ${usd(t.none.usd).padStart(11)} ${usd(t.recorded.usd).padStart(10)} ${usd(t.sticky.usd).padStart(12)} ${`${t.growthsInWindow}/${t.growths}`.padStart(8)}`);
  lines.push("");
  lines.push("cache tokens (read / write):");
  for (const [name, c] of [["no trimming", t.none], ["recorded", t.recorded], ["sticky (sim)", t.sticky]]) {
    lines.push(`  ${name.padEnd(13)} read ${mt(c.read)}   write ${mt(c.write)}`);
  }
  lines.push("");
  const ratio = t.recordedPromptTokens > 0 ? t.simPromptTokens / t.recordedPromptTokens : NaN;
  lines.push(`calibration: simulated no-trim prompt tokens / recorded = ${Number.isFinite(ratio) ? ratio.toFixed(2) : "n/a"} (${mt(t.simPromptTokens)} vs ${mt(t.recordedPromptTokens)})`);
  lines.push(`requests priced: ${t.requests - t.unpricedRequests} of ${t.requests} (unpriced model → excluded from every column)`);
  lines.push(`sessions: ${sessions.length} simulated, ${skipped} skipped (missing parts)`);
  lines.push("");
  const pct = t.none.usd > 0 ? ((1 - t.sticky.usd / t.none.usd) * 100).toFixed(1) : "n/a";
  lines.push(`growths per session (window): max ${summary.maxGrowths} (limit ${MAX_GROWTHS_PER_SESSION}) — ${summary.calm ? "ok" : "TOO MANY"}`);
  lines.push(`simulated sticky ${usd(t.sticky.usd).trim()} vs no-trimming ${usd(t.none.usd).trim()} (${pct}% cheaper) — ${summary.cheaper ? "ok" : "NOT CHEAPER"}`);
  lines.push(summary.pass ? "RESULT: PASS" : "RESULT: FAIL");
  return lines.join("\n");
}

/** Parse "2026-10-17T09:00:00Z" → ms (throws on junk). */
export function parseTime(s) {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`not a time: ${s}`);
  return t;
}

/**
 * Build the `lookupPrice` function from a provider-keyed cost table
 * ({ [providerID]: { [modelID]: costRecord } } — Manta's model-prices.json
 * `providers`) or from opencode's models.json ({ [providerID]: { models: { [id]: { cost } } } }).
 * Exact (providerID, modelID) lookup; never borrows another provider's price.
 */
export function priceLookup(table) {
  return ({ providerID, modelID }) => {
    if (!providerID || !modelID || !table || typeof table !== "object") return null;
    const prov = Object.hasOwn(table, providerID) ? table[providerID] : null;
    if (!prov || typeof prov !== "object") return null;
    const viaModels = prov.models && typeof prov.models === "object" ? prov.models : null;
    const entry = viaModels ? (Object.hasOwn(viaModels, modelID) ? viaModels[modelID] : null) : Object.hasOwn(prov, modelID) ? prov[modelID] : null;
    if (!entry || typeof entry !== "object") return null;
    const cost = viaModels ? entry.cost : entry;
    return cost && typeof cost === "object" ? cost : null;
  };
}
