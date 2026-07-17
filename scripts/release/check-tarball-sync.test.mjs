// check-tarball-sync.test.mjs — unit tests for the served-tarball drift check.
//
// Pure: every I/O surface (fetch, file reads, tar extract) is injected via
// `setupScenario`. The only end-to-end exercise is extractTarballPaths's
// default exec, which shells out to system tar against a real synthetic
// tarball — that's a smoke test, not a unit, and it skips itself if tar
// or gzip is unavailable on the test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";

import {
  DEFAULT_TARGETS,
  sha256Hex,
  extractTarballPaths,
  runSyncCheck,
  notifyDrift,
  envTargets,
} from "./check-tarball-sync.mjs";

// ---------------------------------------------------------------------------
// Test fixtures — synthetic repo + tarball contents. Keeps the suite 100%
// in-memory; no real network or real repo files.
// ---------------------------------------------------------------------------

const FAKE_REPO_INSTALL_SH = new TextEncoder().encode(
  "#!/usr/bin/env bash\n# FAKE repo install.sh — version test-fixture\n",
);
const FAKE_REPO_INSTALL_LIB = new TextEncoder().encode(
  "// FAKE repo install-lib.mjs — version test-fixture\nexport const CLI = ['print-config','check-identity','tarball-url'];\n",
);

// ---------------------------------------------------------------------------
// Per-URL fake fetch builder.
// ---------------------------------------------------------------------------

function fakeFetch(perUrl) {
  return async (url, init = {}) => {
    const handler = perUrl[url];
    if (!handler) throw new Error(`fakeFetch: no handler for ${url} (method=${init.method ?? "GET"})`);
    return handler({ url, method: init.method ?? "GET" });
  };
}

function makeRes({ status = 200, body = null } = {}) {
  const finalBody = body ?? new Uint8Array();
  return {
    status,
    arrayBuffer: async () => finalBody.buffer.slice(
      finalBody.byteOffset,
      finalBody.byteOffset + finalBody.byteLength,
    ),
  };
}

// Fake readRepoFile: returns repo bytes for the two paths we ship.
function fakeReadRepoFile(repoBytes) {
  return async (absPath) => {
    if (absPath.endsWith("scripts/install.sh")) return repoBytes.installSh;
    if (absPath.endsWith("scripts/install-lib.mjs")) return repoBytes.installLib;
    return null;
  };
}

// Fake extract: returns the bytes as-is (no shell-out needed in unit tests).
function fakeExtract(map) {
  return async ({ tarball: _tarball, paths }) => {
    const out = new Map();
    for (const p of paths) if (map.has(p)) out.set(p, map.get(p));
    return out;
  };
}

/**
 * Single source of truth for the "happy-path" scenario arguments every test
 * starts from. Tests override only the specific inputs they want to perturb;
 * the rest of the wiring (URLs, body decoding, log) stays identical so the
 * cases below read as "what changed?" not "and now twenty lines of setup".
 *
 * User-supplied fetchOverrides win over the defaults — the spread happens
 * AFTER the defaults so a per-URL override (e.g. a tarball fetch that throws)
 * is the one that fires.
 */
function setupScenario({
  repoBytes = { installSh: FAKE_REPO_INSTALL_SH, installLib: FAKE_REPO_INSTALL_LIB },
  tarballMap = new Map([
    ["scripts/install.sh", FAKE_REPO_INSTALL_SH],
    ["scripts/install-lib.mjs", FAKE_REPO_INSTALL_LIB],
  ]),
  installShBody = FAKE_REPO_INSTALL_SH,
  tarballBody = new Uint8Array([0x00]),
  extractOverride = null,
  fetchOverrides = {},
} = {}) {
  const fetchFn = fakeFetch({
    [DEFAULT_TARGETS.installShUrl]: () => makeRes({ body: installShBody }),
    [DEFAULT_TARGETS.tarballUrl]: () => makeRes({ body: tarballBody }),
    ...fetchOverrides,
  });
  return {
    fetchFn,
    readRepoFile: fakeReadRepoFile(repoBytes),
    extract: extractOverride ?? fakeExtract(tarballMap),
    log: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("DEFAULT_TARGETS points at the canonical mantaui.com URLs", () => {
  assert.equal(DEFAULT_TARGETS.tarballUrl, "https://mantaui.com/releases/manta-latest.tar.gz");
  assert.equal(DEFAULT_TARGETS.installShUrl, "https://mantaui.com/install.sh");
});

test("sha256Hex matches node:crypto.createHash reference", () => {
  const bytes = new TextEncoder().encode("hello");
  assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
});

test("runSyncCheck returns ok:true when served install.sh and tarball contents all match repo", async () => {
  const result = await runSyncCheck(setupScenario());
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("runSyncCheck flags served install.sh drift (BET-171 regression)", async () => {
  const staleInstall = new TextEncoder().encode("# STALE\n");
  const result = await runSyncCheck(setupScenario({
    installShBody: staleInstall,
    tarballMap: new Map(),
  }));
  assert.equal(result.ok, false);
  const drift = result.failures.find((f) => f.what.includes("served install.sh"));
  assert.ok(drift, `expected a served-install.sh drift; got ${JSON.stringify(result.failures)}`);
  assert.equal(drift.kind, "drift");
  assert.equal(drift.repoSha, sha256Hex(FAKE_REPO_INSTALL_SH));
  assert.equal(drift.servedSha, sha256Hex(staleInstall));
});

test("runSyncCheck flags tarball install.sh drift (BET-172)", async () => {
  const staleTarInstall = new TextEncoder().encode("# STALE in tarball\n");
  const result = await runSyncCheck(setupScenario({
    tarballMap: new Map([
      ["scripts/install.sh", staleTarInstall],
      ["scripts/install-lib.mjs", FAKE_REPO_INSTALL_LIB],
    ]),
  }));
  assert.equal(result.ok, false);
  const drift = result.failures.find((f) => f.what.includes("install.sh") && f.what.includes("≠ repo"));
  assert.ok(drift, `expected a tarball install.sh drift; got ${JSON.stringify(result.failures)}`);
  assert.equal(drift.repoSha, sha256Hex(FAKE_REPO_INSTALL_SH));
  assert.equal(drift.tarballSha, sha256Hex(staleTarInstall));
});

test("runSyncCheck flags tarball install-lib.mjs drift (BET-172, the launch-blocking one)", async () => {
  // The pre-BET-170 install-lib.mjs subcommand list — exactly what shipped
  // in the stale tarball that broke the fresh-VPS install.
  const staleTarLib = new TextEncoder().encode(
    "export const CLI = ['print-config','check-identity','tarball-url'];\n",
  );
  const result = await runSyncCheck(setupScenario({
    tarballMap: new Map([
      ["scripts/install.sh", FAKE_REPO_INSTALL_SH],
      ["scripts/install-lib.mjs", staleTarLib],
    ]),
  }));
  assert.equal(result.ok, false);
  const drift = result.failures.find((f) => f.what.includes("install-lib.mjs"));
  assert.ok(drift, `expected a tarball install-lib.mjs drift; got ${JSON.stringify(result.failures)}`);
  assert.equal(drift.repoSha, sha256Hex(FAKE_REPO_INSTALL_LIB));
  assert.equal(drift.tarballSha, sha256Hex(staleTarLib));
});

test("runSyncCheck flags a tarball that lacks install-lib.mjs entirely", async () => {
  const result = await runSyncCheck(setupScenario({
    tarballMap: new Map([
      ["scripts/install.sh", FAKE_REPO_INSTALL_SH],
      // install-lib.mjs missing on purpose
    ]),
  }));
  assert.equal(result.ok, false);
  const miss = result.failures.find((f) => f.what.includes("install-lib.mjs"));
  assert.ok(miss);
  assert.equal(miss.kind, "missing");
});

test("runSyncCheck flags a tarball fetch failure (HTTP 500 / network error)", async () => {
  const result = await runSyncCheck(setupScenario({
    tarballMap: new Map(),
    fetchOverrides: {
      [DEFAULT_TARGETS.tarballUrl]: async () => { throw new Error("ENOTFOUND mantaui.com"); },
    },
  }));
  assert.equal(result.ok, false);
  const f = result.failures.find((x) => x.what.includes("served tarball"));
  assert.ok(f);
  assert.equal(f.kind, "fetch-failed");
});

test("runSyncCheck flags a tarball that 200s but is not actually a tarball (extract yields 0 files)", async () => {
  // Each expected path that didn't come out of the tarball is a distinct
  // "missing" failure — a 200 on a wrong-content body surfaces as two
  // separate "tarball is missing" findings (one per expected file).
  const result = await runSyncCheck(setupScenario({
    tarballBody: new TextEncoder().encode("<!doctype html>not a tarball</html>"),
    tarballMap: new Map(),
  }));
  assert.equal(result.ok, false);
  const missing = result.failures.filter((f) => f.kind === "missing");
  assert.equal(missing.length, 2);
  assert.ok(missing.some((f) => f.what.includes("install.sh")));
  assert.ok(missing.some((f) => f.what.includes("install-lib.mjs")));
});

test("runSyncCheck flags a repo file that doesn't exist (tarball contains it, repo doesn't)", async () => {
  // Repo is missing install-lib.mjs but the tarball DOES ship it — that's a
  // genuine drift case: the operator published a tarball that carries code
  // the repo no longer has.
  const result = await runSyncCheck(setupScenario({
    repoBytes: { installSh: FAKE_REPO_INSTALL_SH, installLib: null },
  }));
  assert.equal(result.ok, false);
  const f = result.failures.find((x) => x.kind === "missing" && x.what.includes("repo"));
  assert.ok(f, `expected a repo-missing failure; got ${JSON.stringify(result.failures)}`);
  assert.match(f.what, /install-lib\.mjs/);
});

test("runSyncCheck flags a tarball extract failure", async () => {
  const result = await runSyncCheck(setupScenario({
    extractOverride: async () => { throw new Error("gzip: not in gzip format"); },
  }));
  assert.equal(result.ok, false);
  const f = result.failures.find((x) => x.kind === "extract-failed");
  assert.ok(f, `expected an extract-failed; got ${JSON.stringify(result.failures)}`);
});

test("notifyDrift is a no-op when MANTA_NOTIFY_URL is unset", async () => {
  const fetchFn = async () => { throw new Error("should not be called"); };
  const out = await notifyDrift({
    failures: [{ kind: "drift", what: "test" }],
    env: {},
    fetchFn,
  });
  assert.equal(out.skipped, true);
  assert.match(out.reason, /MANTA_NOTIFY_URL\/SECRET unset/);
});

test("notifyDrift is a no-op when failures list is empty", async () => {
  const fetchFn = async () => { throw new Error("should not be called"); };
  const out = await notifyDrift({
    failures: [],
    env: { MANTA_NOTIFY_URL: "https://x", MANTA_NOTIFY_SECRET: "s" },
    fetchFn,
  });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "no failures");
});

test("notifyDrift signs the body with HMAC-SHA256 and POSTs it with X-Bui-Signature", async () => {
  let captured = null;
  const fetchFn = async (url, init) => {
    captured = { url, init };
    return { status: 200 };
  };
  const out = await notifyDrift({
    failures: [{ kind: "drift", what: "tarball install-lib.mjs ≠ repo install-lib.mjs" }],
    env: { MANTA_NOTIFY_URL: "https://hooks.example/x", MANTA_NOTIFY_SECRET: "shhh" },
    fetchFn,
    cryptoImpl: { createHmac },
    now: () => "2026-07-17T00:00:00.000Z",
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(captured.url, "https://hooks.example/x");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  const sigHeader = captured.init.headers["X-Bui-Signature"];
  assert.match(sigHeader, /^sha256=[a-f0-9]{64}$/);
  // The signature must equal HMAC-SHA256(secret, body) — independently computed.
  const expected = createHmac("sha256", "shhh").update(captured.init.body).digest("hex");
  assert.equal(sigHeader, `sha256=${expected}`);
  // Body must include the failures list + source + ts.
  const body = JSON.parse(captured.init.body);
  assert.equal(body.source, "check-tarball-sync");
  assert.equal(body.ts, "2026-07-17T00:00:00.000Z");
  assert.deepEqual(body.failures, [{ kind: "drift", what: "tarball install-lib.mjs ≠ repo install-lib.mjs" }]);
});

test("notifyDrift returns ok:false when the webhook returns non-2xx", async () => {
  const fetchFn = async () => ({ status: 500 });
  const out = await notifyDrift({
    failures: [{ kind: "drift", what: "x" }],
    env: { MANTA_NOTIFY_URL: "https://hooks.example/x", MANTA_NOTIFY_SECRET: "s" },
    fetchFn,
    cryptoImpl: { createHmac },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 500);
});

test("envTargets builds the canonical URLs from MANTA_SITE", () => {
  assert.deepEqual(envTargets({}), {
    tarballUrl:   "https://mantaui.com/releases/manta-latest.tar.gz",
    installShUrl: "https://mantaui.com/install.sh",
  });
  assert.deepEqual(
    envTargets({ MANTA_SITE: "https://staging.mantaui.com" }),
    {
      tarballUrl:   "https://staging.mantaui.com/releases/manta-latest.tar.gz",
      installShUrl: "https://staging.mantaui.com/install.sh",
    },
  );
  assert.deepEqual(
    envTargets({
      MANTA_SITE: "https://staging.mantaui.com",
      MANTA_TARBALL_PATH: "/snapshots/foo.tar.gz",
      MANTA_INSTALL_SH_PATH: "/scripts/install.sh",
    }),
    {
      tarballUrl:   "https://staging.mantaui.com/snapshots/foo.tar.gz",
      installShUrl: "https://staging.mantaui.com/scripts/install.sh",
    },
  );
});

// ---------------------------------------------------------------------------
// Smoke test — extractTarballPaths with the real default exec (system tar).
// Skips if tar or gzip is unavailable on the test runner.
// ---------------------------------------------------------------------------

function buildFakeTarball(entries) {
  // entries: [{ name, bytes: Uint8Array }, ...] — built into a USTAR archive
  // with the same root-prefix shape pack.mjs uses ("manta-<version>/...").
  const blocks = [];
  for (const e of entries) {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(e.name).slice(0, 100), 0);
    header.set(new TextEncoder().encode("0000644\0"), 100);
    header.set(new TextEncoder().encode("0000000\0"), 108);
    header.set(new TextEncoder().encode("0000000\0"), 116);
    const sizeOct = e.bytes.length.toString(8).padStart(11, "0") + "\0";
    header.set(new TextEncoder().encode(sizeOct), 124);
    header.set(new TextEncoder().encode("00000000000\0"), 136);
    header.set(new TextEncoder().encode("        "), 148); // checksum placeholder
    header[156] = 0x30; // type flag = regular file
    header.set(new TextEncoder().encode("ustar"), 257);
    header[262] = 0x00;
    header.set(new TextEncoder().encode("00"), 263);
    let chk = 0;
    for (let i = 0; i < 512; i++) chk += header[i];
    const chkOct = chk.toString(8).padStart(6, "0") + "\0 ";
    header.set(new TextEncoder().encode(chkOct), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(e.bytes.length / 512) * 512);
    padded.set(e.bytes);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // EOF marker (two zero blocks)
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const flat = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) { flat.set(b, off); off += b.length; }
  const r = spawnSync("gzip", ["-n"], { input: flat, stdio: ["pipe", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error("gzip not available — cannot build fake tarball");
  return r.stdout;
}

test("extractTarballPaths default exec extracts a real gzipped tar (smoke)", async () => {
  const probe = spawnSync("tar", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) return; // tar missing — skip
  let tarball;
  try {
    tarball = buildFakeTarball([
      { name: "manta-9.9.9/scripts/install.sh", bytes: FAKE_REPO_INSTALL_SH },
      { name: "manta-9.9.9/scripts/install-lib.mjs", bytes: FAKE_REPO_INSTALL_LIB },
    ]);
  } catch {
    return; // gzip missing — skip
  }
  const out = await extractTarballPaths({
    tarball,
    paths: ["scripts/install.sh", "scripts/install-lib.mjs"],
  });
  assert.equal(out.size, 2);
  // fs.readFile returns a Buffer; compare byte-by-byte rather than via
  // deepStrictEqual (which compares by identity for typed arrays).
  assert.equal(Buffer.compare(out.get("scripts/install.sh"), FAKE_REPO_INSTALL_SH), 0);
  assert.equal(Buffer.compare(out.get("scripts/install-lib.mjs"), FAKE_REPO_INSTALL_LIB), 0);
});
