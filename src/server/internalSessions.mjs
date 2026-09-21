import { internalSessionsStore, ledgerStore, patchStore } from "./ctoStores.mjs";
import { readConversationRole, CONVERSATION_ROLE } from "./ctoBinding.mjs";

// The durable CEO conversation's role label contrast for the generic internal
// class. The conversation itself is NEVER in these tombstones — it is
// recognized via the binding record (readConversationRole), keeping the two
// provenance registers separate (P3a1 review blocker 4).
export const CTO_INTERNAL_ROLE = "cto_internal";

const generations = new WeakMap();
export function createInternalSessions({ store = internalSessionsStore, now = Date.now, barrierMs = 250,
  readAttempts = 3,
  report = (row) => ledgerStore.append(row),
  conversationReader = readConversationRole } = {}) {
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

  // One read attempt: barrier on in-flight registrations (a read that precedes
  // a still-queued registration could fail OPEN — classify a cto-internal
  // session as a pipeline session — so the wait is load-bearing), then the
  // shared load flight, then the writer/read generation check.
  async function readInternalSessionIdsOnce() {
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
  }

  // BET-1541: the 250ms barrier is a per-attempt bound, not a total one. Under
  // patchStore write-lock contention (concurrent ephemeral-session
  // registrations) the creating set drains slower than one barrier, which sent
  // 749 provenance-timeout rows to the ledger — every read of the scan, search
  // and backfill died on a transient stall. A read is now retried: each
  // attempt gets a fresh barrierMs window, `provenance-updating` (a pure
  // writer/read generation race) retries immediately. The fail-closed budget
  // is readAttempts × barrierMs (default 3 × 250ms = 750ms): a genuinely stuck
  // store still fails every consumer closed within that budget, and only the
  // FINAL failure reports to the ledger (transient blips that recover on
  // retry stay out of the noise). Non-transient failures (corrupt payload,
  // store.load rejections) break immediately.
  async function internalSessionIds() {
    const attempts = Math.max(1, readAttempts);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await readInternalSessionIdsOnce();
      } catch (error) {
        lastError = error;
        snapshot = null;
        const transient = error?.message === "provenance-updating" || error?.message === "provenance-timeout";
        if (!transient || attempt === attempts) break;
      }
    }
    if (now() - lastReport >= 300_000) {
      lastReport = now();
      void Promise.resolve().then(() => report({ kind: "cto.provenance_unavailable", actor: "cto", ts: now(),
        code: lastError?.message === "provenance-timeout" ? "timeout" : "store-unavailable" })).catch(() => {});
    }
    throw lastError;
  }

  async function isInternalSession(sid) {
    if (internal.has(sid)) return true;
    return (await internalSessionIds()).has(sid);
  }

  async function resolvePipelineSession(sessionID, listProjects) {
    if (!sessionID) return { owner: "unknown" };
    // Distinct role provenance (P3a1 review blocker 4): the durable CEO
    // conversation is recognized from the BINDING record — checked before the
    // generic tombstones and before tmux — so readers can tell a human CEO
    // message (cto_conversation) apart from the CTO's own ephemeral inference
    // sessions (cto_internal). A corrupt binding store fails closed (throws).
    if (await conversationReader(sessionID)) return { owner: "cto", role: CONVERSATION_ROLE };
    if (await isInternalSession(sessionID)) return { owner: "cto", role: CTO_INTERNAL_ROLE };
    const cached = owners.get(sessionID);
    if (cached && cached.until > now()) return cached.info;
    if (!projectsFlight) projectsFlight = Promise.resolve().then(listProjects).finally(() => { projectsFlight = null; });
    const projects = await bounded(projectsFlight);
    if (await isInternalSession(sessionID)) return { owner: "cto", role: CTO_INTERNAL_ROLE };
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
