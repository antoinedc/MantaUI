// PairingQR — renders a QR code image for mobile device pairing.
//
// The QR encodes the UNIVERSAL-LINK https form produced by the SHARED
// `buildUniversalPairLink` helper (src/shared/pairPayload.ts):
//   https://app.mantaui.com/m?box=<boxId>&code=<code>[&server=<url>]
// A camera scan of a universal link opens a URL even when the app is NOT yet
// installed (the OS resolves it and hands off to the App Store / app once the
// associated domains resolve) — scanning a custom `manta://` scheme did
// nothing without the app (BET-703). `buildUniversalPairLink` shares the
// single `UNIVERSAL_LINK_HOST` with the iOS parser, and is deliberately NOT
// parameterized by channel (universal links have one registered host).
//
// The optional `serverUrl` prop (BET-703) lets a tailnet / macOS box (no
// public hostname) ship a QR that carries its private listener — see
// `resolveQrServerOverride` in pairPanel.ts, which the AddPhonePanel feeds.
// The caller passes the desktop's configured server URL in; when it equals
// the box's derived public hostname, `serverUrl` is omitted (today's
// behavior).
//
// We use the `qrcode` npm package to generate a data URL, then render it as
// an <img> tag. The data URL is memoized so we don't regenerate on every
// render (QR generation is CPU-bound).
//
// This is a desktop-only feature (BET-80). The mobile app generates the QR on
// the desktop side but consumes the same URL scheme.

import { useEffect, useMemo, useState } from "react";
import { buildUniversalPairLink } from "../shared/pairPayload";

// Lazy-load qrcode so the renderer doesn't pay the bundle cost if this
// component is never rendered (Settings is a modal, only open on demand).
// We use a dynamic import inside useMemo so SSR/static builds don't choke.
async function loadQrCode() {
  return (await import("qrcode")).default;
}

export function PairingQR({
  boxId,
  pairingCode,
  serverUrl,
}: {
  boxId: string;
  pairingCode: string;
  serverUrl?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    // Universal-link https form — the QR is what gets scanned by a camera, so
    // it must open a URL whether or not the app is installed. Single source:
    // pairPayload.ts. No channel scheme: universal links have one host.
    return buildUniversalPairLink({ boxId, code: pairingCode, serverUrl });
  }, [boxId, pairingCode, serverUrl]);

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
      <div className="text-meta text-danger p-2">
        QR generation failed: {error}
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div className="w-[200px] h-[200px] bg-bg-soft border border-border rounded-xs flex items-center justify-center text-meta text-text-muted">
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
      <div className="text-meta text-danger">
        Expired. Generate a new code.
      </div>
    );
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const isLow = remaining < 60;

  return (
    <div className={`text-meta ${isLow ? "text-danger" : "text-text-muted"}`}>
      Expires in {minutes}:{seconds.toString().padStart(2, "0")}
    </div>
  );
}
