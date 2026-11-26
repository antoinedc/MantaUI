// claudeCliVersion.mjs — keeps `<state>/.manta/claude-cli-version` equal to the
// box's real `claude --version` (issue #1684).
//
// The manta-claude-max opencode plugin claims a Claude Code version to
// Anthropic and re-reads this file per request, so a `claude update` (the
// desktop About row, self-update, a manual update, Claude's own auto-update)
// reaches the running opencode WITHOUT restarting it — a restart would end
// every in-flight chat turn. See "The box tells Anthropic which Claude Code
// version it is" in AGENTS.md.
//
// Every dependency is injected, so the tests touch no real file or process.

import { constants } from "node:fs";
import { access as fsAccess, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { readVersion, resolveBinary } from "./cliUpdates.mjs";

export const CLAUDE_CLI_VERSION_FILENAME = "claude-cli-version";
export const CLAUDE_CLI_VERSION_RECHECK_MS = 60 * 60 * 1000;

// Same shape the plugin accepts; anything else is never written.
const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;

export function claudeCliVersionPath() {
  return statePath(CLAUDE_CLI_VERSION_FILENAME);
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * @param {object} [deps]
 * @param {() => string} [deps.path]
 * @param {(path:string) => Promise<string>} [deps.readFile]
 * @param {(path:string, text:string) => Promise<void>} [deps.writeFile] - must be atomic
 * @param {() => Promise<string|null>} [deps.readCliVersion] - the box's `claude --version`, or null
 * @param {(msg:string) => void} [deps.warn]
 * @returns {{ record(version:unknown): Promise<boolean>, refresh(): Promise<boolean> }}
 */
export function createClaudeCliVersionSync(deps = {}) {
  const path = deps.path ?? claudeCliVersionPath;
  const read = deps.readFile ?? ((p) => readFile(p, "utf8"));
  const write = deps.writeFile ?? atomicWrite;
  const readCliVersion = deps.readCliVersion ?? defaultReadCliVersion;
  const warn = deps.warn ?? ((m) => console.warn(m));

  let queue = Promise.resolve();

  async function writeIfChanged(version) {
    const file = path();
    // Read every time (rare: hourly / on About probes), so a file deleted or
    // edited behind our back is repaired rather than trusted from memory.
    const onDisk = await read(file).then((t) => t.trim(), () => "");
    if (onDisk === version) return false;
    await write(file, `${version}\n`);
    return true;
  }

  /** Persist `version` when it is valid and differs from what is on disk. Never throws. */
  function record(version) {
    const v = typeof version === "string" ? version.trim() : "";
    if (!VERSION_RE.test(v)) return Promise.resolve(false);
    // Serialized: two callers racing (hourly tick + About probe) never interleave.
    const run = queue.then(() => writeIfChanged(v)).catch((e) => {
      warn(`[claude-cli-version] could not write ${path()}: ${e?.message ?? e}`);
      return false;
    });
    queue = run;
    return run;
  }

  /** Read the CLI's version now and persist it. Never throws. */
  async function refresh() {
    try {
      return await record(await readCliVersion());
    } catch {
      return false;
    }
  }

  return { record, refresh };
}

async function defaultReadCliVersion() {
  const env = process.env;
  const abs = await resolveBinary("claude", { access: (p, m) => fsAccess(p, m ?? constants.X_OK), env });
  return abs ? readVersion(abs, { spawn: nodeSpawn }) : null;
}

/**
 * Boot-time sync plus an hourly re-check (notices Claude's own auto-update and a
 * manual `claude update`). Same poller shape as the rest of the server:
 * immediate first tick, timer.unref().
 */
export function startClaudeCliVersionSync({ sync = createClaudeCliVersionSync(), intervalMs = CLAUDE_CLI_VERSION_RECHECK_MS } = {}) {
  void sync.refresh();
  const timer = setInterval(() => void sync.refresh(), intervalMs);
  timer.unref?.();
  return { sync, stop: () => clearInterval(timer) };
}
