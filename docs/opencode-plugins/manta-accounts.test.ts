// Tests for docs/opencode-plugins/manta-accounts.ts — the pure rewrite
// logic AND the wrapper end to end against a stub `fetch` (no network, fake
// tokens only). The test file is never installed
// (sync_opencode_plugins skips *.test.ts).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MantaAccounts } from "./manta-accounts";

const t: any = (MantaAccounts as any).__test;

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const CLAUDE = "https://api.anthropic.com/v1/messages?beta=true";
const CODEX = "https://chatgpt.com/backend-api/codex/responses";

describe("matchTarget", () => {
  it("matches only POSTs to the two model endpoints", () => {
    expect(t.matchTarget(CLAUDE, "POST")).toBe("claude");
    expect(t.matchTarget("https://api.anthropic.com/v1/messages", "post")).toBe("claude");
    expect(t.matchTarget(CODEX, "POST")).toBe("codex");
    expect(t.matchTarget(new URL(CODEX), "POST")).toBe("codex");
    expect(t.matchTarget(new Request(CLAUDE, { method: "POST" }), "POST")).toBe("claude");
  });
  it("leaves everything else alone", () => {
    expect(t.matchTarget(CLAUDE, "GET")).toBeNull();
    expect(t.matchTarget("https://api.anthropic.com/api/oauth/profile", "POST")).toBeNull();
    expect(t.matchTarget("https://console.anthropic.com/v1/oauth/token", "POST")).toBeNull();
    expect(t.matchTarget("https://chatgpt.com/backend-api/wham/usage", "POST")).toBeNull();
    expect(t.matchTarget("https://auth.openai.com/oauth/token", "POST")).toBeNull();
    expect(t.matchTarget("https://api.anthropic.com.evil.test/v1/messages", "POST")).toBeNull();
    expect(t.matchTarget("http://api.anthropic.com/v1/messages", "POST")).toBeNull();
    expect(t.matchTarget("not a url", "POST")).toBeNull();
    expect(t.matchTarget(undefined, "POST")).toBeNull();
  });
});

describe("headers + session ids", () => {
  it("normalises Headers / array / object init, and init replaces the Request's headers", () => {
    expect(t.collectHeaders(CLAUDE, { headers: { "X-A": "1" } }).get("x-a")).toBe("1");
    expect(t.collectHeaders(CLAUDE, { headers: [["X-A", "2"]] }).get("x-a")).toBe("2");
    expect(t.collectHeaders(CLAUDE, { headers: new Headers({ "X-A": "3" }) }).get("x-a")).toBe("3");
    const req = new Request(CLAUDE, { method: "POST", headers: { "x-from": "req" } });
    expect(t.collectHeaders(req, undefined).get("x-from")).toBe("req");
    expect(t.collectHeaders(req, { headers: { "x-from": "init" } }).get("x-from")).toBe("init");
  });
  it("reads the session ids; a parent-only request is the parent's session; none → null", () => {
    expect(t.sessionIds(new Headers({ "x-opencode-session-id": "ses_1" }))).toEqual({ sessionID: "ses_1", parentSessionID: null });
    expect(t.sessionIds(new Headers({ "x-opencode-session-id": "ses_2", "x-opencode-parent-session-id": "ses_1" }))).toEqual({ sessionID: "ses_2", parentSessionID: "ses_1" });
    expect(t.sessionIds(new Headers({ "x-opencode-parent-session-id": "ses_1" }))).toEqual({ sessionID: "ses_1", parentSessionID: null });
    expect(t.sessionIds(new Headers())).toBeNull();
  });
  it("a sub-agent shares its parent's cache key", () => {
    const parent = t.rootKey("claude", { sessionID: "p", parentSessionID: null });
    expect(t.rootKey("claude", { sessionID: "c", parentSessionID: "p" })).toBe(parent);
    expect(t.rootKey("codex", { sessionID: "p", parentSessionID: null })).not.toBe(parent);
  });
});

describe("rewriteHeaders", () => {
  it("claude: swaps authorization only", () => {
    const h = t.rewriteHeaders(new Headers({ authorization: "Bearer LIVE", "anthropic-beta": "x", "x-keep": "1" }), "claude", { accessToken: "SEAT2-TOKEN" });
    expect(h.get("authorization")).toBe("Bearer SEAT2-TOKEN");
    expect(h.get("anthropic-beta")).toBe("x");
    expect(h.get("x-keep")).toBe("1");
  });
  it("codex: sets the account id and the seat token's residency", () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_compute_residency: "us" } });
    const h = t.rewriteHeaders(new Headers({ authorization: "Bearer LIVE", "ChatGPT-Account-Id": "live-acct", "x-openai-internal-codex-residency": "eu" }), "codex", { accessToken: token, accountId: "seat-acct" });
    expect(h.get("authorization")).toBe(`Bearer ${token}`);
    expect(h.get("chatgpt-account-id")).toBe("seat-acct");
    expect(h.get("x-openai-internal-codex-residency")).toBe("us");
  });
  it("codex: removes the account id and residency header the seat does not have", () => {
    const h = t.rewriteHeaders(new Headers({ "ChatGPT-Account-Id": "live-acct", "x-openai-internal-codex-residency": "eu" }), "codex", { accessToken: jwt({ chatgpt_compute_residency: "no_constraint" }) });
    expect(h.has("chatgpt-account-id")).toBe(false);
    expect(h.has("x-openai-internal-codex-residency")).toBe(false);
  });
  it("does not mutate the headers it was given", () => {
    const src = new Headers({ authorization: "Bearer LIVE" });
    t.rewriteHeaders(src, "claude", { accessToken: "X" });
    expect(src.get("authorization")).toBe("Bearer LIVE");
  });
});

describe("residencyFromToken / jwtClaims", () => {
  it("reads either claim location and ignores no_constraint", () => {
    expect(t.residencyFromToken(jwt({ "https://api.openai.com/auth": { chatgpt_compute_residency: "us" } }))).toBe("us");
    expect(t.residencyFromToken(jwt({ chatgpt_compute_residency: "eu" }))).toBe("eu");
    expect(t.residencyFromToken(jwt({ chatgpt_compute_residency: "no_constraint" }))).toBeNull();
    expect(t.residencyFromToken(jwt({}))).toBeNull();
    expect(t.residencyFromToken("opaque")).toBeNull();
    expect(t.jwtClaims("a.b")).toBeNull();
  });
});

describe("small helpers", () => {
  it("parseResolved: a non-live answer needs a credential FILE (never a token); anything else is live", () => {
    expect(t.parseResolved({ seatId: "seat-2", live: false, provider: "claude", credentialFile: "/x/.credentials.json", expiresAt: 5 })).toEqual({ seatId: "seat-2", live: false, credentialFile: "/x/.credentials.json" });
    expect(t.parseResolved({ seatId: "seat-2", live: false })).toEqual({ seatId: "seat-2", live: true });
    expect(t.parseResolved({ seatId: "seat-2", live: false, accessToken: "T" })).toEqual({ seatId: "seat-2", live: true });
    expect(t.parseResolved({ seatId: null, live: true })).toEqual({ seatId: null, live: true });
    expect(t.parseResolved(null)).toBeNull();
  });
  it("expiresSoon: within 60 s; unknown expiry never", () => {
    expect(t.expiresSoon(1_059_000, 1_000_000)).toBe(true);
    expect(t.expiresSoon(1_061_000, 1_000_000)).toBe(false);
    expect(t.expiresSoon(undefined, 1_000_000)).toBe(false);
  });
  it("isReplayableBody: strings and buffers yes, streams no", () => {
    expect(t.isReplayableBody(undefined)).toBe(true);
    expect(t.isReplayableBody("{}")).toBe(true);
    expect(t.isReplayableBody(new Uint8Array(2))).toBe(true);
    expect(t.isReplayableBody(new ReadableStream())).toBe(false);
  });
  it("loopbackBase only ever accepts a loopback URL; forwardUrl keeps path and query", () => {
    expect(t.loopbackBase("http://127.0.0.1:9999/x")).toBe("http://127.0.0.1:9999");
    expect(t.loopbackBase("http://localhost:1")).toBe("http://localhost:1");
    expect(t.loopbackBase("https://evil.example")).toBeNull();
    expect(t.loopbackBase("file:///etc/passwd")).toBeNull();
    expect(t.loopbackBase(undefined)).toBeNull();
    expect(t.forwardUrl(CLAUDE, null)).toBe(CLAUDE);
    expect(t.forwardUrl(CLAUDE, "http://127.0.0.1:9")).toBe("http://127.0.0.1:9/v1/messages?beta=true");
  });
  it("exports exactly one function (opencode calls every export of a plugin file as a plugin)", async () => {
    const mod = await import("./manta-accounts");
    expect(Object.keys(mod)).toEqual(["MantaAccounts"]);
  });
});

// ---- seat credential files ---------------------------------------------------

const claudeFile = (access: string, expiresAt = 9_000_000) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: "r", expiresAt } });
const codexFile = (access: string, accountId = "seat-acct", expires = 9_000_000) => JSON.stringify({ openai: { type: "oauth", refresh: "r", access, expires, accountId } });

function seatsDir() {
  const base = mkdtempSync(join(tmpdir(), "manta-acct-plugin-"));
  const root = join(base, ".manta-secrets", "accounts");
  mkdirSync(join(root, "claude", "seat-2"), { recursive: true });
  mkdirSync(join(root, "codex", "seat-2"), { recursive: true });
  return { base, root, claude: join(root, "claude", "seat-2", ".credentials.json"), codex: join(root, "codex", "seat-2", "auth.json") };
}

describe("seat credential files", () => {
  it("parseSeatCredentials: claude and codex shapes; garbage → null", () => {
    expect(t.parseSeatCredentials("claude", claudeFile("SEAT2-TOKEN", 123))).toEqual({ accessToken: "SEAT2-TOKEN", expiresAt: 123 });
    expect(t.parseSeatCredentials("codex", codexFile("CX", "acct-2", 456))).toEqual({ accessToken: "CX", accountId: "acct-2", expiresAt: 456 });
    expect(t.parseSeatCredentials("codex", JSON.stringify({ type: "oauth", access: "BARE", expires: 1 }))).toEqual({ accessToken: "BARE", expiresAt: 1 });
    expect(t.parseSeatCredentials("claude", "{}")).toBeNull();
    expect(t.parseSeatCredentials("codex", claudeFile("x"))).toBeNull();
    expect(t.parseSeatCredentials("claude", "not json")).toBeNull();
  });

  it("allowedCredentialPath: absolute + real path inside the seats dir only", () => {
    const d = seatsDir();
    try {
      writeFileSync(d.claude, claudeFile("T"));
      expect(t.allowedCredentialPath(d.claude, d.root)).toContain("seat-2");
      expect(t.allowedCredentialPath("relative/.credentials.json", d.root)).toBeNull();
      expect(t.allowedCredentialPath(join(d.root, "..", "..", "elsewhere.json"), d.root)).toBeNull();
      expect(t.allowedCredentialPath(join(d.root, "claude", "seat-2"), d.root)).toBeNull(); // a directory
      expect(t.allowedCredentialPath(join(d.root, "claude", "seat-2", "missing.json"), d.root)).toBeNull();
      expect(t.allowedCredentialPath(undefined, d.root)).toBeNull();
      expect(t.allowedCredentialPath("/etc/passwd", d.root)).toBeNull();
      // a symlink INSIDE the dir that points OUT of it is rejected (realpath)
      const outside = join(d.base, "outside.json");
      writeFileSync(outside, claudeFile("STOLEN"));
      const link = join(d.root, "claude", "seat-2", "link.json");
      symlinkSync(outside, link);
      expect(t.allowedCredentialPath(link, d.root)).toBeNull();
      // a sibling dir that merely shares the prefix is not inside
      mkdirSync(join(d.base, ".manta-secrets", "accounts-evil"), { recursive: true });
      writeFileSync(join(d.base, ".manta-secrets", "accounts-evil", "x.json"), "{}");
      expect(t.allowedCredentialPath(join(d.base, ".manta-secrets", "accounts-evil", "x.json"), d.root)).toBeNull();
    } finally {
      rmSync(d.base, { recursive: true, force: true });
    }
  });

  it("the reader serves the file's token, re-reads when the file changes (mtime) or is invalidated, and refuses outside paths", () => {
    const d = seatsDir();
    try {
      writeFileSync(d.claude, claudeFile("TOKEN-A"));
      const r = t.createCredentialReader(() => d.root);
      expect(r.read("claude", d.claude)?.accessToken).toBe("TOKEN-A");
      writeFileSync(d.claude, claudeFile("TOKEN-B"));
      const future = new Date(Date.now() + 5000);
      utimesSync(d.claude, future, future);
      expect(r.read("claude", d.claude)?.accessToken).toBe("TOKEN-B");
      // same size + same mtime → served from cache until invalidated
      const st = new Date(future.getTime());
      writeFileSync(d.claude, claudeFile("TOKEN-C"));
      utimesSync(d.claude, st, st);
      expect(r.read("claude", d.claude)?.accessToken).toBe("TOKEN-B");
      r.invalidate(d.claude);
      expect(r.read("claude", d.claude)?.accessToken).toBe("TOKEN-C");
      const outside = join(d.base, "o.json");
      writeFileSync(outside, claudeFile("NOPE"));
      expect(r.read("claude", outside)).toBeNull();
      expect(r.read("claude", undefined)).toBeNull();
    } finally {
      rmSync(d.base, { recursive: true, force: true });
    }
  });

  it("seatsRootDir honours MANTA_STATE_HOME", () => {
    const prev = process.env.MANTA_STATE_HOME;
    try {
      process.env.MANTA_STATE_HOME = "/tmp/some-state";
      expect(t.seatsRootDir()).toBe("/tmp/some-state/.manta-secrets/accounts");
    } finally {
      if (prev === undefined) delete process.env.MANTA_STATE_HOME;
      else process.env.MANTA_STATE_HOME = prev;
    }
  });
});

// ---- the wrapper against a stub fetch --------------------------------------

type Call = { url: string; init: any };
// `files` is the stand-in for the seat credential files: path → creds (null = unreadable).
function rig(opts: { resolve: any; refresh?: any; files?: Record<string, any>; now?: () => number; respond?: (c: Call, n: number) => Response; testUpstream?: string | null }) {
  const calls: Call[] = [];
  const origFetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return opts.respond ? opts.respond({ url, init }, calls.length) : new Response("{}", { status: 200 });
  }) as any;
  const resolveCalls: any[] = [];
  const refreshCalls: any[] = [];
  const files = opts.files ?? {};
  const invalidated: string[] = [];
  const f = t.createAccountsFetch({
    origFetch,
    credentials: {
      read: (_p: string, file: string) => files[file] ?? null,
      invalidate: (file: string) => void invalidated.push(file),
    },
    resolve: async (p: string, ids: any) => {
      resolveCalls.push([p, ids]);
      return opts.resolve(p, ids);
    },
    refresh: async (p: string, s: string) => {
      refreshCalls.push([p, s]);
      return opts.refresh ? opts.refresh(p, s) : null;
    },
    now: opts.now ?? (() => 1_000_000),
    testUpstream: opts.testUpstream ?? null,
  });
  return { f, calls, resolveCalls, refreshCalls, files, invalidated };
}
const sessionInit = (extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { authorization: "Bearer LIVE", "x-opencode-session-id": "ses_1", ...extra },
  body: JSON.stringify({ m: 1 }),
});
const F2 = "/seats/claude/seat-2/.credentials.json";
const seat2 = { seatId: "seat-2", live: false, credentialFile: F2 };
const files2 = (over: any = {}) => ({ [F2]: { accessToken: "SEAT2-TOKEN", expiresAt: 9_000_000, ...over } });
const authOf = (c: Call) => new Headers(c.init.headers).get("authorization");

describe("wrapper", () => {
  it("never touches a non-model request", async () => {
    const r = rig({ resolve: async () => seat2, files: files2() });
    await r.f("https://auth.openai.com/oauth/token", { method: "POST", body: "x" });
    await r.f(CLAUDE, { method: "GET" });
    expect(r.resolveCalls).toHaveLength(0);
    expect(r.calls.map((c) => c.url)).toEqual(["https://auth.openai.com/oauth/token", CLAUDE]);
  });

  it("passes through when the request carries no session id", async () => {
    const r = rig({ resolve: async () => seat2, files: files2() });
    await r.f(CLAUDE, { method: "POST", headers: { authorization: "Bearer LIVE" }, body: "{}" });
    expect(r.resolveCalls).toHaveLength(0);
    expect(authOf(r.calls[0])).toBe("Bearer LIVE");
  });

  it("live seat → the request is passed through byte for byte (same init object)", async () => {
    const r = rig({ resolve: async () => ({ seatId: "seat-1", live: true }) });
    const init = sessionInit();
    await r.f(CLAUDE, init);
    expect(r.calls[0].init).toBe(init);
    expect(r.calls[0].url).toBe(CLAUDE);
  });

  it("non-live seat → the token is read from the FILE and swapped in; URL/method/body/other headers kept", async () => {
    const r = rig({ resolve: async () => seat2, files: files2() });
    await r.f(CLAUDE, sessionInit({ "anthropic-beta": "b" }));
    const h = new Headers(r.calls[0].init.headers);
    expect(h.get("authorization")).toBe("Bearer SEAT2-TOKEN");
    expect(h.get("anthropic-beta")).toBe("b");
    expect(h.get("x-opencode-session-id")).toBe("ses_1");
    expect(r.calls[0].url).toBe(CLAUDE);
    expect(r.calls[0].init.method).toBe("POST");
    expect(r.calls[0].init.body).toBe(JSON.stringify({ m: 1 }));
  });

  it("a credential file that cannot be read (or is outside the seats dir) → live pass-through", async () => {
    const r = rig({ resolve: async () => seat2, files: {} });
    const init = sessionInit();
    await r.f(CLAUDE, init);
    expect(r.calls[0].init).toBe(init);
    expect(authOf(r.calls[0])).toBe("Bearer LIVE");
  });

  it("codex: account id and residency come from the seat's file", async () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_compute_residency: "us" } });
    const F = "/seats/codex/seat-2/auth.json";
    const r = rig({ resolve: async () => ({ seatId: "seat-2", live: false, credentialFile: F }), files: { [F]: { accessToken: token, accountId: "seat-acct", expiresAt: 9_000_000 } } });
    await r.f(CODEX, sessionInit({ "ChatGPT-Account-Id": "live-acct" }));
    const h = new Headers(r.calls[0].init.headers);
    expect(h.get("chatgpt-account-id")).toBe("seat-acct");
    expect(h.get("x-openai-internal-codex-residency")).toBe("us");
    expect(r.resolveCalls[0][0]).toBe("codex");
  });

  it("sends the sub-agent's parent id to resolve and caches per conversation for 30 s", async () => {
    let now = 1_000_000;
    const r = rig({ resolve: async () => seat2, files: files2(), now: () => now });
    const sub = { method: "POST", headers: { "x-opencode-session-id": "c", "x-opencode-parent-session-id": "p" }, body: "{}" };
    await r.f(CLAUDE, sub);
    expect(r.resolveCalls[0][1]).toEqual({ sessionID: "c", parentSessionID: "p" });
    await r.f(CLAUDE, sessionInit({ "x-opencode-session-id": "p" }));
    expect(r.resolveCalls).toHaveLength(1);
    now += 31_000;
    await r.f(CLAUDE, sessionInit({ "x-opencode-session-id": "p" }));
    expect(r.resolveCalls).toHaveLength(2);
  });

  it("resolve down → the last answer for the conversation (and its FILE) is used; none yet → untouched", async () => {
    let now = 1_000_000;
    let up = true;
    const r = rig({ resolve: async () => (up ? seat2 : null), files: files2(), now: () => now });
    const first = rig({ resolve: async () => null });
    await first.f(CLAUDE, sessionInit());
    expect(authOf(first.calls[0])).toBe("Bearer LIVE");

    await r.f(CLAUDE, sessionInit());
    up = false;
    now += 120_000;
    await r.f(CLAUDE, sessionInit());
    expect(authOf(r.calls[1])).toBe("Bearer SEAT2-TOKEN");
  });

  it("a resolver that THROWS is the same as one that is down", async () => {
    const r = rig({ resolve: async () => { throw new Error("boom"); } });
    await r.f(CLAUDE, sessionInit());
    expect(authOf(r.calls[0])).toBe("Bearer LIVE");
  });

  it("a token within 60 s of expiry is refreshed BEFORE sending, then the file is re-read", async () => {
    const r = rig({
      resolve: async () => seat2,
      files: files2({ expiresAt: 1_030_000 }),
      refresh: async () => {
        r.files[F2] = { accessToken: "SEAT2-FRESH", expiresAt: 9_000_000 }; // the server rewrote the file
        return seat2;
      },
    });
    await r.f(CLAUDE, sessionInit());
    expect(r.refreshCalls).toEqual([["claude", "seat-2"]]);
    expect(r.invalidated).toContain(F2);
    expect(authOf(r.calls[0])).toBe("Bearer SEAT2-FRESH");
    // The fresh file is not near expiry: no second refresh.
    await r.f(CLAUDE, sessionInit({ "x-opencode-session-id": "ses_other" }));
    expect(r.refreshCalls).toHaveLength(1);
  });

  it("a failed pre-send refresh still sends with the token in the file", async () => {
    const r = rig({ resolve: async () => seat2, files: files2({ expiresAt: 1_030_000 }), refresh: async () => null });
    await r.f(CLAUDE, sessionInit());
    expect(authOf(r.calls[0])).toBe("Bearer SEAT2-TOKEN");
  });

  it("401 from a non-live seat → refresh once, re-read the file, retry once with the new token", async () => {
    const r = rig({
      resolve: async () => seat2,
      files: files2(),
      refresh: async () => {
        r.files[F2] = { accessToken: "SEAT2-NEW", expiresAt: 9_000_000 };
        return seat2;
      },
      respond: (_c, n) => new Response("{}", { status: n === 1 ? 401 : 200 }),
    });
    const res = await r.f(CLAUDE, sessionInit());
    expect(res.status).toBe(200);
    expect(r.calls).toHaveLength(2);
    expect(authOf(r.calls[1])).toBe("Bearer SEAT2-NEW");
    expect(r.calls[1].init.body).toBe(JSON.stringify({ m: 1 }));
  });

  it("401 and the file still holds the same token → the 401 is returned, no second send", async () => {
    const r = rig({ resolve: async () => seat2, files: files2(), refresh: async () => seat2, respond: () => new Response("no", { status: 401 }) });
    const res = await r.f(CLAUDE, sessionInit());
    expect(res.status).toBe(401);
    expect(r.calls).toHaveLength(1);
  });

  it("401 on a LIVE seat is never retried", async () => {
    const r = rig({ resolve: async () => ({ seatId: "seat-1", live: true }), respond: () => new Response("no", { status: 401 }) });
    expect((await r.f(CLAUDE, sessionInit())).status).toBe(401);
    expect(r.calls).toHaveLength(1);
    expect(r.refreshCalls).toHaveLength(0);
  });

  it("a Request input: body read once and passed explicitly, so the retry can resend it", async () => {
    const r = rig({
      resolve: async () => seat2,
      files: files2(),
      refresh: async () => {
        r.files[F2] = { accessToken: "SEAT2-NEW", expiresAt: 9_000_000 };
        return seat2;
      },
      respond: (_c, n) => new Response("{}", { status: n === 1 ? 401 : 200 }),
    });
    const req = new Request(CLAUDE, { method: "POST", headers: { authorization: "Bearer LIVE", "x-opencode-session-id": "ses_1" }, body: '{"hello":true}' });
    const res = await r.f(req);
    expect(res.status).toBe(200);
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      expect(c.url).toBe(CLAUDE);
      expect(c.init.method).toBe("POST");
      expect(Buffer.from(c.init.body).toString()).toBe('{"hello":true}');
    }
    expect(authOf(r.calls[0])).toBe("Bearer SEAT2-TOKEN");
    expect(authOf(r.calls[1])).toBe("Bearer SEAT2-NEW");
  });

  it("a streaming body is swapped but never retried", async () => {
    const r = rig({ resolve: async () => seat2, files: files2(), refresh: async () => seat2, respond: () => new Response("no", { status: 401 }) });
    const res = await r.f(CLAUDE, { ...sessionInit(), body: new ReadableStream() });
    expect(res.status).toBe(401);
    expect(r.calls).toHaveLength(1);
  });

  it("test upstream: intercepted requests go to the stub, path and query kept, identity still swapped", async () => {
    const r = rig({ resolve: async () => seat2, files: files2(), testUpstream: "http://127.0.0.1:4555" });
    await r.f(CLAUDE, sessionInit());
    expect(r.calls[0].url).toBe("http://127.0.0.1:4555/v1/messages?beta=true");
    expect(authOf(r.calls[0])).toBe("Bearer SEAT2-TOKEN");
    const live = rig({ resolve: async () => ({ seatId: "s", live: true }), testUpstream: "http://127.0.0.1:4555" });
    await live.f(CODEX, sessionInit());
    expect(live.calls[0].url).toBe("http://127.0.0.1:4555/backend-api/codex/responses");
    expect(authOf(live.calls[0])).toBe("Bearer LIVE");
  });
});

describe("plugin install", () => {
  it("wraps globalThis.fetch exactly once, even when loaded twice", async () => {
    const g: any = globalThis;
    const before = g.fetch;
    const key = Symbol.for("manta.accounts.fetch-wrapped");
    try {
      delete g[key];
      await (MantaAccounts as any)({});
      const once = g.fetch;
      expect(once).not.toBe(before);
      await (MantaAccounts as any)({});
      expect(g.fetch).toBe(once);
    } finally {
      g.fetch = before;
      delete g[key];
    }
  });
});
