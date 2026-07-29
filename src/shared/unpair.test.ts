import { describe, it, expect } from "vitest";
import {
  classifyUnpairResult,
  classifyUnpairHttp,
} from "./unpair.mjs";

// classifyUnpairResult — the literal (remoteOk, remoteError) signature from
// the issue spec (BET-357 §2). Covers the success branch and every failure
// shape the desktop's Settings "Remove box" action needs to render.
describe("classifyUnpairResult", () => {
  it("remoteOk=true → ok regardless of remoteError", () => {
    expect(classifyUnpairResult(true, null)).toEqual({ ok: true });
    // Defensive: a buggy caller that passes both true and a non-null error
    // still gets a clean ok result (the remoteError is ignored on success).
    expect(classifyUnpairResult(true, "network")).toEqual({ ok: true });
    expect(classifyUnpairResult(true, "auth_rejected")).toEqual({ ok: true });
  });

  it("remoteOk=false + null remoteError → network (safe default)", () => {
    const r = classifyUnpairResult(false, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });

  it("remoteOk=false + undefined remoteError → network", () => {
    const r = classifyUnpairResult(false, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });

  it("each known error kind maps to itself with a user-facing message", () => {
    const kinds = [
      "network",
      "bad_request",
      "auth_rejected",
      "method_not_allowed",
      "rate_limited",
      "server_error",
      "unexpected",
    ] as const;
    for (const kind of kinds) {
      const r = classifyUnpairResult(false, kind);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe(kind);
        expect(typeof r.message).toBe("string");
        expect(r.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("unknown error kind → 'unexpected' (don't crash the renderer)", () => {
    const r = classifyUnpairResult(false, "made-up-kind");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("unexpected");
  });

  it("each failure message is meaningful and unique enough to debug", () => {
    const r1 = classifyUnpairResult(false, "network");
    const r2 = classifyUnpairResult(false, "auth_rejected");
    const r3 = classifyUnpairResult(false, "server_error");
    if (r1.ok || r2.ok || r3.ok) throw new Error("expected all failures");
    expect(r1.message).not.toBe(r2.message);
    expect(r2.message).not.toBe(r3.message);
    // The network message must mention the unreachable-box graceful-fallback
    // ("locally only") so the UI can be honest about what the user is seeing.
    expect(r1.message.toLowerCase()).toMatch(/locally|unreachable|reach/);
  });
});

// classifyUnpairHttp — the one-step convenience that takes a raw fetch result
// (status + optional network tag). This is what the desktop main process
// actually uses (src/main/unpair.ts); the two-classifier shape lets the
// existing tests assert on the issue-spec signature while production code
// benefits from the structured-input variant.
describe("classifyUnpairHttp", () => {
  it("200 → ok", () => {
    expect(classifyUnpairHttp({ status: 200 })).toEqual({ ok: true });
  });

  it("400 → bad_request", () => {
    const r = classifyUnpairHttp({ status: 400 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("bad_request");
  });

  it("401 → auth_rejected", () => {
    const r = classifyUnpairHttp({ status: 401 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("auth_rejected");
  });

  it("405 → method_not_allowed", () => {
    const r = classifyUnpairHttp({ status: 405 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("method_not_allowed");
  });

  it("429 → rate_limited", () => {
    const r = classifyUnpairHttp({ status: 429 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("rate_limited");
  });

  it("5xx → server_error", () => {
    for (const status of [500, 502, 503, 504]) {
      const r = classifyUnpairHttp({ status });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("server_error");
    }
  });

  it("null status (no response) → network", () => {
    const r = classifyUnpairHttp({ status: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });

  it("any status + networkError tag → network (fetch-level failure wins)", () => {
    for (const status of [200, 401, 500, null]) {
      const r = classifyUnpairHttp({ status, networkError: "connection_refused" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("network");
    }
  });

  it("unexpected status (404, 418, ...) → unexpected, not network", () => {
    for (const status of [404, 418, 422]) {
      const r = classifyUnpairHttp({ status });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("unexpected");
    }
  });

  it("empty args object (defensive) → network", () => {
    const r = classifyUnpairHttp({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });
});

// The unreachable-box fallback (BET-357 §2): the helper must always classify
// to a user-facing message, even when called with the degenerate inputs a
// half-broken fetch could produce. The renderer's Settings panel relies on
// `r.message` being a non-empty string so the "couldn't revoke remotely" note
// renders inline below the action button.
describe("unpair classifier — unreachable-box fallback contract", () => {
  it("any null/undefined status collapses to network (the safe default)", () => {
    expect(classifyUnpairHttp({ status: undefined }).ok).toBe(false);
    expect(classifyUnpairHttp({ status: null as unknown as number }).ok).toBe(false);
    expect(classifyUnpairHttp().ok).toBe(false);
  });

  it("every failure kind carries a non-empty message (UI sanity)", () => {
    const failures = [
      classifyUnpairResult(false, "network"),
      classifyUnpairResult(false, "bad_request"),
      classifyUnpairResult(false, "auth_rejected"),
      classifyUnpairResult(false, "method_not_allowed"),
      classifyUnpairResult(false, "rate_limited"),
      classifyUnpairResult(false, "server_error"),
      classifyUnpairResult(false, "unexpected"),
    ];
    for (const f of failures) {
      if (!f.ok) {
        expect(typeof f.message).toBe("string");
        expect(f.message.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
