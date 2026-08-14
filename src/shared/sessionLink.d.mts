// Hand-written type declarations for sessionLink.mjs. Implementation is plain
// JS so any server code imports it natively; the renderer imports through
// bundler resolution. Keep in sync with src/shared/sessionLink.mjs.

import type { SessionLink, SessionLinkRef } from "./types.js";

// The shape a session record must carry for the link helpers. In the box this
// is `ProjectMeta` (src/shared/types.ts), which carries `link?`; the optional
// slot is open (`unknown`) so any record — linked or not — is accepted and its
// other fields are preserved through the mutators.
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

// Set (replace) the session's issue link, preserving any PR link. Returns a
// NEW record (the caller persists it). Throws `TypeError` on an invalid ref.
export function linkIssue<S extends SessionLike>(
  session: S | null | undefined,
  ref: SessionLinkRef,
): S;

// Set (replace) the session's PR link, preserving any issue link. Returns a
// NEW record. Throws `TypeError` on an invalid ref.
export function linkPullRequest<S extends SessionLike>(
  session: S | null | undefined,
  ref: SessionLinkRef,
): S;

// Remove the session's link entirely (both slots). Returns a NEW record.
export function clearLink<S extends SessionLike>(
  session: S | null | undefined,
): S;
