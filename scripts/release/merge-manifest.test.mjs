// merge-manifest.test.mjs — node:test cases for scripts/release/merge-manifest.mjs
//
// Covers the four scenarios the issue requires:
//   1. Two-arch merge produces a single combined file with version= first,
//      then each arch's file+sha pair.
//   2. Version mismatch between sidecars dies loudly.
//   3. One-arch input still produces a valid single-arch combined manifest.
//   4. Unknown extra keys are dropped gracefully (forward compatibility).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(import.meta.dirname, "merge-manifest.mjs");

function fresh() {
  return mkdtempSync(join(tmpdir(), "merge-manifest-test-"));
}

// Tiny helper: invoke the merger against sidecar files, return the combined
// body. Throws (with stderr surfaced) on non-zero exit — tests assert on
// either the body or the rejection.
function runMerge(args, opts = {}) {
  return execFileSync("node", [SCRIPT, ...args], { encoding: "utf-8", ...opts });
}

function writeSidecar(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

test("merges two sidecars into a single combined manifest", () => {
  const dir = fresh();
  try {
    const a = writeSidecar(dir, "a.txt", "version=1.2.3\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n");
    const b = writeSidecar(dir, "b.txt", "version=1.2.3\nfile_linux_arm64=manta-1.2.3-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n");
    const out = join(dir, "combined.txt");
    runMerge([a, b, "--out", out]);
    const got = readFileSync(out, "utf-8");
    assert.equal(
      got,
      "version=1.2.3\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\nfile_linux_arm64=manta-1.2.3-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dies on version mismatch between sidecars", () => {
  const dir = fresh();
  try {
    const a = writeSidecar(dir, "a.txt", "version=1.2.3\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n");
    const b = writeSidecar(dir, "b.txt", "version=9.9.9\nfile_linux_arm64=manta-9.9.9-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n");
    assert.throws(
      () => runMerge([a, b, "--out", join(dir, "combined.txt")]),
      /version mismatch/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one-arch input produces a valid single-arch combined manifest", () => {
  const dir = fresh();
  try {
    const a = writeSidecar(dir, "x64.txt", "version=0.0.1\nfile_linux_x64=manta-0.0.1-linux-x64.tar.gz\nsha256_linux_x64=cafe\n");
    const out = join(dir, "combined.txt");
    runMerge([a, "--out", out]);
    const got = readFileSync(out, "utf-8");
    assert.equal(got, "version=0.0.1\nfile_linux_x64=manta-0.0.1-linux-x64.tar.gz\nsha256_linux_x64=cafe\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores unknown extra keys gracefully", () => {
  const dir = fresh();
  try {
    const a = writeSidecar(
      dir,
      "x64.txt",
      "version=1.0.0\nfile_linux_x64=manta-1.0.0-linux-x64.tar.gz\nsha256_linux_x64=dead\nsome_future_key=ignored\nrelease_channel=stable\n",
    );
    const b = writeSidecar(
      dir,
      "arm64.txt",
      "version=1.0.0\nfile_linux_arm64=manta-1.0.0-linux-arm64.tar.gz\nsha256_linux_arm64=beef\nanother_future_thing=skip\n",
    );
    const out = join(dir, "combined.txt");
    runMerge([a, b, "--out", out]);
    const got = readFileSync(out, "utf-8");
    assert.equal(
      got,
      "version=1.0.0\nfile_linux_x64=manta-1.0.0-linux-x64.tar.gz\nsha256_linux_x64=dead\nfile_linux_arm64=manta-1.0.0-linux-arm64.tar.gz\nsha256_linux_arm64=beef\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
