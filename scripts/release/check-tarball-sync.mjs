// check-tarball-sync.mjs — assert the served tarball contains the same
// install.sh + install-lib.mjs that ship in this repo, and POST a signed
// notify if anything has drifted.
//
// Why this exists (BET-172): scripts/release/publish.sh's `200`-only verify
// silently passed against a stale tarball — a 200 is healthy even when the
// contents are 6 weeks old. `scripts/release/publish.sh` now content-checks
// the tarball it just published, but that's only as fresh as the last time
// the operator ran `bash scripts/release/publish.sh`. This script is the
// belt-and-braces: it runs nightly from the dev box (off-site relative to
// prod) and wakes the maintainer when the served tarball diverges from the
// repo. The notify uses the same MANTA_NOTIFY_URL / MANTA_NOTIFY_SECRET
// HMAC contract as scripts/prod/backup-relay.sh.
//
// INSTALL on the dev box (in this opencode session, per BET-163 §3 pattern):
//   schedule_create cron "17 4 * * *" running `node /path/check-tarball-sync.mjs`;
//   on failure the cron turn should call `notify` urgent:true quoting the
//   drift list. The script itself ALSO POSTs a signed payload to the
//   webhook, so a separate session listening on that webhook wakes up even
//   if the cron session is gone.
//
// What it checks (every failure is a discrete entry in the returned list):
//   1. served install.sh  ==  repo scripts/install.sh      (BET-171: deploy drift)
//   2. tarball's scripts/install.sh  ==  repo scripts/install.sh     (BET-172)
//   3. tarball's scripts/install-lib.mjs  ==  repo scripts/install-lib.mjs  (BET-172)
//
// Override (env):
//   MANTA_SITE             public URL root (default https://mantaui.com)
//   MANTA_TARBALL_PATH     path under SITE for the tarball (default /releases/manta-latest.tar.gz)
//   MANTA_INSTALL_SH_PATH  path under SITE for install.sh (default /install.sh)
//   MANTA_NOTIFY_URL       webhook URL to POST drift reports to (no-op if unset)
//   MANTA_NOTIFY_SECRET    HMAC key for the X-Bui-Signature header (no-op if unset)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/release/check-tarball-sync.mjs → repo root is ../..
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// Default URLs (single source of truth — also used by the test suite).
// ---------------------------------------------------------------------------

export const DEFAULT_TARGETS = {
  tarballUrl:    "https://mantaui.com/releases/manta-latest.tar.gz",
  installShUrl:  "https://mantaui.com/install.sh",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Extract the named files from a gzipped tar archive buffer.
 * Pure: takes bytes in, returns a Map<relPath, bytes>. No filesystem I/O.
 * Uses `tar` via spawnSync so the tarball never hits disk; equivalent to
 *   tar -xzf - --to-stdout <each path>
 * but tar's --to-stdout is one-file-at-a-time, so we stream the whole tar to
 * a tmpdir instead (still small — the install files are a few KB).
 *
 * @param {object} opts
 * @param {Uint8Array} opts.tarball       gzipped tar bytes
 * @param {string[]}   opts.paths         relative paths to extract (e.g. ["scripts/install.sh"])
 * @param {Function}   opts.exec          ({ tarball, paths, cwd }) → Map<path, Uint8Array>
 *                                        injected for testability.
 */
export async function extractTarballPaths({ tarball, paths, exec }) {
  const fn = exec ?? defaultExecExtract;
  return fn({ tarball, paths });
}

async function defaultExecExtract({ tarball, paths }) {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "manta-tar-"));
  try {
    // Pipe the tarball bytes into `tar -xzf - -C <tmp>`. The tarball from
    // pack.mjs has root `manta-<version>/`; --strip-components=1 makes
    // `scripts/install.sh` land at tmp/scripts/install.sh (the runtime layout).
    const r = spawnSync("tar", ["xzf", "-", "--strip-components=1", "-C", tmp], {
      input: tarball,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      throw new Error(`tar extract failed: ${r.stderr?.toString?.() ?? "(no stderr)"}`);
    }
    const out = new Map();
    for (const p of paths) {
      const bytes = await fs.readFile(path.join(tmp, p));
      out.set(p, bytes);
    }
    return out;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Run the drift check. Pure-ish: every I/O surface is injected.
 * @param {object} opts
 * @param {string}    opts.repoRoot      absolute path to the repo root
 * @param {string}    opts.tarballUrl    full URL of the served tarball
 * @param {string}    opts.installShUrl  full URL of the served install.sh
 * @param {Function}  opts.fetchFn       fetch(url) → Response
 * @param {Function}  opts.readRepoFile  (absPath) → Promise<Uint8Array|null>  (null = missing)
 * @param {Function}  opts.extract       ({ tarball, paths }) → Map<path, Uint8Array>
 * @param {Function}  opts.log           (line) => void
 */
export async function runSyncCheck({
  repoRoot = DEFAULT_REPO_ROOT,
  tarballUrl = DEFAULT_TARGETS.tarballUrl,
  installShUrl = DEFAULT_TARGETS.installShUrl,
  fetchFn = globalThis.fetch,
  readRepoFile = defaultReadRepoFile,
  extract = extractTarballPaths,
  log = () => {},
} = {}) {
  const failures = [];
  const paths = ["scripts/install.sh", "scripts/install-lib.mjs"];

  // 1. fetch served install.sh and repo install.sh
  log(`fetch ${installShUrl}`);
  const servedInstall = await fetchOk(fetchFn, installShUrl, log, "served install.sh");
  const repoInstall = await readRepoFile(join(repoRoot, "scripts/install.sh"));
  if (!repoInstall) {
    failures.push({ kind: "missing", what: "repo scripts/install.sh", url: null });
  } else {
    if (!servedInstall) {
      failures.push({ kind: "fetch-failed", what: "served install.sh", url: installShUrl });
    } else if (!bytesEq(servedInstall, repoInstall)) {
      failures.push({
        kind: "drift",
        what: "served install.sh ≠ repo scripts/install.sh",
        servedSha: sha256Hex(servedInstall),
        repoSha:   sha256Hex(repoInstall),
        url: installShUrl,
      });
    }
  }

  // 2. fetch tarball, extract paths, compare each against repo
  log(`fetch ${tarballUrl}`);
  const tarball = await fetchOk(fetchFn, tarballUrl, log, "served tarball");
  if (!tarball) {
    failures.push({ kind: "fetch-failed", what: "served tarball", url: tarballUrl });
    return { ok: false, failures };
  }

  let extracted;
  try {
    extracted = await extract({ tarball, paths });
  } catch (e) {
    failures.push({ kind: "extract-failed", what: `tarball extract: ${e?.message ?? e}`, url: tarballUrl });
    return { ok: false, failures };
  }

  for (const p of paths) {
    const tarFile = extracted.get(p);
    const repoFile = await readRepoFile(join(repoRoot, p));
    if (!tarFile) {
      failures.push({
        kind: "missing",
        what: `tarball is missing ${p}`,
        url: tarballUrl,
      });
      continue;
    }
    if (!repoFile) {
      failures.push({
        kind: "missing",
        what: `repo is missing ${p} (tarball contains it)`,
        url: null,
      });
      continue;
    }
    if (!bytesEq(tarFile, repoFile)) {
      failures.push({
        kind: "drift",
        what: `tarball's ${p} ≠ repo ${p}`,
        tarballSha: sha256Hex(tarFile),
        repoSha:    sha256Hex(repoFile),
        url: tarballUrl,
      });
    }
  }

  log(failures.length === 0
    ? `OK: served install.sh, tarball install.sh, tarball install-lib.mjs all match repo`
    : `FAIL: ${failures.length} drift/missing finding(s)`);

  return { ok: failures.length === 0, failures };
}

async function defaultReadRepoFile(absPath) {
  try {
    return new Uint8Array(await readFile(absPath));
  } catch {
    return null;
  }
}

async function fetchOk(fetchFn, url, log, label) {
  try {
    const res = await fetchFn(url);
    if (res.status !== 200) {
      log(`${label}: HTTP ${res.status}`);
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf;
  } catch (e) {
    log(`${label}: ${e?.message ?? e}`);
    return null;
  }
}

function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Notify — POST a signed JSON body on drift. Reuses the MANTA_NOTIFY_*
// HMAC contract established by scripts/prod/backup-relay.sh (the webhook
// handler at src/server/webhooks.mjs `verifySignature` matches).
// ---------------------------------------------------------------------------

/**
 * Sign + POST a drift report.
 * @param {object} opts
 * @param {Array} opts.failures      drift list from runSyncCheck
 * @param {object} opts.env          env-like (default process.env)
 * @param {Function} opts.fetchFn    fetch impl
 * @param {object} opts.cryptoImpl   { createHmac } — injected for tests
 * @param {Function} opts.now        () => Date ISO — injected for tests
 */
export async function notifyDrift({
  failures,
  env = process.env,
  fetchFn = globalThis.fetch,
  cryptoImpl = null,
  now = () => new Date().toISOString(),
} = {}) {
  const url    = env.MANTA_NOTIFY_URL;
  const secret = env.MANTA_NOTIFY_SECRET;
  if (!url || !secret) return { skipped: true, reason: "MANTA_NOTIFY_URL/SECRET unset" };
  if (!failures || failures.length === 0) return { skipped: true, reason: "no failures" };

  const body = JSON.stringify({
    source: "check-tarball-sync",
    ts: now(),
    failures,
  });
  const crypto = cryptoImpl ?? (await import("node:crypto"));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bui-Signature": `sha256=${sig}`,
      },
      body,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export function envTargets(env) {
  const site = env.MANTA_SITE ?? "https://mantaui.com";
  return {
    tarballUrl:   `${site}${env.MANTA_TARBALL_PATH    ?? "/releases/manta-latest.tar.gz"}`,
    installShUrl: `${site}${env.MANTA_INSTALL_SH_PATH ?? "/install.sh"}`,
  };
}

function cliLog(line) {
  process.stderr.write(`[check-tarball-sync] ${line}\n`);
}

async function cliMain() {
  const targets = envTargets(process.env);
  const result = await runSyncCheck({
    tarballUrl:   targets.tarballUrl,
    installShUrl: targets.installShUrl,
    log: cliLog,
  });
  if (result.ok) {
    process.stderr.write(`[check-tarball-sync] OK\n`);
    process.exit(0);
  }
  process.stderr.write(`[check-tarball-sync] FAIL: ${result.failures.length} drift/missing finding(s):\n`);
  for (const f of result.failures) {
    process.stderr.write(`  - [${f.kind}] ${f.what}` + (f.url ? ` (${f.url})` : "") + "\n");
  }
  const notify = await notifyDrift({ failures: result.failures });
  if (notify.skipped) {
    process.stderr.write(`[check-tarball-sync] notify skipped: ${notify.reason}\n`);
  } else if (notify.ok) {
    process.stderr.write(`[check-tarball-sync] notify POST → ${notify.status}\n`);
  } else {
    process.stderr.write(`[check-tarball-sync] notify POST failed: ${notify.error ?? "(no detail)"}\n`);
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cliMain();
}
