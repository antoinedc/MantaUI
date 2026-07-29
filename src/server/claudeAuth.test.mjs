import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCredentials,
  isRefreshTokenExpired,
  classifyRefreshOutcome,
  isClaudeCredentialError,
  shouldAttemptRecovery,
  shouldRefreshAhead,
  extractClaudeAuthUrl,
  classifyClaudeLoginProgress,
  backupClaudeCredentials,
  restoreFromBackup,
  defaultCredentialsValidator,
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

// ===== backupClaudeCredentials + restoreFromBackup (BET-359, BET-367 §4) =====
//
// Both helpers do async IO against `~/.claude/.credentials.json`. Each test
// spins up a hermetic tmp HOME-style layout (mirrors opencodeRestart.test.mjs):
// the helper accepts `credentialsFile` and `now` as injected args, so we
// point it at a file inside `mkdtempSync(...)`. The real credentials path
// on this box is NEVER touched.

function setupFakeCredentialsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-auth-test-"));
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  const credsFile = path.join(dir, ".claude", ".credentials.json");
  return { dir, credsFile };
}

function teardownFakeHome(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test("backupClaudeCredentials: 'no existing file' when the credentials file is missing", async () => {
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    const r = await backupClaudeCredentials({ credentialsFile: credsFile, now: 1_700_000_000_000 });
    assert.equal(r.backedUp, false);
    assert.equal(r.reason, "no existing file");
  } finally {
    teardownFakeHome(dir);
  }
});

test("backupClaudeCredentials: copies the existing file to .bak.<unix-ts> and returns the path", async () => {
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    const original = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-at",
        refreshToken: "old-rt",
        expiresAt: 1,
        refreshTokenExpiresAt: 9_999_999_999_999,
      },
    });
    writeFileSync(credsFile, original);

    const now = 1_700_000_123_000; // 1700000123 seconds since epoch
    const r = await backupClaudeCredentials({ credentialsFile: credsFile, now });
    assert.equal(r.backedUp, true);
    assert.equal(r.backupPath, `${credsFile}.bak.${Math.floor(now / 1000)}`);
    // The backup file must byte-match the original — nothing trimmed,
    // nothing reinterpreted (the validator later parses the backup as
    // the original was parsed, so a round-trip through copyFile must be
    // transparent).
    assert.equal(readFileSync(r.backupPath, "utf-8"), original);
    // The original credentials file is unchanged.
    assert.equal(readFileSync(credsFile, "utf-8"), original);
  } finally {
    teardownFakeHome(dir);
  }
});

test("backupClaudeCredentials: a bad inputs short-circuit to 'no existing file' rather than throwing", async () => {
  // Defensive: the connect flow calls this helper inside an async try/catch
  // chain. A throw would be a programmer error (TypeError on a missing
  // argument); the helper's contract is "never throw", so bad inputs
  // surface as the no-op result instead. This is the simpler-honest
  // behaviour — the caller logs and proceeds, the same as if the file
  // genuinely didn't exist.
  assert.equal(
    (await backupClaudeCredentials({ credentialsFile: "", now: 1 })).reason,
    "no existing file",
  );
  assert.equal(
    (await backupClaudeCredentials({ credentialsFile: "/tmp/x", now: NaN })).reason,
    "no existing file",
  );
  assert.equal(
    (await backupClaudeCredentials({ credentialsFile: "/tmp/x", now: -1 })).reason,
    "no existing file",
  );
});

test("defaultCredentialsValidator: accepts a well-formed credentials blob, rejects empty / malformed", () => {
  const good = JSON.stringify({
    claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1, refreshTokenExpiresAt: 2 },
  });
  assert.equal(defaultCredentialsValidator(good), true);
  assert.equal(defaultCredentialsValidator(""), false);
  assert.equal(defaultCredentialsValidator("not json{"), false);
  assert.equal(defaultCredentialsValidator(JSON.stringify({ other: "field" })), false);
  assert.equal(defaultCredentialsValidator(JSON.stringify({ claudeAiOauth: "not an object" })), false);
});

test("restoreFromBackup: leaves the live file alone when the validator accepts it", async () => {
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    // Take a backup first so backupPath exists.
    const original = JSON.stringify({
      claudeAiOauth: {
        accessToken: "OLD",
        refreshToken: "OLD_RT",
        expiresAt: 1,
        refreshTokenExpiresAt: 9_999_999_999_999,
      },
    });
    writeFileSync(credsFile, original);
    const backup = await backupClaudeCredentials({ credentialsFile: credsFile, now: 1_700_000_000_000 });
    assert.equal(backup.backedUp, true);

    // Now simulate a successful OAuth write — replace the live file with
    // a different (valid) blob. The validator should accept it and the
    // backup must NOT be copied over.
    const next = JSON.stringify({
      claudeAiOauth: {
        accessToken: "NEW",
        refreshToken: "NEW_RT",
        expiresAt: 9_999_999_999_999,
        refreshTokenExpiresAt: 9_999_999_999_999,
      },
    });
    writeFileSync(credsFile, next);

    const r = await restoreFromBackup({
      credentialsFile: credsFile,
      backupPath: backup.backupPath,
      validator: defaultCredentialsValidator,
    });
    assert.equal(r.restored, false);
    assert.equal(r.reason, "valid");
    // Live file is the new (successful) write, not the backup.
    assert.equal(readFileSync(credsFile, "utf-8"), next);
  } finally {
    teardownFakeHome(dir);
  }
});

test("restoreFromBackup: rolls back to the backup when the live file is malformed", async () => {
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    // Pre-state: take a snapshot of v1 credentials.
    const v1 = JSON.stringify({
      claudeAiOauth: {
        accessToken: "OLD_AT",
        refreshToken: "OLD_RT",
        expiresAt: 1,
        refreshTokenExpiresAt: 9_999_999_999_999,
      },
    });
    writeFileSync(credsFile, v1);
    const backup = await backupClaudeCredentials({ credentialsFile: credsFile, now: 1_700_000_000_000 });
    assert.equal(backup.backedUp, true);

    // Simulate a half-broken `claude auth login` write: the file is now
    // truncated / empty. (This is the BET-359 hazard: a destructive
    // overwrite that leaves an unusable file behind.)
    writeFileSync(credsFile, "");

    const r = await restoreFromBackup({
      credentialsFile: credsFile,
      backupPath: backup.backupPath,
      validator: defaultCredentialsValidator,
    });
    assert.equal(r.restored, true);
    assert.equal(r.from, backup.backupPath);
    assert.equal(r.to, credsFile);
    // The live file is byte-for-byte the backup (v1) — every running
    // session's cached snapshot is still valid because we didn't
    // touch the underlying file in a way that invalidates their
    // captured state. (opencode itself only re-reads on restart, which
    // is what pollClaudeLogin does after the restore.)
    assert.equal(readFileSync(credsFile, "utf-8"), v1);
  } finally {
    teardownFakeHome(dir);
  }
});

test("restoreFromBackup: rolls back when the live file has unparseable JSON", async () => {
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    const v1 = JSON.stringify({ claudeAiOauth: { accessToken: "OLD" } });
    writeFileSync(credsFile, v1);
    const backup = await backupClaudeCredentials({ credentialsFile: credsFile, now: 1_700_000_000_000 });

    // OAuth wrote something that LOOKS like JSON but isn't valid — the
    // most realistic "CLI got SIGKILLed mid-write" outcome.
    writeFileSync(credsFile, '{"claudeAiOauth": ');

    const r = await restoreFromBackup({
      credentialsFile: credsFile,
      backupPath: backup.backupPath,
      validator: defaultCredentialsValidator,
    });
    assert.equal(r.restored, true);
    assert.equal(readFileSync(credsFile, "utf-8"), v1);
  } finally {
    teardownFakeHome(dir);
  }
});

test("restoreFromBackup: rolls back when the live file is missing entirely (mid-write crash)", async () => {
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    const v1 = JSON.stringify({ claudeAiOauth: { accessToken: "OLD" } });
    writeFileSync(credsFile, v1);
    const backup = await backupClaudeCredentials({ credentialsFile: credsFile, now: 1_700_000_000_000 });

    // Simulate the file being unlinked by the broken OAuth flow.
    rmSync(credsFile);

    const r = await restoreFromBackup({
      credentialsFile: credsFile,
      backupPath: backup.backupPath,
      validator: defaultCredentialsValidator,
    });
    assert.equal(r.restored, true);
    assert.equal(readFileSync(credsFile, "utf-8"), v1);
  } finally {
    teardownFakeHome(dir);
  }
});

test("restoreFromBackup: 'no-backup' is a correct no-op when backupPath was never set (fresh box)", async () => {
  // The user had no credentials file at startClaudeLogin time, so
  // backupClaudeCredentials returned `no existing file` and
  // startClaudeLogin stored backupPath=null on the session entry.
  // pollClaudeLogin still calls restoreFromBackup with backupPath=null;
  // the helper must NOT throw, must NOT pretend to restore, and must
  // surface the reason so the connect flow can distinguish "nothing to
  // restore" from "restore failed".
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    // Fresh-box state: no backup, but the new OAuth write DID succeed.
    const next = JSON.stringify({ claudeAiOauth: { accessToken: "NEW" } });
    writeFileSync(credsFile, next);

    const r = await restoreFromBackup({
      credentialsFile: credsFile,
      backupPath: null,
      validator: defaultCredentialsValidator,
    });
    assert.equal(r.restored, false);
    assert.equal(r.reason, "no-backup");
    // Live file is unchanged.
    assert.equal(readFileSync(credsFile, "utf-8"), next);
  } finally {
    teardownFakeHome(dir);
  }
});

test("restoreFromBackup: a missing validator function surfaces as 'copy-failed' (never throws)", async () => {
  // Defensive: the helper's contract is "never throws", so a programmer
  // error (passing the wrong shape for `validator`) must surface as a
  // structured result the caller can route into the UI rather than
  // propagate as an uncaught exception.
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    const r = await restoreFromBackup({
      credentialsFile: credsFile,
      backupPath: "/tmp/whatever.bak.123",
      validator: null,
    });
    assert.equal(r.restored, false);
    assert.equal(r.reason, "copy-failed");
    assert.match(r.error, /validator/);
  } finally {
    teardownFakeHome(dir);
  }
});

test("backup + restore round-trip: backup copy → fresh write → restore returns to v1 byte-for-byte", async () => {
  // Belt-and-braces integration check: cover the exact sequence the
  // connect flow executes when a successful OAuth follows a real
  // pre-existing login. Confirms no surprise re-encoding or path
  // mangling across the helper boundary.
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    const v1 = JSON.stringify({
      claudeAiOauth: {
        accessToken: "OLD_AT",
        refreshToken: "OLD_RT",
        expiresAt: 1,
        refreshTokenExpiresAt: 9_999_999_999_999,
      },
    });
    writeFileSync(credsFile, v1);

    const backup = await backupClaudeCredentials({ credentialsFile: credsFile, now: 1_700_000_000_000 });
    assert.equal(backup.backedUp, true);

    // Simulate a corrupt OAuth write that the validator rejects.
    writeFileSync(credsFile, "definitely not json");

    const r = await restoreFromBackup({
      credentialsFile: credsFile,
      backupPath: backup.backupPath,
      validator: defaultCredentialsValidator,
    });
    assert.equal(r.restored, true);
    assert.equal(readFileSync(credsFile, "utf-8"), v1);
  } finally {
    teardownFakeHome(dir);
  }
});

test("backupClaudeCredentials: a same-second retry overwrites the earlier backup (simpler-honest behaviour)", async () => {
  // The backup naming uses seconds granularity. Two startClaudeLogin
  // calls inside the same wall-clock second land on the same backup
  // path; the second copyFile overwrites the first. This is
  // intentional — the issue spec says "simplest honest path", and a
  // backup that survives a same-second second attempt would need
  // collision-avoidance logic that the issue doesn't ask for. Pin the
  // behaviour here so a future "let's add a random suffix" change is
  // an explicit decision, not a silent drift.
  const { dir, credsFile } = setupFakeCredentialsDir();
  try {
    writeFileSync(credsFile, "v1");
    const t = 1_700_000_000_000;
    const r1 = await backupClaudeCredentials({ credentialsFile: credsFile, now: t });
    assert.equal(r1.backedUp, true);
    // Overwrite the live file, then take a second backup at the same
    // wall-clock second. The second backup MUST land at the same path.
    writeFileSync(credsFile, "v2");
    const r2 = await backupClaudeCredentials({ credentialsFile: credsFile, now: t });
    assert.equal(r2.backedUp, true);
    assert.equal(r2.backupPath, r1.backupPath);
    assert.equal(readFileSync(r2.backupPath, "utf-8"), "v2");
  } finally {
    teardownFakeHome(dir);
  }
});
