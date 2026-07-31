// Tests for the /api/version route (BET-180).
//
// Coverage:
//   - readServerVersion: pure, with injected fs (no real IO during the test,
//     per BET-180 spec). Asserts the version literal round-trips, FALLBACK
//     fires on every failure path.
//   - writeVersionResponse: pure — asserts the captured response shape
//     matches { version }.
//   - HTTP route + auth gate: spins up a minimal server with the real
//     handler + an authEngine built from a known box_token. Asserts 401
//     when no Bearer, 200 + body when Bearer present.
//
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import http from "node:http";
import {
  readServerVersion,
  readOpencodeVersion,
  writeVersionResponse,
  FALLBACK_VERSION,
  MIN_CLIENT,
} from "./version.mjs";
import {
  ensureAuth,
  createAuthEngine,
  authorizationForRequest,
  queryTokenAllowedForPath,
  isExemptPath,
} from "./auth.mjs";

// Minimal fs stub — captures the path + returns whatever the test sets.
// Avoids real disk IO per BET-180's "inject the fs read" requirement.
function makeFsStub(contents) {
  return {
    lastPath: null,
    async readFile(path) {
      this.lastPath = path;
      if (contents === undefined) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return contents;
    },
  };
}

// ---------------------------------------------------------------------------
// readServerVersion
// ---------------------------------------------------------------------------

test("readServerVersion returns the version field from package.json", async () => {
  const fs = makeFsStub(JSON.stringify({ version: "1.2.3", name: "manta-ui" }));
  const v = await readServerVersion("/repo", fs);
  assert.equal(v, "1.2.3");
  assert.ok(fs.lastPath && fs.lastPath.endsWith("package.json"));
});

test("readServerVersion returns FALLBACK_VERSION on missing file", async () => {
  const fs = makeFsStub(undefined); // throws ENOENT
  const v = await readServerVersion("/repo", fs);
  assert.equal(v, FALLBACK_VERSION);
});

test("readServerVersion returns FALLBACK_VERSION on malformed JSON", async () => {
  const fs = makeFsStub("{ not json");
  const v = await readServerVersion("/repo", fs);
  assert.equal(v, FALLBACK_VERSION);
});

test("readServerVersion returns FALLBACK_VERSION when version field is missing or wrong type", async () => {
  for (const bad of [
    JSON.stringify({ name: "no-version" }),
    JSON.stringify({ version: "" }),
    JSON.stringify({ version: 42 }),
    JSON.stringify({ version: null }),
  ]) {
    const v = await readServerVersion("/repo", makeFsStub(bad));
    assert.equal(v, FALLBACK_VERSION, `expected FALLBACK for ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// readOpencodeVersion (BET-428)
// ---------------------------------------------------------------------------
// opencode's HTTP API exposes no version endpoint, so the server shells out
// to `opencode --version` once at startup. `exec` is injectable (mirrors the
// fs-injection contract readServerVersion uses) so no real subprocess runs
// during the test. The stub returns a Buffer/string the same way execFileSync
// would; we assert parsing + every failure path falls back to FALLBACK_VERSION.

test("readOpencodeVersion parses a clean version string from execFileSync stdout", () => {
  const exec = () => "1.18.10\n";
  assert.equal(readOpencodeVersion(exec), "1.18.10");
});

test("readOpencodeVersion takes the last token when stdout has a prefix", () => {
  // Robust to a future `opencode version 1.18.10`-style output without
  // coupling to a fixed format.
  const exec = () => "opencode version 1.18.10\n";
  assert.equal(readOpencodeVersion(exec), "1.18.10");
});

test("readOpencodeVersion trims trailing whitespace / newlines", () => {
  const exec = () => "  1.2.3  \n\n";
  assert.equal(readOpencodeVersion(exec), "1.2.3");
});

test("readOpencodeVersion returns FALLBACK_VERSION when the command throws (ENOENT — opencode not installed)", () => {
  const exec = () => {
    const err = new Error("spawn opencode ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  assert.equal(readOpencodeVersion(exec), FALLBACK_VERSION);
});

test("readOpencodeVersion returns FALLBACK_VERSION when stdout is empty", () => {
  const exec = () => "";
  assert.equal(readOpencodeVersion(exec), FALLBACK_VERSION);
});

test("readOpencodeVersion returns FALLBACK_VERSION when stdout is only whitespace", () => {
  const exec = () => "   \n\t\n";
  assert.equal(readOpencodeVersion(exec), FALLBACK_VERSION);
});

test("readOpencodeVersion returns FALLBACK_VERSION on non-zero exit (child returns empty)", () => {
  // execFileSync throws on non-zero exit; the catch maps it to FALLBACK.
  const exec = () => {
    throw new Error("Command failed: opencode --version");
  };
  assert.equal(readOpencodeVersion(exec), FALLBACK_VERSION);
});

// ---------------------------------------------------------------------------
// writeVersionResponse (pure)
// ---------------------------------------------------------------------------

test("writeVersionResponse writes 200 + JSON { version, minClient, opencodeVersion }", () => {
  let captured = null;
  const fakeRes = {
    writeHead(status, headers) {
      this._status = status;
      this._headers = headers;
    },
    end(body) {
      captured = { status: this._status, headers: this._headers, body };
    },
  };
  writeVersionResponse(fakeRes, { version: "9.9.9", opencodeVersion: "1.18.10" });
  assert.equal(captured.status, 200);
  assert.equal(captured.headers["content-type"], "application/json");
  const body = JSON.parse(captured.body);
  assert.equal(body.version, "9.9.9");
  // minClient MUST be present so the renderer's version-skew guard can
  // compute isClientTooOld without a second endpoint/polling cycle
  // (BET-225 stage 2 server side; renderer consumes in stage 3).
  assert.equal(body.minClient, MIN_CLIENT);
  assert.equal(typeof body.minClient, "string");
  assert.ok(body.minClient.length > 0);
  // BET-428: opencodeVersion MUST be present so Settings → About renders it
  // in the same getServerVersion round-trip — no new IPC channel.
  assert.equal(body.opencodeVersion, "1.18.10");
});

test("writeVersionResponse defaults opencodeVersion to FALLBACK_VERSION when omitted", () => {
  // Backward-compat: the BET-180 callers (and the existing route test below)
  // pass only { version }. The response must still carry opencodeVersion so
  // the renderer's destructure never hits `undefined`; it falls back to
  // "0.0.0" which the About block hides.
  let captured = null;
  const fakeRes = {
    writeHead() {},
    end(body) { captured = body; },
  };
  writeVersionResponse(fakeRes, { version: "1.2.3" });
  const body = JSON.parse(captured);
  assert.equal(body.opencodeVersion, FALLBACK_VERSION);
});

// ---------------------------------------------------------------------------
// HTTP route + auth gate
// ---------------------------------------------------------------------------
// Booting the full src/server/index.mjs is heavy (tmux + opencode + relay +
// push + websocket pumps). Instead, mirror just the /api/version route's
// shape — path match + auth gate + handler — using the SAME auth helpers
// src/server/index.mjs calls, so we prove the wiring without standing up
// every subsystem.

const HEY_HEX32 = "0123456789abcdef0123456789abcdef";
const BOX_ID = "fedcba9876543210fedcba9876543210";

function httpRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function startVersionServer(version, opencodeVersion = FALLBACK_VERSION) {
  // Real ensureAuth writes to ~/.manta/auth.json — avoid touching disk in
  // tests, so build an auth engine from a hand-rolled boxAuth with the
  // well-known HEX32 token. createAuthEngine doesn't care where the auth
  // object came from as long as it has box_token + box_id + version.
  const boxAuth = {
    box_id: BOX_ID,
    box_token: HEY_HEX32,
    version: 1,
  };
  // saveAuth/deleteAuth are stubbed for the same reason: their defaults write
  // the real ~/.manta/auth.json, so any future revoke() here would rotate the
  // identity of the machine running the suite.
  const authEngine = createAuthEngine({
    auth: boxAuth,
    enforce: true,
    saveAuth: async () => {},
    deleteAuth: async () => {},
  });

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Parse the URL just enough to do path matching.
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;

      // ---- Auth gate (mirrors src/server/index.mjs lines 599-623) ----
      const gate = authEngine.authorize({
        method: req.method,
        path,
        authorization: authorizationForRequest(
          path,
          req.headers["authorization"],
          url.searchParams.get("token"),
        ),
      });
      if (!gate.ok) {
        res.writeHead(gate.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: gate.error }));
        return;
      }

      // ---- /api/version route (mirrors src/server/index.mjs) ----
      if (req.method === "GET" && path === "/api/version") {
        writeVersionResponse(res, { version, opencodeVersion });
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test("/api/version returns 401 when no Bearer present", async () => {
  const { server, port } = await startVersionServer("1.2.3-test");
  try {
    const res = await httpRequest(port, "/api/version");
    assert.equal(res.status, 401);
    assert.match(res.body, /"error"/);
  } finally {
    server.close();
  }
});

test("/api/version returns 401 when Bearer is wrong", async () => {
  const { server, port } = await startVersionServer("1.2.3-test");
  try {
    const res = await httpRequest(port, "/api/version", {
      authorization: `Bearer ${"f".repeat(32)}`,
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("/api/version returns 200 + { version, minClient, opencodeVersion } when Bearer present", async () => {
  const { server, port } = await startVersionServer("1.2.3-test", "1.18.10");
  try {
    const res = await httpRequest(port, "/api/version", {
      authorization: `Bearer ${HEY_HEX32}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json");
    const body = JSON.parse(res.body);
    assert.equal(body.version, "1.2.3-test");
    // Same skew-guard contract as the writeVersionResponse test — the route
    // surface MUST surface minClient to the renderer's `getServerVersion()`
    // consumer in stage 3.
    assert.equal(body.minClient, MIN_CLIENT);
    // BET-428: opencodeVersion MUST be present so Settings → About renders it
    // in the same round-trip — no new IPC channel.
    assert.equal(body.opencodeVersion, "1.18.10");
  } finally {
    server.close();
  }
});

test("/api/version falls through the auth gate (NOT exempt)", () => {
  // Sanity: the route must be gated, not the public /hook/<token> /auth/* set.
  // (BET-180 spec: "Bearer-gated like the other /api/* routes".) If this
  // changes, the gate disappears and the 401 test above silently turns into
  // an unauthenticated 200 — flag it here.
  assert.equal(isExemptPath("/api/version"), false);
  assert.equal(queryTokenAllowedForPath("/api/version"), false);
});
