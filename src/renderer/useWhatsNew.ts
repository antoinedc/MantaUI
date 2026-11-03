// useWhatsNew.ts — owns the automatic "What's new" window (spec
// 2026-11-03-whats-new-modal). All DECISIONS live in ../shared/whatsNew.mjs;
// this hook wires them to the server's changelog, this device's stored
// acknowledgements and the moments the window may open.
//
//   • fetch when the connection goes live and on every reconnect, and again when
//     the upgrade gate clears (a reconnect during an upgrade gets a 503 and the
//     upgrade can finish on the same connection);
//   • a response is dropped if the API generation changed while it was in flight
//     (a different server), or a newer fetch superseded it;
//   • no server id in the response → nothing to key storage on → no automatic
//     display (the manual open from Settings still works);
//   • first sight of a server is recorded silently; otherwise the unseen entries
//     are held until nothing else owns the screen (`blocked`, the upgrade gate);
//   • ANY close acknowledges every returned entry. A manual open never touches
//     the stored acknowledgements.
//
// Failures of the automatic fetch are silent to the user (console.warn only): an
// older server without the channel is not an error.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangelogEntry } from "../shared/api";
import { acknowledge, decideWhatsNew, previousVersion } from "../shared/whatsNew.mjs";

export const WHATS_NEW_STORAGE_PREFIX = "manta:whats-new:";
export const whatsNewStorageKey = (serverId: string) => `${WHATS_NEW_STORAGE_PREFIX}${serverId}`;

export type WhatsNewView = {
  /** The entries to show, newest first. */
  entries: ChangelogEntry[];
  /** The version the user last had (A's "from → to" eyebrow); null when unknown. */
  previous: string | null;
};

type Pending = {
  serverId: string;
  /** Everything the server returned — what a close acknowledges. */
  returned: ChangelogEntry[];
  view: WhatsNewView;
};

function readStored(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("[whats-new] couldn't save acknowledgements:", e);
  }
}

export function useWhatsNew(inputs: {
  /** The connection is live. */
  connected: boolean;
  /** Bumped when `window.api` is swapped (a possibly different server). */
  apiGeneration: number;
  /** The blocking upgrade screen is up. */
  gateVisible: boolean;
  /** Anything else owns the screen (Settings, another dialog…). */
  blocked: boolean;
}): {
  /** What to render now, or null. */
  view: WhatsNewView | null;
  /** Close whatever is showing (acknowledges, for the automatic window). */
  close: () => void;
  /** Settings → About: open the window for this entry; acknowledgements untouched. */
  showEntry: (entry: ChangelogEntry) => void;
} {
  const { connected, apiGeneration, gateVisible, blocked } = inputs;
  const [pending, setPending] = useState<Pending | null>(null);
  const [manual, setManual] = useState<ChangelogEntry | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A different server: forget what the last one produced and void any fetch in flight.
  const generation = useRef(apiGeneration);
  const fetchSeq = useRef(0);
  useEffect(() => {
    generation.current = apiGeneration;
    fetchSeq.current += 1;
    setPending(null);
  }, [apiGeneration]);

  const fetchNow = useCallback(async () => {
    const api = window.api;
    if (typeof api?.serverChangelog !== "function") return;
    const seq = ++fetchSeq.current;
    const gen = generation.current;
    let res: Awaited<ReturnType<typeof api.serverChangelog>> | undefined;
    try {
      res = await api.serverChangelog();
    } catch (e) {
      console.warn("[whats-new] changelog fetch failed:", e);
      return;
    }
    if (!alive.current || seq !== fetchSeq.current || gen !== generation.current) return;
    if (!res || typeof res.serverId !== "string" || res.serverId === "" || !Array.isArray(res.entries)) return;

    const key = whatsNewStorageKey(res.serverId);
    const stored = readStored(key);
    const decision = decideWhatsNew(stored, res.entries);
    if (decision.baseline) {
      writeStored(key, acknowledge(null, res.entries));
      setPending(null);
      return;
    }
    if (decision.unseen.length === 0) {
      setPending(null);
      return;
    }
    setPending({
      serverId: res.serverId,
      returned: res.entries,
      view: { entries: decision.unseen, previous: previousVersion(stored, res.entries, decision.unseen) },
    });
  }, []);

  // Connection live / reconnect / server swap.
  useEffect(() => {
    if (!connected) return;
    void fetchNow();
  }, [connected, apiGeneration, fetchNow]);

  // The upgrade gate clearing: the changelog the server serves may have moved.
  const wasGated = useRef(false);
  useEffect(() => {
    if (wasGated.current && !gateVisible) void fetchNow();
    wasGated.current = gateVisible;
  }, [gateVisible, fetchNow]);

  const close = useCallback(() => {
    if (manual) {
      setManual(null);
      return;
    }
    if (!pending) return;
    const key = whatsNewStorageKey(pending.serverId);
    writeStored(key, acknowledge(readStored(key), pending.returned));
    setPending(null);
  }, [manual, pending]);

  const showEntry = useCallback((entry: ChangelogEntry) => setManual(entry), []);

  let view: WhatsNewView | null = null;
  if (manual) view = { entries: [manual], previous: null };
  else if (pending && !blocked && !gateVisible) view = pending.view;

  return { view, close, showEntry };
}
