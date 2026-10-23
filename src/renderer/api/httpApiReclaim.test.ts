// httpApi reclaim client (cleanup spec K7): upgradeReclaimStatus / upgradeReclaim.
//   • status: 404 → null (box predates the route); 401 → AuthRequiredError; other failures reject.
//   • reclaim: never rejects on a refusal or network error ({ok:false,error}); 401 throws.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthRequiredError, httpApi } from "./httpApi.js";

const store: Record<string, string> = {};
const HEX32 = "0123456789abcdef0123456789abcdef";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const stubFetch = () => {
  const mock = vi.fn<FetchFn>();
  vi.stubGlobal("fetch", mock);
  return mock;
};
const res = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  store["manta_server"] = "https://example.com";
  store["manta_token"] = HEX32;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
  });
  vi.stubGlobal("location", { protocol: "https:", hostname: "example.com", origin: "https://example.com" });
});

describe("upgradeReclaimStatus", () => {
  it("GETs /api/upgrade/reclaim with the bearer token and returns the parsed status", async () => {
    const f = stubFetch().mockResolvedValue(res({ available: true, reason: null, mode: "copy", bytes: 123, state: "none" }));
    expect(await httpApi.upgradeReclaimStatus()).toEqual({ available: true, reason: null, mode: "copy", bytes: 123, state: "none" });
    expect(f.mock.calls[0][0]).toBe("https://example.com/api/upgrade/reclaim");
    expect(f.mock.calls[0][1]?.method).toBe("GET");
    expect(JSON.stringify(f.mock.calls[0][1]?.headers)).toContain(HEX32);
  });
  it("404 → null (the box predates the route)", async () => {
    stubFetch().mockResolvedValue(res({ error: "not found" }, 404));
    expect(await httpApi.upgradeReclaimStatus()).toBeNull();
  });
  it("401 → AuthRequiredError", async () => {
    stubFetch().mockResolvedValue(res({}, 401));
    await expect(httpApi.upgradeReclaimStatus()).rejects.toBeInstanceOf(AuthRequiredError);
  });
  it("other HTTP errors, network failures and malformed bodies reject", async () => {
    stubFetch().mockResolvedValue(res({}, 503));
    await expect(httpApi.upgradeReclaimStatus()).rejects.toThrow("HTTP 503");
    stubFetch().mockRejectedValue(new Error("fetch failed"));
    await expect(httpApi.upgradeReclaimStatus()).rejects.toThrow("fetch failed");
    stubFetch().mockResolvedValue(res({ nope: 1 }));
    await expect(httpApi.upgradeReclaimStatus()).rejects.toThrow("unrecognised");
  });
  it("normalises unknown mode/state values", async () => {
    stubFetch().mockResolvedValue(res({ available: false, reason: "x", mode: "weird", bytes: "n", state: "??" }));
    expect(await httpApi.upgradeReclaimStatus()).toEqual({ available: false, reason: "x", mode: null, bytes: null, state: "none" });
  });
});

describe("upgradeReclaim", () => {
  it("POSTs and returns {ok:true, freedBytes}", async () => {
    const f = stubFetch().mockResolvedValue(res({ ok: true, freedBytes: 999 }));
    expect(await httpApi.upgradeReclaim()).toEqual({ ok: true, freedBytes: 999 });
    expect(f.mock.calls[0][0]).toBe("https://example.com/api/upgrade/reclaim");
    expect(f.mock.calls[0][1]?.method).toBe("POST");
  });
  it("a refusal comes back as {ok:false,error} — never a rejection", async () => {
    stubFetch().mockResolvedValue(res({ ok: false, error: "Already reclaimed" }));
    expect(await httpApi.upgradeReclaim()).toEqual({ ok: false, error: "Already reclaimed" });
  });
  it("a non-JSON / empty failure body still yields a message", async () => {
    stubFetch().mockResolvedValue(new Response("<html>", { status: 502 }));
    expect(await httpApi.upgradeReclaim()).toEqual({ ok: false, error: "HTTP 502" });
  });
  it("a network error comes back as {ok:false,error}", async () => {
    stubFetch().mockRejectedValue(new Error("fetch failed"));
    expect(await httpApi.upgradeReclaim()).toEqual({ ok: false, error: "fetch failed" });
  });
  it("401 throws AuthRequiredError", async () => {
    stubFetch().mockResolvedValue(res({}, 401));
    await expect(httpApi.upgradeReclaim()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});
