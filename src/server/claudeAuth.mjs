// Pure helpers for the Claude credential auto-refresh flow (BET-139, BET-280).
//
// Chat mode authenticates to Anthropic via the opencode-claude-auth plugin,
// which reads/writes ~/.claude/.credentials.json. When the plugin can't
// refresh a stale access token, opencode emits an error event whose
// `error.data.message` reads "Claude Code credentials are unavailable or
// expired. Run `claude` to refresh them." — opencode wraps the plugin's
// plain `Error` throw as `UnknownError`, so the legacy ProviderAuthError
// name match never fires in production (BET-280 follow-up). The user's
// manual fix today is to run `claude` once on the box, which re-mints the
// token; this module supplies the PURE decision logic for automating that
// fix. All IO (spawn, file read) lives in src/server/opencode.mjs
// (refreshClaudeCredentials) — this file has no top-level side effects and
// no imports of node:fs / node:child_process, so it's directly node:test-able
// with in-memory literals.

import { homedir } from "node:os";
import path from "node:path";

/** Where the opencode-claude-auth plugin (and the `claude` CLI) persist OAuth
 *  tokens. Expanded via homedir() so it works regardless of $HOME overrides
 *  in the spawned child's env. */
export const CREDENTIALS_PATH = path.join(homedir(), ".claude", ".credentials.json");

/**
 * Parse the raw text of ~/.claude/.credentials.json into the fields we care
 * about. Returns null for invalid JSON or a missing `claudeAiOauth` block —
 * callers treat null as "no usable credentials" rather than throwing.
 *
 * @param {string} rawFileText
 * @returns {{ accessToken?: string, refreshToken?: string, expiresAt?: number, refreshTokenExpiresAt?: number } | null}
 */
export function parseCredentials(rawFileText) {
  let parsed;
  try {
    parsed = JSON.parse(rawFileText);
  } catch {
    return null;
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    refreshTokenExpiresAt: oauth.refreshTokenExpiresAt,
  };
}

/**
 * True when the refresh token itself is expired — i.e. the CLI refresh
 * cannot possibly succeed and the user must re-run `opencode auth login
 * anthropic` (or `claude` interactively) to re-authenticate from scratch.
 * A missing `refreshTokenExpiresAt` is treated as "not expired" (assume
 * still valid — do not block on missing data).
 *
 * @param {{ refreshTokenExpiresAt?: number }} creds
 * @param {number} now epoch millis
 * @returns {boolean}
 */
export function isRefreshTokenExpired(creds, now) {
  const exp = creds?.refreshTokenExpiresAt;
  return typeof exp === "number" && exp <= now;
}

/**
 * Classify the outcome of a refresh attempt by comparing the credential
 * snapshot before and after running the CLI refresh. Pure — no IO, just a
 * decision over the two snapshots + current time.
 *
 * @param {{ credsBefore: ReturnType<typeof parseCredentials>, credsAfter: ReturnType<typeof parseCredentials>, now: number }} args
 * @returns {"no-credentials" | "refresh-token-expired" | "ok" | "failed"}
 */
export function classifyRefreshOutcome({ credsBefore, credsAfter, now }) {
  if (!credsBefore) return "no-credentials";
  if (isRefreshTokenExpired(credsBefore, now)) return "refresh-token-expired";
  // Mirrors the opencode-claude-auth plugin's own freshness check
  // (expiresAt > now + 60_000, a 60s clock-skew margin) — "ok" means the
  // token was genuinely advanced past that window, not just present.
  if (credsAfter && typeof credsAfter.expiresAt === "number" && credsAfter.expiresAt > now + 60_000) {
    return "ok";
  }
  return "failed";
}

/**
 * True when an `error`-shaped payload (typically `evt.properties.error` from a
 * `session.error` event) reports an expired/unavailable Claude credential.
 *
 * Returns true if EITHER:
 *   1. `err.name === "ProviderAuthError"` — kept for forward compatibility if
 *      opencode ever starts emitting that name again (it currently does NOT —
 *      the plugin throws a plain `Error` that opencode wraps as
 *      `UnknownError`); OR
 *   2. the message — read from `err?.data?.message` and coerced via
 *      `String(...)` — matches ALL THREE case-insensitive patterns:
 *      `/claude/`, `/credential/`, `/(expired|unavailable)/`.
 *
 * Matching on the message shape (rather than the exact upstream string) is
 * the entire point of BET-280: BET-139 keyed off `err.name` only and never
 * fired in production because opencode wraps the plugin's throw. The
 * three-substring AND keeps the gate tight enough not to catch unrelated
 * errors, while tolerating minor wording changes upstream.
 *
 * Returns false for null, undefined, non-objects, and any payload that
 * matches neither branch.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isClaudeCredentialError(err) {
  if (err == null || typeof err !== "object") return false;
  if (err.name === "ProviderAuthError") return true;
  const raw = err?.data?.message;
  if (raw == null) return false;
  const msg = String(raw).toLowerCase();
  return /claude/.test(msg) && /credential/.test(msg) && /(expired|unavailable)/.test(msg);
}

/**
 * Cooldown gate for the auto-recovery trigger — returns true when enough time
 * has passed since the last attempt. A single expired-credential burst on the
 * live box produced ~12 error events in ~25 seconds; without this gate each
 * one would spawn its own `claude` process.
 *
 * True when `lastAttemptAt == null` OR `now - lastAttemptAt >= cooldownMs`.
 * Nothing else.
 *
 * @param {number | null | undefined} lastAttemptAt  epoch ms, or null/undefined for "never"
 * @param {number} now                                epoch ms
 * @param {number} [cooldownMs=60_000]                gate window
 * @returns {boolean}
 */
export function shouldAttemptRecovery(lastAttemptAt, now, cooldownMs = 60_000) {
  if (lastAttemptAt == null) return true;
  return now - lastAttemptAt >= cooldownMs;
}
