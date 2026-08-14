// Hand-written type declarations for sessionLink.mjs. Implementation is plain
// JS so any server code imports it natively. Keep in sync with
// src/shared/sessionLink.mjs.

import type { SessionLink } from "./types.js";

// The shape a session record's `link` slot may carry. The slot is open
// (`unknown`) so any record — linked or not — is accepted.
export type SessionLike = {
  tmuxSession?: unknown;
  defaultCwd?: unknown;
  link?: SessionLink | null;
};

// Read a session's link — a normalized `{ issue?, pr? }` (only set slots) or
// `null` when the record has no link. Never returns the raw stored value.
export function sessionLink(
  session: SessionLike | null | undefined,
): SessionLink | null;
