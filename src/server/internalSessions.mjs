import { internalSessionsStore, ledgerStore, patchStore } from "./ctoStores.mjs";

const generations = new WeakMap();
export function createInternalSessions({ store = internalSessionsStore, now = Date.now, barrierMs = 250,
  report = (row) => ledgerStore.append(row) } = {}) {
  const creating = new Set();
  const internal = new Set();
  const owners = new Map();
  let snapshot, loading, projectsFlight;
  let lastReport = -Infinity;

  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("provenance-timeout")), barrierMs);
      })]);
    } finally { clearTimeout(timer); }
  }

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
          snapshot?.ids.add(sid);
          await patchStore(store, (fresh) => ({ ids: [...new Set([...ids(fresh), sid])] }));
        }
      } finally {
        generations.set(store, (generations.get(store) ?? 0) + 1);
        snapshot = null;
        creating.delete(pending);
        release();
      }
    })();
  }

  async function internalSessionIds() {
    try {
      await bounded(Promise.all([...creating]));
      if (!loading) {
        loading = (async () => {
          const generation = generations.get(store) ?? 0;
          const stamp = await store.stamp?.();
          if (!snapshot || snapshot.stamp !== stamp || snapshot.generation !== generation || snapshot.until <= now()) {
            snapshot = { ids: new Set([...ids(await store.load()), ...internal]), stamp, generation, until: now() + 5000 };
          }
          return snapshot.ids;
        })().finally(() => { loading = null; });
      }
      const loaded = await bounded(loading);
      if (snapshot?.generation !== (generations.get(store) ?? 0)) throw new Error("provenance-updating");
      return loaded;
    } catch (error) {
      snapshot = null;
      if (now() - lastReport >= 300_000) {
        lastReport = now();
        void Promise.resolve().then(() => report({ kind: "cto.provenance_unavailable", actor: "cto", ts: now(),
          code: error.message === "provenance-timeout" ? "timeout" : "store-unavailable" })).catch(() => {});
      }
      throw error;
    }
  }

  async function isInternalSession(sid) {
    if (internal.has(sid)) return true;
    return (await internalSessionIds()).has(sid);
  }

  async function resolvePipelineSession(sessionID, listProjects) {
    if (!sessionID) return { owner: "unknown" };
    if (await isInternalSession(sessionID)) return { owner: "cto" };
    const cached = owners.get(sessionID);
    if (cached && cached.until > now()) return cached.info;
    if (!projectsFlight) projectsFlight = Promise.resolve().then(listProjects).finally(() => { projectsFlight = null; });
    const projects = await bounded(projectsFlight);
    if (await isInternalSession(sessionID)) return { owner: "cto" };
    let info = { owner: "unknown" };
    for (const p of projects ?? []) {
      const w = (p.windows ?? []).find((w) => w.opencodeSessionId === sessionID);
      if (w) {
        info = { owner: w.owner ?? "user", project: p.tmuxSession, cwd: w.paneCurrentPath ?? p.defaultCwd };
        break;
      }
    }
    owners.set(sessionID, { info, until: now() + (info.owner === "unknown" ? 1000 : 5000) });
    if (owners.size > 4096) owners.delete(owners.keys().next().value);
    return info;
  }

  return { beginInternalSession, isInternalSession, resolvePipelineSession, internalSessionIds };
}

export const { beginInternalSession, isInternalSession, resolvePipelineSession, internalSessionIds } = createInternalSessions();
