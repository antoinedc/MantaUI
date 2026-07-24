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
  arrowDownNavigatesHistory,
  arrowUpNavigatesHistory,
  computeContextBreakdown,
  resolveContextLimit,
  type CaretRow,
  type StaleCacheResult,
} from "./chatUtils";
import {
  CLAUDE_ORANGE,
  type ModelSelection,
  type TokenUsage,
} from "./chatShared";
import { ContextBar } from "./ContextBar";
import { ModelPicker } from "./ModelPicker";
import { MicButton, SessionToolbar } from "./ComposerParts";
// Re-exported so existing `import { AttachmentStrip, TypeaheadPopup } from
// "./InputArea"` call sites (ChatPanel) keep working after these leaf
// components moved to ./ComposerParts.
export { AttachmentStrip, TypeaheadPopup } from "./ComposerParts";

// Measure the caret's VISUAL row within a textarea, accounting for soft wrap.
// Render a hidden mirror <div> that copies the textarea's box + text styling,
// place a marker span at the caret offset, and compare the marker's top against
// the content-box top (first row) and content height (last row). Returns null
// when measurement isn't possible (no element / SSR) — callers treat null as
// "unknown" and fall back to navigating history.
const MIRROR_COPIED_PROPS = [
  "boxSizing", "width",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle",
  "letterSpacing", "textTransform", "wordSpacing", "lineHeight", "tabSize",
] as const;

export function caretRowInfo(el: HTMLTextAreaElement | null): CaretRow | null {
  if (!el || typeof document === "undefined") return null;
  const value = el.value;
  const caret = el.selectionStart ?? value.length;

  const style = window.getComputedStyle(el);
  const mirror = document.createElement("div");
  const ms = mirror.style;
  ms.position = "absolute";
  ms.visibility = "hidden";
  ms.top = "0";
  ms.left = "-9999px";
  ms.whiteSpace = "pre-wrap";
  ms.wordWrap = "break-word";
  for (const prop of MIRROR_COPIED_PROPS) {
    ms[prop] = style[prop];
  }

  mirror.textContent = value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = value.slice(caret) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) || 16;
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const padTop = parseFloat(style.paddingTop) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  const borderBottom = parseFloat(style.borderBottomWidth) || 0;

  const caretTop = markerRect.top - mirrorRect.top - borderTop - padTop;
  const contentHeight = mirrorRect.height - borderTop - borderBottom - padTop - padBottom;

  document.body.removeChild(mirror);

  const atFirstRow = caretTop < lineHeight * 0.5;
  const atLastRow = caretTop + lineHeight > contentHeight - lineHeight * 0.5;
  return { atFirstRow, atLastRow };
}

export function InputArea({
  input,
  setInput,
  inputRef,
  submit,
  abort,
  running,
  // True while the canonical transcript is being refetched in the background.
  // Drives the ambient orange gradient on the top divider (below).
  refreshing,
  branch,
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
  deactivatedMainModels,
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
  // True while the canonical transcript is being refetched in the background.
  // Drives the ambient orange gradient on the top divider (below).
  refreshing: boolean;
  branch: string | null;
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
  // BET-215: "providerID/modelID" strings — hidden from the ModelPicker
  // dropdown. Mirrors the AppConfig.deactivatedMainModels opt-out semantics.
  deactivatedMainModels: string[];
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
      {/* when recording starts/stops. While a background transcript refetch */}
      {/* is in flight (BET-251), the resting hairline is replaced by an */}
      {/* ambient orange gradient — the line itself stays 1px tall (the */}
      {/* gradient is painted as a background-image, not a thicker border). */}
      <div
        className={
          voiceActive
            ? "border-t border-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.6)]"
            : refreshing
              ? "manta-loading-divider"
              : "border-t border-text/25"
        }
        aria-busy={refreshing || undefined}
      />
      {/* Input row — no box, generous vertical padding. The mic affordance */}
      {/* on desktop is keyboard-only (Ctrl+M to toggle, Enter to stop+send, */}
      {/* Esc to cancel); the visible feedback is the pulsing border above + */}
      {/* below this row. On mobile the mic lives in the floating PTT FAB */}
      {/* above the composer (rendered at the top of this wrapper). */}
      <div className="px-4 py-3 flex items-start gap-2">
        <span
          className="select-none pt-px shrink-0"
          style={{ color: voiceActive ? "#FF7A88" : CLAUDE_ORANGE }}
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
            // when the caret is on the first VISUAL row (Up) or last VISUAL row
            // (Down) — soft-wrapped long lines occupy multiple rows, and a caret
            // on row 2 must NOT jump to history. Measurement failure (null)
            // degrades to "navigate history" so the arrows never wedge.
            // While running, Up on an empty first-row input pops the last queued
            // message back into the input so it can be edited/removed.
            if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const el = e.currentTarget;
              const row = caretRowInfo(el);
              if (row == null || arrowUpNavigatesHistory(row)) {
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
              const row = caretRowInfo(el);
              if (row == null || arrowDownNavigatesHistory(row)) {
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
          <ModelPicker
            modelLabel={modelLabel}
            models={models}
            modelOverride={modelOverride}
            defaultModel={defaultModel}
            deactivatedMainModels={deactivatedMainModels}
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
