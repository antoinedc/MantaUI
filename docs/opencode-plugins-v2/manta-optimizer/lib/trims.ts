// Trim persistence (contract C4) — one JSON file per session under
// <stateHome>/.manta/optimizer-trims/<sessionID>.json (dir 0700, files 0600).
// stateHome honours MANTA_STATE_HOME (the test seam; production resolves to $HOME).
// Writes are SYNCHRONOUS (temp + rename) and happen only on grow / clear /
// shadow-change — rare by design — and BEFORE the request is sent, so a crash can
// never lose a trim that already went upstream. One opencode process per box is
// assumed; a session's writes are serialized by construction (single-threaded,
// synchronous). Same logic as the V1 plugin (docs/opencode-plugins/manta-optimizer.ts).

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_MAP_ENTRIES } from "./plan.ts";
import type { Boundary, TrimState } from "./types.ts";

export const TRIMS_VERSION = 1;
export const RENDER_VERSION = 1;
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const HOUR_MS = 3_600_000;
export const PRUNE_AGE_MS = 14 * 24 * HOUR_MS;
export const MAX_SESSIONS_IN_MEMORY = 512;

export function stateHome(env: Record<string, string | undefined> = process.env): string {
  const o = env.MANTA_STATE_HOME;
  return typeof o === "string" && o.trim() !== "" ? o : homedir();
}
export const trimsDir = (): string => join(stateHome(), ".manta", "optimizer-trims");
export const trimFile = (sessionID: string): string => join(trimsDir(), `${sessionID}.json`);

const warned = new Set<string>();
export function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    console.warn(`[manta-optimizer] ${msg}`);
  } catch {
    /* logging must never throw */
  }
}

export function freshState(): TrimState {
  return {
    version: TRIMS_VERSION,
    renderVersion: RENDER_VERSION,
    real: {},
    shadow: {},
    reqCount: 0,
    nextGrowthAllowedAt: 0,
    shadowNextGrowthAllowedAt: 0,
    lastModel: null,
    updatedAt: 0,
  } as TrimState;
}

function cleanMap(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (id === "__proto__" || typeof raw[id] !== "string") continue;
    if (++n > MAX_MAP_ENTRIES) break;
    out[id] = raw[id];
  }
  return out;
}

export function sanitizeState(raw: any): TrimState {
  const s = freshState();
  if (!raw || typeof raw !== "object" || raw.version !== TRIMS_VERSION) return s;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  s.real = cleanMap(raw.real);
  s.shadow = cleanMap(raw.shadow);
  s.reqCount = num(raw.reqCount);
  s.nextGrowthAllowedAt = num(raw.nextGrowthAllowedAt);
  s.shadowNextGrowthAllowedAt = num(raw.shadowNextGrowthAllowedAt);
  s.lastModel = typeof raw.lastModel === "string" ? raw.lastModel : null;
  s.updatedAt = num(raw.updatedAt);
  return s;
}

/** Cold load, synchronous. Files > 4 MB are refused (treated as empty); corrupt → empty. Logs once. */
export function loadState(sessionID: string): TrimState {
  const file = trimFile(sessionID);
  try {
    if (statSync(file).size > MAX_STATE_BYTES) {
      warnOnce(`big:${sessionID}`, `trim file for ${sessionID} exceeds 4 MB — ignoring it`);
      return freshState();
    }
    return sanitizeState(JSON.parse(readFileSync(file, "utf-8")));
  } catch (e: any) {
    if (e?.code !== "ENOENT") warnOnce(`load:${sessionID}`, `could not read trim file for ${sessionID}: ${e?.code ?? e?.message ?? e}`);
    return freshState();
  }
}

/** Synchronous temp + rename; the temp is removed on failure. Returns false on any failure. */
export function saveStateSync(sessionID: string, state: TrimState): boolean {
  const file = trimFile(sessionID);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(trimsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (e: any) {
    try {
      unlinkSync(tmp);
    } catch {
      /* no temp to remove */
    }
    warnOnce(`save:${sessionID}`, `could not write trim file for ${sessionID}: ${e?.code ?? e?.message ?? e}`);
    return false;
  }
}

/** Per-session in-memory entry. `boundary` is memory-only: a restart has none. */
export interface Entry {
  state: TrimState;
  boundary: Boundary | null;
  touchedAt: number;
}

/** The trim store: LRU-512 session entries + hourly mtime touch + hourly 14-day prune. */
export function createTrimStore() {
  const entries = new Map<string, Entry>();
  let lastPruneAt = 0;
  return {
    get(sessionID: string): Entry {
      let e = entries.get(sessionID);
      if (e) {
        entries.delete(sessionID);
        entries.set(sessionID, e);
        return e;
      }
      e = { state: loadState(sessionID), boundary: null, touchedAt: 0 };
      entries.set(sessionID, e);
      while (entries.size > MAX_SESSIONS_IN_MEMORY) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return e;
    },
    /** While a session is in use, touch its file at most once an hour so it is not pruned. */
    touch(sessionID: string, entry: Entry, now: number): void {
      if (now - entry.touchedAt < HOUR_MS) return;
      entry.touchedAt = now;
      try {
        const t = new Date(now);
        utimesSync(trimFile(sessionID), t, t);
      } catch {
        /* no file (nothing trimmed yet) */
      }
    },
    /** Delete trim files untouched for > 14 days — at most once per hour. */
    prune(now: number): void {
      if (now - lastPruneAt < HOUR_MS) return;
      lastPruneAt = now;
      try {
        const dir = trimsDir();
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const p = join(dir, f);
          try {
            if (now - statSync(p).mtimeMs > PRUNE_AGE_MS) unlinkSync(p);
          } catch {
            /* raced with another delete — fine */
          }
        }
      } catch {
        /* no dir yet */
      }
    },
  };
}
