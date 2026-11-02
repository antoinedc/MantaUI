// ExplorerQuickOpen.tsx — ⌘P "Go to file…" for the Explorer (spec §Tree →
// Quick open, contract E14): the shared PaletteShell over the session folder,
// searched with the existing `opencodeFindFiles` (≤ 50 relative results).
// A failed search is shown in the palette (list + footer), never as "no matches".

import { useEffect, useRef, useState } from "react";
import { File } from "lucide-react";
import type { FsGitBadge } from "../../shared/fsTypes";
import { PaletteShell, useSelectedIntoView } from "../PaletteShell";
import type { ExplorerQuickOpenProps } from "./types";

const SEARCH_DEBOUNCE_MS = 120;

const BADGE_TONE: Record<FsGitBadge, string> = {
  M: "text-warn",
  A: "text-ok",
  "?": "text-text-faint",
  "!": "text-danger",
};

/** A find-files result as an absolute path under `dir`. */
export function toAbsolute(dir: string, result: string): string {
  if (result.startsWith("/")) return result;
  const base = dir.replace(/\/+$/, "");
  return `${base}/${result.replace(/^\.\//, "")}`;
}

/** Split a result into text before / inside / after the first match of `query`. */
export function splitMatch(path: string, query: string): { before: string; match: string; after: string } {
  const q = query.trim().toLowerCase();
  const at = q ? path.toLowerCase().indexOf(q) : -1;
  if (at < 0) return { before: path, match: "", after: "" };
  return { before: path.slice(0, at), match: path.slice(at, at + q.length), after: path.slice(at + q.length) };
}

export function ExplorerQuickOpen(props: ExplorerQuickOpenProps) {
  return props.open ? <QuickOpenBody {...props} /> : null;
}

function Row({
  path,
  query,
  badge,
  selected,
  onPick,
  onHover,
}: {
  path: string;
  query: string;
  badge?: FsGitBadge;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const ref = useSelectedIntoView<HTMLDivElement>(selected);
  const { before, match, after } = splitMatch(path, query);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      onClick={onPick}
      onMouseMove={onHover}
      className={`flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 font-mono text-label ${
        selected ? "bg-accent-bg text-text" : "text-text-muted"
      }`}
    >
      <File size={14} aria-hidden="true" className="shrink-0 text-text-faint" />
      <span className="min-w-0 truncate">
        {before}
        {match && <mark className="bg-transparent font-semibold text-accent-tx">{match}</mark>}
        {after}
      </span>
      {badge && <span className={`ml-auto font-mono text-micro font-semibold ${BADGE_TONE[badge]}`}>{badge}</span>}
    </div>
  );
}

function QuickOpenBody({ owner, onClose, onOpen }: ExplorerQuickOpenProps) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, FsGitBadge>>({});
  const seq = useRef(0);
  const q = query.trim();

  useEffect(() => {
    let cancelled = false;
    window.api
      .fsGitStatus({ root: owner.cwd })
      .then((res) => {
        if (!cancelled && res.ok) setChanges(res.changes);
      })
      .catch((e) => console.warn("[explorer] quick-open git status failed:", e));
    return () => {
      cancelled = true;
    };
  }, [owner.cwd]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await window.api.opencodeFindFiles({ query: q, directory: owner.cwd });
        if (seq.current !== mine) return; // a newer query superseded this one
        setResults(found);
        setError(null);
      } catch (e) {
        if (seq.current !== mine) return;
        console.warn("[explorer] quick-open search failed:", e);
        setResults([]);
        setError("Couldn’t search this folder — try again");
      } finally {
        if (seq.current === mine) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [q, owner.cwd]);

  useEffect(() => {
    if (sel >= results.length) setSel(0);
  }, [results.length, sel]);

  const open = (i: number): void | false => {
    const path = results[i];
    if (!path) return false;
    const isDir = path.endsWith("/");
    onOpen({ abs: toAbsolute(owner.cwd, path.replace(/\/+$/, "")), owner, kind: isDir ? "dir" : "file" });
  };

  return (
    <PaletteShell
      label="Go to file"
      placeholder="Go to file…"
      query={query}
      setQuery={(v) => {
        setQuery(v);
        setSel(0);
      }}
      itemCount={results.length}
      sel={sel}
      setSel={setSel}
      onPick={open}
      onClose={onClose}
      footerExtra={
        error ? (
          <span role="alert" className="text-danger">
            {error}
          </span>
        ) : results.length > 0 ? (
          `${results.length} result${results.length === 1 ? "" : "s"}`
        ) : undefined
      }
    >
      {(pick) => {
        const note = (text: string, tone = "text-text-faint") => (
          <div className={`px-3 py-3 text-label ${tone}`}>{text}</div>
        );
        if (error) return note(error, "text-danger");
        if (!q) return note("Type a file name to search this folder.");
        if (results.length === 0) return note(loading ? "Searching…" : `No files match “${q}”.`);
        return (
          <div className="manta-explorer-quickopen" role="listbox" aria-label="Files">
            {results.map((path, i) => {
              const rel = path.startsWith("/") ? path.slice(owner.cwd.replace(/\/+$/, "").length + 1) : path;
              return (
                <Row
                  key={path}
                  path={path}
                  query={q}
                  badge={changes[rel]}
                  selected={i === sel}
                  onPick={() => pick(i)}
                  onHover={() => i !== sel && setSel(i)}
                />
              );
            })}
          </div>
        );
      }}
    </PaletteShell>
  );
}
