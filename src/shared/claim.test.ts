import { describe, it, expect } from "vitest";
import {
  normalizeCode,
  isSubmittableCode,
  classifyClaimResult,
  classifyRelayClaimResult,
  networkFailure,
} from "./claim.mjs";

// A well-formed 32-lowercase-hex box_token/box_id (128 bits) — the shape
// src/server/auth.mjs isValidToken and transport.mjs isValidBoxToken enforce.
const HEX32 = "0123456789abcdef0123456789abcdef";
const HEX32B = "fedcba9876543210fedcba9876543210";

describe("normalizeCode", () => {
  it("strips non-digits and clamps to 6", () => {
    expect(normalizeCode("847291")).toBe("847291");
    expect(normalizeCode("84-72 91")).toBe("847291");
    expect(normalizeCode("847291999")).toBe("847291");
    expect(normalizeCode("abc12def34")).toBe("1234");
    expect(normalizeCode("")).toBe("");
  });

  it("tolerates nullish input", () => {
    expect(normalizeCode(undefined as unknown as string)).toBe("");
    expect(normalizeCode(null as unknown as string)).toBe("");
  });
});

describe("isSubmittableCode", () => {
  it("true only for exactly 6 digits", () => {
    expect(isSubmittableCode("847291")).toBe(true);
    expect(isSubmittableCode("12345")).toBe(false);
    expect(isSubmittableCode("1234567")).toBe(false);
    expect(isSubmittableCode("12a456")).toBe(false);
    expect(isSubmittableCode("")).toBe(false);
  });
});

describe("classifyClaimResult", () => {
  it("200 with a valid body → ok + tokens", () => {
    const r = classifyClaimResult(200, { box_token: HEX32, box_id: HEX32B });
    expect(r).toEqual({ ok: true, boxToken: HEX32, boxId: HEX32B });
  });

  it("200 with malformed token → invalid_response", () => {
    const r = classifyClaimResult(200, { box_token: "nope", box_id: HEX32B });
    expect(r).toEqual({
      ok: false,
      kind: "invalid_response",
      message: expect.any(String),
    });
  });

  it("200 with a null body → invalid_response", () => {
    const r = classifyClaimResult(200, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_response");
  });

  it("403 → wrong_code", () => {
    const r = classifyClaimResult(403, { error: "pairing failed" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("wrong_code");
  });

  it("400 → wrong_code", () => {
    const r = classifyClaimResult(400, { error: "invalid pairing code" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("wrong_code");
  });

  it("429 → rate_limited", () => {
    const r = classifyClaimResult(429, { error: "rate limited" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("rate_limited");
  });

  it("5xx → server_error", () => {
    const r = classifyClaimResult(500, { error: "boom" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("server_error");
  });

  it("unexpected status (404/401) → server_error, not wrong_code", () => {
    for (const status of [401, 404, 418]) {
      const r = classifyClaimResult(status, null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("server_error");
    }
  });
});

describe("networkFailure", () => {
  it("returns a network failure with a message", () => {
    const r = networkFailure();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("network");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyRelayClaimResult (BET-156, relay /pair)", () => {
  // Wire shape: { box_id, account_id, account_token }. The desktop stores
  // `account_token` in the SAME `boxToken` slot the direct /auth/claim shape
  // populates — the renderer's auth code path is unaware of the difference.
  it("200 with a valid body → ok + (account_token → boxToken, box_id)", () => {
    const r = classifyRelayClaimResult(200, {
      box_id: HEX32B,
      account_id: HEX32,
      account_token: HEX32B, // a different 32-hex value
    });
    expect(r).toEqual({ ok: true, boxToken: HEX32B, boxId: HEX32B });
  });

  it("200 with malformed account_token → invalid_response", () => {
    const r = classifyRelayClaimResult(200, {
      box_id: HEX32B,
      account_id: HEX32,
      account_token: "nope",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_response");
  });

  it("200 with missing account_token → invalid_response", () => {
    const r = classifyRelayClaimResult(200, { box_id: HEX32B, account_id: HEX32 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_response");
  });

  it("200 with null body → invalid_response", () => {
    const r = classifyRelayClaimResult(200, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_response");
  });

  it("status mapping matches classifyClaimResult exactly (one error-handling path on the renderer)", () => {
    for (const [status, kind] of [
      [403, "wrong_code"],
      [400, "wrong_code"],
      [429, "rate_limited"],
      [500, "server_error"],
      [503, "server_error"],
    ] as const) {
      const r = classifyRelayClaimResult(status, { error: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe(kind);
    }
  });
});
