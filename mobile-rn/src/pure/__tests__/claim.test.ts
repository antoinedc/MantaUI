// claim.test.ts — pure pairing-outcome classification (ported classifyClaimResult):
// ok / bad code / expired / rate-limited / unreachable / malformed.

import { describe, expect, it } from "vitest";

import {
  classifyClaimResult,
  isSubmittableCode,
  isValidBoxToken,
  networkFailure,
  normalizeCode,
} from "../claim";

const VALID_TOKEN = "0123456789abcdef0123456789abcdef";
const VALID_ID = "fedcba9876543210fedcba9876543210";

describe("normalizeCode / isSubmittableCode", () => {
  it("strips non-digits and clamps to 6", () => {
    expect(normalizeCode(" 12-34 56 ")).toBe("123456");
    expect(normalizeCode("1234567")).toBe("123456");
    expect(normalizeCode("abc12")).toBe("12");
  });
  it("accepts exactly 6 digits", () => {
    expect(isSubmittableCode("123456")).toBe(true);
    expect(isSubmittableCode("12345")).toBe(false);
    expect(isSubmittableCode("1234567")).toBe(false);
    expect(isSubmittableCode("12345a")).toBe(false);
  });
});

describe("isValidBoxToken", () => {
  it("accepts 32-hex, rejects everything else", () => {
    expect(isValidBoxToken(VALID_TOKEN)).toBe(true);
    expect(isValidBoxToken("ABCDEF0123456789abcdef0123456789")).toBe(false); // uppercase
    expect(isValidBoxToken("0123456789abcdef0123456789abcde")).toBe(false); // 31
    expect(isValidBoxToken("0123456789abcdef0123456789abcdeff")).toBe(false); // 33
    expect(isValidBoxToken(123)).toBe(false);
    expect(isValidBoxToken(null)).toBe(false);
  });
});

describe("classifyClaimResult", () => {
  it("200 with valid body → ok, carries both fields", () => {
    const r = classifyClaimResult(200, { box_token: VALID_TOKEN, box_id: VALID_ID });
    expect(r).toEqual({ ok: true, boxToken: VALID_TOKEN, boxId: VALID_ID });
  });

  it("200 with malformed body → invalid_response (never persists a bad token)", () => {
    for (const body of [
      null,
      42,
      "nope",
      {},
      { box_token: VALID_TOKEN }, // missing box_id
      { box_token: "short", box_id: VALID_ID }, // bad token
      { box_token: VALID_TOKEN, box_id: "ABC" }, // bad id
    ]) {
      const r = classifyClaimResult(200, body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("invalid_response");
    }
  });

  it("403 (wrong / expired / used code) → wrong_code", () => {
    const r = classifyClaimResult(403, { error: "bad" });
    expect(r).toMatchObject({ ok: false, kind: "wrong_code" });
  });

  it("400 (server-side shape reject) also collapses to wrong_code", () => {
    const r = classifyClaimResult(400, { error: "bad" });
    expect(r).toMatchObject({ ok: false, kind: "wrong_code" });
  });

  it("429 → rate_limited", () => {
    const r = classifyClaimResult(429, { error: "slow down" });
    expect(r).toMatchObject({ ok: false, kind: "rate_limited" });
  });

  it("5xx → server_error", () => {
    expect(classifyClaimResult(500, null)).toMatchObject({ kind: "server_error" });
    expect(classifyClaimResult(503, null)).toMatchObject({ kind: "server_error" });
  });

  it("unexpected status (401/404) → server_error, not wrong_code", () => {
    expect(classifyClaimResult(401, null)).toMatchObject({ kind: "server_error" });
    expect(classifyClaimResult(404, null)).toMatchObject({ kind: "server_error" });
  });

  it("every failure carries a non-empty message", () => {
    for (const status of [400, 403, 429, 500, 401]) {
      const r = classifyClaimResult(status, null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("networkFailure (unreachable box)", () => {
  it("maps a no-response fetch to network kind", () => {
    const r = networkFailure();
    expect(r).toMatchObject({ ok: false, kind: "network" });
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});
