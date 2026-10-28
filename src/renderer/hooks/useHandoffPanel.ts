// ===== useHandoffPanel =====
//
// Everything a chat panel owes the auto-handoff feature (spec 2026-10-26-auto-
// handoff.md), in one hook so ChatPanel only wires its results into the tree:
//
//   - the session's handoff info (records / links / continuation) and which
//     records pin above the composer;
//   - §6.4 reconcile: when a REPLACEMENT commits while this panel shows the
//     predecessor (bus event, own start response, or on load/reconnect), copy
//     the local prefs, carry the composer over, and switch the pane;
//   - §7 draft consumption and §8 composer carry-over INTO this panel;
//   - the continuation notice, the carried-over context block, "Previous
//     sessions" and the read-only previous-session view;
//   - `/handoff` / "Hand off" → a `ready` card.
//
// `enabled` is false only for the read-only previous-session view: it shows a
// session the user is only looking at, which must never be switched away from.
// `interactive` is false for a read-only background-job pane: it still follows
// its job to the successor (§6.3), but has no composer to carry into/out of and
// no card to act on.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ModelChoice } from "../chatShared";
import type { HandoffEventPayload, HandoffRecord } from "../../shared/api";
import { resolveSessionOwner, useStore } from "../store";
import { claimSwitch, loadSession, releaseSwitch, subscribeHandoff, useHandoffSession, useHandoffStore } from "../handoffStore";
import { createHandoff } from "../handoffActions";
import {
  clearCarry,
  composeIncoming,
  copySessionPrefs,
  persistDraft,
  readDraftLoaded,
  reconcileSessionPrefs,
  takeCarry,
  writeCarry,
  writeDraftLoaded,
} from "../handoffCarry";
import {
  buildPreviousEntries,
  carriableAttachments,
  creatingRecord,
  describeHandoffError,
  draftRecordFor,
  eventOfRecord,
  selectPinnedHandoffs,
  shouldLoadDraft,
  shouldSwitchPane,
  type PreviousSessionEntry,
} from "../handoff";

export interface PreviousView {
  id: string;
  label: string;
  deleted: boolean;
}

export interface HandoffPanel {
  /** Server-path records to pin above the composer. */
  pinned: HandoffRecord[];
  /** The armed handoff waiting to ride the next message, or null. */
  preamble: string | null;
  /** Replacement predecessors + branch origin, newest first. */
  previous: PreviousSessionEntry[];
  /** The previous session being viewed read-only in this pane, or null. */
  previousView: PreviousView | null;
  openPrevious: (id: string) => void;
  closePrevious: () => void;
  /** `/handoff [goal]` and the "Hand off" button. Reports a failure through `setSendError`. */
  create: (trigger: "user" | "button", goal?: string) => Promise<void>;
}

export function useHandoffPanel(args: {
  sessionId: string;
  cwd: string;
  enabled: boolean;
  interactive: boolean;
  running: boolean;
  /** The live composer, read when a replacement commits (a ref so the hook never re-subscribes per keystroke). */
  composerRef: React.MutableRefObject<{ text: string; attachments: Attachment[] }>;
  /** The live model picker choice, so Auto/variant carry exactly as shown. */
  sessionChoice: ModelChoice;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setSendError: (v: string | null) => void;
}): HandoffPanel {
  const { sessionId, cwd, enabled, interactive, running, composerRef, sessionChoice, setInput, setAttachments, setSendError } = args;

  const entry = useHandoffSession(enabled ? sessionId : null);
  const info = entry?.info ?? null;
  const cache = useHandoffStore((s) => s.records);

  // Latest values for the long-lived listeners below.
  const choiceRef = useRef(sessionChoice);
  choiceRef.current = sessionChoice;
  const sendErrorRef = useRef(setSendError);
  sendErrorRef.current = setSendError;

  // ----- pinned -----
  const records = useMemo(() => {
    if (!info) return [] as HandoffRecord[];
    // A start answered by the box lands in the record cache before the session
    // list is refetched; overlay it so the card never offers a start twice.
    return info.records.map((r) => {
      const live = cache[r.id]?.record;
      return live && live.updatedAt > r.updatedAt ? live : r;
    });
  }, [info, cache]);
  const pinned = useMemo(
    () => (enabled && interactive ? selectPinnedHandoffs(records, sessionId) : []),
    [enabled, interactive, records, sessionId],
  );

  // ----- §6.4 reconcile: a replacement committed while this pane shows the predecessor -----
  const switchToSuccessor = useCallback(
    async (ev: Pick<HandoffEventPayload, "id" | "successorId">) => {
      const successorId = ev.successorId!;
      if (!claimSwitch(ev.id)) return;
      copySessionPrefs(sessionId, successorId, choiceRef.current);
      const c = composerRef.current;
      writeCarry(successorId, { text: c.text, attachments: carriableAttachments(c.attachments) });
      try {
        await useStore.getState().refresh();
        if (!resolveSessionOwner(useStore.getState().projects, successorId)) {
          throw new Error("the new session isn't listed yet");
        }
      } catch (e) {
        // Still showing the predecessor: nothing moved, so nothing must be carried.
        clearCarry(successorId);
        releaseSwitch(ev.id);
        sendErrorRef.current(
          `This conversation was handed off to a new session, but the switch failed: ${String((e as Error)?.message ?? e)}`,
        );
      }
    },
    [sessionId, composerRef],
  );

  useEffect(() => {
    if (!enabled) return;
    return subscribeHandoff((ev) => {
      if (shouldSwitchPane(sessionId, ev)) void switchToSuccessor(ev);
    });
  }, [enabled, sessionId, switchToSuccessor]);

  // On load / reconnect: the box says this session was replaced but the pane still shows it.
  const replacedBy = info?.links?.replacedBy;
  useEffect(() => {
    if (!enabled || !replacedBy) return;
    const rec = records.find((r) => r.successorId === replacedBy && r.how === "clear" && r.state === "committed");
    const ev = rec
      ? eventOfRecord(rec)
      : ({ id: `link:${sessionId}>${replacedBy}`, fromSessionId: sessionId, successorId: replacedBy, state: "committed", how: "clear" } as const);
    if (shouldSwitchPane(sessionId, ev)) void switchToSuccessor(ev);
  }, [enabled, sessionId, replacedBy, records, switchToSuccessor]);

  // ----- incoming: carried composer + "Edit first" draft (§7, §8) -----
  const applyIncoming = useCallback(() => {
    const incoming = takeCarry(sessionId);
    if (!incoming) return;
    setInput((prev) => composeIncoming(prev, incoming));
    if (incoming.attachments.length > 0) setAttachments((prev) => [...prev, ...incoming.attachments]);
  }, [sessionId, setInput, setAttachments]);

  useEffect(() => {
    if (enabled && interactive) applyIncoming();
  }, [enabled, interactive, applyIncoming]);

  const continuation = info?.continuation ?? null;
  const draftRecord = useMemo(() => draftRecordFor(records, sessionId), [records, sessionId]);
  const draftInFlight = useRef<number | null>(null);
  useEffect(() => {
    draftInFlight.current = null;
  }, [sessionId]);
  useEffect(() => {
    if (!enabled || !interactive || !continuation || !draftRecord) return;
    if (!shouldLoadDraft(continuation, readDraftLoaded(sessionId))) return;
    const revision = continuation.draftRevision as number;
    // A refetch while the box is being told must not start a second load.
    if (draftInFlight.current === revision) return;
    draftInFlight.current = revision;
    const text = continuation.draft as string;
    void (async () => {
      // §7: our own copy first, THEN tell the box — a crash between the two
      // must leave the draft on this machine, not nowhere.
      persistDraft(sessionId, { revision, text });
      try {
        await window.api.handoffDraftConsumed({ id: draftRecord.id, draftRevision: revision });
      } catch (e) {
        // Not consumed on the box; the local copy is safe. Load it anyway (the
        // user asked to edit it) and say the box wasn't told.
        sendErrorRef.current(`Loaded your edited handoff, but couldn't mark it as used: ${describeHandoffError(e)}`);
      }
      writeDraftLoaded(sessionId, revision);
      applyIncoming();
    })();
  }, [enabled, interactive, continuation, draftRecord, sessionId, applyIncoming]);

  // ----- successor chrome -----
  const preamble = enabled && interactive && typeof continuation?.preamble === "string" && continuation.preamble.trim() ? continuation.preamble : null;
  // The preamble clears when the first message after the handoff is accepted;
  // re-read at each turn boundary so the block disappears once it has been sent.
  useEffect(() => {
    if (preamble) void loadSession(sessionId);
  }, [running, preamble, sessionId]);

  const replaces = info?.links?.replaces;
  const branchedFrom = info?.links?.branchedFrom;
  // Primitives off the creating record, so the effects below re-run when the
  // handoff changes — not on every refetch that hands back an equal record.
  const creating = creatingRecord(records, sessionId);
  const createdAt = creating?.createdAt ?? 0;
  useEffect(() => {
    if (enabled && replaces) reconcileSessionPrefs(replaces, sessionId);
  }, [enabled, replaces, sessionId]);

  const titles = useSessionTitles(cwd, enabled && !!(replaces || branchedFrom));

  const [chain, setChain] = useState<Array<{ id: string; kind: "previous" | "branched-from"; at: number }>>([]);
  useEffect(() => {
    let alive = true;
    if (!enabled || (!replaces && !branchedFrom)) {
      setChain([]);
      return;
    }
    void (async () => {
      const hops: Array<{ id: string; kind: "previous" | "branched-from"; at: number }> = [];
      if (branchedFrom) hops.push({ id: branchedFrom, kind: "branched-from", at: createdAt });
      // Walk the replacement chain back, one hop per predecessor's own links.
      let next = replaces;
      let at = createdAt;
      const seen = new Set<string>([sessionId]);
      for (let depth = 0; next && !seen.has(next) && depth < 20; depth++) {
        seen.add(next);
        hops.push({ id: next, kind: "previous", at });
        const pred = await loadSession(next);
        const rec = pred ? creatingRecord(pred.records, next) : null;
        at = rec?.createdAt ?? at;
        next = pred?.links?.replaces;
      }
      if (alive) setChain(hops);
    })();
    return () => {
      alive = false;
    };
  }, [enabled, sessionId, replaces, branchedFrom, createdAt]);

  const chainTitles = info?.chain?.predecessors;
  const previous = useMemo(() => {
    const t: Record<string, string | undefined> = { ...titles };
    // The box's own lookup covers every predecessor; the directory listing above
    // misses sessions outside its page, which then read "Untitled session".
    for (const p of chainTitles ?? []) if (p.title) t[p.id] ??= p.title;
    for (const r of records) if (r.fromTitle) t[r.fromSessionId] ??= r.fromTitle;
    return buildPreviousEntries(chain, t);
  }, [chain, titles, chainTitles, records]);

  // ----- previous-session view (read-only, same pane) -----
  const [previousView, setPreviousView] = useState<PreviousView | null>(null);
  useEffect(() => setPreviousView(null), [sessionId]);
  const previousRef = useRef(previous);
  previousRef.current = previous;
  const openPrevious = useCallback((id: string) => {
    const e = previousRef.current.find((p) => p.id === id);
    const label = e?.title || "Untitled session";
    // A deleted session keeps its id in the links (§9); opening it says so.
    window.api
      .opencodeMessages(id, { limit: 1 })
      .then(() => setPreviousView({ id, label, deleted: false }))
      .catch(() => setPreviousView({ id, label, deleted: true }));
  }, []);
  const closePrevious = useCallback(() => setPreviousView(null), []);

  const create = useCallback(
    async (trigger: "user" | "button", goal?: string) => {
      try {
        await createHandoff({ sessionId, trigger, goal });
        await loadSession(sessionId);
      } catch (e) {
        sendErrorRef.current(`Couldn't hand off: ${String((e as Error)?.message ?? e)}`);
      }
    },
    [sessionId],
  );

  return { pinned, preamble, previous, previousView, openPrevious, closePrevious, create };
}

/** Session titles for the "Continued from" notice and the Previous sessions list. */
function useSessionTitles(cwd: string, active: boolean): Record<string, string | undefined> {
  const [titles, setTitles] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    if (!active) return;
    let alive = true;
    window.api
      .opencodeListSessions(cwd || undefined)
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        const t: Record<string, string | undefined> = {};
        for (const s of list) t[s.id] = s.title;
        setTitles(t);
      })
      .catch(() => {
        /* titles are decoration — the list falls back to "Untitled session" */
      });
    return () => {
      alive = false;
    };
  }, [cwd, active]);
  return titles;
}
