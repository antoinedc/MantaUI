// ===== Status / interaction cards =====
//
// Extracted from ChatPanel.tsx (M0.5). Leaf cards rendered inline in the
// transcript when the session needs the user's attention or is doing async
// housekeeping:
//   - RetryCard: provider retry / rate-limit backoff notice.
//   - CompactionCard: live compaction progress.
//   - PermissionCard: tool-approval prompt (once / always / reject).
//   - QuestionCard: the Question tool's multi-choice + free-text form.

import { useState } from "react";
import type { PermissionRequest, QuestionRequest } from "../shared/types";
import { buildQuestionAnswers, canSubmitQuestion } from "./chatUtils";
import { CLAUDE_ORANGE } from "./chatShared";

// ===== Retry card =====

export function RetryCard({
  info,
}: {
  info: {
    attempt: number;
    message: string;
    next: number;
    action?: { title: string; message: string; label: string; link?: string };
  };
}) {
  const headline = info.action?.title || `Retrying… (attempt ${info.attempt})`;
  const body = info.action?.message || info.message;
  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: CLAUDE_ORANGE }}>↻</span>
        <span className="text-text">{headline}</span>
        {info.attempt > 0 && (
          <span className="text-text-faint">· attempt {info.attempt}</span>
        )}
      </div>
      {body && (
        <div className="text-text-muted break-words mb-1">{body}</div>
      )}
      {info.action?.link && (
        <div>
          <a
            href={info.action.link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-block px-2 py-0.5 rounded border border-border-strong text-text hover:bg-bg-soft"
          >
            {info.action.label || "Open"}
          </a>
        </div>
      )}
    </div>
  );
}

// ===== Credential refresh card =====
//
// Rendered while the renderer auto-recovers from a ProviderAuthError (BET-139):
// a background `claude` refresh runs server-side, and on success the failed
// turn is auto-resent. Failure is surfaced via the sendError banner instead
// (see credentialRefreshBannerText in chatUtils.ts) — this card renders
// nothing for the "error" phase to avoid double-surfacing the message.

export function CredRefreshCard({ state }: { state: "refreshing" | "ok" }) {
  const isRefreshing = state === "refreshing";
  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: CLAUDE_ORANGE }}>
          <span className={isRefreshing ? "inline-block animate-pulse" : "inline-block"}>
            ↻
          </span>
        </span>
        <span className="text-text">
          {isRefreshing ? "Refreshing Claude credentials…" : "Credentials refreshed — resending."}
        </span>
      </div>
    </div>
  );
}

// ===== Compaction card =====
//
// Rendered while session.next.compaction.* events stream in. "running" shows
// the live-built summary fragment; "done" shows the first line of the final
// summary for a beat before the parent clears state.

export function CompactionCard({
  state,
}: {
  state: { reason: string; text: string; phase: "running" | "done" };
}) {
  const isRunning = state.phase === "running";
  const firstLine = state.text.split("\n").find((s) => s.trim()) ?? "";
  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: CLAUDE_ORANGE }}>
          <span className={isRunning ? "inline-block animate-pulse" : "inline-block"}>
            ✻
          </span>
        </span>
        <span className="text-text">
          {isRunning ? "Compacting…" : "Compacted"}
        </span>
        {state.reason && (
          <span className="text-text-faint">· {state.reason}</span>
        )}
      </div>
      {isRunning ? (
        state.text && (
          <div className="text-text-muted break-words whitespace-pre-wrap line-clamp-3 font-mono">
            {state.text}
          </div>
        )
      ) : (
        firstLine && (
          <div className="text-text-muted break-words font-mono">{firstLine}</div>
        )
      )}
    </div>
  );
}

// ===== Permission card =====
//
// Rendered when opencode has paused a tool waiting for user approval. We
// surface enough info to make a sensible call without digging into the
// transcript: category (e.g. "external_directory", "bash"), the filepath or
// command if available in metadata, and the "always" patterns scope.
//
// Three options match the API's three reply enum values:
//   - "once"    — allow this single execution
//   - "always"  — allow this AND save the patterns for future auto-approval
//   - "reject"  — deny; the tool errors out

export function PermissionCard({
  perm,
  onReply,
}: {
  perm: PermissionRequest;
  onReply: (reply: "once" | "always" | "reject") => void;
}) {
  const meta = perm.metadata ?? {};
  const filepath = typeof meta.filepath === "string" ? meta.filepath : undefined;
  const command = typeof meta.command === "string" ? meta.command : undefined;
  const detail = filepath ?? command ?? "";
  const alwaysScope =
    perm.always && perm.always.length > 0 ? perm.always.join(", ") : null;

  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: CLAUDE_ORANGE }}>✻</span>
        <span className="text-text">Permission needed</span>
        <span className="text-text-faint">· {perm.permission}</span>
      </div>
      {detail && (
        <div className="text-text-muted break-all mb-2 font-mono">{detail}</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onReply("once")}
          className="px-2 py-0.5 rounded border border-border-strong text-text hover:bg-bg-soft"
        >
          Allow once
        </button>
        {alwaysScope && (
          <button
            onClick={() => onReply("always")}
            className="px-2 py-0.5 rounded text-bg"
            style={{ backgroundColor: CLAUDE_ORANGE }}
            title={`Always allow ${alwaysScope}`}
          >
            Always allow {alwaysScope}
          </button>
        )}
        <button
          onClick={() => onReply("reject")}
          className="px-2 py-0.5 rounded text-red-400 hover:bg-red-500/10 border border-red-500/30"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

// ===== Question card =====
//
// Rendered when Claude invokes the Question tool mid-task. Each QuestionRequest
// may contain multiple QuestionInfo entries; we render one block per question.
// The user selects option(s) and hits Submit — or clicks × to reject the whole
// request (Claude receives an error and may handle it gracefully).

export function QuestionCard({
  request,
  onReply,
  onReject,
}: {
  request: QuestionRequest;
  onReply: (answers: string[][]) => void;
  onReject: () => void;
}) {
  // One Set<string> per question tracks selected option labels.
  const [selected, setSelected] = useState<Set<string>[]>(() =>
    request.questions.map(() => new Set<string>()),
  );
  // One custom text value per question (only used when info.custom is true).
  const [customValues, setCustomValues] = useState<string[]>(() =>
    request.questions.map(() => ""),
  );

  function toggleOption(qIdx: number, label: string, multiple: boolean) {
    setSelected((prev) => {
      const next = prev.map((s) => new Set(s));
      if (multiple) {
        if (next[qIdx].has(label)) next[qIdx].delete(label);
        else next[qIdx].add(label);
      } else {
        next[qIdx] = new Set([label]);
      }
      return next;
    });
  }

  function handleSubmit() {
    onReply(buildQuestionAnswers(selected, customValues));
  }

  // Submit is enabled once every question has either a selection OR typed text.
  const canSubmit = canSubmitQuestion(selected, customValues);

  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: CLAUDE_ORANGE }}>?</span>
        <span className="text-text font-medium">Question</span>
        <button
          onClick={onReject}
          className="ml-auto text-text-faint hover:text-text leading-none"
          title="Reject / dismiss"
        >
          ×
        </button>
      </div>

      <div className="space-y-3">
        {request.questions.map((info, qIdx) => (
          <div key={qIdx}>
            {/* Header as a short label, question as the full body */}
            <div className="text-text-muted mb-0.5 font-medium">{info.header}</div>
            <div className="text-text mb-1.5 leading-snug">{info.question}</div>

            {/* Option buttons */}
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              {info.options.map((opt) => {
                const isSelected = selected[qIdx].has(opt.label);
                return (
                  <button
                    key={opt.label}
                    onClick={() => toggleOption(qIdx, opt.label, info.multiple ?? false)}
                    title={opt.description}
                    className={[
                      "px-2 py-0.5 rounded border text-[12px] transition-colors",
                      isSelected
                        ? "text-bg border-transparent"
                        : "text-text border-border-strong hover:bg-bg-soft",
                    ].join(" ")}
                    style={isSelected ? { backgroundColor: CLAUDE_ORANGE } : undefined}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* Free-text input — always available so the user can type a
                custom reply for any question, even when opencode didn't flag
                it as custom. Combined with any selected option(s) on submit. */}
            <input
              type="text"
              placeholder="Or type your own answer…"
              value={customValues[qIdx]}
              onChange={(e) => {
                const v = e.target.value;
                setCustomValues((prev) => {
                  const next = [...prev];
                  next[qIdx] = v;
                  return next;
                });
              }}
              onKeyDown={(e) => {
                // Enter submits when the whole request is answerable (matches
                // the composer's submit-on-Enter muscle memory). Shift+Enter
                // is left alone for anyone who wants a literal newline-free
                // multi-field flow.
                if (e.key === "Enter" && !e.shiftKey && canSubmit) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="mt-1.5 w-full rounded border border-border bg-transparent px-2 py-0.5 text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong"
            />
          </div>
        ))}
      </div>

      <hr className="my-2 mx-2 border-border" />

      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onReject}
          className="px-2 py-0.5 rounded text-text-faint hover:text-text border border-border"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-2 py-0.5 rounded text-bg disabled:opacity-40"
          style={{ backgroundColor: CLAUDE_ORANGE }}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
