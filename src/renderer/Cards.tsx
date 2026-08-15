// ===== Status / interaction cards =====
//
// Leaf cards rendered inline in the transcript when the session needs the
// user's attention or is doing async housekeeping:
//   - RetryCard: provider retry / rate-limit backoff notice.
//   - CompactionCard: live compaction progress.
//   - PermissionCard: tool-approval prompt (once / always / reject).
//   - QuestionCard: the Question tool's multi-choice + free-text form.
//
// PermissionCard and QuestionCard are the same shape — a blocking ask with a
// badge, a title, an optional body and an action row — so they render through
// one shared AskCardShell below (BET-458). BET-415 gave them the 30px icon
// badge, plain-language titles, checkbox question options and a button ladder.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { DraftingCompass, Shield, HelpCircle, Check, Send, ChevronDown, ArrowUpRight, Link2 } from "lucide-react";
import type { PermissionRequest, ProgressRecord, QuestionRequest, OpencodeModel } from "../shared/types";
import {
  buildQuestionAnswers,
  canSubmitQuestion,
  resolveDelegateModel,
  shortModelName,
} from "./chatUtils";
import { resolveActiveModel } from "./chatShared";
import { Card } from "./Card";
import { Pill } from "./Pill";
import { OutputWell } from "./OutputWell";
import { Button, SplitButton } from "./Button";
import { StatusDot } from "./StatusDot";
import { ModelMenu } from "./ModelMenu";
import { renderMarkdown } from "./MarkdownBody";

// ===== Shared ask-card shell (BET-458) =====
//
// One card surface through the Card chrome primitive (edge, radius, padding,
// the transcript measure it inherits) plus badge/title/sub/body/actions
// slots for both ask cards. `text-meta` lives on a wrapper (not Card) because
// Card owns the chrome uniformly and the GroupCard adopters don't use the
// meta size — keeping it here preserves each ask card's inherited 12px text
// with no visual change (BET-531).
function AskCardShell({
  badge,
  badgeBg,
  badgeColor,
  title,
  subtitle,
  body,
  actions,
}: {
  badge: ReactNode;
  badgeBg: string;
  badgeColor: string;
  title: ReactNode;
  subtitle?: ReactNode;
  body?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="text-meta">
      <Card
        elevated
        header={
          <>
            <span
              className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-md shrink-0"
              style={{ backgroundColor: badgeBg, color: badgeColor }}
            >
              {badge}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-text font-medium mb-px">{title}</div>
              {subtitle && <div className="text-text-faint mb-px">{subtitle}</div>}
            </div>
          </>
        }
        actions={actions}
      >
        {body || undefined}
      </Card>
    </div>
  );
}

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
      className="rounded-sm border bg-bg-elev px-4 py-3 text-meta"
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
            className="inline-block px-2 py-px rounded-xs border border-border-strong text-text hover:bg-bg-soft"
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
      className="rounded-sm border bg-bg-elev px-4 py-3 text-meta"
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
// Through AskCardShell with a Shield badge (--warn), a plain-language title,
// and the literal command in a mono well. Button ladder: Allow once is the
// filled accent primary, Always allow <tool> the outlined secondary, Reject
// text-tinted --danger on hover and pushed to the far right.

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

  // Button ladder (the loudest element on screen is the primary action):
  //   Allow once — the FILLED accent primary, with a Check + ⏎ hint.
  //   Always allow <tool> — outlined secondary.
  //   (spacer)
  //   Reject — danger text at rest, gains --danger-bg fill on hover (tone="danger").
  const actions = (
    <>
      <Button tone="primary" onClick={() => onReply("once")}>
        <Check size={13} aria-hidden="true" />
        Allow once
        <span className="text-on-accent opacity-70" aria-hidden="true">
          ⏎
        </span>
      </Button>
      {alwaysScope ? (
        <Button
          tone="default"
          onClick={() => onReply("always")}
          title={`Always allow ${alwaysScope}`}
        >
          Always allow&nbsp;
          <span className="text-text-faint">{alwaysScope}</span>
        </Button>
      ) : null}
      {/* spacer pushes Reject to the far right */}
      <div className="flex-1" />
      <Button tone="danger" onClick={() => onReply("reject")}>
        Reject
      </Button>
    </>
  );

  return (
    <AskCardShell
      badge={<Shield size={16} aria-hidden="true" />}
      badgeBg="var(--warn-bg)"
      badgeColor="var(--warn)"
      title={title}
      subtitle={desc}
      body={
        detail ? (
          // The literal command in its own recessed well — only for permissions.
          <OutputWell variant="standalone">{detail}</OutputWell>
        ) : null
      }
      actions={actions}
    />
  );
}

// ===== Question card =====
//
// Through AskCardShell with a HelpCircle badge (--accent). Options are
// checkboxes (multi-select aware); recommended answers strip the
// "(Recommended)" suffix, badge as a pill and preselect only for
// single-select. Multiple questions → numbered sections + "N of M answered"
// + one Submit. One dismissal affordance: the trailing Dismiss text action.

// The "<label> (Recommended)" suffix convention; stripped for display.
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
  // Defensive: a malformed payload (missing `questions`, or a question with no
  // `options`) must not throw and blank the app. Normalize to safe arrays.
  const rawQuestions = Array.isArray(request.questions) ? request.questions : [];

  // Pre-parse options once: strip "(Recommended)" and track which are
  // recommended so we can preselect (single-select only) and badge them.
  // The ORIGINAL label is kept as `origLabel` (the wire key opencode
  // matches on); `label` is the display text.
  const parsedQuestions = rawQuestions.map((info) => ({
    info,
    options: (Array.isArray(info.options) ? info.options : []).map((opt) => {
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
    rawQuestions.map(() => ""),
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
  const totalQuestions = rawQuestions.length;
  const isMulti = totalQuestions > 1;
  const singleInfo = totalQuestions === 1 ? parsedQuestions[0]?.info : undefined;

  // One option row — the spec's full-width `.opt` button. Selected/hover →
  // border-accent + accent-bg; the `.mk` mark is the 15px checkbox square,
  // filled with the accent-solid + Check icon when selected. Rendered as a
  // real accessible control: an sr-only radio/checkbox drives the same
  // toggleOption logic (origLabel stays the selection key).
  function renderOption(
    qIdx: number,
    multiple: boolean,
    opt: { origLabel: string; displayLabel: string; description: string; recommended: boolean },
  ) {
    const isSelected = selected[qIdx].has(opt.origLabel);
    return (
      <label
        key={opt.origLabel}
        className={
          "flex items-center w-full text-left rounded-md border px-3 py-[10px] cursor-pointer text-label font-medium transition-colors " +
          (isSelected
            ? "border-accent bg-accent-bg"
            : "border-border bg-bg hover:border-accent hover:bg-accent-bg")
        }
        title={opt.description}
      >
        <span
          className={
            "inline-flex items-center justify-center w-[15px] h-[15px] rounded-xs border shrink-0 mr-2 " +
            (isSelected
              ? "border-transparent text-on-accent"
              : "border-border-strong")
          }
          style={isSelected ? { backgroundColor: "var(--accent-solid)" } : undefined}
        >
          {isSelected && <Check size={10} strokeWidth={4} aria-hidden="true" />}
        </span>
        <span className="text-text min-w-0">{opt.displayLabel}</span>
        {opt.recommended && (
          // The "Recommended" standing tag — a GREEN Pill placed INLINE right
          // after the label. Pill owns the chrome; ml-2 is the placement.
          <span className="ml-2 shrink-0">
            <Pill tone="ok" size="label">
              Recommended
            </Pill>
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
  }

  // The `.ask-free` free-text box — a bordered container with a leading Send
  // icon and a transparent input. Enter submits when the request is answerable.
  function renderFreeText(qIdx: number) {
    return (
      <div className="flex items-center gap-2 border border-border rounded-md bg-bg px-3 py-2">
        <Send size={14} aria-hidden="true" className="text-text-quiet shrink-0" />
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
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-meta text-text placeholder:text-text-faint"
        />
      </div>
    );
  }

  return (
    <AskCardShell
      badge={<HelpCircle size={16} aria-hidden="true" />}
      badgeBg="var(--accent-bg)"
      badgeColor="var(--accent-tx)"
      // Single question → the header IS the question (2-line: header + question
      // sub). Multiple → keep a generic "Question" card title; each sub-question
      // renders its own numbered block in the body.
      title={isMulti ? "Question" : singleInfo?.header ?? "Question"}
      subtitle={isMulti ? undefined : singleInfo?.question}
      body={
        <>
          <div className="space-y-3">
            {parsedQuestions.map(({ info, options }, qIdx) => {
              const multiple = info.multiple ?? false;
              return (
                <div key={qIdx}>
                  {/* Multi-question: a numbered `.qb` block with a circular */}
                  {/* badge + question + `em` context, separated by `.qsep`. */}
                  {isMulti && (
                    <>
                      {qIdx > 0 && <div className="h-px bg-border-subtle mb-3" />}
                      <div className="flex items-start gap-2 mb-2">
                        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-fill-active text-text-faint font-mono font-semibold text-micro shrink-0">
                          {qIdx + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="text-text font-semibold text-label leading-snug">
                            {info.header}
                          </div>
                          <div className="text-text-faint text-meta leading-snug mt-px">
                            {info.question}
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Full-width `.opt` option buttons. */}
                  <div className="space-y-2">
                    {options.map((opt) => renderOption(qIdx, multiple, opt))}
                  </div>

                  {/* `.ask-free` free-text box — always available. */}
                  <div className="mt-2">{renderFreeText(qIdx)}</div>
                </div>
              );
            })}
          </div>

          <hr className="border-border-subtle my-3" />
        </>
      }
      actions={
        <>
          {/* Submit FIRST — the filled accent primary with a trailing ⏎ hint. */}
          <Button tone="primary" onClick={handleSubmit} disabled={!canSubmit}>
            Submit
            <span className="text-on-accent opacity-70" aria-hidden="true">
              ⏎
            </span>
          </Button>
          {/* Multi-question progress — mono `.prog`. */}
          {isMulti && (
            <span className="text-text-faint text-meta font-mono ml-2">
              {answeredCount} of {totalQuestions} answered
            </span>
          )}
          {/* spacer pushes Dismiss to the far right */}
          <div className="flex-1" />
          <Button tone="ghost" onClick={onReject} title="Dismiss this question">
            Dismiss
          </Button>
        </>
      }
    />
  );
}

// ===== Plan card (BET-951) =====
//
// Upgrades the plan_exit question (detected EXACTLY via isPlanExitQuestion —
// the matching `plan_exit` tool callID, never the question text) into a
// dedicated card. Rendered in the transcript TAIL, the same way the question
// cards are (it used to be pinned in the card stack). It is an unanswered ask
// like the questions beside it, never below an ambient card.
//
// The delegate split reuses the shared split control (SplitButton — the Button
// chrome brother of SplitChip) fed by the EXISTING ModelMenu; model precedence
// lives in resolveDelegateModel (a pure chatUtils helper), never inline here.

export function PlanCard({
  data,
  models,
  remembered,
  sessionModel,
  buildModelName,
  atDelegateCap,
  onBuildHere,
  onKeepPlanning,
  onStartDelegate,
  onRememberDelegateModel,
  onOpenInBrowser,
  planUrl = null,
  planPublishing = false,
}: {
  data: { title: string; path?: string; metrics: { steps?: number; files?: number } };
  models: Array<[string, OpencodeModel[]]> | null;
  remembered: import("./chatShared").ModelSelection | null;
  sessionModel: import("./chatShared").ModelSelection | null;
  buildModelName: string;
  atDelegateCap: boolean;
  onBuildHere: (feedback: string) => void;
  onKeepPlanning: (feedback: string) => void;
  onOpenInBrowser: () => void;
  onStartDelegate: (
    model: import("./chatShared").ModelSelection | null,
    feedback: string,
  ) => void;
  onRememberDelegateModel: (model: import("./chatShared").ModelSelection | null) => void;
  /** Eagerly-published shareable page URL for this session's plan (before plan_exit). */
  planUrl?: string | null;
  /** True while the page is being published. */
  planPublishing?: boolean;
}) {
  // Level 1 of the model precedence — an explicit pick made on THIS card wins
  // while it is open. Written through to the remembered key on pick (see
  // onRememberDelegateModel) so it survives reopening.
  const [picked, setPicked] = useState<import("./chatShared").ModelSelection | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  const resolution = useMemo(
    () => resolveDelegateModel({ picked, remembered, sessionModel, selectable: models }),
    [picked, remembered, sessionModel, models],
  );
  const delegateModel = resolution.model;
  const allModels = useMemo(() => models?.flatMap(([, ms]) => ms) ?? [], [models]);
  const resolvedOpencode = useMemo(
    () => resolveActiveModel(allModels, delegateModel, null),
    [allModels, delegateModel],
  );
  // The right segment names the model the way every other picker does — the
  // human name, shortened past its brand prefix exactly as the composer chip
  // shortens it (shortModelName). The raw modelID is the LAST resort, for a
  // model that is not in the loaded catalog at all.
  const modelLabel =
    shortModelName(resolvedOpencode?.name) ?? delegateModel?.modelID ?? "model";

  // `N steps · N files` — each clause omitted (never `0`) when not derivable.
  const metricsLine = [
    data.metrics.steps ? `${data.metrics.steps} steps` : null,
    data.metrics.files ? `${data.metrics.files} files` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const busy = atDelegateCap;

  const body = (
    <>
      {(metricsLine || data.path) && (
        <div className="text-text-faint mb-px">
          {metricsLine}
          {metricsLine && data.path ? " · " : ""}
          {data.path && <span className="text-text-quiet">{data.path}</span>}
        </div>
      )}
      {/* Free-text feedback — QuestionCard's field recipe verbatim. */}
      <div className="flex items-center gap-2 border border-border rounded-md bg-bg px-3 py-2 mt-2">
        <Send size={14} aria-hidden="true" className="text-text-quiet shrink-0" />
        <input
          type="text"
          placeholder="Anything to change before we start?"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-meta text-text placeholder:text-text-faint"
        />
      </div>
      {/* Once the page is published (eager, before plan_exit) surface the URL so
          the reader can open/share it without clicking anything. */}
      {planUrl && (
        <div
          className="flex items-center gap-1 text-meta text-text-quiet mt-2 truncate"
          title={planUrl}
        >
          <Link2 size={13} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{planUrl}</span>
        </div>
      )}
    </>
  );

  // Actions, in order: [Build here] [Delegate ▾] [See in browser ↗] spacer [Keep planning].
  const splitTitle = busy
    ? "Too many background jobs running (5)"
    : "Start a background job in its own worktree";
  const actions = (
    <>
      <Button tone="primary" onClick={() => onBuildHere(feedback)}>
        Build here
      </Button>
      <SplitButton
        left="Delegate"
        right={
          <span className="flex items-center gap-1 truncate">
            <span className="truncate max-w-[110px]">{modelLabel}</span>
            <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-text-faint" />
          </span>
        }
        onLeftClick={() => onStartDelegate(delegateModel, feedback)}
        onRightClick={() => setMenuOpen((o) => !o)}
        rightAccent={resolution.overridden}
        rightExpanded={menuOpen}
        rightBtnRef={modelBtnRef}
        leftHook="manta-plan-delegate-btn"
        rightHook="manta-plan-delegate-model-btn"
        leftTitle={splitTitle}
        rightTitle={busy ? splitTitle : "Model this background job will run on"}
        disabled={busy}
        loading={models === null}
      />
      <Button
        tone="ghost"
        onClick={onOpenInBrowser}
        loading={planPublishing}
        disabled={planPublishing}
        title={
          planUrl
            ? "Open the published plan page"
            : data.path
              ? "Publish this plan to a shareable page and open it"
              : undefined
        }
        hook="manta-plan-open-page"
      >
        {planUrl ? "Open page" : planPublishing ? "Publishing…" : "See in browser"}
        <ArrowUpRight size={14} aria-hidden="true" />
      </Button>
      <div className="flex-1" />
      <Button tone="ghost" onClick={() => onKeepPlanning(feedback)}>
        Keep planning
      </Button>
    </>
  );

  return (
    <>
      <AskCardShell
        badge={<DraftingCompass size={16} aria-hidden="true" />}
        badgeBg="var(--accent-bg)"
        badgeColor="var(--accent-tx)"
        title={data.title}
        subtitle={buildModelName ? `Ready to build · ${buildModelName}` : "Ready to build"}
        body={body}
        actions={actions}
      />
      {menuOpen && (
        <ModelMenu
          open={menuOpen}
          anchorRef={modelBtnRef}
          groups={models}
          modelOverride={delegateModel}
          defaultModel={null}
          // "Same as current" = the session's BUILD model — never the plan
          // model (the composer chip may be showing the plan model while plan
          // mode is on). Sending a background job to the planning model is the
          // bug the precedence order exists to prevent.
          defaultRow={{ label: "Same as this session", sub: buildModelName }}
          onSelect={(m) => {
            setPicked(m);
            onRememberDelegateModel(m);
            setMenuOpen(false);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}

// ===== Blocked progress card (BET-791 [C9]) =====
//
// The ONE card a progress state earns: a model has reported — in its own
// words — that it stopped and needs a human decision. Warn-toned, it is
// registered in ChatPanel's card stack as a blocking-tier ask, alongside
// permission and question and never below an ambient card. It is NOT
// dismissible by × — it clears when the model reports a different state or
// the turn ends. Headline is 13px/600 `--tx1` with a warn dot; the body is
// the model's `detail` run through the transcript's markdown treatment so
// inline `code` renders like it does in the transcript.
export function BlockedProgressCard({ progress }: { progress: ProgressRecord }) {
  return (
    <Card warn>
      <div className="flex items-center gap-2">
        <StatusDot tone="warn" />
        <span className="text-text font-semibold" style={{ fontSize: 13 }}>
          Blocked — needs a decision
        </span>
      </div>
      {progress.detail ? (
        <div className="mt-2 text-text-muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          {renderMarkdown(progress.detail)}
        </div>
      ) : null}
    </Card>
  );
}
