// BET-792 — the review pane (READ HALF).
//
// Fetches a session's linked-PR diff (`window.api.forgeDiff({ cwd })`), renders
// it with the comment gutter via the SAME `UnifiedDiff` the tool output uses,
// and shows incoming forge threads + your own drafts as inline notes IN the
// diff (never a sidebar, never a popover — faithfulness check 1).
//
// The write half is a separate issue, so the only destination a draft note has
// here is "Send to agent", which appends the note's text to the main composer
// via the `manta-forge-comment` window event (ChatPanel fills its input; it
// does not send). "Add to review" / comment POST / resolve arrive with the
// write half.
//
// Anchor shape is forge-neutral `{ line, side, startLine }` (spec §3.4③); the
// adapter's three-SHA GitLab position object is its problem, not ours.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ForgeThread } from "../shared/types";
import type { CommentableLine } from "./chatUtils";
import { Pill } from "./Pill";
import { Chip } from "./Chip";
import { UnifiedDiff, type UnifiedDiffGutter, type UnifiedDiffNote } from "./ToolBodies";

// ---- Draft comment (this issue's only forge-write-adjacent object) ---------

type DraftComment = {
  key: string;
  anchor: CommentableLine;
  body: string;
  sentToAgent: boolean;
};

// Map a GitHub thread anchor onto the forge-neutral `{ line, side }` the diff
// gutters use. GitHub "RIGHT" → the new side, "LEFT" → the old side.
function threadAnchor(t: ForgeThread): CommentableLine | null {
  if (t.line == null) return null;
  return { line: t.line, side: t.side === "LEFT" ? "old" : "new" };
}

// Derive the pane's file header from the diff text: the first touched path and
// the total +/− counts. The minus glyph is U+2212 (−), per the mockup.
function diffHeader(diff: string): { label: string; plus: number; minus: number } {
  let label = "";
  let plus = 0;
  let minus = 0;
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m && !label) label = m[1].trim();
    if (line.startsWith("+") && !line.startsWith("+++")) plus++;
    else if (line.startsWith("-") && !line.startsWith("---")) minus++;
  }
  return { label: label || "review", plus, minus };
}

// The inline note-inline block (a colleague's thread or your draft) that sits
// between diff lines, styled per the spec's `.note-inline`: 2px accent left
// border, accent-bg surface, indented past the gutter, max 62ch. The
// attribution line (§4.5②) is emphasised; the status line is mono `--tx4`.
function NoteInline({
  attribution,
  body,
  action,
  status,
}: {
  attribution: ReactNode;
  body: ReactNode;
  action?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className="ml-[26px] my-[6px] max-w-[62ch] rounded-r-sm border-l-2 border-accent bg-accent-bg px-[11px] py-2 text-[12.5px] leading-[1.55] text-text-muted">
      <div className="font-semibold text-text">{attribution}</div>
      <div className="mt-px whitespace-pre-wrap break-words">{body}</div>
      {action && (
        <div className="mt-2 flex items-center gap-[6px]">{action}</div>
      )}
      {status && (
        <div className="mt-[6px] font-mono text-[11.5px] text-text-quiet">{status}</div>
      )}
    </div>
  );
}

export function ReviewPane({
  sessionId,
  cwd,
}: {
  sessionId: string;
  cwd: string;
}) {
  const [diff, setDiff] = useState<string>("");
  const [threads, setThreads] = useState<ForgeThread[]>([]);
  const [error, setError] = useState<"no_forge" | "not_connected" | "no_pr" | null>(null);
  const [loading, setLoading] = useState(true);

  const [composing, setComposing] = useState<CommentableLine | null>(null);
  const [draftText, setDraftText] = useState<string>("");
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const draftIdRef = useRef(0);

  // Fetch the PR diff for the session's cwd. Re-runs when the cwd changes
  // (session switch). No interval — the read half refetches on reopen.
  useEffect(() => {
    if (!cwd) {
      setLoading(false);
      setError("no_forge");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setComposing(null);
    setDraftText("");
    setDrafts([]);
    window.api
      .forgeDiff({ cwd })
      .then((res) => {
        if (cancelled) return;
        setDiff(res.diff ?? "");
        setThreads(Array.isArray(res.threads) ? res.threads : []);
        setError(res.error ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("no_forge");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, sessionId]);

  const { label, plus, minus } = useMemo(() => diffHeader(diff), [diff]);

  const gutter = useMemo<UnifiedDiffGutter>(
    () => ({
      commentable: () => true,
      onCompose: (a) => {
        setComposing(a);
        setDraftText("");
      },
    }),
    [],
  );

  const submitDraft = useCallback(() => {
    if (!composing) return;
    const body = draftText.trim();
    if (!body) return;
    setDrafts((prev) => [
      ...prev,
      { key: `draft-${++draftIdRef.current}`, anchor: composing, body, sentToAgent: false },
    ]);
    setComposing(null);
    setDraftText("");
  }, [composing, draftText]);

  const sendDraftToAgent = useCallback(
    (key: string) => {
      const d = drafts.find((x) => x.key === key);
      if (!d) return;
      window.dispatchEvent(
        new CustomEvent("manta-forge-comment", {
          detail: { sessionId, text: d.body },
        }),
      );
      setDrafts((prev) =>
        prev.map((x) => (x.key === key ? { ...x, sentToAgent: true } : x)),
      );
    },
    [drafts, sessionId],
  );

  const notes = useMemo<UnifiedDiffNote[]>(() => {
    const out: UnifiedDiffNote[] = [];

    // Incoming forge threads — anchored to their line, or the file top when the
    // comment is file-level (no line).
    for (const t of threads) {
      out.push({
        key: `thread-${t.id}`,
        anchor: threadAnchor(t),
        node: (
          <NoteInline
            attribution={
              <>
                {t.comments[0]?.author || "reviewer"}
                {t.resolved ? " · resolved" : ""}
              </>
            }
            body={
              <div>
                {t.comments.map((c, i) => (
                  <div key={i} className={i > 0 ? "mt-2" : ""}>
                    {c.body}
                  </div>
                ))}
              </div>
            }
          />
        ),
      });
    }

    // Your own drafts — the same surface, "You · draft", with the one
    // destination this issue wires ("Send to agent").
    for (const d of drafts) {
      out.push({
        key: d.key,
        anchor: d.anchor,
        node: (
          <NoteInline
            attribution={<>You · draft</>}
            body={d.body}
            action={
              d.sentToAgent ? null : (
                <Chip on onClick={() => sendDraftToAgent(d.key)}>
                  Send to agent
                </Chip>
              )
            }
            status={
              d.sentToAgent ? <>&#8627; attached to composer · not yet published</> : undefined
            }
          />
        ),
      });
    }

    // The inline composer opened by the gutter `+`, anchored at its line.
    if (composing) {
      out.push({
        key: "composer",
        anchor: composing,
        node: (
          <div className="ml-[26px] my-[6px] rounded-r-sm border-l-2 border-accent bg-inset px-[11px] py-2">
            <textarea
              autoFocus
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitDraft();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setComposing(null);
                  setDraftText("");
                }
              }}
              placeholder="Comment on this line…"
              rows={2}
              className="w-full resize-none rounded-xs border border-border-strong bg-bg px-2 py-1 font-mono text-[12.5px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            />
            <div className="mt-2 flex items-center gap-[6px]">
              <button
                type="button"
                onClick={submitDraft}
                className="rounded-sm bg-accent-solid px-2 py-1 text-[12px] font-medium text-on-accent hover:opacity-90"
              >
                Add note
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposing(null);
                  setDraftText("");
                }}
                className="rounded-sm px-2 py-1 text-[12px] text-text-muted hover:bg-fill-hover hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        ),
      });
    }

    return out;
  }, [threads, drafts, composing, draftText, submitDraft, sendDraftToAgent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* File header — the mockup's real `.mhead`: path + the +/− pill. */}
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <span className="min-w-0 truncate font-mono text-[11.5px] font-semibold text-text-muted">
          {label}
        </span>
        {!loading && !error && diff !== "" && (
          <Pill tone="neutral" size="label" border={false}>
            {`+${plus} −${minus}`}
          </Pill>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-6 text-meta text-text-faint">Loading diff…</div>
        ) : error ? (
          <div className="px-3 py-6 text-meta text-text-faint">
            {error === "no_pr"
              ? "No pull request on this session's branch."
              : error === "not_connected"
                ? "No forge connection to this repository."
                : "No linked forge repository."}
          </div>
        ) : diff === "" ? (
          <div className="px-3 py-6 text-meta text-text-faint">No diff.</div>
        ) : (
          <div className="py-2">
            <UnifiedDiff
              text={diff}
              bare
              showHunks
              gutter={gutter}
              notes={notes}
            />
          </div>
        )}
      </div>
    </div>
  );
}
