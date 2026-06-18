import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPushEvent,
  buildSessionLabel,
  shouldSuppressForDesktop,
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
