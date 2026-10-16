// Unit tests for the plugin's shared libs (lib/server.ts, lib/context.ts).

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta", "lib");
const tree = await transpileTree(LIB);
const server = await import(pathToFileURL(join(tree.dir, "server.mjs")).href);
const context = await import(pathToFileURL(join(tree.dir, "context.mjs")).href);
const schema = await import(pathToFileURL(join(tree.dir, "schema.mjs")).href);

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
after(async () => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
  await tree.cleanup();
});

describe("server.boxToken / authHeaders", () => {
  const home = mkdtempSync(join(tmpdir(), "manta-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));

  test("MANTA_BOX_TOKEN wins; no body → no content-type", () => {
    process.env.MANTA_BOX_TOKEN = "envtoken";
    assert.deepEqual(server.authHeaders(), { authorization: "Bearer envtoken" });
    assert.deepEqual(server.authHeaders({ a: 1 }), {
      "content-type": "application/json",
      authorization: "Bearer envtoken",
    });
  });

  test("falls back to ~/.manta/auth.json box_token (32 hex only), re-read every call", () => {
    delete process.env.MANTA_BOX_TOKEN;
    process.env.HOME = home;
    assert.equal(server.boxToken(), null, "no store yet → no header");
    mkdirSync(join(home, ".manta"));
    const good = "a".repeat(32);
    writeFileSync(join(home, ".manta", "auth.json"), JSON.stringify({ box_token: good }));
    assert.equal(server.boxToken(), good);
    writeFileSync(join(home, ".manta", "auth.json"), JSON.stringify({ box_token: "b".repeat(32) }));
    assert.equal(server.boxToken(), "b".repeat(32), "rotation picked up without a restart");
    writeFileSync(join(home, ".manta", "auth.json"), JSON.stringify({ box_token: "not-hex" }));
    assert.equal(server.boxToken(), null);
    writeFileSync(join(home, ".manta", "auth.json"), "{ not json");
    assert.equal(server.boxToken(), null);
  });

  test("serverUrl defaults to loopback 8787 and honours MANTA_SERVER_URL", () => {
    delete process.env.MANTA_SERVER_URL;
    assert.equal(server.serverUrl(), "http://127.0.0.1:8787");
    process.env.MANTA_SERVER_URL = "http://x:1";
    assert.equal(server.serverUrl(), "http://x:1");
  });
});

describe("server.call error semantics", () => {
  process.env.MANTA_SERVER_URL = "http://manta.test";
  process.env.MANTA_BOX_TOKEN = "t";
  const reply = (status, text) => {
    globalThis.fetch = async () => new Response(text, { status });
  };

  test("2xx JSON → parsed; empty body → {}", async () => {
    reply(200, '{"a":1}');
    assert.deepEqual(await server.call("GET", "/x"), { a: 1 });
    reply(200, "");
    assert.deepEqual(await server.call("GET", "/x"), {});
  });

  test("non-2xx throws json.error, then `manta-server <status>`, and wraps non-JSON text", async () => {
    reply(400, '{"error":"bad thing"}');
    await assert.rejects(server.call("GET", "/x"), /^Error: bad thing$/);
    reply(502, "{}");
    await assert.rejects(server.call("GET", "/x"), /^Error: manta-server 502$/);
    reply(500, "plain text failure");
    await assert.rejects(server.call("GET", "/x"), /^Error: plain text failure$/);
  });
});

describe("context.resolveToolContext (directory resolution)", () => {
  test("uses the plugin instance's location.directory (per-location instance)", async () => {
    const out = await context.resolveToolContext(
      { location: { directory: "/a" } },
      { sessionID: "ses_1", messageID: "msg_1", agent: "build" },
    );
    assert.deepEqual(out, { sessionID: "ses_1", messageID: "msg_1", directory: "/a" });
  });

  test("falls back to the session record's location when the plugin has none", async () => {
    let asked;
    const out = await context.resolveToolContext(
      {
        session: {
          get: async ({ sessionID }) => {
            asked = sessionID;
            return { location: { directory: "/from-session" } };
          },
        },
      },
      { sessionID: "ses_2" },
    );
    assert.equal(asked, "ses_2");
    assert.equal(out.directory, "/from-session");
  });

  test("a failing session lookup leaves directory undefined instead of failing the tool", async () => {
    const out = await context.resolveToolContext(
      { session: { get: async () => Promise.reject(new Error("gone")) } },
      { sessionID: "ses_3" },
    );
    assert.equal(out.directory, undefined);
    assert.equal(out.sessionID, "ses_3");
  });
});

describe("schema builders", () => {
  test("input() marks everything required except the optional names", () => {
    const s = schema.input({ a: schema.str("A"), b: schema.num() }, ["b"]);
    assert.deepEqual(s, {
      type: "object",
      properties: { a: { type: "string", description: "A" }, b: { type: "number" } },
      required: ["a"],
      additionalProperties: false,
    });
  });

  test("noInput() is a closed empty object with no `required`", () => {
    assert.deepEqual(schema.noInput(), { type: "object", properties: {}, additionalProperties: false });
  });
});
