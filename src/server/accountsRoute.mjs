// /api/accounts/resolve and /api/accounts/refresh — extracted from index.mjs
// (the projectsRoute.mjs pattern) so the REAL route logic is testable, and so a
// harness can serve it without booting the whole server.
//
// The ONLY consumer is the manta-accounts opencode plugin. Both routes answer
// `{seatId, live:true}` or `{seatId, live:false, accessToken, accountId?,
// expiresAt?}`. The token is returned over the Bearer-gated loopback API and is
// never logged. 400 on bad input, 404 on an unknown seat, 405 on a wrong method.
// A thrown error is the caller's to turn into a 500 (index.mjs owns that, with
// its class-2 marker).

const PROVIDERS = ["claude", "codex"];
const MAX_ID = 200;

export const ACCOUNTS_ROUTE_PATHS = ["/api/accounts/resolve", "/api/accounts/refresh"];

/**
 * @param {{ seatAssigner: {resolve: Function, refreshSeat: Function},
 *           readJson: (req: any) => Promise<any>,
 *           respondJson: (res: any, status: number, body: object) => void }} deps
 */
export function createAccountsRouteHandler({ seatAssigner, readJson, respondJson }) {
  /** @returns {Promise<boolean>} true when the path was one of ours (and answered) */
  return async function handleAccountsRoute(req, res, url) {
    const path = url.pathname;
    if (!ACCOUNTS_ROUTE_PATHS.includes(path)) return false;
    const isResolve = path === ACCOUNTS_ROUTE_PATHS[0];
    if (req.method !== (isResolve ? "GET" : "POST")) {
      respondJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (isResolve) {
      const provider = url.searchParams.get("provider") || "";
      const sessionID = url.searchParams.get("sessionID") || "";
      const parentSessionID = url.searchParams.get("parentSessionID") || null;
      if (!PROVIDERS.includes(provider) || !sessionID || sessionID.length > MAX_ID || (parentSessionID && parentSessionID.length > MAX_ID)) {
        respondJson(res, 400, { error: "invalid" });
        return true;
      }
      respondJson(res, 200, await seatAssigner.resolve(provider, sessionID, parentSessionID));
      return true;
    }
    const body = await readJson(req).catch(() => null);
    const provider = body?.provider;
    const seatId = body?.seatId;
    if (!PROVIDERS.includes(provider) || typeof seatId !== "string" || !seatId || seatId.length > MAX_ID) {
      respondJson(res, 400, { error: "invalid" });
      return true;
    }
    const result = await seatAssigner.refreshSeat(provider, seatId);
    if (!result) {
      respondJson(res, 404, { error: "unknown seat" });
      return true;
    }
    respondJson(res, 200, result);
    return true;
  };
}
