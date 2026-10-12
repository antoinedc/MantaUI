import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSeatRetryWatch,
  lastUserModelFromMessages,
  SIGNAL_DEBOUNCE_MS,
  RECOVER_DEBOUNCE_MS,
  RECOVER_MIN_WAIT_MS,
} from "./seatRetryWatch.mjs";
import { KEEP_GOING_PROMPT } from "./usageResume.mjs";

const LIMIT_MSG = "This request would exceed your account's rate limit. Please try again later.";

function setup(over = {}) {
  const calls = [];
  const logs = [];
  let t = 1_000_000;
  const assignments = over.assignments ?? { s1: { provider: "claude", conversation: "s1" } };
  const watch = createSeatRetryWatch({
    sessionAssignment: (sid) => assignments[sid] ?? null,
    onLimitSignal:
      over.onLimitSignal ?? (async (sig) => (calls.push(["signal", sig]), { moved: true, from: "seat-1", to: "seat-2" })),
    abortSession: over.abortSession ?? (async (sid) => void calls.push(["abort", sid])),
    lastUserModel:
      over.lastUserModel ?? (async (sid) => (calls.push(["lastUserModel", sid]), { providerID: "anthropic", modelID: "claude-opus-4" })),
    deliver: over.deliver ?? (async (args) => (calls.push(["deliver", args]), { ok: true })),
    now: () => t,
    log: { warn: (...a) => logs.push(a.join(" ")) },
  });
  return { watch, calls, logs, assignments, advance: (ms) => (t += ms) };
}

const retry = (sessionID, message = LIMIT_MSG) => ({
  type: "session.status",
  properties: { sessionID, status: { type: "retry", attempt: 1, message, next: Date.now() + 3_600_000 } },
});
// `next` is relative to the fake clock in setup() (starts at 1_000_000); null → no `next` field.
const T0 = 1_000_000;
const retryNext = (sessionID, next, message = LIMIT_MSG) => ({
  type: "session.status",
  properties: { sessionID, status: { type: "retry", attempt: 1, message, ...(next === null ? {} : { next }) } },
});
const status = (sessionID, type) => ({ type: "session.status", properties: { sessionID, status: { type } } });
const moved = (sessionId, extra = {}) => ({ sessionId, provider: "claude", from: "seat-1", to: "seat-2", ...extra });

test("retry + rate-limit message → limit signal; moved → abort, then Keep going on the last user model", async () => {
  const { watch, calls, logs } = setup();
  await watch.observeEvent(retry("s1"));
  assert.deepEqual(calls, [
    ["signal", { sessionId: "s1", adapterId: "claude", kind: "rate-limit" }],
    ["abort", "s1"],
    ["lastUserModel", "s1"],
    ["deliver", { sessionId: "s1", text: KEEP_GOING_PROMPT, model: { providerID: "anthropic", modelID: "claude-opus-4" } }],
  ]);
  assert.ok(logs.some((l) => l === "[seat-retry] recovered s1 seat-1 -> seat-2"), logs.join("|"));
});

test("a Codex usage-limit wording also counts (classified as a refusal); the signal carries the provider", async () => {
  const { watch, calls } = setup({ assignments: { x: { provider: "codex", conversation: "x" } } });
  await watch.observeEvent(retry("x", "usage_limit_reached"));
  assert.deepEqual(calls[0], ["signal", { sessionId: "x", adapterId: "codex", kind: "refusal" }]);
});

test("overload / unrelated retry messages do nothing", async () => {
  const { watch, calls } = setup();
  for (const m of ["Overloaded", "server_is_overloaded", "Service temporarily unavailable", "", null]) {
    await watch.observeEvent(retry("s1", m));
  }
  assert.deepEqual(calls, []);
});

test("a session with no seat assignment is ignored", async () => {
  const { watch, calls } = setup({ assignments: {} });
  await watch.observeEvent(retry("s1"));
  await watch.onMoved(moved("s1"));
  assert.deepEqual(calls, []);
});

test("limit handler says not moved → nothing is aborted, but the session stays tracked for a later move", async () => {
  const { watch, calls } = setup({ onLimitSignal: async (sig) => (void 0, { moved: false }) });
  await watch.observeEvent(retry("s1"));
  assert.deepEqual(calls, []);
  await watch.onMoved(moved("s1"));
  assert.deepEqual(calls.map((c) => c[0]), ["abort", "lastUserModel", "deliver"]);
});

test("limit handler returning null (it failed) → nothing", async () => {
  const { watch, calls } = setup({ onLimitSignal: async () => null });
  await watch.observeEvent(retry("s1"));
  assert.deepEqual(calls, []);
});

test("a sub-agent child is only aborted — no Keep going, no model lookup", async () => {
  const { watch, calls } = setup({ assignments: { kid: { provider: "claude", conversation: "root" } } });
  await watch.observeEvent(retry("kid"));
  assert.deepEqual(calls.map((c) => c[0]), ["signal", "abort"]);
  assert.deepEqual(calls[1], ["abort", "kid"]);
});

test("unknown last user model → Keep going without a model", async () => {
  const { watch, calls } = setup({ lastUserModel: async () => null });
  await watch.observeEvent(retry("s1"));
  const d = calls.find((c) => c[0] === "deliver");
  assert.deepEqual(d[1], { sessionId: "s1", text: KEEP_GOING_PROMPT });
});

test("a failing model lookup still sends Keep going (without a model)", async () => {
  const { watch, calls } = setup({ lastUserModel: async () => { throw new Error("no transcript"); } });
  await watch.observeEvent(retry("s1"));
  assert.deepEqual(calls.find((c) => c[0] === "deliver")[1], { sessionId: "s1", text: KEEP_GOING_PROMPT });
});

test("onMoved for a retrying conversation → recover (abort + Keep going), with the move's from/to logged", async () => {
  const { watch, calls, logs } = setup({ onLimitSignal: async () => ({ moved: false }) });
  await watch.observeEvent(retry("s1"));
  await watch.onMoved(moved("s1", { from: "seat-A", to: "seat-B" }));
  assert.deepEqual(calls.map((c) => c[0]), ["abort", "lastUserModel", "deliver"]);
  assert.ok(logs.some((l) => l === "[seat-retry] recovered s1 seat-A -> seat-B"), logs.join("|"));
});

test("onMoved recovers every retrying session of the conversation, including its sub-agents, and no one else", async () => {
  const assignments = {
    root: { provider: "claude", conversation: "root" },
    kid: { provider: "claude", conversation: "root" },
    other: { provider: "claude", conversation: "other" },
    cx: { provider: "codex", conversation: "root" },
  };
  const { watch, calls } = setup({ assignments, onLimitSignal: async () => ({ moved: false }) });
  for (const s of ["root", "kid", "other"]) await watch.observeEvent(retry(s));
  await watch.observeEvent(retry("cx", "usage_limit_reached"));
  await watch.onMoved(moved("root"));
  const aborted = calls.filter((c) => c[0] === "abort").map((c) => c[1]).sort();
  assert.deepEqual(aborted, ["kid", "root"]);
  const delivered = calls.filter((c) => c[0] === "deliver").map((c) => c[1].sessionId);
  assert.deepEqual(delivered, ["root"], "the child is only aborted");
});

test("onMoved for a conversation that is not retrying does nothing", async () => {
  const { watch, calls } = setup();
  await watch.onMoved(moved("s1"));
  assert.deepEqual(calls, []);
});

test("busy / idle / session.idle / session.error clear the retrying flag", async () => {
  for (const clear of [status("s1", "busy"), status("s1", "idle"), { type: "session.idle", properties: { sessionID: "s1" } }, { type: "session.error", properties: { sessionID: "s1", error: { name: "MessageAbortedError" } } }]) {
    const { watch, calls } = setup({ onLimitSignal: async () => ({ moved: false }) });
    await watch.observeEvent(retry("s1"));
    await watch.observeEvent(clear);
    await watch.onMoved(moved("s1"));
    assert.deepEqual(calls, [], clear.type + ":" + (clear.properties.status?.type ?? ""));
  }
});

test("the limit signal is debounced to once per session per 60 s", async () => {
  const { watch, calls, advance } = setup({ onLimitSignal: async (sig) => (calls.push(["signal", sig.sessionId]), { moved: false }) });
  await watch.observeEvent(retry("s1"));
  advance(SIGNAL_DEBOUNCE_MS - 1);
  await watch.observeEvent(retry("s1"));
  assert.equal(calls.filter((c) => c[0] === "signal").length, 1);
  advance(2);
  await watch.observeEvent(retry("s1"));
  assert.equal(calls.filter((c) => c[0] === "signal").length, 2);
});

test("recovery happens at most once per session per 2 minutes", async () => {
  const { watch, calls, advance } = setup({ onLimitSignal: async () => ({ moved: false }) });
  await watch.observeEvent(retry("s1"));
  await watch.onMoved(moved("s1"));
  assert.equal(calls.filter((c) => c[0] === "abort").length, 1);
  advance(60_000);
  await watch.observeEvent(retry("s1")); // retrying again
  await watch.onMoved(moved("s1"));
  assert.equal(calls.filter((c) => c[0] === "abort").length, 1, "inside the window");
  advance(RECOVER_DEBOUNCE_MS);
  await watch.observeEvent(retry("s1"));
  await watch.onMoved(moved("s1"));
  assert.equal(calls.filter((c) => c[0] === "abort").length, 2, "after the window");
});

test("the same move reported by the handler AND onMoved recovers once", async () => {
  // The assigner announces a move synchronously from inside reconsider — i.e.
  // while the limit handler is still on its way back to the watch.
  let watchRef;
  const calls = [];
  const s = setup({
    onLimitSignal: async () => {
      void watchRef.onMoved(moved("s1"));
      return { moved: true, from: "seat-1", to: "seat-2" };
    },
    abortSession: async (sid) => void calls.push(["abort", sid]),
    deliver: async (a) => void calls.push(["deliver", a.sessionId]),
  });
  watchRef = s.watch;
  await s.watch.observeEvent(retry("s1"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["abort", "s1"], ["deliver", "s1"]]);
});

test("a failed abort sends nothing, and the session can be recovered by the next trigger", async () => {
  let fail = true;
  const { watch, calls, logs } = setup({
    onLimitSignal: async () => ({ moved: false }),
    abortSession: async (sid) => {
      if (fail) throw new Error("opencode abortSession 500");
      calls.push(["abort", sid]);
    },
  });
  await watch.observeEvent(retry("s1"));
  await watch.onMoved(moved("s1"));
  assert.deepEqual(calls, []);
  assert.ok(logs.some((l) => l.includes("abort of s1 failed")));
  fail = false;
  await watch.onMoved(moved("s1"));
  assert.deepEqual(calls.map((c) => c[0]), ["abort", "lastUserModel", "deliver"]);
});

test("a throwing dependency never rejects observeEvent / onMoved", async () => {
  const boom = async () => {
    throw new Error("boom");
  };
  const a = setup({ onLimitSignal: boom });
  await assert.doesNotReject(a.watch.observeEvent(retry("s1")));

  const b = setup({ onLimitSignal: async () => ({ moved: true }), abortSession: boom });
  await assert.doesNotReject(b.watch.observeEvent(retry("s1")));

  const c = setup({ onLimitSignal: async () => ({ moved: true }), deliver: boom });
  await assert.doesNotReject(c.watch.observeEvent(retry("s1")));

  const d = setup({ onLimitSignal: async () => ({ moved: false }), abortSession: boom });
  await d.watch.observeEvent(retry("s1"));
  await assert.doesNotReject(d.watch.onMoved(moved("s1")));

  const e = createSeatRetryWatch({ sessionAssignment: () => { throw new Error("store"); }, onLimitSignal: boom, abortSession: boom, deliver: boom });
  await assert.doesNotReject(e.observeEvent(retry("s1")));
  await assert.doesNotReject(e.observeEvent(null));
  await assert.doesNotReject(e.observeEvent({ type: "session.status" }));
  await assert.doesNotReject(e.onMoved(null));
});

test("a deliver that reports rejected is logged, not thrown", async () => {
  const { watch, logs } = setup({ deliver: async () => ({ rejected: true }) });
  await watch.observeEvent(retry("s1"));
  assert.ok(logs.some((l) => l.includes("was rejected")));
});

// ---- lastUserModelFromMessages ---------------------------------------------------

test("lastUserModelFromMessages: reads info.model of the LAST user message, or providerID/modelID on info", () => {
  const msgs = [
    { info: { role: "user", model: { providerID: "openai", modelID: "gpt-old" } } },
    { info: { role: "assistant", providerID: "anthropic", modelID: "assistant-model" } },
    { info: { role: "user", model: { providerID: "anthropic", modelID: "claude-opus-4" } } },
    { info: { role: "assistant", providerID: "anthropic", modelID: "assistant-model" } },
  ];
  assert.deepEqual(lastUserModelFromMessages(msgs), { providerID: "anthropic", modelID: "claude-opus-4" });
  assert.deepEqual(lastUserModelFromMessages([{ info: { role: "user", providerID: "a", modelID: "b" } }]), { providerID: "a", modelID: "b" });
});

test("lastUserModelFromMessages: null for no user message, no model, or junk", () => {
  assert.equal(lastUserModelFromMessages([{ info: { role: "assistant", providerID: "a", modelID: "b" } }]), null);
  assert.equal(lastUserModelFromMessages([{ info: { role: "user" } }]), null);
  assert.equal(lastUserModelFromMessages([{ info: { role: "user", model: { providerID: "a" } } }]), null);
  assert.equal(lastUserModelFromMessages(null), null);
  assert.equal(lastUserModelFromMessages([null, {}]), null);
});

test("short next (≤ 30 s away) → moved but NOT aborted; the entry is kept", async () => {
  const { watch, calls } = setup();
  await watch.observeEvent(retryNext("s1", T0 + RECOVER_MIN_WAIT_MS)); // exactly the threshold: still short
  assert.deepEqual(calls.map((c) => c[0]), ["signal"]);
  // still tracked: a later onMoved with the same short next is also skipped, not lost
  await watch.onMoved(moved("s1"));
  assert.deepEqual(calls.map((c) => c[0]), ["signal"]);
});

test("short next, then a later retry with a long next → recovers from the remembered move", async () => {
  const { watch, calls, logs, advance } = setup();
  await watch.observeEvent(retryNext("s1", T0 + 5_000));
  assert.deepEqual(calls.map((c) => c[0]), ["signal"]);
  advance(5_000);
  // same limit message again, within the 60 s signal debounce — must still recover
  await watch.observeEvent(retryNext("s1", T0 + 5_000 + 3_600_000));
  assert.deepEqual(calls.map((c) => c[0]), ["signal", "abort", "lastUserModel", "deliver"]);
  assert.ok(logs.some((l) => l === "[seat-retry] recovered s1 seat-1 -> seat-2"), logs.join("|"));
});

test("short next, then a later retry that is still short → still not aborted", async () => {
  const { watch, calls, advance } = setup();
  await watch.observeEvent(retryNext("s1", T0 + 5_000));
  advance(5_000);
  await watch.observeEvent(retryNext("s1", T0 + 5_000 + 20_000));
  assert.deepEqual(calls.map((c) => c[0]), ["signal"]);
});

test("short next, then onMoved with a long next recorded by a later non-limit retry → recovers", async () => {
  const { watch, calls } = setup();
  await watch.observeEvent(retryNext("s1", T0 + 5_000));
  await watch.observeEvent(retryNext("s1", T0 + 3_600_000, "Overloaded")); // pendingMove survives; next is long
  assert.deepEqual(calls.map((c) => c[0]), ["signal", "abort", "lastUserModel", "deliver"]);
});

test("onMoved with a short next is skipped, a later long-next retry then recovers it", async () => {
  const { watch, calls } = setup({ onLimitSignal: async () => ({ moved: false }) });
  await watch.observeEvent(retryNext("s1", T0 + 1_000, "Overloaded"));
  await watch.onMoved(moved("s1"));
  assert.deepEqual(calls, []);
  await watch.observeEvent(retryNext("s1", T0 + 3_600_000, "Overloaded"));
  assert.deepEqual(calls.map((c) => c[0]), ["abort", "lastUserModel", "deliver"]);
});

test("unknown next → recovers as before", async () => {
  const { watch, calls } = setup();
  await watch.observeEvent(retryNext("s1", null));
  assert.deepEqual(calls.map((c) => c[0]), ["signal", "abort", "lastUserModel", "deliver"]);
});

test("long next → recovers; a non-numeric next is treated as unknown", async () => {
  const a = setup();
  await a.watch.observeEvent(retryNext("s1", T0 + RECOVER_MIN_WAIT_MS + 1));
  assert.deepEqual(a.calls.map((c) => c[0]), ["signal", "abort", "lastUserModel", "deliver"]);
  const b = setup();
  await b.watch.observeEvent(retryNext("s1", "soon"));
  assert.deepEqual(b.calls.map((c) => c[0]), ["signal", "abort", "lastUserModel", "deliver"]);
});

test("a pending move is forgotten when the session goes busy again", async () => {
  const { watch, calls } = setup();
  await watch.observeEvent(retryNext("s1", T0 + 5_000));
  await watch.observeEvent(status("s1", "busy"));
  await watch.observeEvent(retryNext("s1", T0 + 3_600_000, "Overloaded"));
  assert.deepEqual(calls.map((c) => c[0]), ["signal"]);
});
