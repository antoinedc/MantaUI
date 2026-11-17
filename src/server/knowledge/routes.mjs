// routes.mjs — the AI-facing HTTP surface of the knowledge subsystem (spec §11.2) and the
// desktop RPC channels (§11.6), as thin adapters over the engine.
//
//   POST /api/knowledge/notes           {sessionID, kind, text, refs[]} → {accepted, id | reason}
//   GET  /api/knowledge/search          ?sessionID&query&scope&sources&limit → {hits[], truncated}
//   GET  /api/knowledge/page            ?sessionID&ref → page | session neighbourhood
//   GET  /api/knowledge/briefing        ?sessionID&directory&assistantMessages → {text, token}
//   POST /api/knowledge/briefing/ack    {sessionID, token} → {ok:true} | 409 stale-token
//   POST /api/knowledge/briefing/reset  {sessionID} → {ok:true}
//
// Errors are class-2 (BET-1460): consumed by the manta opencode tools, which relay the message
// to the model. A KnowledgeError carries its own status and code (`invalid-note`,
// `invalid-query`, `not-found`, `not-shared`, `disabled`, `stale-token`); the briefing routes
// never error (a failure answers `{text:"", token:null}`).

import { isKnowledgeError } from "./errors.mjs";

const errBody = (e) => ({ error: e.code, message: e.message });

/**
 * @returns {Promise<boolean>} true when the request was a knowledge route (and has been answered).
 */
export async function handleKnowledgeRoute({ engine, req, res, path, url, readJsonBody, respondJson }) {
  if (!path.startsWith("/api/knowledge/")) return false;
  const sub = path.slice("/api/knowledge/".length);
  const q = (k) => url.searchParams.get(k) ?? undefined;
  const method = req.method;
  try {
    if (sub === "notes") {
      if (method !== "POST") return void respondJson(res, 405, { error: "method not allowed" }), true;
      const body = (await readJsonBody(req)) ?? {};
      respondJson(res, 200, await engine.enqueueNote({ sessionID: body.sessionID, kind: body.kind, text: body.text, refs: body.refs }));
      return true;
    }
    if (sub === "search") {
      if (method !== "GET") return void respondJson(res, 405, { error: "method not allowed" }), true;
      const sources = q("sources");
      respondJson(res, 200, await engine.search({ sessionID: q("sessionID"), query: q("query"), scope: q("scope"), sources: sources === undefined ? undefined : sources.split(",").map((s) => s.trim()).filter(Boolean), limit: q("limit") === undefined ? undefined : Number(q("limit")) }));
      return true;
    }
    if (sub === "page") {
      if (method !== "GET") return void respondJson(res, 405, { error: "method not allowed" }), true;
      respondJson(res, 200, await engine.readPage({ sessionID: q("sessionID"), ref: q("ref") }));
      return true;
    }
    if (sub === "briefing") {
      if (method !== "GET") return void respondJson(res, 405, { error: "method not allowed" }), true;
      respondJson(res, 200, await engine.briefing({ sessionID: q("sessionID"), directory: q("directory"), assistantMessages: q("assistantMessages") === undefined ? undefined : Number(q("assistantMessages")) }));
      return true;
    }
    if (sub === "briefing/ack") {
      if (method !== "POST") return void respondJson(res, 405, { error: "method not allowed" }), true;
      const body = (await readJsonBody(req)) ?? {};
      respondJson(res, 200, await engine.briefingAck({ sessionID: body.sessionID, token: body.token }));
      return true;
    }
    if (sub === "briefing/reset") {
      if (method !== "POST") return void respondJson(res, 405, { error: "method not allowed" }), true;
      const body = (await readJsonBody(req)) ?? {};
      respondJson(res, 200, await engine.briefingReset({ sessionID: body.sessionID }));
      return true;
    }
    respondJson(res, 404, { error: "not found" });
    return true;
  } catch (e) {
    if (sub === "briefing") {
      respondJson(res, 200, { text: "", token: null });
      return true;
    }
    if (isKnowledgeError(e)) {
      respondJson(res, e.status, errBody(e));
      return true;
    }
    // class-2 (BET-1460): knowledge_* opencode tools — relays the message to the model.
    respondJson(res, 500, { error: String(e?.message ?? e) });
    return true;
  }
}

/** The `knowledge:*` RPC channels for rpc.mjs `buildHandlers` (the desktop Knowledge card). */
export function buildKnowledgeChannels(engine) {
  const need = () => {
    if (!engine) throw Object.assign(new Error("Shared knowledge isn't available on this box."), { rpcStatus: 503 });
    return engine;
  };
  return {
    "knowledge:status": () => need().status(),
    "knowledge:settings-get": () => need().settingsGet(),
    "knowledge:settings-set": (args) => need().settingsSet(args && typeof args === "object" && "patch" in args ? args.patch : args),
    "knowledge:changes": (args) => need().changes(args ?? {}),
    "knowledge:undo": (args) => need().undo(args ?? {}),
  };
}
