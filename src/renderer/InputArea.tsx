// ===== Composer / input area =====
//
// Extracted from ChatPanel.tsx (M0.5). The bottom composer and its immediate
// helpers:
//   - SessionToolbar: ⏰/🔑/🪝 footer toggles.
//   - AttachmentStrip: uploaded-file chips above the textarea.
//   - TypeaheadPopup: @-file / @-agent / /command completion list (visual +
//     mouse; keyboard nav is driven by InputArea).
//   - MicButton: press-and-hold voice affordance (inline + mobile PTT FAB).
//   - InputArea: the textarea row, footer (model picker + context bar +
//     toolbar), and trust toggle. Purely presentational — all state and
//     handlers are passed in as props by ChatPanel.

import { useEffect, useRef, useState } from "react";
import type { OpencodeModel } from "../shared/types";
import type { VoiceMode, VoicePhase } from "./voice";
import {
  ASSUMED_CONTEXT_TOKENS,
  computeContextBreakdown,
  resolveContextLimit,
  type StaleCacheResult,
} from "./chatUtils";
import {
  CLAUDE_ORANGE,
  type Attachment,
  type ModelSelection,
  type TokenUsage,
  type TypeaheadRow,
} from "./chatShared";
import { ContextBar } from "./ContextBar";
import { ModelPicker } from "./ModelPicker";

// SessionToolbar — footer affordances. fork / compact / delete moved out of the
// footer (they live in the header ⋯ menu); only the ⏰ schedules toggle remains
// here so its live count is always visible next to the composer.
function SessionToolbar({
  scheduleCount,
  onSchedules,
  onSecrets,
  onWebhooks,
}: {
  scheduleCount: number;
  onSchedules: () => void;
  onSecrets: () => void;
  onWebhooks: () => void;
}) {
  return (
    <span className="flex items-center gap-1 text-[10px]">
      <button
        onClick={onSchedules}
        className="px-1.5 py-px rounded text-text-faint hover:text-text-muted"
        title="View / cancel scheduled tasks"
      >
        ⏰ schedules{scheduleCount > 0 ? ` (${scheduleCount})` : ""}
      </button>
      <button
        onClick={onSecrets}
        className="px-1.5 py-px rounded text-text-faint hover:text-text-muted"
        title="Manage secrets the agent can use (values never enter the chat)"
      >
        🔑 secrets
      </button>
      <button
        onClick={onWebhooks}
        className="px-1.5 py-px rounded text-text-faint hover:text-text-muted"
        title="View / revoke inbound webhooks (external events that wake this session)"
      >
        🪝 webhooks
      </button>
    </span>
  );
}

// ===== Attachment chips =====
//
// Strip of chips above the input. Each chip carries filename + status. Click
// the × to remove. Uploading shows a small spinner; error tints red with the
// remote error in the tooltip.

export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  // pt-2 above + pb-2 below leaves a clear gap between the chip row and the
  // input area's top border.
  return (
    <div className="shrink-0 px-4 pt-2 pb-2 flex flex-wrap gap-1 text-[11px]">
      {attachments.map((a) => {
        const color =
          a.status === "error"
            ? "text-red-300 border-red-500/30"
            : a.status === "uploading"
              ? "text-text-faint border-border"
              : "text-text border-border-strong";
        return (
          <span
            key={a.id}
            className={`rounded-md border px-1.5 py-0.5 flex items-center gap-1 bg-bg-elev ${color}`}
            title={a.status === "error" ? a.errorMsg : a.remotePath}
          >
            {a.status === "uploading" && (
              <span className="inline-block animate-spin" style={{ color: CLAUDE_ORANGE }}>
                ↻
              </span>
            )}
            <span className="truncate max-w-[200px]">{a.filename}</span>
            <button
              onClick={() => onRemove(a.id)}
              className="text-text-faint hover:text-red-300 leading-none px-0.5"
              title="Remove"
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

// ===== Typeahead popup =====
//
// Anchored above the input area; rows for command/agent/file results. Keyboard
// nav is handled by InputArea (Up/Down/Enter/Tab/Esc) — this component is
// purely visual + mouse selection.

export function TypeaheadPopup({
  rows,
  selectedIdx,
  onSelect,
  onHover,
  emptyHint,
}: {
  rows: TypeaheadRow[];
  selectedIdx: number;
  onSelect: (row: TypeaheadRow) => void;
  onHover: (idx: number) => void;
  emptyHint: string;
}) {
  return (
    <div className="shrink-0 mx-4 mb-1 max-h-[240px] overflow-y-auto rounded border border-border bg-bg-elev shadow-lg text-[12px]">
      {rows.length === 0 && (
        <div className="px-2 py-1 text-text-faint italic">{emptyHint}</div>
      )}
      {rows.map((row, idx) => {
        const active = idx === selectedIdx;
        // Special-case the "no attachment support" warning row — render in
        // red, non-selectable (clicking is a no-op).
        const isWarning = row.kind === "file" && row.key === "" && row.primary.startsWith("⚠");
        if (isWarning) {
          return (
            <div
              key={`warn:${idx}`}
              className="px-2 py-1 flex items-center gap-2 text-red-300 bg-red-900/15 cursor-default"
            >
              <span className="truncate flex-1">{row.primary}</span>
              {row.secondary && (
                <span className="text-red-400/70 truncate max-w-[50%] text-[11px]">
                  {row.secondary}
                </span>
              )}
            </div>
          );
        }
        return (
          <button
            key={`${row.kind}:${row.key}`}
            onClick={() => onSelect(row)}
            onMouseEnter={() => onHover(idx)}
            className={
              "w-full text-left px-2 py-1 flex items-center gap-2 " +
              (active ? "bg-bg-soft text-text" : "text-text-muted hover:bg-bg-soft")
            }
          >
            <span className="truncate flex-1">{row.primary}</span>
            {row.secondary && (
              <span className="text-text-faint truncate max-w-[50%] text-[11px]">
                {row.secondary}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ===== Input area =====

// Press-and-hold mic button. Plain tap = dictate (transcript inserted at
// caret). Hold + ⌥ on desktop, or a long-press (≥500ms) on touch, = command
// mode (transcript routed through the rules classifier + Groq llama).
//
// **Mode source of truth lives in `useVoiceRecorder`** — see the W2 fix in
// PR #4 review. The previous design kept a parallel `modeRef` in the
// button which never propagated to the hook, so long-press on touch
// transcribed as dictate. The button now passes "dictate" or "command"
// at press time (based on the ⌥ modifier) and the HOOK schedules the
// long-press promotion + exposes the current mode for the label.
//
// Visual states (phase):
//   - idle       → microphone glyph in text-muted
//   - requesting → spinner in text-faint (waiting on mic permission)
//   - recording  → filled circle pulsing in red, hint text "release to send"
//   - processing → spinner in accent (Groq round-trip in flight)
//   - error      → muted-red mic; click to retry by pressing again
function MicButton({
  phase,
  mode,
  onStart,
  onStop,
  onCancel,
  floating = false,
}: {
  phase: VoicePhase;
  mode: VoiceMode;
  onStart: (mode: VoiceMode, opts?: { promote?: boolean }) => Promise<void>;
  onStop: () => void;
  onCancel: () => void;
  // `floating` = the mobile WhatsApp-style push-to-talk FAB (bottom-right,
  // above the composer). It is dictation-only: it starts in "dictate" with
  // promotion DISABLED so a normal speak-length hold isn't reclassified as a
  // voice command. The inline (non-floating) variant keeps the desktop ⌥ /
  // long-press → command behavior.
  floating?: boolean;
}) {
  const recording = phase === "recording" || phase === "requesting";
  const busy = phase === "processing";

  // Track press state with a REF, not the rendered `recording` prop. This is
  // THE fix for "hold → red → release → nothing happens": the pointerup
  // handler used to gate on `recording`, which is derived from the `phase`
  // PROP. Phase transitions (idle→requesting→recording) are async React
  // state updates in the parent hook; the button only re-renders once they
  // propagate. If the user releases before `phase` has re-rendered to
  // "recording" (fast on a snappy device, or always during the "requesting"
  // window), the closure's `recording` was still false → `onStop()` was
  // never called → the recorder ran until the 60s maxDuration cap, silently.
  // A ref flips synchronously on pointerdown so release ALWAYS reaches stop.
  const pressActiveRef = useRef(false);

  // Pointer-based handlers — single code path for mouse + touch + pen so
  // we don't have to worry about emulated mouse events firing AFTER touch
  // on iOS / Android WebView (the classic "double-tap" bug).
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (busy || pressActiveRef.current) return;
    e.preventDefault();
    pressActiveRef.current = true;
    if (floating) {
      // PTT FAB: always plain dictation, no command promotion.
      onStart("dictate", { promote: false });
    } else {
      // Desktop ⌥-modifier promotes to command IMMEDIATELY. Otherwise we
      // start in dictate and let the hook's longPressMs timer flip us.
      const initial: VoiceMode = e.altKey ? "command" : "dictate";
      onStart(initial);
    }
    // Capture so onPointerUp fires even if the cursor leaves the button.
    try {
      (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    } catch { /* not all browsers support pointer capture */ }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressActiveRef.current) return;
    pressActiveRef.current = false;
    e.preventDefault();
    // Always stop (not cancel) on a deliberate release — even if `phase` is
    // still "requesting" (the recorder hasn't been constructed yet). The
    // hook's stop() handles the requesting-window case: it records a
    // stop-requested intent so the in-flight getUserMedia tears down cleanly
    // instead of recording to the cap. A genuine too-quick press surfaces as
    // the onEmpty("too-short") notice, never silence.
    onStop();
  };

  const handlePointerCancel = () => {
    // pointercancel is an OS-level abort of the gesture (scroll took over,
    // app backgrounded). That's the one case where discarding is right.
    if (!pressActiveRef.current) return;
    pressActiveRef.current = false;
    onCancel();
  };

  const label = busy
    ? "transcribing…"
    : recording
      ? floating
        ? "release to insert"
        : mode === "command"
          ? "release · command"
          : "release · dictate"
      : floating
        ? "hold to talk"
        : "hold to speak (⌥ = command)";

  // Floating PTT FAB: round bubble, bottom-right (positioned by the
  // `.mobile-ptt-fab` rule in mobile.css — visual/layout lives there per the
  // mobile-CSS invariant; this component only sets state modifier classes).
  if (floating) {
    return (
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        title={label}
        aria-label={label}
        className={
          "mobile-ptt-fab" +
          (busy
            ? " mobile-ptt-fab--busy"
            : recording
              ? " mobile-ptt-fab--recording"
              : phase === "error"
                ? " mobile-ptt-fab--error"
                : "")
        }
        style={{ touchAction: "none" }}
      >
        {busy ? "⋯" : "🎙"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      title={label}
      aria-label={label}
      // Inline glyph button — matches the `>` prompt next to it in size and
      // baseline so the input row stays one-line-tall when the textarea has
      // a single line. No round background bubble (the previous w-7 h-7
      // version forced the row to 28px and made it visually two lines).
      // Recording adds a subtle pulse on the glyph itself; busy swaps to a
      // dots spinner. Pointer-capture is still set on pointerdown so we
      // get the pointerup even if the user drifts off.
      className={
        "select-none pt-px shrink-0 leading-none bg-transparent " +
        (busy
          ? "text-accent cursor-progress"
          : recording
            ? "text-red-400 animate-pulse"
            : phase === "error"
              ? "text-red-400 hover:text-red-300"
              : "text-text-faint hover:text-text-muted")
      }
      style={{ touchAction: "none" }}  // suppress mobile pull-to-refresh
    >
      {busy ? "⋯" : "🎙"}
    </button>
  );
}

export function InputArea({
  input,
  setInput,
  inputRef,
  submit,
  abort,
  running,
  branch,
  refreshing,
  modelLabel,
  chatAutoAllow,
  setChatAutoAllow,
  voiceEnabled,
  voicePhase,
  voiceMode,
  voiceRecording,
  voiceProcessing,
  startVoice,
  stopVoice,
  cancelVoice,
  tokens,
  staleCache,
  models,
  modelOverride,
  defaultModel,
  activeModel,
  onOpenModels,
  onSelectModel,
  scheduleCount,
  onSchedules,
  onSecrets,
  onWebhooks,
  typeaheadOpen,
  typeaheadExactMatch,
  onTypeaheadConfirm,
  onTypeaheadMove,
  onTypeaheadCancel,
  onHistoryUp,
  onHistoryDown,
  onQueuePop,
  onPaste,
}: {
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  submit: () => void;
  abort: () => void;
  running: boolean;
  branch: string | null;
  refreshing: boolean;
  modelLabel: string | null;
  chatAutoAllow: boolean;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  // Voice (Groq STT). When voiceEnabled=false the MicButton is hidden so
  // users without a configured API key never see the affordance. start/stop/
  // cancel come from useVoiceRecorder; phase drives the icon state; mode is
  // owned by the hook (W2: previously the button kept its own copy and the
  // two drifted, so long-press never reached the hook as "command").
  voiceEnabled: boolean;
  voicePhase: VoicePhase;
  voiceMode: VoiceMode;
  // Derived flags so the input row's pulse class doesn't need to recompute
  // these on every keystroke. "recording" covers both pre-permission
  // (requesting) and active capture; "processing" is the post-stop
  // transcribe round-trip. Both render the same pulsing affordance — the
  // user only cares "is the mic busy".
  voiceRecording: boolean;
  voiceProcessing: boolean;
  startVoice: (mode: VoiceMode, opts?: { promote?: boolean }) => Promise<void>;
  stopVoice: () => void;
  cancelVoice: () => void;
  tokens: TokenUsage | null;
  // Stale-prompt-cache result: when isStale is true the footer shows
  // "/clear to save Nk tokens" next to the context bar. Computed at the
  // panel scope so the tick interval doesn't run inside InputArea.
  staleCache: StaleCacheResult;
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  // Active model resolved by the parent (modelOverride ?? defaultModel,
  // looked up against `models`). Used to size the context bar against the
  // real provider window (e.g. 1M for Opus 4.7) instead of the 200k
  // fallback — without this the bar saturates at "100%" while the
  // provider happily keeps serving requests, which is misleading.
  activeModel: OpencodeModel | null;
  onOpenModels: () => void;
  onSelectModel: (m: ModelSelection | null) => void;
  scheduleCount: number;
  onSchedules: () => void;
  onSecrets: () => void;
  onWebhooks: () => void;
  typeaheadOpen: boolean;
  typeaheadExactMatch: boolean;
  onTypeaheadConfirm: () => void;
  onTypeaheadMove: (dir: 1 | -1) => void;
  onTypeaheadCancel: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onQueuePop: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  // Persistent context usage — shown next to the model name in the footer
  // whenever the session has had at least one assistant turn (tokens > 0).
  // The running indicator above shows the LIVE version while generating;
  // this one is the resting baseline.
  //
  // Denominator is the ACTIVE model's real context window when known
  // (Opus 4.7 = 1M, Sonnet 4 = 200k, etc.) so the bar reflects what the
  // provider will actually accept on the next request. Falls back to
  // ASSUMED_CONTEXT_TOKENS (200k) when no model is selected yet.
  // Context window numerator = input + cache.read + cache.write. All three
  // input buckets are disjoint and ALL consume the request's context window;
  // the previous formula omitted cache.write and under-reported the bar on
  // cache-warming turns. computeContextBreakdown also produces the per-
  // segment widths the SEGMENTED ContextBar needs (uncached vs warm vs
  // cached) so the user can see the warm-up bucket without hovering.
  const ctxLimit = resolveContextLimit(activeModel);
  const ctxBreakdown = computeContextBreakdown(tokens, ctxLimit);
  const ctxTokens = ctxBreakdown.totalInput;
  const ctxPct = ctxBreakdown.pct;
  // Detect mobile shell (touch device using the no-window.api branch with
  // MobileApp + .mobile-body wrapper). MicButton is only rendered there;
  // on desktop the keyboard shortcut (Ctrl+M / Enter / Esc) drives voice.
  // Read once on mount via a ref callback so we don't pay a per-render
  // closest() cost.
  const [isMobileShell, setIsMobileShell] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (rowRef.current) {
      setIsMobileShell(!!rowRef.current.closest(".mobile-body"));
    }
  }, []);
  // Pulsing border on the input row while the recorder is active OR the
  // transcribe round-trip is in flight. Same affordance for both phases
  // (the user only cares "the mic is busy"). Implemented as a color +
  // shadow swap on the existing top/bottom dividers — border width stays
  // 1px in both states so there's no row jump when recording toggles.
  const voiceActive = voiceRecording || voiceProcessing;
  return (
    <div className="shrink-0" ref={rowRef}>
      {/* Mobile push-to-talk FAB (WhatsApp-style, bottom-right above the
          composer). Hold to record, release to insert the transcript into
          the composer for review. Positioned + sized by `.mobile-ptt-fab` in
          mobile.css; only rendered in the mobile shell with a Groq key set.
          Desktop voice stays keyboard-driven (Ctrl+M / Enter / Esc). */}
      {voiceEnabled && isMobileShell && (
        <MicButton
          phase={voicePhase}
          mode={voiceMode}
          onStart={startVoice}
          onStop={stopVoice}
          onCancel={cancelVoice}
          floating
        />
      )}
      {/* Error banner moved to ChatPanel scope (dismissable + closer to the */}
      {/* attachment strip). Nothing rendered here for sendError anymore. */}
      {/* Top divider — white-ish, matches Claude TUI. Turns into a pulsing */}
      {/* red line while voice is active so the user has clear peripheral */}
      {/* feedback that the mic is hot (the `>` glyph also recolors red). */}
      {/* Border width stays at 1px in both states to avoid a 1px row jump */}
      {/* when recording starts/stops. */}
      <div
        className={
          voiceActive
            ? "border-t border-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.6)]"
            : "border-t border-text/25"
        }
      />
      {/* Input row — no box, generous vertical padding. The mic affordance */}
      {/* on desktop is keyboard-only (Ctrl+M to toggle, Enter to stop+send, */}
      {/* Esc to cancel); the visible feedback is the pulsing border above + */}
      {/* below this row. On mobile the mic lives in the floating PTT FAB */}
      {/* above the composer (rendered at the top of this wrapper). */}
      <div className="px-4 py-3 flex items-start gap-2">
        <span
          className="select-none pt-px shrink-0"
          style={{ color: voiceActive ? "#f87171" : CLAUDE_ORANGE }}
          title={
            voiceActive
              ? voiceProcessing
                ? "Transcribing… (esc cancels)"
                : "Recording — enter to send, ctrl+m to stop, esc to cancel"
              : undefined
          }
        >
          {">"}
        </span>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Typeahead nav. Arrows move, Tab/Enter insert the highlighted
            // row, Esc dismisses. EXCEPTION: when the input text already
            // exactly matches the highlighted row's primary (e.g. user typed
            // `/clear` fully), Enter dismisses the popup and SUBMITS so the
            // command executes in one keystroke instead of two.
            if (typeaheadOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                onTypeaheadMove(1);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                onTypeaheadMove(-1);
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                onTypeaheadConfirm();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (typeaheadExactMatch) {
                  onTypeaheadCancel();
                  submit();
                } else {
                  onTypeaheadConfirm();
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onTypeaheadCancel();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              submit();
              return;
            }
            // Prompt history when typeahead is closed. Only navigate history
            // when the caret is already on the first line (Up) or last line
            // (Down) — otherwise let the cursor move within the multiline text.
            // While running, Up on an empty-or-first-line input pops the last
            // queued message back into the input so it can be edited/removed.
            if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const el = e.currentTarget;
              const textBefore = el.value.slice(0, el.selectionStart ?? 0);
              const onFirstLine = !textBefore.includes("\n");
              if (onFirstLine) {
                e.preventDefault();
                if (running && el.value.trim() === "") {
                  onQueuePop();
                } else {
                  onHistoryUp();
                }
              }
              return;
            }
            if (e.key === "ArrowDown" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const el = e.currentTarget;
              const textAfter = el.value.slice(el.selectionEnd ?? el.value.length);
              const onLastLine = !textAfter.includes("\n");
              if (onLastLine) {
                e.preventDefault();
                onHistoryDown();
              }
              return;
            }
            if (e.key === "Escape" && running) {
              e.preventDefault();
              abort();
            }
          }}
          onPaste={onPaste}
          placeholder={running ? "Queue a message…  (⏎ to queue · Esc to stop)" : "Try something…  (@ files · / commands · tab insert · ⏎ send)"}
          rows={1}
          spellCheck={false}
          className="flex-1 resize-none bg-transparent text-text text-[13px] focus:outline-none placeholder:text-text-faint font-mono"
          style={{ maxHeight: "140px", lineHeight: "1.5" }}
        />
      </div>
      {/* Bottom divider — mirrors the top so the pulsing voice ring */}
      {/* frames the input row on both sides. */}
      <div
        className={
          voiceActive
            ? "border-t border-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.6)]"
            : "border-t border-text/25"
        }
      />
      {/* Meta footer — model picker + ctx bar on the left, session ops + hints right. */}
      {/* NOTE: don't put `truncate` on this row's spans — it triggers */}
      {/* overflow:hidden which clips the model picker's absolute dropdown. */}
      <div className="px-4 py-2 flex items-center justify-between gap-3">
        <span className="flex items-center gap-3 min-w-0">
          {branch && (
            <span
              className="text-text-faint shrink-0 truncate max-w-[160px]"
              title={`Current branch: ${branch}`}
            >
              ⎇ {branch}
            </span>
          )}
          {refreshing && (
            <span
              className="text-text-faint shrink-0 animate-pulse"
              title="Refreshing transcript from opencode (large sessions can take 20–30s)"
            >
              ↻ refreshing…
            </span>
          )}
          <ModelPicker
            modelLabel={modelLabel}
            models={models}
            modelOverride={modelOverride}
            defaultModel={defaultModel}
            onOpen={onOpenModels}
            onSelect={onSelectModel}
          />
          {ctxTokens > 0 && (
            <ContextBar
              breakdown={ctxBreakdown}
              limit={ctxLimit}
              staleCache={staleCache}
              modelName={
                activeModel
                  ? activeModel.name
                  : `(fallback ${ASSUMED_CONTEXT_TOKENS.toLocaleString()}-token window)`
              }
              tooltip={
                // Action hint scales with how close we are to the wall.
                // 100% on the real model limit means the next request will
                // very likely truncate or hit `model_context_window_exceeded`
                // — make the remediation explicit instead of letting the
                // user discover it from a truncated reply. Bucket-level
                // breakdown is provided by ContextBar itself; this tooltip
                // is only the *hint* line.
                ctxPct >= 100
                  ? "Compact recommended — run /compact to free space"
                  : ctxPct >= 90
                    ? "Approaching limit — consider /compact soon"
                    : undefined
              }
            />
          )}
        </span>
        <span className="shrink-0 flex items-center gap-3">
          <SessionToolbar
            scheduleCount={scheduleCount}
            onSchedules={onSchedules}
            onSecrets={onSecrets}
            onWebhooks={onWebhooks}
          />
          {/* Transient status only — recording / interrupt feedback. The static */}
          {/* keyboard-hint (shift+⏎ newline · ⏎ send) was removed to declutter. */}
          {(voiceActive || running) && (
            <span className="text-[10px] text-text-faint">
              {voiceActive
                ? voiceProcessing
                  ? "transcribing… · esc cancels"
                  : "🎙 recording · ⏎ send · ctrl+m stop · esc cancel"
                : "esc · interrupt"}
            </span>
          )}
        </span>
      </div>
      {/* Trust toggle — its own line, more visible when ON. Below the footer */}
      {/* so it doesn't crowd the model/hints row. */}
      <div className="px-4 pb-2 flex items-center text-[10px]">
        <button
          onClick={() => setChatAutoAllow(!chatAutoAllow)}
          className={
            "px-1.5 py-px rounded " +
            (chatAutoAllow
              ? "text-red-300 hover:text-red-200"
              : "text-text-faint hover:text-text-muted")
          }
          title={
            chatAutoAllow
              ? "Trust mode ON — permissions auto-allowed (click to disable)"
              : "Trust mode OFF — permissions require approval (click to enable)"
          }
        >
          {chatAutoAllow
            ? "▶▶ bypass permissions on (click to disable)"
            : "▷▷ bypass permissions off (click to enable)"}
        </button>
      </div>
    </div>
  );
}
