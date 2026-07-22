// Tests for pairPage.mjs pure logic — no live HTTP, no real QR PNG.
// Run via `npm run test:server` (node:test).
//
// Mirror style of src/server/servePage.test.mjs: pure-logic only, asserting
// shape and validation; the actual rendering + serving happens in index.mjs
// (covered by the curl smoke checks at the end of BET-239).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEX32_RE,
  CODE_RE,
  validatePairQrQuery,
  renderPairQr,
  readPairAsset,
} from "./pairPage.mjs";

const HEX32 = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// HEX32_RE / CODE_RE
// ---------------------------------------------------------------------------

test("HEX32_RE accepts 32 lowercase hex only", () => {
  assert.equal(HEX32_RE.test(HEX32), true);
  assert.equal(HEX32_RE.test("a".repeat(32)), true);
  assert.equal(HEX32_RE.test("A".repeat(32)), false); // uppercase rejected
  assert.equal(HEX32_RE.test("a".repeat(31)), false);
  assert.equal(HEX32_RE.test("a".repeat(33)), false);
});

test("CODE_RE accepts exactly 6 digits", () => {
  assert.equal(CODE_RE.test("000000"), true);
  assert.equal(CODE_RE.test("847291"), true);
  assert.equal(CODE_RE.test("12345"), false);
  assert.equal(CODE_RE.test("1234567"), false);
  assert.equal(CODE_RE.test("abcdef"), false);
});

// ---------------------------------------------------------------------------
// validatePairQrQuery
// ---------------------------------------------------------------------------

test("validatePairQrQuery returns ok + the canonical payload for valid input", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "847291" });
  assert.equal(r.ok, true);
  assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
});

test("validatePairQrQuery lowercases the box before validating", () => {
  // Hostnames arrive case-insensitive — uppercase hex MUST be accepted.
  const r = validatePairQrQuery({
    box: "0123456789ABCDEF0123456789ABCDEF",
    code: "847291",
  });
  assert.equal(r.ok, true);
  assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
});

test("validatePairQrQuery trims surrounding whitespace", () => {
  const r = validatePairQrQuery({ box: `  ${HEX32}  `, code: " 847291 " });
  assert.equal(r.ok, true);
  assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
});

test("validatePairQrQuery rejects a 31-hex box", () => {
  const r = validatePairQrQuery({ box: HEX32.slice(0, 31), code: "847291" });
  assert.equal(r.ok, false);
  assert.match(r.error, /32-char lowercase hex/);
});

test("validatePairQrQuery rejects a non-hex box", () => {
  const r = validatePairQrQuery({ box: "not-hex-not-hex-not-hex-not-he", code: "847291" });
  assert.equal(r.ok, false);
  assert.match(r.error, /32-char lowercase hex/);
});

test("validatePairQrQuery rejects a 5-digit code", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "12345" });
  assert.equal(r.ok, false);
  assert.match(r.error, /exactly 6 digits/);
});

test("validatePairQrQuery rejects a 7-digit code", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "1234567" });
  assert.equal(r.ok, false);
  assert.match(r.error, /exactly 6 digits/);
});

test("validatePairQrQuery rejects a non-numeric code", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "abcdef" });
  assert.equal(r.ok, false);
  assert.match(r.error, /exactly 6 digits/);
});

test("validatePairQrQuery rejects missing fields", () => {
  assert.equal(validatePairQrQuery({ code: "847291" }).ok, false);
  assert.equal(validatePairQrQuery({ box: HEX32 }).ok, false);
  assert.equal(validatePairQrQuery({}).ok, false);
  assert.equal(validatePairQrQuery(null).ok, false);
});

test("validatePairQrQuery rejects non-string fields", () => {
  assert.equal(validatePairQrQuery({ box: 123, code: "847291" }).ok, false);
  assert.equal(validatePairQrQuery({ box: HEX32, code: 847291 }).ok, false);
});

// ---------------------------------------------------------------------------
// renderPairQr — produces a valid PNG buffer
// ---------------------------------------------------------------------------

test("renderPairQr returns a Buffer with the PNG magic header", async () => {
  const png = await renderPairQr(`manta://pair?box=${HEX32}&code=847291`);
  assert.ok(Buffer.isBuffer(png), "renderPairQr must return a Buffer");
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(
    png.subarray(0, 8).equals(expected),
    "first 8 bytes must match the PNG magic signature",
  );
  // Sanity: a 360×360 QR with margin:1 is comfortably above the minimum PNG
  // size (the PNG signature + IHDR + at least one IDAT chunk). We just guard
  // against an empty buffer, not the exact pixel count.
  assert.ok(png.length > 100, "PNG buffer should be non-trivial");
});

// ---------------------------------------------------------------------------
// readPairAsset — pair.html / pair-logo.png exist next to this module
// ---------------------------------------------------------------------------

test("readPairAsset returns pair.html bytes from disk", () => {
  const buf = readPairAsset("pair.html");
  assert.ok(Buffer.isBuffer(buf));
  const head = buf.subarray(0, 64).toString("utf-8");
  assert.match(head, /^<!DOCTYPE html>/i);
  // "MantaUI" appears in the <title> later in the file — sample beyond the head.
  const tail = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf-8");
  assert.match(tail, /MantaUI/);
});

test("readPairAsset returns pair-logo.png bytes (PNG magic)", () => {
  const buf = readPairAsset("pair-logo.png");
  assert.ok(Buffer.isBuffer(buf));
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(expected));
  assert.ok(buf.length > 100, "logo PNG should be non-trivial");
});
