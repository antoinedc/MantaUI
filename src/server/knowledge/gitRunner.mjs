// gitRunner.mjs — the one place the knowledge subsystem touches git.
//
// Every module takes a *runner*: `run(args, {cwd, env}) → Promise<string>` (the
// stdout of `git <args>`; throws an Error carrying `.stderr` on failure). The
// default runner is built on simple-git (spec §10: git via simple-git 4.0.2),
// loaded lazily so a missing package degrades the subsystem instead of
// crashing the server at import time. Tests inject their own runner.

// simple-git's environment guard (spec §10: simple-git 4.0.2) refuses EXPLICITLY passed `GIT_*`/editor/
// pager/ssh-command variables unless listed in `allowEnvironment`, and passing the whole ambient
// environment counts as explicit. So the child gets a whitelist of the ambient variables git
// needs (never the box user's GIT_SSH_COMMAND/EDITOR/…), plus ours, and only OUR `GIT_*` names are
// allow-listed.
const AMBIENT_RE = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TMPDIR|TEMP|TMP|SYSTEMROOT|XDG_[A-Z_]+|SSH_AUTH_SOCK|HTTPS?_PROXY|NO_PROXY)$/i;
const BASE_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
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
      const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => AMBIENT_RE.test(k)));
      const full = { ...ambient, ...BASE_ENV, ...(env ?? {}) };
      const allowEnvironment = Object.keys({ ...BASE_ENV, ...(env ?? {}) }).filter((k) => /^git_/i.test(k));
      // `allowUnsafeConfigEnvCount`: the repository writer hands the forge credential to ONE command through
      // GIT_CONFIG_COUNT/KEY_n/VALUE_n (never argv, where /proc shows it). Ambient GIT_* variables never reach the child
      // (see AMBIENT_RE), so only a caller that sets them explicitly can use this.
      const git = simpleGit({ baseDir: cwd, timeout: { block: BLOCK_TIMEOUT_MS }, allowEnvironment, unsafe: { allowUnsafeConfigEnvCount: true } }).env(full);
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
