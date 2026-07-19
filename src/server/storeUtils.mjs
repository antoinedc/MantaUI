// Shared atomic-write helper for the on-disk JSON stores in src/server/.
// Promoted out of src/server/schedule.mjs in BET-184 (consolidation; previously
// duplicated logic lived next to schedule's loadJobs/saveJobs). Both schedule.mjs
// and capabilities.mjs now import from here so there is exactly one
// atomic-write implementation in src/server/.

import { writeFile, rename } from "node:fs/promises";

// Write `data` to `path` atomically: write a temp file alongside, then rename.
// The temp filename encodes pid + timestamp so a process crash mid-write can
// never clobber a sibling in-flight temp from the same process (different ms),
// and a stale temp left over from a previous crash never overwrites a live
// `path` (it sits next to it as `path.tmp-<pid>-<ts>`).
export async function atomicWrite(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
