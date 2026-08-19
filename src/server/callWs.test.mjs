import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachCallWs } from "./callWs.mjs";

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
