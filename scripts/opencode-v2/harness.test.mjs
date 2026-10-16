// Unit tests for the pure parts of the V2 harness (no network, no binary).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OPENCODE_V2_VERSION } from "./version.mjs";
import {
  cacheDirFor,
  integrityMatches,
  packageNameFor,
  parseIntegrity,
  platformKey,
} from "./fetch-binary.mjs";
import { basicAuthHeader, freePort, sandboxEnv } from "./sandbox.mjs";
import { startFakeMantaServer } from "./fake-manta-server.mjs";

describe("version pin", () => {
  test("is the spec'd opencode V2 release", () => {
    assert.equal(OPENCODE_V2_VERSION, "2.0.30");
  });
});

describe("fetch-binary helpers", () => {
  test("platformKey / packageNameFor map the host to @opencode/cli-<os>-<cpu>", () => {
    assert.equal(platformKey("linux", "x64"), "linux-x64");
    assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
    assert.equal(packageNameFor("linux", "arm64"), "@opencode/cli-linux-arm64");
    assert.throws(() => platformKey("freebsd", "x64"), /unsupported platform/);
    assert.throws(() => platformKey("linux", "ia32"), /unsupported platform/);
  });

  test("cacheDirFor lives under ~/.cache/manta/opencode-v2/<version> (XDG_CACHE_HOME honoured)", () => {
    assert.equal(cacheDirFor("2.0.30", { XDG_CACHE_HOME: "/c" }), "/c/manta/opencode-v2/2.0.30");
    assert.match(cacheDirFor("2.0.30", {}), /\.cache\/manta\/opencode-v2\/2\.0\.30$/);
  });

  test("integrity: parse + compare the registry's sha512 SRI string", () => {
    const digest = createHash("sha512").update("hello").digest("base64");
    const sri = `sha512-${digest}`;
    assert.deepEqual(parseIntegrity(sri), { algorithm: "sha512", digest });
    assert.equal(integrityMatches(sri, "sha512", digest), true);
    assert.equal(integrityMatches(sri, "sha512", createHash("sha512").update("other").digest("base64")), false);
    assert.equal(integrityMatches(sri, "sha256", digest), false);
    assert.throws(() => parseIntegrity("md5-abc"), /unrecognised integrity/);
    assert.throws(() => parseIntegrity(undefined), /unrecognised integrity/);
  });
});

describe("sandbox helpers", () => {
  test("sandboxEnv redirects HOME + every XDG dir into the root and leaks no parent credentials", () => {
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    process.env.OPENCODE_SERVER_PASSWORD = "must-not-leak";
    const env = sandboxEnv("/tmp/root", { password: "pw", extra: { ANTHROPIC_API_KEY: "given" } });
    assert.equal(env.HOME, "/tmp/root/home");
    for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      assert.ok(env[k].startsWith("/tmp/root/xdg/"), k);
    }
    assert.equal(env.OPENCODE_PASSWORD, "pw");
    assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, "given", "only what the caller passes in");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    assert.equal(sandboxEnv("/r", { password: "p" }).ANTHROPIC_API_KEY, undefined);
  });

  test("freePort never returns the live opencode / manta-server ports", async () => {
    for (let i = 0; i < 10; i++) {
      const p = await freePort();
      assert.ok(p > 1024 && p !== 4096 && p !== 8787);
    }
  });

  test("basicAuthHeader is HTTP Basic with the fixed `opencode` username", () => {
    assert.equal(basicAuthHeader("pw"), `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  });
});

describe("fake manta-server", () => {
  test("records requests and answers canned JSON; enforces the bearer when asked", async () => {
    const fake = await startFakeMantaServer({ token: "tok" });
    try {
      const unauth = await fetch(`${fake.url}/api/schedule?sessionID=ses_1`);
      assert.equal(unauth.status, 401);
      const ok = await fetch(`${fake.url}/api/schedule?sessionID=ses_1`, { headers: { authorization: "Bearer tok" } });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).jobs.length, 2);
      const post = await fetch(`${fake.url}/api/notify`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({ message: "m", sessionID: "ses_1" }),
      });
      assert.deepEqual(await post.json(), { ok: true });
      const notify = fake.requests.find((r) => r.pathname === "/api/notify");
      assert.deepEqual(notify.body, { message: "m", sessionID: "ses_1" });
      assert.equal(notify.authorization, "Bearer tok");
      assert.equal(fake.requests[1].query.sessionID, "ses_1");
      assert.equal((await fetch(`${fake.url}/api/nope`, { headers: { authorization: "Bearer tok" } })).status, 404);
      fake.reset();
      assert.equal(fake.requests.length, 0);
    } finally {
      await fake.stop();
    }
  });
});
