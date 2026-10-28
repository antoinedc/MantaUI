// WS02 server-first (SF-4 / SF-5) at the RPC seam: the read-only job refusal on the
// nine guarded channels, delegate:job-for-session, decorated delegate:list, the
// approve rule check, and inbox outcome decoration. Dependency-injected — no live box.
// Green once the M-02-srv-6…10 mounts are applied to rpc.mjs.
import { BOX_CAPABILITIES } from "./boxCapabilities.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildHandlers, dispatch, handleRpcRequest } from "./rpc.mjs";
import { createDelegateView, READ_ONLY_JOB_MESSAGE, APPROVAL_RULES_MESSAGE } from "./delegateView.mjs";

const stubDeps = () => ({
  tmux: { listProjects: async () => [] },
  pty: {},
  bus: {},
  syncState: {
    refreshNow: async () => {},
    applyConfig: () => {},
    snapshot: () => ({ projects: [] }),
    payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }),
    everSucceeded: () => true,
  },
  local: { configGet: async () => ({ projects: [] }) },
  push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
});

const JOB_SID = "ses_job";
const WORK_SID = "ses_work";
const jobs = [
  { id: "j1", name: "a", childSessionID: JOB_SID, parentSessionID: "ses_p", status: "running", model: null, activity: "x", correlation: null, attempt: 1, createdAt: 1 },
  { id: "j2", name: "b", childSessionID: WORK_SID, parentSessionID: "ses_p", status: "running", model: null, activity: "y", correlation: { kind: "work" }, attempt: 1, createdAt: 1 },
];

function rig({ cancelResult = { outcome: "cancelled" } } = {}) {
  const log = [];
  const oc = {
    sendPrompt: async (i) => log.push(["sendPrompt", i]),
    runCommand: async (i) => log.push(["runCommand", i]),
    compactSession: (sid) => (log.push(["compactSession", sid]), { ok: true, sid }),
    cancelInboxItem: async () => {},
    setInboxDelivery: async () => {},
    getMessage: async () => null,
    listModels: async () => [],
    getSessionDirectory: async () => undefined,
    replyPermission: async (i) => log.push(["replyPermission", i]),
    replyQuestion: async (i) => log.push(["replyQuestion", i]),
    rejectQuestion: async (i) => log.push(["rejectQuestion", i]),
    interruptSession: async (sid, o) => log.push(["interruptSession", sid, o]),
  };
  const streamInterp = {
    getInbox: async () => ({ epoch: "e", rev: 1, items: [] }),
    cancelInbox: async (sid, id) => (log.push(["cancelInbox", sid, id]), cancelResult),
    setInboxDelivery: async (sid, id, d) => (log.push(["setInboxDelivery", sid, id, d]), { outcome: "changed" }),
  };
  const handoff = { admitPrompt: async (i) => (log.push(["admitPrompt", i]), { ok: true }), guardCommand: (sid) => ({ target: sid }) };
  const ctoConversation = {
    isConversationSession: async () => false,
    admitDirect: async (i) => log.push(["admitDirect", i]),
    admitCommand: async (i) => log.push(["admitCommand", i]),
  };
  const delegateView = createDelegateView({
    loadJobs: async () => jobs,
    listProjects: async () => [],
    listModels: async () => [],
  });
  const delegate = {
    listJobs: async () => jobs,
    listPendingApprovals: () => [],
    approve: (id, tools) => (log.push(["approve", id, tools]), true),
    decline: () => true,
  };
  const handlers = buildHandlers({
    oc,
    streamInterp,
    handoff,
    ctoConversation,
    delegate,
    delegateView,
    backgroundCommandNames: async () => new Set(), // never reach a live opencode
    ...stubDeps(),
  });
  return { handlers, log };
}

// A minimal req/res pair for handleRpcRequest.
function call(handlers, channel, args) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.headers = {};
    const res = {
      writeHead(status) { this.status = status; },
      end(body) { resolve({ status: this.status, body: JSON.parse(Buffer.from(body).toString("utf8")) }); },
    };
    handleRpcRequest(handlers, channel, req, res);
    req.emit("data", JSON.stringify({ args }));
    req.emit("end");
  });
}

const GUARDED = [
  ["opencode:prompt", (sid) => [{ sessionId: sid, text: "hi" }], ["admitPrompt"]],
  ["opencode:inbox-cancel", (sid) => [{ sessionId: sid, id: "m1" }], ["cancelInbox"]],
  ["opencode:inbox-set-delivery", (sid) => [{ sessionId: sid, id: "m1", delivery: "steer" }], ["setInboxDelivery"]],
  ["opencode:compact-session", (sid) => [sid], ["compactSession"]],
  ["opencode:run-command", (sid) => [{ sessionId: sid, command: "review", arguments: "" }], ["runCommand"]],
  // Orchestrator decision (review F4): the job's own asks and its turn are the box's to
  // refuse too, so a client that skips the read-only bar cannot answer or interrupt them.
  ["opencode:permission-reply", (sid) => [{ requestId: "p1", reply: "once", sessionId: sid }], ["replyPermission"]],
  ["opencode:question-reply", (sid) => [{ requestId: "q1", answers: [["a"]], sessionId: sid }], ["replyQuestion"]],
  ["opencode:question-reject", (sid) => [{ requestId: "q1", sessionId: sid }], ["rejectQuestion"]],
  ["opencode:abort", (sid) => [sid], ["interruptSession"]],
];

for (const [channel, argsFor, downstream] of GUARDED) {
  test(`${channel}: a read-only job session → 409 with the exact body and zero downstream calls`, async () => {
    const { handlers, log } = rig();
    const r = await call(handlers, channel, argsFor(JOB_SID));
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: READ_ONLY_JOB_MESSAGE, code: "read_only_job" });
    assert.equal(READ_ONLY_JOB_MESSAGE, "This is a background job — it can't take messages");
    assert.deepEqual(log, [], "nothing reached the downstream fakes");
  });

  test(`${channel}: an ordinary session and a work job reach the existing route`, async () => {
    for (const sid of ["ses_ordinary", WORK_SID]) {
      const { handlers, log } = rig();
      const r = await call(handlers, channel, argsFor(sid));
      assert.equal(r.status, 200, `${channel} ${sid}`);
      assert.equal(log.filter((l) => downstream.includes(l[0])).length, 1, `${channel} ${sid}: downstream called once`);
    }
  });
}

test("opencode:compact-session is async now and still returns the downstream value", async () => {
  const { handlers } = rig();
  assert.deepEqual(await dispatch(handlers, "opencode:compact-session", ["ses_ordinary"]), { ok: true, sid: "ses_ordinary" });
});

test("a handler that throws a HandoffError keeps its mapped status and {error, message} body", async () => {
  const { handlers } = rig();
  handlers["x:handoff"] = async () => {
    throw Object.assign(new Error("slow down"), { name: "HandoffError", code: "expired" });
  };
  const r = await call(handlers, "x:handoff", []);
  assert.notEqual(r.status, 409);
  assert.equal(r.body.error, "expired");
  assert.equal(r.body.message, "slow down");
});

test("delegate:job-for-session answers the view for a job and {readOnly:false} otherwise", async () => {
  const { handlers } = rig();
  const a = await dispatch(handlers, "delegate:job-for-session", [{ sessionId: JOB_SID }]);
  assert.equal(a.readOnly, true);
  assert.equal(a.job.id, "j1");
  assert.deepEqual(await dispatch(handlers, "delegate:job-for-session", [{ sessionId: WORK_SID }]), { readOnly: false });
  assert.deepEqual(await dispatch(handlers, "delegate:job-for-session", [{ sessionId: "nope" }]), { readOnly: false });
  await assert.rejects(dispatch(handlers, "delegate:job-for-session", [{}]), /sessionId is required/);
});

test("delegate:list rows gain statusLabel and summary", async () => {
  const { handlers } = rig();
  const list = await dispatch(handlers, "delegate:list", [undefined]);
  assert.equal(list[0].statusLabel, "running");
  assert.equal(list[0].summary, "0 files changed");
  assert.equal(list[0].id, "j1");
});

test("delegate:approve refuses an empty or blank rule list and keeps the approval pending", async () => {
  const { handlers, log } = rig();
  for (const tools of [[], [{ permission: "bash", pattern: "" }], [{ permission: "", pattern: "x" }]]) {
    assert.deepEqual(await dispatch(handlers, "delegate:approve", [{ id: "a1", tools }]), { ok: false, error: APPROVAL_RULES_MESSAGE });
  }
  assert.deepEqual(log, [], "approve() was never called");
  assert.deepEqual(await dispatch(handlers, "delegate:approve", [{ id: "a1", tools: [{ permission: "bash", pattern: "npm *" }] }]), { ok: true });
  assert.deepEqual(await dispatch(handlers, "delegate:approve", [{ id: "a1" }]), { ok: true });
});

test("inbox-cancel decoration: restore:true on a cancelled item with text restores it; × never does", async () => {
  const item = { id: "m1", text: "hello", attachmentCount: 1, delivery: "queue" };
  const { handlers } = rig({ cancelResult: { outcome: "cancelled", item } });
  const edit = await dispatch(handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a", id: "m1", restore: true }]);
  assert.equal(edit.restoreText, "hello");
  assert.equal(edit.notice, "Attachments weren't restored — re-attach them");
  assert.equal(edit.outcome, "cancelled");
  const x = await dispatch(handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a", id: "m1" }]);
  assert.equal(x.restoreText, null);
  assert.equal(x.notice, null);
});

test("inbox-cancel decoration: cancelled WITHOUT an item never throws and is not a failure", async () => {
  const { handlers } = rig({ cancelResult: { outcome: "cancelled" } });
  const r = await dispatch(handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a", id: "m1", restore: true }]);
  assert.equal(r.error, null);
  assert.equal(r.restoreText, null);
  assert.equal(r.notice, "Removed from the queue, but its text couldn't be recovered");
});

test("inbox-cancel / set-delivery: delivered and unknown carry the box's sentences", async () => {
  const a = rig({ cancelResult: { outcome: "delivered" } });
  assert.equal((await dispatch(a.handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a", id: "m" }])).notice, "Already sent to the agent");
  const b = rig({ cancelResult: { outcome: "unknown" } });
  assert.match((await dispatch(b.handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a", id: "m" }])).error, /may still be sent/);
  const c = rig();
  const sd = await dispatch(c.handlers, "opencode:inbox-set-delivery", [{ sessionId: "ses_a", id: "m", delivery: "queue" }]);
  assert.deepEqual({ notice: sd.notice, error: sd.error }, { notice: null, error: null });
});

test("server:version carries capabilities including chat-cards-1", async () => {
  const { handlers } = rig();
  const v = await dispatch(handlers, "server:version", []);
  assert.ok(Array.isArray(v.capabilities));
  assert.ok(v.capabilities.includes("chat-cards-1"));
  // The RPC and GET /api/version carry the one list (WS11 D1).
  assert.deepEqual(v.capabilities, [...BOX_CAPABILITIES]);
});
