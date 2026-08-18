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
import { CLI_CATALOG, resolveUpgradeCommand } from "../shared/cliCatalog.mjs";
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

// ---------------------------------------------------------------------------
// resolveBinary
// ---------------------------------------------------------------------------

// THE PATH TRAP — this ordering is the whole reason this function exists.
// A process spawned by manta-server gets the SYSTEM path only. `~/.local/bin`
// (claude) and `~/.opencode/bin` (opencode) are added by `~/.bashrc`, which a
// non-login shell never reads — so every one of these CLIs is INVISIBLE unless
// PATH is pinned. `scripts/self-update.sh` already pins PATH for exactly this
// reason. Search these pinned dirs, in order, before `process.env.PATH`.
//
// Never shells out to `which`/`command -v` — check X_OK access on each
// candidate directly.

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
  const pinned = [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
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
export function readVersion(absPath, { spawn, timeoutMs = 10_000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(absPath, ["--version"], { timeout: timeoutMs });
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
      if (code !== 0) {
        resolve(null);
        return;
      }
      const m = out.match(VERSION_RE);
      resolve(m ? m[0] : null);
    });
  });
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
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("npm", ["root", "-g"], { timeout: 5000 });
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
    }, 5000);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const trimmed = out.trim();
      resolve(trimmed || null);
    });
  });
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
