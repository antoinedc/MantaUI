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
// This slice is completely independent of the fragile SSE / pin-to-bottom /
// message-drain core, which is exactly why it's the safe first hook to pull
// out of the container: nothing here touches `messages`, the delta buffer, or
// the scroll refs. The behavior is byte-for-byte the same as when it lived
// inline in ChatPanel — see the git history of ChatPanel.tsx for the original
// call sites.
//
// No Electron-only deps — only `window.api.*`, which the mobile HTTP server
// shims.

import { useCallback, useEffect, useState } from "react";
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

export function useSessionResources(sessionId: string, isActive: boolean): SessionResources {
  // ----- The card surface -----
  // One piece of state governs all three cards (see the type comment above).
  const [openPanel, setOpenPanel] = useState<PanelName | null>(null);
  const togglePanel = useCallback(
    (name: PanelName) => setOpenPanel((cur) => (cur === name ? null : name)),
    [],
  );
  const closePanel = useCallback(() => setOpenPanel(null), []);

  // Derived per-card flags, used ONLY as effect dependencies below. They are
  // booleans, so an effect that watches one re-runs when THAT card opens or
  // closes — not every time any card changes. Depending on `openPanel`
  // directly would, for example, refetch schedules every time the secrets card
  // opened.
  const schedulesOpen = openPanel === "schedules";
  const secretsOpen = openPanel === "secrets";
  const webhooksOpen = openPanel === "webhooks";

  // ----- Scheduled prompts (the ⏰ ScheduledTasksCard) -----
  // Jobs are server-owned (manta-server fires them); here we only list + delete
  // via the schedule:* window.api channels. Refetch-driven (open + open-poll +
  // post-delete) — NOT a bus event, because desktop's renderer isn't wired to
  // the server bus. See docs/manta-tools-scheduler.md.
  const [schedules, setSchedules] = useState<ScheduledJob[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const refreshSchedules = useCallback(() => {
    return window.api
      .scheduleList(sessionId)
      .then((jobs: ScheduledJob[]) => {
        setSchedules(Array.isArray(jobs) ? jobs : []);
        setScheduleError(null);
      })
      .catch((e: unknown) => {
        setScheduleError(e instanceof Error ? e.message : "schedule server unreachable");
      });
  }, [sessionId]);

  // ----- Secrets (the 🔑 SecretsCard) -----
  // Secrets are server-owned (the value never leaves the box; the AI reads
  // them via the secret_* opencode tools). Here the user adds/edits/deletes via
  // secrets:* window.api channels. list returns METADATA ONLY (no values).
  // Refetch-driven like schedules. The card shows shared secrets + this
  // session's scoped ones (sessionId is passed so the agent-visible view
  // matches what tools will resolve).
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [secretError, setSecretError] = useState<string | null>(null);
  const refreshSecrets = useCallback(() => {
    return window.api
      .secretsList(sessionId)
      .then((list: SecretMeta[]) => {
        setSecrets(Array.isArray(list) ? list : []);
        setSecretError(null);
      })
      .catch((e: unknown) => {
        setSecretError(e instanceof Error ? e.message : "secrets server unreachable");
      });
  }, [sessionId]);

  // ----- Inbound webhooks (the 🪝 WebhooksCard) -----
  // Hooks are server-owned (external POSTs wake the session); here we only list
  // + revoke via the webhook:* channels (creation is the AI's job via the
  // `webhook` opencode tool, which returns the one-time signing secret).
  // Refetch-driven like schedules/secrets. See docs/manta-tools-webhook.md.
  const [webhooks, setWebhooks] = useState<WebhookMeta[]>([]);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const refreshWebhooks = useCallback(() => {
    return window.api
      .webhookList(sessionId)
      .then((list: WebhookMeta[]) => {
        setWebhooks(Array.isArray(list) ? list : []);
        setWebhookError(null);
      })
      .catch((e: unknown) => {
        setWebhookError(e instanceof Error ? e.message : "webhook server unreachable");
      });
  }, [sessionId]);

  // Session change closes whatever card is open and drops every cached list.
  // One effect for all three — the three near-identical copies this replaces
  // had already drifted (secrets' was added later, with a comment about the
  // inconsistency).
  useEffect(() => {
    setOpenPanel(null);
    setSchedules([]);
    setScheduleError(null);
    setSecrets([]);
    setSecretError(null);
    setWebhooks([]);
    setWebhookError(null);
  }, [sessionId]);

  // Keep the toolbar schedule count fresh whether or not the card is open:
  // fetch once on mount/session-change, then poll. The card being open speeds
  // the poll up (10s) for snappy create/fire feedback; while closed a slower
  // 30s background poll keeps the "(N)" count current so a model-created job
  // shows up without the user having to open the card first. Refetch-driven
  // (no bus event) so it behaves identically on desktop and mobile. The
  // background poll stops while the panel is hidden — the effect re-runs (and
  // refires once) when isActive flips back on.
  useEffect(() => {
    if (!isActive) return;
    void refreshSchedules();
    const intervalMs = schedulesOpen ? 10_000 : 30_000;
    const poll = setInterval(() => void refreshSchedules(), intervalMs);
    return () => clearInterval(poll);
  }, [schedulesOpen, refreshSchedules, isActive]);

  // Secrets are only fetched while the card is open (no toolbar count badge to
  // keep current in the background — unlike schedules). Refetch on open + 10s
  // poll so a secret added on another device shows up.
  useEffect(() => {
    if (!secretsOpen) return;
    void refreshSecrets();
    const poll = setInterval(() => void refreshSecrets(), 10_000);
    return () => clearInterval(poll);
  }, [secretsOpen, refreshSecrets]);

  // Webhooks fetched only while the card is open (creation is agent-driven; the
  // count isn't surfaced on the toolbar, so no background poll). Refetch on open
  // + 10s poll so a model-created hook / a fresh delivery shows up.
  useEffect(() => {
    if (!webhooksOpen) return;
    void refreshWebhooks();
    const poll = setInterval(() => void refreshWebhooks(), 10_000);
    return () => clearInterval(poll);
  }, [webhooksOpen, refreshWebhooks]);

  // Entry point for an out-of-panel opener (the mobile ⋯ sheet dispatched these;
  // the listeners are the documented bridge and are covered by tests). One loop
  // over the three names replaces three copy-pasted effects. Open-only — never
  // a toggle, because the dispatcher has no idea what is currently open.
  useEffect(() => {
    const names: PanelName[] = ["schedules", "secrets", "webhooks"];
    const offs = names.map((name) => {
      const type = `manta-open-${name}`;
      const onOpen = (e: Event) => {
        const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
        if (detail?.sessionId === sessionId) setOpenPanel(name);
      };
      window.addEventListener(type, onOpen);
      return () => window.removeEventListener(type, onOpen);
    });
    return () => offs.forEach((off) => off());
  }, [sessionId]);

  return {
    openPanel,
    togglePanel,
    closePanel,
    schedules,
    setSchedules,
    scheduleError,
    setScheduleError,
    refreshSchedules,
    secrets,
    setSecrets,
    secretError,
    setSecretError,
    refreshSecrets,
    webhooks,
    setWebhooks,
    webhookError,
    setWebhookError,
    refreshWebhooks,
  };
}
