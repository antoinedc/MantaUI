// Fetch the pinned OpenCode V2 binary from the npm registry.
//
// The standalone binary ships as the `@opencode/cli-<platform>` package. We pull
// its registry tarball directly (no `npm install`, no global install, no curl
// installer), verify the sha512 integrity the registry reports, extract only
// `package/bin/opencode`, and cache it at
//   ~/.cache/manta/opencode-v2/<version>/opencode
// The tarball is deleted after extraction (disk is tight on the dev box) so at
// most one extracted copy exists per version.
//
// CLI:  node scripts/opencode-v2/fetch-binary.mjs   → prints the binary path.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OPENCODE_V2_VERSION } from "./version.mjs";

const REGISTRY = process.env.MANTA_NPM_REGISTRY || "https://registry.npmjs.org";

/** `<platform>-<arch>` suffix of the @opencode/cli-* package for this host. */
export function platformKey(platform = process.platform, arch = process.arch) {
  const osName = { linux: "linux", darwin: "darwin", win32: "windows" }[platform];
  const cpu = { x64: "x64", arm64: "arm64" }[arch];
  if (!osName || !cpu) throw new Error(`unsupported platform ${platform}/${arch}`);
  return `${osName}-${cpu}`;
}

export function packageNameFor(platform, arch) {
  return `@opencode/cli-${platformKey(platform, arch)}`;
}

/** `~/.cache/manta/opencode-v2/<version>` (XDG_CACHE_HOME honoured). */
export function cacheDirFor(version = OPENCODE_V2_VERSION, env = process.env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "manta", "opencode-v2", version);
}

/** Split an npm SRI string (`sha512-<base64>`) into algorithm + base64 digest. */
export function parseIntegrity(integrity) {
  const m = /^(sha512|sha256|sha384|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity ?? ""));
  if (!m) throw new Error(`unrecognised integrity string: ${integrity}`);
  return { algorithm: m[1], digest: m[2] };
}

/** True when the base64 `digest` of the downloaded bytes equals the registry's. */
export function integrityMatches(integrity, algorithm, digest) {
  const want = parseIntegrity(integrity);
  return want.algorithm === algorithm && want.digest === digest;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function registryDist(pkg, version) {
  const url = `${REGISTRY}/${pkg.replace("/", "%2f")}/${version}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry ${res.status} for ${pkg}@${version}`);
  const meta = await res.json();
  const { tarball, integrity } = meta?.dist ?? {};
  if (!tarball || !integrity) throw new Error(`registry gave no dist info for ${pkg}@${version}`);
  return { tarball, integrity };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

/**
 * Ensure the pinned binary is cached; return its absolute path. Idempotent: a
 * present, non-empty binary short-circuits with no network.
 */
export async function ensureBinary({ version = OPENCODE_V2_VERSION, log = () => {} } = {}) {
  const dir = cacheDirFor(version);
  const bin = join(dir, process.platform === "win32" ? "opencode.exe" : "opencode");
  if (await exists(bin)) {
    if ((await stat(bin)).size > 1_000_000) return bin;
  }
  await mkdir(dir, { recursive: true });

  const pkg = packageNameFor();
  const { tarball, integrity } = await registryDist(pkg, version);
  const { algorithm } = parseIntegrity(integrity);
  log(`downloading ${pkg}@${version}`);

  const tgz = join(dir, `download-${process.pid}.tgz`);
  try {
    const res = await fetch(tarball);
    if (!res.ok || !res.body) throw new Error(`tarball download failed: ${res.status}`);
    const hash = createHash(algorithm);
    const out = createWriteStream(tgz);
    const src = Readable.fromWeb(res.body);
    src.on("data", (chunk) => hash.update(chunk));
    await pipeline(src, out);
    if (!integrityMatches(integrity, algorithm, hash.digest("base64"))) {
      throw new Error(`integrity mismatch for ${pkg}@${version} — refusing to extract`);
    }
    log("integrity verified, extracting");
    const tmp = join(dir, `extract-${process.pid}`);
    await mkdir(tmp, { recursive: true });
    await run("tar", ["-xzf", tgz, "-C", tmp, "--strip-components=2", "package/bin/opencode"]);
    await chmod(join(tmp, "opencode"), 0o755);
    await rename(join(tmp, "opencode"), bin);
    await rm(tmp, { recursive: true, force: true });
  } finally {
    await rm(tgz, { force: true });
  }
  return bin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureBinary({ log: (m) => console.error(`[fetch-binary] ${m}`) })
    .then((p) => console.log(p))
    .catch((e) => {
      console.error(`[fetch-binary] ${e.message}`);
      process.exit(1);
    });
}
