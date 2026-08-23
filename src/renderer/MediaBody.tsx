// MediaBody.tsx — the single inline-media renderer (BET-1148).
//
// ONE component used by BOTH call sites: the media card driven by the `media`
// bus events (begin → reserve, show → swap in, fail → label) and the existing
// `file`-part branch of ToolCall for image/video mimes. Writing two renderers
// is a defect for this issue, so MediaBody is the only one.
//
// The load-bearing rule (BET-1148): the placeholder RESERVES the media's final
// aspect box before the bytes arrive. `resolveMediaAspect` (chatUtils) yields
// the width÷height from explicit dimensions, else the declared aspect ratio,
// else the labelled 16:9 default — and every state (pending / ready / failed /
// expired) renders inside the SAME reserved box, so the transcript's
// pin-to-bottom logic never sees a height change under the reader. A `show`
// swaps the finished media in at the exact same aspect: zero movement.
//
// Decisions (locked, do not revisit):
//   - renders as the BODY of a ToolCard, on the inset surface (OutputWell),
//     expanded by default — the image is the result, not the evidence.
//   - no autoplay, ever: video shows a first frame with an explicit play control.
//   - clicking media opens the existing ArtifactPreview overlay (no second lightbox).
//   - bytes are fetched through the existing /api/peek route with the existing
//     auth headers, exactly as ArtifactPreview does (no new fetch path).
//   - pending shows a skeleton + elapsed clock + the declared title; it never
//     fabricates a percentage (the server sends none).

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, Download } from "lucide-react";
import { ToolCard } from "./ToolCard";
import { OutputWell } from "./OutputWell";
import { type Artifact } from "./artifacts";
import { ArtifactPreview } from "./ArtifactPreview";
import { clientToken, serverBase, authHeaders } from "./api/httpApi";
import { boxStyle, DegradedBox, TILE_CLS } from "./inlineEmbed";
import {
  type MediaEntry,
  formatDuration,
  isWithinPreviewSize,
  mediaGrid,
  mediaKindFromMime,
} from "./chatUtils";
import { saveToDownloads } from "./downloadFeedback";
import { useClockTick, WORKING_TICK_MS, nowMs } from "./clock";

function TileIndex({ n }: { n: number }) {
  return (
    <span className="absolute left-1 top-1 px-1 py-px rounded-xs bg-bg-elev border border-border-subtle text-[10px] leading-none text-text-faint font-mono">
      {n}
    </span>
  );
}

// Pending — the reserved box with a skeleton + elapsed clock. Only mounted
// while `state === "pending"`, so its 1s ticker (the shared WORKING_TICK_MS
// bucket, the RunningIndicator precedent) stops the moment a show/fail lands.
function PendingBox({ entry }: { entry: MediaEntry }) {
  useClockTick(WORKING_TICK_MS);
  const { meta } = entry;
  const beganAt = entry.beganAt ?? null;
  const elapsed = beganAt != null ? formatDuration(nowMs() - beganAt) : "<1s";
  const grid = mediaGrid(meta.count);
  const label = meta.kind === "video" ? "Generating video" : "Generating image";

  return (
    <div className="w-full flex flex-col" style={{ gap: "var(--sp-2)" }}>
      {grid.tiles > 1 ? (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
        >
          {Array.from({ length: grid.tiles }).map((_, i) => (
            <div key={i} className={TILE_CLS} style={boxStyle(entry.meta)} data-media-box>
              <TileIndex n={i + 1} />
              <Loader2 className="animate-spin text-text-faint" size={18} aria-hidden="true" />
            </div>
          ))}
        </div>
      ) : (
        <div className={TILE_CLS} style={boxStyle(entry.meta)} data-media-box>
          <Loader2 className="animate-spin text-text-faint" size={18} aria-hidden="true" />
        </div>
      )}
      {grid.more > 0 && (
        <div className="text-label text-text-faint">+{grid.more} more</div>
      )}
      <div className="flex items-center gap-2 text-label text-text-muted">
        <span className="text-text">{label}</span>
        {elapsed && <span className="tabular-nums text-text-faint">{elapsed}</span>}
        <span className="text-text-quiet">· this usually takes a few seconds</span>
      </div>
    </div>
  );
}

function ReadyMedia({ entry }: { entry: MediaEntry }) {
  const { meta } = entry;
  const kind = mediaKindFromMime(meta.mime) ?? meta.kind;
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    const path = meta.path;
    if (!path) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    const ctrl = new AbortController();
    let localUrl: string | null = null;
    const run = async () => {
      try {
        const base = `${serverBase()}/api/peek?path=${encodeURIComponent(path)}`;
        const headers = authHeaders(clientToken());
        const head = await fetch(base, { method: "HEAD", headers, signal: ctrl.signal });
        if (!head.ok) throw new Error("head");
        const size = Number(head.headers.get("content-length") ?? 0);
        if (!isWithinPreviewSize(size)) throw new Error("too-large");
        const res = await fetch(base, { method: "GET", headers, signal: ctrl.signal });
        if (!res.ok) throw new Error("get");
        const blob = await res.blob();
        const u = URL.createObjectURL(blob);
        localUrl = u;
        urlRef.current = u;
        setUrl(u);
        setStatus("ready");
      } catch {
        if (!ctrl.signal.aborted) setStatus("error");
      }
    };
    void run();
    return () => {
      ctrl.abort();
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [meta.path]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const artifact = useMemo<Artifact | null>(() => {
    if (!meta.path) return null;
    const label = meta.title ?? (meta.path.split("/").pop() || meta.path);
    return {
      id: `media:${meta.path}`,
      kind: kind === "image" ? "image" : "file",
      origin: "agent",
      key: meta.path.toLowerCase(),
      label,
      href: meta.path,
      mime: meta.mime,
      size: null,
      at: 0,
      messageId: null,
      context: null,
      expiresAt: null,
    };
  }, [meta.path, meta.title, meta.mime, kind]);

  const openPreview = () => {
    if (artifact) setPreviewOpen(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPreview();
    }
  };

  const label = meta.title ?? (meta.path?.split("/").pop() ?? meta.kind);

  // BET-1156: the shared laptop-download path. On desktop agentPullFile routes
  // through the preload bridge → main writes a real file to downloadsDir;
  // on mobile/web it falls back to a browser download. Used by both the hover
  // overlay and the preview overlay's Download.
  //
  // Goes through `saveToDownloads` so the save REPORTS ITSELF (BET-1198): this
  // used to be a bare fire-and-forget call, so a successful download showed the
  // user nothing at all and a failed one showed only an unhandled rejection in
  // devtools — indistinguishable from each other, and from a broken button.
  const handleDownload = () => {
    if (meta.path) void saveToDownloads(meta.path);
  };

  return (
    <>
      <div
        className="w-full relative group"
        style={boxStyle(entry.meta)}
        onClick={openPreview}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
        aria-label={`Open ${kind} preview`}
        title="Click to view"
        data-media-box
        data-open-preview
      >
        {status === "loading" && (
          <div className={TILE_CLS} style={{ height: "100%" }}>
            <Loader2 className="animate-spin text-text-faint" size={18} aria-hidden="true" />
          </div>
        )}
        {status === "error" && (
          <div className={TILE_CLS} style={{ height: "100%" }}>
            <span className="text-label text-text-muted">⚠ Couldn’t load this media</span>
          </div>
        )}
        {status === "ready" && kind === "image" && url && (
          <img
            src={url}
            alt={label}
            className="w-full h-full object-contain rounded-md border border-border-subtle bg-inset"
          />
        )}
        {status === "ready" && kind === "video" && url && (
          <div className="w-full h-full rounded-md border border-border-subtle bg-inset overflow-hidden">
            {/* No autoplay, ever: explicit play control + first-frame poster. */}
            <video src={url} controls preload="metadata" className="w-full h-full" />
          </div>
        )}
        {/* BET-1156: hover-only Download overlay INSIDE the reserved box.
            Absolute + pointer-events-none so it never changes the box
            dimensions and never blocks the whole-box click-to-preview; only
            the button itself receives pointer events. */}
        {status === "ready" && meta.path && (
          <div className="pointer-events-none absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              aria-label="Download"
              title="Download"
              onClick={(e) => {
                e.stopPropagation();
                handleDownload();
              }}
              className="pointer-events-auto grid place-items-center w-6 h-6 rounded-md text-text-faint hover:bg-fill-hover hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              <Download size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {previewOpen && artifact && (
        <ArtifactPreview
          artifacts={[artifact]}
          index={0}
          onClose={() => setPreviewOpen(false)}
          onDownload={() => handleDownload()}
          onAttach={null}
        />
      )}
    </>
  );
}

function MediaContent({ entry }: { entry: MediaEntry }) {
  if (entry.state === "pending") return <PendingBox entry={entry} />;
  if (entry.state === "ready") return <ReadyMedia entry={entry} />;
  const label = entry.state === "expired" ? "This media expired" : "The media failed to generate";
  return <DegradedBox label={label} dims={entry.meta} />;
}

/**
 * The single media renderer. Renders the full card — a ToolCard shell, expanded
 * by default, with the media body on the inset surface. Memoized (the store
 * keeps a stable per-message entry reference; a typing keystroke re-renders the
 * ChatPanel but must not re-render this leaf).
 */
export const MediaBody = memo(function MediaBody({ entry }: { entry: MediaEntry }) {
  const [expanded, setExpanded] = useState(true);
  const { meta, state } = entry;
  const name = meta.kind === "video" ? "Video" : "Image";
  const arg = meta.title ?? undefined;
  const degraded = state === "failed" || state === "expired";

  return (
    <ToolCard
      tone={degraded ? "error" : undefined}
      name={name}
      arg={arg}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && (
        <OutputWell variant="attached">
          <MediaContent entry={entry} />
        </OutputWell>
      )}
    </ToolCard>
  );
});
