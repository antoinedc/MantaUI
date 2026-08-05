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
  type ArtifactKind,
} from "./artifacts";
import { IconButton } from "./IconButton";

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

// Per-tab empty state: a short line plus the OTHER tabs' counts. This is why a
// default-Links tab is safe even when Links is empty.
function emptyMessage(kind: ArtifactKind, counts: { link: number; image: number; file: number }): string {
  if (kind === "link") return `No links yet — ${counts.image} images, ${counts.file} files`;
  if (kind === "image") return `No images yet — ${counts.link} links, ${counts.file} files`;
  return `No files yet — ${counts.link} links, ${counts.image} images`;
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
  // change so the panel follows the active chat pane cleanly.
  useEffect(() => {
    setTab("link");
    setSearchOpen(false);
    setQuery("");
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
  const filtered = useMemo(() => {
    if (!query) return tabArtifacts;
    const q = query.toLowerCase();
    return tabArtifacts.filter(
      (a) => a.label.toLowerCase().includes(q) || a.href.toLowerCase().includes(q),
    );
  }, [tabArtifacts, query]);
  const groups = useMemo(() => groupByDay(filtered, Date.now()), [filtered]);

  if (!open) return null;

  return (
    <aside
      className="relative shrink-0 border-l border-border bg-bg-elev flex flex-col min-w-0"
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

      {/* Tab bar: Links / Images / Files with counts. Links is always the
          default — a moving default destroys muscle memory. */}
      <div className="flex gap-1 px-2 py-2 border-b border-border shrink-0" role="tablist" aria-label="Artifact kind">
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
                "px-2 py-1 rounded-xs text-meta font-medium " +
                (active
                  ? "bg-bg-soft text-text"
                  : "text-text-muted hover:bg-fill-hover hover:text-text")
              }
            >
              {TAB_LABEL[k]}{" "}
              <span className="tabular-nums text-text-faint">{counts[k]}</span>
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
            {g.items.map((a) => (
              <div
                key={a.id}
                className="px-3 py-1.5 text-meta text-text-muted truncate"
                title={a.href}
              >
                {a.label}
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="px-3 py-4 text-meta text-text-faint">
            {query ? `No matches for “${query}”` : emptyMessage(tab, counts)}
          </div>
        )}
      </div>
    </aside>
  );
}
