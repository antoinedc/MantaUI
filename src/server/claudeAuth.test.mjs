import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCredentials,
  isRefreshTokenExpired,
  classifyRefreshOutcome,
  isClaudeCredentialError,
  shouldAttemptRecovery,
  shouldRefreshAhead,
  extractClaudeAuthUrl,
  classifyClaudeLoginProgress,
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

// ===== extractClaudeAuthUrl (BET-354) =====

test("extractClaudeAuthUrl: extracts the live OAuth URL from a verbatim stdout chunk", () => {
  // Verbatim capture from the BET-352 POC's pane. The URL is one logical
  // line; the visible wrap is a renderer artifact.
  const chunk = [
    "Opening browser to sign in…",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&code_challenge=1E6xfP1krrHacUqxrGCQx_u0jjEPN6VRwJCqih7BDok&code_challenge_method=S256&state=BCqkklUE391xOA5X8Z900durI9Rr9a3Bf2lkMS2c4HA",
    "Paste code here if prompted > ",
  ].join("\n");
  const url = extractClaudeAuthUrl(chunk);
  assert.ok(url);
  assert.ok(url.startsWith("https://claude.com/cai/oauth/authorize?"));
  assert.ok(url.includes("client_id="));
  assert.ok(url.includes("state=BCqkklUE391xOA5X8Z900durI9Rr9a3Bf2lkMS2c4HA"));
});

test("extractClaudeAuthUrl: ignores the first-launch trust prompt's docs URL", () => {
  // The trust prompt's "Security guide" link is the trap: a "first
  // https://" filter picks this and never updates. Filter on URL SHAPE,
  // not on byte order.
  const chunk = [
    "Quick safety check: Is this a project you created or one you trust?",
    "  1. Yes, I trust this project",
    "  2. No, exit",
    "Read our security guide: https://docs.claude.com/en/docs/claude-code-security",
    "Paste code here if prompted > ",
  ].join("\n");
  assert.equal(extractClaudeAuthUrl(chunk), null);
});

test("extractClaudeAuthUrl: still finds the OAuth URL after a docs URL in the same chunk", () => {
  // A log that contains BOTH the docs link AND the OAuth URL — make sure
  // the docs link doesn't shadow the real one.
  const chunk = [
    "Read our security guide: https://docs.claude.com/en/docs/claude-code-security",
    "Opening browser to sign in…",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&state=BCqkklUE391xOA5X8Z900durI9Rr9a3Bf2lkMS2c4HA",
    "Paste code here if prompted > ",
  ].join("\n");
  const url = extractClaudeAuthUrl(chunk);
  assert.ok(url);
  assert.ok(url.startsWith("https://claude.com/cai/oauth/authorize?"));
  assert.ok(!url.startsWith("https://docs.claude.com/"));
});

test("extractClaudeAuthUrl: strips trailing punctuation that survives a parenthesised wrap", () => {
  // Some TUI terminals wrap long URLs in parens; the closing `)` bleeds into
  // the captured chunk. The URL extractor strips trailing `)].,;` defensively.
  const url = extractClaudeAuthUrl(
    "(see https://claude.com/cai/oauth/authorize?code=true&state=ABC)",
  );
  assert.equal(url, "https://claude.com/cai/oauth/authorize?code=true&state=ABC");
});

test("extractClaudeAuthUrl: returns null for empty / non-string input", () => {
  assert.equal(extractClaudeAuthUrl(""), null);
  assert.equal(extractClaudeAuthUrl(null), null);
  assert.equal(extractClaudeAuthUrl(undefined), null);
  assert.equal(extractClaudeAuthUrl(42), null);
});

test("extractClaudeAuthUrl: returns null when the chunk has no authorize URL", () => {
  assert.equal(extractClaudeAuthUrl("just some output without any url"), null);
  assert.equal(extractClaudeAuthUrl(""), null);
});

// ===== classifyClaudeLoginProgress (BET-354) =====

test("classifyClaudeLoginProgress: 'no-file' when the file is missing", () => {
  assert.equal(classifyClaudeLoginProgress({ mtimeMs: null }, 1000), "no-file");
  assert.equal(classifyClaudeLoginProgress(null, 1000), "no-file");
  assert.equal(classifyClaudeLoginProgress(undefined, 1000), "no-file");
});

test("classifyClaudeLoginProgress: 'completed' when the file was modified AT or AFTER startedAt", () => {
  // The credentials file appeared as a direct result of this connect flow.
  assert.equal(classifyClaudeLoginProgress({ mtimeMs: 2000 }, 1000), "completed");
  // Equal mtime counts as completed — `>=`, not `>` (some filesystems
  // round to second granularity, an OAuth completion and the startedAt
  // call landing in the same tick would otherwise miss).
  assert.equal(classifyClaudeLoginProgress({ mtimeMs: 1000 }, 1000), "completed");
});

test("classifyClaudeLoginProgress: 'pre-existing' when the file was last modified BEFORE startedAt", () => {
  // The user already had a working login before this card mounted.
  assert.equal(classifyClaudeLoginProgress({ mtimeMs: 500 }, 1000), "pre-existing");
});

test("classifyClaudeLoginProgress: treats a non-finite startedAt as 'no-file'", () => {
  // Defensive: a card that mounted without a clock (SSR, tests) cannot
  // decide what "pre-existing" means, so it falls through to the
  // "still authenticating" branch instead of incorrectly claiming success.
  assert.equal(classifyClaudeLoginProgress({ mtimeMs: 2000 }, NaN), "no-file");
  assert.equal(classifyClaudeLoginProgress({ mtimeMs: 2000 }, Infinity), "no-file");
});
