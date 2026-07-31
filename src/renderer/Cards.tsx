// ===== Status / interaction cards =====
//
// Extracted from ChatPanel.tsx (M0.5). Leaf cards rendered inline in the
// transcript when the session needs the user's attention or is doing async
// housekeeping:
//   - RetryCard: provider retry / rate-limit backoff notice.
//   - CompactionCard: live compaction progress.
//   - PermissionCard: tool-approval prompt (once / always / reject).
//   - QuestionCard: the Question tool's multi-choice + free-text form.
//
// BET-415 redesign: PermissionCard and QuestionCard get a 30px icon badge
// instead of a whole-card coloured outline, plain-language titles, a
// button-ladder (primary filled / secondary outlined / reject right-tinted),
// and question options become checkboxes (multi-select aware). Recommended
// answers render as a pill and preselect only for single-select.

import { useState } from "react";
import { Shield, HelpCircle, X, Check } from "lucide-react";
import type { PermissionRequest, QuestionRequest } from "../shared/types";
import { buildQuestionAnswers, canSubmitQuestion } from "./chatUtils";

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
      className="rounded-md border bg-bg-elev px-4 py-3 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: "var(--accent)" }}>↻</span>
        <span className="text-text">{headline}</span>
        {info.attempt > 0 && (
          <span className="text-text-faint">· attempt {info.attempt}</span>
        )}
      </div>
      {body && (
        <div className="text-text-muted break-words">{body}</div>
      )}
      {info.action?.link && (
        <div>
          <a
            href={info.action.link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-block px-2 py-px rounded border border-border-strong text-text hover:bg-bg-soft"
          >
            {info.action.label || "Open"}
          </a>
        </div>
      )}
    </div>
  );
}

// ===== Compaction card =====

export function CompactionCard({
  state,
}: {
  state: { reason: string; text: string; phase: "running" | "done" };
}) {
  const isRunning = state.phase === "running";
  const firstLine = state.text.split("\n").find((s) => s.trim()) ?? "";
  return (
    <div
      className="rounded-md border bg-bg-elev px-4 py-3 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: "var(--accent)" }}>
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
// BET-415 redesign:
//   - 30px icon badge (Shield on --warn-bg) replaces the whole-card orange
//     outline.
//   - Plain-language title ("Run a shell command?") above a one-line
//     description; the literal command in its own --inset well below.
//   - Button ladder: primary filled (Always), secondary outlined (Allow once),
//     Reject pushed right and tinted only on hover.

// Map opencode permission categories to plain-language titles.
function permissionTitle(perm: PermissionRequest): string {
  const cat = perm.permission;
  // Common categories: "bash", "external_directory", "web_fetch", "edit",
  // "write", etc. Map the well-known ones to friendly phrasing.
  if (cat === "bash") return "Run a shell command?";
  if (cat === "edit" || cat === "write") return "Edit a file?";
  if (cat === "external_directory") return "Access a directory outside the workspace?";
  if (cat === "web_fetch") return "Fetch a web resource?";
  return "Allow this action?";
}

function permissionDescription(perm: PermissionRequest): string {
  const meta = perm.metadata ?? {};
  const filepath = typeof meta.filepath === "string" ? meta.filepath : undefined;
  const command = typeof meta.command === "string" ? meta.command : undefined;
  if (filepath) return filepath;
  if (command) return command;
  return perm.permission;
}

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
  const title = permissionTitle(perm);
  const desc = permissionDescription(perm);

  return (
    <div className="manta-perm-card rounded-xl border border-border bg-bg-elev px-4 py-3 text-meta">
      <div className="flex items-start gap-3">
        {/* 30px icon badge — Shield on --warn-bg */}
        <span
          className="manta-perm-badge inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg shrink-0"
          style={{ backgroundColor: "var(--warn-bg)", color: "var(--warn)" }}
        >
          <Shield size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Plain-language title + one-line description */}
          <div className="text-text font-medium mb-px">
            {perm.fromJobName ? `${perm.fromJobName} · ` : ""}{title}
          </div>
          <div className="text-text-muted mb-px">{desc}</div>
          {/* Literal command in its own --inset well */}
          {detail && (
            <div className="rounded-md bg-inset px-2 py-1 mt-2 mb-1 font-mono text-text break-all">
              {detail}
            </div>
          )}
        </div>
      </div>
      {/* Button ladder: primary filled (Always), secondary outlined (Allow
          once), Reject pushed right + tinted only on hover. */}
      <div className="flex items-center gap-2 mt-3">
        {alwaysScope ? (
          <button
            onClick={() => onReply("always")}
            className="px-3 py-1 rounded text-bg text-meta font-medium"
            style={{ backgroundColor: "var(--warn)" }}
            title={`Always allow ${alwaysScope}`}
          >
            Always allow
          </button>
        ) : null}
        <button
          onClick={() => onReply("once")}
          className="px-3 py-1 rounded border border-border-strong text-text hover:bg-bg-soft text-meta"
        >
          Allow once
        </button>
        <button
          onClick={() => onReply("reject")}
          className="ml-auto px-3 py-1 rounded text-danger hover:bg-danger-bg text-meta"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

// ===== Question card =====
//
// BET-415 redesign:
//   - 30px icon badge (HelpCircle on --accent-bg) replaces the whole-card
//     accent outline.
//   - Question options become CHECKBOXES (multi-select aware).
//   - Recommended answers: strip the "(Recommended)" suffix, render a pill,
//     preselect ONLY for single-select.
//   - Multiple questions → numbered sections + "N of M answered" count + one
//     Submit.
//   - Keep the always-visible free-text field and buildQuestionAnswers /
//     canSubmitQuestion helpers.

// The convention for a recommended option is a "(Recommended)" suffix on the
// label. We strip it for display and flag the option as recommended.
const RECOMMENDED_RE = /\s*\(Recommended\)\s*$/i;

function parseRecommended(label: string): { text: string; recommended: boolean } {
  const m = label.match(RECOMMENDED_RE);
  if (m) return { text: label.slice(0, m.index).trim(), recommended: true };
  return { text: label, recommended: false };
}

export function QuestionCard({
  request,
  onReply,
  onReject,
}: {
  request: QuestionRequest;
  onReply: (answers: string[][]) => void;
  onReject: () => void;
}) {
  // Pre-parse options once: strip "(Recommended)" and track which are
  // recommended so we can preselect (single-select only) and badge them.
  // The ORIGINAL label is kept as `origLabel` (the wire key opencode
  // matches on); `label` is the display text.
  const parsedQuestions = request.questions.map((info) => ({
    info,
    options: info.options.map((opt) => {
      const { text, recommended } = parseRecommended(opt.label);
      return { ...opt, displayLabel: text, origLabel: opt.label, recommended };
    }),
  }));

  // The `selected` sets key on the ORIGINAL label so buildQuestionAnswers
  // sends back exactly what opencode expects.
  const [selected, setSelected] = useState<Set<string>[]>(() =>
    parsedQuestions.map((q) => {
      const multiple = q.info.multiple ?? false;
      if (multiple) return new Set<string>(); // never preselect multi-select
      // Single-select: preselect the first recommended option, if any.
      const rec = q.options.find((o) => o.recommended);
      return rec ? new Set([rec.origLabel]) : new Set<string>();
    }),
  );
  const [customValues, setCustomValues] = useState<string[]>(() =>
    request.questions.map(() => ""),
  );

  function toggleOption(qIdx: number, origLabel: string, multiple: boolean) {
    setSelected((prev) => {
      const next = prev.map((s) => new Set(s));
      if (multiple) {
        if (next[qIdx].has(origLabel)) next[qIdx].delete(origLabel);
        else next[qIdx].add(origLabel);
      } else {
        next[qIdx] = new Set([origLabel]);
      }
      return next;
    });
  }

  function handleSubmit() {
    onReply(buildQuestionAnswers(selected, customValues));
  }

  const canSubmit = canSubmitQuestion(selected, customValues);
  const answeredCount = selected.filter(
    (s, i) => s.size > 0 || (customValues[i] ?? "").trim().length > 0,
  ).length;
  const totalQuestions = request.questions.length;
  const isMulti = totalQuestions > 1;

  return (
    <div className="manta-question-card rounded-xl border border-border bg-bg-elev px-4 py-3 text-meta">
      <div className="flex items-start gap-3 mb-3">
        {/* 30px icon badge — HelpCircle on --accent-bg */}
        <span
          className="manta-question-badge inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg shrink-0"
          style={{ backgroundColor: "var(--accent-bg)", color: "var(--accent)" }}
        >
          <HelpCircle size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-text font-medium">
            {request.fromJobName ? `${request.fromJobName} · ` : ""}Question
          </div>
          {isMulti && (
            <div className="text-text-faint">
              {answeredCount} of {totalQuestions} answered
            </div>
          )}
        </div>
        <button
          onClick={onReject}
          className="text-text-faint hover:text-text leading-none inline-flex items-center"
          title="Reject / dismiss"
          aria-label="Reject question"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-3">
        {parsedQuestions.map(({ info, options }, qIdx) => (
          <div key={qIdx}>
            {/* Numbered section header when multiple questions */}
            {isMulti && (
              <div className="text-text-faint text-label mb-px">
                {qIdx + 1}. {info.header}
              </div>
            )}
            {!isMulti && (
              <div className="text-text-muted mb-px font-medium">{info.header}</div>
            )}
            <div className="text-text mb-2 leading-snug">{info.question}</div>

            {/* Checkbox options — multi-select aware */}
            <div className="mt-px flex flex-col gap-1">
              {options.map((opt) => {
                const isSelected = selected[qIdx].has(opt.origLabel);
                const multiple = info.multiple ?? false;
                return (
                  <label
                    key={opt.origLabel}
                    className={
                      "flex items-start gap-2 rounded-md px-2 py-1 cursor-pointer border text-meta transition-colors " +
                      (isSelected
                        ? "border-accent bg-accent-bg"
                        : "border-border hover:bg-bg-soft")
                    }
                    title={opt.description}
                  >
                    <span
                      className={
                        "inline-flex items-center justify-center w-4 h-4 rounded border shrink-0 mt-px " +
                        (isSelected
                          ? "bg-accent-solid border-transparent text-on-accent"
                          : "border-border-strong")
                      }
                      style={isSelected ? { backgroundColor: "var(--accent-solid)" } : undefined}
                    >
                      {isSelected && <Check size={12} aria-hidden="true" />}
                    </span>
                    <span className="text-text min-w-0">{opt.displayLabel}</span>
                    {opt.recommended && (
                      <span
                        className="ml-auto shrink-0 px-2 rounded-sm text-label"
                        style={{
                          backgroundColor: "var(--accent-bg)",
                          color: "var(--accent)",
                        }}
                      >
                        Recommended
                      </span>
                    )}
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={`q-${qIdx}`}
                      checked={isSelected}
                      onChange={() => toggleOption(qIdx, opt.origLabel, multiple)}
                      className="sr-only"
                    />
                  </label>
                );
              })}
            </div>

            {/* Free-text input — always available */}
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
                if (e.key === "Enter" && !e.shiftKey && canSubmit) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="mt-2 w-full rounded border border-border bg-transparent px-2 py-px text-meta text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong"
            />
          </div>
        ))}
      </div>

      <hr className="mx-2 border-border my-3" />

      {/* Button ladder: Cancel (outlined) left, Submit (primary filled) right */}
      <div className="flex justify-end gap-2">
        <button
          onClick={onReject}
          className="px-3 py-1 rounded border border-border text-text-faint hover:text-text text-meta"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-3 py-1 rounded text-on-accent text-meta font-medium disabled:opacity-40"
          style={{ backgroundColor: "var(--accent-solid)" }}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
