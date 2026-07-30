// SubscriptionsCard — Settings → AI → Subscriptions (BET-314).
//
// One row per provider declared in src/server/subscriptionProviders.mjs.
// Rows show connection status only (boolean — never a key fragment) and a
// single action button that flips between Connect and Disconnect. The
// connect-side flow is delegated to <ConnectProvider> (BET-312) so we
// share one OAuth / API-key implementation across Settings + onboarding.
// The disconnect side is a small inline destructive-confirm pattern copied
// from ModelsCard (BET-123) — no new component, no new dependency.
//
// Freshness is refetch-driven (no poll, no bus subscription). The desktop
// renderer is not wired to the server's in-process event bus, so any
// "live update" delivery would only ever reach the mobile client (see
// ScheduledTasksCard's comment for the standing precedent). Mount, then
// refetch after every mutation.

import { useCallback, useEffect, useState } from "react";
import type { SubscriptionStatus } from "../shared/types";
import { ConnectProvider } from "./ConnectProvider";
import { describeSubscriptionStatus } from "./chatUtils";

export function SubscriptionsCard() {
  const [statuses, setStatuses] = useState<SubscriptionStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Exactly one row can be mid-mutation at a time. The id is the registry
  // id (anthropic / openai / kimi-for-coding); null when idle.
  const [busy, setBusy] = useState<string | null>(null);
  // Which row is currently showing its connect card. null = collapsed.
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // Which row is showing its destructive-confirm bar. null = hidden.
  const [disconnectConfirmId, setDisconnectConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await window.api.opencodeProviderAuth({ action: "status" });
      if (res.action !== "status") {
        setError("Unexpected response from the box.");
        setStatuses([]);
        return;
      }
      setStatuses(res.providers);
      setError(null);
    } catch (e) {
      // Don't collapse a failure into a deceptively-empty list — surface it
      // as an inline error line, exactly like ProvidersCard's globalError.
      setError(e instanceof Error ? e.message : String(e));
      setStatuses([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disconnect = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(id);
      try {
        const res = await window.api.opencodeProviderAuth({ action: "disconnect", id });
        if (res.action === "disconnect" && !res.ok) {
          setError(res.error ?? "Disconnect failed.");
        } else if (res.action !== "disconnect") {
          setError("Unexpected response from the box.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        setDisconnectConfirmId(null);
        void refresh();
      }
    },
    [busy, refresh],
  );

  const onConnectDone = useCallback(
    (ok: boolean) => {
      setConnectingId(null);
      if (!ok) setError("Connect didn't complete. Try again.");
      void refresh();
    },
    [refresh],
  );

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <label className="block text-xs uppercase tracking-wider text-text-muted">
        Subscriptions
      </label>
      <div className="text-xs text-text-faint space-y-1">
        <div>
          Sign in with a subscription you already pay for. MantaUI never sees
          your password or your key after it is saved.
        </div>
      </div>

      {error && <div className="text-xs text-danger break-words">{error}</div>}

      {(statuses ?? []).map((s) => (
        <div key={s.id} className="border border-border rounded p-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text truncate">
                <span className="font-medium">{s.label}</span>
                <span className="text-text-faint"> · {s.plan}</span>
              </div>
              <div className="text-[10px] text-text-faint flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                    s.connected ? "bg-ok" : "bg-text-faint"
                  }`}
                />
                <span>{describeSubscriptionStatus(s)}</span>
              </div>
            </div>
            {connectingId === s.id ? null : s.connected ? (
              disconnectConfirmId === s.id ? (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void disconnect(s.id)}
                    disabled={busy !== null}
                    className="px-2 py-1 text-xs bg-danger-bg border border-danger rounded text-danger hover:text-danger disabled:opacity-40"
                  >
                    {busy === s.id ? "…" : "Disconnect"}
                  </button>
                  <button
                    onClick={() => setDisconnectConfirmId(null)}
                    disabled={busy !== null}
                    className="px-2 py-1 text-xs text-text-faint hover:text-text disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setDisconnectConfirmId(s.id)}
                  disabled={busy !== null || connectingId !== null}
                  className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
                >
                  Disconnect
                </button>
              )
            ) : (
              <button
                onClick={() => {
                  setError(null);
                  setConnectingId(s.id);
                }}
                disabled={busy !== null || connectingId !== null}
                className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
              >
                Connect
              </button>
            )}
          </div>
          {connectingId === s.id && (
            <ConnectProvider
              id={s.id}
              label={s.label}
              confirmRestart={true}
              onDone={onConnectDone}
              onCancel={() => setConnectingId(null)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
