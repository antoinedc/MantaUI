import { describe, it, expect } from "vitest";
import {
  WsReconnectController,
  WS_OPEN,
  WS_CONNECTING,
  WS_CLOSED,
  type WsLike,
} from "./wsTransport.js";
import { ExponentialBackoff } from "../../shared/net/backoff.js";

// A scriptable fake WebSocket. The controller wires onopen/onclose/onerror/
// onmessage; the test drives them via the helper methods to simulate the
// socket lifecycle deterministically.
class FakeWs implements WsLike {
  readyState = WS_CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close() {
    this.closed = true;
    this.readyState = WS_CLOSED;
  }
  // --- test drivers ---
  fireOpen() {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }
  fireClose() {
    this.readyState = WS_CLOSED;
    this.onclose?.();
  }
  fireError() {
    this.onerror?.();
  }
  fireMessage(data: unknown) {
    this.onmessage?.({ data });
  }
}

// Deterministic timer: queue of {id, fn}. run() fires the earliest pending.
function makeFakeTimer() {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, _ms: number) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeoutFn: (h: unknown) => {
      timers.delete(h as number);
    },
    /** Fire the oldest pending timer (FIFO by insertion / id). */
    run() {
      const id = [...timers.keys()][0];
      if (id === undefined) return false;
      const fn = timers.get(id)!;
      timers.delete(id);
      fn();
      return true;
    },
    count() {
      return timers.size;
    },
  };
}

// Zero-jitter backoff so delays are predictable in assertions.
function noJitterBackoff() {
  return new ExponentialBackoff({ base: 1000, max: 15000, jitter: false });
}

function setup(overrides: Partial<Parameters<typeof buildController>[0]> = {}) {
  return buildController(overrides);
}

function buildController(overrides: {
  urlThrows?: boolean;
  onReconnect?: () => void;
} = {}) {
  const t = makeFakeTimer();
  const created: FakeWs[] = [];
  const states: string[] = [];
  const messages: unknown[] = [];
  const c = new WsReconnectController({
    url: () => {
      if (overrides.urlThrows) throw new Error("no server");
      return "wss://box/events";
    },
    create: (url) => {
      const ws = new FakeWs(url);
      created.push(ws);
      return ws;
    },
    onMessage: (d) => messages.push(d),
    onReconnect: overrides.onReconnect,
    onState: (s) => states.push(s.state),
    backoff: noJitterBackoff(),
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });
  return { c, t, created, states, messages };
}

describe("WsReconnectController — connect lifecycle", () => {
  it("opens a socket and reaches connected on open", () => {
    const { c, created, states } = setup();
    c.ensure();
    expect(created).toHaveLength(1);
    expect(c.getState().state).toBe("connecting");
    created[0].fireOpen();
    expect(c.getState().state).toBe("connected");
    expect(states).toContain("connecting");
    expect(states).toContain("connected");
  });

  it("is idempotent: ensure() while OPEN/CONNECTING does not open a second socket", () => {
    const { c, created } = setup();
    c.ensure();
    c.ensure(); // still CONNECTING → no new socket
    expect(created).toHaveLength(1);
    created[0].fireOpen();
    c.ensure(); // now OPEN → still no new socket
    expect(created).toHaveLength(1);
  });

  it("dispatches message frames to onMessage", () => {
    const { c, created, messages } = setup();
    c.ensure();
    created[0].fireOpen();
    created[0].fireMessage('{"kind":"opencode"}');
    expect(messages).toEqual(['{"kind":"opencode"}']);
  });
});

describe("WsReconnectController — reconnect with shared backoff", () => {
  it("reconnects after a drop and NEVER permanently abandons", () => {
    const { c, t, created } = setup();
    c.ensure();
    created[0].fireOpen();

    // Drop the socket → controller should schedule a reconnect.
    created[0].fireClose();
    expect(c.getState().state).toBe("reconnecting");
    expect(t.count()).toBe(1); // exactly one reconnect timer armed

    // Fire the backoff timer → a fresh socket is opened. The shared state
    // machine has no reconnecting→connecting edge, so we stay in "reconnecting"
    // until the retry's open() succeeds (→ connected).
    t.run();
    expect(created).toHaveLength(2);
    expect(c.getState().state).toBe("reconnecting");

    // Drop again → reconnect again. Prove it doesn't give up.
    created[1].fireOpen();
    created[1].fireClose();
    t.run();
    expect(created).toHaveLength(3);
  });

  it("grows the backoff delay per consecutive failure and resets on a healthy open", () => {
    // Capture the delays the controller asks for.
    const delays: number[] = [];
    const t = {
      timers: new Map<number, () => void>(),
      nextId: 1,
      setTimeoutFn(fn: () => void, ms: number) {
        delays.push(ms);
        const id = this.nextId++;
        this.timers.set(id, fn);
        return id;
      },
      clearTimeoutFn(h: unknown) {
        this.timers.delete(h as number);
      },
      run() {
        const id = [...this.timers.keys()][0];
        if (id === undefined) return;
        const fn = this.timers.get(id)!;
        this.timers.delete(id);
        fn();
      },
    };
    const created: FakeWs[] = [];
    const c = new WsReconnectController({
      url: () => "wss://box/events",
      create: (u) => {
        const ws = new FakeWs(u);
        created.push(ws);
        return ws;
      },
      onMessage: () => {},
      backoff: noJitterBackoff(), // base 1000, factor 2, no jitter
      setTimeoutFn: (fn, ms) => t.setTimeoutFn(fn, ms),
      clearTimeoutFn: (h) => t.clearTimeoutFn(h),
    });

    c.ensure();
    created[0].fireOpen();
    created[0].fireClose(); // 1st backoff → 1000
    t.run();
    created[1].fireClose(); // never opened → 2nd backoff → 2000
    t.run();
    created[2].fireClose(); // 3rd backoff → 4000
    expect(delays).toEqual([1000, 2000, 4000]);

    // A healthy open resets the backoff: next drop is 1000 again.
    t.run();
    created[3].fireOpen();
    created[3].fireClose();
    expect(delays[delays.length - 1]).toBe(1000);
  });

  it("caps the backoff at max (15000)", () => {
    const delays: number[] = [];
    const created: FakeWs[] = [];
    const timers: Array<() => void> = [];
    const c = new WsReconnectController({
      url: () => "wss://box/events",
      create: (u) => {
        const ws = new FakeWs(u);
        created.push(ws);
        return ws;
      },
      onMessage: () => {},
      backoff: noJitterBackoff(),
      setTimeoutFn: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeoutFn: () => {},
    });
    c.ensure();
    created[0].fireOpen();
    // Drop 6 times without a successful open: 1000,2000,4000,8000,15000,15000
    created[0].fireClose();
    for (let i = 1; i <= 5; i++) {
      timers[timers.length - 1]();
      created[i].fireClose();
    }
    expect(delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});

describe("WsReconnectController — resync on reconnect", () => {
  it("fires onReconnect on a re-open after a drop, but NOT on the initial open", () => {
    let reconnects = 0;
    const { c, t, created } = setup({ onReconnect: () => reconnects++ });
    c.ensure();
    created[0].fireOpen();
    expect(reconnects).toBe(0); // initial connect → no resync

    created[0].fireClose();
    t.run();
    created[1].fireOpen();
    expect(reconnects).toBe(1); // reconnect → resync fired once
  });

  it("markReconnectAndEnsure() forces the next open to resync (resume watchdog)", () => {
    let reconnects = 0;
    const { c, created } = setup({ onReconnect: () => reconnects++ });
    c.ensure();
    created[0].fireOpen();
    // Simulate the socket silently dead but readyState still OPEN (iOS resume):
    // markReconnectAndEnsure sets hadDrop, and since it's OPEN, ensure() no-ops
    // the socket but the flag persists. Force a real reopen by closing first.
    created[0].readyState = WS_CLOSED;
    c.markReconnectAndEnsure();
    expect(created).toHaveLength(2);
    created[1].fireOpen();
    expect(reconnects).toBe(1);
  });
});

describe("WsReconnectController — teardown + config errors", () => {
  it("close() cancels timers, closes the socket, and lands in closed", () => {
    const { c, t, created } = setup();
    c.ensure();
    created[0].fireOpen();
    created[0].fireClose();
    expect(t.count()).toBe(1); // a reconnect is armed
    c.close();
    expect(c.getState().state).toBe("closed");
    // A late timer fire after close() must not open a new socket (stale epoch).
    t.run();
    expect(created).toHaveLength(1);
  });

  it("a stale socket callback after close() is ignored", () => {
    const { c, created, messages } = setup();
    c.ensure();
    const ws = created[0];
    ws.fireOpen();
    c.close();
    // Detached handler: firing a message on the old socket must be a no-op.
    ws.fireMessage("late");
    expect(messages).not.toContain("late");
  });

  it("url() throwing reports closed and does NOT spin a retry loop", () => {
    const { c, t } = setup({ urlThrows: true });
    c.ensure();
    expect(c.getState().state).toBe("closed");
    expect(t.count()).toBe(0); // no reconnect scheduled — nothing to retry
  });
});
