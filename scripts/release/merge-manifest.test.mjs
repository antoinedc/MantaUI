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

test("merges three per-arch sidecars (linux_x64 + linux_arm64 + darwin_arm64)", () => {
  // BET-275: the deploy workflow now produces a third arch (darwin-arm64)
  // for the macOS box path. merge-manifest.mjs must keep the darwin_arm64
  // keypair in the combined manifest (not silently drop it as "unknown").
  const dir = fresh();
  try {
    const a = writeSidecar(
      dir,
      "x64.txt",
      "version=2.5.0\nfile_linux_x64=manta-2.5.0-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n",
    );
    const b = writeSidecar(
      dir,
      "arm64.txt",
      "version=2.5.0\nfile_linux_arm64=manta-2.5.0-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n",
    );
    const c = writeSidecar(
      dir,
      "darwin.txt",
      "version=2.5.0\nfile_darwin_arm64=manta-2.5.0-darwin-arm64.tar.gz\nsha256_darwin_arm64=cccc\n",
    );
    const out = join(dir, "combined.txt");
    runMerge([a, b, c, "--out", out]);
    const got = readFileSync(out, "utf-8");
    assert.equal(
      got,
      "version=2.5.0\nfile_linux_x64=manta-2.5.0-linux-x64.tar.gz\nsha256_linux_x64=aaaa\nfile_linux_arm64=manta-2.5.0-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\nfile_darwin_arm64=manta-2.5.0-darwin-arm64.tar.gz\nsha256_darwin_arm64=cccc\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- git_sha: the release's update identity -------------------------------
//
// The box decides "am I already running this?" by comparing the commit the
// release was built from, because `version` is maintained by hand and a
// release cut without a bump used to be indistinguishable from the installed
// one — every box silently skipped a real update. These cases pin the
// merger's half of that contract.

test("carries git_sha into the combined manifest, right after version", () => {
  const dir = fresh();
  try {
    const a = writeSidecar(dir, "a.txt", "version=1.2.3\ngit_sha=abc123\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n");
    const b = writeSidecar(dir, "b.txt", "version=1.2.3\ngit_sha=abc123\nfile_linux_arm64=manta-1.2.3-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n");
    const out = join(dir, "combined.txt");
    runMerge([a, b, "--out", out]);
    const got = readFileSync(out, "utf-8");
    assert.equal(
      got,
      "version=1.2.3\ngit_sha=abc123\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\nfile_linux_arm64=manta-1.2.3-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dies when two arches were built from different commits", () => {
  // Same version, different commits: exactly the case a version-only check
  // cannot see. Publishing these under one manifest ships a release whose
  // halves disagree about what they contain.
  const dir = fresh();
  try {
    const a = writeSidecar(dir, "a.txt", "version=1.2.3\ngit_sha=abc123\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n");
    const b = writeSidecar(dir, "b.txt", "version=1.2.3\ngit_sha=def456\nfile_linux_arm64=manta-1.2.3-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n");
    assert.throws(
      () => runMerge([a, b, "--out", join(dir, "combined.txt")], { stdio: "pipe" }),
      /git_sha mismatch/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drops git_sha entirely when only some sidecars carry one", () => {
  // A partial answer is worse than none: a box whose own arch shipped without
  // a commit stamp would never match the published sha and would reinstall the
  // same tarball on every update check, forever.
  const dir = fresh();
  try {
    const a = writeSidecar(dir, "a.txt", "version=1.2.3\ngit_sha=abc123\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n");
    const b = writeSidecar(dir, "b.txt", "version=1.2.3\nfile_linux_arm64=manta-1.2.3-linux-arm64.tar.gz\nsha256_linux_arm64=bbbb\n");
    const out = join(dir, "combined.txt");
    runMerge([a, b, "--out", out], { stdio: "pipe" });
    const got = readFileSync(out, "utf-8");
    assert.ok(!got.includes("git_sha"), `expected no git_sha in:\n${got}`);
    assert.ok(got.startsWith("version=1.2.3\nfile_linux_x64="), got);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release with no commit anywhere still merges (version-only fallback)", () => {
  const dir = fresh();
  try {
    const a = writeSidecar(dir, "a.txt", "version=1.2.3\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n");
    const out = join(dir, "combined.txt");
    runMerge([a, "--out", out]);
    assert.equal(
      readFileSync(out, "utf-8"),
      "version=1.2.3\nfile_linux_x64=manta-1.2.3-linux-x64.tar.gz\nsha256_linux_x64=aaaa\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
