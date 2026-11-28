// The box's own git runner for work that can be slow (a copy of a real project, a log over a long history).
//
// `tmux.run("git", …)` is tmux's helper: it kills anything after 10 s and says "tmux timed out" even when the command was
// git — so a clone of a real project failed every time with a message pointing at the wrong program. This runs git directly:
// execFile (no shell, the argv is never parsed), a timeout that suits the command, and errors that name git.
import { execFile as nodeExecFile } from "node:child_process";
import { tmuxSpawnEnv } from "./tmux.mjs";

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * `createGitRunner({ execFileImpl?, defaultTimeoutMs? })` → `git(args, { timeoutMs? }) → Promise<{ stdout, stderr }>`.
 * A timed-out git is killed (SIGKILL) and rejects with "git <subcommand> timed out after <n>s"; a failing git rejects with
 * "git exited <code>: <stderr>" (the same shape the tmux helper used, so callers that show it keep reading the same).
 */
export function createGitRunner({ execFileImpl = nodeExecFile, defaultTimeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  return function git(args, { timeoutMs = defaultTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      execFileImpl(
        "git",
        args,
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, encoding: "utf8", env: tmuxSpawnEnv() },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
          if (err.killed || err.signal === "SIGKILL" || err.signal === "SIGTERM") {
            // `-c k=v` and `-C dir` pairs come first; the subcommand is the first word that isn't one of them
            const sub = subcommandOf(args);
            return reject(new Error(`git${sub ? ` ${sub}` : ""} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }
          const detail = String(stderr ?? "").trim() || String(stdout ?? "").trim() || err.message;
          reject(new Error(`git exited ${err.code ?? "?"}: ${detail}`));
        },
      );
    });
  };
}

function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "-C") { i++; continue; }
    if (String(args[i]).startsWith("-")) continue;
    return String(args[i]);
  }
  return "";
}

/** The runner the server wires into the engines that run git. */
export const gitRun = createGitRunner();
