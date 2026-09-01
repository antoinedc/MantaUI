// BET-1490: the no-op engine-deps stub shared by the cto.test.mjs and
// ctoInbound.test.mjs engine tests — every list/read seam returns empty so
// the tests stay deterministic and side-effect free. Callers spread their
// own overrides on top.
export function makeEngineDeps(overrides = {}) {
  return {
    listProjects: async () => [],
    listSessions: async () => [],
    listMessages: async () => [],
    listModels: async () => [],
    getSessionAgent: async () => null,
    listSnapshots: () => [],
    listStopped: async () => ({ records: [], lastLooked: null }),
    searchMessages: async () => ({ supported: true, hits: [] }),
    configGet: async () => ({}),
    gitStatus: async () => "",
    gitBranch: async () => null,
    gitLog: async () => "",
    ...overrides,
  };
}
