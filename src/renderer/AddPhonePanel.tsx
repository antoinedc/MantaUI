// AddPhonePanel — the desktop "Add a phone" pairing card (BET-493).
//
// Shows the pairing code + a four-character verification code (§5.3 "Scan"),
// auto-rotates the code on expiry while the panel is open (§6.4), and carries
// the manual six-digit path (§5.2.9/§5.2.10). The joiner (phone) echoes the
// four characters back in /auth/claim as the two-sided confirm (§6.3) — the
// human is the comparator, so this panel never tries to know what a phone
// shows; it only displays the characters and rotates.
//
// Presentational glue: the expiry/refresh logic lives in the pure, unit-tested
// helpers in ./pairPanel.ts (repo pattern: chatUtils.ts). This component only
// mints via the existing `auth:pair` RPC channel and renders.

import { useCallback, useEffect, useState } from "react";
import type { AuthPairResult } from "../shared/types";
import { PairingQR, PairingCountdown } from "./PairingQR";
import {
  formatVerifyCode,
  shouldRefreshPairCode,
} from "./pairPanel";

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
                verify={pairing.verify}
              />
            </div>
            <div className="flex-1 space-y-2">
              <div className="text-body">
                <span className="text-text-muted">Code:</span>{" "}
                <span className="font-mono text-text">{pairing.pairingCode}</span>
              </div>
              <div className="text-body">
                <span className="text-text-muted">Verification code:</span>{" "}
                <span className="font-mono text-lg text-text">
                  {formatVerifyCode(pairing.verify)}
                </span>
              </div>
              <div className="text-body text-text-muted">
                Your phone will show the same four characters. Only tap Link if
                they match.
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
        Prefer to type it? Enter the {pairing?.ok ? "six digits above" : "six-digit code"} on
        your phone instead of scanning.
      </div>
    </div>
  );
}
