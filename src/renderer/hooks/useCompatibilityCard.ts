// useCompatibilityCard.ts — shared desktop↔box version matrix + dismiss state.
// Extracted verbatim from App.tsx (BET-366) so MobileApp.tsx reuses the SAME
// code path (BET-369) instead of duplicating the version-fetch + isCompatible
// + dismiss logic. Behavior is byte-for-byte identical to the inline App.tsx
// block it replaces.
//
// One fetch, one derivation, one dismiss latch — consumed by both the desktop
// shell (App.tsx) and the mobile shell (MobileApp.tsx). Neither call site
// owns version state or the matrix check anymore.

import { useEffect, useState } from "react";
import { isCompatible } from "../../shared/compatibility.mjs";

export type CompatibilityVariant = "match" | "behind" | "incompatible" | "unknown";

export type CompatibilityCard = {
  clientVersion: string | null;
  serverVersion: string | null;
  serverMinClient: string | null;
  variant: CompatibilityVariant;
  dismissed: boolean;
  dismiss: () => void;
  showCard: boolean;
};

export function useCompatibilityCard(): CompatibilityCard {
  const [clientVersion, setClientVersion] = useState<string | null>(null);
  const [serverMinClient, setServerMinClient] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.api.getClientVersion?.().catch(() => null),
      window.api.getServerVersion?.().catch(() => null),
    ]).then(([client, server]) => {
      if (cancelled) return;
      if (client && typeof client.version === "string") setClientVersion(client.version);
      if (server && typeof server.minClient === "string") setServerMinClient(server.minClient);
      if (server && typeof server.version === "string") setServerVersion(server.version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const variant = isCompatible({
    desktopVersion: clientVersion,
    boxVersion: serverVersion,
  });

  useEffect(() => {
    setDismissed(false);
  }, [variant]);

  const showCard = !dismissed && (variant === "behind" || variant === "incompatible");

  return {
    clientVersion,
    serverVersion,
    serverMinClient,
    variant,
    dismissed,
    dismiss: () => setDismissed(true),
    showCard,
  };
}
