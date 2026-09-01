// Shared in-memory store fixtures for the src/server/cto*.test.mjs files.
//
// BET-1490: extracted from byte-identical copies that the duplication-gate's
// strict policy flags as soon as two of the owning files land in one PR
// (BET-1469 deliberately mirrored the fixtures; this shared module replaces
// the mirror without changing any shape).

// BET-1469: the in-memory `stores` bundle handed to the engine so its default
// sub-engine constructions (cards/trust/verdicts/watchers/probes/segments/
// rollups/facts/profile/journal/budget) all bind memory, never real files.
// Shapes mirror ctoStores.mjs: json stores are single-payload { load, save };
// dir stores are one-payload-per-id { load(id), save(id, data) } over a Map;
// the rollups store namespaces by level. No fs anywhere: `dir` is "" so the
// engine's readdir fall-throughs short-circuit, and pathFor is identity.
export function makeMemoryStores() {
  const jsonStore = (initial) => {
    let payload = { ...initial };
    return {
      load: async () => ({ ...payload }),
      save: async (p) => {
        payload = { ...p };
      },
    };
  };
  const dirStore = () => {
    const map = new Map();
    return {
      dir: "",
      pathFor: (id) => id,
      load: async (id) => map.get(id) ?? { v: 1 },
      save: async (id, data) => {
        map.set(id, data);
      },
    };
  };
  return {
    ledger: { append: async () => true },
    engineState: jsonStore({ v: 1 }),
    trust: jsonStore({}),
    cards: jsonStore({ v: 1, cards: [] }),
    inbox: jsonStore({ v: 1, entries: [] }),
    verdicts: jsonStore({ entries: [] }),
    budget: jsonStore({}),
    watchers: jsonStore({ watchers: [] }),
    toolRegistry: jsonStore({ tools: [] }),
    toolUsage: jsonStore({}),
    probeState: dirStore(),
    segments: dirStore(),
    rollups: {
      dir: "",
      dirFor: (level) => `mem://rollups/${level}`,
      load: async () => ({ v: 1 }),
      save: async () => {},
    },
    facts: dirStore(),
    factsArchive: dirStore(),
    profile: jsonStore({}),
    journal: jsonStore({ entries: [] }),
  };
}

// Deep-copy at the boundary like the real jsonStore (a parsed clone per
// load/save) — aliasing the live object would fake both stale snapshots and
// clobbers.
export function memoryStore(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial ?? {}));
  return {
    load: async () => JSON.parse(JSON.stringify(data)),
    save: async (p) => {
      data = JSON.parse(JSON.stringify(p));
    },
  };
}
