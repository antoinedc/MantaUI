import { describe, it, expect, vi } from "vitest";
import { claimPairing } from "./auth.js";
import type { AppConfig } from "../shared/types.js";

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
    const { fetch } = stubFetch(fakeResponse(403, { error: "pairing failed" }));
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "http://box:8787", code: "000000" },
      persist,
      fetch,
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("wrong_code");
    expect(persist).not.toHaveBeenCalled();
  });

  it("rate limited (429) → rate_limited outcome, no persist", async () => {
    const { fetch } = stubFetch(fakeResponse(429, { error: "slow down" }));
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "http://box:8787", code: "847291" },
      persist,
      fetch,
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("rate_limited");
    expect(persist).not.toHaveBeenCalled();
  });

  it("200 with a malformed token → invalid_response, no persist", async () => {
    const { fetch } = stubFetch(
      fakeResponse(200, { ok: true, box_token: "nope", box_id: HEX32B }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "http://box:8787", code: "847291" },
      persist,
      fetch,
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("invalid_response");
    expect(persist).not.toHaveBeenCalled();
  });

  it("unreachable server (fetch rejects) → network outcome, no persist", async () => {
    const { fetch } = stubFetch({ throw: true });
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "http://nope:9999", code: "847291" },
      persist,
      fetch,
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("network");
    expect(persist).not.toHaveBeenCalled();
  });

  it("empty serverUrl → network outcome without ever fetching", async () => {
    const { fetch, urls } = stubFetch(
      fakeResponse(200, { ok: true, box_token: HEX32, box_id: HEX32B }),
    );
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});

    const out = await claimPairing(
      { serverUrl: "   ", code: "847291" },
      persist,
      fetch,
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("network");
    expect(urls).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
});
