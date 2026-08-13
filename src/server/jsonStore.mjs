// Single source of truth for the atomic JSON read/write dance used by every
// durable store on the box (cap-jobs, schedule, webhooks, secrets, serve-page).
// Promoted out of the five per-store copies in BET-376 — a pure collapse, no
// behaviour change: each store keeps its own load/save wrapper (name, signature,
// async-ness, record shape, default, fallback and mode are all preserved), only
// the temp-file-then-rename core now lives here.
//
// `readJsonSync` is synchronous because `loadHooks`/`loadSecrets`/`loadPages`
// are synchronous today and changing that would ripple into their callers. It
// returns `fallback` on any failure — missing file, unreadable file, or invalid
// JSON — and never throws.
//
// `writeJsonAtomic` keeps the existing temp-file-then-rename pattern, applies
// `mode` to the final file when supplied (matching the 0600 stores), and
// creates the parent directory if missing (matching what the existing copies
// did before each write).

import { readFileSync, existsSync } from "node:fs";
import { writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// A FIFO single-writer mutex (a promise tail). `runExclusive(fn)` guarantees
// that `fn` never overlaps another `fn` on the same mutex, in call order. Stores
// on the box use it to make their whole read-modify-write atomic — the shared
// primitive behind the per-store writer serialization (BET-770).
export function createMutex() {
  let tail = Promise.resolve();
  return {
    runExclusive(fn) {
      const run = tail.then(() => fn());
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}

// A globally-unique suffix for temp files. pid + timestamp make it unique
// across processes and across writes a millisecond apart; the monotonic counter
// makes it unique even for two same-process, same-millisecond writes to one
// path, which the old `pid-Date.now()` suffix could not guarantee (BET-770
// P3-1). The counter is only touched inside the per-path mutex below, so it
// never races.
let tmpSeq = 0;

// Reads and parses `path` as JSON. Returns `fallback` when the file is missing,
// unreadable, or contains invalid JSON. Never throws.
export function readJsonSync(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

// Per-path writer queues. Concurrent writes to the SAME path are serialized so
// the temp-file-then-rename dance can never interleave (two writers to one path
// cannot race on `rename`, and a reader can never observe a half-written final
// file). Different paths run in parallel.
const pathLocks = new Map();
function lockForPath(path) {
  let lock = pathLocks.get(path);
  if (!lock) {
    lock = createMutex();
    pathLocks.set(path, lock);
  }
  return lock;
}

// Write `data` (already-serialized bytes) to `path` atomically: write a temp
// file alongside, then rename. The temp filename encodes pid + timestamp + a
// monotonic counter and is generated under the path's writer lock, so two
// same-process, same-millisecond writes to one path can never collide — the
// old `pid-Date.now()` suffix could, and a colliding `rename` would throw
// ENOENT into a poller or clobber the final file. A stale temp from a previous
// crash never overwrites a live `path`. When `mode` is supplied it is applied
// to the temp file (and re-asserted via chmod, since writeFile's mode is only
// honoured on create) so the renamed final file carries it.
export async function writeJsonAtomic(path, data, { mode } = {}) {
  await lockForPath(path).runExclusive(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${(tmpSeq++).toString(36)}`;
    if (mode !== undefined) {
      await writeFile(tmp, data, { mode });
      await chmod(tmp, mode).catch(() => {});
    } else {
      await writeFile(tmp, data);
    }
    await rename(tmp, path);
  });
}
