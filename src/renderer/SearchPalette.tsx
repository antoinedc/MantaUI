// SearchPalette.tsx — ⌘F conversation search on the shared PaletteShell.
//
// Data flow (BET-698, server-first D23/D24): the palette is a DUMB RENDERER of
// a single server-side query. On query change (120ms debounced) it sends ONE
// `window.api.opencodeSearchMessages({ query, scope:"all", primarySessionId })`
// — the BOX resolves which conversations are in scope, searches opencode's own
// SQLite over their full history, groups the hits and labels each group — and
// this file renders whatever comes back. It builds no scope, groups nothing and
// composes no titles; a failed search (`degraded`, or a transport error) is
// shown as a failure, never as "no matches".
//
// Jump semantics:
//   - same session → dispatch the existing `manta-scroll-to-message`
//     CustomEvent (ChatPanel scrolls + flashes, BET-660 listener).
//   - other session → set window.__mantaPendingMessageScroll, then activate
//     that window; ChatPanel consumes the pending target once the transcript
//     has rendered (its [messages] effect).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PaletteShell, useSelectedIntoView } from "./PaletteShell";
import { resolveSessionOwner } from "./store";
import type { Project, TranscriptHit, TranscriptHitGroup } from "../shared/types";
import {
  formatAge,
  type PendingScrollWin,
} from "./chatUtils";

const MIN_QUERY_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 120;

type FlatRow = { sessionId: string; hit: TranscriptHit };

export type SearchKind =
  | "idle"
  | "loading"
  | "results"
  | "empty"
  | "unsupported"
  | "boxTooOld"
  | "failed";

export type SearchReplyView = {
  kind: SearchKind;
  groups: TranscriptHitGroup[];
  truncated: boolean;
};

// The box's reply → what to render. A box that predates the grouped reply never
// sends `groups` (an empty answer still carries `[]`), which is the "box too
// old" signal — there is deliberately no fallback to the old client-side scope.
export function classifySearchReply(res: {
  supported: boolean;
  groups?: TranscriptHitGroup[];
  truncated?: boolean;
  degraded?: boolean;
}): SearchReplyView {
  const truncated = res.truncated === true;
  if (!res.supported) return { kind: "unsupported", groups: [], truncated };
  if (res.groups === undefined) return { kind: "boxTooOld", groups: [], truncated };
  if (res.degraded) return { kind: "failed", groups: [], truncated };
  if (res.groups.length === 0) return { kind: "empty", groups: [], truncated };
  return { kind: "results", groups: res.groups, truncated };
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
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);

  const q = query.trim();
  const active = q.length >= MIN_QUERY_CHARS;

  // null = nothing answered yet for the current query text.
  const [reply, setReply] = useState<SearchReplyView | null>(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    if (!active) {
      setReply(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.api.opencodeSearchMessages({
          query: q,
          scope: "all",
          primarySessionId: sessionId,
        });
        if (seqRef.current !== seq) return; // stale — a newer query superseded us
        setReply(classifySearchReply(res));
      } catch {
        if (seqRef.current !== seq) return;
        setReply({ kind: "failed", groups: [], truncated: false });
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, q, sessionId]);

  const groups = reply?.groups ?? [];
  const currentGroup = groups.find((g) => g.isCurrent);
  const otherGroups = groups.filter((g) => !g.isCurrent);

  // Flat row list = keyboard-navigation order across all groups as rendered
  // (the current conversation first, then the rest in the box's order).
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    const ordered = groups.filter((g) => g.isCurrent).concat(groups.filter((g) => !g.isCurrent));
    for (const g of ordered) for (const hit of g.hits) rows.push({ sessionId: g.sessionId, hit });
    return rows;
  }, [groups]);

  useEffect(() => {
    if (sel >= flatRows.length) setSel(0);
  }, [flatRows.length, sel]);

  // Returns false when the conversation has no window any more, so the shell
  // keeps the palette open and the notice below can be read.
  const jump = (row: FlatRow): void | false => {
    if (row.sessionId === sessionId) {
      window.dispatchEvent(
        new CustomEvent("manta-scroll-to-message", {
          detail: { sessionId, messageId: row.hit.messageId, query: q },
        }),
      );
      return;
    }
    const owner = resolveSessionOwner(projects, row.sessionId);
    if (!owner) {
      setJumpNotice("That conversation is no longer open.");
      return false;
    }
    (window as PendingScrollWin).__mantaPendingMessageScroll = {
      sessionId: row.sessionId,
      messageId: row.hit.messageId,
      query: q,
    };
    onJumpToWindow(owner.tmuxSession, owner.windowIndex);
  };

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
        setJumpNotice(null);
      }}
      itemCount={flatRows.length}
      sel={sel}
      setSel={setSel}
      onPick={(i) => {
        const row = flatRows[i];
        return row ? jump(row) : false;
      }}
      onClose={onClose}
      footerExtra={
        reply?.kind === "results" && total > 0
          ? `${total} result${total === 1 ? "" : "s"} · ${convCount} conversation${convCount === 1 ? "" : "s"}`
          : undefined
      }
    >
      {(pick) => {
        const notice = jumpNotice ? (
          <div key="jump-notice" role="status" className="px-3 py-2 text-label text-warn">
            {jumpNotice}
          </div>
        ) : null;
        const message = (text: string) => (
          <>
            {notice}
            <div className="px-3 py-3 text-label text-text-faint">{text}</div>
          </>
        );
        if (!active) {
          return message(
            "Search this conversation — and all others. Type at least 2 characters.",
          );
        }
        if (reply?.kind === "unsupported") {
          return message("Search needs a newer server runtime — update the server.");
        }
        if (reply?.kind === "boxTooOld") {
          return message("Search needs a newer box — update your box to use this.");
        }
        if (reply?.kind === "failed") {
          return message("Couldn't search — edit the query to try again.");
        }
        const nodes: ReactNode[] = [];
        let idx = 0;
        if (currentGroup) {
          nodes.push(
            <SectionHeader
              key="cur-head"
              title="This conversation"
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
        const searching = loading || reply === null;
        if (otherGroups.length > 0 || searching) {
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
          nodes.push(
            <SectionHeader
              key={`head-${g.sessionId}`}
              title={g.label}
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
        if (searching) {
          nodes.push(
            <div key="other-loading" className="px-3 py-2 text-meta text-text-faint">
              Searching other conversations…
            </div>,
          );
        }
        if (reply?.truncated) {
          nodes.push(
            <div key="truncated" className="px-3 py-2 text-meta text-text-faint">
              Showing the newest matches — this history is very large.
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
        return (
          <>
            {notice}
            {nodes}
          </>
        );
      }}
    </PaletteShell>
  );
}

// Section header with a right-aligned count — the breadcrumb pattern from the
// approved mockup. `title` is the box's label verbatim (or the fixed "This
// conversation"); nothing is composed here.
function SectionHeader({ title, count }: { title: string; count: string }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1 text-meta text-text-faint">
      <span className="font-medium text-text-muted min-w-0 truncate">{title}</span>
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
