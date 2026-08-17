import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { statePath } from "../shared/paths.mjs";
import {
  classifyPushEvent,
  buildSessionLabel,
  shouldSuppressNotification,
  routeNotification,
  notifTier,
  fireNotify,
  firePush,
  setDesktopPresence,
  setDesktopSink,
  cancelDeferredMobileForSession,
  cancelAllDeferredMobile,
  _deferredMobileTags,
  _resetPushState,
  addApnsToken,
  isValidApnsToken,
  removeApnsToken,
  sendApnsFanout,
  _loadApnsTokensForTest,
  _setFanoutFakesForTest,
  _resetFanoutFakesForTest,
  computeAwayAt,
  desktopState,
  flushDeferredMobile,
  IDLE_AWAY_MS,
  LOCK_AWAY_MS,
  PRESENCE_TTL_MS,
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

test("permission.asked carries requestId + the 3 static reply actions (single-select)", () => {
  const p = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_1", id: "per_1" } },
    NOFOCUS,
  );
  assert.equal(p?.requestId, "per_1");
  assert.deepEqual(p?.actions, [
    { action: "allow-once", title: "Allow once" },
    { action: "allow-always", title: "Always allow" },
    { action: "deny", title: "Deny" },
  ]);
});

test("permission.asked without id → no requestId, no actions (unchanged legacy shape)", () => {
  const p = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_1" } },
    NOFOCUS,
  );
  assert.equal(p?.requestId, undefined);
  assert.equal(p?.actions, undefined);
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

test("plan_exit question → MantaUI plan-ready body + plan page URL, no raw path (BET-993)", () => {
  // Make the box addressable so publicBaseUrl() resolves (auth.json under the
  // MANTA_STATE_HOME sandbox, read fresh on every call). Cleaned up after.
  const authPath = statePath("auth.json");
  mkdirSync(statePath(), { recursive: true });
  writeFileSync(authPath, JSON.stringify({ gateway_host: "box123.boxes.mantaui.com" }));
  try {
    const p = classifyPushEvent(
      {
        type: "question.asked",
        properties: {
          sessionID: "ses_plan",
          questions: [
            {
              header: "Build Agent",
              question:
                "Plan at .opencode/plans/sunny-eagle.md is complete. Would you like to switch to the build agent?",
            },
          ],
        },
      },
      NOFOCUS,
    );
    assert.equal(p?.kind, "question");
    assert.match(p?.body ?? "", /Your plan is ready to review/);
    assert.match(
      p?.body ?? "",
      /https:\/\/box123\.boxes\.mantaui\.com\/pages\/plan-sesplan/,
    );
    assert.ok(!(p?.body ?? "").includes(".md"), "no raw .md path leaks");
    assert.ok(!(p?.body ?? "").includes("Plan at"), "no 'Plan at' literal leaks");
  } finally {
    rmSync(authPath, { force: true });
  }
});

test("plan_exit question with unresolvable URL → body is just the clean line (BET-993)", () => {
  // No sessionID → planPageUrl cannot build a slug → returns "" → nothing appended.
  const p = classifyPushEvent(
    {
      type: "question.asked",
      properties: {
        questions: [{ header: "Build Agent", question: "Plan at foo.md is complete?" }],
      },
    },
    NOFOCUS,
  );
  assert.equal(
    p?.body,
    "Your plan is ready to review — open it, then approve or keep planning.",
  );
  assert.ok(!(p?.body ?? "").includes("Plan at"));
});

test("plan_exit detected via header alone (question not prefixed with 'Plan at ') (BET-993)", () => {
  const p = classifyPushEvent(
    {
      type: "question.asked",
      properties: {
        sessionID: "ses_plan_h",
        questions: [{ header: "Build Agent", question: "Ready to hand off?" }],
      },
    },
    NOFOCUS,
  );
  assert.match(p?.body ?? "", /Your plan is ready to review/);
  assert.ok(!(p?.body ?? "").includes(".md"));
});

test("normal question → body unchanged (BET-993 regression)", () => {
  const p = classifyPushEvent(
    {
      type: "question.asked",
      properties: {
        sessionID: "ses_norm",
        questions: [{ header: "Deploy?", question: "Should I deploy to production now?" }],
      },
    },
    NOFOCUS,
  );
  assert.equal(p?.kind, "question");
  assert.equal(p?.body, "Should I deploy to production now?");
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
      error: { name: "ApiError" },
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
  assert.equal(shouldSuppressNotification(done, null, false), true);
});

test("a named 'done' (resolvable session) is NOT suppressed", () => {
  const done = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_real" } },
    { focusSessionId: null, focusVisible: false, wasBusy: true, label: "default / my-chat" },
  );
  assert.equal(shouldSuppressNotification(done, "default / my-chat", false), false);
});

test("unresolved 'error' (null label) is suppressed — fixes BET-107 orphan spam", () => {
  // An orphan session errors: no tmux window stamps it, so the push would be
  // a nameless "The turn failed." that deep-links nowhere. Suppress it.
  const err = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_orphan" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: null },
  );
  assert.equal(err?.kind, "error");
  assert.equal(shouldSuppressNotification(err, null, false), true);
});

test("resolvable 'error' (with label) is NOT suppressed", () => {
  const err = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_real", message: "boom" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "default / my-chat" },
  );
  assert.equal(err?.kind, "error");
  assert.equal(shouldSuppressNotification(err, "default / my-chat", false), false);
});

test("unresolved 'permission' (null label) is suppressed", () => {
  // An orphan session asks permission: no chat window for the user to act in,
  // so the push is useless even though it's "blocking".
  const perm = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_orphan_perm", id: "per_x" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: null },
  );
  assert.equal(perm?.kind, "permission");
  assert.equal(shouldSuppressNotification(perm, null, false), true);
});

test("resolvable 'permission' (with label) is NOT suppressed", () => {
  const perm = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_real_perm", id: "per_y" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "default / my-chat" },
  );
  assert.equal(perm?.kind, "permission");
  assert.equal(shouldSuppressNotification(perm, "default / my-chat", false), false);
});

test("unresolved 'question' (null label) is suppressed", () => {
  // An orphan session asks a question: no chat window for the user to answer
  // from, so the push is useless.
  const q = classifyPushEvent(
    { type: "question.asked", properties: { sessionID: "ses_orphan_q" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: null },
  );
  assert.equal(q?.kind, "question");
  assert.equal(shouldSuppressNotification(q, null, false), true);
});

test("resolvable 'question' (with label) is NOT suppressed", () => {
  const q = classifyPushEvent(
    { type: "question.asked", properties: { sessionID: "ses_real_q" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "default / my-chat" },
  );
  assert.equal(q?.kind, "question");
  assert.equal(shouldSuppressNotification(q, "default / my-chat", false), false);
});

test("null payload → no suppression (no-op)", () => {
  assert.equal(shouldSuppressNotification(null, null, false), false);
});

test("non-notifying kind with null label → no suppression", () => {
  // Other kinds (e.g. "notify") should not be suppressed even with null label.
  assert.equal(shouldSuppressNotification({ kind: "notify" }, null, false), false);
});

test("background job 'done' (even with resolved label) is suppressed", () => {
  // BET-800: a background job's own child session reports done/error into the
  // parent's transcript, so even with a resolvable label the push is duplicate
  // noise. Match on isBackgroundJob regardless of label.
  const done = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_job" } },
    { focusSessionId: null, focusVisible: false, wasBusy: true, label: "ws / job" },
  );
  assert.equal(done?.kind, "done");
  assert.equal(shouldSuppressNotification(done, "ws / job", true), true);
});

test("background job 'error' (even with resolved label) is suppressed", () => {
  const err = classifyPushEvent(
    { type: "session.error", properties: { sessionID: "ses_job", message: "boom" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "ws / job" },
  );
  assert.equal(err?.kind, "error");
  assert.equal(shouldSuppressNotification(err, "ws / job", true), true);
});

test("background job blocked 'permission' (resolved label) is NOT suppressed", () => {
  // A job asking permission is BLOCKED and will sit until the user acts — a
  // blocked job must still page the user. Silence only done/error.
  const perm = classifyPushEvent(
    { type: "permission.asked", properties: { sessionID: "ses_job_perm", id: "per_j" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "ws / job" },
  );
  assert.equal(perm?.kind, "permission");
  assert.equal(shouldSuppressNotification(perm, "ws / job", true), false);
});

test("background job blocked 'question' (resolved label) is NOT suppressed", () => {
  const q = classifyPushEvent(
    { type: "question.asked", properties: { sessionID: "ses_job_q" } },
    { focusSessionId: null, focusVisible: false, wasBusy: false, label: "ws / job" },
  );
  assert.equal(q?.kind, "question");
  assert.equal(shouldSuppressNotification(q, "ws / job", true), false);
});

test("ordinary chat (resolved label, not a job) still notifies", () => {
  // The normal chat case: named session, not a background job — done pushes fire.
  const done = classifyPushEvent(
    { type: "session.idle", properties: { sessionID: "ses_real" } },
    { focusSessionId: null, focusVisible: false, wasBusy: true, label: "ws / name" },
  );
  assert.equal(done?.kind, "done");
  assert.equal(shouldSuppressNotification(done, "ws / name", false), false);
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

// --- Desktop presence — away calculation + state (BET-1044) ----------------

const NOW = 1_000_000_000;

test("computeAwayAt: idle-only (no lock) → lastSeen + 10min", () => {
  assert.equal(
    computeAwayAt({ lastSeen: NOW, idleSeconds: 0, lockedSeconds: null }),
    NOW + IDLE_AWAY_MS,
  );
});

test("computeAwayAt: already-idle 4 min → lastSeen + 6min", () => {
  assert.equal(
    computeAwayAt({ lastSeen: NOW, idleSeconds: 240, lockedSeconds: null }),
    NOW + IDLE_AWAY_MS - 240_000,
  );
});

test("computeAwayAt: locked 0s → lastSeen + 5min (lock beats idle)", () => {
  assert.equal(
    computeAwayAt({ lastSeen: NOW, idleSeconds: 0, lockedSeconds: 0 }),
    NOW + LOCK_AWAY_MS,
  );
});

test("computeAwayAt: locked 2min into a 10min idle window → ONE instant at lock+5min", () => {
  // The reported scenario: a machine that locks after 2 minutes crosses at
  // lock+5min; the idle+10min rule never fires separately — the two conditions
  // resolve to one instant via min(), not two timers.
  const idleAt = NOW + IDLE_AWAY_MS - 120_000; // idle+10min minus 2min elapsed
  const lockAt = NOW + LOCK_AWAY_MS - 120_000; // lock+5min minus 2min elapsed
  assert.equal(
    computeAwayAt({ lastSeen: NOW, idleSeconds: 120, lockedSeconds: 120 }),
    lockAt,
  );
  assert.notEqual(computeAwayAt({ lastSeen: NOW, idleSeconds: 120, lockedSeconds: 120 }), idleAt);
});

test("computeAwayAt: idleSeconds already past both thresholds → lastSeen (never negative)", () => {
  // Long idle + long lock: both candidates clamp to >= lastSeen, min is lastSeen.
  assert.equal(
    computeAwayAt({ lastSeen: NOW, idleSeconds: 60 * 60, lockedSeconds: 60 * 60 }),
    NOW,
  );
});

test("desktopState: fresh + before awayAt → present", () => {
  assert.equal(
    desktopState({ lastSeen: NOW, idleSeconds: 0, lockedSeconds: null, awayAt: NOW + 1000 }, NOW + 500),
    "present",
  );
});

test("desktopState: fresh + past awayAt → away", () => {
  assert.equal(
    desktopState({ lastSeen: NOW, idleSeconds: 0, lockedSeconds: null, awayAt: NOW - 1 }, NOW),
    "away",
  );
});

test("desktopState: heartbeat older than TTL → gone", () => {
  assert.equal(
    desktopState({ lastSeen: NOW, idleSeconds: 0, lockedSeconds: null, awayAt: NOW + 1000 }, NOW + PRESENCE_TTL_MS + 1),
    "gone",
  );
});

test("desktopState: never-seen record (lastSeen 0) → gone", () => {
  assert.equal(
    desktopState({ lastSeen: 0, idleSeconds: 0, lockedSeconds: null, awayAt: Infinity }, NOW),
    "gone",
  );
  assert.equal(desktopState(null, NOW), "gone");
});

test("setDesktopPresence: a lower incoming idleSeconds cancels all deferred mobile", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  // Desktop present at the real clock (idle 300s, unlocked): an informational
  // notify routes deferMobile, so something gets parked.
  setDesktopPresence({ idleSeconds: 300, lockedSeconds: null });
  await fireNotify({ message: "build done", sessionID: "ses_c" });
  assert.equal(_deferredMobileTags().length, 1);
  // User produced input since the last heartbeat → lower idle → the parked push
  // is cancelled (they'll see the desktop notification).
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null });
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
});

test("setDesktopPresence: a higher incoming idleSeconds does NOT cancel deferred", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null });
  await fireNotify({ message: "build done", sessionID: "ses_d" });
  assert.equal(_deferredMobileTags().length, 1);
  // Idle grew (user stopped typing) → NOT a "came back" signal → still parked.
  setDesktopPresence({ idleSeconds: 60, lockedSeconds: null });
  assert.equal(_deferredMobileTags().length, 1);
  _resetPushState();
});

test("setDesktopPresence: the first-ever heartbeat does not throw or cancel deferred", () => {
  _resetPushState();
  setDesktopPresence({ idleSeconds: 0, lockedSeconds: null });
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
});

test("setDesktopPresence: a malformed body does not throw and does not corrupt the record", () => {
  _resetPushState();
  const r = setDesktopPresence({ idleSeconds: "junk", lockedSeconds: undefined });
  assert.equal(r.idleSeconds, 0, "non-finite/absent idle coerced to 0");
  assert.equal(r.lockedSeconds, null, "absent locked coerced to null");
  const r2 = setDesktopPresence({ idleSeconds: -3, lockedSeconds: NaN });
  assert.equal(r2.idleSeconds, 0, "negative idle clamped to 0");
  assert.equal(r2.lockedSeconds, null, "NaN locked coerced to null");
  _resetPushState();
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
const dPresent = { lastSeen: T, idleSeconds: 0, lockedSeconds: null, awayAt: T + 100_000 }; // running, user at machine
const dAway = { lastSeen: T, idleSeconds: 0, lockedSeconds: null, awayAt: T - 1 }; // running, user left
const dGone = { lastSeen: T - PRESENCE_TTL_MS - 1, idleSeconds: 0, lockedSeconds: null, awayAt: Infinity }; // no heartbeat
const noMobile = { focusSessionId: null, focusVisible: false };

test("notifTier: blocking vs informational", () => {
  assert.equal(notifTier({ kind: "permission" }), "blocking");
  assert.equal(notifTier({ kind: "question" }), "blocking");
  assert.equal(notifTier({ kind: "error" }), "blocking");
  assert.equal(notifTier({ kind: "notify", urgent: true }), "blocking");
  assert.equal(notifTier({ kind: "notify" }), "informational");
  assert.equal(notifTier({ kind: "done" }), "informational");
});

test("route: informational + desktop present → desktop now, mobile deferred", () => {
  const r = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dPresent, ...noMobile },
    T,
  );
  assert.deepEqual(r, { desktop: true, mobileNow: false, deferMobile: true });
});

test("route: informational + desktop away → desktop now + mobile now", () => {
  const r = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dAway, ...noMobile },
    T,
  );
  assert.deepEqual(r, { desktop: true, mobileNow: true, deferMobile: false });
});

test("route: informational + desktop gone → mobile only", () => {
  const r = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dGone, ...noMobile },
    T,
  );
  assert.deepEqual(r, { desktop: false, mobileNow: true, deferMobile: false });
});

test("route: informational + mobile foreground on this session → no mobile, no defer", () => {
  // present + phone viewing this session → nothing parked for mobile.
  const present = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dPresent, focusSessionId: "ses_1", focusVisible: true },
    T,
  );
  assert.deepEqual(present, { desktop: true, mobileNow: false, deferMobile: false });
  // away + phone viewing this session → desktop only, no mobile.
  const away = routeNotification(
    { kind: "done", sessionId: "ses_1" },
    { desktop: dAway, focusSessionId: "ses_1", focusVisible: true },
    T,
  );
  assert.equal(away.mobileNow, false);
  assert.equal(away.deferMobile, false);
  // gone + phone viewing this session → no mobile.
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
  assert.deepEqual(r, { desktop: true, mobileNow: true, deferMobile: false });
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
// Deferred mobile delivery (stateful)
// ---------------------------------------------------------------------------

test("deferred: desktop present parks the mobile push; going away flushes it", async () => {
  _resetPushState();
  setDesktopSink(() => {}); // no-op desktop leg
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // fresh, present
  await fireNotify({ message: "build done", sessionID: "ses_esc" });
  assert.deepEqual(_deferredMobileTags(), ["notify-ses_esc"]);
  // The user leaves the desk → the next flush delivers.
  setDesktopPresence({ idleSeconds: 60 * 60, lockedSeconds: null });
  await flushDeferredMobile();
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
});

test("deferred: a lower idle heartbeat (user returns) cancels ALL parked deliveries", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // present
  await fireNotify({ message: "x", sessionID: "ses_a" });
  await fireNotify({ message: "y", sessionID: "ses_b" });
  assert.equal(_deferredMobileTags().length, 2);
  setDesktopPresence({ idleSeconds: 0, lockedSeconds: null }); // fresh input
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
});

test("deferred: answering one session cancels only its parked delivery", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // present
  await fireNotify({ message: "x", sessionID: "ses_a" });
  await fireNotify({ message: "y", sessionID: "ses_b" });
  assert.equal(_deferredMobileTags().length, 2);
  cancelDeferredMobileForSession("ses_a");
  assert.deepEqual(_deferredMobileTags(), ["notify-ses_b"]);
  _resetPushState();
});

test("deferred: re-notify same tag supersedes (no stack)", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // present
  await fireNotify({ message: "first", sessionID: "ses_s" });
  await fireNotify({ message: "second", sessionID: "ses_s" });
  assert.deepEqual(_deferredMobileTags(), ["notify-ses_s"]);
  cancelAllDeferredMobile();
  _resetPushState();
});

// Counts mobile sends (each sendPush → one APNs fanout fetch). Installs the
// fanout fakes and returns a counter, for the flush tests below.
function withFanoutCount() {
  _resetFanoutFakesForTest();
  const sends = { count: 0 };
  _setFanoutFakesForTest({
    fetchImpl: async () => {
      sends.count++;
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    },
    loadApnsTokens: async () => [{ kind: "apns", token: "f1a1", registeredAt: 1 }],
    removeApnsToken: async () => ({ ok: true, count: 0 }),
    readBoxGatewayIdentity: async () => ({
      box_id: "abcdef0123456789abcdef0123456789",
      gateway_token: "00112233445566778899aabbccddeeff",
    }),
    gatewayBase: "https://gateway.test.local",
  });
  return sends;
}

test("flushDeferredMobile: NOT sent while present", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // present
  await fireNotify({ message: "held", sessionID: "ses_h" });
  const sends = withFanoutCount();
  await flushDeferredMobile();
  assert.equal(sends.count, 0, "desktop still present → nothing delivered");
  assert.equal(_deferredMobileTags().length, 1, "still parked");
  _resetPushState();
  _resetFanoutFakesForTest();
});

test("flushDeferredMobile: IS sent once the state reaches away", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // present
  await fireNotify({ message: "held", sessionID: "ses_h" });
  const sends = withFanoutCount();
  // Idle grew to 1h → awayAt is now → the flush sees "away".
  setDesktopPresence({ idleSeconds: 60 * 60, lockedSeconds: null });
  await flushDeferredMobile();
  assert.equal(sends.count, 1, "delivered to mobile once away");
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
  _resetFanoutFakesForTest();
});

test("flushDeferredMobile: IS sent when the state reaches gone", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // present
  await fireNotify({ message: "held", sessionID: "ses_ng" });
  const sends = withFanoutCount();
  // Same idle (no cancel), but a stale lastSeen past the TTL → gone.
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }, Date.now() - PRESENCE_TTL_MS - 1);
  await flushDeferredMobile();
  assert.equal(sends.count, 1, "delivered to mobile once gone");
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
  _resetFanoutFakesForTest();
});

test("flushDeferredMobile: dropped without sending after 30 min", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  const t0 = Date.now();
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }, t0); // present
  await fireNotify({ message: "held", sessionID: "ses_stale" }); // deferredAt ≈ t0
  // 31 minutes later the desktop is still present (fresh same-idle heartbeat),
  // but the parked notification is stale → dropped, not sent.
  const t1 = t0 + 31 * 60_000;
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }, t1);
  const sends = withFanoutCount();
  await flushDeferredMobile(t1);
  assert.equal(sends.count, 0, "stale parked push dropped without sending");
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
  _resetFanoutFakesForTest();
});

test("flushDeferredMobile: dropped by cancelDeferredMobileForSession", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null });
  await fireNotify({ message: "held", sessionID: "ses_cn" });
  cancelDeferredMobileForSession("ses_cn");
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
});

test("REGRESSION: a deferred push that becomes deliverable flushes to EXACTLY ONE sendPush", async () => {
  _resetPushState();
  setDesktopSink(() => {});
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }); // present
  await fireNotify({ message: "held", sessionID: "ses_once" });
  assert.equal(_deferredMobileTags().length, 1);
  const sends = withFanoutCount();
  // Make it deliverable (gone) and flush twice — the second flush must send
  // nothing because the entry was already delivered and removed.
  setDesktopPresence({ idleSeconds: 5, lockedSeconds: null }, Date.now() - PRESENCE_TTL_MS - 1);
  await flushDeferredMobile();
  await flushDeferredMobile();
  assert.equal(sends.count, 1, "exactly one sendPush across both flushes");
  assert.deepEqual(_deferredMobileTags(), []);
  _resetPushState();
  _resetFanoutFakesForTest();
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
    const r1 = await addApnsToken("aaaa1111", { store });
    assert.equal(r1.ok, true);
    assert.equal(r1.count, 1);
    const r2 = await addApnsToken("bbbb2222", { store });
    assert.equal(r2.count, 2);
    const tokens = await _loadApnsTokensForTest(store);
    assert.deepEqual(
      tokens.map((t) => t.token).sort(),
      ["aaaa1111", "bbbb2222"],
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
    await addApnsToken("dddd1111", { store });
    await addApnsToken("dddd1111", { store });
    await addApnsToken("dddd1111", { store });
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, "dddd1111");
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
    await addApnsToken("cafe1111", { store });
    await addApnsToken("cafe2222", { store });
    const r = await removeApnsToken("cafe2222", { store });
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
    const tokens = await _loadApnsTokensForTest(store);
    assert.deepEqual(
      tokens.map((t) => t.token),
      ["cafe1111"],
    );
  } finally {
    await rm(store, { force: true });
  }
});

test("removeApnsToken: no-op on unknown token (returns count unchanged)", async () => {
  const store = makeApnsStorePath("remove-noop");
  try {
    await addApnsToken("ab01", { store });
    const r = await removeApnsToken("cd02", { store });
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
    return okJson({ results: [{ token: "f1a1", ok: true, prune: false }] });
  };
  _setFanoutFakesForTest({
    fetchImpl: fakeFetch,
    loadApnsTokens: async () => [{ kind: "apns", token: "f1a1", registeredAt: 1 }],
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
    assert.deepEqual(body.tokens, ["f1a1"]);
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
        { token: "beef1111", ok: true, prune: false },
        { token: "beef2222", ok: false, prune: true },
        { token: "beef3333",  ok: false, prune: true },
        { token: "beef4444", ok: false, prune: false }, // 500-style, keep
      ],
    });
  _setFanoutFakesForTest({
    fetchImpl: fakeFetch,
    loadApnsTokens: async () => [
      { kind: "apns", token: "beef1111", registeredAt: 1 },
      { kind: "apns", token: "beef2222", registeredAt: 1 },
      { kind: "apns", token: "beef3333",  registeredAt: 1 },
      { kind: "apns", token: "beef4444", registeredAt: 1 },
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
    assert.deepEqual(pruned.sort(), ["beef2222", "beef3333"]);
  } finally {
    _resetFanoutFakesForTest();
  }
});

// The three delivery-failure modes (network throw, 401, 500) share one
// contract: warn + return, no exception, no prune. Table-driven so the
// fake wiring and warn-capture scaffolding exist once.
const FANOUT_FAILURE_CASES = [
  {
    label: "network throw",
    fetchImpl: async () => {
      throw new Error("socket reset");
    },
    warnChecks: [/gateway send failed/, /socket reset/],
  },
  {
    label: "gateway 401",
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    warnChecks: [/status=401/],
  },
  {
    label: "gateway 500",
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    warnChecks: [/status=500/],
  },
  {
    label: "gateway 200 with malformed JSON body",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected token");
      },
    }),
    warnChecks: [/malformed JSON/],
  },
];

for (const c of FANOUT_FAILURE_CASES) {
  test(`sendApnsFanout: ${c.label} → warn + return (no exception, no prune)`, async () => {
    _resetFanoutFakesForTest();
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    let removeCalls = 0;
    _setFanoutFakesForTest({
      fetchImpl: c.fetchImpl,
      loadApnsTokens: async () => [{ kind: "apns", token: "f1a1", registeredAt: 1 }],
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
      assert.equal(removeCalls, 0, "no prune on delivery failure");
      for (const re of c.warnChecks) {
        assert.ok(warns.some((w) => re.test(w)), `warn matches ${re}`);
      }
    } finally {
      console.warn = origWarn;
      _resetFanoutFakesForTest();
    }
  });
}

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
    loadApnsTokens: async () => [{ kind: "apns", token: "f1a1", registeredAt: 1 }],
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

// ---------------------------------------------------------------------------
// APNs token-shape validation (2026-08-07). One invalid stored token makes
// the gateway 400 the ENTIRE /push batch (its isHexToken caps at 128 hex
// chars) and pruning only runs on a 200 — so a single simulator
// pseudo-token (80 bytes = 160 hex chars) silenced push for every real
// device, permanently. Regression tests: the registration chokepoint
// rejects them, and the fanout self-heals a store poisoned before the
// validation existed.
// ---------------------------------------------------------------------------

// Shared harness for the validation fanout tests: installs the standard
// identity/gateway fakes, records POSTs + prunes, runs `fn`, and always
// resets. Keeps the fake wiring in ONE place instead of per-test copies.
async function withValidationFanout({ storeTokens }, fn) {
  _resetFanoutFakesForTest();
  const calls = [];
  const pruned = [];
  _setFanoutFakesForTest({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    },
    loadApnsTokens: async () => storeTokens,
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
    await fn({ calls, pruned });
  } finally {
    _resetFanoutFakesForTest();
  }
}

test("isValidApnsToken: mirrors the gateway's isHexToken bounds", () => {
  assert.equal(isValidApnsToken("a1".repeat(32)), true, "64-hex real token");
  assert.equal(isValidApnsToken("a1".repeat(64)), true, "128-hex upper bound");
  assert.equal(isValidApnsToken("a1".repeat(80)), false, "160-hex simulator pseudo-token");
  assert.equal(isValidApnsToken("tok-aaa"), false, "non-hex");
  assert.equal(isValidApnsToken(""), false);
  assert.equal(isValidApnsToken(null), false);
});

test("register-apns REGRESSION: rejects a 160-hex simulator pseudo-token and non-hex junk", async () => {
  const store = makeApnsStorePath("reject-invalid");
  try {
    await assert.rejects(() => addApnsToken("80".repeat(80), { store }), /rejected/);
    await assert.rejects(() => addApnsToken("tok-not-hex", { store }), /rejected/);
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 0, "nothing persisted");
  } finally {
    await rm(store, { force: true });
  }
});

test("sendApnsFanout REGRESSION: filters + prunes invalid stored tokens instead of poisoning the batch", async () => {
  const badToken = "80".repeat(80); // 160 hex chars — gateway would 400 the batch
  await withValidationFanout(
    {
      storeTokens: [
        { kind: "apns", token: "beef1111", registeredAt: 1 },
        { kind: "apns", token: badToken, registeredAt: 2 },
      ],
    },
    async ({ calls, pruned }) => {
      await sendApnsFanout({ kind: "done", title: "T", body: "B" });
      assert.equal(calls.length, 1, "batch still sent for the valid token");
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body.tokens, ["beef1111"], "invalid token excluded from the batch");
      assert.deepEqual(pruned, [badToken], "invalid token pruned from the store");
    },
  );
});

test("sendApnsFanout: all-invalid store prunes everything and sends nothing", async () => {
  await withValidationFanout(
    { storeTokens: [{ kind: "apns", token: "80".repeat(80), registeredAt: 1 }] },
    async ({ calls, pruned }) => {
      await sendApnsFanout({ kind: "done" });
      assert.equal(calls.length, 0, "no POST when nothing valid remains");
      assert.equal(pruned.length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// APNs case-insensitivity (BET-1044). Device tokens are hex; Apple routes either
// spelling, so the same phone registered under two cases is ONE device — but an
// exact-match store treated it as two and delivered every notification twice.
// ---------------------------------------------------------------------------

test("register-apns REGRESSION: upper- then lower-case same token → ONE entry (BET-1044)", async () => {
  const store = makeApnsStorePath("case-dedupe");
  try {
    await addApnsToken("36DBB6F9abcdef", { store });
    const r = await addApnsToken("36dbb6f9abcdef", { store });
    assert.equal(r.count, 1, "case-differing re-registration is an upsert, not an append");
    const tokens = await _loadApnsTokensForTest(store);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, "36dbb6f9abcdef", "stored lowercased at the chokepoint");
  } finally {
    await rm(store, { force: true });
  }
});

test("removeApnsToken REGRESSION: opposite case removes the stored entry (BET-1044)", async () => {
  const store = makeApnsStorePath("case-remove");
  try {
    await addApnsToken("36dbb6f9abcdef", { store });
    const r = await removeApnsToken("36DBB6F9ABCDEF", { store });
    assert.equal(r.count, 0, "a prune reported in upper case matches the stored entry");
    assert.equal((await _loadApnsTokensForTest(store)).length, 0);
  } finally {
    await rm(store, { force: true });
  }
});

test("sendApnsFanout REGRESSION: collapses case-differing duplicate tokens to ONE delivery (BET-1044)", async () => {
  await withValidationFanout(
    {
      storeTokens: [
        { kind: "apns", token: "AA11", registeredAt: 1 },
        { kind: "apns", token: "aa11", registeredAt: 2 },
      ],
    },
    async ({ calls, pruned }) => {
      await sendApnsFanout({ kind: "done" });
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.tokens.length, 1, "both spellings → one token in the batch");
      assert.equal(pruned.length, 1, "the duplicate spelling is self-healed out of the store");
    },
  );
});

// ---------------------------------------------------------------------------
// One notification per event (BET-1044). Each opencode event arrives twice —
// once on the global stream, once on the per-directory scoped one — so firePush
// must drop an event whose id it has already seen, else session.error notifies
// twice. Uses a permission.asked on a background-job child session: that kind is
// NOT suppressed (a blocked job must still page the user), so the desktop sink
// call is a clean per-notification observable.
// ---------------------------------------------------------------------------

function primeDelegateJob(childId) {
  const jobsPath = statePath("delegate-jobs.json");
  mkdirSync(statePath(), { recursive: true });
  writeFileSync(jobsPath, JSON.stringify({ jobs: [{ childSessionID: childId }] }));
  return jobsPath;
}

test("firePush REGRESSION: firing the same event twice → ONE notification (BET-1044)", async () => {
  const jobsPath = primeDelegateJob("ses_dup1");
  _resetPushState();
  const sinkCalls = [];
  setDesktopSink(() => sinkCalls.push(1));
  try {
    const evt = {
      id: "evt_dup1",
      type: "permission.asked",
      properties: { sessionID: "ses_dup1", id: "per_dup1" },
    };
    await firePush(evt);
    await firePush(evt);
    assert.equal(sinkCalls.length, 1, "same event on both streams → one notification");
  } finally {
    rmSync(jobsPath, { force: true });
    _resetPushState();
  }
});

test("firePush: two events with different ids → two notifications", async () => {
  const jobsPath = primeDelegateJob("ses_dup2");
  _resetPushState();
  const sinkCalls = [];
  setDesktopSink(() => sinkCalls.push(1));
  try {
    const a = { id: "evt_a", type: "permission.asked", properties: { sessionID: "ses_dup2", id: "per_a" } };
    const b = { id: "evt_b", type: "permission.asked", properties: { sessionID: "ses_dup2", id: "per_b" } };
    await firePush(a);
    await firePush(b);
    assert.equal(sinkCalls.length, 2, "two distinct events → two notifications");
  } finally {
    rmSync(jobsPath, { force: true });
    _resetPushState();
  }
});

test("firePush: an event with no id is not dropped", async () => {
  const jobsPath = primeDelegateJob("ses_noid");
  _resetPushState();
  const sinkCalls = [];
  setDesktopSink(() => sinkCalls.push(1));
  try {
    await firePush({ type: "permission.asked", properties: { sessionID: "ses_noid", id: "per_noid" } });
    assert.equal(sinkCalls.length, 1, "an id-less event still notifies (never silently swallowed)");
  } finally {
    rmSync(jobsPath, { force: true });
    _resetPushState();
  }
});
