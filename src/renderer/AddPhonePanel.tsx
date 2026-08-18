// AddPhonePanel — the desktop "Add a phone" pairing card (BET-493).
//
// Shows the six-digit pairing code, auto-rotates it on expiry while the panel
// is open (§6.4), and carries the manual six-digit path (§5.2.9/§5.2.10).
//
// Presentational glue: the expiry/refresh logic lives in the pure, unit-tested
// helpers in ./pairPanel.ts (repo pattern: chatUtils.ts). This component only
// mints via the existing `auth:pair` RPC channel and renders.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthPairResult } from "../shared/types";
import { PairingQR, PairingCountdown } from "./PairingQR";
import { resolveQrServerOverride, shouldRefreshPairCode } from "./pairPanel";

// 1s tick drives the live countdown + re-evaluates expiry so the code
// auto-rotates the moment it elapses while the panel stays open (§6.4). The
// server is the authority; rotation never happens client-side-minted (the
// `auth:pair` RPC channel is the loopback-only mint).
const TICK_MS = 1000;

export function AddPhonePanel() {
  const [pairing, setPairing] = useState<AuthPairResult | null>(null);
  const [minting, setMinting] = useState(false);
  const [tick, setTick] = useState(0);

  const mint = useCallback(async () => {
    setMinting(true);
    try {
      const result = await window.api.authPair();
      setPairing(result);
    } catch (e) {
      setPairing({
        ok: false,
        error: (e as { message?: string })?.message ?? String(e),
      });
    } finally {
      setMinting(false);
    }
  }, []);

  // Mint on open so the card always shows a fresh code, not a stale one.
  useEffect(() => {
    void mint();
  }, [mint]);

  // A 1s tick keeps the "expires in" pill live and re-evaluates rotation.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Auto-rotate on expiry while the panel is open (§6.4 row 2).
  useEffect(() => {
    if (!pairing?.ok) return;
    const expiresAt = new Date(pairing.expiresAt).getTime();
    if (Number.isNaN(expiresAt)) return;
    if (shouldRefreshPairCode(expiresAt, Date.now())) {
      void mint();
    }
  }, [tick, pairing, mint]);

  // BET-703 (tailnet box): when this desktop's configured server URL differs
  // from the box's derived public hostname AND is a private/tailnet address,
  // the scanned QR must carry `server=` so the phone claims against the real
  // listener instead of a non-existent public host. Computed here (where the
  // mint result feeds the QR) via the pure `resolveQrServerOverride` helper;
  // the configured URL is read via the existing `manta_server` localStorage
  // key — same accessor the transport layer and store overlay use.
  const qrServerUrl = useMemo(() => {
    if (!pairing?.ok) return undefined;
    let configured: string | undefined;
    try {
      configured = localStorage.getItem("manta_server") ?? undefined;
    } catch {
      configured = undefined; // localStorage unavailable — omit override
    }
    return resolveQrServerOverride(pairing.boxId, configured);
  }, [pairing]);

  return (
    <div className="space-y-4">
      <div className="text-body text-text-faint">
        Add a phone. Point its camera at this code — it refreshes on its own
        every five minutes.
      </div>

      {!pairing ? (
        <div className="flex items-center gap-2 text-body text-text-muted">
          <span>Generating pairing code…</span>
        </div>
      ) : pairing.ok ? (
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="bg-white p-2 rounded-xs border border-border shrink-0">
              <PairingQR
                boxId={pairing.boxId}
                pairingCode={pairing.pairingCode}
                serverUrl={qrServerUrl}
              />
            </div>
            <div className="flex-1 space-y-2">
              <div className="text-body">
                <span className="text-text-muted">Code:</span>{" "}
                <span className="font-mono text-text">{pairing.pairingCode}</span>
              </div>
              <div className="text-body">
                <span className="text-text-muted">Server ID:</span>{" "}
                <span className="font-mono text-text break-all">{pairing.boxId}</span>
              </div>
              <PairingCountdown expiry={new Date(pairing.expiresAt)} />
            </div>
          </div>
          <button
            onClick={() => void mint()}
            disabled={minting}
            className="text-body px-4 py-2 rounded-xs border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {minting ? "Refreshing…" : "Refresh code"}
          </button>
        </div>
      ) : (
        <div className="shrink-0 text-body text-danger">{pairing.error}</div>
      )}

      <div className="text-body text-text-faint">
        {pairing?.ok
          ? "Prefer to type it? Enter the six digits and the Server ID above on your phone instead of scanning."
          : "Prefer to type it? Enter the six-digit code on your phone instead of scanning."}
      </div>
    </div>
  );
}
