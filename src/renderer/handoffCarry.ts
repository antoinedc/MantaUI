// ===== Auto-handoff — what moves from one session to its successor (§7, §8) =====
//
// Client-local state only: the box carries the conversation, but the user's
// unsent composer text, uploaded chips, model/Auto/fast choice and plan toggle
// live in this client. This module is the hand-off point between the pane that
// is going away and the one that replaces it:
//
//   - a CARRY entry per successor session (composer text + uploaded chips, and
//     an "Edit first" draft once it has been persisted here) — written BEFORE
//     the box is told the draft was consumed, so a crash cannot lose the only
//     copy (§7), and taken (read + removed) by the successor's panel on mount;
//   - the per-session preference copy (§8).
//
// The entry lives in localStorage with an in-memory shadow, so a full or
// disabled storage degrades to "works until the app restarts" instead of
// silently dropping the user's text.

import type { ModelChoice } from "./chatShared";
import { readPlanSaved, writePlanSaved } from "./chatShared";
import { readSessionAuto, sessionBoxSelection, setSessionChoice } from "./modelPrefs";
import { appendBelow, isEmptyCarry, placeDraft, type CarriedComposer } from "./handoff";

export interface CarryEntry extends CarriedComposer {
  /** An "Edit first" draft, persisted locally before the box is told it was consumed. */
  draft?: { revision: number; text: string };
}

const carryKey = (sessionId: string) => `manta:handoff:carry:${sessionId}`;
const draftLoadedKey = (sessionId: string) => `manta:handoff:draft-loaded:${sessionId}`;
const prefsCopiedKey = (sessionId: string) => `manta:handoff:prefs-copied:${sessionId}`;

const shadow = new Map<string, CarryEntry>();

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function readEntry(sessionId: string): CarryEntry | null {
  const mem = shadow.get(sessionId);
  if (mem) return mem;
  try {
    const raw = store()?.getItem(carryKey(sessionId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CarryEntry>;
    return {
      text: typeof v.text === "string" ? v.text : "",
      attachments: Array.isArray(v.attachments) ? v.attachments : [],
      ...(v.draft && typeof v.draft.text === "string" && typeof v.draft.revision === "number"
        ? { draft: v.draft }
        : {}),
    };
  } catch {
    return null;
  }
}

function writeEntry(sessionId: string, entry: CarryEntry): void {
  shadow.set(sessionId, entry);
  try {
    store()?.setItem(carryKey(sessionId), JSON.stringify(entry));
  } catch {
    /* quota / disabled storage — the in-memory shadow still holds it */
  }
}

/** Stash the pane-that-is-leaving's composer for `sessionId`. Merges with anything already waiting. */
export function writeCarry(sessionId: string, carried: CarriedComposer): void {
  if (isEmptyCarry(carried)) return;
  const prev = readEntry(sessionId);
  writeEntry(sessionId, {
    ...(prev ?? {}),
    text: appendBelow(prev?.text ?? "", carried.text),
    attachments: [...(prev?.attachments ?? []), ...carried.attachments],
  });
}

/** Persist an "Edit first" draft locally. Call this BEFORE telling the box it was consumed. */
export function persistDraft(sessionId: string, draft: { revision: number; text: string }): void {
  const prev = readEntry(sessionId);
  writeEntry(sessionId, { text: prev?.text ?? "", attachments: prev?.attachments ?? [], draft });
}

export function clearCarry(sessionId: string): void {
  shadow.delete(sessionId);
  try {
    store()?.removeItem(carryKey(sessionId));
  } catch {
    /* disabled storage */
  }
}

/** Read AND remove what is waiting for `sessionId`. */
export function takeCarry(sessionId: string): CarryEntry | null {
  const entry = readEntry(sessionId);
  if (!entry) return null;
  clearCarry(sessionId);
  return entry;
}

/** The composer text after loading `entry` into a composer that already holds `existing`. */
export function composeIncoming(existing: string, entry: CarryEntry): string {
  return placeDraft(entry.draft?.text ?? "", appendBelow(existing, entry.text));
}

export function readDraftLoaded(sessionId: string): number | null {
  try {
    const raw = store()?.getItem(draftLoadedKey(sessionId));
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeDraftLoaded(sessionId: string, revision: number): void {
  try {
    store()?.setItem(draftLoadedKey(sessionId), String(revision));
  } catch {
    /* disabled storage */
  }
}

/** The session's current model choice (Auto included) as this client holds it. */
export function snapshotSessionChoice(sessionId: string): ModelChoice {
  if (readSessionAuto(sessionId)) return { kind: "auto" };
  const model = sessionBoxSelection(sessionId);
  return model ? { kind: "model", model } : { kind: "server-default" };
}

/**
 * Copy this client's per-session preferences predecessor → successor: the model
 * choice (incl. Auto and the fast/effort variant it carries) and the saved plan
 * toggle. `choice` is the live picker state when the caller has it (fresher than
 * the cached mirror). A server-default choice writes nothing — there is nothing
 * to carry, and a write would only delete a record that is not there.
 */
export function copySessionPrefs(predecessorId: string, successorId: string, choice?: ModelChoice): void {
  const c = choice ?? snapshotSessionChoice(predecessorId);
  if (c.kind !== "server-default") setSessionChoice(successorId, c);
  if (readPlanSaved(predecessorId)) writePlanSaved(successorId, true);
  try {
    store()?.setItem(prefsCopiedKey(successorId), "1");
  } catch {
    /* disabled storage */
  }
}

/**
 * The successor panel's mount-time reconcile (§6.4 "on load/reconnect"): a client
 * that learned of the commit while it was away still owes the successor its
 * predecessor's prefs. Once only, and never over a choice the successor already has.
 */
export function reconcileSessionPrefs(predecessorId: string, successorId: string): void {
  try {
    if (store()?.getItem(prefsCopiedKey(successorId))) return;
  } catch {
    return;
  }
  const hasChoice = readSessionAuto(successorId) || sessionBoxSelection(successorId) != null;
  if (hasChoice) {
    try {
      store()?.setItem(prefsCopiedKey(successorId), "1");
    } catch {
      /* disabled storage */
    }
    return;
  }
  copySessionPrefs(predecessorId, successorId);
}
