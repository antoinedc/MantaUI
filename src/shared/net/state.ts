// Connection state machine for the unified connection manager.
//
// Pure discriminated union + transition helper. Importable from both the
// Electron main process and the renderer.

export type ConnectionState =
  | { state: "idle" }
  | { state: "connecting"; attempt: number }
  | { state: "connected" }
  | { state: "stalled"; since: Date }
  | { state: "reconnecting"; attempt: number; backoffMs: number }
  | { state: "closed"; reason: string };

/** The bare tag of a {@link ConnectionState}. */
export type ConnectionStateName = ConnectionState["state"];

// Legal transition edges:
//   idle         → connecting
//   connecting   → connected | reconnecting | closed
//   connected    → stalled | closed
//   stalled      → reconnecting | connected | closed
//   reconnecting → connected | reconnecting | closed
//   closed       → idle
const TRANSITIONS: Record<ConnectionStateName, readonly ConnectionStateName[]> = {
  idle: ["connecting"],
  connecting: ["connected", "reconnecting", "closed"],
  connected: ["stalled", "closed"],
  stalled: ["reconnecting", "connected", "closed"],
  reconnecting: ["connected", "reconnecting", "closed"],
  closed: ["idle"],
};

/** Returns true iff moving from `from` to `to` is a legal edge. */
export function canTransition(
  from: ConnectionStateName,
  to: ConnectionStateName,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Short human-readable description of a state, for logs. */
export function describe(state: ConnectionState): string {
  switch (state.state) {
    case "idle":
      return "idle";
    case "connecting":
      return `connecting (attempt ${state.attempt})`;
    case "connected":
      return "connected";
    case "stalled":
      return `stalled since ${state.since.toISOString()}`;
    case "reconnecting":
      return `reconnecting (attempt ${state.attempt}, backoff ${state.backoffMs}ms)`;
    case "closed":
      return `closed (${state.reason})`;
  }
}
