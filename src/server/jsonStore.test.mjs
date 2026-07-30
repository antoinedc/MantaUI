import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";

async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), "manta-jsonstore-test-"));
  return dir;
}

// 1. readJsonSync on a missing file returns the fallback.
test("readJsonSync on a missing file returns the fallback", async () => {
  const dir = await tmpDir();
  const missing = join(dir, "nope.json");
  assert.deepEqual(readJsonSync(missing, { ok: true }), { ok: true });
  assert.deepEqual(readJsonSync(missing, []), []);
  assert.equal(readJsonSync(missing, null), null);
  await rm(dir, { recursive: true, force: true });
});

// 2. readJsonSync on a file containing invalid JSON returns the fallback and
//    does not throw.
test("readJsonSync on invalid JSON returns the fallback and does not throw", async () => {
  const dir = await tmpDir();
  const path = join(dir, "bad.json");
  await writeFile(path, "{ this is not json }}}");
  assert.deepEqual(readJsonSync(path, { fallback: true }), { fallback: true });
  assert.deepEqual(readJsonSync(path, []), []);
  await rm(dir, { recursive: true, force: true });
});

// 3. readJsonSync round-trips a value written by writeJsonAtomic.
test("readJsonSync round-trips a value written by writeJsonAtomic", async () => {
  const dir = await tmpDir();
  const path = join(dir, "rt.json");
  const value = { jobs: [{ id: "a", n: 1 }, { id: "b", n: 2 }] };
  await writeJsonAtomic(path, JSON.stringify(value, null, 2));
  assert.deepEqual(readJsonSync(path, null), value);
  await rm(dir, { recursive: true, force: true });
});

// 4. writeJsonAtomic with mode: 0o600 produces a file whose mode is 0600.
test("writeJsonAtomic with mode 0o600 produces a 0600 file", async () => {
  const dir = await tmpDir();
  const path = join(dir, "secret.json");
  await writeJsonAtomic(path, JSON.stringify({ secrets: [] }, null, 2), { mode: 0o600 });
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  await rm(dir, { recursive: true, force: true });
});

// 5. writeJsonAtomic creates a missing parent directory.
test("writeJsonAtomic creates a missing parent directory", async () => {
  const dir = await tmpDir();
  const path = join(dir, "nested", "deep", "store.json");
  await writeJsonAtomic(path, JSON.stringify({ x: 1 }));
  assert.deepEqual(readJsonSync(path, null), { x: 1 });
  await rm(dir, { recursive: true, force: true });
});

// 6. Writing over an existing file replaces it and leaves no temp file behind
//    in the directory.
test("writeJsonAtomic replaces an existing file and leaves no temp behind", async () => {
  const dir = await tmpDir();
  const path = join(dir, "store.json");
  await writeJsonAtomic(path, JSON.stringify({ v: 1 }));
  await writeJsonAtomic(path, JSON.stringify({ v: 2, more: true }));

  // Content is the latest write.
  assert.deepEqual(readJsonSync(path, null), { v: 2, more: true });

  // No temp files remain alongside the final file.
  const entries = await readdir(dir);
  const temps = entries.filter((e) => e.startsWith("store.json.tmp"));
  assert.deepEqual(temps, []);

  await rm(dir, { recursive: true, force: true });
});

// Extra: a default-mode write (no mode supplied) does not throw and is
// readable — guards the no-mode branch.
test("writeJsonAtomic without a mode writes and is readable", async () => {
  const dir = await tmpDir();
  const path = join(dir, "plain.json");
  await writeJsonAtomic(path, JSON.stringify({ hooks: [] }, null, 2));
  assert.deepEqual(readJsonSync(path, null), { hooks: [] });
  await rm(dir, { recursive: true, force: true });
});
