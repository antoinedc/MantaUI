// testHelpers.mjs — shared fixtures for the knowledge tests (not a test file).
// A real-git runner over the git CLI (the production runner is simple-git; the
// store only needs `run(args, {cwd, env})`), plus tmp dirs and an in-memory state.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
