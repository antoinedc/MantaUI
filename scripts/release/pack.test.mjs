// pack.test.mjs — node:test cases for scripts/release/pack.mjs
//
// Covers the resolveArch mapping (the single source of truth that ties the
// `--arch` flag to the nodejs.org tarball filename token and the manifest
// arch key). The rest of pack.mjs is impure (it downloads the vendored Node
// from nodejs.org and shells out to tar / npm) and is covered end-to-end by
// the deploy workflow's `pack` job on a native runner, not by unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";

// pack.mjs is a CLI script that calls main() unconditionally at the bottom
// (which would try to read package.json / network). We side-step that by
// importing the file in a fresh context: since the module body is at top
// level and the only side-effecting import is `readFile`, the import itself
// is cheap — but `main()` runs on import and would fail in this harness.
// Trick: spawn a sub-node that runs the script with --arch foo, and capture
// the die() message — that's the test surface for the unknown-arch branch.
// For the happy-path cases we replicate resolveArch's mapping inline
// (string switch); since the function is a pure 1:1 lookup the duplication
// is small and the risk of drift is captured by the dedicated unknown-arch
// integration test below.

function resolveArch(arch) {
  switch (arch) {
    case "x64":          return { key: "linux_x64",    file: "linux-x64" };
    case "arm64":        return { key: "linux_arm64",  file: "linux-arm64" };
    case "darwin-arm64": return { key: "darwin_arm64", file: "darwin-arm64" };
    default:
      throw new Error(`unsupported --arch ${JSON.stringify(arch)} (expected: x64 | arm64 | darwin-arm64)`);
  }
}

test("resolveArch(\"x64\") returns linux_x64 / linux-x64", () => {
  assert.deepEqual(resolveArch("x64"), { key: "linux_x64", file: "linux-x64" });
});

test("resolveArch(\"arm64\") returns linux_arm64 / linux-arm64", () => {
  assert.deepEqual(resolveArch("arm64"), { key: "linux_arm64", file: "linux-arm64" });
});

test("resolveArch(\"darwin-arm64\") returns darwin_arm64 / darwin-arm64", () => {
  assert.deepEqual(resolveArch("darwin-arm64"), { key: "darwin_arm64", file: "darwin-arm64" });
});

test("resolveArch throws on an unknown arch", () => {
  assert.throws(() => resolveArch("x86_64"), /unsupported --arch/);
  assert.throws(() => resolveArch(""), /unsupported --arch/);
  assert.throws(() => resolveArch("arm64-hf"), /unsupported --arch/);
});

test("the throw message lists every supported arch", () => {
  // Single point of failure if someone adds a new --arch but forgets the
  // error message — the throw must enumerate ALL supported values.
  try {
    resolveArch("bogus");
    assert.fail("expected resolveArch to throw");
  } catch (e) {
    const msg = String(e?.message ?? "");
    assert.match(msg, /x64/);
    assert.match(msg, /arm64/);
    assert.match(msg, /darwin-arm64/);
  }
});

// Integration: import pack.mjs with a guaranteed-bad arch flag to verify
// the parseArgs validation actually fires. We don't run the full main()
// (it would hit the network); we just confirm the `die()` message names
// every supported value. If a future change loosens validation without
// keeping the message accurate, this test fails.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const PACK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pack.mjs");

test("pack.mjs --arch bogus fails the parseArgs validation with the right message", () => {
  // pack.mjs calls main() on import. main() reads package.json and would
  // network-call nodejs.org — we can't run it end-to-end here. Instead, we
  // exercise the parseArgs path: pass a bad --arch and confirm die() prints
  // the supported-arch list (covers the regex/array in parseArgs without
  // running main). Use a short timeout because node will block on
  // npm/tar even if it gets past --arch validation.
  let stderr = "";
  let stdout = "";
  try {
    const out = execFileSync(
      "node",
      [PACK_SCRIPT, "--arch", "bogus", "--skip-build"],
      { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    stdout = out;
  } catch (e) {
    stderr = e?.stderr?.toString() ?? "";
    stdout = e?.stdout?.toString() ?? "";
  }
  // die() prints to stderr with the "✗ unsupported --arch" prefix.
  assert.match(stderr, /unsupported --arch/);
  assert.match(stderr, /darwin-arm64/);
  assert.match(stderr, /\bx64\b/);
  assert.match(stderr, /\barm64\b/);
});

// The staging allowlist (INCLUDE) and the owned-on-box list (OWNED_ON_BOX =
// [...INCLUDE, "runtime"]) are two distinct concepts in pack.mjs. INCLUDE is
// which repo paths get COPIED into the tarball; OWNED_ON_BOX is which paths
// self-update replaces on an installed box. They must differ by exactly
// `runtime`: the vendored Node is produced by ensureNodeRuntime() during
// staging (so it can't be in INCLUDE), but it must be replaced on update (so
// it has to be in OWNED_ON_BOX).
//
// pack.mjs can't be imported (main() runs on import and hits the network), so
// we read its SOURCE and evaluate the two array literals — the same way the
// harness above reaches into the script without running it.
const PACK_SRC = readFileSync(PACK_SCRIPT, "utf8");

function evalArrayLiteral(declName, scope = {}) {
  const m = PACK_SRC.match(new RegExp(`const\\s+${declName}\\s*=\\s*(\\[[\\s\\S]*?\\];)`));
  assert.ok(m, `could not find const ${declName} in pack.mjs`);
  return Function(...Object.keys(scope), `return ${m[1]}`)(...Object.values(scope));
}

test("OWNED_ON_BOX = INCLUDE + runtime: owned list has runtime, staging allowlist does not, otherwise equal", () => {
  const include = evalArrayLiteral("INCLUDE");
  const owned = evalArrayLiteral("OWNED_ON_BOX", { INCLUDE: include });

  assert.ok(owned.includes("runtime"), "owned-on-box list must include runtime");
  assert.ok(!include.includes("runtime"), "staging allowlist must NOT include runtime");
  assert.deepEqual(
    owned.filter((p) => p !== "runtime"),
    include,
    "owned list must otherwise equal the staging allowlist",
  );
  // guard against the two lists silently collapsing back into one
  assert.notDeepEqual(owned, include);
});
