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
// No top-level side effects. Most helpers are pure decision logic
// (operate on in-memory literals — directly testable in node:test); the
// BET-359 helpers (`backupClaudeCredentials`, `restoreFromBackup`) do
// async IO via `node:fs/promises` because their whole job is file copy.
// They never throw — every IO failure surfaces as a structured result.

import { homedir } from "node:os";
import path from "node:path";
import { stat as fsStat, copyFile as fsCopyFile, readFile as fsReadFile } from "node:fs/promises";

/** Where the opencode-claude-auth plugin (and the `claude` CLI) persist OAuth
 *  tokens. Expanded via homedir() so it works regardless of $HOME overrides
 *  in the spawned child's env. */
export const CREDENTIALS_PATH = path.join(homedir(), ".claude", ".credentials.json");

/** Default validator for the freshly-written credentials file: any non-null
 *  parseCredentials result means the new file is well-formed JSON containing
 *  a `claudeAiOauth` block. The `claude auth login` CLI always emits a full
 *  block on success; an empty / truncated / malformed write fails this gate
 *  and triggers a restore from the BET-359 backup.
 *
 *  Exposed as a named constant (rather than inlined in `restoreFromBackup`)
 *  so the connect card + future automated tests can reuse the same shape
 *  without re-deriving it.
 */
export function defaultCredentialsValidator(rawFileText) {
  return parseCredentials(rawFileText) !== null;
}

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

// ---------------------------------------------------------------------------
// BET-359 fold-in (BET-367 §4): backup-before-overwrite + restore-on-failure
// ---------------------------------------------------------------------------
//
// `claude auth login` writes `~/.claude/.credentials.json` in place; every
// running opencode session that has the file captured at startup (the BET-352
// invariant — pinned by opencodeRestart.test.mjs) loses its tokens on the
// next request. The simplest honest mitigation is: snapshot the existing
// file before any flow that might overwrite it, and if the freshly-written
// file turns out to be empty / malformed, copy the snapshot back.
//
// These helpers are the snapshot + restore primitives. They are
// ASYNC + IO-DEPENDENT (so they're not "pure" in the same sense as the
// classifier helpers above), but they have no top-level side effects, no
// shared mutable state, and never throw — every IO failure surfaces as a
// structured result the caller can route into the connect card's UI.
//
// Wired from `startClaudeLogin` (backup, BEFORE the user can complete OAuth)
// and `pollClaudeLogin`'s `"completed"` branch (restore, AFTER the new file
// is detected + validated).

/**
 * Snapshot the existing credentials file so a destructive overwrite can be
 * rolled back if the new file turns out to be empty / malformed.
 *
 * Returns one of:
 *   - `{ backedUp: true, backupPath }`            — an existing file was
 *                                                  found and copied to
 *                                                  `<credentialsFile>.bak.<unix-ts>`.
 *   - `{ backedUp: false, reason: "no existing file" }`
 *                                               — there was nothing to
 *                                                  back up (a fresh box, or
 *                                                  the user already wiped
 *                                                  the file). Not an error.
 *   - `{ backedUp: false, reason: "copy-failed", error }`
 *                                               — an existing file was found
 *                                                  but the copy failed (perms,
 *                                                  EIO, ENOSPC, …). The caller
 *                                                  should surface this to the
 *                                                  user — proceeding without
 *                                                  a safety net is a real risk.
 *
 * Backup naming uses seconds granularity (`<file>.bak.<unix-ts>`). Collisions
 * inside the same second overwrite the earlier backup — the simpler-honest
 * behavior. Two `claude auth login` runs within 1 second on the same path
 * is not a scenario the connect flow exercises (the renderer spawns the
 * pty, the user types the code, the CLI writes the file — measured in
 * seconds, not sub-second), so overwriting is acceptable.
 *
 * Never throws. Input validation surfaces as `{ backedUp: false }` rather
 * than a TypeError so the connect card's caller doesn't have to wrap the
 * call in try/catch — every path through this helper returns a value.
 *
 * @param {{ credentialsFile: string, now: number }} args
 * @returns {Promise<
 *   | { backedUp: true, backupPath: string }
 *   | { backedUp: false, reason: "no existing file" }
 *   | { backedUp: false, reason: "copy-failed", error: string }
 * >}
 */
export async function backupClaudeCredentials({ credentialsFile, now }) {
  if (typeof credentialsFile !== "string" || credentialsFile.length === 0) {
    return { backedUp: false, reason: "no existing file" };
  }
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) {
    return { backedUp: false, reason: "no existing file" };
  }
  // stat-then-copy: a missing file is the common case (fresh box, first
  // ever login) and is reported as "no existing file" — NOT an error. We
  // distinguish "missing" from "copy failed" so the caller can decide
  // whether to abort (copy-failed = real risk of silent destruction).
  try {
    await fsStat(credentialsFile);
  } catch {
    return { backedUp: false, reason: "no existing file" };
  }
  const backupPath = `${credentialsFile}.bak.${Math.floor(now / 1000)}`;
  try {
    await fsCopyFile(credentialsFile, backupPath);
  } catch (e) {
    return {
      backedUp: false,
      reason: "copy-failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  return { backedUp: true, backupPath };
}

/**
 * Roll the credentials file back to a previously-taken backup when the
 * freshly-written file is empty / malformed (the validator returns false).
 *
 * Behaviour:
 *   - Reads the live credentials file; if the validator accepts it, this
 *     helper is a no-op (`{ restored: false, reason: "valid" }`).
 *   - If the live file is missing / unreadable / fails the validator, copies
 *     `backupPath` over `credentialsFile` and returns
 *     `{ restored: true, from, to }`.
 *   - If the live file fails validation AND the restore copy itself fails
 *     (perms, EIO, …), returns `{ restored: false, reason: "copy-failed", error }`
 *     so the caller can surface "the new login failed AND we couldn't roll
 *     back" — the user is in the worst state, but at least the failure mode
 *     is named.
 *   - If `backupPath` is missing (e.g. the user had no credentials to back
 *     up), the restore is a no-op (`{ restored: false, reason: "no-backup" }`)
 *     — there's nothing to roll back TO, so we don't pretend we did.
 *
 * Never throws. Designed for the connect-card poll loop, which must NOT
 * propagate an exception into the renderer's per-second tick.
 *
 * The default validator (`defaultCredentialsValidator`) reuses
 * `parseCredentials` — empty / malformed / missing-claudeAiOauth all
 * return null and fail the gate. Callers can supply a stricter validator
 * (e.g. one that also checks for a non-empty `accessToken`) without
 * changing this helper.
 *
 * @param {{
 *   credentialsFile: string,
 *   backupPath: string | null | undefined,
 *   validator: (rawFileText: string) => boolean,
 * }} args
 * @returns {Promise<
 *   | { restored: true, from: string, to: string }
 *   | { restored: false, reason: "valid" }
 *   | { restored: false, reason: "no-backup" }
 *   | { restored: false, reason: "copy-failed", error: string }
 * >}
 */
export async function restoreFromBackup({ credentialsFile, backupPath, validator }) {
  if (typeof credentialsFile !== "string" || credentialsFile.length === 0) {
    return { restored: false, reason: "no-backup" };
  }
  if (typeof backupPath !== "string" || backupPath.length === 0) {
    // The connect flow took no backup (fresh box, first-ever login). There
    // is nothing to roll back TO — this is the correct no-op, not a failure.
    return { restored: false, reason: "no-backup" };
  }
  if (typeof validator !== "function") {
    // A missing validator is a programmer error, but per the never-throws
    // contract above we surface it as a structured failure rather than
    // letting it propagate. The caller can decide whether to log + crash.
    return { restored: false, reason: "copy-failed", error: "validator not a function" };
  }
  // Read the live file. Missing / unreadable → treat as invalid → restore.
  let currentText;
  try {
    currentText = await fsReadFile(credentialsFile, "utf-8");
  } catch {
    currentText = null;
  }
  const isValid = typeof currentText === "string" && currentText.length > 0 && validator(currentText);
  if (isValid) {
    return { restored: false, reason: "valid" };
  }
  // Invalid: copy the backup back. Use the supplied `backupPath` even if it
  // doesn't currently exist — fs.copyFile will throw, and we map that to
  // `{ reason: "copy-failed" }` so the caller can distinguish "backup gone"
  // (acceptable on a fresh box where backupClaudeCredentials returned
  // `no existing file`) from a real IO error.
  try {
    await fsCopyFile(backupPath, credentialsFile);
  } catch (e) {
    return {
      restored: false,
      reason: "copy-failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  return { restored: true, from: backupPath, to: credentialsFile };
}
