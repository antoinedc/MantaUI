// ===== useSessionResources =====
//
// Extracted from ChatPanel.tsx (BET-63). Owns the three "server-owned
// resource" cards that hang off a chat session — scheduled prompts (⏰),
// secrets (🔑), and inbound webhooks (🪝). Each is the same shape:
//
//   - a single `openPanel` surface shared by all three cards (opened by the
//     composer toolbar or a mobile ⋯-sheet `manta-open-*` window CustomEvent),
//   - a list of metadata + an error string,
//   - a `refresh*` callback that re-fetches over the `schedule:*` / `secrets:*`
//     / `webhook:*` window.api channels,
//   - a poll effect while the card is open (schedules also background-polls so
//     its toolbar count stays fresh), and
//   - a session-change reset.
//
// The three cards are implemented by ONE generic `useResourceCard` helper
// parameterized by the fetch call, the `manta-open-*` event name, the
// background-poll flag, and the empty value. The three exported surface
// fields are thin instantiations on top of it — the public
// `useSessionResources` return shape is unchanged.
//
// This slice is completely independent of the fragile SSE / pin-to-bottom /
// message-drain core, which is exactly why it's the safe first hook to pull
// out of the container: nothing here touches `messages`, the delta buffer, or
// the scroll refs. The behavior is byte-for-byte the same as when it lived
// inline in ChatPanel — see the git history of ChatPanel.tsx for the original
// call sites.
//
// No Electron-only deps — only `window.api.*`, which the mobile HTTP server
// shims.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduledJob, SecretMeta, WebhookMeta } from "../../shared/types";

/** The three server-owned resource cards that hang off a chat session. */
export type PanelName = "schedules" | "secrets" | "webhooks";

export type SessionResources = {
  // ----- The card surface -----
  //
  // ONE state for all three cards, not three booleans. "at most one card is
  // open" is then a property of the state's shape rather than a rule some
  // caller has to remember to enforce, and every button goes through the same
  // toggle. Do not split this back into per-card flags.
  /** Which card is open, or null when none is. */
  openPanel: PanelName | null;
  /** Toolbar click: open `name`, or close it if it is already the open one.
   *  Opening one closes whichever other was open — implicitly. */
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

// One card's shared state (list + error + refresh), poll cadence, and open-
// bridge listener. The three cards (schedules/secrets/webhooks) differ ONLY
// in: the fetch call, the `manta-open-*` event name (= panelName), whether it
// background-polls (schedules does; the others poll only while their card is
// open), and the "server unreachable" message. Everything else — the list/
// error state, the session-change reset, the open-poll and background-poll,
// and the out-of-panel opener listener — is one copy.
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
  panelName,
  sessionId,
  isActive,
  openPanel,
  setOpenPanel,
  fetch,
  empty,
  backgroundPoll,
  unreachable,
}: ResourceCardConfig<T>) {
  const [items, setItems] = useState<T[]>(empty);
  const [error, setError] = useState<string | null>(null);

  // fetch/empty are passed inline from the caller (recreated each render), so
  // read them through refs to keep `refresh` a stable identity across renders
  // and to keep the session-reset effect from re-firing every render.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const emptyRef = useRef(empty);
  emptyRef.current = empty;

  const refresh = useCallback(() => {
    return fetchRef
      .current(sessionId)
      .then((data) => {
        setItems(Array.isArray(data) ? data : emptyRef.current);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : unreachable);
      });
  }, [sessionId, unreachable]);

  // Session change resets this card's cached list + error (the outer hook
  // closes the shared panel).
  useEffect(() => {
    setItems(emptyRef.current);
    setError(null);
  }, [sessionId]);

  // Derive per-card "is this card open?" for the poll cadence (see type
  // comment on openPanel).
  const opened = openPanel === panelName;

  // Poll freshness. schedules background-polls (10s while open, 30s closed,
  // stopped while the panel is hidden) so its toolbar count stays current; the
  // others poll only while their card is open (10s).
  useEffect(() => {
    if (backgroundPoll) {
      if (!isActive) return;
      void refresh();
      const intervalMs = opened ? 10_000 : 30_000;
      const poll = setInterval(() => void refresh(), intervalMs);
      return () => clearInterval(poll);
    }
    // Non-background cards poll only while open.
    if (!opened) return;
    void refresh();
    const poll = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(poll);
  }, [opened, isActive, backgroundPoll, refresh]);

  // Entry point for an out-of-panel opener (the mobile ⋯ sheet dispatched
  // these; the listeners are the documented bridge and are covered by tests).
  // Open-only — never a toggle, because the dispatcher has no idea what is
  // currently open.
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
  // ----- The card surface -----
  // One piece of state governs all three cards (see the type comment above).
  const [openPanel, setOpenPanel] = useState<PanelName | null>(null);
  const togglePanel = useCallback(
    (name: PanelName) => setOpenPanel((cur) => (cur === name ? null : name)),
    [],
  );
  const closePanel = useCallback(() => setOpenPanel(null), []);

  // ----- Scheduled prompts (the ⏰ ScheduledTasksCard) -----
  // Jobs are server-owned (manta-server fires them); here we only list + delete
  // via the schedule:* window.api channels. Refetch-driven (open + open-poll +
  // post-delete) — NOT a bus event, because desktop's renderer isn't wired to
  // the server bus. See docs/manta-tools-scheduler.md.
  const schedules = useResourceCard<ScheduledJob>({
    panelName: "schedules",
    sessionId,
    isActive,
    openPanel,
    setOpenPanel,
    fetch: (sid) => window.api.scheduleList(sid),
    empty: [],
    backgroundPoll: true,
    unreachable: "schedule server unreachable",
  });

  // ----- Secrets (the 🔑 SecretsCard) -----
  // Secrets are server-owned (the value never leaves the box; the AI reads
  // them via the secret_* opencode tools). Here the user adds/edits/deletes via
  // secrets:* window.api channels. list returns METADATA ONLY (no values).
  // Refetch-driven like schedules. The card shows shared secrets + this
  // session's scoped ones (sessionId is passed so the agent-visible view
  // matches what tools will resolve).
  const secrets = useResourceCard<SecretMeta>({
    panelName: "secrets",
    sessionId,
    isActive,
    openPanel,
    setOpenPanel,
    fetch: (sid) => window.api.secretsList(sid),
    empty: [],
    backgroundPoll: false,
    unreachable: "secrets server unreachable",
  });

  // ----- Inbound webhooks (the 🪝 WebhooksCard) -----
  // Hooks are server-owned (external POSTs wake the session); here we only list
  // + revoke via the webhook:* channels (creation is the AI's job via the
  // `webhook` opencode tool, which returns the one-time signing secret).
  // Refetch-driven like schedules/secrets. See docs/manta-tools-webhook.md.
  const webhooks = useResourceCard<WebhookMeta>({
    panelName: "webhooks",
    sessionId,
    isActive,
    openPanel,
    setOpenPanel,
    fetch: (sid) => window.api.webhookList(sid),
    empty: [],
    backgroundPoll: false,
    unreachable: "webhook server unreachable",
  });

  // Session change closes whatever card is open (each card resets its own
  // list + error inside useResourceCard).
  useEffect(() => {
    setOpenPanel(null);
  }, [sessionId]);

  return {
    openPanel,
    togglePanel,
    closePanel,
    schedules: schedules.items,
    setSchedules: schedules.setItems,
    scheduleError: schedules.error,
    setScheduleError: schedules.setError,
    refreshSchedules: schedules.refresh,
    secrets: secrets.items,
    setSecrets: secrets.setItems,
    secretError: secrets.error,
    setSecretError: secrets.setError,
    refreshSecrets: secrets.refresh,
    webhooks: webhooks.items,
    setWebhooks: webhooks.setItems,
    webhookError: webhooks.error,
    setWebhookError: webhooks.setError,
    refreshWebhooks: webhooks.refresh,
  };
}
