import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  classifyPushEvent,
  buildSessionLabel,
  shouldSuppressForDesktop,
  shouldSuppressUnresolvedNotification,
  routeNotification,
  notifTier,
  fireNotify,
  setDesktopPresence,
  setDesktopSink,
  cancelEscalationsForSession,
  cancelAllEscalations,
  _pendingEscalationTags,
  _resetPushState,
  addApnsToken,
  removeApnsToken,
  sendApnsFanout,
  _loadApnsTokensForTest,
  _setFanoutFakesForTest,
  _resetFanoutFakesForTest,
  ESCALATE_MS,
  DESKTOP_PRESENCE_TTL_MS,
  DESKTOP_GRACE_MS,
} from "./push.mjs";

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

test("question.asked carries the question text + option actions (single select)", () => {
  const p = classifyPushEvent(
    {
      type: "question.asked",
      properties: {
        id: "que_abc",
        sessionID: "ses_q",
        questions: [
          {
            header: "Deploy?",
            question: "Should I deploy to production now?",
            options: [
              { label: "Yes", description: "" },
              { label: "No", description: "" },
              { label: "Wait", description: "" },
            ],
          },
        ],
      },
    },
    NOFOCUS,
  );
  assert.equal(p?.requestId, "que_abc");
  assert.match(p?.title ?? "", /Deploy\?/);
  assert.equal(p?.body, "Should I deploy to production now?");
  assert.deepEqual(p?.answers, ["Yes", "No", "Wait"]);
  assert.deepEqual(p?.actions, [
    { action: "ans:0", title: "Yes" },
    { action: "ans:1", title: "No" },
    { action: "ans:2", title: "Wait" },
  ]);
});

test("question.asked with multi-select → text but NO quick actions", () => {
  const p = classifyPushEvent(
    {
      type: "question.asked",
      properties: {
        id: "que_m",
        sessionID: "ses_q2",
        questions: [
          {
            header: "Pick",
            question: "Choose all that apply",
            multiple: true,
            options: [{ label: "A", description: "" }, { label: "B", description: "" }],
          },
        ],
      },
    },
    NOFOCUS,
  );
  assert.equal(p?.body, "Choose all that apply");
  assert.equal(p?.actions, undefined);
});

test("question.asked with multiple questions → no quick actions (open app)", () => {
  const p = classifyPushEvent(
    {
      type: "question.asked",
      properties: {
        id: "que_multi",
        sessionID: "ses_q3",
        questions: [
          { header: "One", question: "Q1?", options: [{ label: "a", description: "" }] },
          { header: "Two", question: "Q2?", options: [{ label: "b", description: "" }] },
        ],
      },
    },
    NOFOCUS,
  );
  assert.equal(p?.actions, undefined);
});

test("session.error → error notification carrying the message", () => {
  const p = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_3", message: "boom" } },
    NOFOCUS,
  );
  assert.equal(p?.kind, "error");
  assert.match(p?.body ?? "", /boom/);
});

test("session.error MessageAbortedError → NO push (intentional abort/drain)", () => {
  // Mid-flight queued-message drain (and explicit user abort) both surface as
  // a MessageAbortedError session.error. The renderer swallows the banner
  // client-side; the server must drop the push so a transparent turn-swap
  // doesn't buzz the phone with "Error — The turn failed."
  const p = classifyPushEvent(
    {
      type: "session.error",
      properties: {
        sessionID: "ses_abort",
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      },
    },
    NOFOCUS,
  );
  assert.equal(p, null);
});

test("session.error with non-abort error object → still notifies", () => {
  const p = classifyPushEvent(
    {
      type: "session.error",
      properties: {
        sessionID: "ses_err",
        message: "real failure",
        error: { name: "ProviderAuthError" },
      },
    },
    NOFOCUS,
  );
  assert.equal(p?.kind, "error");
  assert.match(p?.body ?? "", /real failure/);
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

test("session.idle 'done' uses the resolved workspace/session label as title", () => {
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_lbl" } },
    {
      focusSessionId: null,
      focusVisible: false,
      wasBusy: true,
      label: "default / my-chat",
    },
  );
  assert.equal(p?.kind, "done");
  assert.equal(p?.title, "default / my-chat");
});

test("session.idle 'done' falls back to generic title when no label", () => {
  const p = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_lbl2" } },
    { focusSessionId: null, focusVisible: false, wasBusy: true, label: null },
  );
  assert.equal(p?.title, "Claude is done");
});

test("REGRESSION: a nameless 'done' (subagent/orphan, null label) is suppressed", () => {
  // A subagent child session finishes: it inherited the parent's directory and
  // streams session.idle on the same scoped /event stream, but no tmux window
  // stamps its sessionID, so resolveSessionLabel → null. firePush must drop it
  // (otherwise the user gets the nameless "Claude is done" that deep-links to a
  // sessionId the app can't find, dumping them on the session list).
  const done = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_child" } },
    { focusSessionId: null, focusVisible: false, wasBusy: true, label: null },
  );
  assert.equal(done?.kind, "done");
  assert.equal(shouldSuppressUnresolvedNotification(done, null), true);
});

test("a named 'done' (resolvable session) is NOT suppressed", () => {
  const done = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_real" } },
    { focusSessionId: null, focusVisible: false, wasBusy: true, label: "default / my-chat" },
  );
  assert.equal(shouldSuppressUnresolvedNotification(done, "default / my-chat"), false);
});

test("unresolved 'error' (null label) is suppressed — fixes BET-107 orphan spam", () => {
  // An orphan session errors: no tmux window stamps it, so the push would be
  // a nameless "The turn failed." that deep-links nowhere. Suppress it.
  const err = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_orphan" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: null },
  );
  assert.equal(err?.kind, "error");
  assert.equal(shouldSuppressUnresolvedNotification(err, null), true);
});

test("resolvable 'error' (with label) is NOT suppressed", () => {
  const err = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_real", message: "boom" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "default / my-chat" },
  );
  assert.equal(err?.kind, "error");
  assert.equal(shouldSuppressUnresolvedNotification(err, "default / my-chat"), false);
});

test("unresolved 'permission' (null label) is suppressed", () => {
  // An orphan session asks permission: no chat window for the user to act in,
  // so the push is useless even though it's "blocking".
  const perm = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_orphan_perm", id: "per_x" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: null },
  );
  assert.equal(perm?.kind, "permission");
  assert.equal(shouldSuppressUnresolvedNotification(perm, null), true);
});

test("resolvable 'permission' (with label) is NOT suppressed", () => {
  const perm = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_real_perm", id: "per_y" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "default / my-chat" },
  );
  assert.equal(perm?.kind, "permission");
  assert.equal(shouldSuppressUnresolvedNotification(perm, "default / my-chat"), false);
});

test("unresolved 'question' (null label) is suppressed", () => {
  // An orphan session asks a question: no chat window for the user to answer
  // from, so the push is useless.
  const q = classifyPushEvent(
    { type: "question.asked", properties: { sessionID: "ses_orphan_q" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: null },
  );
  assert.equal(q?.kind, "question");
  assert.equal(shouldSuppressUnresolvedNotification(q, null), true);
});

test("resolvable 'question' (with label) is NOT suppressed", () => {
  const q = classifyPushEvent(
    { type: "question.asked", properties: { sessionID: "ses_real_q" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "default / my-chat" },
  );
  assert.equal(q?.kind, "question");
  assert.equal(shouldSuppressUnresolvedNotification(q, "default / my-chat"), false);
});

test("null payload → no suppression (no-op)", () => {
  assert.equal(shouldSuppressUnresolvedNotification(null, null), false);
});

test("non-notifying kind with null label → no suppression", () => {
  // Other kinds (e.g. "notify") should not be suppressed even with null label.
  assert.equal(shouldSuppressUnresolvedNotification({ kind: "notify" }, null), false);
});

const LBL = { ...NOFOCUS, label: "default / my-chat" };

test("permission.asked uses the session label as title; kind in body", () => {
  const p = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_p", id: "per_1" } },
    LBL,
  );
  assert.equal(p?.title, "default / my-chat");
  assert.match(p?.body ?? "", /^Permission needed/);
});

test("session.error uses the session label as title; 'Error —' in body", () => {
  const p = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_e", message: "boom" } },
    LBL,
  );
  assert.equal(p?.title, "default / my-chat");
  assert.match(p?.body ?? "", /^Error — boom/);
});

test("session.error without label keeps generic title + raw message body", () => {
  const p = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_e2", message: "boom" } },
    NOFOCUS,
  );
  assert.equal(p?.title, "Claude hit an error");
  assert.equal(p?.body, "boom");
});

test("question.asked uses the session label as title; header+question in body", () => {
  const p = classifyPushEvent(
    {
      type: "question.asked",
      properties: {
        id: "que_l",
        sessionID: "ses_ql",
        questions: [{ header: "Deploy?", question: "Ship it now?", options: [] }],
      },
    },
    LBL,
  );
  assert.equal(p?.title, "default / my-chat");
  assert.equal(p?.body, "Deploy? — Ship it now?");
});

test("buildSessionLabel maps opencode sessionID → 'workspace / session-name'", () => {
  const projects = [
    {
      tmuxSession: "default",
      windows: [
        { name: "shell", opencodeSessionId: null },
        { name: "my-chat", opencodeSessionId: "ses_x" },
      ],
    },
    {
      tmuxSession: "other",
      windows: [{ name: "wkit", opencodeSessionId: "ses_y" }],
    },
  ];
  assert.equal(buildSessionLabel(projects, "ses_x"), "default / my-chat");
  assert.equal(buildSessionLabel(projects, "ses_y"), "other / wkit");
});

test("buildSessionLabel → null for unknown / missing sessionID", () => {
  const projects = [
    { tmuxSession: "default", windows: [{ name: "c", opencodeSessionId: "ses_a" }] },
  ];
  assert.equal(buildSessionLabel(projects, "ses_missing"), null);
  assert.equal(buildSessionLabel(projects, null), null);
  assert.equal(buildSessionLabel(null, "ses_a"), null);
});

// --- Desktop presence suppression (multi-device routing) -------------------

const NOW = 1_000_000_000;

test("shouldSuppressForDesktop: desktop focused now → suppress", () => {
  assert.equal(
    shouldSuppressForDesktop(
      { visible: true, lastSeen: NOW, lastActive: NOW },
      NOW,
    ),
    true,
  );
});

test("shouldSuppressForDesktop: blurred but within grace → suppress", () => {
  const t = NOW + DESKTOP_GRACE_MS - 1;
  assert.equal(
    shouldSuppressForDesktop(
      { visible: false, lastSeen: t, lastActive: NOW },
      t,
    ),
    true,
  );
});

test("shouldSuppressForDesktop: blurred past grace → allow push", () => {
  const t = NOW + DESKTOP_GRACE_MS + 1;
  assert.equal(
    shouldSuppressForDesktop(
      { visible: false, lastSeen: t, lastActive: NOW },
      t,
    ),
    false,
  );
});

test("shouldSuppressForDesktop: stale heartbeat (crash/sleep) → allow push", () => {
  // visible:true but no heartbeat for > TTL → treat desktop as gone.
  const t = NOW + DESKTOP_PRESENCE_TTL_MS + 1;
  assert.equal(
    shouldSuppressForDesktop(
      { visible: true, lastSeen: NOW, lastActive: NOW },
      t,
    ),
    false,
  );
});

test("shouldSuppressForDesktop: no presence ever → allow push", () => {
  assert.equal(
    shouldSuppressForDesktop({ visible: false, lastSeen: 0, lastActive: 0 }, NOW),
    false,
  );
  assert.equal(shouldSuppressForDesktop(null, NOW), false);
});

test("unrelated event → null", () => {
  assert.equal(
    classifyPushEvent({ type: "message.part.delta", properties: {} }, NOFOCUS),
    null,
  );
});

// ---------------------------------------------------------------------------
// routeNotification — the single cross-device router
// ---------------------------------------------------------------------------

const T = 1_000_000_000;
const dActive = { visible: true, lastSeen: T, lastActive: T }; // at the desk
const dIdle = { visible: false, lastSeen: T, lastActive: 0 }; // app open, away
const dGone = { visible: false, lastSeen: 0, lastActive: 0 }; // no heartbeat
const noMobile = { focusSessionId: null, focusVisible: false };

test("notifTier: blocking vs informational", () => {
  assert.equal(notifTier({ kind: "permission" }), "blocking");
  assert.equal(notifTier({ kind: "question" }), "blocking");
  assert.equal(notifTier({ kind: "error" }), "blocking");
  assert.equal(notifTier({ kind: "notify", urgent: true }), "blocking");
  assert.equal(notifTier({ kind: "notify" }), "informational");
  assert.equal(notifTier({ kind: "done" }), "informational");
});

test("route: informational + desktop active → desktop only", () => {
  const r = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dActive, ...noMobile },
    T,
  );
  assert.deepEqual(r, { desktop: true, mobileNow: false, escalateAfterMs: null });
});

test("route: informational + desktop idle → desktop now, escalate mobile", () => {
  const r = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dIdle, ...noMobile },
    T,
  );
  assert.equal(r.desktop, true);
  assert.equal(r.mobileNow, false);
  assert.equal(r.escalateAfterMs, ESCALATE_MS);
});

test("route: informational + desktop gone → mobile only", () => {
  const r = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dGone, ...noMobile },
    T,
  );
  assert.deepEqual(r, { desktop: false, mobileNow: true, escalateAfterMs: null });
});

test("route: informational + mobile foreground on this session → no mobile, no escalation", () => {
  const idle = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dIdle, focusSessionId: "ses_1", focusVisible: true },
    T,
  );
  assert.equal(idle.escalateAfterMs, null);
  const gone = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dGone, focusSessionId: "ses_1", focusVisible: true },
    T,
  );
  assert.equal(gone.mobileNow, false);
});

test("route: blocking → both devices now (desktop + mobile), even when gone", () => {
  const r = routeNotification(
    { kind: "permission", sessionId: "ses_1" },
    { desktop: dGone, ...noMobile },
    T,
  );
  assert.deepEqual(r, { desktop: true, mobileNow: true, escalateAfterMs: null });
});

test("route: blocking + mobile viewing this session → desktop yes, mobile suppressed", () => {
  const r = routeNotification(
    { kind: "question", sessionId: "ses_1" },
    { desktop: dGone, focusSessionId: "ses_1", focusVisible: true },
    T,
  );
  assert.equal(r.desktop, true);
  assert.equal(r.mobileNow, false);
});

// ---------------------------------------------------------------------------
// Escalation lifecycle (stateful)
// ---------------------------------------------------------------------------

test("escalation: idle desktop schedules a mobile escalation; desktop-active cancels it", async () => {
  _resetPushState();
  setDesktopSink(() => {}); // no-op desktop leg
  setDesktopPresence({ visible: false }); // fresh heartbeat, idle/away
  await fireNotify({ message: "build done", sessionID: "ses_esc" });
  assert.deepEqual(_pendingEscalationTags(), ["notify-ses_esc"]);
  setDesktopPresence({ visible: true }); // user returns to the desk
  assert.deepEqual(_pendingEscalationTags(), []);
  _resetPushState();
});

test("escalation: answering one session cancels only its escalation", async () => {
  _resetPushState();
  setDesktopPresence({ visible: false });
  await fireNotify({ message: "x", sessionID: "ses_a" });
  await fireNotify({ message: "y", sessionID: "ses_b" });
  assert.equal(_pendingEscalationTags().length, 2);
  cancelEscalationsForSession("ses_a");
  assert.deepEqual(_pendingEscalationTags(), ["notify-ses_b"]);
  _resetPushState();
});

test("escalation: re-notify same tag supersedes (no duplicate timer)", async () => {
  _resetPushState();
  setDesktopPresence({ visible: false });
  await fireNotify({ message: "first", sessionID: "ses_s" });
  await fireNotify({ message: "second", sessionID: "ses_s" });
  assert.deepEqual(_pendingEscalationTags(), ["notify-ses_s"]);
  cancelAllEscalations();
  _resetPushState();
});

// ---------------------------------------------------------------------------
// APNs device-token store (box-side; APNs signing/HTTP moved in BET-199)
// ---------------------------------------------------------------------------
//
// The actual APNs send (buildApnsJwt / buildApnsRequest / buildApnsPayload /
// sendApns + the prune classification) moved to src/gateway/apns.mjs in
// BET-199. The box keeps the device-token store (this section) — the
// gateway is stateless about tokens; BET-200 will rewire sendApnsFanout
// to POST the gateway and prune on `prune:true` results, calling the
// removeApnsToken tested below.
//
// Tests in this section use a per-test temp store path so parallel runs
// (or a leftover from a prior run) never see each other's writes.

// Per-test temp store path for the APNs device-token registry. Always
// return a unique file so parallel tests (or a leftover from a prior run)
// don't see each other's writes.
function makeApnsStorePath(label) {
  return join(
    tmpdir(),
    `manta-apns-tokens-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

test("register-apns upsert: addApnsToken round-trip via temp store", async () => {
  const store = makeApnsStorePath("upsert");
  try {
    const r1 = await addApnsToken("tok-aaa", { store });
    assert.equal(r1.ok, true);
    assert.equal(r1.count, 1);
    const r2 = await addApnsToken("tok-bbb", { store });
    assert.equal(r2.count, 2);
    const tokens = await _loadApnsTokensForTest(store);
    assert.deepEqual(
      tokens.map((t) => t.token).sort(),
      ["tok-aaa", "tok-bbb"],
    );
    for (const t of tokens) {
      assert.equal(t.kind, "apns");
      assert.equal(typeof t.registeredAt, "number");
      assert.ok(t.registeredAt > 0);
    }
  } finally {
    await rm(store, { force: true });
  }
});

test("register-apns: re-registering same token DE-DUPES (upsert, not append)", async () => {
  const store = makeApnsStorePath("dedupe");
  try {
    await addApnsToken("tok-dup", { store });
    await addApnsToken("tok-dup", { store });
    await addApnsToken("tok-dup", { store });
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, "tok-dup");
  } finally {
    await rm(store, { force: true });
  }
});

test("register-apns: rejects an empty / non-string token", async () => {
  await assert.rejects(() => addApnsToken(""), /non-empty/);
  await assert.rejects(() => addApnsToken(null), /non-empty/);
  await assert.rejects(() => addApnsToken(undefined), /non-empty/);
});

test("removeApnsToken: removes a registered token", async () => {
  const store = makeApnsStorePath("remove");
  try {
    await addApnsToken("tok-keep", { store });
    await addApnsToken("tok-drop", { store });
    const r = await removeApnsToken("tok-drop", { store });
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
    const tokens = await _loadApnsTokensForTest(store);
    assert.deepEqual(
      tokens.map((t) => t.token),
      ["tok-keep"],
    );
  } finally {
    await rm(store, { force: true });
  }
});

test("removeApnsToken: no-op on unknown token (returns count unchanged)", async () => {
  const store = makeApnsStorePath("remove-noop");
  try {
    await addApnsToken("tok-only", { store });
    const r = await removeApnsToken("tok-ghost", { store });
    assert.equal(r.count, 1);
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 1);
  } finally {
    await rm(store, { force: true });
  }
});

// ---------------------------------------------------------------------------
// sendApnsFanout → hosted gateway (BET-201)
//
// The box no longer holds APNs credentials. APNs is the gateway's job
// (src/gateway/apns.mjs); the box fans every device token out via ONE
// POST ${GATEWAY_BASE}/push with {box_id, tokens, payload} +
// `Authorization: Bearer <gateway_token from ~/.manta/auth.json>`, and
// prunes every token the gateway classifies as `prune:true`. All tests
// here inject fetch + identity + token store so nothing touches real FS
// or the network.
// ---------------------------------------------------------------------------

const FANOUT_BOX_ID = "abcdef0123456789abcdef0123456789";
const FANOUT_GATEWAY_TOKEN = "00112233445566778899aabbccddeeff";

function okJson(json) {
  return { ok: true, status: 200, json: async () => json };
}

test("sendApnsFanout: sends exactly one POST to ${GATEWAY_BASE}/push with Bearer token", async () => {
  _resetFanoutFakesForTest();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return okJson({ results: [{ token: "t1", ok: true, prune: false }] });
  };
  _setFanoutFakesForTest({
    fetchImpl: fakeFetch,
    loadApnsTokens: async () => [{ kind: "apns", token: "t1", registeredAt: 1 }],
    removeApnsToken: async () => ({ ok: true, count: 0 }),
    readBoxGatewayIdentity: async () => ({
      box_id: FANOUT_BOX_ID,
      gateway_token: FANOUT_GATEWAY_TOKEN,
    }),
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await sendApnsFanout({ kind: "done", title: "T", body: "B", sessionId: "ses_x", tag: "x" });
    assert.equal(calls.length, 1, "exactly one request");
    assert.equal(calls[0].url, "https://gateway.test.local/push");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["content-type"], "application/json");
    assert.equal(
      calls[0].init.headers.authorization,
      `Bearer ${FANOUT_GATEWAY_TOKEN}`,
    );
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.box_id, FANOUT_BOX_ID);
    assert.deepEqual(body.tokens, ["t1"]);
    assert.equal(body.payload.kind, "done");
  } finally {
    _resetFanoutFakesForTest();
  }
});

test("sendApnsFanout: prunes every token classified prune:true", async () => {
  _resetFanoutFakesForTest();
  const pruned = [];
  const fakeFetch = async () =>
    okJson({
      results: [
        { token: "t-keep", ok: true, prune: false },
        { token: "t-gone", ok: false, prune: true },
        { token: "t-bad",  ok: false, prune: true },
        { token: "t-other", ok: false, prune: false }, // 500-style, keep
      ],
    });
  _setFanoutFakesForTest({
    fetchImpl: fakeFetch,
    loadApnsTokens: async () => [
      { kind: "apns", token: "t-keep", registeredAt: 1 },
      { kind: "apns", token: "t-gone", registeredAt: 1 },
      { kind: "apns", token: "t-bad",  registeredAt: 1 },
      { kind: "apns", token: "t-other", registeredAt: 1 },
    ],
    removeApnsToken: async (tok) => {
      pruned.push(tok);
      return { ok: true, count: 0 };
    },
    readBoxGatewayIdentity: async () => ({
      box_id: FANOUT_BOX_ID,
      gateway_token: FANOUT_GATEWAY_TOKEN,
    }),
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await sendApnsFanout({ kind: "done", title: "T", body: "B" });
    assert.deepEqual(pruned.sort(), ["t-bad", "t-gone"]);
  } finally {
    _resetFanoutFakesForTest();
  }
});

test("sendApnsFanout: network throw → warn + return (no exception, no prune)", async () => {
  _resetFanoutFakesForTest();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let removeCalls = 0;
  const fakeFetch = async () => {
    throw new Error("socket reset");
  };
  _setFanoutFakesForTest({
    fetchImpl: fakeFetch,
    loadApnsTokens: async () => [
      { kind: "apns", token: "t1", registeredAt: 1 },
    ],
    removeApnsToken: async () => {
      removeCalls++;
      return { ok: true, count: 0 };
    },
    readBoxGatewayIdentity: async () => ({
      box_id: FANOUT_BOX_ID,
      gateway_token: FANOUT_GATEWAY_TOKEN,
    }),
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await assert.doesNotReject(() =>
      sendApnsFanout({ kind: "done", title: "T", body: "B" }),
    );
    assert.equal(removeCalls, 0, "no prune on network throw");
    assert.ok(
      warns.some((w) => /gateway send failed/.test(w) && /socket reset/.test(w)),
      "warn mentions the underlying failure",
    );
  } finally {
    console.warn = origWarn;
    _resetFanoutFakesForTest();
  }
});

test("sendApnsFanout: gateway 401 → warn + return (no exception, no prune)", async () => {
  _resetFanoutFakesForTest();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let removeCalls = 0;
  _setFanoutFakesForTest({
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    loadApnsTokens: async () => [{ kind: "apns", token: "t1", registeredAt: 1 }],
    removeApnsToken: async () => {
      removeCalls++;
      return { ok: true, count: 0 };
    },
    readBoxGatewayIdentity: async () => ({
      box_id: FANOUT_BOX_ID,
      gateway_token: FANOUT_GATEWAY_TOKEN,
    }),
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await assert.doesNotReject(() =>
      sendApnsFanout({ kind: "done", title: "T", body: "B" }),
    );
    assert.equal(removeCalls, 0);
    assert.ok(warns.some((w) => /status=401/.test(w)), "warn mentions 401");
  } finally {
    console.warn = origWarn;
    _resetFanoutFakesForTest();
  }
});

test("sendApnsFanout: gateway 500 → warn + return (no exception, no prune)", async () => {
  _resetFanoutFakesForTest();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let removeCalls = 0;
  _setFanoutFakesForTest({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    loadApnsTokens: async () => [{ kind: "apns", token: "t1", registeredAt: 1 }],
    removeApnsToken: async () => {
      removeCalls++;
      return { ok: true, count: 0 };
    },
    readBoxGatewayIdentity: async () => ({
      box_id: FANOUT_BOX_ID,
      gateway_token: FANOUT_GATEWAY_TOKEN,
    }),
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await assert.doesNotReject(() =>
      sendApnsFanout({ kind: "done", title: "T", body: "B" }),
    );
    assert.equal(removeCalls, 0);
    assert.ok(warns.some((w) => /status=500/.test(w)), "warn mentions 500");
  } finally {
    console.warn = origWarn;
    _resetFanoutFakesForTest();
  }
});

test("sendApnsFanout: missing gateway_token in auth.json → warn + no request sent", async () => {
  _resetFanoutFakesForTest();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let fetchCalls = 0;
  _setFanoutFakesForTest({
    fetchImpl: async () => {
      fetchCalls++;
      return okJson({ results: [] });
    },
    loadApnsTokens: async () => [{ kind: "apns", token: "t1", registeredAt: 1 }],
    removeApnsToken: async () => ({ ok: true, count: 0 }),
    readBoxGatewayIdentity: async () => null, // gateway_token not persisted yet
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await assert.doesNotReject(() =>
      sendApnsFanout({ kind: "done", title: "T", body: "B" }),
    );
    assert.equal(fetchCalls, 0, "no request sent when identity is missing");
    assert.ok(
      warns.some((w) => /skipped/.test(w) && /gateway_token/.test(w)),
      "warn explains the skip",
    );
  } finally {
    console.warn = origWarn;
    _resetFanoutFakesForTest();
  }
});

test("sendApnsFanout: empty token store → no request sent", async () => {
  _resetFanoutFakesForTest();
  let fetchCalls = 0;
  _setFanoutFakesForTest({
    fetchImpl: async () => {
      fetchCalls++;
      return okJson({ results: [] });
    },
    loadApnsTokens: async () => [],
    removeApnsToken: async () => ({ ok: true, count: 0 }),
    readBoxGatewayIdentity: async () => ({
      box_id: FANOUT_BOX_ID,
      gateway_token: FANOUT_GATEWAY_TOKEN,
    }),
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await sendApnsFanout({ kind: "done", title: "T", body: "B" });
    assert.equal(fetchCalls, 0);
  } finally {
    _resetFanoutFakesForTest();
  }
});

test("sendApnsFanout: gateway 200 with malformed JSON body → warn + no exception", async () => {
  _resetFanoutFakesForTest();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let removeCalls = 0;
  _setFanoutFakesForTest({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected token");
      },
    }),
    loadApnsTokens: async () => [{ kind: "apns", token: "t1", registeredAt: 1 }],
    removeApnsToken: async () => {
      removeCalls++;
      return { ok: true, count: 0 };
    },
    readBoxGatewayIdentity: async () => ({
      box_id: FANOUT_BOX_ID,
      gateway_token: FANOUT_GATEWAY_TOKEN,
    }),
    gatewayBase: "https://gateway.test.local",
  });
  try {
    await assert.doesNotReject(() =>
      sendApnsFanout({ kind: "done", title: "T", body: "B" }),
    );
    assert.equal(removeCalls, 0);
    assert.ok(warns.some((w) => /malformed JSON/.test(w)));
  } finally {
    console.warn = origWarn;
    _resetFanoutFakesForTest();
  }
});
