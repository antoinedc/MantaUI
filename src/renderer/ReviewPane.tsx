// BET-793 — the review pane (WRITE half on top of BET-792's read half).
//
// The box owns the review: `forge:diff` returns the PR's parsed diff as files →
// rows with line numbers and comment anchors, every incoming thread and every
// box-buffered draft comment already PLACED on a row (`placement`), and the
// reconciled draft — one call, one set of rules for every client (WS05 S.2).
// This pane renders that; it parses no diff text and derives no anchor or
// placement. After a draft mutation it reconciles the placed snapshot by comment
// id (`mergeDraftPlacements`) and only asks for new placements when the merge
// says it must.
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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ForgeDiffFile,
  ForgeDiffResult,
  ForgeDraft,
  ForgePlacedDraft,
  ForgePlacedDraftComment,
  ForgePlacement,
  ForgeThread,
} from "../shared/types";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Callout } from "./Callout";
import { StatusDot } from "./StatusDot";
import { Pill } from "./Pill";
import { useBoxCapability } from "./hooks/useBoxCapabilities";

const REVIEW_VERDICTS = [
  { value: "approved", label: "Approve" },
  { value: "changes_requested", label: "Request changes" },
  { value: "commented", label: "Comment" },
] as const;

export const REVIEW_UPDATE_BOX_NOTE = "Update your box to review pull requests here.";
export const REVIEW_PARSE_FAILED = "Couldn't read this diff.";

// What the pane shows for a box answer, first match wins (WS05 S.2): the box's
// error → an older box (no structured diff) → the diff text couldn't be read →
// no files → the diff. A parse failure is never "No diff.".
export type ReviewLoadState =
  | { kind: "error"; message: string }
  | { kind: "old-box" }
  | { kind: "parse-failed"; message: string }
  | { kind: "empty" }
  | { kind: "diff" };

export function reviewLoadState(res: ForgeDiffResult, capability: boolean | null = null): ReviewLoadState {
  if (res.error) return { kind: "error", message: res.message || res.error };
  if (res.files === undefined || capability === false) return { kind: "old-box" };
  if (res.parseFailed) return { kind: "parse-failed", message: res.message || REVIEW_PARSE_FAILED };
  return res.files.length === 0 ? { kind: "empty" } : { kind: "diff" };
}

// Reconcile the placed draft snapshot of the last `forge:diff` with a draft
// MUTATION response (which carries no placements), by comment id only — an
// anchor is never turned back into a placement here (WS05 S.2):
//   1. ids present before keep their previous placement;
//   2. the one new id (when exactly one appeared and a row was tapped) sits at
//      the tapped row;
//   3. ids no longer present are gone;
//   4. anything else (more unknown ids — another device added comments — or a
//      moved head / flipped stale flag) keeps every comment (the unknown ones
//      `unplaced`) and asks for a refetch;
//   5. a null response (the draft was submitted or cleared elsewhere) clears it.
// The draft's own fields (verdict, body, stale, headSha) always come from the
// response.
export function mergeDraftPlacements(
  previous: ForgePlacedDraft | null,
  response: ForgeDraft | null,
  tapped: ForgePlacement | null,
): { draft: ForgePlacedDraft | null; needsRefetch: boolean } {
  if (!response) return { draft: null, needsRefetch: false };
  // The same rule as iOS `ReviewDraftMerge`: unknown comments are KEPT (a
  // single one from this user's tap sits at the tapped row, any other is
  // `unplaced` until the refetch places it), so the pending count never runs short.
  const known = new Map<string, ForgePlacement>(
    (previous?.comments ?? []).map((c) => [c.id, c.placement ?? ({ at: "unplaced" } as ForgePlacement)]),
  );
  const unknown = response.comments.filter((c) => !known.has(c.id));
  let needsRefetch = false;
  if (previous && (response.headSha !== previous.headSha || response.stale !== previous.stale)) needsRefetch = true;
  if (unknown.length > 1 || (unknown.length === 1 && !tapped)) needsRefetch = true;
  const comments: ForgePlacedDraftComment[] = response.comments.map((c) => ({
    ...c,
    placement:
      known.get(c.id) ?? (unknown.length === 1 && tapped ? tapped : ({ at: "unplaced" } as ForgePlacement)),
  }));
  return { draft: { ...response, comments }, needsRefetch };
}

// A rate-limited re-read returns the stored draft without placements: keep the
// placements this pane already has and take the draft's own fields.
function mergeStaleDraft(current: ForgePlacedDraft | null, fresh: ForgePlacedDraft | null): ForgePlacedDraft | null {
  if (!fresh) return current;
  const known = new Map((current?.comments ?? []).map((c) => [c.id, c.placement]));
  return { ...fresh, comments: fresh.comments.map((c) => ({ ...c, placement: known.get(c.id) ?? c.placement })) };
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
  error,
}: {
  attribution: ReactNode;
  body: ReactNode;
  action?: ReactNode;
  status?: ReactNode;
  error?: string | null;
}) {
  return (
    <div className="ml-[68px]">
      <Callout tone="info" size="note">
        <div className="font-semibold text-text">{attribution}</div>
        <div className="mt-px whitespace-pre-wrap break-words leading-[1.55]">{body}</div>
        {action && <div className="mt-2 flex items-center gap-[6px]">{action}</div>}
        {error && <div className="mt-[6px] break-words text-xs text-danger">{error}</div>}
        {status && (
          <div className="mt-[6px] font-mono text-[11.5px] text-text-quiet">{status}</div>
        )}
      </Callout>
    </div>
  );
}

// A row of the box's structured diff, with the comment gutter. Notes the box
// placed under a row render directly after it.
function ReviewDiffRows({
  file,
  fileIndex,
  notesAfterRow,
  onCompose,
}: {
  file: ForgeDiffFile;
  fileIndex: number;
  notesAfterRow: (file: number, row: number) => ReactNode;
  onCompose: (anchor: NonNullable<ForgeDiffFile["rows"][number]["anchor"]>, placement: ForgePlacement) => void;
}) {
  return (
    <div className="leading-snug w-max min-w-full">
      {file.rows.map((row, ri) => {
        if (row.kind === "hunk") {
          return (
            <div key={ri} className="flex whitespace-pre text-text-quiet">
              <span className="w-[26px] shrink-0" aria-hidden />
              <span className="shrink-0 select-none w-[30px]" />
              <span className="shrink-0 w-3" />
              <span className="flex-1">{row.text}</span>
            </div>
          );
        }
        const added = row.kind === "added";
        const removed = row.kind === "removed";
        const bg = added ? "bg-[var(--diff-add)]" : removed ? "bg-[var(--diff-del)]" : "";
        const signCls = added ? "text-ok" : removed ? "text-danger" : "text-text-faint";
        const lnCls = added ? "text-ok/70" : removed ? "text-danger/70" : "text-text-faint";
        const sign = added ? "+" : removed ? "−" : " ";
        const ln = removed ? row.oldLine : row.newLine;
        const anchor = row.anchor;
        const placement: ForgePlacement = { at: "row", file: fileIndex, row: ri };
        return (
          <Fragment key={ri}>
            <div
              className={["flex whitespace-pre group relative", bg].join(" ").trim()}
              tabIndex={0}
              role="button"
              aria-label={anchor ? "Comment on this line" : "Diff line"}
              onKeyDown={
                anchor
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onCompose(anchor, placement);
                      }
                    }
                  : undefined
              }
            >
              <span className="w-[26px] shrink-0 select-none" aria-hidden>
                {anchor && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Comment on this line"
                    title="Comment on this line"
                    onClick={() => onCompose(anchor, placement)}
                    className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-xs text-text-muted opacity-0 transition-opacity hover:text-text group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                      <path d="M5.5 2v7M2 5.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </span>
              <span className={`select-none shrink-0 text-right pr-2 w-[30px] ${lnCls}`}>{ln ?? ""}</span>
              <span className={`select-none shrink-0 w-3 ${signCls}`}>{sign}</span>
              <span className="flex-1 text-text">{row.text || " "}</span>
            </div>
            {notesAfterRow(fileIndex, ri)}
          </Fragment>
        );
      })}
    </div>
  );
}

export function ReviewPane({
  sessionId,
  cwd,
  target,
  prUrl,
  onOpenExternal,
}: {
  sessionId?: string;
  cwd?: string;
  // BET-850: an explicit cross-repo inbox PR. When present, the pane addresses
  // the forge by { repoKey, number } instead of resolving the session's cwd →
  // origin → open PR (the inbox row may live in a repo the box has not cloned).
  target?: { repoKey: string; number: number };
  // The PR's page, when the caller knows it — enables "Open on GitHub" in the
  // unreadable-diff and too-large states (not rendered without it).
  prUrl?: string;
  onOpenExternal?: (url: string) => void;
}) {
  // The forge read/write ref: the explicit inbox target wins; otherwise the
  // session's cwd (resolved box-side). "Send to agent" needs a live session,
  // so it is gated on a non-empty sessionId (hidden for a standalone review).
  const ref = target ?? { cwd: cwd ?? "" };
  const canSend = Boolean(sessionId);
  const diffCapability = useBoxCapability("forge-diff-view-1");
  const [result, setResult] = useState<ForgeDiffResult | null>(null);
  const resultRef = useRef<ForgeDiffResult | null>(null);
  resultRef.current = result;
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  // The box-buffered draft with the placements of the last forge:diff (BET-793).
  // null = no draft on the box.
  const [draft, setDraft] = useState<ForgePlacedDraft | null>(null);

  const [composing, setComposing] = useState<{
    anchor: NonNullable<ForgeDiffFile["rows"][number]["anchor"]>;
    placement: ForgePlacement;
  } | null>(null);
  const [draftText, setDraftText] = useState<string>("");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Failures of Remove / verdict changes / replies — shown, never swallowed.
  const [noteErrors, setNoteErrors] = useState<Record<string, string>>({});

  // Reply-to-an-incoming-thread composer (for a colleague's thread on the diff).
  // `replyingTo` is the target thread id; `replyText` is the draft reply body.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<string>("");

  // Renderer-local "routed to agent" flags keyed by buffered comment id. The
  // forge never sees this — it only lands in the chat composer. Not a draft
  // field, so the box store stays forge-shaped.
  const sentRef = useRef<Set<string>>(new Set());
  const [, forceRender] = useState(0);

  const refKey = target ? `${target.repoKey}#${target.number}` : cwd;

  // Fetch the PR diff, threads and draft (all placed by the box) for the forge
  // ref. `keepUi` re-reads in place (after a reply or when a merge asks for
  // placements) without blanking the pane. No interval — refetch on reopen.
  const load = useCallback(
    async (keepUi: boolean): Promise<void> => {
      if (!refKey) {
        setLoading(false);
        setLoadFailed(true);
        return;
      }
      if (!keepUi) setLoading(true);
      try {
        const res = await window.api.forgeDiff(ref);
        // A rate-limited read answers no files at all (`stale`, no error): keep
        // what is on screen — the snapshot and the user's unpublished comments —
        // and only flag it stale.
        if (res.error == null && res.stale && (res.files?.length ?? 0) === 0 && resultRef.current) {
          setResult({ ...resultRef.current, stale: true });
          if (res.draft) setDraft((d) => mergeStaleDraft(d, res.draft ?? null));
          setLoadFailed(false);
          return;
        }
        setResult(res);
        setDraft(res.draft ?? null);
        setLoadFailed(false);
      } catch {
        if (!keepUi) setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey],
  );

  useEffect(() => {
    setComposing(null);
    setDraftText("");
    setComposeError(null);
    setSubmitError(null);
    setNoteErrors({});
    sentRef.current = new Set();
    void load(false);
  }, [load, sessionId]);

  // ---- Composer / draft mutations (all box-side) --------------------------

  const applyMutation = useCallback(
    async (next: ForgeDraft | null, tapped: ForgePlacement | null) => {
      const merged = mergeDraftPlacements(draft, next, tapped);
      setDraft(merged.draft);
      if (merged.needsRefetch) await load(true);
    },
    [draft, load],
  );

  const addToReview = useCallback(async () => {
    if (!composing) return;
    const body = draftText.trim();
    if (!body) return;
    setComposeError(null);
    try {
      const res = await window.api.forgeDraftComment({
        ...ref,
        op: "add",
        comment: { path: composing.anchor.path, line: composing.anchor.line, side: composing.anchor.side, body },
      });
      if (!res.ok) {
        // Keep the composer and the typed text; say why.
        setComposeError(res.message ?? res.error);
        return;
      }
      await applyMutation(res.draft, composing.placement);
      setComposing(null);
      setDraftText("");
    } catch (e) {
      setComposeError(e instanceof Error ? e.message : "Couldn't add the comment.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, composing, draftText, applyMutation]);

  // Reply to ONE existing incoming thread — posts immediately (never buffered
  // in the draft), then refetches so the reply lands with the canonical read.
  // The composer stays open (with the reason) on failure.
  const postReply = useCallback(
    async (threadId: string, body: string) => {
      if (!body.trim()) return;
      setNoteErrors((m) => ({ ...m, [`thread-${threadId}`]: "" }));
      try {
        const res = await window.api.forgeThreadReply({ ...ref, threadId, body });
        if (!res.ok) {
          setNoteErrors((m) => ({ ...m, [`thread-${threadId}`]: res.message ?? res.error }));
          return;
        }
        setReplyingTo(null);
        setReplyText("");
        await load(true);
      } catch (e) {
        setNoteErrors((m) => ({ ...m, [`thread-${threadId}`]: e instanceof Error ? e.message : "Couldn't post the reply." }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey, load],
  );

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
      const key = `draft-${commentId}`;
      setNoteErrors((m) => ({ ...m, [key]: "" }));
      try {
        const res = await window.api.forgeDraftComment({ ...ref, op: "delete", comment: { id: commentId } });
        if (!res.ok) {
          setNoteErrors((m) => ({ ...m, [key]: res.message ?? res.error }));
          return;
        }
        await applyMutation(res.draft, null);
      } catch (e) {
        setNoteErrors((m) => ({ ...m, [key]: e instanceof Error ? e.message : "Couldn't remove the comment." }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey, applyMutation],
  );

  const setVerdict = useCallback(
    async (verdict: ForgeDraft["verdict"]) => {
      setSubmitError(null);
      try {
        const res = await window.api.forgeDraftComment({ ...ref, op: "set-verdict", verdict });
        if (!res.ok) {
          setSubmitError(res.message ?? res.error);
          return;
        }
        await applyMutation(res.draft, null);
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : "Couldn't change the verdict.");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey, applyMutation],
  );

  const submit = useCallback(async () => {
    if (!draft || draft.comments.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await window.api.forgeDraftSubmit({ ...ref, verdict: draft.verdict ?? undefined });
      if (res.ok) {
        setDraft(null);
        sentRef.current = new Set();
        await load(true);
      } else {
        // A failed submit leaves the draft intact (box-side) — the pending bar
        // stays so nothing is lost, and the reason is shown.
        setSubmitError(res.message ?? res.error);
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Couldn't submit the review.");
    } finally {
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, draft, submitting, load]);

  const threads: ForgeThread[] = result?.threads ?? [];
  const files: ForgeDiffFile[] = result?.files ?? [];
  const state: ReviewLoadState | null = result ? reviewLoadState(result, diffCapability) : null;

  // ---- Notes (threads + drafts + composer), routed by the box's placement ----

  const threadNote = (t: ForgeThread): ReactNode => (
    <NoteInline
      key={`thread-${t.id}`}
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
          {replyingTo === t.id && (
            <div className="mt-2 rounded-r-[var(--r-sm)] border-l-2 border-accent bg-bg-elev px-[11px] py-2">
              <textarea
                autoFocus
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void postReply(t.id, replyText);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setReplyingTo(null);
                    setReplyText("");
                  }
                }}
                placeholder="Reply…"
                rows={2}
                className="w-full resize-none rounded-xs border border-border-strong bg-bg px-2 py-1 font-mono text-meta text-text outline-none placeholder:text-text-faint focus:border-accent"
              />
              <div className="mt-2 flex items-center gap-[6px]">
                <Button tone="default" onClick={() => void postReply(t.id, replyText)}>
                  Reply
                </Button>
                <Button
                  tone="ghost"
                  onClick={() => {
                    setReplyingTo(null);
                    setReplyText("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      }
      action={
        replyingTo !== t.id ? (
          <Button
            tone="ghost"
            onClick={() => {
              setReplyingTo(t.id);
              setReplyText("");
            }}
          >
            Reply
          </Button>
        ) : undefined
      }
      error={noteErrors[`thread-${t.id}`] || null}
    />
  );

  // Your own box-buffered draft comments — "You · draft", with the two
  // destinations the design wants: "Send to agent" (accent — primary) and
  // "Remove" to un-buffer before submit. A note routed to agent but still
  // buffered reads "↳ attached to composer · not yet published".
  const draftNote = (c: ForgePlacedDraftComment): ReactNode => {
    const sent = sentRef.current.has(c.id);
    return (
      <NoteInline
        key={`draft-${c.id}`}
        attribution={<>You · draft</>}
        body={c.body}
        action={
          <>
            {sent ? null : canSend && (
              <Chip on onClick={() => sendToAgent(c.body, c.id)}>
                Send to agent
              </Chip>
            )}
            <Button tone="ghost" onClick={() => void removeComment(c.id)}>
              Remove
            </Button>
          </>
        }
        status={sent ? <>&#8627; attached to composer · not yet published</> : undefined}
        error={noteErrors[`draft-${c.id}`] || null}
      />
    );
  };

  // The inline composer opened by the gutter `+`, under its row — two
  // destinations, one gesture: "Send to agent" (accent, primary) and "Add to
  // review" (plain). Sending routes to the chat composer; adding buffers the
  // note box-side for the pending review.
  const composerNode: ReactNode = composing ? (
    <div key="composer" className="ml-[68px] my-[6px] rounded-r-[var(--r-sm)] border-l-2 border-accent bg-bg-elev px-[11px] py-2">
      <textarea
        autoFocus
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void addToReview();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setComposing(null);
            setDraftText("");
            setComposeError(null);
          }
        }}
        placeholder="Comment on this line…"
        rows={2}
        className="w-full resize-none rounded-xs border border-border-strong bg-bg px-2 py-1 font-mono text-meta text-text outline-none placeholder:text-text-faint focus:border-accent"
      />
      {composeError && <div className="mt-1 break-words text-xs text-danger">{composeError}</div>}
      <div className="mt-2 flex items-center gap-[6px]">
        {canSend && (
          <Chip on onClick={() => sendToAgent(draftText)}>
            Send to agent
          </Chip>
        )}
        <Button tone="default" onClick={() => void addToReview()}>
          Add to review
        </Button>
        <Button
          tone="ghost"
          onClick={() => {
            setComposing(null);
            setDraftText("");
            setComposeError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  ) : null;

  const { byRow, byFile, otherComments } = useMemo(() => {
    const row = new Map<string, ReactNode[]>();
    const file = new Map<number, ReactNode[]>();
    const other: ReactNode[] = [];
    const put = (p: ForgePlacement | undefined, node: ReactNode) => {
      if (p?.at === "row") {
        const k = `${p.file}:${p.row}`;
        row.set(k, [...(row.get(k) ?? []), node]);
      } else if (p?.at === "file") {
        file.set(p.file, [...(file.get(p.file) ?? []), node]);
      } else {
        other.push(node);
      }
    };
    for (const t of threads) put(t.placement, threadNote(t));
    for (const c of draft?.comments ?? []) put(c.placement, draftNote(c));
    return { byRow: row, byFile: file, otherComments: other };
    // threadNote / draftNote close over the state listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, draft, replyingTo, replyText, noteErrors, canSend, postReply, removeComment, sendToAgent, sentRef.current.size]);

  const notesAfterRow = (file: number, row: number): ReactNode => {
    const placed = byRow.get(`${file}:${row}`);
    const here =
      composing && composing.placement.at === "row" && composing.placement.file === file && composing.placement.row === row;
    if (!placed && !here) return null;
    return (
      <>
        {placed}
        {here && composerNode}
      </>
    );
  };

  const draftCount = draft?.comments.length ?? 0;

  const openOnGithub = prUrl && onOpenExternal ? (
    <Button tone="default" onClick={() => onOpenExternal(prUrl)}>
      Open on GitHub
    </Button>
  ) : null;

  let body: ReactNode;
  if (loading) {
    body = <div className="px-3 py-6 text-meta text-text-faint">Loading diff…</div>;
  } else if (loadFailed || !state) {
    body = (
      <div className="px-3 py-6 text-meta text-text-faint">
        <div>Couldn&apos;t load this diff.</div>
        <div className="mt-2">
          <Button tone="default" onClick={() => void load(false)}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (state.kind === "error") {
    body = (
      <div className="px-3 py-6 text-meta text-text-faint">
        <div>{state.message}</div>
        <div className="mt-2">
          <Button tone="default" onClick={() => void load(false)}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (state.kind === "old-box") {
    body = (
      <div className="px-3 py-6 text-meta text-text-faint">
        <div>{REVIEW_UPDATE_BOX_NOTE}</div>
        {openOnGithub && <div className="mt-2">{openOnGithub}</div>}
      </div>
    );
  } else {
    body = (
      <>
        {state.kind === "parse-failed" && (
          <div className="px-3 py-6 text-meta text-text-faint">
            <div>{state.message}</div>
            <div className="mt-2 flex items-center gap-2">
              <Button tone="default" onClick={() => void load(false)}>
                Try again
              </Button>
              {openOnGithub}
            </div>
          </div>
        )}
        {state.kind === "empty" && <div className="px-3 py-6 text-meta text-text-faint">No diff.</div>}
        {result?.stale && (
          <div className="px-3 pt-2 text-xs text-text-quiet">Showing last known diff — GitHub didn&apos;t answer.</div>
        )}
        {otherComments.length > 0 && (
          <div className="py-2">
            <div className="px-3 pb-1 font-mono text-[11.5px] font-semibold text-text-muted">Other comments</div>
            {otherComments}
          </div>
        )}
        {state.kind === "diff" &&
          files.map((f, fi) => (
            <div key={`${fi}:${f.path}`} className="py-2">
              <div className="flex items-center gap-2 px-3 pb-1">
                <span className="min-w-0 truncate font-mono text-[11.5px] font-semibold text-text-muted">{f.path}</span>
                <Pill tone="neutral" size="label" border={false}>
                  {`+${f.added} −${f.removed}`}
                </Pill>
              </div>
              {byFile.get(fi)}
              {f.truncated ? (
                <div className="px-3 py-2 text-meta text-text-faint">
                  <div>Too large to show here ({f.rowCount} lines).</div>
                  {openOnGithub && <div className="mt-2">{openOnGithub}</div>}
                </div>
              ) : (
                <ReviewDiffRows
                  file={f}
                  fileIndex={fi}
                  notesAfterRow={notesAfterRow}
                  onCompose={(anchor, placement) => {
                    setComposing({ anchor, placement });
                    setDraftText("");
                    setComposeError(null);
                  }}
                />
              )}
            </div>
          ))}
      </>
    );
  }

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
                  onClick={() => void setVerdict(v.value)}
                >
                  {v.label}
                </Button>
              ))}
              <Button tone="primary" disabled={submitting} onClick={() => void submit()}>
                {submitting ? "Submitting…" : "Submit"}
              </Button>
            </span>
          </div>
          {submitError && <div className="mt-1 break-words text-xs text-danger">{submitError}</div>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
