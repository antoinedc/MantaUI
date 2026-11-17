// testHelpers.mjs — shared fixtures for the knowledge tests (not a test file).
// A real-git runner over the git CLI (the production runner is simple-git; the
// store only needs `run(args, {cwd, env})`), plus tmp dirs and an in-memory state.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openState } from "./state.mjs";

export function execGitRunner(defaultCwd) {
  return {
    run(args, { cwd = defaultCwd, env } = {}) {
      return new Promise((resolve, reject) => {
        execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...(env ?? {}) }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            const e = new Error(stderr || err.message);
            e.stderr = stderr;
            e.code = err.code;
            reject(e);
          } else resolve(stdout);
        });
      });
    },
  };
}

export const tmpDir = (prefix = "knowledge-test-") => mkdtemp(join(tmpdir(), prefix));

export async function memState() {
  return openState({ path: ":memory:" });
}

/** A git repo with an optional remote, returns its path. */
export async function makeRepo({ remote, remotes = {}, dir } = {}) {
  const root = dir ?? (await tmpDir("knowledge-repo-"));
  await mkdir(root, { recursive: true });
  const g = execGitRunner(root);
  await g.run(["init", "-q"]);
  await writeFile(join(root, "f.txt"), "x");
  await g.run(["add", "-A"]);
  await g.run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const all = { ...(remote ? { origin: remote } : {}), ...remotes };
  for (const [name, url] of Object.entries(all)) await g.run(["remote", "add", name, url]);
  return root;
}

export const fakeLint = async () => ({ preset: { meta: { id: "p" } }, lintSource: async () => ({ messages: [] }) });

/** An in-memory knowledge-settings config: `{get, update}` as the engine takes it, plus `current()`. */
export function memConfig(initial) {
  let cfg = initial;
  return { get: async () => cfg, update: async (p) => (cfg = { ...cfg, ...p }), current: () => cfg };
}

/**
 * The engine deps every engine-level fixture shares: a git store at `dir`, sessions resolved to the temp repos
 * (`sessions` maps session id → project name; an unknown session lands in the first repo), a notification
 * recorder, a manual clock and quiet timers. Spread it into createKnowledgeEngine and add the rest.
 */
export function baseEngineDeps({ dir, repos, sessions, config, notes, clock }) {
  return {
    dir,
    git: execGitRunner(dir),
    config,
    getSession: async (id) => ({ directory: repos[sessions[id]] ?? repos[Object.keys(repos)[0]] }),
    isCtoSession: async () => false,
    loadLint: fakeLint,
    secretValues: () => [],
    fireNotify: async (n) => notes.push(n),
    maintenanceMs: 3_600_000,
    curatorMs: 3_600_000,
    log: () => {},
    listSessionsPage: async () => [],
    now: () => clock.t,
  };
}

/**
 * A bare "remote" under `root` whose `main` carries `files` (name → content, or `{link}` for a symlink).
 * Returns {remote, g}: the bare repo's path and a git runner rooted at `root`.
 */
export async function seededBareRemote(root, files) {
  const remote = join(root, "remote.git");
  const g = execGitRunner(root);
  await g.run(["init", "--bare", "-q", "-b", "main", remote]);
  const seed = join(root, "seed");
  await mkdir(seed);
  const sg = execGitRunner(seed);
  await sg.run(["init", "-q", "-b", "main"]);
  for (const [n, c] of Object.entries(files)) {
    if (c && typeof c === "object" && c.link) await symlink(c.link, join(seed, n));
    else await writeFile(join(seed, n), c);
  }
  await sg.run(["add", "-A"]);
  await sg.run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  await sg.run(["remote", "add", "origin", `file://${remote}`]);
  await sg.run(["push", "-q", "origin", "main"]);
  return { remote, g };
}
