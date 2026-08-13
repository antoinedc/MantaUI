// release.test.mjs — node:test cases for scripts/lib/release.sh
//
// Exercises the REAL shell function `replace_release_payload` by sourcing
// scripts/lib/release.sh from a bash subprocess against temp directories.
// scripts/lib/release.sh is a functions-only library (it runs nothing at
// source time) and relies on the `log`/`ok`/`warn`/`die` helpers the CALLER
// owns, so each test defines trivial copies before sourcing it — the same
// contract install.sh / self-update.sh observe.
//
// This is the payload-swap used by packaged self-update: replace every path
// the INCOMING release owns, including the vendored Node `runtime/`, so a
// runtime version bump can actually reach an installed box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_LIB = join(__dirname, "release.sh");
const NODE_CMD = process.execPath; // the node running the test doubles as the box's node

function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

function readTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = p.slice(root.length + 1);
      const st = statSync(p);
      if (st.isDirectory()) {
        out[rel + "/"] = true; // marker so the tree entry exists
        walk(p);
      } else {
        out[rel] = readFileSync(p, "utf8");
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function allPaths(root) {
  const paths = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = p.slice(root.length + 1);
      paths.push(rel);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  if (existsSync(root)) walk(root);
  return paths;
}

/**
 * Source scripts/lib/release.sh (trivial log/ok/warn/die defined first), then
 * call `replace_release_payload <pkg> <dest> <node>`. Runs in a throwaway
 * bash subprocess. Returns { status, stdout }.
 */
function runReplace(pkg, dest) {
  const dir = mkdtempSync(join(tmpdir(), "manta-release-"));
  const script = join(dir, "run.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set +e
log()  { printf 'log: %s\\n' "$*"; }
ok()   { printf 'ok: %s\\n' "$*"; }
warn() { printf 'warn: %s\\n' "$*" >&2; }
die()  { printf 'die: %s\\n' "$*" >&2; exit 1; }
source '${RELEASE_LIB}'
replace_release_payload '${pkg}' '${dest}' '${NODE_CMD}'
exit $?
`,
    { mode: 0o755 },
  );
  try {
    const stdout = execFileSync("bash", [script], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The canonical `includes` self-update.sh ships with today (pack.mjs INCLUDE
// + runtime). Not load-bearing on the function's behaviour — each test passes
// its own — just a realistic fixture.
const PKG_INCLUDES = ["src", "scripts", "docs/opencode-tools", "package.json", "runtime"];

function makePkg(includes) {
  const pkg = mkdtempSync(join(tmpdir(), "manta-rel-pkg-"));
  writeFileSync(
    join(pkg, "RELEASE.json"),
    JSON.stringify(
      { name: "manta", version: "1.0.0", built_at: "2026-08-13T00:00:00.000Z", includes },
    ),
  );
  const tree = {
    "src/server/index.mjs": "new index",
    "scripts/self-update.sh": "new self-update",
    "docs/opencode-tools/peers.ts": "new peers",
    "package.json": "new package",
    "runtime/node/bin/node": "new node binary",
  };
  writeTree(pkg, tree);
  return pkg;
}

// A dest that looks like an already-installed box: it has a pre-existing copy
// of every payload path with OLD contents, plus its OWN installed RELEASE.json
// whose `includes` reflects an older release (notably WITHOUT `runtime`).
function makeInstalledDest() {
  const dest = mkdtempSync(join(tmpdir(), "manta-rel-dest-"));
  writeFileSync(
    join(dest, "RELEASE.json"),
    JSON.stringify({
      name: "manta",
      version: "0.0.19",
      built_at: "2026-01-01T00:00:00.000Z",
      includes: ["src", "scripts", "docs/opencode-tools", "package.json"], // no runtime
    }),
  );
  writeTree(dest, {
    "src/server/index.mjs": "old index",
    "scripts/self-update.sh": "old self-update",
    "package.json": "old package",
  });
  return dest;
}

test("replace_release_payload replaces every included path, including runtime", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest();
  // dest has no runtime yet — install it as content the update must overwrite
  writeTree(dest, { "runtime/node/bin/node": "old node binary" });
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    const tree = readTree(dest);
    assert.equal(tree["src/server/index.mjs"], "new index");
    assert.equal(tree["scripts/self-update.sh"], "new self-update");
    assert.equal(tree["package.json"], "new package");
    assert.equal(tree["runtime/node/bin/node"], "new node binary");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("the list is read from the INCOMING RELEASE.json, not the installed one", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest(); // installed includes omits `runtime`
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    // dest's installed RELEASE.json didn't list runtime, but it must still be
    // replaced because the INCOMING release owns it.
    assert.equal(readTree(dest)["runtime/node/bin/node"], "new node binary");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("dest/RELEASE.json is byte-identical to pkg/RELEASE.json (version stamp advanced)", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest();
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    assert.equal(
      readTree(dest)["RELEASE.json"],
      readTree(pkg)["RELEASE.json"],
    );
    assert.equal(readTree(dest)["RELEASE.json"], readFileSync(join(pkg, "RELEASE.json"), "utf8"));
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("a path in includes but missing from pkg exits non-zero, leaving dest's copy untouched", () => {
  const pkg = mkdtempSync(join(tmpdir(), "manta-rel-pkg-"));
  // includes CLAIM runtime, but the tarball is missing it (torn/corrupt pkg)
  writeFileSync(
    join(pkg, "RELEASE.json"),
    JSON.stringify({ name: "manta", version: "2.0.0", includes: ["runtime"] }),
  );
  const dest = makeInstalledDest();
  writeTree(dest, { "runtime/node/bin/node": "old node binary" });
  try {
    const { status, stdout } = runReplace(pkg, dest);
    assert.notEqual(status, 0);
    assert.match(stdout, /tarball is missing/);
    // dest's existing copy of the missing path is untouched
    assert.equal(readTree(dest)["runtime/node/bin/node"], "old node binary");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("no *.new staging directories survive a successful run", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest();
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    for (const rel of allPaths(dest)) {
      assert.ok(!rel.endsWith(".new"), `staging dir survived: ${rel}`);
      assert.ok(!rel.includes(".new/"), `staging dir survived: ${rel}`);
    }
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
