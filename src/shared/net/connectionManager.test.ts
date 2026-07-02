import { describe, it, expect, beforeEach } from "vitest";
import { ConnectionManager } from "./connectionManager";
import type { Transport, TimerHandle } from "./connectionManager";
import { ExponentialBackoff } from "./backoff";
import type { ConnectionState, ConnectionStateName } from "./state";

// --- Deterministic fake clock + timer scheduler ------------------------------
//
// A minimal virtual scheduler: timers are stored with their absolute fire time
// and only fire when `advance(ms)` crosses them. `now()` tracks virtual ms.
// No real wall-clock is ever consulted, so tests are fully deterministic.

interface Scheduled {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
}

class FakeClock {
  private current = 0;
  private nextId = 1;
  private timers: Scheduled[] = [];

  now = (): number => this.current;

  setTimeout = (fn: () => void, ms: number): TimerHandle => {
    const t: Scheduled = { id: this.nextId++, fireAt: this.current + ms, fn, cancelled: false };
    this.timers.push(t);
    return t.id;
  };

  clearTimeout = (handle: TimerHandle): void => {
    const t = this.timers.find((x) => x.id === handle);
    if (t) t.cancelled = true;
  };

  /**
   * Advance virtual time by `ms`, firing every timer whose deadline is crossed
   * in chronological order. Also drains microtasks between fires so awaited
   * promises inside callbacks settle deterministically.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    // Keep firing due timers (including ones scheduled by earlier fires) until
    // we reach the target time and no due timers remain.
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0];
      next.cancelled = true;
      this.current = next.fireAt;
      next.fn();
      // Let any promises the callback awaited resolve before the next timer.
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

/** Drain the microtask queue a few times so chained awaits settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// --- Configurable fake transport --------------------------------------------

class FakeTransport implements Transport {
  openCalls = 0;
  closeCalls = 0;
  pingCalls = 0;

  /** Number of leading `open()` calls that should reject (then succeed). */
  failOpens = 0;
  /** When true, `ping()` returns a promise that never resolves (simulates a dead peer). */
  pingHangs = false;

  private pingResolvers: Array<() => void> = [];

  async open(): Promise<void> {
    this.openCalls++;
    if (this.failOpens > 0) {
      this.failOpens--;
      throw new Error("open failed");
    }
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }

  ping(): Promise<void> {
    this.pingCalls++;
    if (this.pingHangs) {
      return new Promise<void>((resolve) => this.pingResolvers.push(resolve));
    }
    return Promise.resolve();
  }
}

function makeManager(
  transport: Transport,
  clock: FakeClock,
  states: ConnectionState[],
  overrides: Partial<ConstructorParameters<typeof ConnectionManager>[0]> = {},
) {
  return new ConnectionManager({
    transport,
    onState: (s) => states.push(s),
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    // Jitter off so backoff delays are exact and assertable.
    backoff: new ExponentialBackoff({ base: 1000, max: 30000, jitter: false }),
    pingIntervalMs: 30000,
    pongTimeoutMs: 5000,
    stallHealAfterMs: 10000,
    ...overrides,
  });
}

const names = (states: ConnectionState[]): ConnectionStateName[] => states.map((s) => s.state);

describe("ConnectionManager", () => {
  let clock: FakeClock;
  let transport: FakeTransport;
  let states: ConnectionState[];

  beforeEach(() => {
    clock = new FakeClock();
    transport = new FakeTransport();
    states = [];
  });

  it("idle → connecting → connected happy path emits the right sequence", async () => {
    const cm = makeManager(transport, clock, states);
    expect(cm.getState().state).toBe("idle");

    await cm.connect();
    await flushMicrotasks();

    expect(names(states)).toEqual(["connecting", "connected"]);
    expect(cm.getState().state).toBe("connected");
    expect(transport.openCalls).toBe(1);
  });

  it("open() failure → reconnecting with growing backoff → eventual connected → backoff reset", async () => {
    // Fail the first two opens, succeed on the third.
    transport.failOpens = 2;
    const cm = makeManager(transport, clock, states);

    await cm.connect();
    await flushMicrotasks();

    // First open failed → reconnecting with backoff 1000 (base * 2^0).
    let last = states[states.length - 1];
    expect(last.state).toBe("reconnecting");
    expect(last).toMatchObject({ state: "reconnecting", backoffMs: 1000 });
    expect(transport.openCalls).toBe(1);

    // Advance past the first backoff → second open attempt (also fails) →
    // reconnecting with backoff 2000 (base * 2^1).
    await clock.advance(1000);
    last = states[states.length - 1];
    expect(last).toMatchObject({ state: "reconnecting", backoffMs: 2000 });
    expect(transport.openCalls).toBe(2);

    // Advance past the second backoff → third open attempt (succeeds) → connected.
    await clock.advance(2000);
    expect(transport.openCalls).toBe(3);
    expect(cm.getState().state).toBe("connected");
    expect(names(states)).toContain("connected");

    // Backoff was reset on success: a subsequent stall-reconnect starts at 1000.
    // (Fail the next open to observe the fresh backoff value.)
    transport.failOpens = 1;
    transport.pingHangs = true;
    await clock.advance(30000); // trigger a ping
    await clock.advance(5000); // pong times out → stalled
    expect(cm.getState().state).toBe("stalled");
    await clock.advance(10000); // stall-heal → reconnect
    const reconnecting = states.filter((s) => s.state === "reconnecting");
    // The reconnect after reset starts at backoff 1000 again.
    expect(reconnecting[reconnecting.length - 1]).toMatchObject({ backoffMs: 1000 });
  });

  it("ping timeout → stalled → (past stallHealAfterMs) → reconnect", async () => {
    transport.pingHangs = true;
    const cm = makeManager(transport, clock, states);

    await cm.connect();
    await flushMicrotasks();
    expect(cm.getState().state).toBe("connected");

    // Advance to the first ping.
    await clock.advance(30000);
    expect(transport.pingCalls).toBe(1);
    // Still connected until the pong deadline elapses.
    expect(cm.getState().state).toBe("connected");

    // Advance past the pong timeout → stalled.
    await clock.advance(5000);
    expect(cm.getState().state).toBe("stalled");
    const stalled = states.find((s) => s.state === "stalled");
    expect(stalled).toBeDefined();
    expect((stalled as { since: Date }).since).toBeInstanceOf(Date);

    // Stop hanging so the reconnect can succeed.
    transport.pingHangs = false;

    // Advance past the stall-heal window → close + reconnect.
    await clock.advance(10000);
    // Reconnect path closes the old transport then re-opens.
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
    // After the backoff delay it should reconnect.
    await clock.advance(30000);
    expect(cm.getState().state).toBe("connected");
    expect(transport.openCalls).toBeGreaterThanOrEqual(2);
  });

  it("disconnect() → closed, loops stopped, transport.close() called once, idempotent", async () => {
    const cm = makeManager(transport, clock, states);
    await cm.connect();
    await flushMicrotasks();
    expect(cm.getState().state).toBe("connected");
    // Health-check ping is armed.
    expect(clock.pendingCount()).toBeGreaterThan(0);

    await cm.disconnect("bye");
    expect(cm.getState().state).toBe("closed");
    expect(cm.getState()).toMatchObject({ state: "closed", reason: "bye" });
    expect(transport.closeCalls).toBe(1);
    // All timers cancelled → no pending work.
    expect(clock.pendingCount()).toBe(0);

    // Idempotent: second call is a no-op, does not re-close.
    await cm.disconnect("again");
    expect(transport.closeCalls).toBe(1);
    expect(cm.getState()).toMatchObject({ state: "closed", reason: "bye" });

    // Advancing time must not fire any stale ping / reconnect callbacks.
    const openBefore = transport.openCalls;
    const pingBefore = transport.pingCalls;
    await clock.advance(100000);
    expect(transport.openCalls).toBe(openBefore);
    expect(transport.pingCalls).toBe(pingBefore);
  });

  it("disconnect() from reconnecting state → closed, no further reconnect attempts", async () => {
    transport.failOpens = 100; // never succeeds
    const cm = makeManager(transport, clock, states);

    await cm.connect();
    await flushMicrotasks();
    expect(cm.getState().state).toBe("reconnecting");

    await cm.disconnect();
    expect(cm.getState().state).toBe("closed");

    // Pending reconnect timer must not fire.
    const openBefore = transport.openCalls;
    await clock.advance(100000);
    expect(transport.openCalls).toBe(openBefore);
  });

  it("uses no real wall-clock — a hanging ping never resolves on its own", async () => {
    transport.pingHangs = true;
    const cm = makeManager(transport, clock, states);
    await cm.connect();
    await flushMicrotasks();

    // Without advancing the injected clock, no ping fires and state is stable.
    await flushMicrotasks();
    expect(transport.pingCalls).toBe(0);
    expect(cm.getState().state).toBe("connected");
  });

  it("connect() is a no-op when already connecting/connected", async () => {
    const cm = makeManager(transport, clock, states);
    await cm.connect();
    await flushMicrotasks();
    expect(transport.openCalls).toBe(1);

    // Second connect while connected does nothing.
    await cm.connect();
    await flushMicrotasks();
    expect(transport.openCalls).toBe(1);
  });

  it("connect() after disconnect reuses the manager (closed → idle → connecting)", async () => {
    const cm = makeManager(transport, clock, states);
    await cm.connect();
    await flushMicrotasks();
    await cm.disconnect();
    expect(cm.getState().state).toBe("closed");

    states.length = 0;
    await cm.connect();
    await flushMicrotasks();
    expect(cm.getState().state).toBe("connected");
    // idle transition is internal; observed sequence is connecting → connected.
    expect(names(states)).toEqual(["idle", "connecting", "connected"]);
  });
});
