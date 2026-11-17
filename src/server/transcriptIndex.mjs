// transcriptIndex.mjs — the knowledge subsystem's transcript search index, run OFF the main
// thread (shared-knowledge spec §7.2).
//
// manta-server's event loop is shared by every client, and `node:sqlite` is synchronous: an
// index sync (and above all its size-cap eviction, which ends with an FTS5 `optimize` — a full
// rewrite, 20-60 s per GB) would freeze the whole server. So this module owns two worker
// threads (transcriptIndexWorker.mjs), each with its own connection to the same index file:
//
//   writer  runs sync() batches on a poller. WAL mode.
//   reader  answers searches. Read-only, WAL: it never waits for the writer, so a search is
//           answered even while an eviction is running.
//
// The main thread only posts messages. A call that outlives its timeout abandons that worker
// (a native sqlite call cannot be interrupted; the thread dies when it returns) and the next
// call starts a fresh one — one pathological query cannot wedge later ones.
//
// `searchTranscripts` is the adapter the knowledge engine takes
// (`{query, directories, anyTerms, limit}` → `{hits: [{sessionID, messageID, partID, snippet, at}], truncated}`);
// any failure degrades to an empty, truncated answer — a search never throws into a tool call.

import { Worker } from "node:worker_threads";
import { statePath } from "../shared/paths.mjs";

export const TRANSCRIPT_INDEX_FILE = ["knowledge", "search-index.sqlite"];

const DEFAULTS = Object.freeze({
  syncBatch: 500,
  // Gap after a batch that indexed something (catching up / new activity) and after one that
  // found nothing new (the cyclic re-read of history is hash-gated: cheap, so slow is fine).
  busyGapMs: 2_000,
  idleGapMs: 30_000,
  errorGapMs: 60_000,
  unsupportedGapMs: 60 * 60_000,
  syncTimeoutMs: 15 * 60_000,
  searchTimeoutMs: 15_000,
});

export class TranscriptIndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TranscriptIndexError";
    this.code = code;
  }
}

function defaultWorkerFactory({ path, maxBytes }) {
  return (role) => {
    const w = new Worker(new URL("./transcriptIndexWorker.mjs", import.meta.url), { workerData: { role, path, ...(Number.isFinite(maxBytes) ? { maxBytes } : {}) } });
    w.unref();
    return w;
  };
}

/** The engine's hit shape from the index's (camel-Id) envelope hits. */
export function toEngineHits(envelope) {
  const hits = Array.isArray(envelope?.hits) ? envelope.hits : [];
  return hits.map((h) => ({ sessionID: h.sessionId, messageID: h.messageId, partID: h.partId, snippet: h.snippet ?? "", at: h.at ?? h.timeUpdated ?? null }));
}

/**
 * @param {object} [deps]
 * @param {string} [deps.path]                  index file (default `statePath("knowledge","search-index.sqlite")`)
 * @param {number} [deps.maxBytes]              index size cap (default: the index's own, 1 GiB)
 * @param {() => Promise<Iterable<string>>} [deps.provenance]  internal session ids (resolved on THIS thread: the
 *   in-memory registry is authoritative); a failure fails the call closed
 * @param {() => boolean | Promise<boolean>} [deps.isEnabled]  polled before each sync; false = skip
 * @param {(role: "sync"|"search") => import("node:worker_threads").Worker} [deps.workerFactory]  test seam
 * @param {(...a: any[]) => void} [deps.log]
 */
export function createTranscriptIndex(deps = {}) {
  const { path = statePath(...TRANSCRIPT_INDEX_FILE), maxBytes, provenance = async () => [], isEnabled = () => true, log = console.warn } = deps;
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(deps).filter(([k, v]) => k in DEFAULTS && Number.isFinite(v))) };
  const workerFactory = deps.workerFactory ?? defaultWorkerFactory({ path, maxBytes });

  const roles = { sync: null, search: null }; // role → { worker, pending: Map<id, {resolve, reject, timer}> }
  let nextId = 1;
  let stopped = false;
  let timer = null;
  let last = null; // the last sync outcome, for status()

  function failAll(slot, error) {
    for (const [, p] of slot.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    slot.pending.clear();
  }

  function slotFor(role) {
    let slot = roles[role];
    if (slot) return slot;
    const worker = workerFactory(role);
    slot = { worker, pending: new Map() };
    roles[role] = slot;
    const drop = (error) => {
      if (roles[role] === slot) roles[role] = null;
      failAll(slot, error);
    };
    worker.on("message", (m) => {
      const p = slot.pending.get(m?.id);
      if (!p) return; // a late answer from an abandoned call
      slot.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new TranscriptIndexError("task_failed", m.error?.message ?? "index task failed"));
    });
    worker.on("error", (e) => drop(new TranscriptIndexError("worker_failed", `index worker failed: ${e?.message ?? e}`)));
    worker.on("exit", () => drop(new TranscriptIndexError("worker_failed", "index worker exited")));
    return slot;
  }

  function call(role, op, args, timeoutMs) {
    if (stopped) return Promise.reject(new TranscriptIndexError("closed", "the transcript index is stopped"));
    const slot = slotFor(role);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => {
        slot.pending.delete(id);
        // Abandon this thread: it may be inside a native call that cannot be interrupted.
        if (roles[role] === slot) roles[role] = null;
        failAll(slot, new TranscriptIndexError("timeout", `index ${op} exceeded ${timeoutMs} ms`));
        slot.worker.terminate().catch(() => {});
        reject(new TranscriptIndexError("timeout", `index ${op} exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      t.unref?.();
      slot.pending.set(id, { resolve, reject, timer: t });
      try {
        slot.worker.postMessage({ id, op, args });
      } catch (e) {
        slot.pending.delete(id);
        clearTimeout(t);
        reject(new TranscriptIndexError("worker_failed", `could not reach the index worker: ${e?.message ?? e}`));
      }
    });
  }

  const internalIds = async () => [...(await provenance())];

  /** The engine adapter. Never throws; degrades to `{hits: [], truncated: true}`. */
  async function searchTranscripts({ query, directories, anyTerms = true, limit } = {}) {
    try {
      const ids = await internalIds();
      const env = await call("search", "search", { query, directories, anyTerms, limit, internalIds: ids }, cfg.searchTimeoutMs);
      if (env?.status !== "ok") {
        // Not built yet / busy / unavailable: an honest empty answer, never a fabricated "nothing happened".
        return { hits: [], truncated: true, status: env?.status ?? "index_error" };
      }
      return { hits: toEngineHits(env), truncated: env.truncated === true, status: "ok" };
    } catch (e) {
      log("[transcriptIndex] search degraded:", e?.message ?? e);
      return { hits: [], truncated: true, status: "index_error" };
    }
  }

  /** One sync batch on the writer thread; returns `{ok, gapMs, result?|error?}` and never throws. */
  async function syncOnce() {
    try {
      const ids = await internalIds();
      const result = await call("sync", "sync", { limit: cfg.syncBatch, internalIds: ids }, cfg.syncTimeoutMs);
      last = { at: Date.now(), status: result?.status ?? "unknown", coverage: result?.coverage ?? null, size: result?.size ?? null, detail: result?.detail ?? null };
      if (result?.status === "unsupported" || result?.status === "source_unavailable") return { ok: false, gapMs: cfg.unsupportedGapMs, result };
      if (result?.status !== "ok") return { ok: false, gapMs: cfg.errorGapMs, result };
      const p = result.scanned?.parts ?? {};
      const changed = (p.indexed ?? 0) + (p.removed ?? 0) > 0;
      return { ok: true, gapMs: changed ? cfg.busyGapMs : cfg.idleGapMs, result };
    } catch (e) {
      last = { at: Date.now(), status: "error", detail: String(e?.message ?? e) };
      log("[transcriptIndex] sync failed:", e?.message ?? e);
      return { ok: false, gapMs: cfg.errorGapMs, error: e };
    }
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref?.();
  }

  async function tick() {
    if (stopped) return;
    let gap = cfg.idleGapMs;
    try {
      if ((await isEnabled()) === true) gap = (await syncOnce()).gapMs;
    } catch (e) {
      log("[transcriptIndex] tick failed:", e?.message ?? e);
      gap = cfg.errorGapMs;
    }
    schedule(gap);
  }

  return {
    searchTranscripts,
    syncOnce,
    /** Start the sync poller (the first batch runs on the next turn of the loop). */
    start() {
      if (stopped || timer) return;
      schedule(0);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      for (const role of ["sync", "search"]) {
        const slot = roles[role];
        roles[role] = null;
        if (!slot) continue;
        failAll(slot, new TranscriptIndexError("closed", "the transcript index is stopped"));
        await slot.worker.terminate().catch(() => {});
      }
    },
    status() {
      return { path, last };
    },
  };
}
