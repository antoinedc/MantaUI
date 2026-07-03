// sessionActions.ts — pure decision logic for the mobile session actions
// (new / clear / fork / compact), mirroring the desktop composite operations
// the box exposes on its RPC channels (src/server/rpc.mjs):
//
//   • "new session" / "clear"  → `opencode:clear-session`
//        creates a fresh opencode session and re-stamps it onto the SAME tmux
//        window (sessionName + windowIndex). This is the desktop "New chat /
//        Clear" — the window keeps its slot, the conversation resets.
//        payload: { sessionName, windowIndex, cwd?, title? }
//   • "fork"    → `opencode:fork-session`
//        forks the current opencode session into a NEW tmux window.
//        payload: { sessionId, sessionName, windowName, cwd?, messageID? }
//   • "compact" → `opencode:compact-session`
//        compacts (summarizes) the running session's context in place.
//        payload (positional arg): sessionId
//
// The screens stay thin: they collect the tap, ask THIS module which channel +
// payload to send and whether the action is even allowed for the row, then hand
// the result to the impure ../api/pairingApi. Keeping the channel/payload/guard
// LOGIC pure makes it unit-testable without a live box — the same pure↔impure
// split the other mobile-rn modules use.

import type { SessionRowVM } from "./sessionList";

/** The four session actions the mobile UI can trigger. */
export type SessionActionKind = "new" | "clear" | "fork" | "compact";

/** A resolved action ready to dispatch: the RPC channel + its payload. */
export interface SessionActionRequest {
  kind: SessionActionKind;
  /** The box RPC channel this action maps to. */
  channel:
    | "opencode:clear-session"
    | "opencode:fork-session"
    | "opencode:compact-session";
  /**
   * The RPC payload. `clear`/`fork` send a single object arg; `compact` sends a
   * positional sessionId string. The caller spreads/positions this per channel.
   */
  payload: ClearSessionPayload | ForkSessionPayload | CompactSessionPayload;
}

export interface ClearSessionPayload {
  sessionName: string;
  windowIndex: number;
  /** cwd is optional — the box resolves the project cwd when omitted. */
  cwd?: string;
  title?: string;
}

export interface ForkSessionPayload {
  sessionId: string;
  sessionName: string;
  windowName: string;
  cwd?: string;
  messageID?: string;
}

/** compact takes the raw opencode session id as its single positional arg. */
export type CompactSessionPayload = { sessionId: string };

/**
 * Whether a given action is available for a session row.
 *
 *  - "new" / "clear": available for ANY row that has a tmux window (both chat
 *    and terminal rows have a session + windowIndex). Clearing a terminal is a
 *    no-op on opencode but harmless; we still allow "new" for chat rows only,
 *    since that's the meaningful case. Terminals can't hold a chat, so we gate
 *    new/clear/fork/compact to chat rows to keep the UI honest.
 *  - "fork" / "compact": require a live opencode session id (chat rows only).
 *
 * A row without an opencodeSessionId is a terminal — none of these opencode
 * actions apply. Pure.
 */
export function isActionAvailable(
  kind: SessionActionKind,
  row: SessionRowVM,
): boolean {
  // All four actions operate on an opencode chat session; terminals have none.
  if (row.kind !== "chat" || !row.opencodeSessionId) return false;
  return (
    kind === "new" ||
    kind === "clear" ||
    kind === "fork" ||
    kind === "compact"
  );
}

/**
 * The set of actions available for a row, in display order (New, Fork, Compact).
 * "clear" is the same channel as "new"; the UI surfaces a single "New chat"
 * entry, so we expose New/Fork/Compact here and let the component label it.
 * Returns [] for a terminal row. Pure.
 */
export function availableActions(row: SessionRowVM): SessionActionKind[] {
  if (row.kind !== "chat" || !row.opencodeSessionId) return [];
  return ["new", "fork", "compact"];
}

/**
 * Resolve a tapped action + row into the concrete RPC channel + payload, or
 * null when the action isn't available for that row (terminal / missing
 * session id). The caller dispatches the returned request via pairingApi.
 *
 * `title` (optional) names a freshly-cleared session; `messageID` (optional)
 * forks from a specific message rather than the tip. Pure.
 */
export function resolveSessionAction(
  kind: SessionActionKind,
  row: SessionRowVM,
  opts: { title?: string; messageID?: string } = {},
): SessionActionRequest | null {
  if (!isActionAvailable(kind, row)) return null;

  const sessionId = row.opencodeSessionId;
  if (!sessionId) return null;

  switch (kind) {
    case "new":
    case "clear":
      return {
        kind,
        channel: "opencode:clear-session",
        payload: {
          sessionName: row.project,
          windowIndex: row.windowIndex,
          title: opts.title,
        },
      };
    case "fork":
      return {
        kind,
        channel: "opencode:fork-session",
        payload: {
          sessionId,
          sessionName: row.project,
          // A forked window is named after the source row's title so it's
          // recognizable in the list; the box de-dups window names as needed.
          windowName: row.title,
          messageID: opts.messageID,
        },
      };
    case "compact":
      return {
        kind,
        channel: "opencode:compact-session",
        payload: { sessionId },
      };
    default: {
      // Exhaustiveness guard — a new SessionActionKind must be handled above.
      const _never: never = kind;
      return _never;
    }
  }
}
