// Shared test doubles for the ctoSessions suites (ctoSessions.test.mjs, ctoSessions.failover.test.mjs): hermetic, no fs.

export const allow = async () => ({ ok: true });

export function fakeEngineState(initial = {}) {
  let payload = { ...initial };
  return {
    async load() {
      return payload;
    },
    async save(p) {
      payload = p;
    },
    peek() {
      return payload;
    },
  };
}
