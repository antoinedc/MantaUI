import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile, stat } from "node:fs/promises";
import {
  isValidToken,
  isValidPairingCode,
  tokenMatches,
  parseBearer,
  isExemptPath,
  isPublicAssetPath,
  loadAuth,
  saveAuth,
  ensureAuth,
  createPairingRegistry,
  createAuthEngine,
} from "./auth.mjs";

const HEX32 = "0123456789abcdef0123456789abcdef";
const HEX32B = "fedcba9876543210fedcba9876543210";

// ----------------------------------------------------------------------------
// isValidToken
// ----------------------------------------------------------------------------

test("isValidToken accepts 32 lowercase hex only", () => {
  assert.equal(isValidToken(HEX32), true);
  assert.equal(isValidToken("a".repeat(32)), true);
  assert.equal(isValidToken("A".repeat(32)), false); // uppercase
  assert.equal(isValidToken("a".repeat(31)), false); // short
  assert.equal(isValidToken("a".repeat(33)), false); // long
  assert.equal(isValidToken("../etc/passwd"), false);
  assert.equal(isValidToken(""), false);
  assert.equal(isValidToken(null), false);
  assert.equal(isValidToken(undefined), false);
});

// ----------------------------------------------------------------------------
// isValidPairingCode
// ----------------------------------------------------------------------------

test("isValidPairingCode accepts exactly 6 digits", () => {
  assert.equal(isValidPairingCode("000000"), true);
  assert.equal(isValidPairingCode("123456"), true);
  assert.equal(isValidPairingCode("12345"), false); // 5 digits
  assert.equal(isValidPairingCode("1234567"), false); // 7 digits
  assert.equal(isValidPairingCode(" 123456 "), false); // whitespace
  assert.equal(isValidPairingCode("12345a"), false); // non-digit
  assert.equal(isValidPairingCode(123456), false); // not a string
  assert.equal(isValidPairingCode(""), false);
});

// ----------------------------------------------------------------------------
// tokenMatches (constant-time)
// ----------------------------------------------------------------------------

test("tokenMatches only for exact equal valid tokens", () => {
  assert.equal(tokenMatches(HEX32, HEX32), true);
  assert.equal(tokenMatches(HEX32, HEX32B), false);
  assert.equal(tokenMatches(HEX32, "a".repeat(32)), false);
  assert.equal(tokenMatches(HEX32, "bad"), false); // invalid presented
  assert.equal(tokenMatches("bad", HEX32), false); // invalid expected
  assert.equal(tokenMatches(null, HEX32), false);
});

// ----------------------------------------------------------------------------
// parseBearer
// ----------------------------------------------------------------------------

test("parseBearer extracts token from Authorization header", () => {
  assert.equal(parseBearer(`Bearer ${HEX32}`), HEX32);
  assert.equal(parseBearer(`bearer ${HEX32}`), HEX32); // case-insensitive scheme
  assert.equal(parseBearer(`  Bearer   ${HEX32}  `), HEX32); // extra spaces
  assert.equal(parseBearer(HEX32), HEX32); // bare token accepted
  assert.equal(parseBearer(""), null);
  assert.equal(parseBearer(null), null);
  assert.equal(parseBearer(42), null);
});

// ----------------------------------------------------------------------------
// isExemptPath
// ----------------------------------------------------------------------------

test("isExemptPath exempts only /auth pairing + /hook delivery", () => {
  assert.equal(isExemptPath("/auth/pair"), true);
  assert.equal(isExemptPath("/auth/claim"), true);
  assert.equal(isExemptPath("/hook/deadbeef"), true);
  assert.equal(isExemptPath("/hook/"), true);
  // NOT exempt — these must be gated
  assert.equal(isExemptPath("/auth/status"), false);
  assert.equal(isExemptPath("/api/projects"), false);
  assert.equal(isExemptPath("/rpc/tmux"), false);
  assert.equal(isExemptPath("/events"), false);
  assert.equal(isExemptPath("/pty"), false);
  assert.equal(isExemptPath("/"), false);
  assert.equal(isExemptPath(null), false);
});

// ----------------------------------------------------------------------------
// isPublicAssetPath
// ----------------------------------------------------------------------------

test("isPublicAssetPath allows the SPA shell + PWA assets", () => {
  assert.equal(isPublicAssetPath("/"), true);
  assert.equal(isPublicAssetPath("/index.html"), true);
  assert.equal(isPublicAssetPath("/sw.js"), true);
  assert.equal(isPublicAssetPath("/favicon.ico"), true);
  assert.equal(isPublicAssetPath("/manifest.webmanifest"), true);
  assert.equal(isPublicAssetPath("/assets/index-abc123.js"), true);
  assert.equal(isPublicAssetPath("/icons/icon-192.png"), true);
  // data/control routes are NOT public assets
  assert.equal(isPublicAssetPath("/api/projects"), false);
  assert.equal(isPublicAssetPath("/rpc/tmux"), false);
  assert.equal(isPublicAssetPath("/events"), false);
  assert.equal(isPublicAssetPath(null), false);
});

// ----------------------------------------------------------------------------
// store: loadAuth / saveAuth / ensureAuth
// ----------------------------------------------------------------------------

function tmpPath(name) {
  return join(tmpdir(), `bui-auth-test-${process.pid}-${Date.now()}-${name}.json`);
}

test("loadAuth returns null for a missing file", () => {
  assert.equal(loadAuth(tmpPath("missing")), null);
});

test("saveAuth writes 0600 and loadAuth round-trips", async () => {
  const path = tmpPath("roundtrip");
  const auth = { box_id: HEX32, box_token: HEX32B, created_at: 123 };
  try {
    await saveAuth(auth, path);
    const st = await stat(path);
    // 0600 → owner rw only
    assert.equal(st.mode & 0o777, 0o600);
    const loaded = loadAuth(path);
    assert.deepEqual(loaded, auth);
  } finally {
    await rm(path, { force: true });
  }
});

test("loadAuth returns null on corrupt / invalid content", async () => {
  const path = tmpPath("corrupt");
  try {
    await saveAuth({ box_id: "not-hex", box_token: HEX32B }, path);
    assert.equal(loadAuth(path), null);
    await saveAuth({ box_id: HEX32 }, path); // missing token
    assert.equal(loadAuth(path), null);
  } finally {
    await rm(path, { force: true });
  }
});

test("ensureAuth generates + persists a fresh identity on first run, then is stable", async () => {
  const path = tmpPath("ensure");
  const load = () => loadAuth(path);
  const save = (a) => saveAuth(a, path);
  try {
    const first = await ensureAuth({ load, save, now: () => 42 });
    assert.equal(isValidToken(first.box_id), true);
    assert.equal(isValidToken(first.box_token), true);
    assert.equal(first.created_at, 42);
    // second call returns the SAME persisted identity (no regeneration)
    const second = await ensureAuth({ load, save });
    assert.deepEqual(second, first);
    // file actually exists on disk
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    assert.equal(onDisk.box_id, first.box_id);
  } finally {
    await rm(path, { force: true });
  }
});

// ----------------------------------------------------------------------------
// pairing registry
// ----------------------------------------------------------------------------

test("pairing registry issues a 6-digit code and consumes it once", () => {
  const reg = createPairingRegistry();
  const { code } = reg.issue();
  assert.equal(isValidPairingCode(code), true);
  assert.equal(reg.hasActive(), true);
  assert.equal(reg.consume(code), true); // first consume ok
  assert.equal(reg.consume(code), false); // reuse rejected
  assert.equal(reg.hasActive(), false);
});

test("pairing registry rejects wrong / invalid codes", () => {
  const reg = createPairingRegistry();
  const { code } = reg.issue();
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal(reg.consume(wrong), false);
  assert.equal(reg.consume("bad"), false);
  assert.equal(reg.consume(null), false);
  // the real code still works — a wrong guess doesn't burn it
  assert.equal(reg.consume(code), true);
});

test("pairing registry expires codes after TTL", () => {
  let t = 1000;
  const reg = createPairingRegistry({ ttlMs: 500, now: () => t });
  const { code } = reg.issue();
  t = 1400; // within TTL
  assert.equal(reg.hasActive(), true);
  t = 1600; // past TTL
  assert.equal(reg.hasActive(), false);
  assert.equal(reg.consume(code), false);
});

test("issuing a new code supersedes the prior one", () => {
  const reg = createPairingRegistry();
  const first = reg.issue().code;
  const second = reg.issue().code;
  // first is invalidated even if it happened to differ
  if (first !== second) assert.equal(reg.consume(first), false);
  assert.equal(reg.consume(second), true);
});

// ----------------------------------------------------------------------------
// auth engine — authorize gate
// ----------------------------------------------------------------------------

const AUTH = { box_id: HEX32, box_token: HEX32B, created_at: 0 };

test("createAuthEngine requires a valid identity", () => {
  assert.throws(() => createAuthEngine({ auth: null }));
  assert.throws(() => createAuthEngine({ auth: { box_id: "bad", box_token: HEX32 } }));
});

test("authorize gates data routes without a valid token", () => {
  const eng = createAuthEngine({ auth: AUTH });
  // no token → 401
  let r = eng.authorize({ method: "GET", path: "/api/projects", authorization: "" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  // wrong token → 401
  r = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${HEX32}`,
  });
  assert.equal(r.ok, false);
  // correct token → ok
  r = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${AUTH.box_token}`,
  });
  assert.equal(r.ok, true);
});

test("authorize allows exempt + preflight + public-asset paths without a token", () => {
  const eng = createAuthEngine({ auth: AUTH });
  assert.equal(eng.authorize({ method: "OPTIONS", path: "/api/projects" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/auth/pair" }).ok, true);
  assert.equal(eng.authorize({ method: "POST", path: "/auth/claim" }).ok, true);
  assert.equal(eng.authorize({ method: "POST", path: "/hook/abcd" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/assets/x.js" }).ok, true);
  // /auth/status is NOT exempt → gated
  assert.equal(eng.authorize({ method: "GET", path: "/auth/status" }).ok, false);
  // a POST to an asset-looking path is still gated (assets are GET-only)
  assert.equal(eng.authorize({ method: "POST", path: "/assets/x.js" }).ok, false);
});

test("authorize allows everything when enforcement is disabled", () => {
  const eng = createAuthEngine({ auth: AUTH, enforce: false });
  assert.equal(eng.authorize({ method: "GET", path: "/api/projects", authorization: "" }).ok, true);
  assert.equal(eng.authorize({ method: "POST", path: "/rpc/tmux", authorization: "" }).ok, true);
});

// ----------------------------------------------------------------------------
// auth engine — pair / claim handshake
// ----------------------------------------------------------------------------

test("pair mints a code + box_id; claim exchanges a valid code for the token", () => {
  const eng = createAuthEngine({ auth: AUTH });
  const p = eng.pair();
  assert.equal(p.ok, true);
  assert.equal(isValidPairingCode(p.pairing_code), true);
  assert.equal(p.box_id, AUTH.box_id);

  const c = eng.claim({ pairing_code: p.pairing_code });
  assert.equal(c.ok, true);
  assert.equal(c.box_token, AUTH.box_token);
  assert.equal(c.box_id, AUTH.box_id);
});

test("claim is one-time and rejects reused / wrong / malformed codes", () => {
  const eng = createAuthEngine({ auth: AUTH });
  const { pairing_code } = eng.pair();

  // reused code → 403
  eng.claim({ pairing_code });
  const reused = eng.claim({ pairing_code });
  assert.equal(reused.ok, false);
  assert.equal(reused.status, 403);

  // malformed code → 400
  const bad = eng.claim({ pairing_code: "abc" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);

  // wrong (valid-shape) code → 403
  eng.pair();
  const wrong = eng.claim({ pairing_code: "999999" });
  // could be right by 1-in-1e6 chance; assert only the shape of a rejection path
  if (!wrong.ok) assert.equal(wrong.status, 403);
});

test("claim rejects an expired code", () => {
  let t = 0;
  const eng = createAuthEngine({ auth: AUTH, ttlMs: 100, now: () => t });
  const { pairing_code } = eng.pair();
  t = 200; // past TTL
  const r = eng.claim({ pairing_code });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});
