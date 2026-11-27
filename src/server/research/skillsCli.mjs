// skillsCli.mjs — the Architect's `skills` research source (Architect v2 §4.2, docs/superpowers/specs/2026-11-27-architect-v2.md).
//
// Search only: a pinned, box-local install of the `skills` CLI (vercel-labs/skills, MIT) under ~/.manta/tools/skills, installed on
// first use with `npm install --prefix`, then run as `node <bin> find <query>` — argv, no shell, `queryRefusal` first, a 40 s timeout,
// telemetry off. Its text output is parsed and never executed; stderr is never returned. The CLI's own `add` is never used: it would
// install for every agent, outside any proposal.

import { join, dirname } from "node:path";
import fsPromises from "node:fs/promises";
import { ResearchError } from "./transport.mjs";
import { queryRefusal } from "./extra.mjs";

export const SKILLS_CLI_VERSION = "1.9.1";
export const SKILLS_FIND_TIMEOUT_MS = 40_000;
export const SKILLS_INSTALL_TIMEOUT_MS = 180_000;
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
 * @param {string} [deps.nodePath]  the node that runs the CLI (this server's own)
 */
export function createSkillsFinder({ toolsRoot, exec, fs = fsPromises, home, pathEnv = process.env.PATH, nodePath = process.execPath, log = console }) {
  const binPath = join(toolsRoot, "node_modules", "skills", "bin", "cli.mjs");
  const pkgPath = join(toolsRoot, "node_modules", "skills", "package.json");
  const env = () => ({
    PATH: [...new Set([dirname(nodePath), ...String(pathEnv ?? "").split(":").filter(Boolean), "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
    HOME: home,
    LANG: "C.UTF-8",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
  });

  const isInstalled = async () => {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
      await fs.access(binPath);
      return pkg?.version === SKILLS_CLI_VERSION;
    } catch {
      return false;
    }
  };

  let installing = null;
  async function ensureInstalled() {
    if (await isInstalled()) return;
    installing ??= (async () => {
      try {
        await fs.mkdir(toolsRoot, { recursive: true });
        await exec("npm", ["install", "--prefix", toolsRoot, `skills@${SKILLS_CLI_VERSION}`, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"], {
          cwd: toolsRoot,
          env: env(),
          timeout: SKILLS_INSTALL_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          shell: false,
          windowsHide: true,
        });
      } catch (e) {
        log.warn?.(`[research] couldn't install the skills CLI: ${e?.message ?? e}`);
      }
      if (!(await isInstalled())) throw new ResearchError("The skills search isn't available on this box right now (its tool couldn't be installed); search GitHub or the web instead");
    })().finally(() => {
      installing = null;
    });
    await installing;
  }

  /** `{ results, note? }`. Throws a ResearchError with a fixed sentence. */
  async function find(query) {
    const refused = queryRefusal(query);
    if (refused) throw new ResearchError(refused);
    await ensureInstalled();
    let stdout;
    try {
      ({ stdout } = await exec(nodePath, [binPath, "find", query], { cwd: toolsRoot, env: env(), timeout: SKILLS_FIND_TIMEOUT_MS, maxBuffer: MAX_BUFFER, shell: false, windowsHide: true }));
    } catch (e) {
      if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") throw new ResearchError("The skills search timed out; try a simpler query or search GitHub");
      if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new ResearchError("The skills search returned more than 1 MiB");
      throw new ResearchError(`The skills search failed (exit ${typeof e?.code === "number" ? e.code : "?"})`);
    }
    const text = stripAnsi(stdout);
    const results = parseFindOutput(text);
    if (results.length === 0) return { results, note: /no skills found/i.test(text) ? text.trim().split("\n").find((l) => /no skills found/i.test(l)).trim() : "No skills were listed for that query" };
    return { results };
  }

  return { find, ensureInstalled, binPath };
}
