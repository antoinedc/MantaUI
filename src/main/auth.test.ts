import { describe, it, expect, vi, beforeEach } from "vitest";
import { claimPairing, RELAY_BASE } from "./auth.js";
import type { AppConfig, AuthClaimInput } from "../shared/types.js";

const HEX32 = "0123456789abcdef0123456789abcdef";
const HEX32B = "fedcba9876543210fedcba9876543210";

// A minimal Response-like stub — claimPairing only reads .status and .json().
function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  } as unknown as Response;
}

// Build a fetch stub that records the URL it was called with and returns the
// given response. Rejects when `throwOn` is set (simulating an unreachable box).
function stubFetch(res: Response | { throw: true }): {
  fetch: typeof fetch;
  urls: string[];
  bodies: string[];
} {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.body) bodies.push(String(init.body));
    if ("throw" in res) throw new Error("ECONNREFUSED");
    return res;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls, bodies };
}

// Shared arrange/act/assert for the failure cases: run a claim against the
// given response stub and assert it produced the expected failure `kind`
// without persisting. Returns the recorded fetch URLs for callers that also
// want to assert on request behavior. Extracting this keeps the individual
// failure cases from each repeating the same ~11-line scaffold.
async function expectClaimFailure(
  res: Response | { throw: true },
  input: AuthClaimInput,
  kind: string,
): Promise<{ urls: string[] }> {
  const { fetch, urls } = stubFetch(res);
  const persist = vi.fn((_patch: Partial<AppConfig>) => {});

  const out = await claimPairing(input, persist, fetch);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.kind).toBe(kind);
  expect(persist).not.toHaveBeenCalled();
  return { urls };
}

describe("claimPairing", () => {
  it("valid code → ok outcome + persists { serverUrl, boxId, boxToken }", async () => {
    const { fetch, urls, bodies } = stubFetch(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "http://box:8787", code: "847291" },
      persist,
      fetch,
    );

    expect(out).toEqual({ ok: true, boxToken: HEX32, boxId: HEX32B });
    expect(urls).toEqual(["http://box:8787/auth/claim"]);
    // POST body carries the pairing_code under the server's expected key.
    expect(JSON.parse(bodies[0])).toEqual({ pairing_code: "847291" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      serverUrl: "http://box:8787",
      boxId: HEX32B,
      boxToken: HEX32,
    });
  });

  it("trims a trailing slash off serverUrl before the claim + when persisting", async () => {
    const { fetch, urls } = stubFetch(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    await claimPairing(
      { serverUrl: "http://box:8787/", code: "847291" },
      persist,
      fetch,
    );

    expect(urls).toEqual(["http://box:8787/auth/claim"]);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "http://box:8787" }),
    );
  });

  it("wrong/expired code (403) → wrong_code outcome, does NOT persist", async () => {
    await expectClaimFailure(
      fakeResponse(403, { error: "pairing failed" }),
      { serverUrl: "http://box:8787", code: "000000" },
      "wrong_code",
    );
  });

  it("rate limited (429) → rate_limited outcome, no persist", async () => {
    await expectClaimFailure(
      fakeResponse(429, { error: "slow down" }),
      { serverUrl: "http://box:8787", code: "847291" },
      "rate_limited",
    );
  });

  it("200 with a malformed token → invalid_response, no persist", async () => {
    await expectClaimFailure(
      fakeResponse(200, { ok: true, box_token: "nope", box_id: HEX32B }),
      { serverUrl: "http://box:8787", code: "847291" },
      "invalid_response",
    );
  });

  it("unreachable server (fetch rejects) → network outcome, no persist", async () => {
    await expectClaimFailure(
      { throw: true },
      { serverUrl: "http://nope:9999", code: "847291" },
      "network",
    );
  });

  it("empty serverUrl → network outcome without ever fetching", async () => {
    const { urls } = await expectClaimFailure(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
      { serverUrl: "   ", code: "847291" },
      "network",
    );
    // No fetch should have happened for a blank server URL.
    expect(urls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Relay branch (BET-156 / ADR-3) — payload.boxId present → POST <relay>/pair
// ---------------------------------------------------------------------------

const ACCOUNT_TOKEN = "aabbccddeeff00112233445566778899"; // 32 hex; account_token

// Reset MANTA_RELAY_BASE so a developer's env doesn't leak into tests.
beforeEach(() => {
  delete process.env.MANTA_RELAY_BASE;
});

describe("claimPairing — relay branch (boxId present)", () => {
  it("RELAY_BASE is the canonical relay host (single source for the desktop)", () => {
    expect(RELAY_BASE).toBe("https://relay.mantaui.com");
  });

  it("valid boxId → POSTs <relay>/pair with { box_id, code }, persists { serverUrl: <relay>/box/<id>, boxId, boxToken: account_token }", async () => {
    const { fetch, urls, bodies } = stubFetch(
      fakeResponse(200, { box_id: HEX32B, account_id: HEX32, account_token: ACCOUNT_TOKEN }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "", boxId: HEX32B, code: "847291" },
      persist,
      fetch,
    );

    expect(out).toEqual({ ok: true, boxToken: ACCOUNT_TOKEN, boxId: HEX32B });
    expect(urls).toEqual(["https://relay.mantaui.com/pair"]);
    expect(JSON.parse(bodies[0])).toEqual({ box_id: HEX32B, code: "847291" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      serverUrl: `https://relay.mantaui.com/box/${HEX32B}`,
      boxId: HEX32B,
      boxToken: ACCOUNT_TOKEN,
    });
  });

  it("HONORS MANTA_RELAY_BASE env override (tests only — same shape, just a different host)", async () => {
    process.env.MANTA_RELAY_BASE = "http://127.0.0.1:9999";
    const { fetch, urls, bodies } = stubFetch(
      fakeResponse(200, { box_id: HEX32B, account_id: HEX32, account_token: ACCOUNT_TOKEN }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    await claimPairing({ serverUrl: "", boxId: HEX32B, code: "847291" }, persist, fetch);

    expect(urls).toEqual(["http://127.0.0.1:9999/pair"]);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: `http://127.0.0.1:9999/box/${HEX32B}`,
      }),
    );
    // suppress unused
    void bodies;
  });

  it("wrong/expired code (403) → wrong_code, does NOT persist", async () => {
    await expectClaimFailure(
      fakeResponse(403, { error: "claim rejected" }),
      { serverUrl: "", boxId: HEX32B, code: "000000" },
      "wrong_code",
    );
  });

  it("rate limited (429) → rate_limited, no persist", async () => {
    await expectClaimFailure(
      fakeResponse(429, { error: "slow down" }),
      { serverUrl: "", boxId: HEX32B, code: "847291" },
      "rate_limited",
    );
  });

  it("box offline (relay 503 box_offline) → server_error, no persist", async () => {
    await expectClaimFailure(
      fakeResponse(503, { error: "box_offline" }),
      { serverUrl: "", boxId: HEX32B, code: "847291" },
      "server_error",
    );
  });

  it("200 with a malformed account_token → invalid_response, no persist", async () => {
    await expectClaimFailure(
      fakeResponse(200, { box_id: HEX32B, account_id: HEX32, account_token: "nope" }),
      { serverUrl: "", boxId: HEX32B, code: "847291" },
      "invalid_response",
    );
  });

  it("unreachable relay (fetch rejects) → network, no persist", async () => {
    await expectClaimFailure(
      { throw: true },
      { serverUrl: "", boxId: HEX32B, code: "847291" },
      "network",
    );
  });

  it("malformed boxId → network outcome without ever fetching", async () => {
    const { fetch, urls } = stubFetch(
      fakeResponse(200, { box_id: HEX32B, account_id: HEX32, account_token: ACCOUNT_TOKEN }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "", boxId: "not-32-hex", code: "847291" },
      persist,
      fetch,
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("network");
    expect(persist).not.toHaveBeenCalled();
    expect(urls).toEqual([]); // never even tried the relay
  });

  it("serverUrl empty + boxId present → relay branch (the desktop's box-form input)", async () => {
    const { fetch, urls } = stubFetch(
      fakeResponse(200, { box_id: HEX32B, account_id: HEX32, account_token: ACCOUNT_TOKEN }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    // PairStep sends { serverUrl: "", boxId: HEX32B, code } for the box form
    // (empty serverUrl keeps httpApi's mobile-only type signature unchanged).
    const out = await claimPairing(
      { serverUrl: "", boxId: HEX32B, code: "847291" },
      persist,
      fetch,
    );

    expect(out.ok).toBe(true);
    expect(urls).toEqual(["https://relay.mantaui.com/pair"]);
    expect(persist).toHaveBeenCalledWith({
      serverUrl: `https://relay.mantaui.com/box/${HEX32B}`,
      boxId: HEX32B,
      boxToken: ACCOUNT_TOKEN,
    });
  });
});
