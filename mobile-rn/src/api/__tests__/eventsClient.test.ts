// eventsClient.test.ts — the socket glue's observable behavior with an injected
// fake WebSocket + timer: URL building, viewed-session filtering of delivered
// events, reconnect on unexpected close, and no-reconnect after close().

import { describe, expect, it, vi } from "vitest";

import {
  eventsWsUrl,
  subscribeOpencodeEvents,
  type WebSocketLike,
} from "../eventsClient";
import type { OpencodeEventLike } from "../../pure/transcript";

describe("eventsWsUrl", () => {
  it("http→ws, appends token as ?token=", () => {
    expect(eventsWsUrl("http://box:8787", "tok")).toBe(
      "ws://box:8787/events?token=tok",
    );
  });
  it("https→wss and trims trailing slash", () => {
    expect(eventsWsUrl("https://box/", "a b")).toBe(
      "wss://box/events?token=a%20b",
    );
  });
});

/** A controllable fake socket that captures its handlers. */
class FakeSocket implements WebSocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data?: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  closed = false;
  static instances: FakeSocket[] = [];
  constructor() {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ kind: "opencode", payload }) });
  }
}

function frame(type: string, sessionID?: string) {
  return { type, properties: sessionID ? { sessionID } : {} };
}

describe("subscribeOpencodeEvents", () => {
  it("delivers only events for the viewed session", () => {
    FakeSocket.instances = [];
    const received: OpencodeEventLike[] = [];
    const sub = subscribeOpencodeEvents(
      "http://box",
      "tok",
      "s1",
      (ev) => received.push(ev),
      { createSocket: () => new FakeSocket() },
    );
    const ws = FakeSocket.instances[0];
    ws.onopen?.();
    ws.emit(frame("session.idle", "s1")); // ours → delivered
    ws.emit(frame("message.part.delta", "s2")); // other → dropped
    ws.emit(frame("permission.replied")); // no sessionID → delivered
    ws.onmessage?.({ data: "not json" }); // junk → ignored
    ws.onmessage?.({ data: JSON.stringify({ kind: "pty", payload: {} }) }); // non-opencode → ignored

    expect(received.map((e) => e.type)).toEqual([
      "session.idle",
      "permission.replied",
    ]);
    sub.close();
  });

  it("reconnects after an unexpected close, using the injected timer", () => {
    FakeSocket.instances = [];
    const scheduledRef: { fn: (() => void) | null } = { fn: null };
    const setTimeoutFn = vi.fn((fn: () => void) => {
      scheduledRef.fn = fn;
      return 1;
    });
    const sub = subscribeOpencodeEvents("http://box", "t", "s1", () => {}, {
      createSocket: () => new FakeSocket(),
      setTimeoutFn,
      backoff: { baseMs: 10, maxMs: 100, factor: 2 },
    });
    expect(FakeSocket.instances).toHaveLength(1);

    // Simulate an unexpected drop.
    FakeSocket.instances[0].onclose?.();
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 10);

    // Fire the scheduled retry → a second socket is created.
    scheduledRef.fn?.();
    expect(FakeSocket.instances).toHaveLength(2);
    sub.close();
  });

  it("does not reconnect after the caller closes the subscription", () => {
    FakeSocket.instances = [];
    const setTimeoutFn = vi.fn((_fn: () => void) => 1);
    const sub = subscribeOpencodeEvents("http://box", "t", "s1", () => {}, {
      createSocket: () => new FakeSocket(),
      setTimeoutFn,
    });
    const ws = FakeSocket.instances[0];
    sub.close();
    expect(ws.closed).toBe(true);
    // A late onclose after teardown must NOT schedule a reconnect.
    ws.onclose?.();
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
