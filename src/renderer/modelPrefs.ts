// Shared per-session model choice, box-backed (BET-1281).
//
// The per-conversation model choice used to live in localStorage
// (`manta:chat:<sid>:model`); it now lives in the box store
// (src/server/modelPrefs.mjs, BET-1279) so the same conversation opened on
// another device shows the same choice. This module is the SINGLE renderer
// cache for that store — one `model-prefs:get` for the whole box, cached at
// module scope, refetched on the `model-prefs.updated` bus event. ChatPanel
// never fetches per-session (no per-session RPC channel exists or should be
// added). Modeled on modelCatalog.ts: module-level cache + a hook.
//
// The box store holds a CONCRETE per-session `ModelSelection` or ABSENCE
// (absence = server default). It has no slot for the desktop "Auto" routing mode
// (BET-1245), so Auto's flag stays device-local OUTSIDE `manta:chat:` (that
// namespace is now box-backed; the DoD grep only admits the plan key there).

import { useEffect, useMemo, useState } from "react";
import type { ModelPrefsSessionRecord, ModelPrefsState } from "../shared/types";
import type { ModelChoice, ModelSelection } from "./chatShared";

// ---- module-level cache of the whole box store ----
let cache: ModelPrefsState = { sessions: {}, recents: [] };
let inFlight: Promise<void> | null = null;
let subscribed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// Fetch once, deduped (concurrent callers share one round trip), and re-fetch on
// the box's `model-prefs.updated` bus event. GUARD (same as modelCatalog): the
// pre-pairing preload subset has no modelPrefsGet / onModelPrefsUpdated, so we
// check before touching them — calling an absent method would throw from the
// commit phase where `.catch` cannot see it.
function load(): void {
  if (inFlight) return;
  const api = window.api as Partial<typeof window.api>;
  if (!api.modelPrefsGet) return;
  if (!subscribed && api.onModelPrefsUpdated) {
    subscribed = true;
    api.onModelPrefsUpdated(() => load());
  }
  inFlight = window.api
    .modelPrefsGet()
    .then((next) => {
      // Keep the previous value on a failed/empty fetch rather than blanking.
      if (next) cache = next;
      emit();
    })
    .catch(() => {
      /* transient — keep last known state */
    })
    .finally(() => {
      inFlight = null;
    });
}

/**
 * The shared box mirror. Returns the cached value synchronously on the first
 * render (so a remount — e.g. after `/clear` — never flashes an empty choice)
 * and re-renders when a refetch brings something new.
 */
export function useModelPrefs(): ModelPrefsState {
  const [snapshot, setSnapshot] = useState<ModelPrefsState>(cache);
  useEffect(() => {
    const onChange = () => setSnapshot(cache);
    listeners.add(onChange);
    if (inFlight === null) load();
    // Adopt anything that landed between render and effect (e.g. an update
    // event refetch resolving before this effect runs).
    if (cache !== snapshot) onChange();
    return () => {
      listeners.delete(onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return snapshot;
}

// ---- device-local Auto flag ----
// The box cannot represent Auto, so it lives in a short device-local key.
// Deliberately NOT `manta:chat:`: that namespace is box-backed now, and the
// one-shot migration scans it for concrete models only. See the header comment.
export function sessionAutoKey(sessionId: string): string {
  return `manta:model-auto:${sessionId}`;
}

export function readSessionAuto(sessionId: string): boolean {
  try {
    return localStorage.getItem(sessionAutoKey(sessionId)) === "1";
  } catch {
    /* disabled storage */
    return false;
  }
}

export function writeSessionAuto(sessionId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(sessionAutoKey(sessionId), "1");
    else localStorage.removeItem(sessionAutoKey(sessionId));
  } catch {
    /* quota / disabled storage */
  }
}

// ---- pure resolution helpers (unit-tested) ----

/** A box session record → the renderer's `ModelSelection` (or null if malformed). */
export function sessionSelectionFromRecord(
  rec: ModelPrefsSessionRecord | undefined,
): ModelSelection | null {
  if (!rec) return null;
  if (
    typeof rec.providerID !== "string" ||
    rec.providerID === "" ||
    typeof rec.modelID !== "string" ||
    rec.modelID === ""
  ) {
    return null;
  }
  const model: ModelSelection = { providerID: rec.providerID, modelID: rec.modelID };
  if (typeof rec.variant === "string" && rec.variant !== "") model.variant = rec.variant;
  return model;
}

/**
 * Resolve the box `sessions` map + the device-local Auto flag into the
 * three-state choice (auto / model / server-default). Auto wins; then a present
 * box record → an explicit model; absence → server default.
 */
export function resolveSessionChoice(
  sessions: Record<string, ModelPrefsSessionRecord>,
  sessionId: string,
  isAuto: boolean,
): ModelChoice {
  if (isAuto) return { kind: "auto" };
  const model = sessionSelectionFromRecord(sessions[sessionId]);
  return model ? { kind: "model", model } : { kind: "server-default" };
}

/**
 * The current session's choice, live: re-resolved whenever the box mirror
 * refreshes and when the device-local Auto flag changes (reads it per render).
 */
export function useSessionModelChoice(sessionId: string): ModelChoice {
  const { sessions } = useModelPrefs();
  const isAuto = readSessionAuto(sessionId);
  const rec = sessions[sessionId];
  // Resolve to primitive fields so the memo is STABLE across a no-op box
  // refetch (the mirror hands back a new object with the same contents). A
  // consumer depends on `sessionChoice` identity to reseed its local override;
  // making it stable means a routing-applied override is not clobbered by an
  // empty initial/refetch that resolves to the same stored choice.
  const providerID =
    typeof rec?.providerID === "string" && rec.providerID !== "" ? rec.providerID : null;
  const modelID =
    typeof rec?.modelID === "string" && rec.modelID !== "" ? rec.modelID : null;
  const variant =
    typeof rec?.variant === "string" && rec.variant !== "" ? rec.variant : undefined;
  const kind: ModelChoice["kind"] =
    isAuto ? "auto" : providerID && modelID ? "model" : "server-default";
  return useMemo(() => {
    switch (kind) {
      case "auto":
        return { kind: "auto" as const };
      case "model":
        return {
          kind: "model" as const,
          model: { providerID: providerID!, modelID: modelID!, ...(variant ? { variant } : {}) },
        };
      default:
        return { kind: "server-default" as const };
    }
  }, [kind, providerID, modelID, variant]);
}

/**
 * The concrete model the box currently holds for `sessionId` (from the cached
 * mirror), or null. Synchronous — used by non-hook call sites (e.g. the routing
 * effect's incumbent read) that can't subscribe to the cache.
 */
export function sessionBoxSelection(sessionId: string): ModelSelection | null {
  return sessionSelectionFromRecord(cache.sessions[sessionId]);
}

/**
 * Persist a user pick: update the device-local Auto flag immediately and write
 * the box. auto → local flag only (the box has no Auto slot); model → the box
 * session record; server-default → delete the box session record. This is the
 * single write path — the same setter powers selectModel, auto, /clear carry
 * and the app-control switch-model fallback. Fire-and-forget; a client
 * refetching its own write is a harmless no-op (no echo suppression).
 */
export function setSessionChoice(sessionId: string, choice: ModelChoice): void {
  writeSessionAuto(sessionId, choice.kind === "auto");
  if (choice.kind === "auto") return;
  const api = window.api as Partial<typeof window.api>;
  if (!api.modelPrefsSet) return; // pre-pairing subset
  // Fire-and-forget: the local override already updated optimistically. A failed
  // write just means the box isn't synced yet — swallow it (no toast on every
  // pick); the next update event refetch reconciles.
  void window.api
    .modelPrefsSet({
      sessionId,
      selection: choice.kind === "model" ? choice.model : null,
    })
    .catch(() => {});
}

// ---- one-shot migration (BET-1281 step 4) ----
// The old localStorage keys were `manta:chat:<sessionId>:model`, holding either
// a `ModelSelection` JSON object, the bare literal `"auto"`, or (badly) something
// else. Scan them into the box, then remove the keys, then set the flag. Do NOT
// touch `manta:chat:*:plan` (plan mode is out of scope).

const OLD_PREFIX = "manta:chat:";
const OLD_SUFFIX = ":model";

export type OldModelValue =
  | { sessionId: string; kind: "model"; model: ModelSelection }
  | { sessionId: string; kind: "auto" };

/**
 * Parse one legacy storage key/value into a concrete model or an Auto marker.
 * Returns null for non-model keys, an empty session id, a missing value, an
 * unrecognised/malformed value, or the literal "auto"-only forms that carry no
 * model (those are handled by the Auto marker). Malformed values are skipped
 * (returned null) — a broken value must never break the migration.
 */
export function parseOldModelPrefs(key: string, raw: string | null): OldModelValue | null {
  if (!key.startsWith(OLD_PREFIX) || !key.endsWith(OLD_SUFFIX)) return null;
  const sessionId = key.slice(OLD_PREFIX.length, key.length - OLD_SUFFIX.length);
  if (sessionId === "") return null;
  if (raw === null) return null;
  if (raw === "auto") return { sessionId, kind: "auto" };
  try {
    const p = JSON.parse(raw);
    if (
      p &&
      typeof p.providerID === "string" &&
      p.providerID !== "" &&
      typeof p.modelID === "string" &&
      p.modelID !== ""
    ) {
      const model: ModelSelection = { providerID: p.providerID, modelID: p.modelID };
      if (typeof p.variant === "string" && p.variant !== "") model.variant = p.variant;
      return { sessionId, kind: "model", model };
    }
  } catch {
    /* malformed JSON — skip */
  }
  return null;
}

/**
 * Scan a caller-supplied bag of keys via `getEntry` (injectable so the function
 * is pure/unit-testable; the real caller passes localStorage). Builds the
 * `{ sessions }` map + the Auto session ids, skipping malformed values. Returns
 * null when nothing parseable was found (caller then skips the seed + flag).
 */
export function collectOldModelPrefs(
  getEntry: (key: string) => string | null,
  keys: string[],
): { sessions: Record<string, ModelSelection>; auto: string[] } | null {
  let found = false;
  const sessions: Record<string, ModelSelection> = {};
  const auto: string[] = [];
  for (const key of keys) {
    const parsed = parseOldModelPrefs(key, getEntry(key));
    if (!parsed) continue;
    found = true;
    if (parsed.kind === "auto") auto.push(parsed.sessionId);
    else sessions[parsed.sessionId] = parsed.model;
  }
  return found ? { sessions, auto } : null;
}

/**
 * One-shot migration. Called once after pairing (next to loadPersistedSnapshot)
 * when the flag is absent: scan `manta:chat:*:model` keys, seed the concrete
 * models to the box (`model-prefs:seed`) + the Auto flags locally, remove the
 * scanned keys, and set the flag. Best-effort; never throws out of boot.
 */
export function migrateModelPrefs(): void {
  const FLAG = "manta:model-prefs:migrated";
  try {
    if (localStorage.getItem(FLAG) !== null) return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const getEntry = (k: string) => localStorage.getItem(k);
    const collected = collectOldModelPrefs(getEntry, keys);
    if (collected) {
      const api = window.api as Partial<typeof window.api>;
      if (collected.sessions && Object.keys(collected.sessions).length > 0 && api.modelPrefsSeed) {
        void window.api.modelPrefsSeed({ sessions: collected.sessions }).catch(() => {});
      }
      for (const sid of collected.auto) setSessionChoice(sid, { kind: "auto" });
    }
    // Remove every scanned model key (Auto segments of the keys are removed
    // here too; the Auto flag migration wrote a NEW key, so no conflict).
    for (const key of keys) {
      if (parseOldModelPrefs(key, getEntry(key))) localStorage.removeItem(key);
    }
    localStorage.setItem(FLAG, "1");
  } catch {
    /* best-effort — never break boot over a migration */
  }
}
