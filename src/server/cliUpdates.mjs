// cliUpdates.mjs — box-side CLI catalog, installed-count and latest-version
// probes (BET-1095, stage 1 of the unified-update epic).
//
// Answers, for each CLI in the catalog (opencode / claude / codex / kimi):
//   * is it installed, and at what version?
//   * what is the latest published version?
//   * what command upgrades it (or should the UI show a manual link)?
//
// The name/version/upgrade data lives in src/shared/cliCatalog.mjs — this file
// only probes reality against that table. Everything here is dependency-
// injected (access / spawn / fetchJson) so every function is unit-testable
// with no real process spawn and no real network.

import { join } from "node:path";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import {
  CLI_CATALOG,
  HOME_CLI_INSTALL_DIRS,
  resolveUpgradeCommand,
} from "../shared/cliCatalog.mjs";
import { isUpdateAvailable } from "../shared/versionCompare.mjs";
import { createJsonFetcher } from "./conditionalFetch.mjs";

// Default deps — the real-server wiring. Tests inject stubs for all of these.
const defaultAccess = (p, mode) => fsAccess(p, mode);
const defaultSpawn = (cmd, args, opts) => nodeSpawn(cmd, args, opts);

// One conditional-GET fetcher PER CATALOG ENTRY, memoized for the process
// lifetime. It MUST be per-entry, never one shared instance: createJsonFetcher
// caches exactly ONE etag and ONE parsed body per fetcher, so a single fetcher
// used for four different URLs could answer a 304 with the body of a DIFFERENT
// package. Per-entry keeps the conditional GET correct (each entry maps to
// exactly one URL) and keeps the ETag benefit across the detector's 5-minute
// re-probes.
const entryFetchers = new Map();
function defaultFetchJsonFor(entryId) {
  let f = entryFetchers.get(entryId);
  if (!f) {
    f = createJsonFetcher({ label: "cli latest fetch" });
    entryFetchers.set(entryId, f);
  }
  return f;
}

// THE PATH TRAP — this ordering is the whole reason these helpers exist.
// A process spawned by manta-server gets the SYSTEM path only. `~/.local/bin`
// (claude) and `~/.opencode/bin` (opencode) are added by `~/.bashrc`, which a
// non-login shell never reads — so every one of these CLIs is INVISIBLE unless
// PATH is pinned. `scripts/self-update.sh` already pins PATH for exactly this
// reason. Search these pinned dirs, in order, before `process.env.PATH`.
//
// Single source for the pinned-dir list, shared by resolveBinary (the search
// order) and upgradeCli (building the PATH for an upgrade spawn — upgrade-clis
// invokes BARE NAME upgrades like `claude update`, and systemd services lack
// these dirs). The home-relative entries come from the shared
// HOME_CLI_INSTALL_DIRS (src/shared/cliCatalog.mjs — the same list
// scripts/self-update.sh prepends to PATH, BET-1163); /opt/homebrew/bin and
// /usr/local/bin are system-level dirs (not home-relative) and are pinned
// additionally. Never duplicate this literal a third time — read the constant.
//
// Never shells out to `which`/`command -v` — check X_OK access on each
// candidate directly.
const CLI_BIN_DIRS = [...HOME_CLI_INSTALL_DIRS, "/opt/homebrew/bin", "/usr/local/bin"];

function resolveCliBinDirs(home) {
  return CLI_BIN_DIRS.map((dir) => (dir.startsWith("/") ? dir : join(home, dir)));
}

// ---------------------------------------------------------------------------
// resolveBinary
// ---------------------------------------------------------------------------

/**
 * Resolve a CLI binary to an absolute path, or null if it is not executable
 * anywhere we look.
 *
 * @param {string} bin
 * @param {object} deps
 * @param {(path:string, mode:number) => Promise<void>} deps.access - rejects
 *   (or resolves) for non-accessible (accessible) paths, mirroring
 *   fs.promises.access.
 * @param {Record<string,string>} deps.env - the environment (for HOME an PATH).
 * @returns {Promise<string|null>}
 */
export async function resolveBinary(bin, { access, env }) {
  const home = env?.HOME ?? "";
  const pinned = resolveCliBinDirs(home);
  const pathDirs = (env?.PATH ?? "").split(":").filter(Boolean);

  for (const dir of [...pinned, ...pathDirs]) {
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable here — keep searching
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// readVersion
// ---------------------------------------------------------------------------

const VERSION_RE = /\d+\.\d+\.\d+(?:[-.\w]*)?/;

/**
 * Spawn a command and resolve its stdout, or null on ANY failure.
 *
 * The single spawn-and-read code path in this module. This shared helper is
 * why the file needs no duplication-gate exemption — reuse it for a third
 * spawn call rather than re-copying the scaffolding. Resolves null — never
 * rejects — on a spawn throw, a child `error`, a non-zero exit, or the
 * timeout. Callers treat null as "couldn't tell", never as a value.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} deps
 * @param {(cmd:string, args:string[], opts:any) => import("node:child_process").ChildProcess} deps.spawn
 * @param {number} deps.timeoutMs
 * @returns {Promise<string|null>} raw stdout on exit 0, else null
 */
function spawnStdout(cmd, args, { spawn, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { timeout: timeoutMs });
    } catch {
      resolve(null);
      return;
    }

    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      resolve(null);
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/**
 * Spawn `<absPath> --version` and read the first dotted version out of stdout.
 *
 * Every CLI in the catalog prints something like `2.1.233 (Claude Code)` or
 * `codex-cli 0.147.0`; the regex covers both. Any throw, non-zero exit, or
 * 10s timeout → returns null (never propagates).
 *
 * @param {string} absPath
 * @param {object} deps
 * @param {(cmd:string, args:string[], opts:any) => import("node:child_process").ChildProcess} deps.spawn
 * @param {number} [deps.timeoutMs=10000]
 * @returns {Promise<string|null>}
 */
export async function readVersion(absPath, { spawn, timeoutMs = 10_000 }) {
  const out = await spawnStdout(absPath, ["--version"], { spawn, timeoutMs });
  if (out == null) return null;
  const m = out.match(VERSION_RE);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// runUpgrade
// ---------------------------------------------------------------------------

/**
 * Run one upgrade command array (`["opencode","upgrade"]`,
 * `["npm","install","-g",…]`, or a `["sh","-c",…]` pipeline). Streams child
 * stdout/stderr through (stdio:"inherit") so the self-update log shows what the
 * vendor installer did. Resolves on exit 0, rejects otherwise — on ENOENT
 * (spawn throw / child `error`) and on any non-zero exit. Per-CLI timeout is
 * enforced by spawn's `timeout`.
 *
 * This is the ONE shared upgrade-spawn implementation — consumed by both
 * `scripts/upgrade-clis.mjs` (the whole-box loop) and `upgradeCli`
 * (single-CLI upgrade). `env` is propagated to the child so a caller can pin
 * PATH; omitted, the child inherits the parent environment exactly as before.
 *
 * @param {string[]} argv - the upgrade command as `[cmd, ...args]`.
 * @param {object} [deps]
 * @param {(cmd:string, args:string[], opts:any) => import("node:child_process").ChildProcess} [deps.spawn]
 * @param {Record<string,string>} [deps.env]
 * @param {number} [deps.timeoutMs=10*60*1000]
 * @returns {Promise<void>}
 */
export function runUpgrade(argv, { spawn = nodeSpawn, env, timeoutMs = 10 * 60 * 1000 } = {}) {
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "inherit", timeout: timeoutMs, env });
    } catch (e) {
      reject(e);
      return;
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// upgradeCli
// ---------------------------------------------------------------------------

/**
 * Upgrade exactly ONE installed CLI, by catalog id, to its latest version.
 *
 * REUSES the existing pieces — the cached detector's detect() and current
 * version, resolveBinary's pinned-dir search, readVersion after the upgrade,
 * and runUpgrade to execute — it does NOT re-implement detection or the
 * upgrade command. Returns `{ ok }` and NEVER rejects: any throw is caught and
 * returned as `{ ok:false, error }`.
 *
 * @param {string} cliId - a CLI_CATALOG id (opencode / claude / codex / kimi).
 * @param {object} [deps]
 * @param {() => Promise<Array<object>>} [deps.detect] - the cached detector's
 *   detect(). Defaults to a fresh createCliDetector().detect.
 * @param {(argv:string[], opts?:object) => Promise<void>} [deps.run]
 * @param {(p:string, mode:number) => Promise<void>} [deps.access]
 * @param {object} [deps.env]
 * @param {(cmd:string, args:string[], opts:any) => import("node:child_process").ChildProcess} [deps.spawn] - used for the after-upgrade version read.
 * @param {({spawn}) => Promise<string|null>} [deps.getNpmGlobalRoot]
 * @returns {Promise<{ok:boolean; before?:string|null; after?:string|null; changed?:boolean; error?:string}>}
 */
export async function upgradeCli(cliId, deps = {}) {
  try {
    const detect = deps.detect ?? createCliDetector().detect;
    const run = deps.run ?? runUpgrade;
    const access = deps.access ?? defaultAccess;
    const env = deps.env ?? process.env;
    const spawn = deps.spawn ?? nodeSpawn;

    const results = await detect();
    const t = results.find((r) => r.id === cliId);
    if (!t || !Array.isArray(t.upgrade) || t.upgrade.length === 0) {
      // Unknown id, or a target with no resolvable upgrade command (manual /
    // Homebrew-managed) — nothing we can safely run.
      return { ok: false, error: "no upgrade path" };
    }

    const before = t.current ?? null;

    // Pin PATH for the upgrade spawn: upgrade-clis invokes BARE NAMES
    // (`claude update`, `npm install -g …`) and systemd services lack the CLI
    // dirs. Same list resolveBinary searches.
    const home = env?.HOME ?? "";
    const pinnedCliPath = [...resolveCliBinDirs(home), env?.PATH ?? ""]
      .filter(Boolean)
      .join(":");
    const upgradeEnv = { ...env, PATH: pinnedCliPath };

    await run(t.upgrade, { spawn, env: upgradeEnv });

    // Re-resolve the binary + re-read the version to see whether it changed.
    const after = await readBinaryVersion(cliId, { access, env, spawn });
    return {
      ok: true,
      before,
      after,
      changed: !!after && after !== before,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function readBinaryVersion(cliId, { access, env, spawn }) {
  const entry = CLI_CATALOG.find((c) => c.id === cliId);
  if (!entry?.bin) return null;
  const absPath = await resolveBinary(entry.bin, { access, env });
  if (!absPath) return null;
  return readVersion(absPath, { spawn });
}

// ---------------------------------------------------------------------------
// fetchLatest
// ---------------------------------------------------------------------------

/**
 * Fetch the latest published version for a catalog entry.
 *
 *   - `kind:"npm"`    → GET https://registry.npmjs.org/<pkg>/latest, read `.version`
 *   - `kind:"github"` → GET https://api.github.com/repos/<repo>/releases/latest,
 *                       read `.tag_name`, strip a leading `v`
 *
 * Any failure (network, non-2xx, unparseable, missing field) → null.
 *
 * @param {object} entry - a CLI_CATALOG entry
 * @param {object} deps
 * @param {(url:string) => Promise<any>} deps.fetchJson
 * @returns {Promise<string|null>}
 */
export async function fetchLatest(entry, { fetchJson }) {
  const meta = entry?.latest;
  try {
    if (meta?.kind === "npm") {
      const data = await fetchJson(`https://registry.npmjs.org/${meta.pkg}/latest`);
      return typeof data?.version === "string" ? data.version : null;
    }
    if (meta?.kind === "github") {
      const data = await fetchJson(`https://api.github.com/repos/${meta.repo}/releases/latest`);
      if (typeof data?.tag_name !== "string") return null;
      return data.tag_name.replace(/^v/, "");
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// npmGlobalRoot
// ---------------------------------------------------------------------------

/**
 * Resolve `npm root -g` (5s timeout; null on any failure). Used to decide
 * whether a binary is npm-managed so `resolveUpgradeCommand` can prefer an
 * `npm install -g` over a vendor installer that would shadow it.
 */
function defaultGetNpmGlobalRoot({ spawn }) {
  return spawnStdout("npm", ["root", "-g"], { spawn, timeoutMs: 5000 }).then(
    (out) => (out == null ? null : out.trim() || null),
  );
}

// ---------------------------------------------------------------------------
// detectClis
// ---------------------------------------------------------------------------

/**
 * Probe the INSTALLED CLIs across the catalog.
 *
 * Returns one CliStatus per installed CLI (a CLI with no executable binary is
 * omitted from the array entirely):
 *   { id, label, current, latest, available, ok, manual, manualUrl, disruption, upgrade }
 *
 * - `available` = `current` and `latest` both known AND `latest > current`
 *   (reuses versionCompare — never a hand-rolled comparator).
 * - `ok` = false when `latest` could not be determined. An unknown is NEVER
 *   reported as up to date.
 * - `manual` = true when `resolveUpgradeCommand(...)` returned null.
 * - `available` is always false whenever `manual` is true — "Update all" only
 *   ever counts things it will actually do.
 *
 * @param {object} deps
 * @param {(...) => Promise<void>} [deps.access]
 * @param {object} [deps.env]
 * @param {(...) => import("node:child_process").ChildProcess} [deps.spawn]
 * @param {(url:string) => Promise<any>} [deps.fetchJson]
 * @param {({spawn}) => Promise<string|null>} [deps.getNpmGlobalRoot]
 * @returns {Promise<Array<object>>}
 */
export async function detectClis(deps = {}) {
  const access = deps.access ?? defaultAccess;
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? defaultSpawn;
  const getNpmGlobalRoot = deps.getNpmGlobalRoot ?? defaultGetNpmGlobalRoot;

  // The npm global root is threaded into resolveUpgradeCommand so npm-managed
  // binaries upgrade via npm (vendor installer would shadow npm's copy).
  const npmGlobalRoot = await getNpmGlobalRoot({ spawn });

  const results = [];
  for (const entry of CLI_CATALOG) {
    const absPath = await resolveBinary(entry.bin, { access, env });
    if (!absPath) continue; // not installed → omitted entirely

    const current = await readVersion(absPath, { spawn });
    const latest = await fetchLatest(entry, {
      fetchJson: deps.fetchJson ?? defaultFetchJsonFor(entry.id),
    });

    const upgrade = resolveUpgradeCommand(entry, absPath, npmGlobalRoot);
    const manual = upgrade === null;
    // `available` requires a real upgrade path + both versions known + newest.
    const available =
      !manual &&
      current != null &&
      latest != null &&
      isUpdateAvailable(current, latest);
    // Unknown latest is NEVER reported as up to date.
    const ok = latest != null;

    results.push({
      id: entry.id,
      label: entry.label,
      current,
      latest,
      available,
      ok,
      manual,
      manualUrl: entry.manualUrl,
      disruption: entry.disruption,
      upgrade,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// createCliDetector — cached, in-flight-joining detect()
// ---------------------------------------------------------------------------

/**
 * Build a `{ detect() }` handle with a 5-minute result cache and an in-flight
 * join. Same shape as `createUpdateCheck` in serverUpdate.mjs: a concurrent
 * caller JOINS the in-flight promise rather than getting a stale early return.
 * Probing costs up to 4 process spawns plus 4 HTTPS requests, which is why the
 * result is cached and why two callers within a probe must not double it.
 *
 * @param {object} [deps] passed through to `detectClis` per detect
 * @returns {{ detect: () => Promise<Array<object>> }}
 */
export function createCliDetector(deps = {}) {
  const TTL_MS = 5 * 60 * 1000;
  let inFlight = null;
  let lastResult = null;
  let lastAt = 0;

  function detect() {
    // Join the in-flight probe rather than starting a second one.
    if (inFlight) return inFlight;
    // Serve a fresh-enough cached result.
    if (lastResult && Date.now() - lastAt < TTL_MS) {
      return Promise.resolve(lastResult);
    }
    inFlight = detectClis(deps)
      .then((res) => {
        lastResult = res;
        lastAt = Date.now();
        return res;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { detect };
}
