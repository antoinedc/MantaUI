// MediaBody.tsx — the inline image / video body shared by the Artifacts preview
// overlay and the Explorer viewer (extracted from ArtifactPreview so there is
// ONE renderer). `usePeekedMedia` is the shared loader: an authenticated
// /api/peek fetch into a blob: URL, aborted on unmount / source change and
// revoked when replaced.

import { useEffect, useState } from "react";
import { fetchPeekBlob, type PeekFailure } from "./filePeek";

export type MediaDims = { width: number; height: number };

export function MediaBody({
  kind,
  url,
  label,
  onDims,
}: {
  kind: "image" | "video";
  url: string;
  /** Alt text / title. */
  label: string;
  /** Reports the intrinsic size once an image has loaded. */
  onDims?: (dims: MediaDims) => void;
}) {
  return (
    <div className="m-auto p-4 w-full h-full grid place-items-center">
      {kind === "image" ? (
        <img
          src={url}
          alt={label}
          className="max-w-full max-h-full object-contain"
          onLoad={(e) => {
            const el = e.currentTarget;
            onDims?.({ width: el.naturalWidth, height: el.naturalHeight });
          }}
        />
      ) : (
        // No autoplay: an explicit play control + first-frame poster.
        <video src={url} controls preload="metadata" title={label} className="max-w-full max-h-full" />
      )}
    </div>
  );
}

export type PeekedMedia =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed"; reason: PeekFailure | "too-large" };

/** Loads `abs` into a blob: URL. `version` re-loads the same path (Retry / a
 *  refreshed file). */
export function usePeekedMedia(abs: string, version: number): PeekedMedia {
  const [state, setState] = useState<PeekedMedia>({ status: "loading" });
  useEffect(() => {
    const ctrl = new AbortController();
    let url: string | null = null;
    setState({ status: "loading" });
    fetchPeekBlob(abs, { signal: ctrl.signal })
      .then((r) => {
        if (ctrl.signal.aborted) return;
        if (!r.ok) {
          setState({ status: "failed", reason: r.reason });
          return;
        }
        url = URL.createObjectURL(r.blob);
        setState({ status: "ready", url });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ status: "failed", reason: "network" });
      });
    return () => {
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [abs, version]);
  return state;
}
