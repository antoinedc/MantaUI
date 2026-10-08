// opencodePlugins.mjs — install Manta's opencode PLUGINS (docs/opencode-plugins/*.ts)
// into opencode's plugins/ directory, from inside manta-server.
//
// WHY THE SERVER DOES THIS TOO. scripts/lib/release.sh `sync_opencode_plugins`
// does the same job for install.sh and self-update.sh — but an installed box runs
// the self-update.sh it ALREADY has, so the first update that ships a plugin
// would deliver the script and the plugin files and still not install them (the
// "two-hop" gap). Every box restarts manta-server after an update, and the NEW
// server code is what runs, so syncing at server startup closes the gap: the
// first update after this ships installs the plugins. The shell helper stays
// (fresh installs run install.sh before any server exists); a second sync is a
// no-op.
//
// THIS IS A PORT of the shell helper, with the same semantics and the SAME
// manifest file (`<state home>/.manta/opencode-plugins.manifest`):
//   * every non-test *.ts in srcDir is copied to destDir as a REAL file (temp +
//     rename, so a symlink is replaced rather than written through);
//   * the manifest lists the basenames Manta installed. A manifested plugin the
//     release no longer ships is deleted; nothing outside the manifest ever is;
//     a manifest entry containing "/" or starting with "." is ignored;
//   * a missing srcDir changes nothing (never delete on the strength of a broken
//     payload);
//   * NON-FATAL: every failure becomes a warning, nothing throws.
// `src/server/opencodePlugins.contract.test.mjs` runs
// both implementations on identical fixtures and asserts identical results — it
// is the guard that the two stay in sync.

import * as nodeFs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statePath } from "../shared/paths.mjs";

/** opencode restarts for a plugin change only when it started this recently. */
export const PLUGIN_RESTART_MAX_UPTIME_MS = 3 * 60_000;

const isShipped = (name) => name.endsWith(".ts") && !name.endsWith(".test.ts");

/**
 * @param {{srcDir: string, destDir: string, manifestPath: string, fs?: typeof nodeFs, pid?: number}} args
 * @returns {Promise<{changed: boolean, installed: number, updated: number, removed: number, warnings: string[]}>}
 */
export async function syncOpencodePlugins({ srcDir, destDir, manifestPath, fs = nodeFs, pid = process.pid }) {
  const warnings = [];
  const out = { changed: false, installed: 0, updated: 0, removed: 0, warnings };
  const warn = (m) => warnings.push(m);

  let entries;
  try {
    entries = await fs.readdir(srcDir);
  } catch {
    warn(`source not found: ${srcDir} — leaving installed plugins as they are`);
    return out;
  }
  try {
    await fs.mkdir(destDir, { recursive: true });
  } catch {
    warn(`cannot create ${destDir} — skipping plugin sync`);
    return out;
  }

  const shipped = new Set();
  const owned = new Set();
  for (const name of entries.filter(isShipped).sort()) {
    let wanted;
    try {
      const st = await fs.stat(join(srcDir, name));
      if (!st.isFile()) continue;
      wanted = await fs.readFile(join(srcDir, name));
    } catch {
      warn(`failed to read ${name}`);
      continue;
    }
    shipped.add(name);
    const dest = join(destDir, name);
    try {
      const l = await fs.lstat(dest);
      if (l.isFile() && !l.isSymbolicLink() && wanted.equals(await fs.readFile(dest))) {
        owned.add(name);
        out.installed++;
        continue;
      }
    } catch {
      // not there yet
    }
    const tmp = join(destDir, `.${name}.manta-tmp.${pid}`);
    try {
      await fs.writeFile(tmp, wanted);
      await fs.rename(tmp, dest);
      owned.add(name);
      out.installed++;
      out.updated++;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      warn(`failed to copy ${name}`);
    }
  }

  // Remove what a previous sync installed and this release no longer ships.
  let previous = "";
  try {
    previous = await fs.readFile(manifestPath, "utf-8");
  } catch {
    // no manifest yet
  }
  for (const line of previous.split("\n")) {
    const name = line;
    if (!name || name.includes("/") || name.startsWith(".") || name.endsWith(".test.ts") || !name.endsWith(".ts")) continue;
    if (shipped.has(name)) continue;
    const dest = join(destDir, name);
    let present = false;
    try {
      await fs.lstat(dest);
      present = true;
    } catch {
      // already gone
    }
    if (!present) continue;
    try {
      await fs.rm(dest, { force: true });
      out.removed++;
    } catch {
      warn(`failed to remove ${name}`);
      owned.add(name); // still ours, still on disk
    }
  }

  // Rewrite the manifest only when it differs (byte order, so it never churns
  // and matches the shell's `LC_ALL=C sort -u`).
  const want = [...owned].sort().join("\n");
  if (want !== previous.replace(/\n+$/, "")) {
    const tmp = `${manifestPath}.tmp.${pid}`;
    try {
      await fs.mkdir(dirname(manifestPath), { recursive: true });
      await fs.writeFile(tmp, want ? `${want}\n` : "");
      await fs.rename(tmp, manifestPath);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      warn(`could not write ${manifestPath}`);
    }
  }

  out.changed = out.updated > 0 || out.removed > 0;
  return out;
}

/**
 * Should opencode be restarted now because plugins changed? Only when it has JUST
 * been (re)started — by the update that also restarted this server — so no
 * meaningful turn is lost. An unknown uptime (macOS, no systemd, any failure)
 * never restarts. Pure.
 * @param {{changed: boolean, opencodeUptimeMs: number|null|undefined}} a
 */
export function shouldRestartOpencodeForPlugins({ changed, opencodeUptimeMs }) {
  if (!changed) return false;
  if (typeof opencodeUptimeMs !== "number" || !Number.isFinite(opencodeUptimeMs) || opencodeUptimeMs < 0) return false;
  return opencodeUptimeMs < PLUGIN_RESTART_MAX_UPTIME_MS;
}

/**
 * opencode-serve's age from `systemctl --user show opencode-serve -p
 * ActiveEnterTimestampMonotonic` (microseconds since boot on the monotonic
 * clock, 0 when never active) and /proc/uptime (seconds since boot). Pure.
 * @returns {number|null}
 */
export function parseOpencodeUptimeMs({ showOutput, procUptime }) {
  const m = /ActiveEnterTimestampMonotonic=(\d+)/.exec(String(showOutput ?? ""));
  const up = Number.parseFloat(String(procUptime ?? "").split(/\s+/)[0]);
  if (!m || !Number.isFinite(up)) return null;
  const enterUs = Number(m[1]);
  if (!Number.isFinite(enterUs) || enterUs <= 0) return null;
  const ms = up * 1000 - enterUs / 1000;
  return ms >= 0 ? ms : null;
}

/** The age of the running opencode service, or null when it cannot be told. */
export async function readOpencodeUptimeMs({
  exec = (cmd, args) => import("node:child_process").then(({ execFile }) => new Promise((res, rej) => execFile(cmd, args, { timeout: 5000 }, (e, so) => (e ? rej(e) : res(String(so)))))),
  readProc = () => nodeFs.readFile("/proc/uptime", "utf-8"),
} = {}) {
  try {
    const showOutput = await exec("systemctl", ["--user", "show", "opencode-serve", "-p", "ActiveEnterTimestampMonotonic"]);
    return parseOpencodeUptimeMs({ showOutput, procUptime: await readProc() });
  } catch {
    return null;
  }
}

/** The shipped plugin sources, relative to this module (git checkout and tarball alike). */
export function defaultPluginPaths() {
  const here = dirname(fileURLToPath(import.meta.url));
  const configDir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
  return {
    srcDir: join(here, "..", "..", "docs", "opencode-plugins"),
    destDir: join(configDir, "plugins"),
    manifestPath: statePath("opencode-plugins.manifest"),
  };
}

/**
 * The startup step: sync, and — only when something changed AND opencode was
 * just restarted — restart it so the plugins load. Never throws.
 * @param {{paths?: object, sync?: Function, readUptime?: Function, restart?: Function, log?: {log: Function, warn: Function}}} [deps]
 */
export async function runStartupPluginSync({
  paths = defaultPluginPaths(),
  sync = syncOpencodePlugins,
  readUptime = readOpencodeUptimeMs,
  restart = async () => (await import("./opencodeAdmin.mjs")).restartOpencode(),
  log = console,
} = {}) {
  try {
    const r = await sync(paths);
    for (const w of r.warnings) log.warn(`[plugins] ${w}`);
    if (!r.changed) return r;
    log.log(`[plugins] synced (${r.installed} installed, ${r.updated} updated, ${r.removed} removed)`);
    const opencodeUptimeMs = await readUptime();
    if (shouldRestartOpencodeForPlugins({ changed: r.changed, opencodeUptimeMs })) {
      const res = await restart();
      if (res?.ok === false) log.warn(`[plugins] opencode restart failed: ${res.error}`);
      else log.log("[plugins] updated; restarted opencode (it had just started) so the plugins load");
    } else {
      log.log("[plugins] updated; takes effect on next opencode restart");
    }
    return r;
  } catch (e) {
    log.warn("[plugins] startup sync failed:", e?.message ?? e);
    return null;
  }
}
