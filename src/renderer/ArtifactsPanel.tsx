// BET-659/660: the Artifacts panel — a fixed-width sibling of <main> in
// App.tsx. Owns the open/closed width (device-local via localStorage), the
// Links / Images / Files tab bar, and the header (title, search, close).
//
// BET-661 owns the preview overlay (ArtifactPreview + the row-open wiring in
// `openPreview`/`previewable`). BET-660 fills the three tabs with their real
// row grammar — link cards, a 2-up image grid, and compact file rows — and the
// shared row actions (open / attach / download / jump). Attach and download
// reuse the `attachArtifact` / `downloadArtifact` helpers BET-661 defined here
// (bytes via /api/peek, non-destructive); jump scrolls the transcript to the
// owning message via the `manta-scroll-to-message` window event.
//
// Data: the transcript is lifted into the store by ChatPanel (setChatMessages)
// so this panel can derive artifacts without a second opencodeMessages fetch;
// served pages come from servePageList on open + a 30s poll while open.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  FileText,
  Link2,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import type { OutboxFile, ServedPageMeta } from "../shared/types";
import { useStore } from "./store";
import {
  countByKind,
  deriveArtifacts,
  groupByDay,
  pageState,
  type Artifact,
  type ArtifactKind,
  type ArtifactOrigin,
} from "./artifacts";
import { expiryLabel, formatBytes, resolvePreviewType } from "./chatUtils";
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

// Direction glyph — the ONLY direction affordance (there is no direction
// filter). ArrowUp tinted --info for user-sent, ArrowDown tinted --ok for
// agent-generated. Matches the mockup's `.dirglyph.up/.down`.
function DirectionGlyph({ origin }: { origin: ArtifactOrigin }) {
  const Icon = origin === "user" ? ArrowUp : ArrowDown;
  return (
    <Icon
      className={`manta-artifacts-dir h-[11px] w-[11px] flex-none`}
      style={{ strokeWidth: 2.4, color: origin === "user" ? "var(--info)" : "var(--ok)" }}
    />
  );
}

function ActionButton({
  icon,
  label,
  title,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-sm text-text-muted hover:bg-fill-hover hover:text-text disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
    </button>
  );
}

// The three shared row actions (attach / download / jump) used by both the
// image tiles and the file rows, so the button cluster is defined once.
function RowActions({
  onAttach,
  onDownload,
  onJump,
  canJump,
}: {
  onAttach: () => void;
  onDownload: () => void;
  onJump: () => void;
  canJump: boolean;
}) {
  return (
    <>
      <ActionButton icon={<Paperclip className="h-3.5 w-3.5" />} label="Attach to message" title="Attach to message" onClick={onAttach} />
      <ActionButton icon={<Download className="h-3.5 w-3.5" />} label="Download" title="Download" onClick={onDownload} />
      <ActionButton icon={<ChevronRight className="h-3.5 w-3.5" />} label="Jump to message" title="Jump to message" onClick={onJump} disabled={!canJump} />
    </>
  );
}

// ===== Tab 1 — Links =======================================================

function ExpiryPill({ state, label }: { state: "live" | "soon" | "expired"; label: string }) {
  const cls =
    state === "live"
      ? "bg-ok-bg text-ok"
      : state === "soon"
        ? "bg-warn-bg text-warn"
        : "bg-danger-bg text-danger";
  return (
    <span
      className={`ml-1 inline-flex shrink-0 items-center gap-1 rounded-full px-[6px] py-[2px] text-[9.5px] font-semibold align-middle ${cls}`}
    >
      {label}
    </span>
  );
}

function LinkCard({
  artifact,
  now,
  onOpen,
  onJump,
}: {
  artifact: Artifact;
  now: number;
  onOpen: (el: HTMLElement) => void;
  onJump: () => void;
}) {
  const state = artifact.expiresAt != null ? pageState(artifact.expiresAt, now) : null;
  const expired = state === "expired";
  const isHosted = artifact.isHosted ?? false;
  const hasContext = artifact.context != null;

  return (
    <div
      className={`mb-[9px] overflow-hidden rounded-md border border-border-subtle bg-bg-soft ${expired ? "opacity-50" : ""}`}
    >
      {/* Row body — opens the artifact. */}
      <button
        type="button"
        onClick={(e) => onOpen(e.currentTarget)}
        className="flex w-full items-start gap-3 p-3 text-left"
        aria-label="Open artifact"
      >
        <div className="grid h-[52px] w-[52px] flex-none place-items-center rounded-sm border border-border-subtle bg-inset">
          {isHosted ? (
            <FileText className="h-5 w-5 text-text-quiet" style={{ strokeWidth: 1.6 }} />
          ) : (
            <Link2 className="h-5 w-5 text-text-quiet" style={{ strokeWidth: 1.6 }} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {/* Title + expiry pill on ONE line: the label truncates with an
              ellipsis when tight; the pill is a shrink-0 sibling so name and
              expiry never wrap to a second line. */}
          <div className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate text-meta font-semibold text-text">
              {artifact.label}
            </span>
            {/* Expiry chip — present on every hosted page (serve_page), incl. a
                no-expiry one, so it is never hidden by a long title; the label
                truncates above. External/pasted links never get a chip. */}
            {isHosted && (
              <ExpiryPill
                state={state ?? "live"}
                label={
                  state === "expired"
                    ? "expired"
                    : artifact.expiresAt != null
                      ? expiryLabel(artifact.expiresAt, now)
                      : "no expiry"
                }
              />
            )}
          </div>
          <div className="mt-1 truncate font-mono text-micro text-text-quiet">
            {artifact.kind === "link" ? artifact.href.replace(/^https?:\/\//, "") : artifact.href}
          </div>
        </div>
      </button>

      {/* Context strip — omitted entirely when context is null. */}
      {hasContext && (
        <div className="flex items-center gap-2 border-t border-border-subtle bg-fill px-3 py-[7px]">
          <div className="line-clamp-2 min-w-0 flex-1 text-micro text-text-faint">
            {artifact.context}
          </div>
          <button
            type="button"
            aria-label="Jump to message"
            title="Jump to message"
            disabled={!artifact.messageId}
            onClick={onJump}
            className="flex flex-none items-center justify-center text-text-faint hover:text-text disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" style={{ strokeWidth: 2 }} />
          </button>
        </div>
      )}
    </div>
  );
}

// ===== Tab 2 — Images ======================================================

function ImageTile({
  artifact,
  onOpen,
  onAttach,
  onDownload,
  onJump,
}: {
  artifact: Artifact;
  now?: number; // shared with FileRow so image tiles span the same render path
  onOpen: (el: HTMLElement) => void;
  onAttach: () => void;
  onDownload: () => void;
  onJump: () => void;
}) {
  return (
    <div className="group relative aspect-[4/3] overflow-hidden rounded-sm border border-border-subtle bg-inset">
      <button
        type="button"
        onClick={(e) => onOpen(e.currentTarget)}
        className="absolute inset-0 block bg-fill-hover"
        aria-label={`Open ${artifact.label}`}
      />
      {/* Direction glyph, top-left translucent chip. */}
      <span className="pointer-events-none absolute left-[5px] top-[5px] grid h-4 w-4 place-items-center rounded-xs bg-raised/80">
        <DirectionGlyph origin={artifact.origin} />
      </span>
      {/* Bottom gradient scrim + hover actions, bottom-right at 26px. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/40 to-transparent px-2 py-2 opacity-0 transition-opacity group-hover:opacity-100">
        <RowActions
          onAttach={onAttach}
          onDownload={onDownload}
          onJump={onJump}
          canJump={!!artifact.messageId}
        />
      </div>
    </div>
  );
}

// ===== Tab 3 — Files =======================================================

function fileGlyphTone(mime: string | null): string {
  if (!mime) return "text-text-muted";
  if (mime === "application/pdf") return "text-danger";
  if (mime.startsWith("text/") || mime.includes("csv")) return "text-ok";
  return "text-accent";
}

function FileRow({
  artifact,
  now,
  onOpen,
  onAttach,
  onDownload,
  onJump,
}: {
  artifact: Artifact;
  now: number;
  onOpen: (el: HTMLElement) => void;
  onAttach: () => void;
  onDownload: () => void;
  onJump: () => void;
}) {
  const size = artifact.size;
  // Outbox files carry a TTL and are swept (not deleted) on download, so they
  // render a live/soon/expired pill just like hosted pages.
  const expiry =
    artifact.expiresAt != null ? pageState(artifact.expiresAt, now) : null;
  return (
    <div className="group flex items-center gap-[9px] rounded-sm px-2 py-[7px] hover:bg-fill-hover">
      <button
        type="button"
        onClick={(e) => onOpen(e.currentTarget)}
        className="grid h-[30px] w-[30px] flex-none place-items-center rounded-sm border border-border-subtle bg-inset"
        aria-label="Open file"
      >
        <FileText className={`h-3.5 w-3.5 ${fileGlyphTone(artifact.mime)}`} style={{ strokeWidth: 1.7 }} />
      </button>
      <button type="button" onClick={(e) => onOpen(e.currentTarget)} className="min-w-0 flex-1 text-left">
        <div className="truncate font-mono text-meta text-text">{artifact.label}</div>
        <div className="mt-px flex items-center gap-[5px] text-micro text-text-quiet">
          <DirectionGlyph origin={artifact.origin} />
          <span>
            {size != null && formatBytes(size)}
            {size != null && artifact.origin === "user" && " · "}
            {artifact.origin === "user" && "you sent this"}
          </span>
          {/* Outbox files carry a TTL and are swept (not deleted) on download,
              so they render a live/soon/expired pill just like hosted pages. */}
          {expiry && artifact.expiresAt != null && (
            <ExpiryPill
              state={expiry}
              label={expiry === "expired" ? "expired" : expiryLabel(artifact.expiresAt, now)}
            />
          )}
        </div>
      </button>
      <div className="flex flex-none gap-px opacity-0 transition-opacity group-hover:opacity-100">
        <RowActions
          onAttach={onAttach}
          onDownload={onDownload}
          onJump={onJump}
          canJump={!!artifact.messageId}
        />
      </div>
    </div>
  );
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
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);
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

  // Page registry + outbox mailbox: fetch both on open + 30s poll while open
  // only. Timer cleared on close and on session change (mirrors
  // useSessionResources).
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
      try {
        const entries = await window.api.outboxList(sessionId ?? "");
        if (!cancelled) setOutbox(entries ?? []);
      } catch {
        /* best-effort outbox refresh */
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

  const now = useMemo(() => Date.now(), []);
  const artifacts = useMemo(
    () => deriveArtifacts(messages, pages, sessionId ?? "", outbox),
    [messages, pages, outbox, sessionId],
  );
  const counts = useMemo(() => countByKind(artifacts), [artifacts]);
  const tabArtifacts = useMemo(
    () => artifacts.filter((a) => a.kind === tab),
    [artifacts, tab],
  );
  // The arrow-key paging set: the current tab's artifacts with a resolvable
  // preview renderer, in display order. Refuse-type rows never open the
  // overlay — for them we download instead.
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
  const groups = useMemo(() => groupByDay(filtered, now), [filtered, now]);

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

  // Row-body "open". Previewables (image/PDF/text) open the BET-661 overlay;
  // links open externally (no in-app web renderer); everything else downloads.
  const openRow = (a: Artifact, el: HTMLElement) => {
    if (a.kind === "link") {
      void window.api.openExternal(a.href);
      return;
    }
    const pi = previewable.findIndex((p) => p.id === a.id);
    if (pi >= 0) openPreview(pi, el);
    else void downloadArtifact(a);
  };

  // Jump the transcript to the message that owns an artifact.
  const jumpToMessage = (a: Artifact) => {
    if (!a.messageId) return;
    window.dispatchEvent(
      new CustomEvent("manta-scroll-to-message", {
        detail: { sessionId, messageId: a.messageId },
      }),
    );
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

        {/* Header: title + actions, then the tab bar. Compact and borderless to
            match the design's `.phead`/`.ptop` rhythm (sp-3 top, sp-3 gap to
            the tabs) — not a 44px titlebar with a divider. */}
        <div className="shrink-0 px-3 pt-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="min-w-0 truncate text-label font-semibold text-text">
              Artifacts
            </span>
            <div className="flex items-center gap-px">
              <IconButton
                icon={<Search />}
                label={searchOpen ? "Hide search" : "Search artifacts"}
                title={searchOpen ? "Hide search" : "Search"}
                onClick={() => setSearchOpen((v) => !v)}
              />
              <IconButton icon={<X />} label="Close artifacts panel" title="Close" onClick={onClose} />
            </div>
          </div>

          {searchOpen && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search links, images, files…"
              className="mb-3 w-full bg-bg border border-border px-2 py-1 text-meta rounded-xs focus:outline-none placeholder:text-text-faint"
            />
          )}

          {/* Tab bar: Links / Images / Files with counts, Links always the
              default. Segmented control per the design `.mk-tabs`. The 12px
              gap to the content below comes from the body's own top padding. */}
          <div
            className="flex gap-px p-px bg-inset border border-border-subtle rounded-md"
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
                  (active ? "bg-raised text-text shadow-sm" : "text-text-faint hover:text-text")
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
        </div>{/* close the px-3 pt-[11px] header wrapper */}

        {/* Body: day-grouped, sticky headers, newest first, one renderer per
            tab. */}
        <div className="flex-1 overflow-y-auto min-h-0">          {groups.length === 0 ? (
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
          ) : (
            groups.map((g) => (
              <div key={g.label}>
                <div className="sticky top-0 bg-bg-elev px-3 pt-3 pb-[7px] text-micro font-semibold text-text-faint">
                  {g.label}
                </div>
                {tab === "link" ? (
                  <div className="px-3 pb-3">
                    {g.items.map((a) => (
                      <LinkCard
                        key={a.id}
                        artifact={a}
                        now={now}
                        onOpen={(el) => openRow(a, el)}
                        onJump={() => jumpToMessage(a)}
                      />
                    ))}
                  </div>
                ) : (
                  // Image tiles and file rows take the same props, so they
                  // share one render path (the container class differs).
                  <div className={tab === "image" ? "grid grid-cols-2 gap-1 px-3 pb-3" : "px-2 pb-3"}>
                    {g.items.map((a) => {
                      const Row = tab === "image" ? ImageTile : FileRow;
                      return (
                        <Row
                          key={a.id}
                          artifact={a}
                          now={now}
                          onOpen={(el) => openRow(a, el)}
                          onAttach={() => void attachArtifact(a, sessionId ?? "")}
                          onDownload={() => void downloadArtifact(a)}
                          onJump={() => jumpToMessage(a)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            ))
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
