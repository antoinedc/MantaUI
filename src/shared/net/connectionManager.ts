// Transport-agnostic connection orchestrator for the unified network layer.
//
// Composes the stage-1 primitives (`ExponentialBackoff`, `ConnectionState` +
// `canTransition`) into a single state machine that drives connect / health
// check / reconnect / disconnect against an INJECTED `Transport`. It performs
// no I/O itself — no `child_process`, no `EventSource`, no `WebSocket`. The real
// SSH and SSE/WS transports get wired in stages 3 (BET-46.3) and 4 (BET-46.4).
//
// All time and timer access goes through injectable `now` / `setTimeoutFn` /
// `clearTimeoutFn` hooks so tests are fully deterministic (no real sleeps).

import { ExponentialBackoff } from "./backoff";
import { canTransition, describe as describeState } from "./state";
import type { ConnectionState, ConnectionStateName } from "./state";

/**
 * The underlying connection this manager orchestrates. Implementations are
 * injected (SSH ControlMaster, EventSource, WebSocket, or a test fake) — the
 * manager never constructs one itself.
 */
export interface Transport {
  /** Establish the underlying connection. Rejects/throws on failure. */
  open(): Promise<void>;
  /** Tear the underlying connection down. Should not throw in normal use. */
  close(): Promise<void>;
  /** Resolve on pong; reject/throw (or never resolve) when the peer is dead. */
  ping(): Promise<void>;
}

/** Opaque timer handle — a number (browser) or NodeJS.Timeout. Never inspected. */
export type TimerHandle = unknown;

export type SetTimeoutFn = (fn: () => void, ms: number) => TimerHandle;
export type ClearTimeoutFn = (handle: TimerHandle) => void;

export interface ConnectionManagerOpts {
  /** The injected transport to drive. Required. */
  transport: Transport;
  /**
   * Shared exponential backoff used for reconnect delays. Defaults to
   * `new ExponentialBackoff({ base: 1000, max: 30000 })`. Reset on every
   * successful (re)connect.
   */
  backoff?: ExponentialBackoff;
  /** Interval between health-check pings while connected. Defaults to 30000ms. */
  pingIntervalMs?: number;
  /** How long to wait for a pong before marking the link stalled. Defaults to 5000ms. */
  pongTimeoutMs?: number;
  /** How long the link may stay stalled before we force a reconnect. Defaults to 10000ms. */
  stallHealAfterMs?: number;
  /** Emitted on every state transition. */
  onState?: (s: ConnectionState) => void;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable timer scheduler. Defaults to global `setTimeout`. */
  setTimeoutFn?: SetTimeoutFn;
  /** Injectable timer canceller. Defaults to global `clearTimeout`. */
  clearTimeoutFn?: ClearTimeoutFn;
}

/**
 * Orchestrates a single transport through the connection lifecycle:
 *
 *   idle → connecting → connected ⇄ stalled → reconnecting → connected …
 *                                                → closed
 *
 * - `connect()` opens the transport, retrying with exponential backoff on
 *   failure, and starts a health-check loop once connected.
 * - The health-check loop pings every `pingIntervalMs`; a ping that doesn't
 *   resolve within `pongTimeoutMs` marks the link `stalled`. Once it has been
 *   stalled for `stallHealAfterMs`, a reconnect is triggered.
 * - `disconnect()` stops all loops, closes the transport once, and lands in
 *   `closed`. It is idempotent.
 */
export class ConnectionManager {
  private readonly transport: Transport;
  private readonly backoff: ExponentialBackoff;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly stallHealAfterMs: number;
  private readonly onState?: (s: ConnectionState) => void;
  private readonly now: () => number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;

  private state: ConnectionState = { state: "idle" };

  /** Pending scheduled timers we own, so `disconnect()` can cancel them. */
  private pingTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  /** Monotonic epoch bumped on every teardown so stale async callbacks no-op. */
  private epoch = 0;

  constructor(opts: ConnectionManagerOpts) {
    this.transport = opts.transport;
    this.backoff = opts.backoff ?? new ExponentialBackoff({ base: 1000, max: 30000 });
    this.pingIntervalMs = opts.pingIntervalMs ?? 30000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 5000;
    this.stallHealAfterMs = opts.stallHealAfterMs ?? 10000;
    this.onState = opts.onState;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Current connection state (the live object, not a copy). */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Begin connecting. Transitions idle→connecting and attempts `open()`. On
   * success → connected and the health loop starts; on failure → reconnecting
   * with a backoff delay, then retries. No-op if already past `idle`/`closed`.
   */
  async connect(): Promise<void> {
    if (this.state.state !== "idle") {
      // Only a fresh (idle) or previously-closed→idle manager may connect.
      // `connecting`/`connected`/etc. are already in-flight; ignore.
      if (this.state.state === "closed") {
        // closed → idle is a legal edge; allow a caller to reuse the manager.
        this.transition({ state: "idle" });
      } else {
        return;
      }
    }
    await this.attemptOpen(1);
  }

  /**
   * Stop all activity and close the transport exactly once. Lands in
   * `closed{reason}`. Idempotent — a second call while already closed is a
   * no-op that does NOT re-close the transport.
   */
  async disconnect(reason = "disconnect"): Promise<void> {
    if (this.state.state === "closed") return;
    this.teardownTimers();
    // Bump epoch so any in-flight open/ping callback recognises it is stale.
    this.epoch += 1;
    this.transition({ state: "closed", reason });
    await this.safeClose();
  }

  // --- internal ---------------------------------------------------------

  /**
   * Attempt to open the transport. On failure, schedule a backoff-delayed
   * retry via the reconnecting state. `attempt` is 1-indexed for reporting.
   */
  private async attemptOpen(attempt: number): Promise<void> {
    this.transition({ state: "connecting", attempt });
    const myEpoch = this.epoch;
    try {
      await this.transport.open();
    } catch {
      if (this.isStale(myEpoch)) return;
      this.scheduleReconnect(attempt);
      return;
    }
    if (this.isStale(myEpoch)) return;
    this.onConnected();
  }

  /** Land in `connected`, reset backoff, and (re)arm the health-check loop. */
  private onConnected(): void {
    this.backoff.reset();
    this.transition({ state: "connected" });
    this.armPing();
  }

  /**
   * Schedule the next reconnect attempt after a backoff delay. Enters
   * `reconnecting` immediately (so observers see it), then waits `backoffMs`
   * before the next `open()`.
   */
  private scheduleReconnect(prevAttempt: number): void {
    const backoffMs = this.backoff.next();
    const nextAttempt = prevAttempt + 1;
    this.transition({ state: "reconnecting", attempt: nextAttempt, backoffMs });
    const myEpoch = this.epoch;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      if (this.isStale(myEpoch)) return;
      void this.attemptOpen(nextAttempt);
    }, backoffMs);
  }

  /** Arm the next health-check ping `pingIntervalMs` from now. */
  private armPing(): void {
    const myEpoch = this.epoch;
    this.pingTimer = this.setTimeoutFn(() => {
      this.pingTimer = null;
      if (this.isStale(myEpoch)) return;
      void this.runHealthCheck();
    }, this.pingIntervalMs);
  }

  /**
   * Ping the transport with a `pongTimeoutMs` deadline. A timely pong re-arms
   * the loop; a timeout marks the link stalled and starts the stall-heal timer.
   */
  private async runHealthCheck(): Promise<void> {
    if (this.state.state !== "connected") return;
    const myEpoch = this.epoch;

    let timedOut = false;
    const timeout = new Promise<"timeout">((resolve) => {
      const h = this.setTimeoutFn(() => {
        timedOut = true;
        resolve("timeout");
      }, this.pongTimeoutMs);
      // Store on the ping slot so a disconnect cancels the pong deadline too.
      this.pingTimer = h;
    });

    let outcome: "ok" | "timeout";
    try {
      outcome = await Promise.race([
        this.transport.ping().then(() => "ok" as const),
        timeout,
      ]);
    } catch {
      outcome = "timeout";
    }

    if (this.isStale(myEpoch)) return;
    // If the pong won the race, cancel the still-pending timeout timer.
    if (!timedOut && this.pingTimer !== null) {
      this.clearTimeoutFn(this.pingTimer);
      this.pingTimer = null;
    }

    if (outcome === "ok") {
      // Healthy: schedule the next ping.
      this.armPing();
      return;
    }
    this.onStalled();
  }

  /** Enter `stalled`, recording `since`, and arm the stall-heal timer. */
  private onStalled(): void {
    const since = new Date(this.now());
    this.transition({ state: "stalled", since });
    const myEpoch = this.epoch;
    this.pingTimer = this.setTimeoutFn(() => {
      this.pingTimer = null;
      if (this.isStale(myEpoch)) return;
      if (this.state.state !== "stalled") return;
      void this.healViaReconnect();
    }, this.stallHealAfterMs);
  }

  /**
   * Heal a stalled link: close the current transport, then reconnect through
   * the normal backoff path.
   */
  private async healViaReconnect(): Promise<void> {
    const myEpoch = this.epoch;
    await this.safeClose();
    if (this.isStale(myEpoch)) return;
    // stalled → reconnecting is a legal edge; drive the backoff loop from here.
    this.scheduleReconnect(this.backoff.attempt());
  }

  /** Apply a state transition, guarding illegal edges, and notify observers. */
  private transition(next: ConnectionState): void {
    const from: ConnectionStateName = this.state.state;
    if (from !== next.state && !canTransition(from, next.state)) {
      throw new Error(
        `illegal connection transition ${from} → ${next.state} ` +
          `(current: ${describeState(this.state)})`,
      );
    }
    this.state = next;
    this.onState?.(next);
  }

  /** Cancel every timer we own. */
  private teardownTimers(): void {
    if (this.pingTimer !== null) {
      this.clearTimeoutFn(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Close the transport, swallowing errors (best-effort teardown). */
  private async safeClose(): Promise<void> {
    try {
      await this.transport.close();
    } catch {
      // Best-effort; a failing close must not wedge the state machine.
    }
  }

  /**
   * True if the manager has been torn down / re-driven since `capturedEpoch`
   * was taken, meaning this async continuation is stale and must not mutate
   * state. Every scheduled callback checks this before acting.
   */
  private isStale(capturedEpoch: number): boolean {
    return capturedEpoch !== this.epoch;
  }
}
