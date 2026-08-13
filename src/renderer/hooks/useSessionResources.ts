// ===== useSessionResources =====
//
// Extracted from ChatPanel.tsx (BET-63). Owns the three "server-owned
// resource" cards hanging off a chat session — scheduled prompts (⏰), secrets
// (🔑), inbound webhooks (🪝). Each card is the same shape: a shared `openPanel`
// surface, a metadata list + error, a `refresh*` callback, a poll effect while
// open (schedules also background-polls so its toolbar count stays fresh), a
// `manta-open-*` window-CustomEvent opener, and a session-change reset.
//
// The three cards are ONE generic `useResourceCard` helper parameterized by
// the fetch call, the event name, the background-poll flag, and the empty
// value; the public `useSessionResources` return shape is unchanged.
//
// Only `window.api.*` — no Electron-only deps (the mobile HTTP server shims it).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduledJob, SecretMeta, WebhookMeta } from "../../shared/types";

/** The three server-owned resource cards that hang off a chat session. */
export type PanelName = "schedules" | "secrets" | "webhooks";

export type SessionResources = {
  // ----- The card surface -----
  // ONE state for all three cards ("at most one open" falls out of the shape).
  /** Which card is open, or null when none is. */
  openPanel: PanelName | null;
  /** Toolbar click: open `name`, or close it if already open. */
  togglePanel: (name: PanelName) => void;
  /** A card's × button, and the session-change reset. */
  closePanel: () => void;

  // Scheduled prompts (⏰).
  schedules: ScheduledJob[];
  setSchedules: React.Dispatch<React.SetStateAction<ScheduledJob[]>>;
  scheduleError: string | null;
  setScheduleError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshSchedules: () => Promise<void>;

  // Secrets (🔑).
  secrets: SecretMeta[];
  setSecrets: React.Dispatch<React.SetStateAction<SecretMeta[]>>;
  secretError: string | null;
  setSecretError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshSecrets: () => Promise<void>;

  // Inbound webhooks (🪝).
  webhooks: WebhookMeta[];
  setWebhooks: React.Dispatch<React.SetStateAction<WebhookMeta[]>>;
  webhookError: string | null;
  setWebhookError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshWebhooks: () => Promise<void>;
};

// One card's shared list/error/refresh state, poll cadence, and open-bridge
// listener. Cards differ only in the fetch call, event name (= panelName), the
// background-poll flag (schedules background-polls; the others poll only while
// their card is open), and the "server unreachable" message.
type ResourceCardConfig<T> = {
  panelName: PanelName;
  sessionId: string;
  isActive: boolean;
  /** Shared "which card is open" state — one card open at a time. */
  openPanel: PanelName | null;
  setOpenPanel: React.Dispatch<React.SetStateAction<PanelName | null>>;
  /** The fetch call for this card's channel. */
  fetch: (sessionId: string) => Promise<T[]>;
  /** Empty value to reset to on session change / failed fetch. */
  empty: T[];
  /** schedules background-polls (toolbar count stays fresh); others don't. */
  backgroundPoll: boolean;
  /** Error message when the server is unreachable. */
  unreachable: string;
};

function useResourceCard<T>({
  panelName, sessionId, isActive, openPanel, setOpenPanel, fetch, empty, backgroundPoll, unreachable,
}: ResourceCardConfig<T>) {
  const [items, setItems] = useState<T[]>(empty);
  const [error, setError] = useState<string | null>(null);
  // fetch/empty are passed inline (recreated each render); hold them in refs so
  // `refresh` keeps a stable identity and the reset effect doesn't re-fire.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const emptyRef = useRef(empty);
  emptyRef.current = empty;

  const refresh = useCallback(() => {
    return fetchRef.current(sessionId)
      .then((data) => {
        setItems(Array.isArray(data) ? data : emptyRef.current);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : unreachable));
  }, [sessionId, unreachable]);

  // Session change resets this card's cached list + error (the outer hook
  // closes the shared panel).
  useEffect(() => {
    setItems(emptyRef.current);
    setError(null);
  }, [sessionId]);

  const opened = openPanel === panelName;

  // Poll freshness: schedules background-polls (10s open / 30s closed, stopped
  // while hidden); the others poll only while their card is open (10s).
  useEffect(() => {
    if (backgroundPoll) {
      if (!isActive) return;
      void refresh();
      const intervalMs = opened ? 10_000 : 30_000;
      const poll = setInterval(() => void refresh(), intervalMs);
      return () => clearInterval(poll);
    }
    if (!opened) return;
    void refresh();
    const poll = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(poll);
  }, [opened, isActive, backgroundPoll, refresh]);

  // Open this card from an out-of-panel `manta-open-*` bridge. Open-only —
  // never a toggle, because the dispatcher has no idea what is open.
  useEffect(() => {
    const type = `manta-open-${panelName}`;
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setOpenPanel(panelName);
    };
    window.addEventListener(type, onOpen);
    return () => window.removeEventListener(type, onOpen);
  }, [panelName, sessionId, setOpenPanel]);

  return { items, setItems, error, setError, refresh };
}

export function useSessionResources(sessionId: string, isActive: boolean): SessionResources {
  // One piece of state governs all three cards (at most one open — see the
  // type comment).
  const [openPanel, setOpenPanel] = useState<PanelName | null>(null);
  const togglePanel = useCallback(
    (name: PanelName) => setOpenPanel((cur) => (cur === name ? null : name)),
    [],
  );
  const closePanel = useCallback(() => setOpenPanel(null), []);

  // Scheduled prompts (⏰): server-owned; list + delete via schedule:* channels.
  // Refetch-driven (open + open-poll + post-delete), NOT a bus event.
  const schedules = useResourceCard<ScheduledJob>({
    panelName: "schedules", sessionId, isActive, openPanel, setOpenPanel,
    fetch: (sid) => window.api.scheduleList(sid), empty: [], backgroundPoll: true,
    unreachable: "schedule server unreachable",
  });

  // Secrets (🔑): server-owned (values never leave the box). list returns
  // METADATA ONLY (no values). Refetch-driven like schedules.
  const secrets = useResourceCard<SecretMeta>({
    panelName: "secrets", sessionId, isActive, openPanel, setOpenPanel,
    fetch: (sid) => window.api.secretsList(sid), empty: [], backgroundPoll: false,
    unreachable: "secrets server unreachable",
  });

  // Inbound webhooks (🪝): server-owned (external POSTs wake the session).
  // list + revoke via webhook:* channels (creation is the AI's job).
  // Refetch-driven like schedules/secrets.
  const webhooks = useResourceCard<WebhookMeta>({
    panelName: "webhooks", sessionId, isActive, openPanel, setOpenPanel,
    fetch: (sid) => window.api.webhookList(sid), empty: [], backgroundPoll: false,
    unreachable: "webhook server unreachable",
  });

  // Session change closes whatever card is open (each card resets its own
  // list + error inside useResourceCard).
  useEffect(() => {
    setOpenPanel(null);
  }, [sessionId]);

  return {
    openPanel, togglePanel, closePanel,
    schedules: schedules.items, setSchedules: schedules.setItems,
    scheduleError: schedules.error, setScheduleError: schedules.setError,
    refreshSchedules: schedules.refresh,
    secrets: secrets.items, setSecrets: secrets.setItems,
    secretError: secrets.error, setSecretError: secrets.setError,
    refreshSecrets: secrets.refresh,
    webhooks: webhooks.items, setWebhooks: webhooks.setItems,
    webhookError: webhooks.error, setWebhookError: webhooks.setError,
    refreshWebhooks: webhooks.refresh,
  };
}
