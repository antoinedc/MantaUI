// SearchPalette.tsx — ⌘F conversation search on the shared PaletteShell.
//
// Data flow (BET-698): the palette is a DUMB RENDERER of a single server-side
// query. On query change (120ms debounced) it sends ONE
// `window.api.opencodeSearchMessages({ query, sessionIds })` — the server
// searches opencode's own SQLite over ALL of the chat windows' full history —
// and renders whatever comes back. The old client-side "download N transcripts
// over HTTP and scan them" fan-out (which capped at 5 sessions/keystroke) is
// gone, and the active conversation is searched by the same call (fixing the
// old tail-only gap). The renderer holds no search logic.
//
// Jump semantics:
//   - same session → dispatch the existing `manta-scroll-to-message`
//     CustomEvent (ChatPanel scrolls + flashes, BET-660 listener).
//   - other session → set window.__mantaPendingMessageScroll, then activate
//     that window; ChatPanel consumes the pending target once the transcript
//     has rendered (its [messages] effect).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PaletteShell, useSelectedIntoView } from "./PaletteShell";
import { flatSessions, resolveSessionOwner } from "./store";
import type { Project, TranscriptHit } from "../shared/types";
import {
  formatAge,
  type PendingScrollWin,
} from "./chatUtils";

const MIN_QUERY_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 120;

type Section = {
  sessionId: string;
  hits: TranscriptHit[];
};

type FlatRow = { sessionId: string; hit: TranscriptHit };

// Group a flat, server-ordered hit list by sessionId in first-appearance order
// (the server already returns primary-first, then sessions in sidebar order,
// so the group order follows). The group whose id equals the active session is
// the "This conversation" section; the rest render under "other conversations".
function groupHits(hits: TranscriptHit[]): Section[] {
  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.sessionId)) continue;
    seen.add(h.sessionId);
    sections.push({
      sessionId: h.sessionId,
      hits: hits.filter((x) => x.sessionId === h.sessionId),
    });
  }
  return sections;
}

export function SearchPalette({
  sessionId,
  projects,
  onJumpToWindow,
  onClose,
}: {
  sessionId: string;
  projects: Project[];
  onJumpToWindow: (tmuxSession: string, windowIndex: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const q = query.trim();
  const active = q.length >= MIN_QUERY_CHARS;

  // Search scope: the active session first, then every OTHER chat-mode window
  // with an opencodeSessionId, in sidebar order, de-duplicated. No cap.
  const sessionIds = useMemo(() => {
    const seen = new Set<string>([sessionId]);
    const ids = [sessionId];
    for (const f of flatSessions(projects)) {
      const sid = f.window.opencodeSessionId;
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        ids.push(sid);
      }
    }
    return ids;
  }, [projects, sessionId]);

  // workspace › session label lookup per sessionId (for section headers).
  const ownerBySession = useMemo(() => {
    const m = new Map<string, { tmuxSession: string; name: string }>();
    for (const f of flatSessions(projects)) {
      const sid = f.window.opencodeSessionId;
      if (sid) m.set(sid, { tmuxSession: f.project.tmuxSession, name: f.window.name });
    }
    return m;
  }, [projects]);

  const [groups, setGroups] = useState<Section[]>([]);
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(true);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    if (!active) {
      setGroups([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.api.opencodeSearchMessages({ query: q, sessionIds });
        if (seqRef.current !== seq) return; // stale — a newer query superseded us
        setSupported(res.supported);
        setGroups(res.supported ? groupHits(res.hits) : []);
      } catch {
        // A transport failure surfaces as no results rather than a new error UI.
        if (seqRef.current !== seq) return;
        setGroups([]);
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, q, sessionIds]);

  // Flat row list = keyboard-navigation order across all groups as rendered.
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const g of groups) for (const hit of g.hits) rows.push({ sessionId: g.sessionId, hit });
    return rows;
  }, [groups]);

  useEffect(() => {
    if (sel >= flatRows.length) setSel(0);
  }, [flatRows.length, sel]);

  const jump = (row: FlatRow) => {
    if (row.sessionId === sessionId) {
      window.dispatchEvent(
        new CustomEvent("manta-scroll-to-message", {
          detail: { sessionId, messageId: row.hit.messageId, query: q },
        }),
      );
      return;
    }
    const owner = resolveSessionOwner(projects, row.sessionId);
    if (!owner) return;
    (window as PendingScrollWin).__mantaPendingMessageScroll = {
      sessionId: row.sessionId,
      messageId: row.hit.messageId,
      query: q,
    };
    onJumpToWindow(owner.tmuxSession, owner.windowIndex);
  };

  const currentGroup = groups.find((g) => g.sessionId === sessionId);
  const otherGroups = groups.filter((g) => g.sessionId !== sessionId);
  const total = flatRows.length;
  const convCount = groups.length;

  return (
    <PaletteShell
      label="Search conversations"
      placeholder="Search in conversations…"
      query={query}
      setQuery={(v) => {
        setQuery(v);
        setSel(0);
      }}
      itemCount={flatRows.length}
      sel={sel}
      setSel={setSel}
      onPick={(i) => {
        const row = flatRows[i];
        if (row) jump(row);
      }}
      onClose={onClose}
      footerExtra={
        total > 0
          ? `${total} result${total === 1 ? "" : "s"} · ${convCount} conversation${convCount === 1 ? "" : "s"}`
          : undefined
      }
    >
      {(pick) => {
        if (!active) {
          return (
            <div className="px-3 py-3 text-label text-text-faint">
              Search this conversation — and all others. Type at least 2
              characters.
            </div>
          );
        }
        if (!supported) {
          return (
            <div className="px-3 py-3 text-label text-text-faint">
              Search needs a newer server runtime — update the server.
            </div>
          );
        }
        const nodes: ReactNode[] = [];
        let idx = 0;
        if (currentGroup && currentGroup.hits.length > 0) {
          nodes.push(
            <SectionHeader
              key="cur-head"
              session="This conversation"
              count={`${currentGroup.hits.length} match${currentGroup.hits.length === 1 ? "" : "es"}`}
            />,
          );
          for (const hit of currentGroup.hits) {
            const i = idx++;
            nodes.push(
              <HitRow
                key={`cur-${hit.messageId}`}
                hit={hit}
                selected={i === sel}
                onEnter={() => setSel(i)}
                onClick={() => pick(i)}
              />,
            );
          }
        }
        if (otherGroups.length > 0 || loading) {
          nodes.push(
            <div
              key="other-div"
              className="flex items-center gap-3 px-3 pt-3 pb-1 text-meta text-text-faint"
            >
              <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
              other conversations
              <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
            </div>,
          );
        }
        for (const g of otherGroups) {
          const owner = ownerBySession.get(g.sessionId);
          nodes.push(
            <SectionHeader
              key={`head-${g.sessionId}`}
              workspace={owner?.tmuxSession}
              session={owner?.name ?? g.sessionId}
              count={String(g.hits.length)}
            />,
          );
          for (const hit of g.hits) {
            const i = idx++;
            nodes.push(
              <HitRow
                key={`${g.sessionId}-${hit.messageId}`}
                hit={hit}
                selected={i === sel}
                onEnter={() => setSel(i)}
                onClick={() => pick(i)}
              />,
            );
          }
        }
        if (loading) {
          nodes.push(
            <div key="other-loading" className="px-3 py-2 text-meta text-text-faint">
              Searching other conversations…
            </div>,
          );
        }
        if (nodes.length === 0) {
          nodes.push(
            <div key="none" className="px-3 py-3 text-label text-text-faint">
              No matches for “{q}”
            </div>,
          );
        }
        return <>{nodes}</>;
      }}
    </PaletteShell>
  );
}

// "This conversation" / "workspace › session" section header with a
// right-aligned count — the breadcrumb pattern from the approved mockup.
function SectionHeader({
  workspace,
  session,
  count,
}: {
  workspace?: string;
  session: string;
  count: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1 text-meta text-text-faint">
      <span className="flex items-center gap-2 min-w-0 truncate">
        {workspace != null && (
          <>
            <span>{workspace}</span>
            <span aria-hidden="true">›</span>
          </>
        )}
        <span className="font-medium text-text-muted truncate">{session}</span>
      </span>
      <span className="ml-auto font-mono shrink-0">{count}</span>
    </div>
  );
}

function HitRow({
  hit,
  selected,
  onEnter,
  onClick,
}: {
  hit: TranscriptHit;
  selected: boolean;
  onEnter: () => void;
  onClick: () => void;
}) {
  const ref = useSelectedIntoView<HTMLButtonElement>(selected);
  return (
    <button
      ref={ref}
      onMouseEnter={onEnter}
      onClick={onClick}
      className={`w-full flex items-start gap-3 px-3 py-3 rounded-md text-left border-l-2 ${
        selected ? "bg-bg-soft border-l-accent" : "border-l-transparent hover:bg-bg-soft"
      }`}
    >
      <span
        className={`w-6 h-6 rounded-sm bg-raised flex items-center justify-center text-meta shrink-0 ${
          hit.role === "user" ? "text-accent-tx" : "text-text-faint"
        }`}
        aria-hidden="true"
      >
        {hit.role === "user" ? "›" : "✳"}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-label text-text-muted line-clamp-2">
          {hit.pre}
          <mark className="bg-accent/20 text-accent-tx rounded-xs px-px font-medium">
            {hit.match}
          </mark>
          {hit.post}
        </span>
        <span className="block text-meta text-text-faint mt-1">
          {hit.role === "user" ? "you" : "assistant"}
        </span>
      </span>
      {hit.timeCreated != null && (
        <span className="text-meta font-mono text-text-faint shrink-0">
          {formatAge(Date.now() - hit.timeCreated)}
        </span>
      )}
    </button>
  );
}
