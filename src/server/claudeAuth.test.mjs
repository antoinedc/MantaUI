import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCredentials,
  isRefreshTokenExpired,
  classifyRefreshOutcome,
  isClaudeCredentialError,
  shouldAttemptRecovery,
  shouldRefreshAhead,
} from "./claudeAuth.mjs";

// ===== parseCredentials =====

test("parseCredentials extracts claudeAiOauth fields from a valid blob", () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1000,
      refreshTokenExpiresAt: 2000,
    },
  });
  assert.deepEqual(parseCredentials(raw), {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: 1000,
    refreshTokenExpiresAt: 2000,
  });
});

test("parseCredentials returns null when claudeAiOauth is missing", () => {
  assert.equal(parseCredentials(JSON.stringify({ other: "field" })), null);
});

test("parseCredentials returns null for invalid JSON", () => {
  assert.equal(parseCredentials("not json{"), null);
});

// ===== isRefreshTokenExpired =====

test("isRefreshTokenExpired: true when refreshTokenExpiresAt is in the past", () => {
  assert.equal(isRefreshTokenExpired({ refreshTokenExpiresAt: 1000 }, 2000), true);
});

test("isRefreshTokenExpired: false when refreshTokenExpiresAt is in the future", () => {
  assert.equal(isRefreshTokenExpired({ refreshTokenExpiresAt: 3000 }, 2000), false);
});

test("isRefreshTokenExpired: false when the field is missing (assume still valid)", () => {
  assert.equal(isRefreshTokenExpired({}, 2000), false);
});

// ===== classifyRefreshOutcome =====

test("classifyRefreshOutcome: no-credentials when credsBefore is null", () => {
  assert.equal(
    classifyRefreshOutcome({ credsBefore: null, credsAfter: null, now: 1000 }),
    "no-credentials",
  );
});

test("classifyRefreshOutcome: refresh-token-expired when the refresh token itself expired", () => {
  const credsBefore = { expiresAt: 500, refreshTokenExpiresAt: 900 };
  assert.equal(
    classifyRefreshOutcome({ credsBefore, credsAfter: null, now: 1000 }),
    "refresh-token-expired",
  );
});

test("classifyRefreshOutcome: ok when the token advanced past now + 60s", () => {
  const now = 1_000_000;
  const credsBefore = { expiresAt: 500, refreshTokenExpiresAt: now + 10_000_000 };
  const credsAfter = { expiresAt: now + 61_000, refreshTokenExpiresAt: now + 10_000_000 };
  assert.equal(classifyRefreshOutcome({ credsBefore, credsAfter, now }), "ok");
});

test("classifyRefreshOutcome: failed when the token did not advance (same/no progress)", () => {
  const now = 1_000_000;
  const credsBefore = { expiresAt: 500, refreshTokenExpiresAt: now + 10_000_000 };
  // credsAfter identical to before — refresh ran but nothing changed.
  const credsAfter = { expiresAt: 500, refreshTokenExpiresAt: now + 10_000_000 };
  assert.equal(classifyRefreshOutcome({ credsBefore, credsAfter, now }), "failed");
});

test("classifyRefreshOutcome: failed when credsAfter is null (file unreadable post-refresh)", () => {
  const now = 1_000_000;
  const credsBefore = { expiresAt: 500, refreshTokenExpiresAt: now + 10_000_000 };
  assert.equal(
    classifyRefreshOutcome({ credsBefore, credsAfter: null, now }),
    "failed",
  );
});

// ===== isClaudeCredentialError (BET-280) =====

test("isClaudeCredentialError: true for the live UnknownError payload from opencode-claude-auth", () => {
  // Captured live from the box's opencode API (BET-280 context): the plugin
  // throws a plain Error and opencode wraps it as UnknownError. The shape is
  // exact; the message wording may drift upstream and this test should still
  // match as long as all three substrings remain.
  assert.equal(
    isClaudeCredentialError({
      name: "UnknownError",
      data: {
        message: "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
      },
    }),
    true,
  );
});

test("isClaudeCredentialError: true when name is ProviderAuthError (forward compatibility)", () => {
  assert.equal(isClaudeCredentialError({ name: "ProviderAuthError" }), true);
  // Even with no data.message at all, the name alone is enough.
  assert.equal(isClaudeCredentialError({ name: "ProviderAuthError" }), true);
});

test("isClaudeCredentialError: false for unrelated error names with similar messages", () => {
  assert.equal(
    isClaudeCredentialError({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    }),
    false,
  );
  assert.equal(
    isClaudeCredentialError({
      name: "UnknownError",
      data: { message: "Something else failed" },
    }),
    false,
  );
});

test("isClaudeCredentialError: false for null / undefined / empty object / non-objects", () => {
  assert.equal(isClaudeCredentialError(null), false);
  assert.equal(isClaudeCredentialError(undefined), false);
  assert.equal(isClaudeCredentialError({}), false);
  assert.equal(isClaudeCredentialError("ProviderAuthError"), false);
  assert.equal(isClaudeCredentialError(42), false);
});

// ===== shouldAttemptRecovery (BET-280) =====

test("shouldAttemptRecovery: true when lastAttemptAt is null/undefined (never tried)", () => {
  assert.equal(shouldAttemptRecovery(null, 1_000_000), true);
  assert.equal(shouldAttemptRecovery(undefined, 1_000_000), true);
});

test("shouldAttemptRecovery: false when last attempt is within the cooldown window", () => {
  // 10s ago < 60_000 default cooldown.
  assert.equal(shouldAttemptRecovery(1_000_000 - 10_000, 1_000_000), false);
});

test("shouldAttemptRecovery: true when last attempt is older than the cooldown window", () => {
  // 90s ago > 60_000 default cooldown.
  assert.equal(shouldAttemptRecovery(1_000_000 - 90_000, 1_000_000), true);
});

test("shouldAttemptRecovery: respects a custom cooldown", () => {
  // 30s ago, 20s cooldown → past cooldown → true.
  assert.equal(shouldAttemptRecovery(1_000_000 - 30_000, 1_000_000, 20_000), true);
  // 30s ago, 60s cooldown → within cooldown → false.
  assert.equal(shouldAttemptRecovery(1_000_000 - 30_000, 1_000_000, 60_000), false);
});

// ===== shouldRefreshAhead (BET-281) =====

test("shouldRefreshAhead: true when expiresAt is within the default 30 min lead", () => {
  // now=1_000_000, expiresAt=now+10min (600_000ms) — within 30min lead → true.
  const now = 1_000_000;
  assert.equal(
    shouldRefreshAhead({ expiresAt: now + 10 * 60_000, refreshTokenExpiresAt: now + 10_000_000 }, now),
    true,
  );
});

test("shouldRefreshAhead: true when expiresAt is already in the past", () => {
  // Already expired — clearly within the lead window — but the refresh token
  // is still valid so the CLI refresh can succeed.
  const now = 1_000_000;
  assert.equal(
    shouldRefreshAhead({ expiresAt: now - 60_000, refreshTokenExpiresAt: now + 10_000_000 }, now),
    true,
  );
});

test("shouldRefreshAhead: false when expiresAt is comfortably in the future (5h away)", () => {
  // 5h > 30min default lead → too early.
  const now = 1_000_000;
  assert.equal(
    shouldRefreshAhead({ expiresAt: now + 5 * 60 * 60_000, refreshTokenExpiresAt: now + 10_000_000 }, now),
    false,
  );
});

test("shouldRefreshAhead: false when refreshTokenExpiresAt is in the past", () => {
  // Within the lead window BUT the refresh token is dead → CLI refresh can't
  // succeed, the reactive path / `claude auth login` is the only fix.
  const now = 1_000_000;
  assert.equal(
    shouldRefreshAhead({ expiresAt: now + 5 * 60_000, refreshTokenExpiresAt: now - 1000 }, now),
    false,
  );
});

test("shouldRefreshAhead: false for null / undefined creds", () => {
  assert.equal(shouldRefreshAhead(null, 1_000_000), false);
  assert.equal(shouldRefreshAhead(undefined, 1_000_000), false);
});

test("shouldRefreshAhead: false when creds has no expiresAt (we have no clock to read)", () => {
  // Defensive: without expiresAt we can't decide ahead-of-time. The reactive
  // path (isClaudeCredentialError) still applies.
  assert.equal(shouldRefreshAhead({}, 1_000_000), false);
  // expiresAt non-number (string from a corrupt file) → also no.
  assert.equal(shouldRefreshAhead({ expiresAt: "soon" }, 1_000_000), false);
});

test("shouldRefreshAhead: respects a custom leadMs", () => {
  const now = 1_000_000;
  // expiresAt 2h out, lead 1h → 2h > 1h, too early.
  assert.equal(
    shouldRefreshAhead({ expiresAt: now + 2 * 60 * 60_000, refreshTokenExpiresAt: now + 10_000_000 }, now, 60 * 60_000),
    false,
  );
  // Same creds, lead 3h → within window.
  assert.equal(
    shouldRefreshAhead({ expiresAt: now + 2 * 60 * 60_000, refreshTokenExpiresAt: now + 10_000_000 }, now, 3 * 60 * 60_000),
    true,
  );
});
