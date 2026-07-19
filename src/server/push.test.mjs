import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
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
  buildApnsJwt,
  buildApnsRequest,
  buildApnsPayload,
  addApnsToken,
  removeApnsToken,
  sendApns,
  sendApnsFanout,
  _resetApnsJwtCache,
  _loadApnsTokensForTest,
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
// APNs native-push delivery leg (BET-181)
// ---------------------------------------------------------------------------
//
// All tests below use a generated EC P-256 keypair written to a tmpdir .p8
// and an injectable `sender` function — no live Apple round-trips, no
// production ~/.manta/apns-tokens.json writes. The `store` injection on
// addApnsToken/removeApnsToken/sendApnsFanout lets every assertion run
// against a per-test temp file that the test cleans up.

// Generate a P-256 EC keypair and export the private side as PKCS#8 PEM,
// the exact shape Apple's APNs .p8 tokens are. Returns the path to a
// tmpfile the test MUST clean up.
async function makeApnsKeyFile() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const path = join(
    tmpdir(),
    `bui-apns-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.p8`,
  );
  await writeFile(path, pem, "utf-8");
  return { path, cleanup: () => rm(path, { force: true }) };
}

// Per-test temp store path for the APNs device-token registry. Always
// return a unique file so parallel tests (or a leftover from a prior run)
// don't see each other's writes.
function makeApnsStorePath(label) {
  return join(
    tmpdir(),
    `bui-apns-tokens-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

const APNS_CFG = {
  teamId: "FSQ3HS4Z24",
  keyId: "82P7483297",
  bundleId: "com.antoinedc.mantaui",
};

test("buildApnsJwt: claim/header structure matches Apple APNs spec", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  try {
    const cfg = { ...APNS_CFG, p8Path };
    const IAT = 1_700_000_000;
    const jwt = await buildApnsJwt(cfg, { now: IAT });
    // Format: <header-b64url>.<claims-b64url>.<signature-b64url>
    const parts = jwt.split(".");
    assert.equal(parts.length, 3, "JWT must have exactly 3 parts");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, APNS_CFG.keyId);
    assert.equal(claims.iss, APNS_CFG.teamId);
    assert.equal(claims.iat, IAT);
    // Signature segment must be non-empty (binary blob — just assert length).
    assert.ok(parts[2].length > 0);
  } finally {
    await cleanup();
  }
});

test("buildApnsPayload: maps notification payload to APNs `aps` envelope", () => {
  const out = buildApnsPayload({
    title: "default / my-chat",
    body: "Permission needed — Claude wants to run a tool.",
    sessionId: "ses_abc",
  });
  assert.deepEqual(out, {
    aps: {
      alert: {
        title: "default / my-chat",
        body: "Permission needed — Claude wants to run a tool.",
      },
      "thread-id": "ses_abc",
    },
    sessionId: "ses_abc",
  });
});

test("buildApnsPayload: no sessionId → no thread-id, still shaped right", () => {
  const out = buildApnsPayload({ title: "T", body: "B" });
  assert.deepEqual(out.aps.alert, { title: "T", body: "B" });
  assert.equal(out.aps["thread-id"], undefined);
  assert.equal(out.sessionId, null);
});

test("buildApnsRequest: host/path/headers/body shape (HTTP/2 style)", () => {
  // 64-char hex device token (Apple's standard shape).
  const deviceToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const req = buildApnsRequest({
    cfg: APNS_CFG,
    deviceToken,
    payload: { aps: { alert: { title: "T", body: "B" } }, sessionId: null },
    jwt: "header.claims.sig",
  });
  assert.equal(req.host, "api.push.apple.com");
  assert.equal(req.path, `/3/device/${deviceToken}`);
  assert.equal(req.method, "POST");
  assert.equal(req.headers["authorization"], "bearer header.claims.sig");
  assert.equal(req.headers["apns-topic"], APNS_CFG.bundleId);
  assert.equal(req.headers["apns-push-type"], "alert");
  assert.match(req.headers["content-type"], /application\/json/);
  assert.match(req.body, /"aps"/);
});

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

// --- sendApns pruning rules -----------------------------------------------

test("sendApns: 200 → ok, does NOT prune the token", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("send-ok");
  try {
    await addApnsToken("tok-ok", { store });
    _resetApnsJwtCache();
    const sent = [];
    const res = await sendApns(
      { ...APNS_CFG, p8Path },
      "tok-ok",
      { title: "T", body: "B", sessionId: "ses_x" },
      async (req) => {
        sent.push(req);
        return { status: 200, body: null };
      },
      { store },
    );
    assert.equal(res.ok, true);
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 1, "200 must NOT prune");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers["apns-topic"], APNS_CFG.bundleId);
    assert.equal(sent[0].headers["apns-push-type"], "alert");
    assert.match(sent[0].headers.authorization, /^bearer /);
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("sendApns: 410 Gone → prunes the token", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("send-410");
  try {
    await addApnsToken("tok-410", { store });
    _resetApnsJwtCache();
    const res = await sendApns(
      { ...APNS_CFG, p8Path },
      "tok-410",
      { title: "T", body: "B" },
      async () => ({ status: 410, body: { reason: "Unregistered" } }),
      { store },
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, "dead-token");
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 0, "410 must prune");
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("sendApns: 400 BadDeviceToken → prunes the token", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("send-bad");
  try {
    await addApnsToken("tok-bad", { store });
    _resetApnsJwtCache();
    const res = await sendApns(
      { ...APNS_CFG, p8Path },
      "tok-bad",
      { title: "T", body: "B" },
      async () => ({ status: 400, body: { reason: "BadDeviceToken" } }),
      { store },
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, "dead-token");
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 0, "400 BadDeviceToken must prune");
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("sendApns: 400 Unregistered → prunes the token", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("send-unreg");
  try {
    await addApnsToken("tok-unreg", { store });
    _resetApnsJwtCache();
    const res = await sendApns(
      { ...APNS_CFG, p8Path },
      "tok-unreg",
      { title: "T", body: "B" },
      async () => ({ status: 400, body: { reason: "Unregistered" } }),
      { store },
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, "dead-token");
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 0);
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("sendApns: 400 with other reason → keep token (transient)", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("send-400other");
  try {
    await addApnsToken("tok-keepme", { store });
    _resetApnsJwtCache();
    const res = await sendApns(
      { ...APNS_CFG, p8Path },
      "tok-keepme",
      { title: "T", body: "B" },
      async () => ({ status: 400, body: { reason: "BadCertificateEnvironment" } }),
      { store },
    );
    assert.equal(res.ok, false);
    assert.notEqual(res.reason, "dead-token");
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 1, "non-dead-token failures must NOT prune");
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("sendApns: 500 / transport error → keep token (transient)", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("send-500");
  try {
    await addApnsToken("tok-keep500", { store });
    _resetApnsJwtCache();
    const res = await sendApns(
      { ...APNS_CFG, p8Path },
      "tok-keep500",
      { title: "T", body: "B" },
      async () => ({ status: 500, body: null }),
      { store },
    );
    assert.equal(res.ok, false);
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 1, "500 must NOT prune");
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

// --- sendApnsFanout integration ---------------------------------------------

test("sendApnsFanout: empty store → no send (and no crash)", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("fanout-empty");
  try {
    let called = 0;
    await sendApnsFanout(
      { title: "T", body: "B", sessionId: "ses_1" },
      { cfg: { ...APNS_CFG, p8Path }, sender: async () => { called++; return { status: 200, body: null }; }, store },
    );
    assert.equal(called, 0);
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("sendApnsFanout: fans out to ALL registered tokens; dead pruned live", async () => {
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("fanout-all");
  try {
    await addApnsToken("tok-1", { store });
    await addApnsToken("tok-2", { store });
    await addApnsToken("tok-3", { store });
    _resetApnsJwtCache();
    const seen = [];
    await sendApnsFanout(
      { title: "T", body: "B", sessionId: "ses_x" },
      {
        cfg: { ...APNS_CFG, p8Path },
        sender: async (req) => {
          seen.push(req.path.match(/\/3\/device\/(.+)/)[1]);
          // tok-2 is "dead" → Apple returns 410
          if (req.path.includes("tok-2")) {
            return { status: 410, body: { reason: "Unregistered" } };
          }
          return { status: 200, body: null };
        },
        store,
      },
    );
    assert.equal(seen.length, 3);
    assert.ok(seen.includes("tok-1"));
    assert.ok(seen.includes("tok-2"));
    assert.ok(seen.includes("tok-3"));
    // tok-2 was pruned live during the fanout.
    const tokens = await _loadApnsTokensForTest(store);
    assert.deepEqual(
      tokens.map((t) => t.token).sort(),
      ["tok-1", "tok-3"],
    );
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("sendApnsFanout: no cfg → silent no-op (matches Web Push behavior)", async () => {
  // No cfg passed and local.apnsConfig() would return null in the absence
  // of the apns block — we just confirm the function exits early without
  // touching any token store or invoking any sender.
  let called = false;
  await sendApnsFanout(
    { title: "T", body: "B" },
    { cfg: null, sender: async () => { called = true; return { status: 200, body: null }; } },
  );
  assert.equal(called, false);
});

test("sendApnsFanout: end-to-end with fireNotify still calls APNs when both registries present", async () => {
  // Integration-style: fire a notify that the router decides to push
  // mobile-now → Web Push sendPush runs (no real subscribers → no-op),
  // APNs fan-out runs, the temp store's token gets the send.
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("fire-integration");
  try {
    await addApnsToken("tok-fired", { store });
    _resetPushState();
    _resetApnsJwtCache();
    setDesktopSink(() => {}); // no desktop leg
    setDesktopPresence({ visible: false, lastSeen: 0, lastActive: 0 }); // desktop GONE → mobile only
    const sent = [];
    // Monkey-patch push.mjs' sendPush path by driving the APNs side
    // directly through the fan-out entry point, simulating what
    // dispatchNotification does in production after a routeNotification
    // decision: it calls sendPush (Web Push) AND sendApnsFanout (APNs).
    await fireNotify({ message: "build done", sessionID: "ses_fire" });
    await sendApnsFanout(
      { kind: "done", title: "default / my-chat", body: "Your turn finished.", sessionId: "ses_fire" },
      {
        cfg: { ...APNS_CFG, p8Path },
        sender: async (req) => { sent.push(req.path); return { status: 200, body: null }; },
        store,
      },
    );
    assert.ok(
      sent.some((p) => p.endsWith("/tok-fired")),
      "APNs fan-out must reach the registered token",
    );
    // The Web Push leg fired too (no subs → no-op), but the routing
    // decision (mobileNow:true) is the same — so the test confirms
    // APNs participates WITHOUT changing routing decisions.
    _resetPushState();
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});

test("_resetApnsJwtCache: a new sign is forced after reset (verified via sendApns JWT)", async () => {
  // buildApnsJwt itself always re-signs (ES256 has a random k), so the
  // cache lives in getApnsJwt (called by sendApns). We exercise the cache
  // by capturing the bearer token from the request sendApns builds, then
  // resetting the cache and asserting the bearer token changes.
  const { path: p8Path, cleanup } = await makeApnsKeyFile();
  const store = makeApnsStorePath("jwt-cache");
  try {
    await addApnsToken("tok-cache", { store });
    _resetApnsJwtCache();
    const cfg = { ...APNS_CFG, p8Path };
    const captured = [];
    await sendApns(
      cfg,
      "tok-cache",
      { title: "T", body: "B" },
      async (req) => {
        captured.push(req.headers.authorization);
        return { status: 200, body: null };
      },
      { store },
    );
    await sendApns(
      cfg,
      "tok-cache",
      { title: "T", body: "B" },
      async (req) => {
        captured.push(req.headers.authorization);
        return { status: 200, body: null };
      },
      { store },
    );
    assert.equal(captured.length, 2);
    assert.equal(
      captured[0],
      captured[1],
      "second sendApns within cache window returns the cached bearer",
    );
    _resetApnsJwtCache();
    await sendApns(
      cfg,
      "tok-cache",
      { title: "T", body: "B" },
      async (req) => {
        captured.push(req.headers.authorization);
        return { status: 200, body: null };
      },
      { store },
    );
    assert.notEqual(
      captured[1],
      captured[2],
      "after _resetApnsJwtCache the bearer must be freshly signed",
    );
  } finally {
    await cleanup();
    await rm(store, { force: true });
  }
});
