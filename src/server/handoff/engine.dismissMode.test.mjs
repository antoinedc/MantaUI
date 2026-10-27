// Dismissing a handoff card (the session stops being offered handoffs) and the
// per-session handoff mode. Spec: 2026-10-27-handoff-card-inline-dismiss-per-session-mode.md §4–§5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_STATUS } from "./engine.mjs";
import { emptyState, normalizeState } from "./state.mjs";
import { FULL_BODY, readyRecord, settle, standardWorld } from "./testWorld.mjs";

const OPUS = { providerID: "anthropic", modelID: "claude-opus-4-8" };

/** One turn over the context budget, replayed as lifecycle events. */
async function overBudgetTurn(engine, sid, ctx = 250_000) {
  const ev = (type, properties) => engine.observeEvent({ type, properties: { sessionID: sid, ...properties } });
  ev("session.status", { status: { type: "busy" } });
  ev("session.next.step.ended", { tokens: { input: ctx, cache: { read: 0, write: 0 } }, ...OPUS });
  ev("session.status", { status: { type: "idle" } });
  ev("session.idle", {});
  await settle(10);
}
const recordsOf = (w, sid = "ses_p") => Object.values(w.engine._state.records).filter((r) => r.fromSessionId === sid);

// ---- dismiss ---------------------------------------------------------------------

test("dismiss: a ready or failed card becomes dismissed, the session is marked, a bus event and a persisted state follow", async () => {
  const w = standardWorld();
  const ready = await readyRecord(w);
  const out = await w.engine.dismiss(ready.id);
  assert.equal(out.state, "dismissed");
  assert.equal(out.id, ready.id);
  assert.equal(out.internal, undefined, "the public view");
  assert.equal(typeof w.engine._state.dismissedSessions.ses_p, "number");
  assert.ok(w.published.some((e) => e.kind === "handoff" && e.payload.id === ready.id && e.payload.state === "dismissed"));
  assert.equal(JSON.parse(w.disk.json).dismissedSessions.ses_p, w.engine._state.dismissedSessions.ses_p, "persisted");
  assert.equal((await w.engine.list({ sessionId: "ses_p" })).dismissed, true);

  const f = standardWorld();
  f.failures.generate.push({}, {});
  const rec = await f.engine.create({ sessionId: "ses_p", trigger: "user" });
  await settle();
  assert.equal(f.engine.get(rec.id).state, "failed");
  assert.equal((await f.engine.dismiss(rec.id)).state, "dismissed");
});

test("dismiss: only ready/failed can be dismissed (not_ready), unknown ids are expired, a second dismiss is not_ready", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  await w.engine.dismiss(r.id);
  await assert.rejects(w.engine.dismiss(r.id), (e) => e.code === "not_ready" && e.message === "This handoff can no longer be dismissed." && e.handoff?.state === "dismissed");
  await assert.rejects(w.engine.dismiss("hof_nope"), (e) => e.code === "expired");

  const c = standardWorld();
  const committed = await readyRecord(c);
  await c.engine.start(committed.id, { how: "clear", disposition: "send" });
  await assert.rejects(c.engine.dismiss(committed.id), (e) => e.code === "not_ready");
  assert.equal(c.engine._state.dismissedSessions.ses_p, undefined, "a refused dismissal marks nothing");

  const g = standardWorld();
  const requested = await g.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: "## Goal\nthin" });
  assert.equal(requested.state, "requested");
  await assert.rejects(g.engine.dismiss(requested.id), (e) => e.code === "not_ready");
});

test("a dismissed session gets no automatic handoff — neither a card (suggest) nor a start (auto)", async () => {
  for (const mode of ["suggest", "auto"]) {
    const w = standardWorld({ mode });
    const r = await readyRecord(w);
    await w.engine.dismiss(r.id);
    await overBudgetTurn(w.engine, "ses_p");
    assert.deepEqual(recordsOf(w).map((x) => x.id), [r.id], `${mode}: nothing new`);
    assert.equal(w.generateCalls.length, 0, `${mode}: no generation was paid for`);
    assert.equal(w.created.length, 0);
  }
});

test("a dismissed session refuses the agent's handoff tool (both actions) with the dismissed code; /handoff and the button still make a card and keep the dismissal", async () => {
  const w = standardWorld();
  await w.engine.dismiss((await readyRecord(w)).id);
  const before = Object.keys(w.engine._state.records).length;
  for (const action of ["suggest", "handoff"]) {
    await assert.rejects(
      w.engine.create({ sessionId: "ses_p", trigger: "agent", action, body: FULL_BODY }),
      (e) => e.code === "dismissed" && /The user dismissed handoff suggestions in this conversation\. Do not suggest a handoff again unless the user asks\./.test(e.message),
    );
  }
  assert.equal(Object.keys(w.engine._state.records).length, before, "no record was created for the refused calls");
  for (const trigger of ["user", "button"]) {
    const rec = await w.engine.create({ sessionId: "ses_p", trigger });
    assert.equal(rec.state, "generating", trigger);
    await settle();
    assert.equal(w.engine.get(rec.id).state, "ready", trigger);
  }
  assert.equal((await w.engine.list({ sessionId: "ses_p" })).dismissed, true, "an explicit request does not clear the dismissal");
});

test("dismissed is a 409 error code", () => {
  assert.equal(ERROR_STATUS.dismissed, 409);
});

test("policyFor reports mode off for a dismissed session (the plugin stops nudging), whatever its mode", async () => {
  const w = standardWorld();
  await overBudgetTurn(w.engine, "ses_p", 120_000);
  assert.equal((await w.engine.policyFor("ses_p")).mode, "auto");
  await w.engine.dismiss((await readyRecord(w)).id);
  assert.equal((await w.engine.policyFor("ses_p")).mode, "off");
  assert.equal((await w.engine.list({ sessionId: "ses_p" })).mode, "auto", "the mode itself is untouched");
});

test("a session created by a handoff starts undismissed (and the agent tool works there)", async () => {
  const w = standardWorld();
  const first = await readyRecord(w);
  await w.engine.dismiss(first.id);
  const card = await w.engine.create({ sessionId: "ses_p", trigger: "user" });
  await settle();
  const out = await w.engine.start(card.id, { how: "clear", disposition: "send" });
  const succ = out.successorId;
  assert.equal((await w.engine.list({ sessionId: succ })).dismissed, false);
  const rec = await w.engine.create({ sessionId: succ, trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.state, "ready");
  // The predecessor id resolves to the successor too, so the old dismissal does not follow the chain.
  const viaOld = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(viaOld.fromSessionId, succ);
});

test("a deleted session drops its dismissal and its own mode", async () => {
  const w = standardWorld();
  await w.engine.dismiss((await readyRecord(w)).id);
  await w.engine.setMode("ses_p", "off");
  w.engine.observeEvent({ type: "session.deleted", properties: { info: { id: "ses_p" } } });
  assert.equal(w.engine._state.dismissedSessions.ses_p, undefined);
  assert.equal(w.engine._state.sessionModes.ses_p, undefined);
  await settle();
  const disk = JSON.parse(w.disk.json);
  assert.deepEqual([disk.dismissedSessions, disk.sessionModes], [{}, {}]);
});

// ---- per-session mode ---------------------------------------------------------------

test("mode: a session without its own value reads the box default; setMode gives it its own; two sessions are independent", async () => {
  const w = standardWorld({ mode: "suggest" });
  w.addSession("ses_q");
  assert.deepEqual(pick(await w.engine.list({ sessionId: "ses_p" })), { mode: "suggest", modeIsDefault: true, dismissed: false });
  assert.equal(await w.engine.setMode("ses_p", "off"), "off");
  assert.deepEqual(pick(await w.engine.list({ sessionId: "ses_p" })), { mode: "off", modeIsDefault: false, dismissed: false });
  assert.deepEqual(pick(await w.engine.list({ sessionId: "ses_q" })), { mode: "suggest", modeIsDefault: true, dismissed: false }, "another session is untouched");
  w.mode = "auto"; // the box default moves: only the session without its own value follows
  assert.equal((await w.engine.list({ sessionId: "ses_q" })).mode, "auto");
  assert.equal((await w.engine.list({ sessionId: "ses_p" })).mode, "off");
  assert.equal(await w.engine.modeFor("ses_p"), "off");
  assert.equal(await w.engine.modeFor("ses_q"), "auto");
});
const pick = ({ mode, modeIsDefault, dismissed }) => ({ mode, modeIsDefault, dismissed });

test("mode: setMode validates its input", async () => {
  const w = standardWorld();
  await assert.rejects(w.engine.setMode("ses_p", "sometimes"), (e) => e.code === "invalid");
  await assert.rejects(w.engine.setMode("ses_p", undefined), (e) => e.code === "invalid");
  await assert.rejects(w.engine.setMode("", "off"), (e) => e.code === "invalid");
  assert.equal(w.engine._state.sessionModes.ses_p, undefined);
});

test("mode: create uses the session's own mode — the agent's handoff action is a card in suggest, a queued start in auto", async () => {
  const w = standardWorld({ mode: "auto" });
  await w.engine.setMode("ses_p", "suggest");
  assert.equal((await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY })).state, "ready");
  const x = standardWorld({ mode: "suggest" });
  await x.engine.setMode("ses_p", "auto");
  assert.equal((await x.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY })).state, "requested");
});

test("mode: the turn-end trigger uses the session's own mode (auto → replaces, suggest → card, off → nothing)", async () => {
  const auto = standardWorld({ mode: "off" });
  await auto.engine.setMode("ses_p", "auto");
  await overBudgetTurn(auto.engine, "ses_p");
  assert.equal(recordsOf(auto)[0]?.state, "committed");

  const suggest = standardWorld({ mode: "auto" });
  await suggest.engine.setMode("ses_p", "suggest");
  await overBudgetTurn(suggest.engine, "ses_p");
  assert.equal(recordsOf(suggest)[0]?.state, "ready");
  assert.equal(suggest.created.length, 0);

  const off = standardWorld({ mode: "auto" });
  await off.engine.setMode("ses_p", "off");
  await overBudgetTurn(off.engine, "ses_p");
  assert.equal(recordsOf(off).length, 0);
  assert.equal(off.generateCalls.length, 0);
});

test("mode: a replacement inherits the predecessor's effective mode, stored explicitly; a session made any other way does not", async () => {
  // own value
  const w = standardWorld({ mode: "auto" });
  await w.engine.setMode("ses_p", "suggest");
  const r = await readyRecord(w);
  const succ = (await w.engine.start(r.id, { how: "clear", disposition: "send" })).successorId;
  assert.equal(w.engine._state.sessionModes[succ], "suggest");
  assert.deepEqual(pick(await w.engine.list({ sessionId: succ })), { mode: "suggest", modeIsDefault: false, dismissed: false });

  // default value: copied as an explicit value, so a later change of the box default does not move the successor
  const d = standardWorld({ mode: "suggest" });
  const dr = await readyRecord(d);
  const dsucc = (await d.engine.start(dr.id, { how: "clear", disposition: "send" })).successorId;
  d.mode = "off";
  assert.equal((await d.engine.list({ sessionId: dsucc })).mode, "suggest");
  assert.equal((await d.engine.list({ sessionId: dsucc })).modeIsDefault, false);

  // a /clear-style session (nothing links it to ses_p) follows the box default
  d.addSession("ses_cleared");
  assert.deepEqual(pick(await d.engine.list({ sessionId: "ses_cleared" })), { mode: "off", modeIsDefault: true, dismissed: false });
});

test("mode: a branch inherits too, and an explicit value on the successor is never overwritten", async () => {
  const w = standardWorld({ mode: "auto" });
  await w.engine.setMode("ses_p", "off");
  const r = await readyRecord(w);
  const succ = (await w.engine.start(r.id, { how: "new-session", disposition: "draft" })).successorId;
  assert.equal(w.engine._state.sessionModes[succ], "off");

  const x = standardWorld({ mode: "auto" });
  await x.engine.setMode("ses_p", "off");
  const xr = await readyRecord(x);
  const e = x.build({ mintSessionId: () => "ses_preset" });
  await e.setMode("ses_preset", "suggest");
  const out = await e.start(xr.id, { how: "clear", disposition: "draft" });
  assert.equal(out.successorId, "ses_preset");
  assert.equal(e._state.sessionModes.ses_preset, "suggest");
});

// ---- persistence ---------------------------------------------------------------------

test("persistence: dismissed sessions and per-session modes survive a restart; a file from before these keys still loads", async () => {
  const w = standardWorld();
  await w.engine.dismiss((await readyRecord(w)).id);
  await w.engine.setMode("ses_p", "off");
  const again = w.build();
  assert.equal(typeof again._state.dismissedSessions.ses_p, "number");
  assert.equal(again._state.sessionModes.ses_p, "off");
  assert.deepEqual(pick(await again.list({ sessionId: "ses_p" })), { mode: "off", modeIsDefault: false, dismissed: true });

  const old = { version: 1, records: {}, links: {}, continuations: {}, fences: {}, held: {} };
  const s = normalizeState(old);
  assert.deepEqual(s.dismissedSessions, {});
  assert.deepEqual(s.sessionModes, {});
  assert.deepEqual(normalizeState(null), emptyState());
  const junk = normalizeState({ dismissedSessions: { a: 5, b: "x" }, sessionModes: { a: "off", b: "maybe" } });
  assert.deepEqual([junk.dismissedSessions, junk.sessionModes], [{ a: 5 }, { a: "off" }]);
});
