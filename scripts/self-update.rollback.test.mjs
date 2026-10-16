// self-update.rollback.test.mjs — the REAL scripts/self-update.sh run end to end against throwaway
// boxes: previous-release.json is recorded BEFORE the payload swap, and `--to <sha>` installs that
// exact release (git box: fetch + reset; packaged box: the version-named manifest/tarball on the
// release host, which must still carry that commit — else a loud failure).
//
// SAFETY: this runs a script that restarts services. Every external command that could touch the
// live box is shadowed by a logging fake FIRST on PATH (systemctl, launchctl, npm), HOME and
// MANTA_STATE_HOME are throwaway dirs, and the "release host" is a file:// directory.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = join(HERE, "self-update.sh");
const REAL_LIB = join(HERE, "lib", "release.sh");
const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const ARCH_KEY = (() => {
  const m = process.arch === "arm64" ? "arm64" : "x64";
  return process.platform === "darwin" ? "darwin_arm64" : `linux_${m}`;
})();

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "manta-su-"));
  roots.push(root);
  const fakebin = join(root, "fakebin");
  mkdirSync(fakebin);
  const calls = join(root, "calls.log");
  for (const name of ["systemctl", "launchctl", "npm", "loginctl"]) {
    writeFileSync(join(fakebin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\nexit 0\n`);
    chmodSync(join(fakebin, name), 0o755);
  }
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home);
  mkdirSync(state);
  const health = join(root, "health");
  writeFileSync(health, "ok");
  return { root, fakebin, calls, home, state, health };
}

function installScripts(mantaHome, { runtime = false } = {}) {
  mkdirSync(join(mantaHome, "scripts", "lib"), { recursive: true });
  copyFileSync(REAL_SCRIPT, join(mantaHome, "scripts", "self-update.sh"));
  copyFileSync(REAL_LIB, join(mantaHome, "scripts", "lib", "release.sh"));
  if (!runtime) return;
  mkdirSync(join(mantaHome, "runtime", "node", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(mantaHome, "runtime", "node", "bin", "node"));
}

function run(sb, mantaHome, args = [], extraEnv = {}) {
  const r = spawnSync("bash", [join(mantaHome, "scripts", "self-update.sh"), ...args], {
    env: {
      PATH: `${sb.fakebin}:/usr/local/bin:/usr/bin:/bin`,
      HOME: sb.home,
      MANTA_STATE_HOME: sb.state,
      MANTA_HEALTH_URL: `file://${sb.health}`,
      SELF_UPDATE_HEALTH_ATTEMPTS: "2",
      LANG: "C.UTF-8",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const logFile = join(sb.state, ".manta", "self-update.log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return { code: r.status, log, stderr: r.stderr ?? "" };
}

const prevFile = (sb) => join(sb.state, ".manta", "previous-release.json");
const prev = (sb) => JSON.parse(readFileSync(prevFile(sb), "utf8"));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();

// ------------------------------------------------------------------ git box

function gitBox() {
  const sb = sandbox();
  const origin = join(sb.root, "origin.git");
  const seed = join(sb.root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  const commit = (version, marker) => {
    writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "manta-ui", version }));
    writeFileSync(join(seed, "marker.txt"), marker);
    installScripts(seed); // identical bytes in every commit: the running script is never rewritten
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", marker);
    return git(seed, "rev-parse", "HEAD");
  };
  const old = commit("0.9.0", "OLD");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const mantaHome = join(sb.root, "box");
  execFileSync("git", ["clone", "-q", origin, mantaHome]);
  // runtime/ is untracked on a real box too; node lives there
  mkdirSync(join(mantaHome, "runtime", "node", "bin"), { recursive: true });
  symlinkSync(process.execPath, join(mantaHome, "runtime", "node", "bin", "node"));
  const fresh = commit("1.0.0", "NEW");
  git(seed, "push", "-q", "origin", "main");
  return { sb, mantaHome, origin, old, fresh, head: () => git(mantaHome, "rev-parse", "HEAD"), marker: () => readFileSync(join(mantaHome, "marker.txt"), "utf8") };
}

describe("git box", () => {
  test("an update records the release it replaces BEFORE moving HEAD (sha, version, time; 0600)", () => {
    const b = gitBox();
    assert.equal(b.head(), b.old);
    const r = run(b.sb, b.mantaHome);
    assert.equal(r.code, 0, r.log);
    assert.equal(b.head(), b.fresh);
    const p = prev(b.sb);
    assert.equal(p.git_sha, b.old);
    assert.equal(p.version, "0.9.0");
    assert.match(p.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(statSync(prevFile(b.sb)).mode & 0o777, 0o600);
  });

  test("an update that changes nothing leaves previous-release.json alone", () => {
    const b = gitBox();
    run(b.sb, b.mantaHome);
    const before = readFileSync(prevFile(b.sb), "utf8");
    const r = run(b.sb, b.mantaHome);
    assert.equal(r.code, 0, r.log);
    assert.equal(readFileSync(prevFile(b.sb), "utf8"), before);
  });

  test("--to <sha> puts the box back on exactly that commit (older than origin/main) and restarts the server", () => {
    const b = gitBox();
    run(b.sb, b.mantaHome); // now on `fresh`
    assert.equal(b.marker(), "NEW");
    writeFileSync(b.sb.calls, "");
    const r = run(b.sb, b.mantaHome, ["--to", b.old]);
    assert.equal(r.code, 0, r.log);
    assert.equal(b.head(), b.old);
    assert.equal(b.marker(), "OLD");
    assert.match(readFileSync(b.sb.calls, "utf8"), /systemctl --user restart manta-server/);
    assert.equal(prev(b.sb).git_sha, b.fresh, "the release just replaced is now the recorded one");
  });

  test("--to accepts an abbreviated sha", () => {
    const b = gitBox();
    run(b.sb, b.mantaHome);
    const r = run(b.sb, b.mantaHome, ["--to", b.old.slice(0, 10)]);
    assert.equal(r.code, 0, r.log);
    assert.equal(b.head(), b.old);
  });

  test("--to a commit origin does not have fails loudly and leaves the box where it was", () => {
    const b = gitBox();
    run(b.sb, b.mantaHome);
    const r = run(b.sb, b.mantaHome, ["--to", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
    assert.notEqual(r.code, 0);
    assert.match(r.log + r.stderr, /not available from origin/);
    assert.equal(b.head(), b.fresh);
  });

  test("--to rejects a non-hex argument and unknown flags", () => {
    const b = gitBox();
    assert.notEqual(run(b.sb, b.mantaHome, ["--to", "main"]).code, 0);
    assert.match(run(b.sb, b.mantaHome, ["--to", "main"]).log, /needs a commit sha/);
    assert.equal(run(b.sb, b.mantaHome, ["--bogus"]).code, 2);
  });
});

// -------------------------------------------------------------- packaged box

function release(host, { version, sha, marker, manifestSha = sha }) {
  const stage = join(host, "stage", `manta-${version}`);
  mkdirSync(join(stage, "src", "server"), { recursive: true });
  mkdirSync(join(stage, "node_modules"), { recursive: true });
  writeFileSync(join(stage, "src", "server", "index.mjs"), `// ${marker}`);
  writeFileSync(join(stage, "node_modules", "x"), "");
  writeFileSync(join(stage, "marker.txt"), marker);
  writeFileSync(
    join(stage, "RELEASE.json"),
    JSON.stringify({ name: "manta", version, git_sha: sha, includes: ["src", "node_modules", "marker.txt"] }),
  );
  const rel = join(host, "releases");
  mkdirSync(rel, { recursive: true });
  const tgz = `manta-${version}-${ARCH_KEY.replace("_", "-")}.tar.gz`;
  execFileSync("tar", ["-czf", join(rel, tgz), "-C", join(host, "stage"), `manta-${version}`]);
  const digest = createHash("sha256").update(readFileSync(join(rel, tgz))).digest("hex");
  const manifest = `version=${version}\n${manifestSha ? `git_sha=${manifestSha}\n` : ""}file_${ARCH_KEY}=${tgz}\nsha256_${ARCH_KEY}=${digest}\n`;
  writeFileSync(join(rel, `manta-${version}.txt`), manifest);
  return manifest;
}

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);

function packagedBox() {
  const sb = sandbox();
  const host = join(sb.root, "host");
  mkdirSync(host);
  release(host, { version: "0.9.0", sha: SHA_OLD, marker: "OLD" });
  const mantaHome = join(sb.root, "box");
  mkdirSync(mantaHome);
  installScripts(mantaHome, { runtime: true });
  // the box is currently on the OLD release
  mkdirSync(join(mantaHome, "src", "server"), { recursive: true });
  writeFileSync(join(mantaHome, "src", "server", "index.mjs"), "// OLD");
  writeFileSync(join(mantaHome, "marker.txt"), "OLD");
  writeFileSync(join(mantaHome, "RELEASE.json"), JSON.stringify({ name: "manta", version: "0.9.0", git_sha: SHA_OLD, includes: ["src", "node_modules", "marker.txt"] }));
  // …and the host has since published NEW as latest
  const latest = release(host, { version: "1.0.0", sha: SHA_NEW, marker: "NEW" });
  writeFileSync(join(host, "releases", "manta-latest.txt"), latest);
  const env = { MANTA_RELEASE_HOST: `file://${host}` };
  return {
    sb, host, mantaHome, env,
    marker: () => readFileSync(join(mantaHome, "marker.txt"), "utf8"),
    installed: () => JSON.parse(readFileSync(join(mantaHome, "RELEASE.json"), "utf8")),
    run: (args = []) => run(sb, mantaHome, args, env),
  };
}

describe("packaged box", () => {
  test("an update records the release it replaces (read from the OLD RELEASE.json, i.e. before the swap)", () => {
    const b = packagedBox();
    const r = b.run();
    assert.equal(r.code, 0, r.log);
    assert.equal(b.marker(), "NEW");
    assert.equal(b.installed().git_sha, SHA_NEW);
    const p = prev(b.sb);
    assert.equal(p.git_sha, SHA_OLD);
    assert.equal(p.version, "0.9.0");
    assert.equal(statSync(prevFile(b.sb)).mode & 0o777, 0o600);
  });

  test("--to <sha> installs that exact release from the version-named manifest and restarts the server", () => {
    const b = packagedBox();
    assert.equal(b.run().code, 0);
    writeFileSync(b.sb.calls, "");
    const r = b.run(["--to", SHA_OLD]); // version comes from previous-release.json
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /manta-0\.9\.0\.txt/);
    assert.equal(b.marker(), "OLD");
    assert.equal(b.installed().git_sha, SHA_OLD);
    assert.match(readFileSync(b.sb.calls, "utf8"), /systemctl --user restart manta-server/);
    assert.equal(prev(b.sb).git_sha, SHA_NEW);
  });

  test("--to with an explicit --version works with no previous-release.json at all", () => {
    const b = packagedBox();
    assert.equal(b.run().code, 0);
    rmSync(prevFile(b.sb));
    const r = b.run(["--to", SHA_OLD.slice(0, 12), "--version", "0.9.0"]);
    assert.equal(r.code, 0, r.log);
    assert.equal(b.marker(), "OLD");
  });

  test("--to without a recorded version fails loudly and changes nothing", () => {
    const b = packagedBox();
    assert.equal(b.run().code, 0);
    rmSync(prevFile(b.sb));
    const r = b.run(["--to", SHA_OLD]);
    assert.notEqual(r.code, 0);
    assert.match(r.log + r.stderr, /no version is recorded for that commit/);
    assert.equal(b.marker(), "NEW");
  });

  test("--to when the host's manifest for that version now holds a DIFFERENT build fails loudly (no wrong rollback)", () => {
    const b = packagedBox();
    assert.equal(b.run().code, 0);
    // a later release reused version 0.9.0 and overwrote its manifest
    release(b.host, { version: "0.9.0", sha: "c".repeat(40), marker: "IMPOSTOR" });
    const r = b.run(["--to", SHA_OLD]);
    assert.notEqual(r.code, 0);
    assert.match(r.log + r.stderr, /release host no longer has commit/);
    assert.equal(b.marker(), "NEW");
  });

  test("--to a version the host no longer serves fails loudly", () => {
    const b = packagedBox();
    assert.equal(b.run().code, 0);
    rmSync(join(b.host, "releases", "manta-0.9.0.txt"));
    const r = b.run(["--to", SHA_OLD]);
    assert.notEqual(r.code, 0);
    assert.match(r.log + r.stderr, /manifest fetch failed/);
    assert.equal(b.marker(), "NEW");
  });

  test("--to the commit already installed is a no-op success", () => {
    const b = packagedBox();
    const r = b.run(["--to", SHA_OLD, "--version", "0.9.0"]);
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /already at 0\.9\.0/);
    assert.equal(existsSync(prevFile(b.sb)), false, "nothing replaced, nothing recorded");
  });
});
