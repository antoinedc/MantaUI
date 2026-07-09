// Renderer WebSocket reconnect controller for the unified network layer.
//
// This is the stage-4 (BET-46.4) renderer half of BET-46: it replaces the
// ad-hoc `_backoff` / `_reconnectTimer` reconnect logic that used to live
// inline in `src/renderer/api/httpApi.ts` with the SHARED
// `ExponentialBackoff` primitive (BET-46.1) and surfaces the socket's
// lifecycle as the shared `ConnectionState` machine (BET-46.1) so stall /
// reconnect state is unified across the whole app.
//
// It is intentionally transport-injectable and DOM-free: the real
// `WebSocket` constructor and browser timers are passed in, so the whole
// reconnect state machine is unit-testable with a fake socket and fake
// timers (no real sockets, no real sleeps). `httpApi.ts` wires in the live
// `WebSocket` + `setTimeout`/`clearTimeout`.
//
// WHY a bespoke controller and not `ConnectionManager` (BET-46.2)?
//   `ConnectionManager` orchestrates an open/close/PING transport with a
//   health-check ping loop. The events WebSocket here is a *message-carrying*
//   socket with no application-level ping/pong protocol — liveness is observed
//   from the socket's own `onopen`/`onclose`/`onerror`, not from a ping. The
//   issue (BET-46.4 scope §1) calls for exactly this: "WebSocket: manual
//   reconnect via the shared `ExponentialBackoff`". So this controller reuses
//   the shared backoff + state union but drives them off socket events. The
//   SSH/opencode side (BET-46.2/46.3) is the piece that uses ConnectionManager.

import { ExponentialBackoff } from "../../shared/net/backoff.js";
import type { ConnectionState } from "../../shared/net/state.js";

/**
 * The minimal WebSocket surface this controller drives. The real DOM
 * `WebSocket` satisfies it; tests pass a fake. We only touch the members the
 * reconnect loop actually needs.
 */
export interface WsLike {
  readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

/** WebSocket readyState constants (DOM `WebSocket.OPEN` etc.), inlined so the
 *  controller has no DOM dependency and tests can use the same numbers. */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export type TimerHandle = unknown;
export type SetTimeoutFn = (fn: () => void, ms: number) => TimerHandle;
export type ClearTimeoutFn = (handle: TimerHandle) => void;

export interface WsReconnectOpts {
  /**
   * Build the WebSocket URL for the *next* connection attempt. Called fresh on
   * every (re)connect so a rotated token / changed server base is picked up.
   * May THROW (e.g. no server configured) — the controller catches it, reports
   * `closed`, and does NOT schedule a retry (there is nothing to retry until
   * config changes and `connect()` is called again).
   */
  url: () => string;
  /** Construct a socket for `url`. The real impl is `(u) => new WebSocket(u)`. */
  create: (url: string) => WsLike;
  /** Deliver a parsed message frame's raw `data` to the consumer. */
  onMessage: (data: unknown) => void;
  /**
   * Fired once per *reconnect* (a successful open that followed a drop, not the
   * initial connect). The httpApi layer uses this to refetch state that may
   * have changed while disconnected (the existing "resync" behavior).
   */
  onReconnect?: () => void;
  /** Emitted on every connection-state transition (for observers / debugging). */
  onState?: (s: ConnectionState) => void;
  /**
   * Shared exponential backoff for reconnect delays. Defaults to
   * `new ExponentialBackoff({ base: 1000, max: 15000 })` — matches the prior
   * inline cap (1s → 15s) this controller replaces. Reset on every healthy open.
   */
  backoff?: ExponentialBackoff;
  /** Called when `url()` throws (no server configured). Optional; for logging. */
  onConfigError?: (err: unknown) => void;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

/**
 * Owns a single reconnecting WebSocket. `ensure()` opens the socket if it is
 * not already live and is idempotent; a drop (`onclose`/`onerror`) schedules a
 * reconnect through the shared `ExponentialBackoff` and **never permanently
 * abandons** the socket (the guarantee the old inline code made, now unified).
 *
 * Connection lifecycle mapped onto the shared `ConnectionState`:
 *   idle → connecting → connected            (healthy open)
 *   connected → stalled → reconnecting → …    (drop → backoff retry)
 *   * → closed                                (explicit close() / config error)
 *
 * NOTE the socket is message-carrying, so "stalled" here means "the socket
 * dropped" (observed from onclose/onerror), which we surface before entering
 * `reconnecting`. There is no ping loop — liveness is the socket's own events.
 */
export class WsReconnectController {
  private readonly opts: WsReconnectOpts;
  private readonly backoff: ExponentialBackoff;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;

  private ws: WsLike | null = null;
  private state: ConnectionState = { state: "idle" };
  private reconnectTimer: TimerHandle | null = null;
  /** True once we've seen a drop, so the NEXT open is a reconnect (→ onReconnect). */
  private hadDrop = false;
  /** Bumped on close()/teardown so stale socket callbacks no-op. */
  private epoch = 0;

  constructor(opts: WsReconnectOpts) {
    this.opts = opts;
    this.backoff =
      opts.backoff ?? new ExponentialBackoff({ base: 1000, max: 15000 });
    this.setTimeoutFn =
      opts.setTimeoutFn ??
      ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Current connection state (live object, not a copy). */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Ensure a live socket exists. Idempotent: an OPEN or CONNECTING socket is
   * left untouched; a missing / CLOSING / CLOSED one is (re)opened. Safe to
   * call repeatedly (e.g. from a resume watchdog).
   */
  ensure(): void {
    if (
      this.ws &&
      (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)
    ) {
      return;
    }
    this.open();
  }

  /**
   * Force the controller into a "reconnect on next open" posture and ensure a
   * socket. Used by the resume watchdog (iOS foreground / bfcache restore):
   * even if the socket looks alive, we want the next open to trigger a resync
   * of state missed while backgrounded.
   */
  markReconnectAndEnsure(): void {
    this.hadDrop = true;
    this.ensure();
  }

  /**
   * Unconditionally tear down the current socket and open a fresh one RIGHT
   * NOW, even if `readyState === OPEN`. Used by the liveness watchdog
   * (httpApi.ts): a half-open socket keeps reporting OPEN even when the
   * underlying path died silently (tunnel restart, sleep/wake, NAT timeout),
   * so `ensure()` (which no-ops on an already-open socket) can never recover
   * it — only an unconditional close does.
   *
   * This is a deliberate restart, not a failure retry: the backoff is reset
   * first so the reconnect is immediate (no exponential delay), and the drop
   * is marked so the next successful open still fires `onReconnect` (the
   * resync path), exactly like any other reconnect. `open()` itself closes
   * whatever socket currently exists (open/connecting/dead) before creating
   * the new one, so there's no separate close step needed here.
   */
  forceReconnect(): void {
    this.hadDrop = true;
    this.backoff.reset();
    this.open();
  }

  /** Tear down permanently (app teardown). Cancels timers, closes the socket. */
  close(reason = "close"): void {
    this.epoch += 1;
    this.clearReconnectTimer();
    this.closeSocket();
    this.transition({ state: "closed", reason });
  }

  // --- internal ---------------------------------------------------------

  private open(): void {
    this.clearReconnectTimer();
    this.closeSocket();

    let url: string;
    try {
      url = this.opts.url();
    } catch (e) {
      // No server configured (url() threw). Nothing to retry until config
      // changes and ensure()/connect() is called again — report closed, no
      // backoff loop (an infinite retry against a throwing url() would spin).
      this.opts.onConfigError?.(e);
      this.transition({ state: "closed", reason: "no server configured" });
      return;
    }

    this.enterConnecting();
    const myEpoch = this.epoch;
    let ws: WsLike;
    try {
      ws = this.opts.create(url);
    } catch (e) {
      // Constructor threw (malformed URL) — treat as a drop and back off.
      this.opts.onConfigError?.(e);
      this.scheduleReconnect(myEpoch);
      return;
    }
    this.ws = ws;

    ws.onmessage = (m) => {
      if (this.isStale(myEpoch)) return;
      this.opts.onMessage(m.data);
    };
    ws.onopen = () => {
      if (this.isStale(myEpoch)) return;
      this.onOpen();
    };
    // A single "drop" handler for both error and close — the old inline code
    // wired the same `drop` to onerror AND onclose. Reconnect is idempotent
    // (guarded by the reconnectTimer), so a socket that fires both is fine.
    const drop = () => {
      if (this.isStale(myEpoch)) return;
      this.onDrop(myEpoch);
    };
    ws.onerror = drop;
    ws.onclose = drop;
  }

  private onOpen(): void {
    this.backoff.reset();
    this.transition({ state: "connected" });
    if (this.hadDrop) {
      this.hadDrop = false;
      this.opts.onReconnect?.();
    }
  }

  private onDrop(myEpoch: number): void {
    this.hadDrop = true;
    // Surface a stalled tick before reconnecting so observers see the drop
    // distinctly from the reconnect attempt. connected→stalled is a legal edge;
    // from connecting we skip straight to reconnecting.
    if (this.state.state === "connected") {
      this.transition({ state: "stalled", since: new Date() });
    }
    this.scheduleReconnect(myEpoch);
  }

  private scheduleReconnect(myEpoch: number): void {
    if (this.reconnectTimer !== null) return; // a retry is already armed
    const backoffMs = this.backoff.next();
    this.transition({
      state: "reconnecting",
      attempt: this.backoff.attempt(),
      backoffMs,
    });
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      if (this.isStale(myEpoch)) return;
      this.open();
    }, backoffMs);
  }

  private enterConnecting(): void {
    // idle/closed → connecting is the fresh-connect edge; reconnecting →
    // connecting is NOT a legal edge in the shared machine, so when we retry we
    // are already in `reconnecting` and open() is invoked from the timer — we
    // must not re-enter connecting there. Guard by only emitting connecting
    // from a non-reconnecting origin.
    if (this.state.state === "reconnecting") return;
    this.transition({ state: "connecting", attempt: this.backoff.attempt() + 1 });
  }

  private transition(next: ConnectionState): void {
    this.state = next;
    this.opts.onState?.(next);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      // Detach handlers before closing so a late onclose from THIS socket
      // doesn't drive a reconnect against a controller that's moving on.
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* already dead */
      }
      this.ws = null;
    }
  }

  private isStale(capturedEpoch: number): boolean {
    return capturedEpoch !== this.epoch;
  }
}
