// Credential safety for the LIVE Claude Max e2e (test:opencode-v2:max).
//
// The user's real Claude login must never be exposed or rotated by a test:
//   - only `accessToken` + `expiresAt` (+ `subscriptionType`, `scopes`) are ever
//     copied — NEVER the refresh token (so nothing in the sandbox can rotate it)
//   - the copy lives inside the sandbox temp dir, mode 0600, and is removed on
//     EVERY exit path: normal end, failure, process exit, SIGINT, SIGTERM
//   - the run aborts when the token expires within 20 minutes
//   - token values are never printed; `sha12` is the only fingerprint allowed
// The source files are only ever READ.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MIN_TOKEN_LIFE_MS = 20 * 60_000;

/** First 12 hex chars of sha256(token) — the only fingerprint that may be logged. */
export const sha12 = (token) => createHash("sha256").update(String(token)).digest("hex").slice(0, 12);

/** The user's single Claude login file. */
export const liveCredentialsPath = () => join(homedir(), ".claude", ".credentials.json");

/** `~/.manta-secrets/accounts/claude/<seat>/.credentials.json` */
export const seatCredentialsPath = (seat) => join(homedir(), ".manta-secrets", "accounts", "claude", seat, ".credentials.json");

/**
 * Pure: the access-token-only credential object for a parsed Claude credentials
 * file. Throws (never returns a partial) when the token is missing or expires in
 * under `minLifeMs`. The refresh token is not copied, by construction.
 */
export function stripToAccessOnly(parsed, { now = Date.now(), minLifeMs = MIN_TOKEN_LIFE_MS } = {}) {
  const o = parsed?.claudeAiOauth;
  if (typeof o?.accessToken !== "string" || !o.accessToken) throw new Error("credentials have no access token");
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) throw new Error("credentials have no expiresAt");
  const left = o.expiresAt - now;
  if (left < minLifeMs) {
    throw new Error(`access token expires in ${Math.round(left / 60_000)} min (< ${minLifeMs / 60_000} min floor) — refusing to run`);
  }
  const out = { accessToken: o.accessToken, expiresAt: o.expiresAt };
  if (typeof o.subscriptionType === "string") out.subscriptionType = o.subscriptionType;
  if (Array.isArray(o.scopes)) out.scopes = [...o.scopes];
  return { claudeAiOauth: out };
}

/** Read `source` (read-only) and return the stripped object. */
export function readAccessOnly(source, opts) {
  return stripToAccessOnly(JSON.parse(readFileSync(source, "utf8")), opts);
}

/**
 * Tracks everything that must not survive the run and removes it synchronously
 * on exit / SIGINT / SIGTERM. `add(path)` BEFORE writing the file, so a crash
 * between create and register cannot leak it.
 */
export function createCleanupGuard() {
  const paths = new Set();
  let installed = false;
  const run = () => {
    for (const p of paths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* best effort — reported by the verification step */
      }
    }
    paths.clear();
  };
  const onSignal = (sig) => () => {
    run();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  const handlers = { SIGINT: onSignal("SIGINT"), SIGTERM: onSignal("SIGTERM") };
  return {
    add(path) {
      paths.add(path);
      if (!installed) {
        installed = true;
        process.on("exit", run);
        for (const [sig, h] of Object.entries(handlers)) process.on(sig, h);
      }
    },
    /** Remove everything now (idempotent). */
    run,
    paths: () => [...paths],
  };
}

/** Write a credentials object at `path` (0600), registering it with `guard` first. */
export function writeCredentialsFile(guard, path, creds) {
  guard.add(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(creds), { mode: 0o600 });
  chmodSync(path, 0o600);
}
