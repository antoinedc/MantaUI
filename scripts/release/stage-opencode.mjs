#!/usr/bin/env node
// stage-opencode.mjs — stage the PINNED OpenCode V2 binary into <dest>/vendor/opencode/.
//
// The ONE place that does it: scripts/release/pack.mjs imports `stageOpencodeBinary` for every
// release tarball, and the macOS install smoke runs this file's CLI to put the very same bytes
// (same pin, same registry integrity check, same sha256 sidecar) into the tree it installs.
//
//   node scripts/release/stage-opencode.mjs --arch darwin-arm64 --dest <dir>
//
// Output: <dest>/vendor/opencode/{opencode, opencode.sha256, VERSION}. Prints one line,
// "<version> <platform> <sha256>" — no secrets are involved.

import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary as ensureOpencodeBinary, platformKey as opencodePlatformKey } from "../opencode-v2/fetch-binary.mjs";
import { OPENCODE_V2_VERSION } from "../opencode-v2/version.mjs";

// The @opencode/cli-<platform> package the packer's host must be able to fetch for `--arch`. The
// release tarballs are built natively per arch (see server-tarball-deploy.yml), so the host's own
// platform IS the target's; a mismatch would ship a binary the box cannot execute.
export function opencodePlatformFor(arch) {
  return { x64: "linux-x64", arm64: "linux-arm64", "darwin-arm64": "darwin-arm64" }[arch] ?? null;
}

// Stage the PINNED OpenCode V2 binary (scripts/opencode-v2/version.mjs) into
// <stageDir>/vendor/opencode/: the binary, an `opencode.sha256` sidecar the box re-verifies on
// install, and a VERSION file. The registry integrity (sha512) is checked by ensureBinary when it
// downloads; the sidecar covers everything after that (extraction, tarball transit, the copy onto
// the box). `deps` is injected so this is testable without the network.
export function stageOpencodeBinary(stageDir, arch, deps) {
  const d = {
    ensureBinary: ensureOpencodeBinary,
    platformKey: opencodePlatformKey,
    version: OPENCODE_V2_VERSION,
    mkdir, copyFile, chmod, readFile, writeFile, createHash,
    ...deps,
  };
  return (async () => {
    const want = opencodePlatformFor(arch);
    if (!want) throw new Error(`no OpenCode build for --arch ${arch}`);
    const have = d.platformKey();
    if (have !== want) {
      throw new Error(`cannot stage the ${want} OpenCode binary on a ${have} host — build each arch natively`);
    }
    const bin = await d.ensureBinary({});
    const dest = join(stageDir, "vendor", "opencode");
    await d.mkdir(dest, { recursive: true });
    await d.copyFile(bin, join(dest, "opencode"));
    await d.chmod(join(dest, "opencode"), 0o755);
    const digest = d.createHash("sha256").update(await d.readFile(join(dest, "opencode"))).digest("hex");
    await d.writeFile(join(dest, "opencode.sha256"), `${digest}  opencode\n`);
    await d.writeFile(join(dest, "VERSION"), `${d.version}\n`);
    return { version: d.version, sha256: digest, platform: want };
  })();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = {};
  for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  if (!flags.arch || !flags.dest) {
    console.error("usage: stage-opencode.mjs --arch <x64|arm64|darwin-arm64> --dest <dir>");
    process.exit(2);
  }
  stageOpencodeBinary(resolve(flags.dest), flags.arch).then(
    (r) => console.log(`${r.version} ${r.platform} ${r.sha256}`),
    (e) => {
      console.error(`stage-opencode: ${e?.message ?? e}`);
      process.exit(1);
    },
  );
}
