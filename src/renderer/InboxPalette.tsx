// InboxPalette.tsx — the work inbox on the shared PaletteShell (BET-795).
//
// The one cross-repo surface in the app: issues assigned to you, PRs awaiting
// your review, and your own open PRs whose checks are red — served by ONE
// box-side read (window.api.forgeInbox()) built on three SEARCH queries. The
// renderer holds no forge logic; it renders rows and routes the row actions
// through the EXISTING session-creation path.
//
// Rows are the shared ListRow (leading dot · title · reason · repo · age).
// The three row actions sit UNDER the list exactly as the mockup lays them
// out: `↵ Start a session` (the Enter-key default), `Open review`, and
// `Delegate in background` — all operating on the currently selected row.
//
// "Start a session" reuses the ONE creation path (tmuxNewSession + the
// worktree/project naming helpers from src/shared/projectName.mjs): it resolves the item's repo
// to a local path on the box, adds a worktree, creates the session, lands in
// it, and SEEDS the composer with the box-provided prompt WITHOUT submitting
// (the user reviews + hits Enter). "Delegate in background" runs the same
// path but auto-submits (the agent starts working immediately).

import { useEffect, useMemo, useState } from "react";
import { CornerDownLeft, X } from "lucide-react";
import { PaletteShell } from "./PaletteShell";
import { ListRow } from "./ListRow";
import { StatusDot } from "./StatusDot";
import { Chip } from "./Chip";
import { Button } from "./Button";
import { Pill } from "./Pill";
import { ReviewPane } from "./ReviewPane";
import { useStore } from "./store";
import { formatAge } from "./chatUtils";
import { UPDATE_BOX_NOTE_TEXT } from "./components/UpdateBoxNote";
import { useBoxCapability } from "./hooks/useBoxCapabilities";
import type { ForgeInboxItem } from "../shared/types";

// The box's semantic row tone mapped onto StatusDot's vocabulary — presentation
// only: danger → error, warn → warn, muted / unknown → idle. (Which tone a row
// has, its label, identifier, secondary line, branch name and local checkout
// are all the box's: `forge:inbox` row fields, WS05 G13.)
function inboxDotTone(tone: ForgeInboxItem["tone"]): Parameters<typeof StatusDot>[0]["tone"] {
  switch (tone) {
    case "danger":
      return "error";
    case "warn":
      return "warn";
    default:
      return "idle";
  }
}

// The short repo name for messages; the box sends it, a row without it (older
// box) is not rendered at all (see `outdated`).
function repoNameOf(item: ForgeInboxItem): string {
  return item.repoName ?? item.repoKey.split("/").pop() ?? item.repoKey;
}

export function InboxPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const applyProjects = useStore((s) => s.applyProjects);
  const activateWindow = useStore((s) => s.activateWindow);
  const setActive = useStore((s) => s.setActive);
  const setSeedPrompt = useStore((s) => s.setSeedPrompt);

  const [items, setItems] = useState<ForgeInboxItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // BET-850: the inbox PR currently open in the in-app review pane (null =
  // no review open, showing the inbox list). Addressed by { repoKey, number }
  // — a cross-repo PR the box may not have cloned — NOT the session's cwd.
  const [reviewItem, setReviewItem] = useState<ForgeInboxItem | null>(null);

  // One fetch on open — never polled while closed (§ Hygiene).
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    if (typeof window.api.forgeInbox === "function") {
      window.api
        .forgeInbox()
        .then((res) => {
          if (cancelled) return;
          setItems(res?.items ?? []);
          if (res?.error === "not_connected") setLoadError("GitHub isn't connected on this server.");
        })
        .catch(() => {
          if (cancelled) return;
          setLoadError("Couldn't load the inbox.");
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    } else {
      // Inbox not wired on this client (e.g. unpaired) — degrade gracefully.
      setLoadError("Inbox isn't available here yet.");
      setLoaded(true);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // The rows after query filtering, in display order (the box sorts and
  // de-duplicates them).
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q),
        )
      : items;
    return filtered;
  }, [items, query]);
  // An older box sends rows without the row fields — say so instead of drawing
  // half-empty rows.
  const rowFieldsCapability = useBoxCapability("forge-inbox-view-1");
  const namingCapability = useBoxCapability("sessions-naming-1");
  const outdated = loaded && (rowFieldsCapability === false || items.some((i) => i.label === undefined));

  useEffect(() => {
    if (sel >= rows.length) setSel(0);
  }, [rows.length, sel]);

  // Create a session from an inbox item, reusing the ONE creation path. The
  // prompt is seeded into the composer (setSeedPrompt) but NOT submitted —
  // the user reviews + hits Enter ("start a session").
  const createSessionFromItem = async (item: ForgeInboxItem) => {
    const path = item.localPath;
    if (!path) {
      setError(`No local checkout of ${repoNameOf(item)} on this server to start a session in.`);
      return;
    }
    if (namingCapability === false) {
      setError(UPDATE_BOX_NOTE_TEXT);
      return;
    }
    setError(null);
    try {
      const wt = await window.api.gitAddWorktree({ cwd: path, name: item.branchName ?? `manta/${item.kind}-${item.number}` });
      const dir = wt.path ?? path;
      // The box names the session from the repo folder and returns the final name (WS11 D5 / S1).
      const created = await window.api.tmuxNewSession({
        nameHint: path,
        cwd: dir,
        windowName: "default",
        chatMode: true,
        createDir: false,
        // BET-871: only ISSUE items carry the originating issue onto the
        // session's `@manta-forge-issue` stamp — a PR is not something a PR
        // closes. Omitted entirely (not null) so the box skips the stamp.
        ...(item.kind !== "pr" ? { forgeIssue: { repoKey: item.repoKey, number: item.number } } : {}),
      });
      applyProjects(Array.isArray(created) ? created : created.projects);
      const name = Array.isArray(created) ? null : created.name;
      if (!name) throw new Error("The box didn't report the new session's name.");
      const proj = useStore.getState().projects.find((p) => p.tmuxSession === name);
      const win = proj?.windows.find((w) => w.active) ?? proj?.windows[0];
      const sessionId =
        (Array.isArray(created) ? null : created.sessionId) ?? win?.opencodeSessionId ?? null;
      if (win) {
        try {
          await activateWindow(name, win.index);
        } catch {
          setActive(name, win.index);
        }
      } else {
        setActive(name, 0);
      }
      if (sessionId && item.seed) setSeedPrompt({ sid: sessionId, text: item.seed });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // "Delegate in background" — the same work as Start-a-session but routed
  // through the EXISTING delegate engine (spec §3): it creates its own
  // worktree + branch + nested rail row and runs the seeded prompt without the
  // user watching. The parent is the active chat session the job nests under.
  const delegateInBackground = async (item: ForgeInboxItem) => {
    const path = item.localPath;
    if (!path) {
      setError(`No local checkout of ${repoNameOf(item)} on this server to delegate in.`);
      return;
    }
    const active = useStore.getState().activeSession();
    const parentId = active
      ? (useStore
          .getState()
          .projects.find((p) => p.tmuxSession === active.projectName)
          ?.windows.find((w) => w.index === active.windowIndex)?.opencodeSessionId ?? null)
      : null;
    if (!parentId) {
      setError("Open a chat session first — a background job nests under its parent session.");
      return;
    }
    setError(null);
    try {
      const res = await window.api.delegateStart({
        prompt: item.seed,
        sessionID: parentId,
        directory: path,
      });
      if (!res?.ok) {
        setError(res?.error ?? "Couldn't start the background job.");
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startSession = (item: ForgeInboxItem) => void createSessionFromItem(item);
  // BET-850: "Open review" opens the in-app review pane (ReviewPane) for the
  // inbox PR — addressed explicitly by { repoKey, number }, so a cross-repo PR
  // from outside the session (possibly a repo the box has not cloned) renders
  // its diff + comment gutter + box-buffered draft review, not the browser.
  const openReview = (item: ForgeInboxItem) => {
    if (item.kind !== "pr") {
      setError("Open review is for pull requests.");
      return;
    }
    setError(null);
    setReviewItem(item);
  };

  const selected = rows[sel] ?? null;

  // The stable { repoKey, number } the review pane addresses. Memoized on the
  // item so the pane's fetch effect keyed on `target` does not re-run on every
  // InboxPalette re-render (the inline object would otherwise be new each time).
  const reviewTarget = useMemo(
    () => (reviewItem ? { repoKey: reviewItem.repoKey, number: reviewItem.number } : null),
    [reviewItem],
  );

  // The in-app review overlay that "Open review" mounts on top of the inbox.
  // A full-surface sheet (above the z-50 palette) hosting the shared
  // ReviewPane, addressed by the inbox PR's { repoKey, number }. No session —
  // "Send to agent" is hidden; the box-buffered draft review + comment gutter
  // still work against the cross-repo forge read.
  const reviewOverlay = reviewItem ? (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-bg"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setReviewItem(null);
        }
      }}
    >
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
        <span className="font-mono text-meta text-text-faint">{`!${reviewItem.number}`}</span>
        <span className="min-w-0 flex-1 truncate text-label font-semibold text-text">
          {reviewItem.title}
        </span>
        <button
          type="button"
          onClick={() => setReviewItem(null)}
          title="Back to inbox (Esc)"
          aria-label="Back to inbox"
          className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-2 py-1 text-meta text-text-faint hover:text-text"
        >
          <X size={13} aria-hidden="true" /> Back to inbox
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ReviewPane
          target={reviewTarget ?? undefined}
          prUrl={reviewItem.url}
          onOpenExternal={(url) => void window.api.openExternal(url)}
        />
      </div>
    </div>
  ) : null;

  return (
    <>
    <PaletteShell
      label="Inbox"
      placeholder="Filter inbox…"
      query={query}
      setQuery={(v) => {
        setQuery(v);
        setSel(0);
      }}
      itemCount={rows.length}
      sel={sel}
      setSel={setSel}
      onPick={(i) => {
        const item = rows[i];
        if (item) startSession(item);
      }}
      onClose={onClose}
      footerExtra={
        <span className="font-mono">
          ⌥↵ delegate
        </span>
      }
    >
      {(pick) => {
        void pick;
        // Header: Inbox + count pill (Pill tone="accent" — the mockup's .pill.info).
        const header = (
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <span className="text-label font-semibold text-text">Inbox</span>
            {loaded && items.length > 0 && (
              <Pill tone="accent">{String(items.length)}</Pill>
            )}
          </div>
        );

        if (!loaded) {
          return (
            <>
              {header}
              <div className="px-3 py-3 text-label text-text-faint">Loading inbox…</div>
            </>
          );
        }
        if (loadError) {
          return (
            <>
              {header}
              <div className="px-3 py-3 text-label text-text-faint">{loadError}</div>
            </>
          );
        }
        if (outdated) {
          return (
            <>
              {header}
              <div className="px-3 py-3 text-label text-text-faint">Update your box to use the inbox here.</div>
            </>
          );
        }
        if (rows.length === 0) {
          return (
            <>
              {header}
              <div className="px-3 py-3 text-label text-text-faint">
                {query.trim()
                  ? `No inbox matches “${query.trim()}”`
                  : "Nothing needs you right now."}
              </div>
            </>
          );
        }

        return (
          <>
            {header}
            {rows.map((item, i) => (
              <ListRow
                key={`${item.repoKey}#${item.number}`}
                leading={<StatusDot tone={inboxDotTone(item.tone)} />}
                name={
                  <span className="truncate">
                    <span className="text-text-faint">{item.identifier} </span>
                    {item.title}
                  </span>
                }
                secondary={<span className="truncate">{item.secondary}</span>}
                trailing={formatAge(Date.now() - item.updatedAt)}
                onClick={() => setSel(i)}
                title={item.url}
                className={i === sel ? "bg-fill-hover" : undefined}
              />
            ))}

            {/* Row actions — the mockup's chip row under the list. `↵ Start a
                session` is the Enter-key default (onPick above) and carries the
                accent-outlined Chip-on treatment; Enter actually does it. */}
            <div className="flex items-center gap-2 flex-wrap px-3 pt-2 pb-1">
              <Chip on onClick={() => selected && startSession(selected)} title="Create a worktree + session, seed the prompt (Enter)">
                <CornerDownLeft size={12} aria-hidden="true" /> Start a session
              </Chip>
              <Button tone="default" onClick={() => selected && openReview(selected)}>
                Open review
              </Button>
              <Button tone="default" onClick={() => selected && delegateInBackground(selected)}>
                Delegate in background
              </Button>
            </div>

            {error && <div className="px-3 pb-2 text-meta text-danger break-words">{error}</div>}
          </>
        );
      }}
    </PaletteShell>
    {reviewOverlay}
    </>
  );
}
