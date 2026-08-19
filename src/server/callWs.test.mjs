import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachCallWs, createCallRegistry } from "./callWs.mjs";

function makeClientWs() {
  const ws = new EventEmitter();
  ws.clientSent = [];
  ws.send = (msg) => ws.clientSent.push(msg);
  ws.close = () => {
    ws.closed = true;
    ws.emit("close");
  };
  return ws;
}

function makeFakeRealtime() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.closed = false;
  ws.send = (msg) => ws.sent.push(typeof msg === "string" ? msg : JSON.stringify(msg));
  ws.close = () => {
    ws.closed = true;
  };
  return ws;
}

// A tiny async helper so the WS message callback (JSON text) can be driven.
function deliver(ws, obj) {
  ws.emit("message", Buffer.from(JSON.stringify(obj)));
}

test("connect boots the engine, calls setCallActive(true), and streams session to live", async () => {
  const client = makeClientWs();
  const rt = makeFakeRealtime();
  const activeState = [];
  const dispatchCalls = [];
  attachCallWs(client, new URL("/call", "http://x"), {
    realtimeConnect: async () => rt,
    configGet: async () => ({ openaiApiKey: "sk-test", cto: {} }),
    dispatchCto: async (name, args, ctx) => {
      dispatchCalls.push(name);
      return { ok: true };
    },
    listTools: () => [{ name: "t1", description: "d", params: {} }],
    setCallActive: (a, e) => activeState.push(a ? "active" : "inactive"),
  });
  // The engine's start() is async; let it open the fake realtime socket.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(activeState.includes("active"), true, "call active flagged on connect");
  assert.ok(
    rt.sent.some((s) => {
      try {
        return JSON.parse(s).type === "session.update";
      } catch {
        return false;
      }
    }),
    "session.update sent to realtime",
  );

  // session.created → renderer receives `state: live`.
  rt.emit("message", Buffer.from(JSON.stringify({ type: "session.created", session: { id: "s1" } })));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    client.clientSent.some((m) => {
      try {
        return JSON.parse(m).type === "state" && JSON.parse(m).state === "live";
      } catch {
        return false;
      }
    }),
    "renderer told the call is live",
  );
});

test("client audio/commit/barge bridge into the Realtime session", async () => {
  const client = makeClientWs();
  const rt = makeFakeRealtime();
  attachCallWs(client, new URL("/call", "http://x"), {
    realtimeConnect: async () => rt,
    configGet: async () => ({ openaiApiKey: "sk-test", cto: {} }),
    listTools: () => [],
  });
  await new Promise((r) => setTimeout(r, 10));

  deliver(client, { type: "audio", delta: "B64" });
  deliver(client, { type: "commit" });
  deliver(client, { type: "barge" });
  await new Promise((r) => setTimeout(r, 10));

  const sent = rt.sent.map((s) => JSON.parse(s));
  assert.ok(sent.some((m) => m.type === "input_audio_buffer.append" && m.audio === "B64"));
  assert.ok(sent.some((m) => m.type === "input_audio_buffer.commit"));
  assert.ok(sent.some((m) => m.type === "response.cancel"), "barge reaches realtime");
});

test("park / hangup clear the call-active flag and hangup the engine", async () => {
  const client = makeClientWs();
  const rt = makeFakeRealtime();
  const activeState = [];
  attachCallWs(client, new URL("/call", "http://x"), {
    realtimeConnect: async () => rt,
    configGet: async () => ({ openaiApiKey: "sk-test", cto: {} }),
    listTools: () => [],
    setCallActive: (a) => activeState.push(a),
  });
  await new Promise((r) => setTimeout(r, 10));
  deliver(client, { type: "control", action: "hangup" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.closed, true, "realtime session torn down on hangup");
  assert.equal(activeState[activeState.length - 1], false, "call-active cleared");
});

test("control: park clears the call-active flag and parks the engine (no silent session)", async () => {
  const client = makeClientWs();
  const rt = makeFakeRealtime();
  const activeState = [];
  attachCallWs(client, new URL("/call", "http://x"), {
    realtimeConnect: async () => rt,
    configGet: async () => ({ openaiApiKey: "sk-test", cto: {} }),
    listTools: () => [],
    setCallActive: (a) => activeState.push(a),
  });
  await new Promise((r) => setTimeout(r, 10));
  deliver(client, { type: "control", action: "park" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.closed, true, "realtime session torn down on park");
  assert.equal(activeState[activeState.length - 1], false, "call-active cleared on park");
  assert.ok(
    client.clientSent.some((m) => {
      try {
        return JSON.parse(m).type === "state" && JSON.parse(m).state === "parked";
      } catch {
        return false;
      }
    }),
    "engine reports parked to the renderer",
  );
});

test("socket close tears down and clears the call-active flag (no silent session)", async () => {
  const client = makeClientWs();
  const rt = makeFakeRealtime();
  const activeState = [];
  attachCallWs(client, new URL("/call", "http://x"), {
    realtimeConnect: async () => rt,
    configGet: async () => ({ openaiApiKey: "sk-test", cto: {} }),
    listTools: () => [],
    setCallActive: (a) => activeState.push(a),
  });
  await new Promise((r) => setTimeout(r, 10));
  client.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.closed, true);
  assert.equal(activeState[activeState.length - 1], false);
});

test("a rejected engine.start pushes an error frame and is not an unhandled rejection", async () => {
  const client = makeClientWs();
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    attachCallWs(client, new URL("/call", "http://x"), {
      // Deliberately NOT a ws (no .on): openTransport's configureTransport
      // throws after the connect call, so engine.start rejects. The boot
      // IIFE's .catch must contain it.
      realtimeConnect: async () => ({ send() {} }),
      configGet: async () => ({ openaiApiKey: "sk-test", cto: {} }),
      listTools: () => [],
    });
    await new Promise((r) => setTimeout(r, 10));
    const frames = client.clientSent.map((m) => JSON.parse(m));
    assert.ok(frames.some((m) => m.type === "error"), "error frame pushed to renderer");
    assert.equal(unhandled.length, 0, "no unhandled rejection surfaced");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("createCallRegistry begins/ends identity-guarded: a displaced call can't clear a newer call", () => {
  const r = createCallRegistry();
  const e1 = { engine: 1 };
  const e2 = { engine: 2 };
  const s1 = { id: "s1" };
  const s2 = { id: "s2" };

  assert.equal(r.isActive(), false);
  const displaced1 = r.begin(e1, s1);
  assert.equal(displaced1, null, "first begin displaces nothing");
  assert.equal(r.isActive(), true);

  // Second call displaces the first.
  const displaced2 = r.begin(e2, s2);
  assert.equal(displaced2.engine, e1, "second begin displaces the first call");
  assert.equal(displaced2.ws, s1);

  // The DISPLACED call (engine 1) trying to end must NOT clear the active flag.
  assert.equal(r.end(e1), false, "displaced engine end is a no-op");
  assert.equal(r.isActive(), true, "active call survives the displaced call's teardown");

  // The actual active call (engine 2) clears it.
  assert.equal(r.end(e2), true, "active engine end clears the call");
  assert.equal(r.isActive(), false);
});

test("a second /call attach while one is active tears down the first (takeover)", async () => {
  const registry = createCallRegistry();
  const activeState = [];
  const makeOpts = (configGet) => ({
    realtimeConnect: async () => ({}), // realtime ws shape is mocked below via engine deps
    configGet,
    listTools: () => [],
    setCallActive: (a) => activeState.push(a),
    registry,
    log: () => {},
  });

  // First call: real, open realtime session.
  const firstClient = makeClientWs();
  const firstRt = makeFakeRealtime();
  attachCallWs(firstClient, new URL("/call", "http://x"), {
    ...makeOpts(async () => ({ openaiApiKey: "sk-test", cto: {} })),
    realtimeConnect: async () => firstRt,
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(activeState[0], true, "first call active on connect");
  assert.equal(firstRt.closed, false, "first realtime open before takeover");
  assert.notEqual(firstClient.closed, true, "first socket open before takeover");

  // Second call attaches while the first is live → displaces it.
  const secondClient = makeClientWs();
  const secondRt = makeFakeRealtime();
  attachCallWs(secondClient, new URL("/call", "http://x"), {
    ...makeOpts(async () => ({ openaiApiKey: "sk-test", cto: {} })),
    realtimeConnect: async () => secondRt,
  });
  await new Promise((r) => setTimeout(r, 10));

  // The first engine was hung up and its socket closed.
  assert.equal(firstRt.closed, true, "first engine hung up on takeover");
  assert.equal(firstClient.closed, true, "first socket closed on takeover");

  // Let the second call's Realtime session come up.
  secondRt.emit("message", Buffer.from(JSON.stringify({ type: "session.created", session: { id: "s2" } })));
  await new Promise((r) => setTimeout(r, 10));

  // The second call is the live one.
  assert.ok(
    secondClient.clientSent.some((m) => {
      try {
        return JSON.parse(m).type === "state" && JSON.parse(m).state === "live";
      } catch {
        return false;
      }
    }),
    "second call becomes live",
  );
  assert.equal(secondRt.closed, false, "second realtime stays open");

  // The first call's teardown must NOT have cleared the active flag.
  assert.equal(activeState[activeState.length - 1], true, "takeover leaves the new call active");
  assert.equal(registry.isActive(), true, "registry still points at the new call");
});
