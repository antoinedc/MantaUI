// opencode:prompt / run-command `delivery` (K1), opencode:abort resume (K5) and
// the opencode:inbox / inbox-cancel channels (K4) at the RPC seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, buildHandlers } from "./rpc.mjs";

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

function rig({ withInterp = true } = {}) {
  const log = [];
  const oc = {
    sendPrompt: async (i) => log.push(["sendPrompt", i]),
    runCommand: async (i) => log.push(["runCommand", i]),
    interruptSession: async (sid, o) => log.push(["interrupt", sid, o]),
    cancelInboxItem: async (sid, id) => log.push(["cancelInboxItem", sid, id]),
    getMessage: async (sid, id) => (log.push(["getMessage", sid, id]), null),
  };
  const ctoConversation = {
    isConversationSession: async (sid) => sid === "ses_cto",
    admitDirect: async (i) => log.push(["admitDirect", i]),
    admitCommand: async (i) => log.push(["admitCommand", i]),
  };
  const streamInterp = withInterp
    ? {
        getInbox: async (sid) => (log.push(["getInbox", sid]), { epoch: "e", rev: 3, items: [] }),
        cancelInbox: async (sid, id, deps) => {
          await deps.deleteItem();
          await deps.getMessage();
          log.push(["cancelInbox", sid, id]);
          return { outcome: "cancelled" };
        },
      }
    : null;
  const handlers = buildHandlers({ oc, ctoConversation, streamInterp, ...stubDeps() });
  return { handlers, log };
}

test("opencode:prompt forwards a valid delivery on an ordinary session and refuses an invalid one", async () => {
  const { handlers, log } = rig();
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "x", delivery: "steer" }]);
  assert.deepEqual(log[0], ["sendPrompt", { sessionId: "ses_a", text: "x", delivery: "steer" }]);
  await assert.rejects(dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "x", delivery: "now" }]), /invalid delivery/);
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "x" }]);
  assert.equal(log.length, 2, "an absent delivery is an ordinary idle send");
});

test("opencode:prompt / run-command on the CTO conversation DROP delivery before admission", async () => {
  const { handlers, log } = rig();
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_cto", text: "x", delivery: "queue", messageID: "m1" }]);
  await dispatch(handlers, "opencode:run-command", [{ sessionId: "ses_cto", command: "c", arguments: "", delivery: "steer" }]);
  assert.deepEqual(log[0], ["admitDirect", { sessionId: "ses_cto", text: "x", messageID: "m1" }]);
  assert.deepEqual(log[1], ["admitCommand", { sessionId: "ses_cto", command: "c", arguments: "" }]);
  assert.ok(!("delivery" in log[0][1]) && !("delivery" in log[1][1]));
});

test("opencode:run-command forwards delivery on an ordinary session", async () => {
  const { handlers, log } = rig();
  await dispatch(handlers, "opencode:run-command", [{ sessionId: "ses_a", command: "review", arguments: "x", delivery: "steer" }]);
  assert.deepEqual(log[0], ["runCommand", { sessionId: "ses_a", command: "review", arguments: "x", delivery: "steer" }]);
});

test("opencode:abort is the user's Stop: resume=true on ordinary sessions, resume=false on the CTO conversation", async () => {
  const { handlers, log } = rig();
  await dispatch(handlers, "opencode:abort", ["ses_a"]);
  await dispatch(handlers, "opencode:abort", ["ses_cto"]);
  assert.deepEqual(log, [["interrupt", "ses_a", { resume: true }], ["interrupt", "ses_cto", { resume: false }]]);
});

test("opencode:inbox answers the interpreter snapshot; the CTO conversation is refused loudly", async () => {
  const { handlers, log } = rig();
  assert.deepEqual(await dispatch(handlers, "opencode:inbox", ["ses_a"]), { epoch: "e", rev: 3, items: [] });
  assert.deepEqual(log, [["getInbox", "ses_a"]]);
  await assert.rejects(dispatch(handlers, "opencode:inbox", ["ses_cto"]), /not available for the CTO conversation/);
  await assert.rejects(dispatch(handlers, "opencode:inbox", [""]), /sessionId is required/);
});

test("opencode:inbox-cancel wires DELETE + message lookup into the interpreter; refuses CTO and a missing id", async () => {
  const { handlers, log } = rig();
  assert.deepEqual(await dispatch(handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a", id: "msg_1" }]), { outcome: "cancelled" });
  assert.deepEqual(log, [["cancelInboxItem", "ses_a", "msg_1"], ["getMessage", "ses_a", "msg_1"], ["cancelInbox", "ses_a", "msg_1"]]);
  await assert.rejects(dispatch(handlers, "opencode:inbox-cancel", [{ sessionId: "ses_cto", id: "msg_1" }]), /not available for the CTO conversation/);
  await assert.rejects(dispatch(handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a" }]), /id is required/);
});

test("without the interpreter wired the inbox channels fail clearly (never an empty list)", async () => {
  const { handlers } = rig({ withInterp: false });
  await assert.rejects(dispatch(handlers, "opencode:inbox", ["ses_a"]), /not available on this box/);
  await assert.rejects(dispatch(handlers, "opencode:inbox-cancel", [{ sessionId: "ses_a", id: "x" }]), /not available on this box/);
});
