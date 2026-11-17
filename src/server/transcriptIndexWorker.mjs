// transcriptIndexWorker.mjs — the worker_thread side of transcriptIndex.mjs: hosts ONE
// ctoSearchIndex instance on its own thread, so the synchronous node:sqlite work (index
// writes, FTS5 `optimize` during eviction — 20-60 s per GB — and the FTS queries) never
// blocks manta-server's event loop.
//
// Two roles (workerData.role), each with its own sqlite connection to the same file:
//   "sync"   the single WRITER. Runs sync() batches; the index is put in WAL mode.
//   "search" a READER (opened read-only). In WAL mode it never waits for the writer, so a
//            search answers while the writer is in the middle of an eviction.
//
// Protocol: parent → {id, op: "sync"|"search"|"status", args}; worker → {id, ok, result} |
// {id, ok:false, error:{message}}. `args.internalIds` is the parent's authoritative list of
// internal session ids (the in-memory registry only the main thread sees): it becomes the
// provenance filter for the call, so exclusion never depends on a file the worker re-reads.

import { parentPort, workerData } from "node:worker_threads";
import { _setOffloadMode } from "./dbOffload.mjs";
import { createCtoSearchIndex } from "./ctoSearchIndex.mjs";

// The source reads run on this thread; the offload pool would only spawn nested workers.
_setOffloadMode("inline");

const { role = "search", path, maxBytes } = workerData ?? {};
const index = createCtoSearchIndex({
  path,
  ...(Number.isFinite(maxBytes) ? { maxBytes } : {}),
  readOnly: role === "search",
  wal: role === "sync",
  busyTimeoutMs: 5000,
});

parentPort.on("message", async (msg) => {
  const { id, op, args } = msg ?? {};
  try {
    const { internalIds, ...rest } = args ?? {};
    const call = { ...rest, ...(Array.isArray(internalIds) ? { provenanceFilter: async () => internalIds } : {}) };
    let result;
    if (op === "sync") result = await index.sync(call);
    else if (op === "search") result = await index.search(call);
    else if (op === "status") result = await index.status();
    else if (op === "close") {
      index.close();
      result = { ok: true };
    } else throw new Error(`unknown op: ${op}`);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: { message: String(e?.message ?? e) } });
  }
});
