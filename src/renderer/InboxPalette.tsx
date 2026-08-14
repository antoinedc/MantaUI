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
// worktree/project helpers from NewSessionScreen): it resolves the item's repo
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
import { formatAge, inboxReasonLabel, sortInbox } from "./chatUtils";
import { deriveProjectName, uniqueSessionName } from "./NewSessionScreen";
import type { ForgeInboxItem } from "../shared/types";

// The status-dot tone for each inbox reason — the mockup's deliberate mix:
// a red-checks PR is `bad`, a review request is `warn`, an assigned issue is
// `mute` (nothing is wrong, it is just waiting). Four tones, four meanings.
function dotTone(reason: ForgeInboxItem["reason"]): Parameters<typeof StatusDot>[0]["tone"] {
  switch (reason) {
    case "checks failing":
      return "error";
    case "review requested":
      return "warn";
    default:
      return "idle";
  }
}

// The inline identifier prefix — `#` for an issue, `!` for a PR (GitLab's MR
// sigil is preserved too, so a future GitLab MR shows `!88` not `#88`).
function identifier(item: ForgeInboxItem): string {
  return `${item.kind === "pr" ? "!" : "#"}${item.number}`;
}

// The short repo name (host/owner/repo → repo) for the row's source column.
function repoName(item: ForgeInboxItem): string {
  const parts = item.repoKey.split("/");
  return parts[parts.length - 1] ?? item.repoKey;
}

// The secondary column: `reason · repo` for a PR (the row shows its repo), and
// the bare reason phrase for an assigned issue (already "issue · assigned to
// you" — the mockup shows no repo on that row). GitHub/GitLab stay visually
// indistinguishable except for this text.
function secondary(item: ForgeInboxItem): string {
  const label = inboxReasonLabel(item.reason);
  return item.kind === "pr" ? `${label} · ${repoName(item)}` : label;
}

// A readable branch name from an inbox item — the worktree branch that a
// "Start a session" creates. Kept inside the component (display-slab concern),
// so pure sort/label logic stays in chatUtils where the required tests live.
function inboxBranchName(item: ForgeInboxItem): string {
  const slug = (item.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `manta/${item.kind}-${item.number}${slug ? `-${slug}` : ""}`;
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
  const [repos, setRepos] = useState<Record<string, string>>({}); // repoKey -> local path
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
    // Resolve repoKey → local path so "Start a session" can create a worktree
    // (the cached repo probe; box-side, 60s).
    (window.api.forgeProbe?.() ?? Promise.resolve({ repos: [] }))
      .then((probe) => {
        if (cancelled) return;
        const m: Record<string, string> = {};
        for (const r of probe?.repos ?? []) if (r.repoKey) m[r.repoKey] = r.path;
        setRepos(m);
      })
      .catch(() => { /* probe is optional — degrade to no-path rows */ });
    if (typeof window.api.forgeInbox === "function") {
      window.api
        .forgeInbox()
        .then((res) => {
          if (cancelled) return;
          setItems(sortInbox(res?.items ?? []));
          if (res?.error === "not_connected") setLoadError("GitHub isn't connected on this box.");
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

  // The rows after query filtering, in display order (already sorted server-side
  // AND by sortInbox — the renderer re-asserts the invariant it renders by).
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q),
        )
      : items;
    return sortInbox(filtered);
  }, [items, query]);

  useEffect(() => {
    if (sel >= rows.length) setSel(0);
  }, [rows.length, sel]);

  // Create a session from an inbox item, reusing the ONE creation path. The
  // prompt is seeded into the composer (setSeedPrompt) but NOT submitted —
  // the user reviews + hits Enter ("start a session").
  const createSessionFromItem = async (item: ForgeInboxItem) => {
    const path = repos[item.repoKey];
    if (!path) {
      setError(`No local checkout of ${repoName(item)} on this box to start a session in.`);
      return;
    }
    setError(null);
    const existing = useStore.getState().projects.map((p) => p.tmuxSession);
    const name = uniqueSessionName(deriveProjectName(path), new Set(existing));
    try {
      const wt = await window.api.gitAddWorktree({ cwd: path, name: inboxBranchName(item) });
      const dir = wt.path ?? path;
      const created = await window.api.tmuxNewSession({
        name,
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
    const path = repos[item.repoKey];
    if (!path) {
      setError(`No local checkout of ${repoName(item)} on this box to delegate in.`);
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
        <ReviewPane target={reviewTarget ?? undefined} />
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
                leading={<StatusDot tone={dotTone(item.reason)} />}
                name={
                  <span className="truncate">
                    <span className="text-text-faint">{identifier(item)} </span>
                    {item.title}
                  </span>
                }
                secondary={<span className="truncate">{secondary(item)}</span>}
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
