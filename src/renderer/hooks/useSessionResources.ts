// ===== useSessionResources =====
//
// Extracted from ChatPanel.tsx (BET-63). Owns the three "server-owned
// resource" cards that hang off a chat session — scheduled prompts (⏰),
// secrets (🔑), and inbound webhooks (🪝). Each is the same shape:
//
//   - a `show*` toggle (opened by the composer toolbar or a mobile ⋯-sheet
//     `manta-open-*` window CustomEvent),
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

export type SessionResources = {
  // Scheduled prompts (⏰).
  showSchedules: boolean;
  setShowSchedules: React.Dispatch<React.SetStateAction<boolean>>;
  schedules: ScheduledJob[];
  setSchedules: React.Dispatch<React.SetStateAction<ScheduledJob[]>>;
  scheduleError: string | null;
  setScheduleError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshSchedules: () => Promise<void>;

  // Secrets (🔑).
  showSecrets: boolean;
  setShowSecrets: React.Dispatch<React.SetStateAction<boolean>>;
  secrets: SecretMeta[];
  setSecrets: React.Dispatch<React.SetStateAction<SecretMeta[]>>;
  secretError: string | null;
  setSecretError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshSecrets: () => Promise<void>;

  // Inbound webhooks (🪝).
  showWebhooks: boolean;
  setShowWebhooks: React.Dispatch<React.SetStateAction<boolean>>;
  webhooks: WebhookMeta[];
  setWebhooks: React.Dispatch<React.SetStateAction<WebhookMeta[]>>;
  webhookError: string | null;
  setWebhookError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshWebhooks: () => Promise<void>;
};

export function useSessionResources(sessionId: string): SessionResources {
  // ----- Scheduled prompts (the ⏰ ScheduledTasksCard) -----
  // Jobs are server-owned (manta-server fires them); here we only list + delete
  // via the schedule:* window.api channels. Refetch-driven (open + open-poll +
  // post-delete) — NOT a bus event, because desktop's renderer isn't wired to
  // the server bus. See docs/manta-tools-scheduler.md.
  const [showSchedules, setShowSchedules] = useState(false);
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
  const [showSecrets, setShowSecrets] = useState(false);
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
  const [showWebhooks, setShowWebhooks] = useState(false);
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

  // Close the schedules card + clear its state on session change.
  useEffect(() => {
    setShowSchedules(false);
    setSchedules([]);
    setScheduleError(null);
  }, [sessionId]);

  // Keep the toolbar schedule count fresh whether or not the card is open:
  // fetch once on mount/session-change, then poll. The card being open speeds
  // the poll up (10s) for snappy create/fire feedback; while closed a slower
  // 30s background poll keeps the "(N)" count current so a model-created job
  // shows up without the user having to open the card first. Refetch-driven
  // (no bus event) so it behaves identically on desktop and mobile.
  useEffect(() => {
    void refreshSchedules();
    const intervalMs = showSchedules ? 10_000 : 30_000;
    const poll = setInterval(() => void refreshSchedules(), intervalMs);
    return () => clearInterval(poll);
  }, [showSchedules, refreshSchedules]);

  // Secrets are only fetched while the card is open (no toolbar count badge to
  // keep current in the background — unlike schedules). Refetch on open + 10s
  // poll so a secret added on another device shows up.
  useEffect(() => {
    if (!showSecrets) return;
    void refreshSecrets();
    const poll = setInterval(() => void refreshSecrets(), 10_000);
    return () => clearInterval(poll);
  }, [showSecrets, refreshSecrets]);

  // Close the webhooks card + clear its state on session change.
  useEffect(() => {
    setShowWebhooks(false);
    setWebhooks([]);
    setWebhookError(null);
  }, [sessionId]);

  // Webhooks fetched only while the card is open (creation is agent-driven; the
  // count isn't surfaced on the toolbar, so no background poll). Refetch on open
  // + 10s poll so a model-created hook / a fresh delivery shows up.
  useEffect(() => {
    if (!showWebhooks) return;
    void refreshWebhooks();
    const poll = setInterval(() => void refreshWebhooks(), 10_000);
    return () => clearInterval(poll);
  }, [showWebhooks, refreshWebhooks]);

  // Mobile entry point for the schedules card: the ⋯ sheet (outside ChatPanel)
  // dispatches a window CustomEvent rather than reaching into this component's
  // state. Mirrors the manta-scroll-to-question bridge.
  useEffect(() => {
    const onOpenSchedules = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setShowSchedules(true);
    };
    window.addEventListener("manta-open-schedules", onOpenSchedules);
    return () => window.removeEventListener("manta-open-schedules", onOpenSchedules);
  }, [sessionId]);

  // Mobile entry point for the secrets card (mirror of manta-open-schedules).
  useEffect(() => {
    const onOpenSecrets = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setShowSecrets(true);
    };
    window.addEventListener("manta-open-secrets", onOpenSecrets);
    return () => window.removeEventListener("manta-open-secrets", onOpenSecrets);
  }, [sessionId]);

  // Mobile entry point for the webhooks card (mirror of manta-open-schedules).
  useEffect(() => {
    const onOpenWebhooks = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setShowWebhooks(true);
    };
    window.addEventListener("manta-open-webhooks", onOpenWebhooks);
    return () => window.removeEventListener("manta-open-webhooks", onOpenWebhooks);
  }, [sessionId]);

  return {
    showSchedules,
    setShowSchedules,
    schedules,
    setSchedules,
    scheduleError,
    setScheduleError,
    refreshSchedules,
    showSecrets,
    setShowSecrets,
    secrets,
    setSecrets,
    secretError,
    setSecretError,
    refreshSecrets,
    showWebhooks,
    setShowWebhooks,
    webhooks,
    setWebhooks,
    webhookError,
    setWebhookError,
    refreshWebhooks,
  };
}
