// httpApi.sessionsMaterialize: one /rpc call on the pinned channel, the box's answer returned untouched
// (an expected refusal is a value, never a throw).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { httpApi } from "./httpApi.js";
import { IPC } from "../../shared/types";

const store: Record<string, string> = {};
const HEX32 = "0123456789abcdef0123456789abcdef";

const stubFetch = () => {
  const mock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
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

describe("sessionsMaterialize", () => {
  it("POSTs /rpc/sessions:materialize with the session id and returns the box's result", async () => {
    const answer = { ok: true, project: "proj", windowIndex: 4, sessionId: "ses_a" };
    const f = stubFetch().mockResolvedValue(res({ result: answer }));
    expect(await httpApi.sessionsMaterialize({ sessionId: "ses_a" })).toEqual(answer);
    expect(f.mock.calls[0][0]).toBe(`https://example.com/rpc/${encodeURIComponent(IPC.sessionsMaterialize)}`);
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ args: [{ sessionId: "ses_a" }] });
    expect(JSON.stringify(f.mock.calls[0][1]?.headers)).toContain(HEX32);
  });

  it("a refusal comes back as a value", async () => {
    const refusal = { ok: false, reason: "no-project", message: "No workspace owns this session." };
    stubFetch().mockResolvedValue(res({ result: refusal }));
    expect(await httpApi.sessionsMaterialize({ sessionId: "ses_a" })).toEqual(refusal);
  });

  it("a transport failure rejects", async () => {
    stubFetch().mockResolvedValue(res({ error: "boom" }, 500));
    await expect(httpApi.sessionsMaterialize({ sessionId: "ses_a" })).rejects.toThrow("boom");
  });
});
