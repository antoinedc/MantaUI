import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCredentials,
  isRefreshTokenExpired,
  classifyRefreshOutcome,
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
