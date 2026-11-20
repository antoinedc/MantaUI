// prod-disk.test.mjs — node:test cases for scripts/release/prod-disk.sh
//
// The script runs on the prod box, streamed over ssh; here it runs locally with
// bash against throwaway directories.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dirname, "prod-disk.sh");

function run(args, env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf-8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

function fresh() {
  return mkdtempSync(join(tmpdir(), "prod-disk-test-"));
}

function touch(dir, names) {
  for (const n of names) writeFileSync(join(dir, n), "x");
}

const ls = (dir) => readdirSync(dir).sort();

const KEEPERS = [
  "latest-mac.yml",
  "latest.yml",
  "Manta-latest.dmg",
  "Manta-latest-x64.exe",
  "Manta-Staging-latest.dmg",
  "server.json",
  "notes.txt",
  "manta-1.0.0-linux-x64.tar.gz",
];

test("prune keeps the newest N versions across name shapes and extensions", () => {
  const dir = fresh();
  try {
    const old = [
      "Manta UI-0.0.9-arm64.dmg",
      "Manta UI-0.0.9-arm64-mac.zip",
      "Manta-UI-0.0.9-x64.exe",
    ];
    const kept = [
      "Manta UI-0.0.10-arm64.dmg",
      "Manta UI-0.0.10-arm64.dmg.blockmap",
      "Manta UI-1.0.0-arm64.dmg",
      "Manta UI-1.0.0-arm64-mac.zip",
      "Manta-UI-1.0.0-x64.exe",
      "Manta-UI-1.5.0-x64.exe",
      "Manta-UI-1.5.0-x64.exe.blockmap",
    ];
    touch(dir, [...old, ...kept, ...KEEPERS]);

    const r = run(["prune-desktop", "3", dir]);
    assert.equal(r.code, 0, r.out);
    // versions present: 0.0.9 < 0.0.10 < 1.0.0 < 1.5.0 -> keep 0.0.10, 1.0.0, 1.5.0
    assert.deepEqual(ls(dir), [...kept, ...KEEPERS].sort());
    for (const n of old) assert.match(r.out, new RegExp(`deleted .*${n.replace(/[.\\]/g, "\\$&")}`));
    assert.match(r.out, /freed 3B/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune handles the staging name shapes", () => {
  const dir = fresh();
  try {
    touch(dir, [
      "Manta-UI-Staging-0.0.1-arm64.dmg",
      "Manta-UI-Staging-0.0.2-arm64.dmg",
      "Manta-UI-Staging-0.0.3-arm64.dmg",
      "Manta-Staging-0.0.4-arm64.dmg",
      ...KEEPERS,
    ]);
    const r = run(["prune-desktop", "2", dir]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      ls(dir),
      ["Manta-UI-Staging-0.0.3-arm64.dmg", "Manta-Staging-0.0.4-arm64.dmg", ...KEEPERS].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune covers every directory given and ignores a missing one", () => {
  const a = fresh();
  const b = fresh();
  try {
    touch(a, ["Manta UI-1.0.0-arm64.dmg", "Manta UI-1.1.0-arm64.dmg", "Manta UI-1.2.0-arm64.dmg"]);
    touch(b, ["Manta-UI-1.0.0-x64.exe", "Manta-UI-1.1.0-x64.exe", "Manta-UI-1.2.0-x64.exe"]);
    const r = run(["prune-desktop", "2", a, join(a, "does-not-exist"), b]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(ls(a), ["Manta UI-1.1.0-arm64.dmg", "Manta UI-1.2.0-arm64.dmg"]);
    assert.deepEqual(ls(b), ["Manta-UI-1.1.0-x64.exe", "Manta-UI-1.2.0-x64.exe"]);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("prune with fewer versions than keep deletes nothing", () => {
  const dir = fresh();
  try {
    const files = ["Manta UI-1.0.0-arm64.dmg", "Manta UI-1.1.0-arm64.dmg", ...KEEPERS];
    touch(dir, files);
    const r = run(["prune-desktop", "3", dir]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(ls(dir), files.sort());
    assert.match(r.out, /freed 0B/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune refuses keep < 2 or non-numeric with exit 2 and deletes nothing", () => {
  const dir = fresh();
  try {
    const files = ["Manta UI-1.0.0-arm64.dmg", "Manta UI-1.1.0-arm64.dmg", "Manta UI-1.2.0-arm64.dmg"];
    touch(dir, files);
    for (const keep of ["1", "0", "abc", "-3", "2.5", ""]) {
      const r = run(["prune-desktop", keep, dir]);
      assert.equal(r.code, 2, `keep=${JSON.stringify(keep)}: ${r.out}`);
    }
    assert.equal(run(["prune-desktop", "3"]).code, 2);
    assert.deepEqual(ls(dir), files.sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard passes with a tiny request", () => {
  const dir = fresh();
  try {
    const r = run(["guard", "1", dir], { PROD_DISK_MARGIN_BYTES: "0" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /disk ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard measures the nearest existing ancestor of a missing directory", () => {
  const dir = fresh();
  try {
    const r = run(["guard", "1", join(dir, "releases", "staging")], { PROD_DISK_MARGIN_BYTES: "0" });
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard applies the 2 GiB margin on top of the requested size", () => {
  const dir = fresh();
  try {
    // Ask for just under what is free (slack for concurrent writers): passes
    // without a margin, fails with a 2 GiB one.
    const free = Number(spawnSync("df", ["--output=avail", "-B1", dir], { encoding: "utf-8" }).stdout.trim().split("\n").pop().trim());
    const df = String(Math.max(free - 64 * 1024 ** 2, 0));
    assert.equal(run(["guard", df, dir], { PROD_DISK_MARGIN_BYTES: "0" }).code, 0);
    const r = run(["guard", df, dir], { PROD_DISK_MARGIN_BYTES: String(2 * 1024 ** 3) });
    assert.equal(r.code, 1, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard fails with a need/have message when there is not enough space", () => {
  const dir = fresh();
  try {
    const r = run(["guard", "1000000000000000000", dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /need \S+ free, have \S+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard rejects a non-numeric size with exit 2", () => {
  assert.equal(run(["guard", "lots", tmpdir()]).code, 2);
  assert.equal(run(["guard", "5"]).code, 2);
});

test("unknown or missing command exits 2", () => {
  assert.equal(run(["frobnicate"]).code, 2);
  assert.equal(run([]).code, 2);
});

test("works when streamed on stdin the way the workflows invoke it", () => {
  const dir = fresh();
  try {
    touch(dir, ["Manta UI-1.0.0-arm64.dmg", "Manta UI-1.1.0-arm64.dmg", "Manta UI-1.2.0-arm64.dmg"]);
    const script = spawnSync("cat", [SCRIPT], { encoding: "utf-8" }).stdout;
    const r = spawnSync("bash", ["-s", "--", "prune-desktop", "2", dir], { input: script, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(ls(dir), ["Manta UI-1.1.0-arm64.dmg", "Manta UI-1.2.0-arm64.dmg"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
