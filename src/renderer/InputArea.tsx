// ===== Composer / input area =====
//
// Extracted from ChatPanel.tsx (M0.5). The bottom composer and its immediate
// helpers:
//   - SessionToolbar: ⏰/🔑/🪝/🤖 footer toggles.
//   - AttachmentStrip: uploaded-file chips above the textarea.
//   - TypeaheadPopup: @-file / @-agent / /command completion list (visual +
//     mouse; keyboard nav is driven by InputArea).
//   - MicButton: press-and-hold voice affordance (inline + mobile PTT FAB).
//   - InputArea: the textarea row, footer (model picker + resource toolbar),
//     and trust toggle. Purely presentational — all state and handlers are
//     passed in as props by ChatPanel.
//
// BET-415 redesign: the composer owns COMPOSING only. Branch chip, context
// pill, and session ops (fork/compact/clear/delete) moved to the SessionHeader
// above the transcript. The composer shell is now a real bordered input with
// a focus state instead of hairline dividers around a naked textarea.

import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, Shield } from "lucide-react";
import type { OpencodeModel } from "../shared/types";
import type { VoiceMode, VoicePhase } from "./voice";
import {
  arrowDownNavigatesHistory,
  arrowUpNavigatesHistory,
  type CaretRow,
} from "./chatUtils";
import {
  type ModelSelection,
  type Attachment,
  resolveActiveModel,
} from "./chatShared";
import { shortModelName } from "./chatUtils";
import { ModelPicker } from "./ModelPicker";
import { AttachmentStrip, MicButton, SessionToolbar } from "./ComposerParts";
// Re-exported so existing `import { TypeaheadPopup } from "./InputArea"` call
// sites (Composer) keep working after the leaf component moved to ./ComposerParts.
export { TypeaheadPopup } from "./ComposerParts";
// AttachmentStrip is no longer re-exported — it is now rendered INSIDE the
// composer box (BET-416 §B), so Composer no longer imports it.

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
  refreshing,
  attachments,
  onRemoveAttachment,
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
  models,
  modelOverride,
  defaultModel,
  deactivatedMainModels,
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
  // Drives a subtle ambient tint on the composer border so the user knows a
  // refetch is in flight without a separate loading bar.
  refreshing: boolean;
  // Pending attachment chips render INSIDE the composer box, above the text
  // line (BET-416 §B) — they are part of the message being composed, unlike
  // context chips (folder / branch) which sit ABOVE the box in the header.
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  modelLabel: string | null;
  chatAutoAllow: boolean;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  voiceEnabled: boolean;
  voicePhase: VoicePhase;
  voiceMode: VoiceMode;
  voiceRecording: boolean;
  voiceProcessing: boolean;
  startVoice: (mode: VoiceMode, opts?: { promote?: boolean }) => Promise<void>;
  stopVoice: () => void;
  cancelVoice: () => void;
  // tokens / staleCache / branch / activeModel moved to SessionHeader
  // (BET-415). The composer owns only composing controls now.
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  deactivatedMainModels: string[];
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
  const voiceActive = voiceRecording || voiceProcessing;
  // Detect mobile shell (touch device using the no-window.api branch with
  // MobileApp + .mobile-body wrapper). MicButton is only rendered there;
  // on desktop the keyboard shortcut (Ctrl+M / Enter / Esc) drives voice.
  const [isMobileShell, setIsMobileShell] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (rowRef.current) {
      setIsMobileShell(!!rowRef.current.closest(".mobile-body"));
    }
  }, []);

  // Short model name for the composer pill (BET-460): resolve the active
  // model the same way ModelPicker does and compact its friendly name
  // (e.g. "Claude Opus 4.7" → "Opus 4.7"), which sits as its own pill with
  // the effort pill showing the accent. Passed via ModelPicker's existing
  // `labelOverride` (a call-site change — ModelPicker gains no new props).
  const shortLabel = useMemo(
    () => {
      const activeModel = resolveActiveModel(models, modelOverride, defaultModel);
      return activeModel ? shortModelName(activeModel.name) : null;
    },
    [models, modelOverride, defaultModel],
  );
  return (
    <div className="manta-composer shrink-0" ref={rowRef}>
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
      {/* Real input shell (BET-415): a bordered card with focus-within state
          replaces the old hairline-dividers-around-a-naked-textarea. Voice
          recording is now signalled by THIS border — a fourth treatment
          alongside resting / focus / error (BET-416 §A): border-colour pulses
          to --danger, border only, never the fill, solid under reduced-motion.
          A background refetch still shows as an ambient accent border. Horizontal
          padding is --sp-4 (16px) per the BET-423 spacing ruling. */}
      <div
        className={
          "manta-composer-input-row mx-4 mb-2 rounded-lg border bg-bg-soft flex flex-col gap-2 px-4 py-3 " +
          (voiceActive
            ? "manta-recording"
            : refreshing
              ? "border-accent"
              : "border-border-strong")
        }
      >
        {/* Attachment chips live INSIDE the box, above the text line (BET-416
            §B). They are part of the message being composed, so they share
            the box; context chips (folder / branch) sit ABOVE the box in the
            SessionHeader because they describe the session. */}
        {attachments.length > 0 && (
          <AttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />
        )}
        <div className="flex items-start gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
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
          className="flex-1 resize-none bg-transparent text-text text-code focus:outline-none placeholder:text-text-faint font-mono min-w-0"
          style={{ maxHeight: "140px", lineHeight: "1.5" }}
        />
        {/* Inline mic on desktop — keyboard-driven, glyph-only feedback.
            The mobile PTT FAB is rendered above the composer wrapper. */}
        {voiceEnabled && !isMobileShell && (
          <MicButton
            phase={voicePhase}
            mode={voiceMode}
            onStart={startVoice}
            onStop={stopVoice}
            onCancel={cancelVoice}
          />
        )}
        </div>
      </div>
      {/* Meta footer — model ▸ effort split on the left, resource toolbar +
          transient status on the right. Branch + context pill moved to the
          SessionHeader; the footer now owns only composing controls. */}
      <div className="px-4 py-1 flex items-center justify-between gap-3 flex-wrap">
        <span className="flex items-center gap-3 min-w-0 flex-wrap">
          <ModelPicker
            modelLabel={modelLabel}
            models={models}
            modelOverride={modelOverride}
            defaultModel={defaultModel}
            deactivatedMainModels={deactivatedMainModels}
            onOpen={onOpenModels}
            onSelect={onSelectModel}
            labelOverride={shortLabel}
            separatePills
            alwaysShowEffort
            effortAccent
          />
        </span>
        <span className="shrink-0 flex items-center gap-3 flex-wrap">
          <SessionToolbar
            scheduleCount={scheduleCount}
            onSchedules={onSchedules}
            onSecrets={onSecrets}
            onWebhooks={onWebhooks}
          />
          {(voiceActive || running) && (
            <span className="text-meta text-text-faint">
              {voiceActive
                ? voiceProcessing
                  ? "transcribing… · esc cancels"
                  : <span className="inline-flex items-center gap-1"><Mic size={14} aria-hidden="true" />recording · ⏎ send · ctrl+m stop · esc cancel</span>
                : "esc · interrupt"}
            </span>
          )}
        </span>
      </div>
      {/* Trust toggle — labelled control with a Shield icon (BET-415).
          Replaces the ▶▶/▷▷ glyphs. Same chatAutoAllow behaviour, same
          config key. Danger colour when bypassing. */}
      <div className="px-4 pb-3 flex items-center text-meta">
        <button
          onClick={() => setChatAutoAllow(!chatAutoAllow)}
          className={
            "px-2 py-px rounded-xs inline-flex items-center gap-2 " +
            (chatAutoAllow
              ? "text-danger hover:text-danger"
              : "text-text-faint hover:text-text-muted")
          }
          title={
            chatAutoAllow
              ? "Bypassing permissions — click to re-enable approval"
              : "Permissions on — click to bypass"
          }
        >
          <Shield size={14} aria-hidden="true" />
          {chatAutoAllow
            ? "Bypassing permissions"
            : "Permissions on — click to bypass"}
        </button>
      </div>
    </div>
  );
}
