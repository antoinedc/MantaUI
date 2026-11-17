// Minimal tmux/pty/bus/local/syncState/push stubs for the rpc seam tests —
// buildHandlers only closes over them; those tests never touch them. `over`
// replaces any dep wholesale, except `local`, which merges onto the default
// (so a test can add `configUpdate` without restating `configGet`).
export const stubRpcDeps = (over = {}) => ({
  tmux: { listProjects: async () => [] },
  pty: {},
  bus: {},
  syncState: {
    refreshNow: async () => {},
    applyConfig: () => {},
    snapshot: () => ({ projects: [] }),
    payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }),
    everSucceeded: () => true,
  },
  push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
  ...over,
  local: { configGet: async () => ({ projects: [] }), ...over.local },
});
