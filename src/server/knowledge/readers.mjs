// readers.mjs — the transcript readers the knowledge modules take as injected seams (spec §5.2, §6.6, §9.2).
//
// Everything here is a pure function over two injected collaborators:
//   listMessages(sessionID) → [{info:{id, role, time:{created}, tokens, cost, providerID, modelID}, parts:[…V1-shaped]}]
//                             (`oc.listMessages`: opencode's HTTP API, never opencode's database)
//   runDbTask(task, args, {timeoutMs}) → result            (`dbOffload.runDbTask`: the db worker thread, never the main thread)
//
// So no reader touches opencode's SQLite on the event loop; the one that scans history (`lastLoads`) is a
// time-budgeted worker task whose answer may be partial (never "nothing, hung").

import { PART_SQL } from "../opencodeDb.mjs";

const SHELL_TOOLS = /^(bash|shell)$/i;
const DAY_MS = 24 * 3600 * 1000;

const infoOf = (m) => m?.info ?? m ?? {};
const textOf = (m) =>
  (m?.parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("\n");

async function messagesOf(listMessages, sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return null;
  try {
    const all = await listMessages(sessionID);
    return Array.isArray(all) ? all : null;
  } catch {
    return null;
  }
}

/** The shell commands a session ran, in order (`null` when the session can't be read — it proves nothing). */
export function createShellCommandReader({ listMessages }) {
  return async function readShellCommands(sessionID) {
    const all = await messagesOf(listMessages, sessionID);
    if (!all) return null;
    const out = [];
    for (const m of all) {
      for (const p of m?.parts ?? []) {
        if (p?.type !== "tool" || !SHELL_TOOLS.test(String(p.tool ?? ""))) continue;
        const c = p.state?.input?.command;
        if (typeof c === "string" && c.trim()) out.push(c);
      }
    }
    return out;
  };
}

/** `readToolCalls(sessionID) → [{tool, command}]` for the skills evidence bar (shell calls only carry a command). */
export function createToolCallReader({ listMessages }) {
  return async function readToolCalls(sessionID) {
    const all = await messagesOf(listMessages, sessionID);
    if (!all) return [];
    const out = [];
    for (const m of all) {
      for (const p of m?.parts ?? []) {
        if (p?.type !== "tool") continue;
        const c = p.state?.input?.command;
        if (typeof c === "string" && c.trim()) out.push({ tool: String(p.tool ?? ""), command: c });
      }
    }
    return out;
  };
}

/** `readMessage({sessionID, messageID}) → {role, text}|null`. */
export function createSingleMessageReader({ listMessages }) {
  return async function readMessage({ sessionID, messageID } = {}) {
    const all = await messagesOf(listMessages, sessionID);
    const m = all?.find((x) => infoOf(x).id === messageID);
    if (!m) return null;
    return { role: infoOf(m).role === "user" ? "user" : "assistant", text: textOf(m) };
  };
}

/** `listUserRequests(sessionID) → [{id, text}]`: the session's user messages, oldest first. */
export function createUserRequestLister({ listMessages }) {
  return async function listUserRequests(sessionID) {
    const all = await messagesOf(listMessages, sessionID);
    if (!all) return [];
    return all
      .filter((m) => infoOf(m).role === "user")
      .map((m) => ({ id: infoOf(m).id, text: textOf(m) }))
      .filter((m) => typeof m.id === "string" && m.text.trim());
  };
}

/**
 * The trial session's report: its last assistant message with the usage opencode recorded for the session,
 * for the budget (`{text, tokens?, usd?, model?}`).
 */
export function createTrialResultReader({ listMessages }) {
  return async function readResult(sessionID) {
    const all = await messagesOf(listMessages, sessionID);
    if (!all) return { text: "" };
    let text = "";
    let usd = 0;
    let model;
    const tokens = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    let sawUsage = false;
    for (const m of all) {
      const info = infoOf(m);
      if (info.role !== "assistant") continue;
      const t = textOf(m);
      if (t.trim()) text = t;
      if (typeof info.cost === "number") {
        usd += info.cost;
        sawUsage = true;
      }
      if (info.tokens && typeof info.tokens === "object") {
        tokens.input += Number(info.tokens.input) || 0;
        tokens.output += Number(info.tokens.output) || 0;
        tokens.cache.read += Number(info.tokens.cache?.read) || 0;
        tokens.cache.write += Number(info.tokens.cache?.write) || 0;
        sawUsage = true;
      }
      if (info.providerID && info.modelID) model = { providerID: info.providerID, modelID: info.modelID };
    }
    return { text, ...(sawUsage ? { tokens, ...(usd > 0 ? { usd } : {}) } : {}), ...(model ? { model } : {}) };
  };
}

// One session's `skill` tool calls newest first. `/*RANGE*/` is where the worker injects the time window
// (dbTasks.scanWindows); params: session id, since (ms).
export const SKILL_LOAD_SQL = `
  SELECT p.id AS id, p.session_id AS session_id, p.time_created AS time_created,
         json_extract(p.data, '$.state.input.name') AS skill
  FROM ${PART_SQL} p
  WHERE p.session_id = ? AND p.role = 'assistant' AND json_extract(p.data, '$.tool') = 'skill'
    AND p.time_created >= ? /*RANGE*/
  ORDER BY p.time_created DESC`;

/**
 * `lastLoads(names) → {name: ms}`: when each named skill was last loaded by any session in the last 30 days.
 * Sessions that had any message in that range are found with one indexed worker query, then their `skill` tool
 * calls are scanned in the worker, newest first, under a time budget. A partial scan can only under-report a load,
 * which at worst retires a skill a little early; the user can undo it.
 */
export function createSkillLoadReader({ runDbTask, now = Date.now, windowMs = 30 * DAY_MS, budgetMs = 30_000, maxSessions = 400, log = console.warn } = {}) {
  return async function lastLoads(names) {
    const wanted = new Set((names ?? []).filter((n) => typeof n === "string"));
    if (wanted.size === 0) return {};
    const t = now();
    const since = t - windowMs;
    const sessions = await runDbTask("sessionsInRange", { start: since, end: t + 60_000 }, { timeoutMs: 20_000 });
    const scope = (Array.isArray(sessions) ? sessions : []).slice(-maxSessions).map((s) => s.sid);
    if (scope.length === 0) return {};
    const result = await runDbTask("sessionSearch", { scope, sql: SKILL_LOAD_SQL, pattern: since, limit: 2000, perSessionLimit: 200, budgetMs, windowMessages: 100 }, { timeoutMs: budgetMs + 10_000 });
    const out = {};
    for (const r of result?.rows ?? []) {
      const name = typeof r.skill === "string" ? r.skill : null;
      if (!name || !wanted.has(name)) continue;
      if (!(out[name] >= r.time_created)) out[name] = r.time_created;
    }
    if (result && result.complete === false) log("[knowledge] skill load scan was partial");
    return out;
  };
}
