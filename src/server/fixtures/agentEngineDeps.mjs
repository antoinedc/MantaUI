// The deps every agents-engine test gives `createAgentsEngine` the same way: a temp root, a fake config writer, a steerable clock and
// autonomy level (`w.clock`, `w.level`), and a place to see what the engine published (`w.pubs`).
import { MODES } from "../../shared/autonomyShared.mjs";
import { fakeConfigWriter } from "./agentConfigFake.mjs";

export function baseEngineDeps({ root, templatesDir, config, w }) {
  return {
    root,
    templatesDir,
    home: "/h",
    now: () => w.clock,
    isGitRepo: async () => true,
    editConfig: fakeConfigWriter(config),
    reload: async () => ({ ok: true, reloaded: true }),
    log: { warn: () => {} },
    retryDelayMs: 0,
    autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: w.level }),
    publish: (p) => w.pubs.push(p),
  };
}
