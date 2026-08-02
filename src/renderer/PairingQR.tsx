// PairingQR — renders a QR code image for mobile device pairing.
//
// The QR encodes the CANONICAL box-form `<scheme>://pair?box=<boxId>&code=<6-digit>`
// payload produced by the SHARED `buildPairPayload` helper
// (src/shared/pairPayload.ts). BET-237 removed the deprecated
// serverUrl / id forms — `parsePairPayload` rejects anything other than
// `box=<boxId>&code=<6-digit>`. The canonical form is the SAME shape `manta
// pair` prints + the install heredoc + the deep-link handler in
// MobileApp.tsx parses.
//
// We use the `qrcode` npm package to generate a data URL, then render it as
// an <img> tag. The data URL is memoized so we don't regenerate on every
// render (QR generation is CPU-bound).
//
// This is a desktop-only feature (BET-80). The mobile app consumes the same
// URL scheme but generates the QR on the desktop side.
//
// BET-373 (channel-aware wire format): the QR uses THIS channel's URL scheme
// (`channelConfig(__MANTA_CHANNEL__).urlScheme`, the same source the main
// process uses to register `setAsDefaultProtocolClient(...)` and to build
// `PAIR_PREFIX`). A staging desktop scans a QR with `manta-staging://…` so
// the OS routes the open back to staging, not to whichever channel got
// registered last for `manta://`. `__MANTA_CHANNEL__` is baked into the
// renderer at build time (electron.vite.config.ts renderer `define`).

import { useEffect, useMemo, useState } from "react";
import { buildPairPayload } from "../shared/pairPayload";
import { channelConfig } from "../shared/channel.mjs";

// Channel-aware scheme for the QR prefix. The baked `__MANTA_CHANNEL__`
// comes from the renderer `define` (electron.vite.config.ts); channelConfig
// does the same unknown-id → prod fallback the main process relies on, so a
// stale/garbage baked value still produces a usable scheme rather than
// throwing at render time.
const PAIR_SCHEME = channelConfig(__MANTA_CHANNEL__).urlScheme;

// Lazy-load qrcode so the renderer doesn't pay the bundle cost if this
// component is never rendered (Settings is a modal, only open on demand).
// We use a dynamic import inside useMemo so SSR/static builds don't choke.
async function loadQrCode() {
  return (await import("qrcode")).default;
}

export function PairingQR({
  boxId,
  pairingCode,
  verify,
}: {
  boxId: string;
  pairingCode: string;
  /** Optional four-char two-sided-confirm code (BET-514 §5.3). When present
   *  the QR encodes `&verify=` so a scanning device claims WITH it → DISTINCT
   *  Stage-2 device, never the shared primary box_token. */
  verify?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    // Canonical box-form payload — shared with the install heredoc, `manta pair`
    // output, and the mobile deep-link parser. Single source: pairPayload.ts.
    // BET-373: `PAIR_SCHEME` keys the QR to this channel's OS-registered URL
    // scheme so the OS routes the open back to the channel that scanned it.
    // BET-514: forward `verify` (when present) so the QR carries the two-sided
    // confirm and the scanning phone provisions a distinct device.
    return buildPairPayload({ boxId, code: pairingCode, verify }, PAIR_SCHEME);
  }, [boxId, pairingCode, verify]);

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
      <div className="w-[200px] h-[200px] bg-bg-soft border border-border rounded flex items-center justify-center text-meta text-text-muted">
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
