// delegateLivenessLog.mjs — the evidence log for the liveness follow-up routine (spec 2026-11-14 §8).
//
// One JSON line per Manta-owned terminal run segment (what the engine knew at the moment of the decision), plus a one-time
// `{"type":"deployed"}` line the first time a box boots with the feature. Appended to `~/.manta/delegate-liveness.jsonl`
// (through statePath), rotated at 5 MB, rotated files kept 90 days. A failure here never touches a job transition.

import { appendFile, readdir, rename, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { statePath } from "../shared/paths.mjs";

export const LIVENESS_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LIVENESS_LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;

export function createLivenessLog({
  path = statePath("delegate-liveness.jsonl"),
  markerPath = statePath("delegate-liveness.deployed"),
  now = () => Date.now(),
  maxBytes = LIVENESS_LOG_MAX_BYTES,
  retentionMs = LIVENESS_LOG_RETENTION_MS,
} = {}) {
  let chain = Promise.resolve();

  async function rotateIfNeeded() {
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    await rename(path, `${path}.${now()}`);
    await prune();
  }

  async function prune() {
    const dir = dirname(path);
    const prefix = `${basename(path)}.`;
    for (const name of await readdir(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        const st = await stat(join(dir, name));
        if (now() - st.mtimeMs > retentionMs) await unlink(join(dir, name));
      } catch {
        /* a file that vanished is pruned */
      }
    }
  }

  function append(obj) {
    const run = chain.then(async () => {
      await rotateIfNeeded();
      await appendFile(path, `${JSON.stringify(obj)}\n`);
    });
    chain = run.catch(() => {});
    return run.catch((e) => console.warn("[delegate] liveness log append failed:", e?.message ?? e));
  }

  return {
    /** One line for a finished Manta-owned run segment. */
    appendSegment(entry) {
      return append({ at: now(), ...entry });
    },
    /** Write the `deployed` line once per box (marker file), the first time the feature boots. */
    async recordDeployed({ version = null, gitSha = null } = {}) {
      try {
        try {
          await readFile(markerPath, "utf-8");
          return false;
        } catch {
          /* not written yet */
        }
        await append({ type: "deployed", at: now(), version, gitSha });
        await writeFile(markerPath, JSON.stringify({ at: now(), version, gitSha }));
        return true;
      } catch (e) {
        console.warn("[delegate] recording the liveness deployment failed:", e?.message ?? e);
        return false;
      }
    },
    prune: () => prune().catch(() => {}),
    path,
  };
}
