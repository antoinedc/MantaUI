// ===== Global toast host (BET-723 §D4) =====
//
// ONE ToastStack lives at the app root (rendered once in App.tsx) so an
// agent-file / error toast shows over EVERY pane type — a
// terminal pane, a TUI pane, or a new-session draft — instead of only when a
// chat pane happens to be active. ChatPanel keeps zero toast code.
//
// The host assembles:
//   - `appToasts` (store): transient errors + info (the alert() replacements),
//     each with its own id, capped at 5, dismissible via dismissAppToast.
//   - the two legacy single-instance toasts (agent-file /
//     system-notice), which moved up here from the active ChatPanel.
//
// Ordering keeps the moved behavior: newest on top, capped at MAX_TOASTS by
// ToastStack. Action-bearing toasts never auto-dismiss; the /help
// system-notice opts out with ttl:null.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "./store";
import { ToastStack, type ToastItem } from "./Toast";
import { formatBytes } from "./chatUtils";

export function GlobalToasts() {
  const agentFileToast = useStore((s) => s.agentFileToast);
  const systemNotice = useStore((s) => s.systemNotice);
  const appToasts = useStore((s) => s.appToasts);
  const setAgentFileToast = useStore((s) => s.setAgentFileToast);
  const setSystemNotice = useStore((s) => s.setSystemNotice);
  const pushAppToast = useStore((s) => s.pushAppToast);
  const dismissAppToast = useStore((s) => s.dismissAppToast);

  const [agentFileSaving, setAgentFileSaving] = useState(false);

  // ===== Unified toast ordering (moved unchanged from ChatPanel) =====
  const [toastOrder, setToastOrder] = useState<string[]>([]);
  const activeToastIds = useMemo(() => {
    const ids: string[] = [];
    if (agentFileToast) ids.push("agent-file");
    if (systemNotice) ids.push("system-notice");
    for (const t of appToasts) ids.push(t.id);
    return ids;
  }, [agentFileToast, systemNotice, appToasts]);

  useEffect(() => {
    setToastOrder((prev) => {
      const incoming = activeToastIds.filter((id) => !prev.includes(id));
      const survivors = prev.filter((id) => activeToastIds.includes(id));
      // Newly-arrived toasts go first (newest on top); survivors keep order.
      return [...incoming, ...survivors];
    });
  }, [activeToastIds]);

  const dismissToast = useCallback(
    (id: string) => {
      if (id === "agent-file") setAgentFileToast(null);
      else if (id === "system-notice") setSystemNotice(null);
      else dismissAppToast(id);
    },
    [setAgentFileToast, setSystemNotice, dismissAppToast],
  );

  // Agent → laptop file push (moved unchanged from ChatPanel).
  const saveAgentFile = useCallback(async () => {
    const toast = agentFileToast;
    if (!toast || agentFileSaving) return;
    setAgentFileSaving(true);
    try {
      const localPath = await window.api.agentPullFile(toast.remotePath);
      if (localPath) {
        setAgentFileToast({ ...toast, autoPulled: true, localPath });
      } else {
        setAgentFileToast(null);
      }
    } catch {
      // M5: a thrown download failure must NOT look like a saved file. Keep
      // the agent-file toast UP (so the user can retry) and surface the
      // failure clearly. Downloads are non-destructive — the source file stays
      // until the TTL sweep — so retrying is always safe.
      pushAppToast({
        tone: "error",
        message: "Download failed — tap Save to retry",
      });
    } finally {
      setAgentFileSaving(false);
    }
  }, [agentFileToast, agentFileSaving, setAgentFileToast, pushAppToast]);

  const revealAgentFile = useCallback(() => {
    const local = agentFileToast?.localPath;
    if (local) void window.api.revealInFolder(local);
    setAgentFileToast(null);
  }, [agentFileToast, setAgentFileToast]);

  const toasts: ToastItem[] = useMemo(() => {
    const items: ToastItem[] = [];
    const appMap = new Map(appToasts.map((t) => [t.id, t]));
    for (const id of toastOrder) {
      if (id === "agent-file" && agentFileToast) {
        const size = formatBytes(agentFileToast.size);
        items.push({
          id: "agent-file",
          message: (
            <>
              <span className="text-text">↓ {agentFileToast.name}</span>
              {size && <span className="text-text-faint"> · {size}</span>}
              <span className="text-text-faint">
                {agentFileToast.autoPulled ? " · saved to Downloads" : " — AI sent you a file"}
              </span>
            </>
          ),
          actions: agentFileToast.autoPulled
            ? agentFileToast.localPath
              ? [{ label: "Reveal", onClick: () => void revealAgentFile() }]
              : undefined
            : [
                {
                  label: agentFileSaving ? "Saving…" : "Save",
                  onClick: () => void saveAgentFile(),
                  disabled: agentFileSaving,
                },
              ],
        });
      } else if (id === "system-notice" && systemNotice) {
        items.push({
          id: "system-notice",
          message: systemNotice,
          ttl: null, // user-invoked reference content (/help) — no auto-dismiss
        });
      } else {
        const app = appMap.get(id);
        if (app) items.push(app);
      }
    }
    return items;
  }, [
    toastOrder,
    agentFileToast,
    systemNotice,
    appToasts,
    agentFileSaving,
    revealAgentFile,
    saveAgentFile,
  ]);

  return (
    // Fixed bottom-right overlay (BET-723 §D4 — above the status bar, renders
    // over every pane). pointer-events-none so the backdrop never swallows
    // clicks under the stack; each toast re-enables pointer events (ToastStack).
    // z-[60] so toasts paint above the z-50 modal overlay (BET-735).
    <div className="pointer-events-none fixed bottom-24 right-4 z-[60] w-96 flex flex-col items-stretch">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
