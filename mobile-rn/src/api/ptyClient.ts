// ptyClient.ts — the impure /pty WebSocket client for the RN app.
//
// Opens the box's `GET <base>/pty?session=NAME&window=INDEX&cols=C&rows=R`
// WebSocket with the box_token as a `?token=` query param (the server accepts
// `?token=` on /events + /pty ONLY — see src/server/index.mjs).
//
// Client→Server frames are JSON: `{type:"data",data:"..."}` for input,
// `{type:"resize",cols,C}` for terminal resize.
// Server→Client frames are raw PTY output (utf-8 strings).
//
// The client owns the socket lifecycle (connect, send, close, reconnect on
// drop) and exposes a simple API: `attach()` to connect, `write(text)` to send
// input, `resize(cols, rows)` to notify the server of a resize, `onData(cb)` to
// receive output, and `close()` to tear down.

/** Handle returned by {@link attachPty}; call to tear down. */
export interface PtyHandle {
  /** Send raw text to the PTY (user keystrokes). */
  write(text: string): void;
  /** Notify the server of a terminal resize. */
  resize(cols: number, rows: number): void;
  /** Close the WebSocket. */
  close(): void;
  /** Attach a listener for raw PTY output. Returns an unsubscribe function. */
  onData(cb: (data: string) => void): () => void;
  /** Attach a listener for close/error events. Returns an unsubscribe function. */
  onClose(cb: (reason?: string) => void): () => void;
}

/** Strip trailing slashes so "http://box/" and "http://box" behave identically. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Build the /pty WebSocket URL with session/window/cols/rows/token params.
 * http→ws / https→wss.
 */
export function ptyWsUrl(
  base: string,
  token: string,
  session: string,
  windowIdx: number,
  cols: number,
  rows: number,
): string {
  const ws = trimBase(base).replace(/^http/, "ws") + "/pty";
  const params = new URLSearchParams({
    session,
    window: String(windowIdx),
    cols: String(cols),
    rows: String(rows),
    token,
  });
  return `${ws}?${params.toString()}`;
}

/**
 * Attach to the box's /pty WebSocket for the given session/window. Returns a
 * handle that can send input, resize, and receive output. The socket reconnects
 * with exponential backoff on unexpected close (never permanently abandons).
 *
 * Default terminal size: 80x24 (matches the server's fallback).
 */
export function attachPty(
  base: string,
  token: string,
  session: string,
  windowIdx: number,
  opts: { cols?: number; rows?: number; backoff?: BackoffConfig } = {},
): PtyHandle {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const backoff = opts.backoff ?? {
    initialMs: 1000,
    maxMs: 30000,
    factor: 2,
    maxAttempts: Infinity,
  };

  let socket: WebSocket | null = null;
  let closedByCaller = false;
  let attempt = 0;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;

  const dataListeners = new Set<(data: string) => void>();
  const closeListeners = new Set<(reason?: string) => void>();

  function scheduleReconnect() {
    if (closedByCaller) return;
    attempt += 1;
    const delayMs = Math.min(
      backoff.initialMs * Math.pow(backoff.factor, attempt - 1),
      backoff.maxMs,
    );
    if (attempt > backoff.maxAttempts) return;
    retryHandle = setTimeout(() => {
      retryHandle = null;
      connect();
    }, delayMs);
  }

  function connect() {
    if (closedByCaller) return;
    const url = ptyWsUrl(base, token, session, windowIdx, cols, rows);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
    };

    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      for (const cb of dataListeners) {
        try {
          cb(data);
        } catch {
          /* listener threw — never let it break the socket loop */
        }
      }
    };

    ws.onerror = () => {
      /* onclose follows an error; reconnect handled there */
    };

    ws.onclose = (ev) => {
      socket = null;
      const reason = ev?.reason ?? "connection closed";
      for (const cb of closeListeners) {
        try {
          cb(reason);
        } catch {
          /* ignore */
        }
      }
      scheduleReconnect();
    };
  }

  function send(type: string, payload: Record<string, unknown>) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type, ...payload }));
    } catch {
      /* socket may have closed between check and send — reconnect will retry */
    }
  }

  return {
    write(text: string) {
      send("data", { data: text });
    },
    resize(newCols: number, newRows: number) {
      send("resize", { cols: newCols, rows: newRows });
    },
    onData(cb: (data: string) => void) {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onClose(cb: (reason?: string) => void) {
      closeListeners.add(cb);
      return () => {
        closeListeners.delete(cb);
      };
    },
    close() {
      closedByCaller = true;
      if (retryHandle != null) {
        clearTimeout(retryHandle);
        retryHandle = null;
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* already closing */
        }
        socket = null;
      }
    },
  };
}

interface BackoffConfig {
  initialMs: number;
  maxMs: number;
  factor: number;
  maxAttempts: number;
}
