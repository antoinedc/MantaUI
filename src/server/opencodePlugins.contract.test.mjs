// The guard that the JS plugin sync (opencodePlugins.mjs, run at server startup)
// and the shell one (scripts/lib/release.sh sync_opencode_plugins, run by
// install.sh / self-update.sh) stay the same thing. Each scenario is applied,
// step by step, to TWO identical sandboxes — one synced by each implementation —
// and after every step the destination tree, the manifest, and the "did anything
// change" verdict must be identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncOpencodePlugins } from "./opencodePlugins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RELEASE_SH = join(here, "..", "..", "scripts", "lib", "release.sh");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "plugins-contract-"));
  const box = { root, src: join(root, "src"), dest: join(root, "cfg", "plugins"), manifest: join(root, "state", ".manta", "opencode-plugins.manifest") };
  mkdirSync(box.src, { recursive: true });
  return box;
}

function runShell(box) {
  const script = `set +e
log() { :; }; ok() { :; }; warn() { :; }; die() { exit 1; }
. '${RELEASE_SH}'
sync_opencode_plugins '${box.src}' '${box.dest}' '${box.manifest}' >/dev/null 2>&1
echo "CHANGED=$PLUGINS_CHANGED"`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  return /CHANGED=1/.test(out);
}
const runJs = async (box) => (await syncOpencodePlugins({ srcDir: box.src, destDir: box.dest, manifestPath: box.manifest })).changed;

function snapshot(box) {
  const tree = {};
  if (existsSync(box.dest)) {
    for (const name of readdirSync(box.dest).sort()) {
      const p = join(box.dest, name);
      const l = lstatSync(p);
      tree[name] = l.isSymbolicLink() ? "<symlink>" : readFileSync(p, "utf8");
    }
  }
  return { tree, manifest: existsSync(box.manifest) ? readFileSync(box.manifest, "utf8") : null };
}

const write = (box, where, name, body) => {
  const dir = where === "src" ? box.src : box.dest;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};
const rm = (box, where, name) => rmSync(join(where === "src" ? box.src : box.dest, name), { force: true });

/** Apply every step to both boxes, then sync both and compare. */
async function scenario(name, steps) {
  const sh = sandbox();
  const js = sandbox();
  try {
    for (const [label, step] of steps) {
      step(sh);
      step(js);
      const shChanged = runShell(sh);
      const jsChanged = await runJs(js);
      assert.deepEqual(snapshot(js), snapshot(sh), `${name} / ${label}: dest tree + manifest differ`);
      assert.equal(jsChanged, shChanged, `${name} / ${label}: "changed" verdict differs`);
    }
  } finally {
    rmSync(sh.root, { recursive: true, force: true });
    rmSync(js.root, { recursive: true, force: true });
  }
}

test("contract: fresh install, unchanged re-run, change, removal", async () => {
  await scenario("lifecycle", [
    ["fresh", (b) => { write(b, "src", "manta-accounts.ts", "A1"); write(b, "src", "manta-optimizer.ts", "O1"); }],
    ["re-run (no-op)", () => {}],
    ["change one", (b) => write(b, "src", "manta-accounts.ts", "A2")],
    ["stop shipping one", (b) => rm(b, "src", "manta-optimizer.ts")],
    ["re-run again (no-op)", () => {}],
  ]);
});

test("contract: the user's own files and *.test.ts are never installed or touched", async () => {
  await scenario("user files", [
    ["user plugin pre-exists, test file shipped", (b) => {
      write(b, "dest", "mine.ts", "USER");
      write(b, "src", "manta-accounts.ts", "A");
      write(b, "src", "manta-accounts.test.ts", "import 'vitest'");
      write(b, "src", "readme.md", "not a plugin");
    }],
    ["release drops its plugin; the user's stays", (b) => rm(b, "src", "manta-accounts.ts")],
  ]);
});

test("contract: a hand-edited copy is restored; a name collision with a manual copy is taken over; a symlink becomes a real file", async () => {
  await scenario("edits", [
    ["manual copy already there", (b) => { write(b, "dest", "manta-optimizer.ts", "MANUAL"); write(b, "src", "manta-optimizer.ts", "NEW"); }],
    ["hand edit", (b) => write(b, "dest", "manta-optimizer.ts", "edited by hand")],
    ["symlink in place", (b) => {
      rm(b, "dest", "manta-optimizer.ts");
      const target = join(b.root, "elsewhere.ts");
      writeFileSync(target, "TARGET");
      symlinkSync(target, join(b.dest, "manta-optimizer.ts"));
    }],
  ]);
});

test("contract: a manifest cannot make the sync delete outside what it owns", async () => {
  await scenario("hostile manifest", [
    ["install one", (b) => write(b, "src", "manta-accounts.ts", "A")],
    ["poison the manifest, drop the plugin", (b) => {
      write(b, "dest", "mine.ts", "USER");
      write(b, "dest", ".hidden.ts", "H");
      writeFileSync(b.manifest, "manta-accounts.ts\n../escape.ts\n/etc/passwd\n.hidden.ts\n\nmine.test.ts\nnotes.md\n");
      writeFileSync(join(b.root, "escape.ts"), "OUTSIDE");
      rm(b, "src", "manta-accounts.ts");
    }],
  ]);
});

test("contract: manifest order is byte order (uppercase, underscore, hyphen)", async () => {
  await scenario("ordering", [
    ["mixed names", (b) => { for (const n of ["b_two.ts", "B-up.ts", "a-one.ts", "a_one.ts", "Zed.ts"]) write(b, "src", n, n); }],
    ["re-run", () => {}],
  ]);
});

test("contract: a missing source changes nothing in either", async () => {
  await scenario("missing src", [
    ["install", (b) => write(b, "src", "manta-accounts.ts", "A")],
    ["source vanishes", (b) => rmSync(b.src, { recursive: true, force: true })],
  ]);
});
