// skillsCli.mjs — the Architect's `skills` research source (Architect v2 §4.2, docs/superpowers/specs/2026-11-27-architect-v2.md).
//
// Search only: a pinned, box-local install of the `skills` CLI (vercel-labs/skills, MIT) under ~/.manta/tools/skills. The pin is a lockfile
// committed beside this file (`skillsCli/package.json` + `package-lock.json`, every package by integrity hash); the first use runs
// `npm ci --ignore-scripts` against the npm registry from it, and a changed lockfile (a release moved the pin) installs again. The CLI is
// then run as `node <bin> find -- <query>` — argv, no shell, `queryRefusal` first (the CLI reads its argument with util.parseArgs, which ends
// option parsing at `--`), a 40 s timeout, in a throwaway HOME with a minimal environment (no tokens, no user npm config, telemetry off).
// A failed install is not retried for 10 minutes. Its text output is parsed and never executed; stderr is never returned. The CLI's own
// `add` is never used: it would install for every agent, outside any proposal.

import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fsPromises from "node:fs/promises";
import { ResearchError } from "./transport.mjs";
import { queryRefusal } from "./extra.mjs";

export const SKILLS_CLI_VERSION = "1.9.1";
export const SKILLS_FIND_TIMEOUT_MS = 40_000;
export const SKILLS_INSTALL_TIMEOUT_MS = 180_000;
export const INSTALL_BACKOFF_MS = 10 * 60_000; // after a failed install, no new attempt for this long
export const NOTE_MAX = 500; // a note handed back to the model
const REGISTRY = "https://registry.npmjs.org/";
/** The committed package.json + package-lock.json that pin the CLI. */
export const BUNDLED_LOCK_DIR = fileURLToPath(new URL("./skillsCli/", import.meta.url));
const LOCK_MARKER = ".installed-lock"; // the sha256 of the lockfile the installed node_modules came from
const MAX_BUFFER = 1024 * 1024;
const MAX_RESULTS = 40;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
export const stripAnsi = (text) => String(text ?? "").replace(ANSI_RE, "");

/** "938.2K" → 938200, "1.2M" → 1200000, "939" → 939, "1,204" → 1204; anything else null. */
export function parseInstalls(text) {
  const m = /^([\d][\d,]*(?:\.\d+)?)\s*([KMB])?$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase()] ?? 1;
  return Math.round(n * unit);
}

const REF_LINE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([A-Za-z0-9._:-]+)\s+(\S+)\s+installs?$/;
const ADDRESS_LINE = /^[└╰\u2514\u2570]\s*(https:\/\/skills\.sh\/\S+)$/u;

/**
 * `[{ ref, repo, skill, installs, url }]` from the CLI's text: a line `owner/repo@skill 938.2K installs`, then `└ https://skills.sh/…`.
 * A line that doesn't have that shape is ignored; an address that isn't on skills.sh is dropped (url null).
 */
export function parseFindOutput(text) {
  const lines = stripAnsi(text).split(/\r?\n/).map((l) => l.trim());
  const out = [];
  for (let i = 0; i < lines.length && out.length < MAX_RESULTS; i++) {
    const m = REF_LINE.exec(lines[i]);
    if (!m) continue;
    const next = /^[└╰]/u.test(lines[i + 1] ?? "") ? lines[i + 1] : "";
    const url = ADDRESS_LINE.exec(next)?.[1] ?? null;
    out.push({ ref: `${m[1]}@${m[2]}`, repo: m[1], skill: m[2], installs: parseInstalls(m[3]), url });
  }
  return out;
}

/**
 * @param {object} deps
 * @param {string} deps.toolsRoot   ~/.manta/tools/skills
 * @param {Function} deps.exec      execFile-shaped `(file, args, opts) → Promise<{stdout}>`
 * @param {string} [deps.lockDir]   the folder holding the pinned package.json + package-lock.json
 * @param {string} [deps.nodePath]  the node that runs the CLI (this server's own)
 */
export function createSkillsFinder({ toolsRoot, exec, lockDir = BUNDLED_LOCK_DIR, fs = fsPromises, pathEnv = process.env.PATH, nodePath = process.execPath, now = Date.now, log = console }) {
  const binPath = join(toolsRoot, "node_modules", "skills", "bin", "cli.mjs");
  const pkgPath = join(toolsRoot, "node_modules", "skills", "package.json");
  const throwawayHome = join(toolsRoot, "home"); // the CLI and npm run with this as HOME: nothing of the user's is read or written
  const basePath = () => [...new Set([dirname(nodePath), ...String(pathEnv ?? "").split(":").filter(Boolean), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
  // what the CLI runs with: nothing else (no tokens, no SKILLS_* overrides, no CI flags)
  const findEnv = () => ({ PATH: basePath(), HOME: throwawayHome, LANG: "C.UTF-8", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", npm_config_registry: REGISTRY });
  // what npm runs with: the public registry only, no user or global npm config
  const installEnv = () => ({
    PATH: basePath(),
    HOME: throwawayHome,
    LANG: "C.UTF-8",
    npm_config_registry: REGISTRY,
    npm_config_userconfig: join(throwawayHome, "user.npmrc"), // empty files of our own: npm refuses the same path for both
    npm_config_globalconfig: join(throwawayHome, "global.npmrc"),
    npm_config_cache: join(throwawayHome, ".npm"),
  });

  let pinned = null; // the sha256 of the committed lockfile
  const pinnedLockHash = async () => {
    pinned ??= createHash("sha256").update(await fs.readFile(join(lockDir, "package-lock.json"))).digest("hex");
    return pinned;
  };

  // installed = the marker names the committed lockfile AND the files on disk are that version of the CLI
  const isInstalled = async () => {
    try {
      if ((await fs.readFile(join(toolsRoot, LOCK_MARKER), "utf-8")).trim() !== (await pinnedLockHash())) return false;
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
      await fs.access(binPath);
      return pkg?.version === SKILLS_CLI_VERSION;
    } catch {
      return false;
    }
  };

  const UNAVAILABLE = "The skills search isn't available on this box right now (its tool couldn't be installed); search GitHub or the web instead";
  let installing = null;
  let failedAt = null;
  async function ensureInstalled() {
    if (await isInstalled()) return;
    if (failedAt !== null && now() - failedAt < INSTALL_BACKOFF_MS) throw new ResearchError(UNAVAILABLE);
    installing ??= (async () => {
      try {
        await fs.mkdir(throwawayHome, { recursive: true });
        for (const f of ["user.npmrc", "global.npmrc"]) await fs.writeFile(join(throwawayHome, f), "");
        for (const f of ["package.json", "package-lock.json"]) await fs.copyFile(join(lockDir, f), join(toolsRoot, f));
        await exec("npm", ["ci", "--prefix", toolsRoot, "--ignore-scripts", `--registry=${REGISTRY}`, "--no-audit", "--no-fund", "--loglevel=error"], {
          cwd: toolsRoot,
          env: installEnv(),
          timeout: SKILLS_INSTALL_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          shell: false,
          windowsHide: true,
        });
        const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
        await fs.access(binPath);
        if (pkg?.version !== SKILLS_CLI_VERSION) throw new Error(`installed ${pkg?.version}`);
        await fs.writeFile(join(toolsRoot, LOCK_MARKER), await pinnedLockHash());
        failedAt = null;
      } catch (e) {
        failedAt = now();
        log.warn?.(`[research] couldn't install the skills CLI: ${e?.message ?? e}`);
        throw new ResearchError(UNAVAILABLE);
      }
    })().finally(() => {
      installing = null;
    });
    await installing;
  }

  const note = (t) => String(t).slice(0, NOTE_MAX);

  /** `{ results, note? }`. Throws a ResearchError with a fixed sentence. */
  async function find(query) {
    const refused = queryRefusal(query);
    if (refused) throw new ResearchError(refused);
    await ensureInstalled();
    let stdout;
    try {
      await fs.mkdir(throwawayHome, { recursive: true });
      // `--` ends option parsing in the CLI (util.parseArgs): the query is a positional whatever it looks like
      ({ stdout } = await exec(nodePath, [binPath, "find", "--", query], { cwd: throwawayHome, env: findEnv(), timeout: SKILLS_FIND_TIMEOUT_MS, maxBuffer: MAX_BUFFER, shell: false, windowsHide: true }));
    } catch (e) {
      if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") throw new ResearchError("The skills search timed out; try a simpler query or search GitHub");
      if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new ResearchError("The skills search returned more than 1 MiB");
      throw new ResearchError(`The skills search failed (exit ${typeof e?.code === "number" ? e.code : "?"})`);
    }
    const text = stripAnsi(stdout);
    const results = parseFindOutput(text);
    if (results.length === 0) return { results, note: note(/no skills found/i.test(text) ? text.trim().split("\n").find((l) => /no skills found/i.test(l)).trim() : "No skills were listed for that query") };
    return { results };
  }

  return { find, ensureInstalled, binPath };
}
