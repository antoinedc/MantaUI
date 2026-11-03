// ===== Path-link resolution (batching, cache, invalidation) =====
//
// Turns detected path candidates into confirmed links: the box's
// `fs:resolve-paths` says which candidates exist as a readable file/folder on the box.
// Spec: docs/superpowers/specs/2026-11-02-file-explorer.md §Path links.
//
// ONE module-level resolver shared by every link in the app:
//   - requests from every rendered message / link of a session are collected
//     and sent together after a 150 ms quiet period, in chunks of at most
//     FS_RESOLVE_MAX paths, with at most 2 requests in flight per session;
//   - results are cached under (sessionId, cwd, rawPath) together with the
//     file generation they were asked at (explorer/fileChanges.ts);
//   - when a session's generation moves on (a file-changing tool finished, or
//     the stream resynced) cached entries are stale: they keep rendering until
//     a fresh answer replaces them, and are re-requested;
//   - a reply that lands after the generation moved on is discarded.
// A candidate becomes a link only on `ok:true`; every other outcome (and a box
// that cannot answer) leaves the text exactly as it was.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { FS_RESOLVE_MAX, type FsResolved } from "../shared/fsTypes";
import { getFileGeneration, useFileGeneration } from "./explorer/fileChanges";
import type { ExplorerOwner } from "./explorer/types";

export type ResolvedPath = Extract<FsResolved, { ok: true }>;

export const RESOLVE_DEBOUNCE_MS = 150;
export const RESOLVE_MAX_IN_FLIGHT = 2;
const CACHE_MAX = 5000;

type Entry = { result: FsResolved; generation: number };
type Wanted = { cwd: string; raw: string };
type Queue = {
  wanted: Map<string, Wanted>;
  /** key → the generation it was requested at. */
  inFlight: Map<string, number>;
  running: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const cache = new Map<string, Entry>();
const queues = new Map<string, Queue>();
const listeners = new Set<() => void>();

const keyOf = (sessionId: string, cwd: string, raw: string) => `${sessionId}\0${cwd}\0${raw}`;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of Array.from(listeners)) l();
}

function queueFor(sessionId: string): Queue {
  let q = queues.get(sessionId);
  if (!q) {
    q = { wanted: new Map(), inFlight: new Map(), running: 0, timer: null };
    queues.set(sessionId, q);
  }
  return q;
}

function remember(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

async function dispatch(sessionId: string, q: Queue, cwd: string, batch: Array<{ key: string; raw: string }>) {
  const generation = getFileGeneration(sessionId);
  for (const b of batch) q.inFlight.set(b.key, generation);
  q.running += 1;
  let results: FsResolved[] | null = null;
  try {
    const res = await window.api.fsResolvePaths({ base: cwd, paths: batch.map((b) => b.raw) });
    results = Array.isArray(res?.results) ? res.results : null;
  } catch (e) {
    // Background enrichment, not a user action: the text simply stays text.
    console.warn("[path-links] fs:resolve-paths failed", e);
  } finally {
    q.running -= 1;
    for (const b of batch) q.inFlight.delete(b.key);
  }
  if (results && getFileGeneration(sessionId) === generation) {
    const byInput = new Map(results.map((r) => [r.input, r]));
    for (const b of batch) {
      const result = byInput.get(b.raw);
      if (result) remember(b.key, { result, generation });
    }
    notify();
  }
  if (q.timer == null) pump(sessionId);
}

function pump(sessionId: string): void {
  const q = queues.get(sessionId);
  if (!q) return;
  while (q.running < RESOLVE_MAX_IN_FLIGHT && q.wanted.size > 0) {
    const cwd = q.wanted.values().next().value!.cwd;
    const batch: Array<{ key: string; raw: string }> = [];
    for (const [key, w] of q.wanted) {
      if (w.cwd !== cwd) continue;
      batch.push({ key, raw: w.raw });
      if (batch.length >= FS_RESOLVE_MAX) break;
    }
    for (const b of batch) q.wanted.delete(b.key);
    void dispatch(sessionId, q, cwd, batch);
  }
}

function want(owner: ExplorerOwner, paths: readonly string[]): void {
  if (typeof window.api?.fsResolvePaths !== "function") return;
  const q = queueFor(owner.sessionId);
  const generation = getFileGeneration(owner.sessionId);
  let added = false;
  for (const raw of paths) {
    const key = keyOf(owner.sessionId, owner.cwd, raw);
    if (cache.get(key)?.generation === generation) continue;
    if (q.inFlight.get(key) === generation) continue;
    if (q.wanted.has(key)) continue;
    q.wanted.set(key, { cwd: owner.cwd, raw });
    added = true;
  }
  if (!added) return;
  if (q.timer != null) clearTimeout(q.timer);
  q.timer = setTimeout(() => {
    q.timer = null;
    pump(owner.sessionId);
  }, RESOLVE_DEBOUNCE_MS);
}

function lookup(sessionId: string, cwd: string, raw: string): ResolvedPath | undefined {
  const r = cache.get(keyOf(sessionId, cwd, raw))?.result;
  return r && r.ok ? r : undefined;
}

// What the hook's component renders from: changes only when one of ITS paths
// changes outcome, so a cache write for another link never re-renders it.
function signature(sessionId: string, cwd: string, paths: readonly string[]): string {
  let s = "";
  for (const raw of paths) {
    const r = lookup(sessionId, cwd, raw);
    s += r ? `${r.kind}:${r.abs}\n` : "-\n";
  }
  return s;
}

/**
 * Resolve `paths` (as written in the transcript) against the owner's folder.
 * Returns a lookup that yields the confirmed target, or undefined while the
 * path is unresolved / missing / unreadable. No owner → nothing resolves and
 * nothing is requested.
 */
export function usePathResolution(
  owner: ExplorerOwner | null,
  paths: readonly string[],
): (raw: string) => ResolvedPath | undefined {
  const sessionId = owner?.sessionId ?? "";
  const cwd = owner?.cwd ?? "";
  const generation = useFileGeneration(sessionId);
  const pathsKey = paths.join("\n");
  const sig = useSyncExternalStore(
    subscribe,
    () => signature(sessionId, cwd, paths),
    () => "",
  );
  useEffect(() => {
    if (!owner || paths.length === 0) return;
    want(owner, paths);
    // `paths` is covered by pathsKey; `owner` by its two fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd, pathsKey, generation]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((raw: string) => (owner ? lookup(sessionId, cwd, raw) : undefined), [sessionId, cwd, sig]);
}

/** Single-path convenience: the confirmed target of one candidate. */
export function useResolvedPath(owner: ExplorerOwner | null, raw: string | null): ResolvedPath | undefined {
  const find = usePathResolution(owner, raw ? [raw] : []);
  return raw ? find(raw) : undefined;
}

/** Test seam: forget every cached answer and pending request. */
export function resetPathResolution(): void {
  for (const q of queues.values()) if (q.timer != null) clearTimeout(q.timer);
  queues.clear();
  cache.clear();
}
