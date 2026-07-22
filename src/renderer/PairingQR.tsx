// PairingQR — renders a QR code image for mobile device pairing.
//
// The QR encodes the CANONICAL box-form `manta://pair?box=<boxId>&code=<6-digit>`
// payload produced by the SHARED `buildPairPayload` helper
// (src/renderer/mobile/pairPayload.ts). BET-237 removed the deprecated
// serverUrl / id forms — `parsePairPayload` rejects anything other than
// `box=<boxId>&code=<6-digit>`. The canonical form is the SAME shape `bui
// pair` prints + the install heredoc + the deep-link handler in
// MobileApp.tsx parses.
//
// We use the `qrcode` npm package to generate a data URL, then render it as
// an <img> tag. The data URL is memoized so we don't regenerate on every
// render (QR generation is CPU-bound).
//
// This is a desktop-only feature (BET-80). The mobile app consumes the same
// URL scheme but generates the QR on the desktop side.

import { useEffect, useMemo, useState } from "react";
import { buildPairPayload } from "./mobile/pairPayload";

// Lazy-load qrcode so the renderer doesn't pay the bundle cost if this
// component is never rendered (Settings is a modal, only open on demand).
// We use a dynamic import inside useMemo so SSR/static builds don't choke.
async function loadQrCode() {
  return (await import("qrcode")).default;
}

export function PairingQR({
  boxId,
  pairingCode,
}: {
  boxId: string;
  pairingCode: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    // Canonical box-form payload — shared with the install heredoc, `bui pair`
    // output, and the mobile deep-link parser. Single source: pairPayload.ts.
    return buildPairPayload({ boxId, code: pairingCode });
  }, [boxId, pairingCode]);

  useEffect(() => {
    let cancelled = false;
    loadQrCode()
      .then((qr: { toDataURL: (url: string, opts: { width: number; margin: number }) => Promise<string> }) =>
        qr.toDataURL(url, { width: 200, margin: 2 }),
      )
      .then((dataUrl: string) => {
        if (!cancelled) setDataUrl(dataUrl);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div className="text-xs text-red-400 p-2">
        QR generation failed: {error}
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div className="w-[200px] h-[200px] bg-bg-soft border border-border rounded flex items-center justify-center text-xs text-text-muted">
        Generating…
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt={`Pairing QR: ${pairingCode}`}
      className="w-[200px] h-[200px]"
    />
  );
}

// PairingCountdown — shows a live countdown to the pairing code expiry.
// The server returns an ISO-8601 expiresAt timestamp; we compute the remaining
// seconds and update every second. When the code expires, we show "Expired"
// and the user must generate a new code.
export function PairingCountdown({ expiry }: { expiry: Date }) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, Math.floor((expiry.getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    if (remaining <= 0) return;
    const interval = setInterval(() => {
      const diff = Math.max(
        0,
        Math.floor((expiry.getTime() - Date.now()) / 1000),
      );
      setRemaining(diff);
      if (diff <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [expiry, remaining]);

  if (remaining <= 0) {
    return (
      <div className="text-xs text-red-400">
        Expired. Generate a new code.
      </div>
    );
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const isLow = remaining < 60;

  return (
    <div className={`text-xs ${isLow ? "text-red-400" : "text-text-muted"}`}>
      Expires in {minutes}:{seconds.toString().padStart(2, "0")}
    </div>
  );
}
