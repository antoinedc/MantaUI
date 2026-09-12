import { internalSessionsStore, patchStore } from "./ctoStores.mjs";

export function createInternalSessions({ store = internalSessionsStore } = {}) {
  const creating = new Set();
  const internal = new Set();
  const owners = new Map();

  function ids(payload) {
    if (payload?.ids === undefined && payload?.v === 1) return [];
    if (!Array.isArray(payload?.ids) || payload.ids.some((id) => typeof id !== "string" || !id)) {
      throw new Error("invalid-internal-provenance");
    }
    return payload.ids;
  }

  function beginInternalSession() {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    creating.add(pending);
    let finishing;
    return (sid) => finishing ??= (async () => {
      try {
        if (typeof sid === "string" && sid) {
          internal.add(sid);
          await patchStore(store, (fresh) => ({ ids: [...new Set([...ids(fresh), sid])] }));
        }
      } finally {
        creating.delete(pending);
        release();
      }
    })();
  }

  async function internalSessionIds() {
    await Promise.all([...creating]);
    // Read fresh so multiple producers and restart-time readers agree. This
    // identity check must never turn a read failure into a user default.
    return new Set([...ids(await store.load()), ...internal]);
  }

  async function isInternalSession(sid) {
    return (await internalSessionIds()).has(sid);
  }

  async function resolvePipelineSession(sessionID, listProjects) {
    if (!sessionID) return { owner: "unknown" };
    if (await isInternalSession(sessionID)) return { owner: "cto" };
    const cached = owners.get(sessionID);
    if (cached && cached.until > Date.now()) return cached.info;
    const projects = await listProjects();
    if (await isInternalSession(sessionID)) return { owner: "cto" };
    for (const p of projects ?? []) {
      const w = (p.windows ?? []).find((w) => w.opencodeSessionId === sessionID);
      if (w) {
        const info = { owner: w.owner ?? "user", project: p.tmuxSession };
        owners.set(sessionID, { info, until: Date.now() + 5000 });
        if (owners.size > 4096) owners.delete(owners.keys().next().value);
        return info;
      }
    }
    return { owner: "unknown" };
  }

  return { beginInternalSession, isInternalSession, resolvePipelineSession, internalSessionIds };
}

export const { beginInternalSession, isInternalSession, resolvePipelineSession, internalSessionIds } = createInternalSessions();
