import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPushEvent } from "./push.mjs";

const NOFOCUS = { focusSessionId: null, focusVisible: false, wasBusy: false };

test("permission.asked → permission notification", () => {
  const p = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_1", id: "per_1" } },
    NOFOCUS,
  );
  assert.equal(p?.kind, "permission");
  assert.equal(p?.sessionId, "ses_1");
  assert.equal(p?.tag, "perm-ses_1");
});

test("question.asked → question notification", () => {
  const p = classifyPushEvent(
    { type: "question.asked", properties: { sessionID: "ses_2" } },
    NOFOCUS,
  );
  assert.equal(p?.kind, "question");
  assert.equal(p?.sessionId, "ses_2");
});

test("session.error → error notification carrying the message", () => {
  const p = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_3", message: "boom" } },
    NOFOCUS,
  );
  assert.equal(p?.kind, "error");
  assert.match(p?.body ?? "", /boom/);
});

test("session.idle with no prior busy → no notification (spurious idle)", () => {
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_4" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false },
  );
  assert.equal(p, null);
});

test("session.idle after busy, not viewing → done notification", () => {
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_5" } },
    { focusSessionId: null, focusVisible: false, wasBusy: true },
  );
  assert.equal(p?.kind, "done");
  assert.equal(p?.sessionId, "ses_5");
});

test("session.idle after busy, viewing that session → suppressed", () => {
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_6" } },
    { focusSessionId: "ses_6", focusVisible: true, wasBusy: true },
  );
  assert.equal(p, null);
});

test("session.idle after busy, viewing a DIFFERENT session → done notification", () => {
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_7" } },
    { focusSessionId: "ses_other", focusVisible: true, wasBusy: true },
  );
  assert.equal(p?.kind, "done");
});

test("session.idle after busy, app backgrounded on that session → done notification", () => {
  // visible:false means the app isn't foreground, so even the watched session
  // should notify (the user can't see it).
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_8" } },
    { focusSessionId: "ses_8", focusVisible: false, wasBusy: true },
  );
  assert.equal(p?.kind, "done");
});

test("session.idle while a question/permission is pending → suppressed (not 'done')", () => {
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_9" } },
    {
      focusSessionId: null,
      focusVisible: false,
      wasBusy: true,
      pendingAttention: true,
    },
  );
  assert.equal(p, null);
});

test("unrelated event → null", () => {
  assert.equal(
    classifyPushEvent({ type: "message.part.delta", properties: {} }, NOFOCUS),
    null,
  );
});
