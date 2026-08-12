// SearchPalette.tsx — ⌘F conversation search on the shared PaletteShell.
//
// Data flow:
//   - ACTIVE conversation: the live transcript already mirrored into the
//     store by ChatPanel (store.chatMessages, BET-659) — zero fetch, filtered
//     synchronously per keystroke.
//   - OTHER conversations: chat-mode windows from flatSessions(projects),
//     searched 150ms-debounced. Only the first MAX_LIVE_FETCHES candidates get
//     a live opencodeMessages fetch per keystroke; the rest are skipped (never
//     hammer opencode with a dozen full-transcript pulls per keystroke). A seq
//     guard discards stale async results.
//
// Jump semantics:
//   - same session → dispatch the existing `manta-scroll-to-message`
//     CustomEvent (ChatPanel scrolls + flashes, BET-660 listener).
//   - other session → set window.__mantaPendingMessageScroll, then activate
//     that window; ChatPanel consumes the pending target once the transcript
//     has rendered (its [messages] effect).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PaletteShell, useSelectedIntoView } from "./PaletteShell";
import { useStore, flatSessions, resolveSessionOwner } from "./store";
import type { Project } from "../shared/types";
import {
  formatAge,
  searchTranscript,
  type PendingScrollWin,
  type TranscriptHit,
} from "./chatUtils";
import type { OpencodeMessage } from "../shared/types";

const MIN_QUERY_CHARS = 2;
const CROSS_SEARCH_DEBOUNCE_MS = 150;
const MAX_OTHER_SESSIONS = 15; // chat windows scanned, sidebar order
const MAX_LIVE_FETCHES = 5; // candidates that get a live transcript fetch
const MAX_HITS_CURRENT = 50;
const MAX_HITS_PER_OTHER = 3;

type OtherSection = {
  sessionId: string;
  workspace: string; // project.tmuxSession
  session: string; // window.name
  hits: TranscriptHit[];
};

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
  const chatMessages = useStore((s) => s.chatMessages);
  const currentMessages = chatMessages[sessionId] ?? null;

  const q = query.trim();
  const active = q.length >= MIN_QUERY_CHARS;

  const currentHits = useMemo(
    () =>
      active && currentMessages
        ? searchTranscript(currentMessages, q, MAX_HITS_CURRENT)
        : [],
    [active, currentMessages, q],
  );

  const candidates = useMemo(
    () =>
      flatSessions(projects)
        .filter(
          (f) =>
            f.window.opencodeSessionId != null &&
            f.window.opencodeSessionId !== sessionId,
        )
        .slice(0, MAX_OTHER_SESSIONS),
    [projects, sessionId],
  );

  const [otherSections, setOtherSections] = useState<OtherSection[]>([]);
  const [otherLoading, setOtherLoading] = useState(false);
  const seqRef = useRef(0);
  useEffect(() => {
    const seq = ++seqRef.current;
    if (!active) {
      setOtherSections([]);
      setOtherLoading(false);
      return;
    }
    setOtherLoading(true);
    const timer = window.setTimeout(async () => {
      const found: OtherSection[] = [];
      await Promise.all(
        candidates.map(async (c, i) => {
          const sid = c.window.opencodeSessionId as string;
          if (i >= MAX_LIVE_FETCHES) return;
          let messages: OpencodeMessage[] | null = null;
          try {
            messages = await window.api.opencodeMessages(sid);
          } catch {
            messages = null;
          }
          if (!messages) return;
          const hits = searchTranscript(messages, q, MAX_HITS_PER_OTHER);
          if (hits.length > 0) {
            found.push({
              sessionId: sid,
              workspace: c.project.tmuxSession,
              session: c.window.name,
              hits,
            });
          }
        }),
      );
      if (seqRef.current !== seq) return; // stale — a newer query superseded us
      // Deterministic section order: sidebar (flatSessions) order.
      const rank = new Map(
        candidates.map((c, i) => [c.window.opencodeSessionId, i]),
      );
      found.sort(
        (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
      );
      setOtherSections(found);
      setOtherLoading(false);
    }, CROSS_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, q, candidates]);

  // Flat row list = keyboard-navigation order: current conversation's hits,
  // then each other-conversation section in render order.
  type FlatRow = { sessionId: string; hit: TranscriptHit };
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = currentHits.map((hit) => ({ sessionId, hit }));
    for (const s of otherSections)
      for (const hit of s.hits) rows.push({ sessionId: s.sessionId, hit });
    return rows;
  }, [currentHits, otherSections, sessionId]);

  useEffect(() => {
    if (sel >= flatRows.length) setSel(0);
  }, [flatRows.length, sel]);

  const jump = (row: FlatRow) => {
    if (row.sessionId === sessionId) {
      window.dispatchEvent(
        new CustomEvent("manta-scroll-to-message", {
          detail: { sessionId, messageId: row.hit.messageId },
        }),
      );
      return;
    }
    const owner = resolveSessionOwner(projects, row.sessionId);
    if (!owner) return;
    (window as PendingScrollWin).__mantaPendingMessageScroll = {
      sessionId: row.sessionId,
      messageId: row.hit.messageId,
    };
    onJumpToWindow(owner.tmuxSession, owner.windowIndex);
  };

  const total = flatRows.length;
  const convCount = (currentHits.length > 0 ? 1 : 0) + otherSections.length;

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
        const nodes: ReactNode[] = [];
        let idx = 0;
        if (currentHits.length > 0) {
          nodes.push(
            <SectionHeader
              key="cur-head"
              session="This conversation"
              count={`${currentHits.length} match${currentHits.length === 1 ? "" : "es"}`}
            />,
          );
          for (const hit of currentHits) {
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
        if (otherSections.length > 0 || otherLoading) {
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
        for (const s of otherSections) {
          nodes.push(
            <SectionHeader
              key={`head-${s.sessionId}`}
              workspace={s.workspace}
              session={s.session}
              count={String(s.hits.length)}
            />,
          );
          for (const hit of s.hits) {
            const i = idx++;
            nodes.push(
              <HitRow
                key={`${s.sessionId}-${hit.messageId}`}
                hit={hit}
                selected={i === sel}
                onEnter={() => setSel(i)}
                onClick={() => pick(i)}
              />,
            );
          }
        }
        if (otherLoading) {
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
