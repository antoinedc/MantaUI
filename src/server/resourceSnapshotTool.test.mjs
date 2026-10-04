// resourceSnapshotTool.test.mjs — exercises the opencode tool registrar
// (docs/opencode-tools/resource-snapshot.ts) WITHOUT a real opencode host.
//
// The tool imports `@opencode-ai/plugin` (absent from this repo) and
// `./manta-auth` (an extensionless sibling). So the test transpiles both .ts
// files with the repo's own `typescript` into a throwaway dir that also holds a
// stub `@opencode-ai/plugin` (its `tool()` is an identity wrapper), then
// imports the transpiled tool and calls `execute` against a local HTTP server.
// Limitation: this proves the registrar's logic, not that opencode itself
// loads it — that still needs the manual copy + `opencode-serve` restart.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(here, "..", "..", "docs", "opencode-tools");
// 32 lowercase hex chars (the shape manta-auth accepts), assembled at runtime so
// no credential-shaped literal sits in the source for the CI secret scan.
const FIXTURE_HEX32 = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16)).join("");

let dir;
let importCounter = 0;
let savedToken;

function transpile(name) {
  const src = readFileSync(join(toolsDir, `${name}.ts`), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return out.replace(/from "\.\/manta-auth"/g, 'from "./manta-auth.mjs"');
}

before(() => {
  // manta-auth reads the token per CALL (and falls back to the real
  // ~/.manta/auth.json), so pin it for the whole suite — never touch the real one.
  savedToken = process.env.MANTA_BOX_TOKEN;
  process.env.MANTA_BOX_TOKEN = FIXTURE_HEX32;
  dir = mkdtempSync(join(tmpdir(), "rs-tool-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const stub = join(dir, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "package.json"), '{"name":"@opencode-ai/plugin","type":"module","exports":"./index.js"}');
  writeFileSync(join(stub, "index.js"), "export const tool = Object.assign((d) => d, { schema: {} });\n");
  writeFileSync(join(dir, "manta-auth.mjs"), transpile("manta-auth"));
  writeFileSync(join(dir, "resource-snapshot.mjs"), transpile("resource-snapshot"));
});

after(() => {
  if (savedToken === undefined) delete process.env.MANTA_BOX_TOKEN;
  else process.env.MANTA_BOX_TOKEN = savedToken;
  rmSync(dir, { recursive: true, force: true });
});

// Import a fresh copy of the tool with the env it reads at module load.
async function loadTool(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const mod = await import(`${pathToFileURL(join(dir, "resource-snapshot.mjs")).href}?v=${++importCounter}`);
    return mod.resource_snapshot;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      }),
    );
  });
}

const GIB = 1024 ** 3;
const SNAPSHOT = {
  ok: true,
  capturedAt: "2026-10-04T12:00:00.000Z",
  memory: {
    totalBytes: 16 * GIB,
    availableBytes: 8 * GIB,
    opencodeCgroup: { currentBytes: 8.5 * GIB, limitBytes: 10 * GIB, availableBytes: 1.5 * GIB },
  },
  cpu: { count: 8, load1: 1, load5: 2, load15: 3 },
  disk: { path: "/work", totalBytes: 100 * GIB, availableBytes: 60 * GIB },
  topProcesses: [{ pid: 42, name: "node", rssBytes: 512 * 1024 ** 2 }],
  containers: { available: false, items: [] },
  status: "constrained",
  suggestedJobMemoryBytes: Math.floor(1.5 * GIB * 0.1),
  warnings: ["docker: not installed", "memory: opencode cgroup headroom is low"],
};

describe("resource_snapshot tool registrar", () => {
  test("formats the snapshot incl. the cgroup budget; sends auth + directory", async () => {
    let seen;
    const srv = await serve((req, res) => {
      seen = { url: req.url, auth: req.headers.authorization, method: req.method };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SNAPSHOT));
    });
    try {
      const t = await loadTool({ MANTA_SERVER_URL: srv.url });
      const out = await t.execute({}, { directory: "/work dir" });
      assert.equal(seen.method, "GET");
      assert.equal(seen.url, "/api/resource-snapshot?directory=%2Fwork+dir");
      assert.equal(seen.auth, `Bearer ${FIXTURE_HEX32}`);
      assert.match(out, /status: constrained/);
      assert.match(out, /Memory \(host\): 8\.0 GiB available of 16\.0 GiB/);
      assert.match(out, /Memory \(opencode cgroup budget\): 1\.5 GiB available — 8\.5 GiB used of 10\.0 GiB limit/);
      assert.match(out, /lower of host and opencode-cgroup available/);
      assert.match(out, /node \(pid 42\)/);
      assert.match(out, /Docker containers: unavailable/);
      assert.match(out, /docker: not installed/);
    } finally {
      await srv.close();
    }
  });

  test("describes an unlimited / unknown cgroup honestly", async () => {
    const snap = (cg) => ({ ...SNAPSHOT, memory: { ...SNAPSHOT.memory, opencodeCgroup: cg } });
    for (const [cg, re] of [
      [{ currentBytes: 2 * GIB, limitBytes: null, availableBytes: null }, /cgroup budget\): 2\.0 GiB used, no limit/],
      [{ currentBytes: null, limitBytes: null, availableBytes: null }, /cgroup budget\): unknown/],
    ]) {
      const srv = await serve((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(snap(cg)));
      });
      try {
        const t = await loadTool({ MANTA_SERVER_URL: srv.url });
        assert.match(await t.execute({}, {}), re);
      } finally {
        await srv.close();
      }
    }
  });

  test("a server error body is surfaced as the thrown message", async () => {
    const srv = await serve((req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "directory must be an absolute path" }));
    });
    try {
      const t = await loadTool({ MANTA_SERVER_URL: srv.url });
      await assert.rejects(t.execute({}, { directory: "rel" }), /directory must be an absolute path/);
    } finally {
      await srv.close();
    }
  });

  test("a hung manta-server is aborted and reported with an actionable error", async () => {
    const srv = await serve(() => {
      /* accept the request and never answer */
    });
    try {
      const t = await loadTool({
        MANTA_SERVER_URL: srv.url,
        MANTA_RESOURCE_SNAPSHOT_TIMEOUT_MS: "150",
      });
      const started = Date.now();
      await assert.rejects(t.execute({}, { directory: "/work" }), (e) => {
        assert.match(e.message, /timed out after 0\.15s waiting for manta-server/);
        assert.match(e.message, /run heavy work serially|retry/);
        assert.match(e.message, /systemctl --user status manta-server/);
        return true;
      });
      assert.ok(Date.now() - started < 3000, "must abort promptly, not hang");
    } finally {
      await srv.close();
    }
  });

  test("a body that stalls after the headers is also aborted", async () => {
    const srv = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":'); // headers + partial body, then silence
    });
    try {
      const t = await loadTool({
        MANTA_SERVER_URL: srv.url,
        MANTA_RESOURCE_SNAPSHOT_TIMEOUT_MS: "150",
      });
      await assert.rejects(t.execute({}, {}), /timed out after/);
    } finally {
      await srv.close();
    }
  });

  test("the default timeout is 10s (source pin)", () => {
    const src = readFileSync(join(toolsDir, "resource-snapshot.ts"), "utf8");
    assert.match(src, /\|\| 10_000/);
    assert.match(src, /signal: controller\.signal/);
  });
});
