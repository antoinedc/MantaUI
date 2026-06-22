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
// `lastFreshAt` is the wall-clock ms we last received an authoritative
// transcript (a successful listMessages, or a cached read we promoted).
// `lastActivityAt` is the last time a live SSE event touched this session.
// When activity is newer than freshness, the cached payload is known-stale
// (deltas arrived after the last full fetch) and we must NOT paint it on a
// remount — doing so showed users the pre-send transcript for the 6s a fresh
// listMessages took to return, making "switch away and back" look like the
// send never happened. The disk file is still useful as a cold-start safety
// net for sessions with no SSE activity this run; we just suppress it for
// the hot cases.
const lastFreshAt = new Map<string, number>();
const lastActivityAt = new Map<string, number>();

// Called by the SSE bus on every event that carries a sessionID. Pure
// recorder — never blocks, never throws.
export function noteSessionActivity(sessionId: string): void {
  lastActivityAt.set(sessionId, Date.now());
}

export function getCachedTranscript(sessionId: string): OpencodeMessage[] | null {
  // If live SSE events for this session arrived AFTER the last time we
  // stored a fresh transcript, the cached copy is stale by definition —
  // skip it and let the renderer show its loading state until the real
  // fetch lands. Avoids the "remount shows pre-send state for 6s" bug.
  const activity = lastActivityAt.get(sessionId);
  const fresh = lastFreshAt.get(sessionId);
  if (activity != null && (fresh == null || activity > fresh)) return null;
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
  // Mark this as the freshest authoritative state we know about. A subsequent
  // SSE event bumps lastActivityAt past this and invalidates the cache until
  // the next listMessages call refreshes it.
  lastFreshAt.set(sessionId, Date.now());
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
  lastFreshAt.delete(sessionId);
  lastActivityAt.delete(sessionId);
  const pending = pendingWrites.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    pendingWrites.delete(sessionId);
  }
  try { unlinkSync(cachePath(sessionId)); } catch { /* best-effort */ }
}
