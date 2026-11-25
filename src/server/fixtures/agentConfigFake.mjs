// A one-file stand-in for opencode.jsonc, for the agents tests: the config writer applies its edits to a plain object
// (`config.cfg`), counts a reload per real change in `config.reloads`, records every edit in `config.edits`, and fails with
// `config.failEdit` as its error when that is set. Same call shape as providers.editConfig: edits, or a function of the config.
export function fakeConfigWriter(config) {
  return async (fn) => {
    if (config.failEdit) return { ok: false, changed: false, error: config.failEdit };
    const edits = typeof fn === "function" ? await fn(config.cfg) : fn;
    for (const e of edits) {
      config.edits.push(e);
      const [, key] = e.path;
      config.cfg.agent ??= {};
      if (e.value === undefined) delete config.cfg.agent[key];
      else config.cfg.agent[key] = structuredClone(e.value);
    }
    if (edits.length > 0) config.reloads++; // the writer reloads after a real change
    return { ok: true, changed: edits.length > 0, reloaded: edits.length > 0 };
  };
}
