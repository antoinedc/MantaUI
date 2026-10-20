// Unit tests for the manta-claude-max V2 plugin libs (pure logic + injected I/O;
// no OpenCode, no network, no real credentials).

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta-claude-max", "lib");
const tree = await transpileTree(LIB);
const load = (n) => import(pathToFileURL(join(tree.dir, `${n}.mjs`)).href);
const body = await load("body");
const config = await load("config");
const sse = await load("sse");
const seats = await load("seats");
const creds = await load("creds");
const codex = await load("codex");
const exchange = await load("exchange");

const scratch = mkdtempSync(join(tmpdir(), "manta-cm-test-"));
after(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await tree.cleanup();
});

// ------------------------------------------------------------------ config

describe("config", () => {
  test("version claim: env wins, fallback constant otherwise", () => {
    assert.equal(config.cliVersion({}), config.CC_VERSION_FALLBACK);
    assert.equal(config.cliVersion({ ANTHROPIC_CLI_VERSION: "2.1.300" }), "2.1.300");
    assert.equal(config.userAgent({ ANTHROPIC_CLI_VERSION: "2.1.300" }), "claude-cli/2.1.300 (external, sdk-cli)");
  });

  test("model betas: haiku drops effort, opus-4-5/4-6/4-7 add it, first match wins", () => {
    const eff = "effort-2025-11-24";
    assert.ok(!config.modelBetas("claude-haiku-4-5", undefined, {}).includes(eff));
    assert.ok(config.modelBetas("claude-opus-4-5", undefined, {}).includes(eff));
    assert.ok(config.modelBetas("claude-sonnet-4-6", undefined, {}).includes(eff));
    assert.ok(!config.modelBetas("claude-sonnet-4-5", undefined, {}).includes(eff));
    const ex = new Set(["interleaved-thinking-2025-05-14"]);
    assert.ok(!config.modelBetas("x", ex, {}).includes("interleaved-thinking-2025-05-14"));
  });

  test("long-context error detection", () => {
    assert.ok(config.isLongContextError("You're out of extra usage"));
    assert.ok(!config.isLongContextError("rate limited"));
  });
});

// -------------------------------------------------------------- transformBody

describe("transformBody", () => {
  const input = () =>
    JSON.stringify({
      model: "claude-haiku-5-5",
      system: [{ type: "text", text: `${body.SYSTEM_IDENTITY}\nYou are in OpenCode.`, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "shell", description: "d", input_schema: {} }, { name: "read" }],
      output_config: { effort: "high" },
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world, run it" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });

  test("billing header is system[0]; identity is its own entry; other system text moves to the first user turn", () => {
    const r = body.transformBody(input(), { ANTHROPIC_CLI_VERSION: "2.1.280" });
    assert.ok(r.rewritten);
    const p = JSON.parse(r.body);
    assert.match(p.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/);
    assert.equal(p.system[0].cache_control, undefined);
    assert.equal(p.system[1].text, body.SYSTEM_IDENTITY);
    assert.equal(p.system[1].cache_control, undefined);
    assert.equal(p.system.length, 2);
    assert.match(p.messages[0].content[0].text, /^You are in OpenCode\./);
    assert.equal(p.messages[0].content[1].text, "hello world, run it");
  });

  test("billing signature depends on the first user text and the claimed version", () => {
    const a = body.buildBillingHeaderValue([{ role: "user", content: "abcdefghijklmnopqrstuvwxyz" }], "2.1.280", "sdk-cli");
    const b = body.buildBillingHeaderValue([{ role: "user", content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" }], "2.1.280", "sdk-cli");
    const c = body.buildBillingHeaderValue([{ role: "user", content: "abcdefghijklmnopqrstuvwxyz" }], "2.1.281", "sdk-cli");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.equal(body.computeCch("x").length, 5);
  });

  test("tool names get the PascalCase mcp_ prefix on definitions AND replayed tool_use; the map inverts it", () => {
    const r = body.transformBody(input(), {});
    const p = JSON.parse(r.body);
    assert.deepEqual(p.tools.map((t) => t.name), ["mcp_Shell", "mcp_Read"]);
    assert.equal(p.messages[1].content[0].name, "mcp_Shell");
    assert.equal(r.nameMap.get("mcp_Shell"), "shell");
    assert.equal(r.nameMap.get("mcp_Read"), "read");
    assert.equal(r.model, "claude-haiku-5-5");
  });

  test("the name map handles names the case flip cannot invert", () => {
    const r = body.transformBody(JSON.stringify({ model: "m", tools: [{ name: "Foo_Bar" }, { name: "todo_write" }], messages: [] }), {});
    assert.equal(r.nameMap.get("mcp_Foo_Bar"), "Foo_Bar"); // plain flip would give foo_Bar
    assert.equal(body.stripToolPrefix('{"name":"mcp_Foo_Bar"}', r.nameMap), '{"name":"Foo_Bar"}');
    assert.equal(body.stripToolPrefix('{"name":"mcp_Zed"}', r.nameMap), '{"name":"zed"}'); // unknown → flip
  });

  test("haiku loses effort; other models keep it", () => {
    const h = JSON.parse(body.transformBody(input(), {}).body);
    assert.equal(h.output_config, undefined);
    const o = JSON.parse(body.transformBody(input().replace("claude-haiku-5-5", "claude-opus-4-5"), {}).body);
    assert.equal(o.output_config.effort, "high");
  });

  test("orphan tool_use gets a synthesized adjacent tool_result; orphan tool_result is dropped", () => {
    const orphanUse = JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "shell", input: {} }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ],
    });
    const p = JSON.parse(body.transformBody(orphanUse, {}).body);
    assert.equal(p.messages[2].content[0].type, "tool_result");
    assert.equal(p.messages[2].content[0].tool_use_id, "a");
    assert.equal(p.messages[2].content[0].content, body.TOOL_RESULT_PLACEHOLDER);
    assert.equal(p.messages[2].content[1].text, "next");

    const orphanResult = body.synthesizeMissingToolResults([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "zzz", content: "x" }] },
    ]);
    assert.equal(orphanResult.length, 1);
  });

  test("a body that is not a JSON object is returned untouched", () => {
    for (const raw of ["not json", "[1,2]", "null", ""]) {
      const r = body.transformBody(raw, {});
      assert.equal(r.body, raw);
      assert.equal(r.rewritten, false);
    }
  });

  test("version + entrypoint come from the env", () => {
    const p = JSON.parse(body.transformBody(input(), { ANTHROPIC_CLI_VERSION: "2.1.100", CLAUDE_CODE_ENTRYPOINT: "cli" }).body);
    assert.match(p.system[0].text, /cc_version=2\.1\.100\.[0-9a-f]{3}; cc_entrypoint=cli;/);
  });
});

// ------------------------------------------------------------------ headers

describe("claudeHeaders / withBetaParam", () => {
  test("Bearer swap, Claude Code identity, x-api-key removed, betas merged", () => {
    const incoming = new Headers({ "x-api-key": "k", "anthropic-beta": "custom-beta-1, oauth-2025-04-20", "content-type": "application/json" });
    const h = body.claudeHeaders(incoming, "TOKEN123", "claude-haiku-5-5", undefined, { ANTHROPIC_CLI_VERSION: "2.1.280" });
    assert.equal(h.get("authorization"), "Bearer TOKEN123");
    assert.equal(h.get("x-api-key"), null);
    assert.equal(h.get("x-app"), "cli");
    assert.equal(h.get("anthropic-version"), "2023-06-01");
    assert.equal(h.get("anthropic-dangerous-direct-browser-access"), "true");
    assert.equal(h.get("user-agent"), "claude-cli/2.1.280 (external, sdk-cli)");
    assert.equal(h.get("content-type"), "application/json");
    const betas = h.get("anthropic-beta").split(",");
    assert.ok(betas.includes("custom-beta-1"));
    assert.equal(betas.filter((b) => b === "oauth-2025-04-20").length, 1);
    assert.ok(!betas.includes("effort-2025-11-24"));
    assert.ok(h.get("x-stainless-lang"));
    assert.equal(incoming.get("x-api-key"), "k", "the input headers are not mutated");
  });

  test("?beta=true is appended to /v1/messages only, once", () => {
    assert.equal(body.withBetaParam("https://api.anthropic.com/v1/messages"), "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(body.withBetaParam("https://api.anthropic.com/v1/messages?beta=true"), "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(body.withBetaParam("https://api.anthropic.com/v1/models"), "https://api.anthropic.com/v1/models");
  });
});

// -------------------------------------------------------------- SSE un-prefix

/** Small deterministic PRNG so a failure reproduces. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function sseFixture() {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev("message_start", { type: "message_start", message: { id: "m1", role: "assistant" } }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "héllo — ünïcode ✓ 🎉" } }) +
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "mcp_Shell", input: {} } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"name":"mcp_Notathing"}' } }) +
    ev("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t2", name: "mcp_Todo_write", input: {} } }) +
    ev("message_stop", { type: "message_stop" })
  );
}

describe("SSE un-prefix (R1)", () => {
  const nameMap = new Map([["mcp_Todo_write", "todo_write"], ["mcp_Shell", "shell"]]);
  const text = sseFixture();
  const expected = body.stripToolPrefix(text, nameMap);

  test("sanity: the whole-text rewrite un-prefixes tool names", () => {
    assert.match(expected, /"name":"shell"/);
    assert.match(expected, /"name":"todo_write"/);
  });

  test("PROPERTY: any chunk split of the byte stream gives the same output as the whole text", async () => {
    const bytes = new TextEncoder().encode(text);
    const rand = rng(0xc0ffee);
    for (let iter = 0; iter < 400; iter++) {
      // random cut points — including mid-token and mid-UTF-8-sequence
      const cuts = new Set();
      const n = Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) cuts.add(Math.floor(rand() * bytes.length));
      const points = [0, ...[...cuts].sort((a, b) => a - b), bytes.length];
      const chunks = [];
      for (let i = 0; i < points.length - 1; i++) chunks.push(bytes.slice(points[i], points[i + 1]));
      const stream = new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(ch);
          c.close();
        },
      });
      const out = await sse.unprefixResponse(new Response(stream, { status: 200 }), nameMap).text();
      assert.equal(out, expected, `split ${JSON.stringify(points)}`);
    }
  });

  test("PROPERTY: the pure core agrees for random TEXT splits, and never emits a partial event early", () => {
    const rand = rng(42);
    for (let iter = 0; iter < 300; iter++) {
      const un = sse.createUnprefixer(nameMap);
      let out = "";
      let pos = 0;
      while (pos < text.length) {
        const step = 1 + Math.floor(rand() * 25);
        const piece = text.slice(pos, pos + step);
        pos += step;
        const emitted = un.push(piece);
        out += emitted;
        // anything emitted so far must be a prefix of the expected output ending on an event boundary
        assert.ok(expected.startsWith(out));
        if (out) assert.ok(out.endsWith("\n\n"));
      }
      out += un.flush();
      assert.equal(out, expected);
    }
  });

  test("a stream without event boundaries (plain JSON) is rewritten once at the end", async () => {
    const json = '{"content":[{"type":"tool_use","name":"mcp_Shell"}]}';
    const res = sse.unprefixResponse(new Response(json), nameMap);
    assert.equal(await res.text(), '{"content":[{"type":"tool_use","name":"shell"}]}');
  });

  test("CRLF event boundaries are honoured; status + headers survive; null body passes through", async () => {
    const crlf = 'data: {"name":"mcp_Shell"}\r\n\r\ndata: {"name":"mcp_Read"}\r\n\r\n';
    const res = sse.unprefixResponse(new Response(crlf, { status: 201, headers: { "x-k": "v" } }), nameMap);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("x-k"), "v");
    assert.equal(await res.text(), 'data: {"name":"shell"}\r\n\r\ndata: {"name":"read"}\r\n\r\n');
    const nb = new Response(null, { status: 204 });
    assert.equal(sse.unprefixResponse(nb), nb);
  });
});

// -------------------------------------------------------------------- creds

describe("credentials", () => {
  const root = join(scratch, "state", ".manta-secrets", "accounts");
  const seatFile = join(root, "claude", "seat-1", ".credentials.json");
  mkdirSync(dirname(seatFile), { recursive: true });
  writeFileSync(seatFile, JSON.stringify({ claudeAiOauth: { accessToken: "AT1", expiresAt: 5_000_000_000_000 } }));
  const outside = join(scratch, "outside.json");
  writeFileSync(outside, JSON.stringify({ claudeAiOauth: { accessToken: "EVIL" } }));
  symlinkSync(outside, join(root, "claude", "link.json"));

  test("seat path must be absolute and inside the accounts dir (symlinks resolved)", () => {
    assert.equal(creds.allowedCredentialPath(seatFile, root), seatFile);
    assert.equal(creds.allowedCredentialPath(outside, root), null);
    assert.equal(creds.allowedCredentialPath(join(root, "claude", "link.json"), root), null);
    assert.equal(creds.allowedCredentialPath("relative/path", root), null);
    assert.equal(creds.allowedCredentialPath(join(root, "..", "x"), root), null);
    assert.equal(creds.allowedCredentialPath(root, root), null);
    assert.equal(creds.allowedCredentialPath(undefined, root), null);
  });

  test("seatsRootDir honours MANTA_STATE_HOME", () => {
    assert.equal(creds.seatsRootDir({ MANTA_STATE_HOME: "/s" }), "/s/.manta-secrets/accounts");
  });

  test("reader: seat read, outside path refused, live read, cache keyed by mtime/size, invalidate", () => {
    const live = join(scratch, "live.json");
    writeFileSync(live, JSON.stringify({ claudeAiOauth: { accessToken: "LIVE", expiresAt: 1 } }));
    const r = creds.createCredentialReader({ rootDir: () => root, liveFile: () => live });
    assert.equal(r.readSeat("claude", seatFile).accessToken, "AT1");
    assert.equal(r.readSeat("claude", outside), null);
    assert.equal(r.readLive().accessToken, "LIVE");
    writeFileSync(seatFile, JSON.stringify({ claudeAiOauth: { accessToken: "AT2-longer", expiresAt: 5_000_000_000_000 } }));
    assert.equal(r.readSeat("claude", seatFile).accessToken, "AT2-longer", "a rewritten file (refresh) is re-read");
    r.invalidate(seatFile);
    assert.equal(r.readSeat("claude", seatFile).accessToken, "AT2-longer");
  });

  test("parse: claude + codex shapes; garbage → null", () => {
    assert.deepEqual(creds.parseSeatCredentials("claude", '{"claudeAiOauth":{"accessToken":"a","expiresAt":9}}'), { accessToken: "a", expiresAt: 9 });
    assert.equal(creds.parseSeatCredentials("claude", '{"claudeAiOauth":{}}'), null);
    assert.deepEqual(
      creds.parseSeatCredentials("codex", '{"openai":{"type":"oauth","access":"x","accountId":"acc","expires":7}}'),
      { accessToken: "x", accountId: "acc", expiresAt: 7 },
    );
    assert.equal(creds.parseSeatCredentials("codex", "nope"), null);
  });

  test("expiresSoon: 60 s margin, unknown expiry is not soon", () => {
    assert.equal(creds.expiresSoon(1_000_000 + 59_000, 1_000_000), true);
    assert.equal(creds.expiresSoon(1_000_000 + 61_000, 1_000_000), false);
    assert.equal(creds.expiresSoon(undefined, 1_000_000), false);
  });
});

// -------------------------------------------------------------------- codex

describe("codex headers", () => {
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  test("account id + residency set from the seat; removed when absent", () => {
    const t = jwt({ "https://api.openai.com/auth": { chatgpt_compute_residency: "us" } });
    const h = codex.codexHeaders(new Headers({ authorization: "Bearer old", "ChatGPT-Account-Id": "old", "x-other": "keep" }), { accessToken: t, accountId: "acc" });
    assert.equal(h.get("authorization"), `Bearer ${t}`);
    assert.equal(h.get("ChatGPT-Account-Id"), "acc");
    assert.equal(h.get("x-openai-internal-codex-residency"), "us");
    assert.equal(h.get("x-other"), "keep");
    const h2 = codex.codexHeaders(new Headers({ "ChatGPT-Account-Id": "old", "x-openai-internal-codex-residency": "eu" }), { accessToken: jwt({ chatgpt_compute_residency: "no_constraint" }) });
    assert.equal(h2.get("ChatGPT-Account-Id"), null);
    assert.equal(h2.get("x-openai-internal-codex-residency"), null);
  });
});

// -------------------------------------------------------------------- seats

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const call = { url, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    calls.push(call);
    return handler(call);
  };
  f.calls = calls;
  return f;
}
const jres = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

describe("seat resolver", () => {
  const ids = { sessionID: "s1", parentSessionID: null, model: "claude-haiku-5-5" };

  test("asks resolve with the V1 params + bearer; caches 30 s", async () => {
    let t = 1_000;
    const f = fakeFetch(() => jres({ seatId: "seat-2", live: false, credentialFile: "/x/.manta-secrets/accounts/claude/seat-2/.credentials.json" }));
    const r = seats.createSeatResolver({ fetch: f, base: () => "http://x", token: () => "TOK", now: () => t });
    const a = await r.seatFor("claude", ids);
    assert.equal(a.seatId, "seat-2");
    assert.equal(f.calls[0].path, "/api/accounts/resolve");
    assert.deepEqual(f.calls[0].query, { provider: "claude", sessionID: "s1", model: "claude-haiku-5-5" });
    assert.equal(f.calls[0].headers.authorization, "Bearer TOK");
    await r.seatFor("claude", ids);
    assert.equal(f.calls.length, 1, "cached");
    t += 29_999;
    await r.seatFor("claude", ids);
    assert.equal(f.calls.length, 1);
    t += 2;
    await r.seatFor("claude", ids);
    assert.equal(f.calls.length, 2, "expired after 30 s");
  });

  test("a sub-agent shares its parent's cache key and sends parentSessionID", async () => {
    const f = fakeFetch(() => jres({ seatId: "seat-3", live: true }));
    const r = seats.createSeatResolver({ fetch: f, base: () => "http://x", token: () => null });
    await r.seatFor("claude", { sessionID: "child", parentSessionID: "root", model: null });
    assert.equal(f.calls[0].query.parentSessionID, "root");
    assert.equal(f.calls[0].query.model, undefined);
    assert.equal(f.calls[0].headers.authorization, undefined);
    await r.seatFor("claude", { sessionID: "other-child", parentSessionID: "root", model: null });
    assert.equal(f.calls.length, 1, "same root → one lookup");
    assert.equal(seats.rootKey("claude", { sessionID: "c", parentSessionID: "p" }), "claude|p");
  });

  test("single-flight: concurrent lookups share one request", async () => {
    let release;
    const gate = new Promise((res) => (release = res));
    const f = fakeFetch(async () => {
      await gate;
      return jres({ seatId: "a", live: true });
    });
    const r = seats.createSeatResolver({ fetch: f, base: () => "http://x" });
    const ps = [r.seatFor("claude", ids), r.seatFor("claude", ids), r.seatFor("claude", ids)];
    release();
    await Promise.all(ps);
    assert.equal(f.calls.length, 1);
  });

  test("FAIL-SAFE: error / non-200 / bad JSON → last answer for the conversation, else null (= live login)", async () => {
    let t = 0;
    let mode = "ok";
    const f = fakeFetch(() => {
      if (mode === "ok") return jres({ seatId: "seat-9", live: false, credentialFile: "/f" });
      if (mode === "500") return jres({ error: "x" }, 500);
      if (mode === "junk") return new Response("not json", { status: 200 });
      throw new Error("connection refused");
    });
    const r = seats.createSeatResolver({ fetch: f, base: () => "http://x", now: () => t });
    mode = "500";
    assert.equal(await r.seatFor("claude", ids), null, "no prior answer → null");
    mode = "ok";
    assert.equal((await r.seatFor("claude", ids)).seatId, "seat-9");
    for (const m of ["500", "junk", "throw"]) {
      t += 31_000;
      mode = m;
      assert.equal((await r.seatFor("claude", ids)).seatId, "seat-9", `stale answer reused on ${m}`);
    }
  });

  test("1.5 s timeout: a hung server aborts the call and fails open", async () => {
    const f = fakeFetch(
      (call) =>
        new Promise((_res, rej) => {
          call.signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const r = seats.createSeatResolver({ fetch: f, base: () => "http://x" });
    const t0 = Date.now();
    assert.equal(await r.seatFor("claude", ids), null);
    const took = Date.now() - t0;
    assert.ok(took >= 1400 && took < 3000, `took ${took}ms`);
    assert.equal(seats.RESOLVE_TIMEOUT_MS, 1500);
    assert.equal(seats.REFRESH_TIMEOUT_MS, 30_000);
    assert.equal(seats.LIMIT_TIMEOUT_MS, 10_000);
  });

  test("cache is capped at 500 entries (oldest evicted)", async () => {
    const f = fakeFetch(() => jres({ seatId: "a", live: true }));
    const r = seats.createSeatResolver({ fetch: f, base: () => "http://x" });
    for (let i = 0; i < 501; i++) await r.seatFor("claude", { sessionID: `s${i}`, parentSessionID: null });
    assert.equal(f.calls.length, 501);
    await r.seatFor("claude", { sessionID: "s500", parentSessionID: null });
    assert.equal(f.calls.length, 501, "newest still cached");
    await r.seatFor("claude", { sessionID: "s0", parentSessionID: null });
    assert.equal(f.calls.length, 502, "oldest evicted");
  });

  test("refresh is single-flight per seat and POSTs {provider, seatId}; limit POSTs the ids", async () => {
    let release;
    const gate = new Promise((res) => (release = res));
    const f = fakeFetch(async (c) => {
      if (c.path === "/api/accounts/refresh") await gate;
      return jres({ seatId: "seat-2", live: true, moved: true });
    });
    const r = seats.createSeatResolver({ fetch: f, base: () => "http://x" });
    const ps = [r.refresh("claude", "seat-2"), r.refresh("claude", "seat-2")];
    release();
    await Promise.all(ps);
    assert.equal(f.calls.filter((c) => c.path === "/api/accounts/refresh").length, 1);
    assert.deepEqual(f.calls[0].body, { provider: "claude", seatId: "seat-2" });
    const l = await r.limit("claude", { sessionID: "s", parentSessionID: "p", model: "m" });
    assert.equal(l.moved, true);
    assert.deepEqual(f.calls.at(-1).body, { provider: "claude", sessionID: "s", parentSessionID: "p", model: "m" });
  });

  test("parseResolved: a non-live answer without a credentialFile degrades to live; loopback-only env override", () => {
    assert.deepEqual(seats.parseResolved({ seatId: "x", live: false }), { seatId: "x", live: true });
    assert.equal(seats.parseResolved(null), null);
    assert.equal(seats.loopbackBase("https://evil.example"), null);
    assert.equal(seats.loopbackBase("http://127.0.0.1:9"), "http://127.0.0.1:9");
    assert.equal(seats.serverBase({ MANTA_ACCOUNTS_SERVER: "http://evil.example" }), seats.DEFAULT_SERVER);
  });
});

// ----------------------------------------------------------------- exchange

describe("exchange (request + response hooks)", () => {
  const stateRoot = join(scratch, "ex-state");
  const accounts = join(stateRoot, ".manta-secrets", "accounts", "claude");
  const writeSeat = (name, token, expiresAt = Date.now() + 3_600_000) => {
    const f = join(accounts, name, ".credentials.json");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }));
    return f;
  };
  const liveFile = join(scratch, "ex-live.json");
  writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: { accessToken: "LIVE-TOKEN", expiresAt: Date.now() + 3_600_000 } }));

  const fakeResolver = (over = {}) => {
    const calls = [];
    return {
      calls,
      seatFor: async () => ({ seatId: null, live: true }),
      refresh: async (...a) => (calls.push(["refresh", ...a]), null),
      limit: async (...a) => (calls.push(["limit", ...a]), null),
      forget: (...a) => calls.push(["forget", ...a]),
      remember: (...a) => calls.push(["remember", ...a]),
      ...over,
    };
  };
  const make = (resolver, send = async () => new Response("{}"), extra = {}) =>
    exchange.createExchange({
      resolver,
      credentials: creds.createCredentialReader({ rootDir: () => join(stateRoot, ".manta-secrets", "accounts"), liveFile: () => liveFile }),
      parentOf: async () => null,
      send,
      sleep: async () => {},
      env: { ANTHROPIC_CLI_VERSION: "2.1.280" },
      ...extra,
    });
  const anthropicRequest = () =>
    new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "should-go", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        system: [{ type: "text", text: "sys" }],
        tools: [{ name: "shell" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
  const bearerOf = (req) => req.headers.get("authorization");

  test("no seat → the single login signs the request; body + url rewritten; original untouched stream", async () => {
    const ex = make(fakeResolver());
    const event = { request: anthropicRequest(), sessionID: "s1", kind: "primary", model: { id: "claude-haiku-5-5" } };
    await ex.onRequest(event);
    assert.equal(bearerOf(event.request), "Bearer LIVE-TOKEN");
    assert.equal(event.request.headers.get("x-api-key"), null);
    assert.equal(event.request.url, "https://api.anthropic.com/v1/messages?beta=true");
    const sent = JSON.parse(await event.request.text());
    assert.equal(sent.tools[0].name, "mcp_Shell");
    assert.match(sent.system[0].text, /^x-anthropic-billing-header/);
  });

  test("a seat answer swaps in THAT seat's token (read from the file, never from HTTP)", async () => {
    const file = writeSeat("seat-2", "SEAT-2-TOKEN");
    const ex = make(fakeResolver({ seatFor: async () => ({ seatId: "seat-2", live: false, credentialFile: file }) }));
    const event = { request: anthropicRequest(), sessionID: "s1", kind: "primary" };
    await ex.onRequest(event);
    assert.equal(bearerOf(event.request), "Bearer SEAT-2-TOKEN");
  });

  test("two sessions → two seats", async () => {
    const f1 = writeSeat("seat-a", "TOKEN-A");
    const f2 = writeSeat("seat-b", "TOKEN-B");
    const ex = make(
      fakeResolver({
        seatFor: async (_p, ids) => (ids.sessionID === "A" ? { seatId: "seat-a", live: false, credentialFile: f1 } : { seatId: "seat-b", live: false, credentialFile: f2 }),
      }),
    );
    const a = { request: anthropicRequest(), sessionID: "A" };
    const b = { request: anthropicRequest(), sessionID: "B" };
    await ex.onRequest(a);
    await ex.onRequest(b);
    assert.equal(bearerOf(a.request), "Bearer TOKEN-A");
    assert.equal(bearerOf(b.request), "Bearer TOKEN-B");
  });

  test("a credential file OUTSIDE the accounts dir is ignored → live login", async () => {
    const evil = join(scratch, "evil.json");
    writeFileSync(evil, JSON.stringify({ claudeAiOauth: { accessToken: "EVIL", expiresAt: Date.now() + 9e6 } }));
    const ex = make(fakeResolver({ seatFor: async () => ({ seatId: "x", live: false, credentialFile: evil }) }));
    const event = { request: anthropicRequest(), sessionID: "s" };
    await ex.onRequest(event);
    assert.equal(bearerOf(event.request), "Bearer LIVE-TOKEN");
  });

  test("a seat within 60 s of expiry is refreshed first (server-side), then re-read", async () => {
    const file = writeSeat("seat-exp", "OLD-TOKEN", Date.now() + 10_000);
    const resolver = fakeResolver({
      seatFor: async () => ({ seatId: "seat-exp", live: false, credentialFile: file }),
      refresh: async (p, seatId) => {
        resolver.calls.push(["refresh", p, seatId]);
        writeSeat("seat-exp", "NEW-TOKEN", Date.now() + 3_600_000); // manta-server rewrote the file
        return { seatId, live: false, credentialFile: file };
      },
    });
    const ex = make(resolver);
    const event = { request: anthropicRequest(), sessionID: "s" };
    await ex.onRequest(event);
    assert.deepEqual(resolver.calls[0], ["refresh", "claude", "seat-exp"]);
    assert.equal(bearerOf(event.request), "Bearer NEW-TOKEN");
  });

  test("FAIL OPEN: no credentials anywhere / unrelated host / no session → request left exactly as OpenCode built it", async () => {
    const noCreds = exchange.createExchange({
      resolver: fakeResolver(),
      credentials: creds.createCredentialReader({ rootDir: () => stateRoot, liveFile: () => join(scratch, "does-not-exist.json") }),
      parentOf: async () => null,
      send: async () => new Response("{}"),
    });
    const e1 = { request: anthropicRequest(), sessionID: "s" };
    const orig = e1.request;
    await noCreds.onRequest(e1);
    assert.equal(e1.request, orig);

    const ex = make(fakeResolver());
    const other = new Request("https://example.com/x", { method: "POST", body: "{}" });
    const e2 = { request: other, sessionID: "s" };
    await ex.onRequest(e2);
    assert.equal(e2.request, other);
    const e3 = { request: anthropicRequest() };
    const o3 = e3.request;
    await ex.onRequest(e3);
    assert.equal(e3.request, o3);

    const throwing = make(fakeResolver({ seatFor: async () => { throw new Error("boom"); } }));
    const e4 = { request: anthropicRequest(), sessionID: "s" };
    const o4 = e4.request;
    await throwing.onRequest(e4);
    assert.equal(e4.request, o4, "a throwing resolver never breaks the request");
  });

  test("response hook: success is un-prefixed using the request's own name map", async () => {
    const ex = make(fakeResolver());
    const event = { request: anthropicRequest(), sessionID: "s" };
    await ex.onRequest(event);
    const res = { request: event.request, response: new Response('data: {"type":"content_block_start","content_block":{"name":"mcp_Shell"}}\n\n') };
    await ex.onResponse(res);
    assert.match(await res.response.text(), /"name":"shell"/);
  });

  test("401 → server-side refresh → re-read → retried ONCE with the new token", async () => {
    const file = writeSeat("seat-401", "STALE");
    const sentRequests = [];
    const resolver = fakeResolver({
      seatFor: async () => ({ seatId: "seat-401", live: false, credentialFile: file }),
      refresh: async (p, seatId) => {
        resolver.calls.push(["refresh", p, seatId]);
        writeSeat("seat-401", "FRESH");
        return { seatId, live: false, credentialFile: file };
      },
    });
    const ex = make(resolver, async (req) => (sentRequests.push(req), new Response('{"ok":true}', { status: 200 })));
    const event = { request: anthropicRequest(), sessionID: "s" };
    await ex.onRequest(event);
    const res = { request: event.request, response: new Response('{"error":"expired"}', { status: 401 }) };
    await ex.onResponse(res);
    assert.equal(res.response.status, 200);
    assert.equal(sentRequests.length, 1);
    assert.equal(bearerOf(sentRequests[0]), "Bearer FRESH");
    assert.equal(sentRequests[0].url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(JSON.parse(await sentRequests[0].text()).tools[0].name, "mcp_Shell", "the replayed body keeps the rewrite");
  });

  test("401 with a refresh that fails (the fake server's error) → the original 401 comes back, nothing rotated", async () => {
    const file = writeSeat("seat-fail", "STALE");
    const resolver = fakeResolver({ seatFor: async () => ({ seatId: "seat-fail", live: false, credentialFile: file }), refresh: async () => null });
    const sent = [];
    const ex = make(resolver, async (r) => (sent.push(r), new Response("{}")));
    const event = { request: anthropicRequest(), sessionID: "s" };
    await ex.onRequest(event);
    const res = { request: event.request, response: new Response('{"error":"expired"}', { status: 401 }) };
    await ex.onResponse(res);
    assert.equal(res.response.status, 401);
    assert.equal(sent.length, 0);
  });

  test("429 → /limit; the seat MOVED → retried once on the new seat; same seat → original 429", async () => {
    const fOld = writeSeat("seat-old", "OLD");
    const fNew = writeSeat("seat-new", "NEWSEAT");
    const mk = (answer) => {
      const resolver = fakeResolver({
        seatFor: async () => ({ seatId: "seat-old", live: false, credentialFile: fOld }),
        limit: async (...a) => (resolver.calls.push(["limit", ...a]), answer),
      });
      return resolver;
    };
    // moved
    const r1 = mk({ seatId: "seat-new", live: false, credentialFile: fNew, moved: true });
    const sent = [];
    const ex1 = make(r1, async (req) => (sent.push(req), new Response("{}", { status: 200 })));
    const e1 = { request: anthropicRequest(), sessionID: "s" };
    await ex1.onRequest(e1);
    const out1 = { request: e1.request, response: new Response('{"error":"limit"}', { status: 429, headers: { "retry-after": "9999" } }) };
    await ex1.onResponse(out1);
    assert.equal(out1.response.status, 200);
    assert.equal(bearerOf(sent[0]), "Bearer NEWSEAT");
    assert.ok(r1.calls.some((c) => c[0] === "limit"));
    assert.ok(r1.calls.some((c) => c[0] === "forget"));
    assert.ok(r1.calls.some((c) => c[0] === "remember"));
    // not moved → original 429, retry-after stripped so OpenCode does not park for hours
    const r2 = mk({ seatId: "seat-old", live: false, credentialFile: fOld, moved: false });
    const ex2 = make(r2, async () => assert.fail("must not retry"));
    const e2 = { request: anthropicRequest(), sessionID: "s" };
    await ex2.onRequest(e2);
    const out2 = { request: e2.request, response: new Response('{"error":"limit"}', { status: 429, headers: { "retry-after": "9999" } }) };
    await ex2.onResponse(out2);
    assert.equal(out2.response.status, 429);
    assert.equal(out2.response.headers.get("retry-after"), null);
    assert.match(await out2.response.text(), /limit/, "the body survives");
  });

  test("a SHORT retry-after is slept and retried (V1 fetchWithRetry); a long one is surfaced", async () => {
    const slept = [];
    const sent = [];
    const ex = make(fakeResolver(), async (r) => (sent.push(r), new Response("{}", { status: 200 })), { sleep: async (ms) => slept.push(ms) });
    const e = { request: anthropicRequest(), sessionID: "s" };
    await ex.onRequest(e);
    const out = { request: e.request, response: new Response("{}", { status: 429, headers: { "retry-after": "3" } }) };
    await ex.onResponse(out);
    assert.deepEqual(slept, [3000]);
    assert.equal(out.response.status, 200);
    assert.equal(sent.length, 1);
  });

  test("long-context 400 → long-context betas dropped one per retry (V1 order), then the good response wins", async () => {
    const sent = [];
    const lc = () => new Response(JSON.stringify({ error: { message: "You're out of extra usage" } }), { status: 400 });
    const ex = make(fakeResolver(), async (r) => (sent.push(r), sent.length === 1 ? lc() : new Response("{}", { status: 200 })));
    const e = { request: anthropicRequest(), sessionID: "s" };
    await ex.onRequest(e);
    assert.ok(e.request.headers.get("anthropic-beta").includes("interleaved-thinking-2025-05-14"));
    const out = { request: e.request, response: lc() };
    await ex.onResponse(out);
    assert.equal(out.response.status, 200);
    assert.equal(sent.length, 2);
    assert.ok(sent[0].headers.get("anthropic-beta").includes("interleaved-thinking-2025-05-14"), "1st retry only drops the (absent) 1M beta");
    assert.ok(!sent[1].headers.get("anthropic-beta").includes("interleaved-thinking-2025-05-14"), "2nd retry drops interleaved-thinking");
  });

  test("codex: a seat rewrites the Codex identity headers; the live login is untouched; body never changes", async () => {
    const file = join(stateRoot, ".manta-secrets", "accounts", "codex", "seat-c", "auth.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ openai: { type: "oauth", access: "CODEX-TOKEN", accountId: "acct-9", expires: Date.now() + 9e6 } }));
    const mkReq = () => new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", headers: { authorization: "Bearer opencode-own" }, body: '{"model":"gpt-x"}' });
    const ex = make(fakeResolver({ seatFor: async () => ({ seatId: "seat-c", live: false, credentialFile: file }) }));
    const e = { request: mkReq(), sessionID: "s" };
    await ex.onRequest(e);
    assert.equal(bearerOf(e.request), "Bearer CODEX-TOKEN");
    assert.equal(e.request.headers.get("ChatGPT-Account-Id"), "acct-9");
    assert.equal(e.request.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(await e.request.text(), '{"model":"gpt-x"}');
    const live = make(fakeResolver());
    const e2 = { request: mkReq(), sessionID: "s" };
    const o2 = e2.request;
    await live.onRequest(e2);
    assert.equal(e2.request, o2);
  });

  test("tokens are never logged: log fields carry only a sha12", async () => {
    const lines = [];
    const ex = make(fakeResolver(), undefined, { log: (tag, f) => lines.push(JSON.stringify({ tag, ...f })) });
    await ex.onRequest({ request: anthropicRequest(), sessionID: "s", kind: "primary" });
    const joined = lines.join("\n");
    assert.ok(!joined.includes("LIVE-TOKEN"));
    assert.match(joined, /"tokenSha12":"[0-9a-f]{12}"/);
  });

  test("parent lookup: cached, fail-open (a throwing lookup → null, retried next time)", async () => {
    let n = 0;
    const look = exchange.createParentLookup(async (id) => (n++, id === "kid" ? { data: { parentID: "root" } } : { data: {} }));
    assert.equal(await look("kid"), "root");
    assert.equal(await look("kid"), "root");
    assert.equal(n, 1);
    assert.equal(await look("top"), null);
    const bad = exchange.createParentLookup(async () => { throw new Error("x"); });
    assert.equal(await bad("a"), null);
  });

  test("matchTarget", () => {
    assert.equal(exchange.matchTarget("https://api.anthropic.com/v1/messages", "POST"), "claude");
    assert.equal(exchange.matchTarget("https://chatgpt.com/backend-api/codex/responses", "POST"), "codex");
    assert.equal(exchange.matchTarget("https://chatgpt.com/backend-api/codex/responses", "GET"), null);
    assert.equal(exchange.matchTarget("http://api.anthropic.com/v1/messages", "POST"), null);
    assert.equal(exchange.matchTarget("https://example.com/", "POST"), null);
  });
});

// ------------------------------------------------- cache_control normalisation

describe("normalizeCacheControl (V2: top-level + 4 block breakpoints = HTTP 400 'Found 5')", () => {
  const eph = (ttl) => (ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl });
  const count = (v) => {
    let n = 0;
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (x && typeof x === "object") {
        if ("cache_control" in x) n++;
        Object.values(x).forEach(walk);
      }
    };
    walk(v);
    return n;
  };
  const blockCCs = (p) => {
    const out = [];
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (x && typeof x === "object") {
        if (x.cache_control) out.push(x.cache_control);
        Object.values(x).forEach(walk);
      }
    };
    const { cache_control: _top, ...rest } = p;
    walk(rest);
    return out;
  };

  test("no top-level cache_control → untouched (even with block breakpoints)", () => {
    const p = { system: [{ type: "text", text: "s", cache_control: eph() }], messages: [] };
    const before = JSON.stringify(p);
    assert.equal(body.normalizeCacheControl(p), false);
    assert.equal(JSON.stringify(p), before);
  });

  test("top-level but ZERO block breakpoints → the top-level one is left alone", () => {
    const p = { cache_control: eph("1h"), system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }] };
    const before = JSON.stringify(p);
    assert.equal(body.normalizeCacheControl(p), false);
    assert.equal(JSON.stringify(p), before);
  });

  test("top-level + ONE block breakpoint → top-level removed, block takes its ttl", () => {
    const p = { cache_control: eph("1h"), system: [{ type: "text", text: "s", cache_control: eph() }], messages: [] };
    assert.equal(body.normalizeCacheControl(p), true);
    assert.equal("cache_control" in p, false);
    assert.deepEqual(p.system[0].cache_control, eph("1h"));
  });

  test("top-level + FOUR block breakpoints across tools/system/messages/tool_result → 4 total, all 1h, no top-level", () => {
    const p = {
      model: "m",
      cache_control: eph("1h"),
      tools: [{ name: "a", input_schema: {}, cache_control: eph() }],
      system: [{ type: "text", text: "s", cache_control: eph() }],
      messages: [
        { role: "user", content: [{ type: "text", text: "u", cache_control: eph() }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "a", input: { x: 1 } }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "r", cache_control: eph() }] }],
        },
      ],
    };
    assert.equal(count(p), 5, "fixture reproduces the 5-breakpoint request");
    assert.equal(body.normalizeCacheControl(p), true);
    assert.equal(count(p), 4);
    assert.equal("cache_control" in p, false);
    assert.deepEqual(blockCCs(p), [eph("1h"), eph("1h"), eph("1h"), eph("1h")]);
  });

  test("mixed block ttls (5m after 1h, 1h after 5m, none) all become the top-level ttl, so ordering holds", () => {
    const p = {
      cache_control: eph("1h"),
      system: [
        { type: "text", text: "a", cache_control: eph("5m") },
        { type: "text", text: "b", cache_control: eph("1h") },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "c", cache_control: eph("5m") }, { type: "text", text: "d", cache_control: eph() }] }],
    };
    body.normalizeCacheControl(p);
    assert.deepEqual(blockCCs(p).map((c) => c.ttl), ["1h", "1h", "1h", "1h"]);
    assert.ok(blockCCs(p).every((c) => c.type === "ephemeral"), "other fields are kept");
  });

  test("a top-level without ttl means the default: block ttls are cleared (all 5m)", () => {
    const p = { cache_control: eph(), system: [{ type: "text", text: "a", cache_control: eph("1h") }] };
    body.normalizeCacheControl(p);
    assert.deepEqual(p.system[0].cache_control, eph());
  });

  test("a user tool input that happens to contain a 'cache_control' key is NOT a breakpoint", () => {
    const p = {
      cache_control: eph("1h"),
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: { cache_control: { x: 1 } } }] }],
    };
    assert.equal(body.normalizeCacheControl(p), false);
    assert.ok(p.cache_control, "top-level kept: there were no real block breakpoints");
    assert.deepEqual(p.messages[0].content[0].input.cache_control, { x: 1 });
  });

  test("normalizeCacheControlBody: text in/out, unchanged text returned as the SAME string, garbage fails open", () => {
    const plain = JSON.stringify({ messages: [] });
    assert.deepEqual(body.normalizeCacheControlBody(plain), { body: plain, changed: false });
    assert.deepEqual(body.normalizeCacheControlBody("not json cache_control"), { body: "not json cache_control", changed: false });
    assert.deepEqual(body.normalizeCacheControlBody('"cache_control"'), { body: '"cache_control"', changed: false });
    const five = JSON.stringify({ cache_control: eph("1h"), system: [{ type: "text", text: "s", cache_control: eph() }] });
    const r = body.normalizeCacheControlBody(five);
    assert.equal(r.changed, true);
    assert.equal(JSON.parse(r.body).cache_control, undefined);
    assert.deepEqual(JSON.parse(r.body).system[0].cache_control, eph("1h"));
  });

  test("transformBody (Max path) also normalises, after its own rewrites", () => {
    const raw = JSON.stringify({
      model: "claude-haiku-5-5",
      cache_control: eph("1h"),
      system: [{ type: "text", text: "sys", cache_control: eph() }],
      tools: [{ name: "shell", cache_control: eph() }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: eph() }] }],
    });
    const out = JSON.parse(body.transformBody(raw, { ANTHROPIC_CLI_VERSION: "2.1.280" }).body);
    assert.equal(out.cache_control, undefined);
    assert.ok(blockCCs(out).length >= 1 && blockCCs(out).length <= 4);
    assert.ok(blockCCs(out).every((c) => c.ttl === "1h"));
  });
});

describe("exchange: cache fix runs for EVERY Anthropic request, incl. API-key auth (no credential → no signing)", () => {
  const eph = (ttl) => (ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl });
  const five = () =>
    new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-keep-me", "content-type": "application/json", "content-length": "9999" },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        cache_control: eph("1h"),
        system: [{ type: "text", text: "s", cache_control: eph() }],
        tools: [{ name: "shell", cache_control: eph() }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: eph() }] }],
      }),
    });
  const noCreds = () =>
    exchange.createExchange({
      resolver: { seatFor: async () => null, refresh: async () => null, limit: async () => null, forget() {}, remember() {} },
      credentials: creds.createCredentialReader({ rootDir: () => join(scratch, "no-seats"), liveFile: () => join(scratch, "no-live.json") }),
      parentOf: async () => null,
      send: async () => new Response("{}"),
      env: { ANTHROPIC_CLI_VERSION: "2.1.280" },
    });

  test("API-key request (no identity): headers + rest of body untouched, cache_control fixed", async () => {
    const event = { request: five(), sessionID: "s", kind: "primary" };
    const orig = event.request;
    await noCreds().onRequest(event);
    assert.notEqual(event.request, orig, "request replaced");
    assert.equal(event.request.headers.get("x-api-key"), "sk-ant-keep-me", "the API key is kept");
    assert.equal(event.request.headers.get("authorization"), null, "no Bearer injected");
    assert.equal(event.request.headers.get("content-length"), null, "stale length dropped");
    assert.equal(event.request.url, "https://api.anthropic.com/v1/messages", "no ?beta=true: not Claude Code identity");
    const sent = JSON.parse(await event.request.text());
    assert.equal(sent.cache_control, undefined);
    assert.equal(sent.tools[0].name, "shell", "no tool prefixing");
    assert.equal(sent.system.length, 1, "no billing header / identity injected");
    const ccs = [sent.system[0], sent.tools[0], sent.messages[0].content[0]].map((b) => b.cache_control);
    assert.deepEqual(ccs, [eph("1h"), eph("1h"), eph("1h")]);
  });

  test("request with no sessionID is still fixed", async () => {
    const event = { request: five() };
    await noCreds().onRequest(event);
    assert.equal(JSON.parse(await event.request.text()).cache_control, undefined);
  });

  test("an API-key request with nothing to fix is left as the very same Request", async () => {
    const plain = new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ messages: [] }) });
    const event = { request: plain, sessionID: "s" };
    await noCreds().onRequest(event);
    assert.equal(event.request, plain);
  });

  test("a non-Anthropic request is never touched", async () => {
    const other = new Request("https://example.com/v1/messages", { method: "POST", body: await five().text() });
    const event = { request: other, sessionID: "s" };
    await noCreds().onRequest(event);
    assert.equal(event.request, other);
  });

  test("the Claude Max path (identity found) sends ≤4 breakpoints, all 1h, no top-level", async () => {
    const liveFile = join(scratch, "cache-live.json");
    writeFileSync(liveFile, JSON.stringify({ claudeAiOauth: { accessToken: "LIVE", expiresAt: Date.now() + 3_600_000 } }));
    const ex = exchange.createExchange({
      resolver: { seatFor: async () => ({ seatId: null, live: true }), refresh: async () => null, limit: async () => null, forget() {}, remember() {} },
      credentials: creds.createCredentialReader({ rootDir: () => join(scratch, "no-seats"), liveFile: () => liveFile }),
      parentOf: async () => null,
      send: async () => new Response("{}"),
      env: { ANTHROPIC_CLI_VERSION: "2.1.280" },
    });
    const event = { request: five(), sessionID: "s", kind: "primary" };
    await ex.onRequest(event);
    assert.equal(event.request.headers.get("authorization"), "Bearer LIVE");
    const sent = JSON.parse(await event.request.text());
    assert.equal(sent.cache_control, undefined);
    const all = [...sent.system, ...sent.tools, ...sent.messages.flatMap((m) => m.content)].map((b) => b.cache_control).filter(Boolean);
    assert.ok(all.length >= 1 && all.length <= 4);
    assert.ok(all.every((c) => c.ttl === "1h"));
  });
});
