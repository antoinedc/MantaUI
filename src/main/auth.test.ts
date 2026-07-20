import { describe, it, expect, vi } from "vitest";
import { claimPairing } from "./auth.js";
import { boxDirectUrl } from "../shared/transport.mjs";
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

describe("claimPairing — direct-HTTPS branch (BET-49, BET-198)", () => {
  it("valid code → ok outcome + persists { serverUrl, boxId, boxToken }", async () => {
    const { fetch, urls, bodies } = stubFetch(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "https://0123456789abcdef0123456789abcdef.boxes.mantaui.com", code: "847291" },
      persist,
      fetch,
    );

    expect(out).toEqual({ ok: true, boxToken: HEX32, boxId: HEX32B });
    expect(urls).toEqual([
      "https://0123456789abcdef0123456789abcdef.boxes.mantaui.com/auth/claim",
    ]);
    // POST body carries the pairing_code under the server's expected key.
    expect(JSON.parse(bodies[0])).toEqual({ pairing_code: "847291" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      serverUrl: "https://0123456789abcdef0123456789abcdef.boxes.mantaui.com",
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
      {
        serverUrl: "https://0123456789abcdef0123456789abcdef.boxes.mantaui.com/",
        code: "847291",
      },
      persist,
      fetch,
    );

    expect(urls).toEqual([
      "https://0123456789abcdef0123456789abcdef.boxes.mantaui.com/auth/claim",
    ]);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://0123456789abcdef0123456789abcdef.boxes.mantaui.com",
      }),
    );
  });

  it("wrong/expired code (403) → wrong_code outcome, does NOT persist", async () => {
    await expectClaimFailure(
      fakeResponse(403, { error: "pairing failed" }),
      { serverUrl: "https://box.example", code: "000000" },
      "wrong_code",
    );
  });

  it("rate limited (429) → rate_limited outcome, no persist", async () => {
    await expectClaimFailure(
      fakeResponse(429, { error: "slow down" }),
      { serverUrl: "https://box.example", code: "847291" },
      "rate_limited",
    );
  });

  it("200 with a malformed token → invalid_response, no persist", async () => {
    await expectClaimFailure(
      fakeResponse(200, { ok: true, box_token: "nope", box_id: HEX32B }),
      { serverUrl: "https://box.example", code: "847291" },
      "invalid_response",
    );
  });

  it("unreachable server (fetch rejects) → network outcome, no persist", async () => {
    await expectClaimFailure(
      { throw: true },
      { serverUrl: "https://nope.example", code: "847291" },
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

describe("claimPairing — box-form pair link (BET-156, BET-198)", () => {
  it("boxId + empty serverUrl → claims against boxDirectUrl(boxId), persists the canonical URL", async () => {
    const { fetch, urls, bodies } = stubFetch(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "", boxId: HEX32, code: "847291" },
      persist,
      fetch,
    );

    expect(out).toEqual({ ok: true, boxToken: HEX32, boxId: HEX32B });
    // Single source of truth: claim hits the same URL boxDirectUrl returns,
    // so desktop paste-link and mobile deep-link produce the IDENTICAL wire
    // request (and the IDENTICAL persisted serverUrl).
    const expectedUrl = boxDirectUrl(HEX32);
    expect(urls).toEqual([`${expectedUrl}/auth/claim`]);
    expect(JSON.parse(bodies[0])).toEqual({ pairing_code: "847291" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      serverUrl: expectedUrl,
      boxId: HEX32B,
      boxToken: HEX32,
    });
  });

  it("malformed boxId → network outcome without ever fetching", async () => {
    const { urls } = await expectClaimFailure(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
      { serverUrl: "", boxId: "not-a-box", code: "847291" },
      "network",
    );
    expect(urls).toEqual([]);
  });

  it("empty boxId AND empty serverUrl → network outcome without ever fetching", async () => {
    const { urls } = await expectClaimFailure(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
      { serverUrl: "", boxId: "", code: "847291" },
      "network",
    );
    expect(urls).toEqual([]);
  });
});
