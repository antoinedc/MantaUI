// transcript.test.ts — pure transcript-model tests: raw opencode messages →
// row VMs (user / assistant / tool), delta-merge accumulation into the right
// message, and the running flag driven by session.idle / session.status.

import { describe, expect, it } from "vitest";

import {
  applyOpencodeEvent,
  mapMessageRow,
  mapTranscript,
  mergeDelta,
  type MessageRowVM,
  type RawMessage,
  type TranscriptVM,
} from "../transcript";

const userMsg: RawMessage = {
  info: { id: "msg-user-1", role: "user", time: { created: 100 } },
  parts: [{ type: "text", id: "p1", text: "hello box" }],
};

const assistantMsg: RawMessage = {
  info: { id: "msg-asst-1", role: "assistant", time: { created: 200 }, modelID: "claude-x" },
  parts: [
    { type: "reasoning", id: "r1", text: "thinking..." },
    { type: "text", id: "t1", text: "here is the answer" },
    { type: "tool", id: "tool1", tool: "read", state: { status: "completed", title: "src/a.ts" } },
  ],
};

describe("mapMessageRow", () => {
  it("maps a user text message", () => {
    const row = mapMessageRow(userMsg, 0);
    expect(row).toEqual<MessageRowVM>({
      key: "msg-user-1",
      role: "user",
      text: "hello box",
      tools: [],
      model: undefined,
      createdAt: 100,
    });
  });

  it("maps an assistant message with reasoning+text+tool", () => {
    const row = mapMessageRow(assistantMsg, 1);
    expect(row.role).toBe("assistant");
    expect(row.model).toBe("claude-x");
    expect(row.createdAt).toBe(200);
    // reasoning + text concatenated with a blank line
    expect(row.text).toBe("thinking...\n\nhere is the answer");
    expect(row.tools).toEqual([
      { key: "tool1", name: "read", status: "completed", title: "src/a.ts" },
    ]);
  });

  it("skips synthetic/ignored text parts", () => {
    const row = mapMessageRow(
      {
        info: { id: "m", role: "assistant" },
        parts: [
          { type: "text", text: "visible" },
          { type: "text", text: "hidden", synthetic: true },
          { type: "text", text: "also hidden", ignored: true },
        ],
      },
      0,
    );
    expect(row.text).toBe("visible");
  });

  it("defaults tool name/status and synthesizes a key when absent", () => {
    const row = mapMessageRow(
      { info: { id: "m", role: "assistant" }, parts: [{ type: "tool" }] },
      3,
    );
    expect(row.tools).toEqual([
      { key: "m:tool:0", name: "tool", status: "pending", title: undefined },
    ]);
  });

  it("synthesizes a key when message id is missing", () => {
    const row = mapMessageRow({ info: {}, parts: [] }, 7);
    expect(row.key).toBe("msg-7");
    expect(row.role).toBe("assistant"); // non-user defaults to assistant
  });

  it("tolerates malformed parts without throwing", () => {
    const row = mapMessageRow(
      {
        info: { id: "m", role: "user" },
        // @ts-expect-error deliberately malformed entries
        parts: [null, 42, { type: "text", text: "ok" }],
      },
      0,
    );
    expect(row.text).toBe("ok");
  });
});

describe("mapTranscript", () => {
  it("maps a list of messages to rows, running=false", () => {
    const vm = mapTranscript([userMsg, assistantMsg]);
    expect(vm.running).toBe(false);
    expect(vm.rows.map((r) => r.key)).toEqual(["msg-user-1", "msg-asst-1"]);
  });

  it("returns an empty transcript for non-array / malformed input", () => {
    expect(mapTranscript(null)).toEqual({ rows: [], running: false });
    expect(mapTranscript("nope")).toEqual({ rows: [], running: false });
    expect(mapTranscript({})).toEqual({ rows: [], running: false });
  });

  it("skips non-object entries in the array", () => {
    const vm = mapTranscript([userMsg, null, 5, assistantMsg]);
    expect(vm.rows.map((r) => r.key)).toEqual(["msg-user-1", "msg-asst-1"]);
  });
});

describe("mergeDelta", () => {
  const rows: MessageRowVM[] = [
    { key: "a", role: "assistant", text: "foo", tools: [], createdAt: 1 },
    { key: "b", role: "assistant", text: "bar", tools: [], createdAt: 2 },
  ];

  it("appends the delta to the matching message and returns a new array", () => {
    const next = mergeDelta(rows, { messageID: "b", delta: "baz", field: "text" });
    expect(next).not.toBe(rows);
    expect(next[1].text).toBe("barbaz");
    // other rows untouched (same reference)
    expect(next[0]).toBe(rows[0]);
  });

  it("accumulates successive deltas into the same message", () => {
    let next = mergeDelta(rows, { messageID: "a", delta: "X", field: "text" });
    next = mergeDelta(next, { messageID: "a", delta: "Y", field: "text" });
    expect(next[0].text).toBe("fooXY");
  });

  it("drops a delta for an unknown message (same reference back)", () => {
    const next = mergeDelta(rows, { messageID: "zzz", delta: "x", field: "text" });
    expect(next).toBe(rows);
  });

  it("ignores non-text-field deltas", () => {
    const next = mergeDelta(rows, { messageID: "a", delta: "x", field: "other" });
    expect(next).toBe(rows);
  });

  it("ignores empty delta or missing messageID", () => {
    expect(mergeDelta(rows, { messageID: "a", delta: "" })).toBe(rows);
    expect(mergeDelta(rows, { delta: "x" })).toBe(rows);
  });
});

describe("applyOpencodeEvent", () => {
  const base: TranscriptVM = {
    rows: [{ key: "a", role: "assistant", text: "foo", tools: [], createdAt: 1 }],
    running: false,
  };

  it("message.part.delta appends text AND sets running=true", () => {
    const next = applyOpencodeEvent(base, {
      type: "message.part.delta",
      properties: { messageID: "a", delta: "bar", field: "text" },
    });
    expect(next.rows[0].text).toBe("foobar");
    expect(next.running).toBe(true);
  });

  it("session.idle flips running to false", () => {
    const running: TranscriptVM = { ...base, running: true };
    const next = applyOpencodeEvent(running, { type: "session.idle" });
    expect(next.running).toBe(false);
    // idempotent when already idle
    expect(applyOpencodeEvent(base, { type: "session.idle" })).toBe(base);
  });

  it("session.status busy → running, idle → not running", () => {
    const busy = applyOpencodeEvent(base, {
      type: "session.status",
      properties: { status: { type: "busy" } },
    });
    expect(busy.running).toBe(true);
    const idle = applyOpencodeEvent(busy, {
      type: "session.status",
      properties: { status: { type: "idle" } },
    });
    expect(idle.running).toBe(false);
  });

  it("session.status retry counts as running", () => {
    const next = applyOpencodeEvent(base, {
      type: "session.status",
      properties: { status: { type: "retry" } },
    });
    expect(next.running).toBe(true);
  });

  it("returns the same VM reference for unhandled events", () => {
    const next = applyOpencodeEvent(base, { type: "todo.updated" });
    expect(next).toBe(base);
  });
});
