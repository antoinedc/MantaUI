// ArtifactPreview.tsx — the in-app preview overlay (BET-661).
//
// ONE surface with a renderer per type, opened by the Artifacts panel's rows.
// A centred card over a canvas-tinted backdrop, with a header (filename +
// type-appropriate actions + close), a scrollable body (the per-type
// renderer), and a footer of metadata. Arrow keys page through every
// previewable artifact in the current tab (no wrapping at either end),
// Escape closes, and focus returns to the row that opened it (caller-owned).
//
// The load-bearing size guard runs BEFORE any bytes are fetched: a `HEAD` to
// `/api/peek` (BET-657) yields `content-length`, and if it exceeds
// `MAX_PREVIEW_BYTES` we never `GET` the body — we show "Too large" with a
// Download instead. The in-flight request is aborted when the overlay closes
// or the user pages to another artifact, so a late response never writes into
// a closed or changed overlay.
//
// Deliberately NOT built on `Modal.tsx`: this surface needs (a) a
// canvas-tinted backdrop (Modal hardcodes an opaque black overlay), (b) a
// max-width-flexible card with a full flex column (header/body/footer) rather
// than one of Modal's fixed-width padded dialog sizes, and (c) absolute
// left/right arrow affordances — none of which Modal's no-escape-hatch
// primitive can express. Escape / arrow-key handling stays at this call site
// regardless (Modal never owns it). All other chrome (IconButton, tokens) is
// reused.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, Paperclip, X } from "lucide-react";
import { clientToken, serverBase, authHeaders } from "./api/httpApi";
import {
  countPreviewLines,
  formatBytes,
  formatPreviewFooter,
  isWithinPreviewSize,
  previewLanguage,
  resolvePreviewType,
  type PreviewType,
} from "./chatUtils";
import { CodeBlock } from "./MarkdownBody";
import { IconButton } from "./IconButton";
import type { Artifact } from "./artifacts";

/** Data + render context for the currently shown artifact once its body has
 *  passed the size guard and been fetched. `kind` mirrors the resolved
 *  `PreviewType` minus `refuse` (the caller only ever opens previewable
 *  artifacts, so refuse never surfaces here). */
type Loaded =
  | { status: "loading" }
  | { status: "too-large"; size: number }
  | { status: "error" }
  | { status: "ready"; kind: "image"; url: string; size: number }
  | { status: "ready"; kind: "pdf"; url: string; size: number }
  | { status: "ready"; kind: "text"; text: string; lines: number; language: string };

// A demo/data-URL href needs no HEAD+GET — render it directly. Production
// artifact hrefs are absolute box paths served by /api/peek.
function isDataUrl(href: string): boolean {
  return href.startsWith("data:");
}

async function loadArtifact(
  artifact: Artifact,
  type: PreviewType,
  signal: AbortSignal,
): Promise<Loaded> {
  if (type === "refuse") {
    // Caller filters these out; this is a defensive guard only.
    return { status: "error" };
  }

  // Demo capture path: the fixture points an image artifact at a data: URL.
  if (isDataUrl(artifact.href)) {
    return { status: "ready", kind: "image", url: artifact.href, size: artifact.href.length };
  }

  const base = `${serverBase()}/api/peek?path=${encodeURIComponent(artifact.href)}`;
  const headers = authHeaders(clientToken());

  // Guard first: HEAD → content-length. Never GET the body unless it passes.
  let head: Response;
  try {
    head = await fetch(base, { method: "HEAD", headers, signal });
  } catch {
    return { status: "error" };
  }
  if (!head.ok) return { status: "error" };
  const size = Number(head.headers.get("content-length") ?? 0);
  if (!isWithinPreviewSize(size)) return { status: "too-large", size };

  let res: Response;
  try {
    res = await fetch(base, { method: "GET", headers, signal });
  } catch {
    return { status: "error" };
  }
  if (!res.ok) return { status: "error" };

  if (type === "text") {
    const text = await res.text();
    return {
      status: "ready",
      kind: "text",
      text,
      lines: countPreviewLines(text),
      language: previewLanguage(artifact.label),
    };
  }

  // image / pdf: keep the body as bytes and address it via an object URL.
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  return { status: "ready", kind: type === "pdf" ? "pdf" : "image", url, size };
}

export function ArtifactPreview({
  artifacts,
  index,
  onClose,
  onDownload,
  onAttach,
}: {
  /** The previewable artifacts in the current tab, in panel display order.
   *  Arrow keys page through this exact list. */
  artifacts: Artifact[];
  /** Initial index into `artifacts`. */
  index: number;
  onClose: () => void;
  onDownload: (artifact: Artifact) => void;
  onAttach: (artifact: Artifact) => void;
}) {
  const [idx, setIdx] = useState(() => Math.min(Math.max(index, 0), Math.max(artifacts.length - 1, 0)));
  const artifact = artifacts[idx];

  // Per-artifact load state + the width/height we only learn after an <img>.
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  // Track object URLs we minted so we can revoke them on unmount/change.
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  const type = useMemo(
    () => resolvePreviewType(artifact?.mime ?? null, artifact?.label ?? ""),
    [artifact],
  );

  useEffect(() => {
    if (!artifact) {
      setLoaded({ status: "error" });
      return;
    }
    setLoaded({ status: "loading" });
    setDims(null);
    const ctrl = new AbortController();
    let localUrl: string | null = null;
    void loadArtifact(artifact, type, ctrl.signal)
      .then((result) => {
        if (ctrl.signal.aborted) return;
        if (result.status === "ready" && result.kind !== "text" && result.url.startsWith("blob:")) {
          localUrl = result.url;
          objectUrlsRef.current.add(result.url);
        }
        setLoaded(result);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoaded({ status: "error" });
      });
    return () => {
      ctrl.abort();
      if (localUrl) objectUrlsRef.current.delete(localUrl);
    };
  }, [artifact, type]);

  // Revoke every object URL we have on final unmount.
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  // Focus the overlay so arrow keys + Escape work immediately (no click first).
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const canPrev = idx > 0;
  const canNext = idx < artifacts.length - 1;

  const prev = () => canPrev && setIdx((i) => i - 1);
  const next = () => canNext && setIdx((i) => i + 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prev();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      next();
    }
  };

  if (!artifact) return null;

  const footerText =
    loaded.status === "ready"
      ? formatPreviewFooter(
          type,
          loaded.kind === "image"
            ? {
                width: dims?.width,
                height: dims?.height,
                size: loaded.size,
                origin: artifact.origin,
              }
            : loaded.kind === "pdf"
              ? { size: loaded.size }
              : { lines: loaded.lines, language: loaded.language },
        )
      : "";

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${artifact.label}`}
      className="manta-artifact-preview fixed inset-0 z-50 flex items-center justify-center outline-none bg-bg/[0.82]"
      onKeyDown={onKeyDown}
    >
      {/* Backdrop click closes. */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      {/* Centred card — max-width 560px like the mockup `.pv`. */}
      <div className="relative w-full max-w-[560px] max-h-[85vh] flex flex-col bg-bg-elev border border-border rounded-lg shadow-lg overflow-hidden mx-6">
        {/* Header — filename, then attach / download / close. */}
        <div className="flex items-center gap-3 px-3 py-[9px] border-b border-border-subtle">
          <span className="flex-1 min-w-0 font-mono text-meta text-text truncate" title={artifact.href}>
            {artifact.label}
          </span>
          <IconButton
            icon={<Paperclip />}
            label="Attach"
            title="Attach"
            onClick={() => onAttach(artifact)}
          />
          <IconButton
            icon={<Download />}
            label="Download"
            title="Download"
            onClick={() => onDownload(artifact)}
          />
          <IconButton icon={<X />} label="Close preview" title="Close" onClick={onClose} />
        </div>

        {/* Body — the per-type renderer on the inset surface. Images sit
            centred/contained; text/pdf scroll. */}
        <div className="flex-1 bg-inset overflow-auto min-h-[240px] flex">
          {loaded.status === "loading" && (
            <div className="m-auto text-text-faint">
              <Loader2 className="animate-spin" size={20} aria-hidden="true" />
            </div>
          )}

          {loaded.status === "too-large" && (
            <div className="m-auto px-6 py-8 text-center">
              <div className="text-label text-text-muted">
                Too large to preview — {formatBytes(loaded.size)}
              </div>
              <div className="mt-3 flex justify-center">
                <IconButton
                  icon={<Download />}
                  label="Download"
                  size="xl"
                  onClick={() => onDownload(artifact)}
                />
              </div>
            </div>
          )}

          {loaded.status === "error" && (
            <div className="m-auto px-6 py-8 text-center">
              <div className="text-label text-text-muted">Couldn’t load this file to preview.</div>
              <div className="mt-3 flex justify-center">
                <IconButton
                  icon={<Download />}
                  label="Download"
                  size="xl"
                  onClick={() => onDownload(artifact)}
                />
              </div>
            </div>
          )}

          {loaded.status === "ready" && loaded.kind === "image" && (
            <div className="m-auto p-4 w-full h-full grid place-items-center">
              <img
                src={loaded.url}
                alt={artifact.label}
                className="max-w-full max-h-full object-contain"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setDims({ width: el.naturalWidth, height: el.naturalHeight });
                }}
              />
            </div>
          )}

          {loaded.status === "ready" && loaded.kind === "pdf" && (
            <embed
              src={loaded.url}
              type="application/pdf"
              title={artifact.label}
              className="w-full h-full"
            />
          )}

          {loaded.status === "ready" && loaded.kind === "text" && (
            <div className="w-full p-1">
              <CodeBlock lang={loaded.language} body={loaded.text} />
            </div>
          )}
        </div>

        {/* Footer — metadata per type. */}
        <div className="flex items-center gap-2 px-3 py-[7px] text-micro text-text-quiet border-t border-border-subtle">
          <span>{footerText}</span>
        </div>
      </div>

      {/* Left / right arrow affordances — paging, no wrap. */}
      {canPrev && (
        <button
          type="button"
          aria-label="Previous artifact"
          onClick={prev}
          className="absolute left-4 top-1/2 -translate-y-1/2 w-[34px] h-[34px] rounded-full bg-raised border border-border grid place-items-center text-text hover:bg-fill-hover"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
      )}
      {canNext && (
        <button
          type="button"
          aria-label="Next artifact"
          onClick={next}
          className="absolute right-4 top-1/2 -translate-y-1/2 w-[34px] h-[34px] rounded-full bg-raised border border-border grid place-items-center text-text hover:bg-fill-hover"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
