// BET-659: the Artifacts panel shell — a fixed-width sibling of <main> in
// App.tsx. Owns the open/closed width (device-local via localStorage), the
// Links / Images / Files tab bar, and the header (title, search, close).
// The artifact rows themselves are deliberate plain-text placeholders; BET-660
// renders them real. Rows and preview are NOT built here.
//
// Data: the transcript is lifted into the store by ChatPanel (setChatMessages)
// so this panel can derive artifacts without a second opencodeMessages fetch;
// served pages come from servePageList on open + a 30s poll while open.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { ServedPageMeta } from "../shared/types";
import { useStore } from "./store";
import {
  countByKind,
  deriveArtifacts,
  groupByDay,
  type Artifact,
  type ArtifactKind,
} from "./artifacts";
import { resolvePreviewType } from "./chatUtils";
import { IconButton } from "./IconButton";
import { ArtifactPreview } from "./ArtifactPreview";
import { authHeaders, clientToken, serverBase } from "./api/httpApi";

// Download an artifact to the user's machine. Read-only: fetches the bytes
// from /api/peek (no source deletion — unlike the outbox /api/download path)
// and hands a blob: URL to a synthetic <a download>, the same save pattern
// httpApi's agentPullFile uses. BET-660's rows reuse this; do not reimplement.
export async function downloadArtifact(artifact: Artifact): Promise<void> {
  try {
    const url = `${serverBase()}/api/peek?path=${encodeURIComponent(artifact.href)}`;
    const res = await fetch(url, { method: "GET", headers: authHeaders(clientToken()) });
    if (!res.ok) return;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = artifact.label;
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  } catch {
    /* download trigger failed — non-fatal */
  }
}

// Re-attach an artifact into the session's composer. Fetches the bytes and
// hands a File to the existing `manta-attach-files` bridge, which renders the
// uploading→ready chip and converts it into a FilePart on submit — the same
// pipeline as every other attach. BET-660's rows reuse this; do not reimplement.
export async function attachArtifact(artifact: Artifact, sessionId: string): Promise<void> {
  try {
    const url = `${serverBase()}/api/peek?path=${encodeURIComponent(artifact.href)}`;
    const res = await fetch(url, { method: "GET", headers: authHeaders(clientToken()) });
    if (!res.ok) return;
    const blob = await res.blob();
    const file = new File([blob], artifact.label, {
      type: artifact.mime ?? "application/octet-stream",
    });
    window.dispatchEvent(
      new CustomEvent("manta-attach-files", { detail: { sessionId, files: [file] } }),
    );
  } catch {
    /* attach failed — non-fatal */
  }
}

const WIDTH_KEY = "manta:artifacts:width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 340;
const POLL_MS = 30_000;

const TABS: ArtifactKind[] = ["link", "image", "file"];
const TAB_LABEL: Record<ArtifactKind, string> = {
  link: "Links",
  image: "Images",
  file: "Files",
};

// Device-local width, clamped to 280-520. Wrapped in try/catch (repo
// convention — localStorage accesses throw in some embedded contexts).
function loadWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw)) {
      return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw));
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_WIDTH;
}

function persistWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    /* best-effort persist */
  }
}

// Per-tab empty state, matching the design's `.empty` block: a leading line
// (`.big`) plus the OTHER tabs' counts (`.sub`). This is why a default-Links
// tab is safe even when Links is empty.
function emptyBig(kind: ArtifactKind): string {
  if (kind === "link") return "No links yet";
  if (kind === "image") return "No images yet";
  return "No files yet";
}

function emptySub(kind: ArtifactKind, counts: { link: number; image: number; file: number }): string {
  if (kind === "link") return `${counts.image} images, ${counts.file} files`;
  if (kind === "image") return `${counts.link} links, ${counts.file} files`;
  return `${counts.link} links, ${counts.image} images`;
}

export function ArtifactsPanel({
  sessionId,
  open,
  onClose,
}: {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  // The transcript lifted by ChatPanel (reuse — never a second fetch).
  const messages = useStore((s) => (sessionId ? s.chatMessages[sessionId] ?? [] : []));

  const [pages, setPages] = useState<ServedPageMeta[]>([]);
  const [width, setWidth] = useState(loadWidth);
  const widthRef = useRef(width);
  widthRef.current = width;

  const [tab, setTab] = useState<ArtifactKind>("link");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The preview overlay: index into `previewable` (the current tab's
  // preview-aware artifacts), or null when closed. `previewSourceRef` keeps
  // the row that opened it so focus returns there on close.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const previewSourceRef = useRef<HTMLElement | null>(null);
  const draggingRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Page registry: fetch on open + 30s poll while open only. Timer cleared on
  // close and on session change (mirrors useSessionResources).
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await window.api.servePageList();
        if (!cancelled) setPages(list ?? []);
      } catch {
        /* best-effort page refresh */
      }
    };
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [open, sessionId]);

  // Reset the tab to the always-Links default + dismiss search on session
  // change so the panel follows the active chat pane cleanly. Also close any
  // open preview (its artifacts belong to the old session).
  useEffect(() => {
    setTab("link");
    setSearchOpen(false);
    setQuery("");
    setPreviewIndex(null);
  }, [sessionId]);

  const artifacts = useMemo(
    () => deriveArtifacts(messages, pages, sessionId ?? ""),
    [messages, pages, sessionId],
  );
  const counts = useMemo(() => countByKind(artifacts), [artifacts]);
  const tabArtifacts = useMemo(
    () => artifacts.filter((a) => a.kind === tab),
    [artifacts, tab],
  );
  // The arrow-key paging set: the current tab's artifacts with a resolvable
  // preview renderer, in display order. Refuse-type rows never open the
  // overlay — for them we download instead (their rows are BET-660's job).
  const previewable = useMemo(
    () => tabArtifacts.filter((a) => resolvePreviewType(a.mime, a.label) !== "refuse"),
    [tabArtifacts],
  );
  const filtered = useMemo(() => {
    if (!query) return tabArtifacts;
    const q = query.toLowerCase();
    return tabArtifacts.filter(
      (a) => a.label.toLowerCase().includes(q) || a.href.toLowerCase().includes(q),
    );
  }, [tabArtifacts, query]);
  const groups = useMemo(() => groupByDay(filtered, Date.now()), [filtered]);

  const openPreview = (pi: number, el: HTMLElement) => {
    previewSourceRef.current = el;
    setPreviewIndex(pi);
  };
  const closePreview = () => {
    setPreviewIndex(null);
    // Focus returns to the row that opened the overlay (BET-661).
    previewSourceRef.current?.focus();
    previewSourceRef.current = null;
  };

  if (!open) return null;

  return (
    <>
      <aside
        className="manta-artifacts-panel relative shrink-0 border-l border-border bg-bg-elev flex flex-col min-w-0"
        style={{ width }}
        aria-label="Artifacts"
      >
      {/* 4px resize handle on the left edge, pointer events only. Clamp to
          280-520; persist on pointer-up, not on every move. */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize touch-none"
        onPointerDown={(e) => {
          draggingRef.current = { startX: e.clientX, startWidth: widthRef.current };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = draggingRef.current;
          if (!d) return;
          const next = d.startWidth - (e.clientX - d.startX);
          setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
        }}
        onPointerUp={() => {
          persistWidth(widthRef.current);
          draggingRef.current = null;
        }}
        onPointerCancel={() => {
          draggingRef.current = null;
        }}
      />

      {/* Header row: title, search toggle, close. */}
      <div className="flex items-center gap-1 pl-3 pr-2 h-11 border-b border-border shrink-0">
        <span className="text-label font-semibold text-text flex-1 min-w-0 truncate">
          Artifacts
        </span>
        <IconButton
          icon={<Search />}
          label={searchOpen ? "Hide search" : "Search artifacts"}
          title={searchOpen ? "Hide search" : "Search"}
          onClick={() => setSearchOpen((v) => !v)}
        />
        <IconButton icon={<X />} label="Close artifacts panel" title="Close" onClick={onClose} />
      </div>

      {searchOpen && (
        <div className="px-2 py-2 border-b border-border shrink-0">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search links, images, files…"
            className="w-full bg-bg border border-border px-2 py-1 text-meta rounded-xs focus:outline-none placeholder:text-text-faint"
          />
        </div>
      )}

      {/* Tab bar: Links / Images / Files with counts, Links always the
          default — a moving default destroys muscle memory. Segmented control
          per the design `.mk-tabs` (inset track, raised active, count pills). */}
      <div
        className="mx-3 mb-3 flex gap-px p-px bg-inset border border-border-subtle rounded-md shrink-0"
        role="tablist"
        aria-label="Artifact kind"
      >
        {TABS.map((k) => {
          const active = tab === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(k)}
              className={
                "flex-1 inline-flex items-center justify-center gap-1 px-1 py-1 rounded-sm text-meta font-medium " +
                (active
                  ? "bg-raised text-text shadow-sm"
                  : "text-text-faint hover:text-text")
              }
            >
              {TAB_LABEL[k]}
              <span
                className={
                  "tabular-nums inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-micro " +
                  (active ? "bg-accent-bg text-accent-tx" : "bg-fill text-text-faint")
                }
              >
                {counts[k]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Body: day-grouped, sticky headers, newest first. Placeholder rows
          render label only — deliberately unstyled. */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="sticky top-0 bg-bg-elev px-3 py-1 text-micro font-semibold uppercase text-text-faint">
              {g.label}
            </div>
            {g.items.map((a) => {
              const pi = previewable.findIndex((p) => p.id === a.id);
              const isPreviewable = pi >= 0;
              return (
                <div
                  key={a.id}
                  role={isPreviewable ? "button" : undefined}
                  tabIndex={isPreviewable ? 0 : undefined}
                  title={a.href}
                  onClick={
                    isPreviewable
                      ? (e) => openPreview(pi, e.currentTarget)
                      : undefined
                  }
                  onKeyDown={
                    isPreviewable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openPreview(pi, e.currentTarget);
                          }
                        }
                      : undefined
                  }
                  className={
                    "px-3 py-1 text-meta text-text-muted truncate" +
                    (isPreviewable
                      ? " rounded-xs cursor-pointer hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent"
                      : "")
                  }
                >
                  {a.label}
                </div>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="px-4 py-8 text-center">
            {query ? (
              <div className="text-label text-text-muted">No matches for “{query}”</div>
            ) : (
              <>
                <div className="text-label text-text-faint">{emptyBig(tab)}</div>
                <div className="mt-1 text-micro text-text-faint">{emptySub(tab, counts)}</div>
              </>
            )}
          </div>
        )}
      </div>
      </aside>

      {/* The preview overlay — one surface, a renderer per type. Rendered here
          (sibling of the panel) so it covers the whole window, not just the
          panel strip. */}
      {previewIndex != null && previewable[previewIndex] != null && (
        <ArtifactPreview
          artifacts={previewable}
          index={previewIndex}
          onClose={closePreview}
          onDownload={downloadArtifact}
          onAttach={(a) => void attachArtifact(a, sessionId ?? "")}
        />
      )}
    </>
  );
}
