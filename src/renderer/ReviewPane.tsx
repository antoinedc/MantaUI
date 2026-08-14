// BET-793 — the review pane (WRITE half on top of BET-792's read half).
//
// BET-792 built the read half: fetch a session's linked-PR diff
// (`window.api.forgeDiff({ cwd })`), render it with the comment gutter via the
// SAME `UnifiedDiff` the tool output uses, and show incoming forge threads IN
// the diff. This issue adds the write half (spec §3.4①) — the box-buffered
// draft review.
//
// THE PORTABILITY DECISION. The box owns the draft. Comments accumulate in
// durable box state (`forge:draft-*` RPC channels → src/server/forge/draft.mjs)
// and "submit" flushes them in ONE review. GitHub's native pending-review is an
// optimisation we may not use, NOT the architecture — which is why the pending
// bar renders identically regardless of forge.
//
// Two destinations per composed note: "Send to agent" (the visually primary
// accent — the fastest path from seeing a problem to it being fixed) and
// "Add to review" (buffer box-side). The pending bar sums the buffered comments
// with the verdict actions (Approve / Request changes / Comment) and a Submit
// that flushes everything as one review. If the branch head moved past what we
// anchored to, the draft is marked stale (kept, never discarded — the warning
// below) and the bar warns instead of dropping the user's writing.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ForgeDraft, ForgeThread } from "../shared/types";
import type { CommentableLine } from "./chatUtils";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Callout } from "./Callout";
import { StatusDot } from "./StatusDot";
import { Pill } from "./Pill";
import { UnifiedDiff, type UnifiedDiffGutter, type UnifiedDiffNote } from "./ToolBodies";

const REVIEW_VERDICTS = [
  { value: "approved", label: "Approve" },
  { value: "changes_requested", label: "Request changes" },
  { value: "commented", label: "Comment" },
] as const;

// Map a GitHub thread anchor onto the forge-neutral `{ path, line, side }` the
// diff gutters use (spec §3.4③). GitHub "RIGHT" → new side, "LEFT" → old side.
function threadAnchor(t: ForgeThread): CommentableLine | null {
  if (t.line == null) return null;
  return { path: t.path ?? "", line: t.line, side: t.side === "LEFT" ? "old" : "new" };
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

// The note-inline block (a colleague's thread, a buffered draft note, or the
// composer) that sits between diff lines. This IS the `Callout` primitive at its
// `note` size — the spec's `.note-inline` (§4.5②): a 2px accent left bar on an
// accent-bg surface, indented under the diff's code region. The attribution
// line is emphasised; the status line is mono `--tx4`.
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
    <div className="ml-[68px]">
      <Callout tone="info" size="note">
        <div className="font-semibold text-text">{attribution}</div>
        <div className="mt-px whitespace-pre-wrap break-words leading-[1.55]">{body}</div>
        {action && <div className="mt-2 flex items-center gap-[6px]">{action}</div>}
        {status && (
          <div className="mt-[6px] font-mono text-[11.5px] text-text-quiet">{status}</div>
        )}
      </Callout>
    </div>
  );
}

export function ReviewPane({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const [diff, setDiff] = useState<string>("");
  const [threads, setThreads] = useState<ForgeThread[]>([]);
  const [error, setError] = useState<"no_forge" | "not_connected" | "no_pr" | null>(null);
  const [loading, setLoading] = useState(true);

  // The box-buffered draft (BET-793). null = no draft yet on the box.
  const [draft, setDraft] = useState<ForgeDraft | null>(null);

  const [composing, setComposing] = useState<CommentableLine | null>(null);
  const [draftText, setDraftText] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  // Renderer-local "routed to agent" flags keyed by buffered comment id. The
  // forge never sees this — it only lands in the chat composer. Not a draft
  // field, so the box store stays forge-shaped.
  const sentRef = useRef<Set<string>>(new Set());
  const [, forceRender] = useState(0);

  // Fetch the PR diff + the box-owned draft for the session's cwd. Re-runs
  // when the cwd changes (session switch). No interval — refetch on reopen.
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
    setDraft(null);
    sentRef.current = new Set();

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

    window.api
      .forgeDraftGet({ cwd })
      .then((res) => {
        if (cancelled) return;
        if (res.draft) setDraft(res.draft);
      })
      .catch(() => {
        // A draft read failure must not blank the diff. Best-effort empty.
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, sessionId]);

  // ---- Composer / draft mutations (all box-side) --------------------------

  const addToReview = useCallback(async () => {
    if (!composing) return;
    const body = draftText.trim();
    if (!body) return;
    const res = await window.api.forgeDraftComment({
      cwd,
      op: "add",
      comment: { path: composing.path, line: composing.line, side: composing.side, body },
    });
    if (res.ok) setDraft(res.draft);
    setComposing(null);
    setDraftText("");
  }, [cwd, composing, draftText]);

  const sendToAgent = useCallback(
    (text: string, commentId?: string) => {
      const t = text.trim();
      if (!t) return;
      window.dispatchEvent(
        new CustomEvent("manta-forge-comment", { detail: { sessionId, text: t } }),
      );
      if (commentId) {
        sentRef.current.add(commentId);
        forceRender((n) => n + 1);
      }
    },
    [sessionId],
  );

  const removeComment = useCallback(
    async (commentId: string) => {
      const res = await window.api.forgeDraftComment({ cwd, op: "delete", comment: { id: commentId } });
      if (res.ok) setDraft(res.draft);
    },
    [cwd],
  );

  const setVerdict = useCallback(
    async (verdict: ForgeDraft["verdict"]) => {
      const res = await window.api.forgeDraftComment({ cwd, op: "set-verdict", verdict });
      if (res.ok) setDraft(res.draft);
    },
    [cwd],
  );

  const submit = useCallback(async () => {
    if (!draft || draft.comments.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const res = await window.api.forgeDraftSubmit({ cwd, verdict: draft.verdict ?? undefined });
      if (res.ok) {
        setDraft(null);
        sentRef.current = new Set();
      }
      // A failed submit returns { ok:false } and leaves the draft intact
      // (box-side) — the pending bar stays so nothing is lost.
    } finally {
      setSubmitting(false);
    }
  }, [cwd, draft, submitting]);

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

    // Your own box-buffered draft comments — "You · draft", with the two
    // destinations the design wants: "Send to agent" (accent — primary) and
    // "Remove" to un-buffer before submit. A note routed to agent but still
    // buffered reads "↳ attached to composer · not yet published".
    for (const c of draft?.comments ?? []) {
      const sent = sentRef.current.has(c.id);
      out.push({
        key: `draft-${c.id}`,
        anchor: { path: c.path, line: c.line, side: c.side },
        node: (
          <NoteInline
            attribution={<>You · draft</>}
            body={c.body}
            action={
              <>
                {sent ? null : (
                  <Chip on onClick={() => sendToAgent(c.body, c.id)}>
                    Send to agent
                  </Chip>
                )}
                <Button tone="ghost" onClick={() => removeComment(c.id)}>
                  Remove
                </Button>
              </>
            }
            status={sent ? <>&#8627; attached to composer · not yet published</> : undefined}
          />
        ),
      });
    }

    // The inline composer opened by the gutter `+`, anchored at its line — two
    // destinations, one gesture: "Send to agent" (accent, primary) and "Add to
    // review" (plain). Sending routes to the chat composer; adding buffers the
    // note box-side for the pending review.
    if (composing) {
      out.push({
        key: "composer",
        anchor: composing,
        node: (
          <div className="ml-[68px] my-[6px] rounded-r-[var(--r-sm)] border-l-2 border-accent bg-bg-elev px-[11px] py-2">
            <textarea
              autoFocus
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  addToReview();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setComposing(null);
                  setDraftText("");
                }
              }}
              placeholder="Comment on this line…"
              rows={2}
              className="w-full resize-none rounded-xs border border-border-strong bg-bg px-2 py-1 font-mono text-meta text-text outline-none placeholder:text-text-faint focus:border-accent"
            />
            <div className="mt-2 flex items-center gap-[6px]">
              <Chip on onClick={() => sendToAgent(draftText)}>
                Send to agent
              </Chip>
              <Button tone="default" onClick={addToReview}>
                Add to review
              </Button>
              <Button
                tone="ghost"
                onClick={() => {
                  setComposing(null);
                  setDraftText("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ),
      });
    }

    return out;
  }, [threads, draft, composing, draftText, addToReview, sendToAgent, removeComment]);

  const draftCount = draft?.comments.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* [R2] The pending bar — one row above the diff. Runs only when there is
          something buffered (never at zero) and renders identically regardless
          of forge, which is the visible payoff of the box-side buffer. */}
      {draftCount > 0 && (
        <div className="px-3 pb-1 pt-2">
          {draft?.stale && (
            <div className="mb-2">
              <Callout tone="warn" size="note">
                The branch moved since you wrote these comments — the line
                anchors may be out of date. Your comments are kept; review them
                before submitting.
              </Callout>
            </div>
          )}
          <div className="flex items-center gap-[9px] text-[13px] text-text-muted">
            <StatusDot tone="warn" />
            <span>
              <b className="text-text">{draftCount === 1 ? "1 comment" : `${draftCount} comments`}</b>{" "}
              not yet published
            </span>
            <span className="ml-auto flex items-center gap-[6px]">
              {REVIEW_VERDICTS.map((v) => (
                <Button
                  key={v.value}
                  tone={draft?.verdict === v.value ? "primary" : "default"}
                  onClick={() => setVerdict(v.value)}
                >
                  {v.label}
                </Button>
              ))}
              <Button tone="primary" disabled={submitting} onClick={submit}>
                {submitting ? "Submitting…" : "Submit"}
              </Button>
            </span>
          </div>
        </div>
      )}

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
            <UnifiedDiff text={diff} bare showHunks gutter={gutter} notes={notes} />
          </div>
        )}
      </div>
    </div>
  );
}
