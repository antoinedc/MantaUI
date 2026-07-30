// Thin re-export of the atomic-write primitive. The temp-file-then-rename dance
// now lives in src/server/jsonStore.mjs (BET-376), the single source of truth
// for every on-disk JSON store's read/write. This wrapper is kept so existing
// importers (src/server/tmux.mjs) keep compiling unchanged; new stores should
// import readJsonSync / writeJsonAtomic from jsonStore.mjs directly.

import { writeJsonAtomic } from "./jsonStore.mjs";

// Write `data` to `path` atomically (temp file + rename). Delegates to
// jsonStore.writeJsonAtomic, which also creates the parent directory if missing
// (idempotent — harmless for callers that already mkdir'd, like tmux.mjs).
export async function atomicWrite(path, data) {
  await writeJsonAtomic(path, data);
}
