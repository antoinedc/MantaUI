// gitRunner.mjs — the one place the knowledge subsystem touches git.
//
// Every module takes a *runner*: `run(args, {cwd, env}) → Promise<string>` (the
// stdout of `git <args>`; throws an Error carrying `.stderr` on failure). The
// default runner is built on simple-git (spec §10: git via simple-git 4.0.2),
// loaded lazily so a missing package degrades the subsystem instead of
// crashing the server at import time. Tests inject their own runner.

const BASE_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C" });
const BLOCK_TIMEOUT_MS = 120_000;

export function createGitRunner({ simpleGitFactory, defaultCwd } = {}) {
  let loading = null;
  const load = () => {
    if (simpleGitFactory) return Promise.resolve(simpleGitFactory);
    loading ??= import("simple-git").then((m) => m.simpleGit ?? m.default);
    return loading;
  };
  return {
    async run(args, { cwd = defaultCwd, env } = {}) {
      const simpleGit = await load();
      const git = simpleGit({ baseDir: cwd, timeout: { block: BLOCK_TIMEOUT_MS } }).env({ ...process.env, ...BASE_ENV, ...(env ?? {}) });
      try {
        return await git.raw(args);
      } catch (e) {
        const err = new Error(String(e?.message ?? e));
        err.stderr = String(e?.message ?? e);
        err.cause = e;
        throw err;
      }
    },
  };
}
