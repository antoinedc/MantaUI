import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthRevoke } from "./authRevokeRoute.mjs";

function run(query, revokeResult = { ok: true, box_id: "b", device_id: null, reset: true }) {
  const calls = [];
  const sent = [];
  return handleAuthRevoke({
    req: { headers: { authorization: "Bearer tok" } },
    url: new URL(`http://x/auth/revoke${query}`),
    res: {},
    authEngine: { revoke: async (a) => (calls.push(a), revokeResult) },
    respondJson: (_res, status, body) => sent.push({ status, body }),
    parseBearer: (h) => String(h).replace(/^Bearer /, ""),
  }).then(() => ({ calls, sent }));
}

test("DELETE /auth/revoke: a PRESENT but blank device_id is refused and never reaches the whole-identity reset (WS11 D3 / X6)", async () => {
  for (const q of ["?device_id=", "?device_id=%20%20", "?deviceId="]) {
    const { calls, sent } = await run(q);
    assert.deepEqual(sent, [{ status: 400, body: { error: "device_id_required" } }], q);
    assert.equal(calls.length, 0, `${q}: revoke must not run`);
  }
});

test("DELETE /auth/revoke: an ABSENT device_id keeps its whole-identity-reset meaning; a real one targets that device", async () => {
  const absent = await run("");
  assert.deepEqual(absent.calls, [{ token: "tok", device_id: null }]);
  assert.equal(absent.sent[0].status, 200);
  assert.equal(absent.sent[0].body.reset, true);
  const one = await run("?device_id=dev1", { ok: true, box_id: "b", device_id: "dev1", reset: false });
  assert.deepEqual(one.calls, [{ token: "tok", device_id: "dev1" }]);
  assert.equal(one.sent[0].body.device_id, "dev1");
});

test("DELETE /auth/revoke: an engine refusal is relayed with its own status", async () => {
  const { sent } = await run("?device_id=d", { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(sent, [{ status: 401, body: { error: "unauthorized" } }]);
});
