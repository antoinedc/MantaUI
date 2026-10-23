// Which slash commands always run in a background child session (spec
// 2026-10-23-opencode-v2-next N3 / §B-server 2).
//
// V2 reports a command as `{name, description}` only — nothing says it will
// background itself — so manta-server reads the definitions it can see. A name
// is background iff its definition says `subagent: true`, or its `agent` names
// an agent whose mode is `subagent` (verified on 2.0.30 against the real binary:
// a native `commands` entry, a global `.md`, a nested `sub/deep.md`, a project
// `.md` and a command whose `agent` is a subagent all ran in a child session;
// the V1 `command` key's `subagent` and a command naming a primary agent did not).
//
// Sources, later overriding earlier for the same name:
//   global  ~/.config/opencode/commands/**/*.md   then global opencode.jsonc `commands`
//   project <dir>/.opencode/commands/**/*.md      then <dir>/opencode.json(c) `commands`
// A `.md` command's name is its path under the commands dir without `.md`, with
// `/` kept (`commands/sub/deep.md` → `sub/deep`, which is what opencode accepts).
// The V1 `command` key is NOT a source: V2 ignores its `subagent` field.
//
// Best effort and NEVER throws: an unreadable or garbled source contributes
// nothing (logged once). Absent from the result means "unknown / foreground".
// Pure with injected I/O (commandBackground.test.mjs); the default instance at
// the bottom wires the real file system and opencode.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

export const BACKGROUND_CACHE_TTL_MS = 10_000;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The YAML frontmatter object of a markdown command file, or null when absent/garbled. */
export function parseFrontmatter(text) {
  if (typeof text !== "string") return null;
  const m = text.replace(/^\uFEFF/, "").match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const fm = parseYaml(m[1]); // throws on garbled YAML — the caller's per-file guard turns that into "nothing"
  return isPlainObject(fm) ? fm : null;
}

/** `commands/sub/deep.md` → `sub/deep` (always `/`, whatever the platform separator). */
export function commandNameFromPath(commandsDir, file) {
  return relative(commandsDir, file).split(sep).join("/").replace(/\.md$/i, "");
}

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.readGlobalConfig   parsed global opencode config
 * @param {(directory: string) => Promise<object|null>} deps.readProjectConfig  parsed project opencode.json(c) or null
 * @param {() => Promise<Array<{name: string, mode?: string}>>} deps.listAgents
 * @param {(path: string) => Promise<string>} deps.readFile
 * @param {(dir: string) => Promise<string[]>} deps.listMarkdown  recursive *.md paths (missing dir → [])
 * @param {string} deps.homeDir
 * @param {string} [deps.configHome]   XDG_CONFIG_HOME (default `<homeDir>/.config`)
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]        0 disables the cache
 * @param {(msg: string) => void} [deps.warn]
 */
export function createCommandBackgroundReader(deps) {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? BACKGROUND_CACHE_TTL_MS;
  const warnedKeys = new Set();
  const warn = (key, msg, e) => {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    try {
      (deps.warn ?? ((m) => console.warn(m)))(`[commandBackground] ${msg}${e ? `: ${String(e?.message ?? e)}` : ""}`);
    } catch {
      /* logging must never throw */
    }
  };
  const cache = new Map(); // directory ("" = none) → { at, promise }

  /** Run one source; any failure → that source contributes nothing. */
  async function guarded(key, label, fn, fallback) {
    try {
      return await fn();
    } catch (e) {
      warn(key, `${label} unreadable — ignored`, e);
      return fallback;
    }
  }

  /** name → definition ({subagent?, agent?}) from a config's native `commands` key. */
  function definitionsFromConfig(cfg) {
    const out = new Map();
    if (!isPlainObject(cfg) || !isPlainObject(cfg.commands)) return out;
    for (const [name, def] of Object.entries(cfg.commands)) {
      if (isPlainObject(def)) out.set(name, def);
    }
    return out;
  }

  /** name → frontmatter for every readable `.md` under a commands dir. */
  async function definitionsFromMarkdown(commandsDir) {
    const out = new Map();
    const files = await guarded(`list:${commandsDir}`, `commands dir ${commandsDir}`, () => deps.listMarkdown(commandsDir), []);
    for (const file of files) {
      const fm = await guarded(`file:${file}`, `command file ${file}`, async () => parseFrontmatter(await deps.readFile(file)), null);
      if (fm) out.set(commandNameFromPath(commandsDir, file), fm);
    }
    return out;
  }

  async function compute(directory) {
    const configHome = deps.configHome || join(deps.homeDir, ".config");
    const globalCommandsDir = join(configHome, "opencode", "commands");
    const [globalCfg, projectCfg, agents, globalMd, projectMd] = await Promise.all([
      guarded("global-config", "global opencode config", () => deps.readGlobalConfig(), null),
      directory
        ? guarded(`project-config:${directory}`, `project opencode config in ${directory}`, () => deps.readProjectConfig(directory), null)
        : null,
      guarded("agents", "agent list", () => deps.listAgents(), []),
      definitionsFromMarkdown(globalCommandsDir),
      directory ? definitionsFromMarkdown(join(directory, ".opencode", "commands")) : new Map(),
    ]);
    const subagentNames = new Set(
      (Array.isArray(agents) ? agents : []).filter((a) => a && a.mode === "subagent" && typeof a.name === "string").map((a) => a.name),
    );
    const definitions = new Map();
    for (const layer of [globalMd, definitionsFromConfig(globalCfg), projectMd, definitionsFromConfig(projectCfg)]) {
      for (const [name, def] of layer) definitions.set(name, def);
    }
    const names = new Set();
    for (const [name, def] of definitions) {
      if (def.subagent === true) names.add(name);
      else if (def.subagent !== false && typeof def.agent === "string" && subagentNames.has(def.agent)) names.add(name);
    }
    return names;
  }

  /** @returns {Promise<Set<string>>} names of the commands proven to run in the background; never rejects */
  async function backgroundCommandNames(directory) {
    const key = typeof directory === "string" ? directory : "";
    const hit = cache.get(key);
    if (ttlMs > 0 && hit && now() - hit.at < ttlMs) return new Set(await hit.promise);
    const promise = compute(key).catch((e) => {
      warn("compute", "background-command scan failed — none marked", e);
      return new Set();
    });
    if (ttlMs > 0) cache.set(key, { at: now(), promise });
    return new Set(await promise);
  }

  return { backgroundCommandNames };
}

// ---- real I/O ----

const MAX_DEPTH = 8;

export async function listMarkdownRecursive(dir, depth = 0) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return [];
    throw e;
  }
  const out = [];
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory() && depth < MAX_DEPTH) out.push(...(await listMarkdownRecursive(full, depth + 1)));
    else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push(full);
  }
  return out.sort();
}

async function readJsoncFile(path) {
  let text;
  try {
    text = await readFile(path, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  const errors = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) throw new Error(`${path} is not valid JSONC`);
  return parsed;
}

/** `<dir>/opencode.json` then `<dir>/opencode.jsonc` (later wins), or null when neither exists. */
export async function readProjectConfigFromDisk(directory) {
  const [json, jsonc] = await Promise.all([readJsoncFile(join(directory, "opencode.json")), readJsoncFile(join(directory, "opencode.jsonc"))]);
  if (!json && !jsonc) return null;
  return { ...(json ?? {}), commands: { ...(json?.commands ?? {}), ...(jsonc?.commands ?? {}) } };
}

/** The reader wired to the real file system and opencode — what rpc.mjs uses. */
export const defaultCommandBackgroundReader = createCommandBackgroundReader({
  readGlobalConfig: async () => (await import("./providers.mjs")).readOpencodeConfig(),
  readProjectConfig: readProjectConfigFromDisk,
  listAgents: async () => (await import("./opencode.mjs")).listAgents(),
  readFile: (p) => readFile(p, "utf-8"),
  listMarkdown: listMarkdownRecursive,
  homeDir: homedir(),
  configHome: process.env.XDG_CONFIG_HOME || undefined,
});

export const backgroundCommandNames = (directory) => defaultCommandBackgroundReader.backgroundCommandNames(directory);
