// Per-session transcript cache, persisted to disk.
//
// Problem: opencode's `GET /session/{id}/message` takes 20–35 s on a 3 MB
// transcript (no server-side cache, full deserialization on every call). The
// renderer blocks on `!messages` showing "Loading session…" for the entire
// fetch, which dominates perceived session-switch latency.
//
// Solution: stash the last successful transcript per sessionId on disk. The
// renderer reads the cached copy synchronously-ish at mount and renders it
// immediately, then kicks off the real fetch in the background and swaps the
// fresh transcript in when it lands. The slow fetch still happens — we just
// stop blocking the UI on it.
//
// Persistence is best-effort: we tolerate read/write failures (the worst
// case is the old behavior, a blank load screen). Writes are debounced per
// sessionId so an SSE-driven refetch storm doesn't hammer the disk.
//
// LRU eviction caps the on-disk footprint. Transcripts grow without bound
// over a session's lifetime (bannerman sessions reach 3 MB), so leaving every
// session ever opened on disk would eat hundreds of MB.

import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OpencodeMessage } from "../shared/types.js";

// Keep the N most-recently-written transcripts on disk. 200 covers heavy
// users without blowing past ~1 GB at worst-case 5 MB per transcript.
const MAX_CACHED_TRANSCRIPTS = 200;
// Debounce per-session disk writes. Refetches fire on every SSE-triggered
// 300 ms refetch tick; coalesce burst writes.
const WRITE_DEBOUNCE_MS = 1000;

function cacheDir(): string {
  return join(app.getPath("userData"), "transcripts");
}

function cachePath(sessionId: string): string {
  // Session IDs are `ses_<base62>` — safe as filenames as-is on macOS/Linux.
  return join(cacheDir(), `${sessionId}.json`);
}

const memCache = new Map<string, OpencodeMessage[]>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

export function getCachedTranscript(sessionId: string): OpencodeMessage[] | null {
  // Memory hit first — avoids JSON.parse on every session switch within a run.
  const mem = memCache.get(sessionId);
  if (mem) return mem;
  const path = cachePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as OpencodeMessage[];
    if (!Array.isArray(parsed)) return null;
    memCache.set(sessionId, parsed);
    return parsed;
  } catch {
    // Corrupt cache file — drop it and miss. The fresh fetch will repopulate.
    try { unlinkSync(path); } catch { /* best-effort */ }
    return null;
  }
}

export function setCachedTranscript(
  sessionId: string,
  messages: OpencodeMessage[],
): void {
  memCache.set(sessionId, messages);
  // Debounce the disk write: SSE-driven refetches fire frequently during an
  // active turn, and each transcript is up to 3 MB. Coalesce so we only
  // serialize once per WRITE_DEBOUNCE_MS per session.
  const existing = pendingWrites.get(sessionId);
  if (existing) clearTimeout(existing);
  pendingWrites.set(
    sessionId,
    setTimeout(() => {
      pendingWrites.delete(sessionId);
      void flushOne(sessionId, messages);
    }, WRITE_DEBOUNCE_MS),
  );
}

async function flushOne(
  sessionId: string,
  messages: OpencodeMessage[],
): Promise<void> {
  const dir = cacheDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return; // Can't create cache dir — silently disable caching for this turn.
  }
  const finalPath = cachePath(sessionId);
  // Atomic write: serialize first, then rename. Avoids a partial file the
  // next mount would JSON.parse and throw on.
  const tmpPath = `${finalPath}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(messages), "utf-8");
    renameSync(tmpPath, finalPath);
  } catch {
    // Disk full, permissions, etc. — best-effort.
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return;
  }
  // Cheap LRU sweep — bounded by MAX_CACHED_TRANSCRIPTS so we don't grow
  // unbounded over months of use.
  evictOldest();
}

function evictOldest(): void {
  const dir = cacheDir();
  let entries: Array<{ path: string; mtime: number }>;
  try {
    entries = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const path = join(dir, f);
        try {
          return { path, mtime: statSync(path).mtimeMs };
        } catch {
          return { path, mtime: 0 };
        }
      });
  } catch {
    return;
  }
  if (entries.length <= MAX_CACHED_TRANSCRIPTS) return;
  entries.sort((a, b) => a.mtime - b.mtime); // oldest first
  const toEvict = entries.slice(0, entries.length - MAX_CACHED_TRANSCRIPTS);
  for (const { path } of toEvict) {
    try { unlinkSync(path); } catch { /* best-effort */ }
  }
}

// Drop the cache for a session (e.g. after delete). Best-effort.
export function dropCachedTranscript(sessionId: string): void {
  memCache.delete(sessionId);
  const pending = pendingWrites.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    pendingWrites.delete(sessionId);
  }
  try { unlinkSync(cachePath(sessionId)); } catch { /* best-effort */ }
}
