// Tests for the box-side CLI probe (BET-1095 stage 1).
//
// All injected I/O — no real process spawn, no real network, no real fs. The
// npm/brew/vendor decision logic itself is covered in
// src/shared/cliCatalog.test.ts; here we pin the probe glue that feeds it
// (resolveBinary's PATH pinning, readVersion's parsing, fetchLatest's URL
// shapes, detectClis' aggregation + the detector cache).
//
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  resolveBinary,
  readVersion,
  fetchLatest,
  detectClis,
  createCliDetector,
} from "./cliUpdates.mjs";
import { HOME_CLI_INSTALL_DIRS } from "../shared/cliCatalog.mjs";

// ---------------------------------------------------------------------------
// resolveBinary — THE PATH TRAP regression
// ---------------------------------------------------------------------------

// A fake access() that grants X_OK on exactly the given paths.
function makeAccess(executable) {
  const set = new Set(executable);
  return async (p) => {
    if (!set.has(p)) throw new Error("ENOENT");
  };
}

test("resolveBinary: finds a binary in a pinned dir ABSENT from process.env.PATH", async () => {
  // THE regression this exists for: ~/.local/bin (claude) and ~/.opencode/bin
  // (opencode) are added by ~/.bashrc, which a non-login manta-server shell
  // never reads — so they never appear in PATH and the CLI would be invisible
  // without the pinned search.
  const env = {
    HOME: "/home/user",
    PATH: "/usr/bin:/bin", // deliberately does NOT include ~/.local/bin
  };
  const access = makeAccess(["/home/user/.local/bin/claude"]);

  const found = await resolveBinary("claude", { access, env });
  assert.equal(found, "/home/user/.local/bin/claude");
});

test("resolveBinary: returns null when nothing is executable", async () => {
  const env = { HOME: "/home/user", PATH: "/usr/bin:/bin" };
  const access = makeAccess([]);
  assert.equal(await resolveBinary("doesnotexist", { access, env }), null);
});

test("resolveBinary: falls back to a PATH-visible binary not in a pinned dir", async () => {
  const env = { HOME: "/home/user", PATH: "/usr/bin:/home/user/.opencode/bin" };
  const access = makeAccess(["/home/user/.opencode/bin/opencode"]);
  assert.equal(await resolveBinary("opencode", { access, env }), "/home/user/.opencode/bin/opencode");
});

test("resolveBinary: searches EVERY home CLI install dir from the single shared source (BET-1163)", async () => {
  // The home CLI dirs are no longer hardcoded here — they come from
  // HOME_CLI_INSTALL_DIRS (src/shared/cliCatalog.mjs), the SAME constant
  // scripts/self-update.sh consumes (via scripts/list-cli-bin-dirs.mjs). This
  // pins that the detector really consumes the whole shared list: a binary
  // placed ONLY in each listed home dir must be found. If someone adds a dir
  // to the shared source, this test forces resolveBinary to search it too —
  // the drift-trap is structural, not remembered.
  const home = "/home/user";
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  assert.ok(Array.isArray(HOME_CLI_INSTALL_DIRS) && HOME_CLI_INSTALL_DIRS.length > 0);
  for (const rel of HOME_CLI_INSTALL_DIRS) {
    const abs = `${home}/${rel}/somecli`;
    const access = makeAccess([abs]);
    const found = await resolveBinary("somecli", { access, env });
    assert.equal(found, abs, `must search home CLI dir ${home}/${rel}`);
  }
});

// ---------------------------------------------------------------------------
// readVersion
// ---------------------------------------------------------------------------

function fakeSpawnResult({ stdout = "", code = 0, error = false, never = false }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    if (never) return child; // never emits → exercises the timeout path
    process.nextTick(() => {
      if (error) {
        child.emit("error", new Error("spawn failed"));
        return;
      }
      child.stdout.emit("data", stdout);
      child.emit("close", code);
    });
    return child;
  };
}

test("readVersion: parses '2.1.233 (Claude Code)'", async () => {
  const v = await readVersion("/x/claude", {
    spawn: fakeSpawnResult({ stdout: "2.1.233 (Claude Code)" }),
  });
  assert.equal(v, "2.1.233");
});

test("readVersion: parses 'codex-cli 0.147.0'", async () => {
  const v = await readVersion("/x/codex", {
    spawn: fakeSpawnResult({ stdout: "codex-cli 0.147.0" }),
  });
  assert.equal(v, "0.147.0");
});

test("readVersion: returns null on a non-zero exit", async () => {
  const v = await readVersion("/x/claude", {
    spawn: fakeSpawnResult({ stdout: "2.1.233", code: 1 }),
  });
  assert.equal(v, null);
});

test("readVersion: returns null on a spawn error", async () => {
  const v = await readVersion("/x/claude", {
    spawn: fakeSpawnResult({ error: true }),
  });
  assert.equal(v, null);
});

test("readVersion: returns null on unparseable output", async () => {
  const v = await readVersion("/x/claude", {
    spawn: fakeSpawnResult({ stdout: "no version here at all" }),
  });
  assert.equal(v, null);
});

test("readVersion: returns null on timeout (never resolves)", async () => {
  const v = await readVersion("/x/claude", {
    spawn: fakeSpawnResult({ never: true }),
    timeoutMs: 20, // inject a tiny timeout instead of the 10s production default
  });
  assert.equal(v, null);
});

// ---------------------------------------------------------------------------
// fetchLatest
// ---------------------------------------------------------------------------

test("fetchLatest: npm kind reads .version from the registry latest endpoint", async () => {
  let url = null;
  const v = await fetchLatest(
    { latest: { kind: "npm", pkg: "@anthropic-ai/claude-code" } },
    {
      fetchJson: async (u) => {
        url = u;
        return { version: "2.1.233" };
      },
    },
  );
  assert.equal(v, "2.1.233");
  assert.equal(url, "https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
});

test("fetchLatest: github kind reads tag_name and strips a leading v", async () => {
  let url = null;
  const v = await fetchLatest(
    { latest: { kind: "github", repo: "anomalyco/opencode" } },
    {
      fetchJson: async (u) => {
        url = u;
        return { tag_name: "v0.145.0" };
      },
    },
  );
  assert.equal(v, "0.145.0");
  assert.equal(url, "https://api.github.com/repos/anomalyco/opencode/releases/latest");
});

test("fetchLatest: any failure → null (never propagates)", async () => {
  for (const fetchJson of [
    async () => {
      throw new Error("network unreachable");
    },
    async () => ({ no_version_field: true }),
    async () => null,
  ]) {
    assert.equal(
      await fetchLatest({ latest: { kind: "npm", pkg: "@x/y" } }, { fetchJson }),
      null,
    );
  }
});

// ---------------------------------------------------------------------------
// detectClis
// ---------------------------------------------------------------------------

function detectDeps({ installed, versions = {}, latests = {}, root = null, spawn }) {
  const access = makeAccess(installed);
  const getNpmGlobalRoot = async () => root;
  // readVersion uses deps.spawn; default to a "1.0.0" printer per bin.
  const realSpawn =
    spawn ??
    ((bin) =>
      fakeSpawnResult({
        stdout: versions[bin] ?? "1.0.0",
      })());
  const fetchJson = async (url) => {
    // yield a newer latest by default unless overridden
    return latests[url] ?? { version: "9.9.9", tag_name: "v9.9.9" };
  };
  const env = { HOME: "/home/user", PATH: "/usr/bin:/bin" };
  return { access, env, spawn: realSpawn, fetchJson, getNpmGlobalRoot };
}

test("detectClis: omits a non-installed CLI entirely", async () => {
  // Only claude resolves to a binary; the other three are absent from the
  // result array.
  const deps = detectDeps({ installed: ["/home/user/.local/bin/claude"] });
  const result = await detectClis(deps);
  assert.deepEqual(
    result.map((c) => c.id),
    ["claude"],
  );
});

test("detectClis: ok:false when latest is unknown (never reports up to date)", async () => {
  const deps = detectDeps({
    installed: ["/home/user/.local/bin/claude"],
    latests: {},
  });
  const deps2 = { ...deps, fetchJson: async () => null };
  const [claude] = await detectClis(deps2);
  assert.equal(claude.ok, false);
  assert.equal(claude.available, false, "unknown latest must not be 'up to date'");
});

test("detectClis: available is never true when manual is true (brew-managed)", async () => {
  // claude resolved inside /opt/homebrew → resolveUpgradeCommand refuses →
  // manual:true → available must be false even though latest > current.
  const deps = detectDeps({
    installed: ["/opt/homebrew/bin/claude"],
    versions: { "/opt/homebrew/bin/claude": "1.0.0" },
  });
  const [claude] = await detectClis(deps);
  assert.equal(claude.manual, true);
  assert.equal(claude.available, false, "a manual-only upgrade must never be counted as available");
  assert.equal(claude.upgrade, null);
});

test("detectClis: npm-managed binary upgrades via npm (available + non-manual)", async () => {
  // claude resolves to a binary inside the npm global root; the threaded
  // npmGlobalRoot makes resolveUpgradeCommand prefer `npm install -g` over the
  // vendor [`claude`,`update`] (vendor installer would shadow npm's copy).
  const root = "/usr/local/bin";
  const claudePath = `${root}/claude`;
  const deps = detectDeps({
    installed: [claudePath],
    versions: { [claudePath]: "1.0.0" },
    root,
  });
  const [claude] = await detectClis(deps);
  assert.deepEqual(claude.upgrade, ["npm", "install", "-g", "@anthropic-ai/claude-code@latest"]);
  assert.equal(claude.manual, false);
  assert.equal(claude.available, true, "1.0.0 → 9.9.9 with an npm path must be available");
  assert.equal(claude.ok, true);
});

test("detectClis: a plain vendor-managed binary reports available", async () => {
  const path = "/usr/local/bin/claude";
  const deps = detectDeps({
    installed: [path],
    versions: { [path]: "1.0.0" },
  });
  const [claude] = await detectClis(deps);
  assert.equal(claude.manual, false);
  assert.deepEqual(claude.upgrade, ["claude", "update"]);
  assert.equal(claude.available, true);
});

// ---------------------------------------------------------------------------
// createCliDetector — cache + in-flight join
// ---------------------------------------------------------------------------

test("detector: two concurrent detect() calls perform ONE probe round", async () => {
  let rootProbes = 0;
  const byPath = {
    "/usr/local/bin/claude": "1.0.0",
    "/home/user/.opencode/bin/opencode": "1.1.1",
  };
  const deps = detectDeps({
    installed: Object.keys(byPath),
    versions: byPath,
    root: null,
    spawn: (bin) => fakeSpawnResult({ stdout: byPath[bin] })(),
  });
  deps.getNpmGlobalRoot = async () => {
    rootProbes += 1;
    return null;
  };

  const detector = createCliDetector(deps);
  const [a, b] = await Promise.all([detector.detect(), detector.detect()]);
  assert.deepEqual(a, b, "both callers see the SAME result (join, not stale)");
  assert.equal(rootProbes, 1, "two concurrent callers must not double the probe work");

  // A subsequent call within the 5-min TTL serves the cache without probing.
  await detector.detect();
  assert.equal(rootProbes, 1, "cached result must not re-probe");
});

test("detectClis: uses a real default fetchJson when none is injected (regression)", async () => {
  // THE regression: deps.fetchJson had no production default, so every CLI
  // reported latest:null / ok:false and Settings › About said "Couldn't check".
  const deps = detectDeps({ installed: ["/home/user/.local/bin/claude"] });
  delete deps.fetchJson; // exactly how src/server/index.mjs wires it

  const urls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null }, // no etag — keeps the memoized fetcher inert for later tests
      json: async () => ({ version: "9.9.9" }),
    };
  };
  try {
    const [claude] = await detectClis(deps);
    assert.deepEqual(urls, ["https://registry.npmjs.org/@anthropic-ai/claude-code/latest"]);
    assert.equal(claude.latest, "9.9.9");
    assert.equal(claude.ok, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});
