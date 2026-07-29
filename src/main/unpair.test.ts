import { describe, it, expect, vi } from "vitest";
import { unpairBox } from "./unpair.js";

const HEX32 = "0123456789abcdef0123456789abcdef";
const SERVER = `https://${HEX32}.boxes.mantaui.com`;

function fakeResponse(status: number): Response {
  return { status } as unknown as Response;
}

function stubFetch(res: Response | { throw: true }): {
  fetch: typeof fetch;
  urls: string[];
  headers: Record<string, string>[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    const hdr: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) hdr[k.toLowerCase()] = h[k];
    }
    headers.push(hdr);
    if ("throw" in res) throw new Error("ECONNREFUSED");
    return res;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls, headers };
}

describe("unpairBox — wire call to DELETE /auth/revoke (BET-357 §2)", () => {
  it("200 → ok and sends DELETE + Bearer to <serverUrl>/auth/revoke", async () => {
    const { fetch, urls, headers } = stubFetch(fakeResponse(200));
    const out = await unpairBox({ serverUrl: SERVER, boxToken: HEX32 }, fetch);
    expect(out.ok).toBe(true);
    expect(urls).toEqual([`${SERVER}/auth/revoke`]);
    // Request is DELETE with the box_token in the Authorization header.
    expect(headers[0]).toEqual({ authorization: `Bearer ${HEX32}` });
  });

  it("trims trailing slash off serverUrl before the request", async () => {
    const { fetch, urls } = stubFetch(fakeResponse(200));
    await unpairBox({ serverUrl: `${SERVER}/`, boxToken: HEX32 }, fetch);
    expect(urls).toEqual([`${SERVER}/auth/revoke`]);
  });

  it("401 → auth_rejected", async () => {
    const { fetch } = stubFetch(fakeResponse(401));
    const out = await unpairBox({ serverUrl: SERVER, boxToken: HEX32 }, fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe("auth_rejected");
      expect(out.message.length).toBeGreaterThan(0);
    }
  });

  it("400 → bad_request (malformed-token shape, per server's manual gate)", async () => {
    const { fetch } = stubFetch(fakeResponse(400));
    const out = await unpairBox({ serverUrl: SERVER, boxToken: HEX32 }, fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("bad_request");
  });

  it("429 → rate_limited", async () => {
    const { fetch } = stubFetch(fakeResponse(429));
    const out = await unpairBox({ serverUrl: SERVER, boxToken: HEX32 }, fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("rate_limited");
  });

  it("5xx → server_error", async () => {
    for (const status of [500, 502, 503]) {
      const { fetch } = stubFetch(fakeResponse(status));
      const out = await unpairBox({ serverUrl: SERVER, boxToken: HEX32 }, fetch);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe("server_error");
    }
  });

  it("fetch rejected (network failure) → network without crashing", async () => {
    const { fetch } = stubFetch({ throw: true });
    const out = await unpairBox({ serverUrl: SERVER, boxToken: HEX32 }, fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("network");
  });

  it("empty serverUrl → network, no fetch", async () => {
    const { fetch, urls } = stubFetch(fakeResponse(200));
    const out = await unpairBox({ serverUrl: "", boxToken: HEX32 }, fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("network");
    expect(urls).toEqual([]);
  });

  it("empty boxToken → network, no fetch (can't present a token)", async () => {
    const { fetch, urls } = stubFetch(fakeResponse(200));
    const out = await unpairBox({ serverUrl: SERVER, boxToken: "" }, fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("network");
    expect(urls).toEqual([]);
  });

  it("404 → unexpected (server doesn't recognize this route)", async () => {
    const { fetch } = stubFetch(fakeResponse(404));
    const out = await unpairBox({ serverUrl: SERVER, boxToken: HEX32 }, fetch);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("unexpected");
  });
});
