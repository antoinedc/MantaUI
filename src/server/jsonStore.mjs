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

// Read and parse `path` as JSON. Returns `fallback` when the file is missing,
// unreadable, or contains invalid JSON. Never throws.
export function readJsonSync(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

// Write `data` (already-serialized bytes) to `path` atomically: write a temp
// file alongside, then rename. The temp filename encodes pid + timestamp so a
// crash mid-write can never clobber a sibling in-flight temp, and a stale temp
// from a previous crash never overwrites a live `path`. When `mode` is supplied
// it is applied to the temp file (and re-asserted via chmod, since writeFile's
// mode is only honoured on create) so the renamed final file carries it.
export async function writeJsonAtomic(path, data, { mode } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (mode !== undefined) {
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode).catch(() => {});
  } else {
    await writeFile(tmp, data);
  }
  await rename(tmp, path);
}
