// authRevokeRoute.mjs — `DELETE /auth/revoke` (extracted from index.mjs so the blank-vs-absent `device_id` rule is
// testable at the route level; WS11 D3 / X6).
//
// Manual auth check (this route is exempt from the standard gate so we can distinguish malformed-token → 400
// from missing-token → 401; the gate collapses both into 401). The response is whatever authEngine.revoke
// returns: { ok, status?, error? }. `device_id` targets ONE device for per-device revoke (BET-490); ABSENT →
// the legacy whole-box reset; PRESENT but blank is a client bug and is refused, never a reset.

import { hasBlankDeviceId } from "./settingsViews.mjs";

export async function handleAuthRevoke({ req, url, res, authEngine, respondJson, parseBearer }) {
  const token = parseBearer(req.headers["authorization"]);
  const q = Object.fromEntries(url.searchParams);
  if (hasBlankDeviceId(q)) {
    respondJson(res, 400, { error: "device_id_required" });
    return;
  }
  const result = await authEngine.revoke({
    token,
    device_id: q.device_id ?? q.deviceId ?? null,
  });
  if (!result.ok) {
    respondJson(res, result.status ?? 401, { error: result.error });
    return;
  }
  respondJson(res, 200, {
    ok: true,
    box_id: result.box_id,
    device_id: result.device_id ?? null,
    reset: !!result.reset,
  });
}
