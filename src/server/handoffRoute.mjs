// handoffRoute.mjs — the REST face of auto-handoff (spec §11), extracted from
// index.mjs on the projectsRoute/uploadRoute pattern so the real route logic is
// unit-testable without a live HTTP server. The rpc channels (rpc.mjs, §15) are
// the other face; both call the same engine methods.
//
// Error bodies follow BET-1460 class 1 (a client renders them): known failures
// are `{error: code, message}` with a human, safe message; anything unexpected
// goes through respondSafe500 (safe literal in the body, detail in the log).

import { ERROR_STATUS, HandoffError } from "./handoff/engine.mjs";
import { respondSafe500 } from "./safeApiError.mjs";

export const HANDOFF_SAFE_500_MESSAGE = "The handoff service hit an unexpected error.";

const ID_RE = /^hof_[a-z0-9]{20}$/;

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * @param {{ engine: any, readJson: (req: any) => Promise<any> }} deps
 * @returns {(req: any, res: any, url: URL) => Promise<boolean>} true when the path was a handoff route
 */
export function createHandoffHandler({ engine, readJson: rawReadJson }) {
  const readJson = (req) =>
    rawReadJson(req).catch(() => {
      throw new HandoffError("invalid", "The request body isn't valid JSON.");
    });
  return async function handleHandoff(req, res, url) {
    const path = url.pathname;
    if (path !== "/api/handoff" && !path.startsWith("/api/handoff/")) return false;
    try {
      if (path === "/api/handoff") {
        if (req.method === "POST") {
          const body = await readJson(req);
          const handoff = await engine.create({
            sessionId: body?.sessionId,
            trigger: body?.trigger,
            action: body?.action,
            goal: body?.goal,
            body: body?.body,
          });
          send(res, 200, { handoff });
          return true;
        }
        if (req.method === "GET") {
          send(res, 200, await engine.list({ sessionId: url.searchParams.get("sessionId") ?? "" }));
          return true;
        }
        send(res, 405, { error: "method_not_allowed", message: "Method not allowed." });
        return true;
      }
      if (path === "/api/handoff/mode") {
        if (req.method !== "POST") {
          send(res, 405, { error: "method_not_allowed", message: "Method not allowed." });
          return true;
        }
        const body = await readJson(req);
        send(res, 200, { mode: await engine.setMode(body?.sessionId, body?.mode) });
        return true;
      }
      const m = path.match(/^\/api\/handoff\/([^/]+)(?:\/(start|retry|rewrite|dismiss|draft-consumed))?$/);
      if (!m || !ID_RE.test(m[1])) {
        send(res, 404, { error: "expired", message: "This handoff has expired." });
        return true;
      }
      const [, id, action] = m;
      if (!action && req.method === "GET") {
        const handoff = engine.get(id);
        if (!handoff) send(res, 404, { error: "expired", message: "This handoff has expired." });
        else send(res, 200, { handoff });
        return true;
      }
      if (action && req.method === "POST") {
        const body = await readJson(req);
        if (action === "start") {
          send(res, 200, { handoff: await engine.start(id, { how: body?.how, disposition: body?.disposition, text: body?.text }) });
        } else if (action === "retry") {
          send(res, 200, { handoff: await engine.retry(id) });
        } else if (action === "rewrite") {
          send(res, 200, { handoff: await engine.rewrite(id) });
        } else if (action === "dismiss") {
          send(res, 200, { handoff: await engine.dismiss(id) });
        } else {
          await engine.draftConsumed(id, body?.draftRevision);
          send(res, 204);
        }
        return true;
      }
      send(res, 405, { error: "method_not_allowed", message: "Method not allowed." });
      return true;
    } catch (e) {
      if (e?.name === "HandoffError" && ERROR_STATUS[e.code]) {
        send(res, ERROR_STATUS[e.code], { error: e.code, message: e.message, ...(e.handoff ? { handoff: e.handoff } : {}) });
        return true;
      }
      respondSafe500(res, "handoff", HANDOFF_SAFE_500_MESSAGE, e);
      return true;
    }
  };
}
