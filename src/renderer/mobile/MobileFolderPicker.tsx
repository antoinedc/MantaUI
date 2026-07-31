// MobileFolderPicker.tsx — full-height folder picker sheet for mobile (BET-417 §B).
//
// Mobile gets the folder picker as a full-height sheet. Reuses the same pure
// helpers (breadcrumbs / parentPath / isDimmedDir / gitStateLabel) as the
// desktop FolderPickerModal — no duplicate logic.
//
// Does NOT redesign other mobile screens (per the issue's Do NOT list).

import { useEffect, useRef, useState } from "react";
import { X, ChevronRight, Folder as FolderIcon, ArrowUp } from "lucide-react";
import {
  breadcrumbs,
  crumbLabel,
  isDimmedDir,
  parentPath,
} from "../folderPicker";

type Props = {
  initialPath: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
};

type Row = { name: string; full: string; dimmed: boolean };

export function MobileFolderPicker({ initialPath, onSelect, onCancel }: Props) {
  const [path, setPath] = useState(initialPath);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  // Path completion (same logic as desktop, tappable on touch).
  const refreshSuggestion = (value: string) => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!value) {
      setSuggestion(null);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const matches = (await window.api.fsListDirs(value)).filter((m) =>
          m.startsWith(value),
        );
        if (matches.length === 1 && matches[0] === value) {
          setSuggestion(null);
          return;
        }
        setSuggestion(matches.length > 0 ? matches[0] : null);
      } catch {
        setSuggestion(null);
      }
    }, 80);
  };

  const onPathChange = (value: string) => {
    setPath(value);
    refreshSuggestion(value);
  };

  const listDir = async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const matches = await window.api.fsListDirs(dir);
      const filtered = matches.filter((m) => m.startsWith(dir));
      const built: Row[] = filtered.map((full) => {
        const name = full.split("/").filter(Boolean).pop() ?? full;
        return { name, full, dimmed: isDimmedDir(name) };
      });
      setRows(built);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const dir = path.endsWith("/") ? path : parentPath(path);
    void listDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const descend = (full: string) => {
    const next = full.endsWith("/") ? full : full + "/";
    setPath(next);
  };

  const goUp = () => {
    setPath(parentPath(path));
  };

  const crumbs = breadcrumbs(path);

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <div className="flex-1 flex items-center gap-2 px-1">
          <button
            onClick={onCancel}
            className="mobile-tap text-text-muted leading-none inline-flex items-center"
            aria-label="Back"
          >
            <X size={20} aria-hidden="true" />
          </button>
          <span className="text-text font-semibold text-body">Choose folder</span>
        </div>
        <button
          onClick={() => onSelect(path.endsWith("/") ? path.slice(0, -1) : path)}
          className="mobile-tap px-3 py-1 bg-accent-solid text-on-accent rounded font-semibold text-meta"
        >
          Select
        </button>
      </div>

      {/* Path field */}
      <div className="px-4 py-2 border-b border-border">
        <input
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void listDir(path.endsWith("/") ? path : parentPath(path));
            }
          }}
          spellCheck={false}
          autoComplete="off"
          className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded font-mono focus:outline-none focus:border-accent"
        />
        {suggestion && suggestion.startsWith(path) && suggestion !== path && (
          <button
            onClick={() => {
              setPath(suggestion);
              refreshSuggestion(suggestion);
            }}
            className="w-full text-left px-3 py-2 text-meta text-text-muted font-mono truncate hover:bg-bg-elev"
          >
            {suggestion}
          </button>
        )}
        {/* Breadcrumbs */}
        <div className="flex items-center flex-wrap gap-px mt-2 text-label">
          <button
            onClick={goUp}
            className="inline-flex items-center gap-1 text-text-faint hover:text-text px-1 py-px"
          >
            <ArrowUp size={12} aria-hidden="true" />
          </button>
          {crumbs.map((c, i) => (
            <span key={c} className="inline-flex items-center">
              {i > 0 && (
                <ChevronRight size={12} className="text-text-quiet" aria-hidden="true" />
              )}
              <button
                onClick={() => setPath(c)}
                className={
                  "px-1 py-px font-mono " +
                  (c === path ? "text-text" : "text-text-faint")
                }
              >
                {crumbLabel(c)}
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Folder list */}
      <div className="manta-scroll-y flex-1 overflow-auto">
        {loading && (
          <div className="px-4 py-4 text-meta text-text-faint">Loading…</div>
        )}
        {error && (
          <div className="px-4 py-4 text-meta text-danger">{error}</div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div className="px-4 py-4 text-meta text-text-faint">No subfolders</div>
        )}
        {!loading && !error && rows.map((r) => (
          <button
            key={r.full}
            onClick={() => descend(r.full)}
            className={
              "mobile-row w-full text-left " +
              (r.dimmed ? "opacity-60" : "")
            }
            title={r.full}
          >
            <FolderIcon size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
            <span className="flex-1 min-w-0 truncate font-mono text-body">{r.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
