// Pure helpers for the Claude credential flow (BET-139, BET-280, BET-354).
//
// Two flows live in this module:
//
//   1. REACTIVE AUTO-REFRESH (BET-139, BET-280). Chat mode authenticates
//      to Anthropic via the opencode-claude-auth plugin, which reads/writes
//      ~/.claude/.credentials.json. When the plugin can't refresh a stale
//      access token, opencode emits an error event whose
//      `error.data.message` reads "Claude Code credentials are unavailable or
//      expired. Run `claude` to refresh them." — opencode wraps the plugin's
//      plain `Error` throw as `UnknownError`, so the legacy ProviderAuthError
//      name match never fires in production. This module supplies the PURE
//      decision logic for automating the CLI fix. All IO (spawn, file read)
//      lives in src/server/opencode.mjs (refreshClaudeCredentials).
//
//   2. PROACTIVE CONNECT (BET-354). Onboarding + Settings → Connect Claude
//      spawn `claude auth login` on the box, stream its output through the
//      existing pty bus, and detect completion by watching the credentials
//      file. This module supplies the pure helpers for the
//      connect flow: URL extraction from a noisy stream and completion
//      detection from file mtime. IO still lives outside this file — in
//      opencode.mjs's `startClaudeLogin` / `pollClaudeLogin`.
//
// No top-level side effects; no node:fs / node:child_process imports. All
// helpers are directly testable in node:test with in-memory literals.

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
 * INTENTIONALLY CLAUDE-ONLY — DO NOT GENERALIZE. Codex (`openai`) and Kimi
 * (`kimi-for-coding`) tokens are minted and refreshed by opencode itself, so
 * their failures surface through opencode's own error path (BET-316). Only
 * Claude's tokens come from an external CLI (`claude`) and need the
 * server-side auto-refresh this predicate gates. "Helpfully" extending this
 * predicate to cover Codex/Kimi would mean manta spawns `claude` to fix
 * problems the plugin cannot solve — every revert on this file has been
 * exactly that generalization, so this comment is here to break the cycle.
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

/**
 * Pre-expiry gate for the proactive refresh poller (BET-281). Returns true
 * when the OAuth access token is "about to expire" (within `leadMs`) AND a
 * refresh is still possible (the refresh token itself is not expired).
 *
 * True when ALL of:
 *   - `creds` is non-null
 *   - `typeof creds.expiresAt === "number"`
 *   - `creds.expiresAt - now <= leadMs`
 *   - `isRefreshTokenExpired(creds, now)` is false
 *
 * Returns false otherwise. Pure — no IO, no imports beyond what this file
 * already has. Reuses `isRefreshTokenExpired` rather than re-implementing the
 * refresh-token check (single source of truth).
 *
 * @param {{ expiresAt?: number, refreshTokenExpiresAt?: number } | null | undefined} creds
 * @param {number} now        epoch ms
 * @param {number} [leadMs=30 * 60_000]  refresh this far before expiry
 * @returns {boolean}
 */
export function shouldRefreshAhead(creds, now, leadMs = 30 * 60_000) {
  if (!creds) return false;
  if (typeof creds.expiresAt !== "number") return false;
  if (creds.expiresAt - now > leadMs) return false;
  return !isRefreshTokenExpired(creds, now);
}

// ---------------------------------------------------------------------------
// BET-354: Claude connect flow helpers
// ---------------------------------------------------------------------------
//
// Used by the in-app Claude connect card (ConnectProvider.tsx) which spawns
// `claude auth login` on the box and drives it interactively. The IO
// (spawn / pty write / fs.stat) lives in src/server/opencode.mjs
// (`startClaudeLogin`, `pollClaudeLogin`, `claudeLoginWrite`); this file
// holds the PURE helpers that make those decisions testable.

/**
 * Pattern that matches Claude's OAuth authorize URL specifically. Anchored
 * to the `claude.com/cai/oauth/authorize` path with an OAuth-shape query
 * (client_id, response_type=code, redirect_uri). Exported so a future
 * upstream shape change is one place to fix.
 *
 * Filtering on shape rather than the byte position of the first https:// is
 * load-bearing: the first-launch trust prompt's "Security guide" link is
 * also `https://…`; a regex that latches onto the FIRST URL picks that one
 * and never updates.
 */
export const CLAUDE_OAUTH_URL_RE =
  /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x07\x1b]+/g;

/**
 * Pull the Claude OAuth authorize URL out of a free-form text chunk (the
 * concatenated stdout of `claude auth login` so far). Returns the FIRST
 * match — the URL stays on screen until the OAuth completes, so the first
 * match IS the live one. Returns null when the chunk has no
 * authorize-URL-shaped substring.
 *
 * Trailing punctuation that occasionally wraps in (`)].,;`) is stripped
 * defensively; the live URL is clean today but terminal soft-wrap and
 * future TUI rewordings may not be.
 *
 * @param {string} chunk   accumulated stdout bytes, decoded to text
 * @returns {string|null}
 */
export function extractClaudeAuthUrl(chunk) {
  if (typeof chunk !== "string" || chunk.length === 0) return null;
  const matches = chunk.match(CLAUDE_OAUTH_URL_RE);
  if (!matches || matches.length === 0) return null;
  // Strip trailing `)].,;` that can ride in from parenthetical wraps.
  return matches[0].replace(/[\]).,;]+$/, "");
}

/**
 * Classify the state of a Claude login attempt given the current credentials
 * file mtime + when the connect card started. Pure — IO lives in
 * `pollClaudeLogin`.
 *
 * Returns one of:
 *   - `"no-file"`         — credentials file does not exist (yet). The card
 *                           stays in `waiting`. This is the "still authenticating"
 *                           state for a fresh box.
 *   - `"pre-existing"`    — file exists AND was last modified before the
 *                           connect card started. The user had a working login
 *                           already; the connect flow is a no-op for them
 *                           unless they actually went through OAuth. Not an
 *                           error — the caller can choose to short-circuit
 *                           straight to the restart step.
 *   - `"completed"`       — file exists AND was last modified after the
 *                           connect card started. The CLI login wrote new
 *                           credentials; ready for restart + connected poll.
 *
 * A `null` `mtimeMs` is treated as "file missing" (the IO wrapper uses
 * fs.stat and a missing file returns `mtimeMs === null`).
 *
 * @param {{ mtimeMs: number | null }} stat
 * @param {number} startedAt     epoch ms the connect flow began
 * @returns {"no-file" | "pre-existing" | "completed"}
 */
export function classifyClaudeLoginProgress(stat, startedAt) {
  if (!stat || typeof stat.mtimeMs !== "number") return "no-file";
  if (!Number.isFinite(startedAt)) return "no-file";
  return stat.mtimeMs >= startedAt ? "completed" : "pre-existing";
}
