import { describe, it, expect } from "vitest";
import {
  normalizeCode,
  isSubmittableCode,
  classifyClaimResult,
  networkFailure,
  pairingReducer,
  initialPairingState,
  canSubmit,
  type PairingState,
} from "./pairingLogic.js";

// A well-formed 32-lowercase-hex box_token/box_id (128 bits) — the shape the
// server's auth.mjs isValidToken and shared transport.mjs isValidBoxToken enforce.
const HEX32 = "0123456789abcdef0123456789abcdef";
const HEX32B = "fedcba9876543210fedcba9876543210";

// ---------------------------------------------------------------------------
// normalizeCode — strip non-digits, clamp to 6
// ---------------------------------------------------------------------------

describe("normalizeCode", () => {
  it("strips spaces, dashes and letters", () => {
    expect(normalizeCode("12 34-56")).toBe("123456");
    expect(normalizeCode("abc123")).toBe("123");
  });
  it("clamps to the first 6 digits", () => {
    expect(normalizeCode("1234567890")).toBe("123456");
  });
  it("handles empty / nullish input", () => {
    expect(normalizeCode("")).toBe("");
    // @ts-expect-error — defensive: guard against a non-string at runtime
    expect(normalizeCode(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isSubmittableCode — exactly 6 digits
// ---------------------------------------------------------------------------

describe("isSubmittableCode", () => {
  it("true only for exactly 6 digits", () => {
    expect(isSubmittableCode("123456")).toBe(true);
    expect(isSubmittableCode("000000")).toBe(true);
  });
  it("false for short/long/non-numeric", () => {
    expect(isSubmittableCode("12345")).toBe(false);
    expect(isSubmittableCode("1234567")).toBe(false);
    expect(isSubmittableCode("12a456")).toBe(false);
    expect(isSubmittableCode("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyClaimResult — map an /auth/claim HTTP outcome to a typed result
// ---------------------------------------------------------------------------

describe("classifyClaimResult", () => {
  it("200 with a valid body → ok with the parsed token/id", () => {
    const r = classifyClaimResult(200, { box_token: HEX32, box_id: HEX32B });
    expect(r).toEqual({ ok: true, boxToken: HEX32, boxId: HEX32B });
  });

  it("200 with a malformed body → invalid_response (never persists junk)", () => {
    const r = classifyClaimResult(200, { box_token: "nope", box_id: HEX32B });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_response");
  });

  it("200 with a null/absent body → invalid_response", () => {
    const r = classifyClaimResult(200, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_response");
  });

  it("403 (wrong/expired/reused code) → wrong_code", () => {
    const r = classifyClaimResult(403, { error: "pairing failed" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("wrong_code");
  });

  it("400 (malformed code, client guard bypassed) → wrong_code", () => {
    const r = classifyClaimResult(400, { error: "invalid pairing code" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("wrong_code");
  });

  it("429 → rate_limited with a friendly message", () => {
    const r = classifyClaimResult(429, { error: "rate limited" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("rate_limited");
      expect(r.message).toMatch(/too many/i);
    }
  });

  it("5xx → server_error", () => {
    const r = classifyClaimResult(500, { error: "boom" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("server_error");
  });

  it("an unexpected status (e.g. 404) → server_error, not wrong_code", () => {
    const r = classifyClaimResult(404, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("server_error");
  });

  it("every failure carries a non-empty user-facing message", () => {
    for (const status of [400, 403, 429, 500, 404]) {
      const r = classifyClaimResult(status, null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("networkFailure", () => {
  it("is a network-kind failure with a message", () => {
    const r = networkFailure();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("network");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// pairingReducer — the form state machine
// ---------------------------------------------------------------------------

describe("pairingReducer", () => {
  it("edit normalizes the code and clears a prior error", () => {
    const errored: PairingState = { code: "12", status: "error", error: "nope" };
    const next = pairingReducer(errored, { type: "edit", raw: "9 8-7654321" });
    expect(next.code).toBe("987654");
    expect(next.error).toBeNull();
    expect(next.status).toBe("error"); // status unchanged until next submit
  });

  it("edit is ignored while a request is in flight (input locked)", () => {
    const submitting: PairingState = { code: "123456", status: "submitting", error: null };
    const next = pairingReducer(submitting, { type: "edit", raw: "000000" });
    expect(next).toBe(submitting); // same reference — no-op
  });

  it("submit from a valid idle state enters submitting and clears error", () => {
    const ready: PairingState = { code: "123456", status: "idle", error: null };
    const next = pairingReducer(ready, { type: "submit" });
    expect(next.status).toBe("submitting");
    expect(next.error).toBeNull();
  });

  it("submit is a no-op when the code isn't 6 digits", () => {
    const partial: PairingState = { code: "123", status: "idle", error: null };
    expect(pairingReducer(partial, { type: "submit" })).toBe(partial);
  });

  it("submit is a no-op while already submitting (no double-fire)", () => {
    const inflight: PairingState = { code: "123456", status: "submitting", error: null };
    expect(pairingReducer(inflight, { type: "submit" })).toBe(inflight);
  });

  it("success returns to idle with no error", () => {
    const inflight: PairingState = { code: "123456", status: "submitting", error: null };
    const next = pairingReducer(inflight, { type: "success" });
    expect(next.status).toBe("idle");
    expect(next.error).toBeNull();
  });

  it("fail moves to error, surfaces the message, and preserves the code", () => {
    const inflight: PairingState = { code: "123456", status: "submitting", error: null };
    const result = classifyClaimResult(403, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const next = pairingReducer(inflight, { type: "fail", result });
    expect(next.status).toBe("error");
    expect(next.error).toBe(result.message);
    expect(next.code).toBe("123456");
  });

  it("full happy path: type → submit → success", () => {
    let s = initialPairingState;
    s = pairingReducer(s, { type: "edit", raw: "123456" });
    expect(canSubmit(s)).toBe(true);
    s = pairingReducer(s, { type: "submit" });
    expect(s.status).toBe("submitting");
    expect(canSubmit(s)).toBe(false); // disabled in-flight
    s = pairingReducer(s, { type: "success" });
    expect(s.status).toBe("idle");
  });

  it("retry path: wrong code → error → correct → submit again", () => {
    let s: PairingState = { code: "111111", status: "submitting", error: null };
    const wrong = classifyClaimResult(403, null);
    if (wrong.ok) throw new Error("unreachable");
    s = pairingReducer(s, { type: "fail", result: wrong });
    expect(s.status).toBe("error");
    expect(canSubmit(s)).toBe(true); // 6 digits still present → can retry
    s = pairingReducer(s, { type: "edit", raw: "222222" });
    expect(s.error).toBeNull();
    s = pairingReducer(s, { type: "submit" });
    expect(s.status).toBe("submitting");
  });
});

describe("canSubmit", () => {
  it("true only with a 6-digit code and not submitting", () => {
    expect(canSubmit({ code: "123456", status: "idle", error: null })).toBe(true);
    expect(canSubmit({ code: "123456", status: "error", error: "x" })).toBe(true);
    expect(canSubmit({ code: "123456", status: "submitting", error: null })).toBe(false);
    expect(canSubmit({ code: "12345", status: "idle", error: null })).toBe(false);
  });
});
