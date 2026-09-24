import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { authorizeCtoProjectMutation as authorize } from "./ctoConversation.mjs";

const authorizeCtoProjectMutation = (tool, sessionID, state) => authorize(tool, sessionID, state, "cto");

const mutation = { name: "work_dispatch", mode: "goal" };
const state = (agent = "cto", status = "accepted") => ({
  binding: { sessionId: "ses_cto" },
  submissions: [{ sessionId: "ses_cto", agent, status }],
});

test("only the bound CTO execution turn can invoke project mutations, regardless of approval/trust", () => {
  assert.deepEqual(authorizeCtoProjectMutation(mutation, "ses_cto", state()), { ok: true });
  for (const [caller, view] of [
    ["ses_worker", state()], ["ses_old_cto", state()], [undefined, state()],
    ["ses_cto", state("cto-plan")], ["ses_cto", state("build")],
    ["ses_cto", state("cto", "completed")], ["ses_cto", state("cto", "interrupt_pending")],
    ["ses_cto", null],
  ]) {
    const result = authorizeCtoProjectMutation(mutation, caller, view);
    assert.equal(result.ok, false);
    assert.equal(result.code, "policy_blocked");
    assert.equal(result.retrySafe, false);
  }
});

test("read-only work/project/session discovery stays available to other sessions and plan mode", () => {
  for (const name of ["work_inspect", "projects_list", "sessions_list", "describe_tools"]) {
    assert.deepEqual(authorizeCtoProjectMutation({ name, mode: "auto" }, "ses_worker", null), { ok: true });
  }
});

test("production route authorizes before processing approval ids or dispatch", async () => {
  const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
  const route = source.split('if (path === "/api/cto")')[1].split('// ---------- Inline media')[0];
  const guard = route.indexOf("authorizeCtoProjectMutation(");
  assert.ok(guard >= 0);
  const goalCreationGrant = route.indexOf("engine.authorizeGoalCreation(");
  const goalMutationGrant = route.indexOf("engine.authorizeGoalMutation(");
  assert.ok(guard < route.indexOf("engine.approveConfirm("));
  assert.ok(guard < route.indexOf("engine.dispatch("));
  assert.ok(goalCreationGrant > guard && goalCreationGrant < route.indexOf("engine.dispatch("));
  assert.ok(goalMutationGrant > guard && goalMutationGrant < route.indexOf("engine.dispatch("));
  assert.match(route, /definition\?\.mode === "goal"\s*\?\s*goalScopedAuthorization\s*\?\s*\[definition\.name\]\s*:\s*\[\]/);
  assert.match(route, /Goal-mode tools deliberately ignore the global trustedActions list/);
  assert.match(route, /grant\?\.workRevision/);
  assert.match(route, /goalAuthorizationRevision,/);
  assert.match(route, /respondJson\(res, 403, authorization\);\s*return;/);
});
