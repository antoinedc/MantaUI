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
import { DraftingCompass, Mic, Shield, Square } from "lucide-react";
import type { OpencodeModel } from "../shared/types";
import type { Voice } from "./hooks/useVoice";
import {
  arrowDownNavigatesHistory,
  arrowUpNavigatesHistory,
  type CaretRow,
  type PlanToggleState,
} from "./chatUtils";
import {
  type ModelSelection,
  type Attachment,
  resolveActiveModel,
} from "./chatShared";
import { baseModelId, isFastModelId, shortModelName } from "./chatUtils";
import { ModelPicker } from "./ModelPicker";
import { Chip } from "./Chip";
import { MeasureColumn } from "./MeasureColumn";
import {
  AttachButton,
  AttachmentStrip,
  MicButton,
  RecordingRow,
  SendFilled,
  SessionToolbar,
  PendingScreenshotStrip,
} from "./ComposerParts";
import type { PendingScreenshot } from "./store";
import { UsageDial } from "./UsageDial";
import { VOICE_MAX_DURATION_MS } from "../shared/waveform.mjs";
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

// True when a mousedown inside the composer box landed on a real control that
// owns its own click — the Send button, the mic, a resource-toolbar button, an
// attachment chip's remove button. Everything else in the box (the padding,
// the chrome, the text field itself) should end up focusing the message field.
//
// WHY THIS EXISTS: on Windows the box could be clicked without the <textarea>
// ever taking focus — the box lit its `:focus-within` ring (so the click DID
// resolve to some descendant) but no caret appeared and the field was
// unusable, while every other input in the app worked. Rather than depend on
// the browser resolving a click inside the box to the textarea, InputArea now
// routes focus explicitly (see the box's onMouseDown). Keep the control
// escape hatch: without it, clicking Send would steal focus back to the field
// and swallow the button's own click.
export function isComposerControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest("button, a, [role='button']");
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
  onAttachFiles,
  pendingScreenshots,
  onAcceptScreenshots,
  onDiscardScreenshot,
  modelLabel,
  chatAutoAllow,
  setChatAutoAllow,
  voice,
  models,
  modelOverride,
  defaultModel,
  plan,
  onTogglePlan,
  activeProviderID,
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
  // Files chosen through the composer's 📎 button. Same sink as drag-drop
  // (ChatPanel's addDroppedFiles) — the button is a second door, not a second
  // upload path.
  onAttachFiles: (files: File[]) => void;
  // Screenshots the OS detector saw, not yet attached. Rendered ABOVE the
  // composer box (see PendingScreenshotStrip) — threaded in exactly like
  // `attachments`, so the panel stays the single owner of what gets attached.
  pendingScreenshots: PendingScreenshot[];
  onAcceptScreenshots: (shots: PendingScreenshot[]) => void;
  onDiscardScreenshot: (id: string) => void;
  modelLabel: string | null;
  chatAutoAllow: boolean;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  // The whole voice hook result (BET-836): the recording session state
  // (phase/elapsedMs/nearLimit/liveWindowRef), the actions (start/pause/
  // resume/send/discard), the discard-arm state, and the a11y announcements.
  voice: Voice;
  // tokens / staleCache / branch / activeModel moved to SessionHeader
  // (BET-415). The composer owns only composing controls now.
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  // BET-738: the active model's providerID, already resolved by ChatPanel
  // via resolveActiveModel (the same computation `shortLabel` above uses) —
  // passed straight through to UsageDial, which never re-resolves the model
  // itself.
  activeProviderID: string | null;
  deactivatedMainModels: string[];
  onOpenModels: () => void;
  onSelectModel: (m: ModelSelection | null) => void;
  // Plan-mode chip (BET-949): the resolved toggle state + the flip handler.
  plan: PlanToggleState;
  onTogglePlan: () => void;
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
  const { voiceEnabled, voiceRecording, voiceProcessing, voiceAnnouncement } =
    voice;
  const {
    phase: voicePhase,
    elapsedMs,
    nearLimit,
    lastError,
    liveWindowRef,
    start: voiceStart,
    pause: voicePause,
    resume: voiceResume,
    send: voiceSend,
    stop: voiceStop,
    cancel: voiceCancel,
    requestDiscard,
    discardArmed,
  } = voice.voiceRecorder;
  const voiceActive = voiceRecording || voiceProcessing;
  // A take is active — swap the textarea row for the recording row. Includes
  // "requesting" (mic permission) so the box's footprint is stable from the
  // instant recording starts.
  const takeActive = voiceRecording;
  // Detect mobile shell (touch device using the no-window.api branch with
  // MobileApp + .mobile-body wrapper). MicButton is only rendered there;
  // on desktop the keyboard shortcut (CmdOrCtrl+Shift+M / Enter / Esc) drives voice.
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
  // When the active model is a `-fast` twin, the chip shows the BASE model's
  // name and lets the lit ⚡ segment carry the mode — "Opus 4.7 Rationale ⚡"
  // rather than "Opus 4.7 Rationale Fast ⚡", which says it twice. Falls back
  // to the model's own name whenever the base twin isn't in the list.
  const shortLabel = useMemo(
    () => {
      const activeModel = resolveActiveModel(models, modelOverride, defaultModel);
      if (!activeModel) return null;
      const base = isFastModelId(activeModel.id)
        ? models?.find(
            (m) =>
              m.providerID === activeModel.providerID &&
              m.id === baseModelId(activeModel.id),
          )
        : null;
      return shortModelName(base?.name ?? activeModel.name);
    },
    [models, modelOverride, defaultModel],
  );
  return (
    <div className="manta-composer shrink-0" ref={rowRef}>
      {/* Mobile push-to-talk FAB (WhatsApp-style, bottom-right above the
          composer). Hold to record, release to insert the transcript into
          the composer for review. Positioned + sized by `.mobile-ptt-fab` in
          mobile.css; only rendered in the mobile shell with a Groq key set.
          Desktop voice stays keyboard-driven (CmdOrCtrl+Shift+M / Enter / Esc). */}
      {voiceEnabled && isMobileShell && (
        <MicButton
          phase={voicePhase}
          onStart={voiceStart}
          onStop={voiceStop}
          onCancel={voiceCancel}
          busy={voiceProcessing}
          floating
        />
      )}
      {/* Measure-capped composer (BET-620 change 3): the box, meta footer and
          trust toggle sit inside --measure (72ch) so the composer aligns with
          the transcript's measure edge, per the session mockup (.comp-in). The
          reading column chrome is the MeasureColumn primitive (BET-637). */}
      <MeasureColumn>
      {/* Pending screenshots sit above the box, inside the same measure column
          — so the row's left edge is the model pill's, with no bespoke
          padding. */}
      <PendingScreenshotStrip
        shots={pendingScreenshots}
        onAccept={onAcceptScreenshots}
        onDiscard={onDiscardScreenshot}
      />
      {/* Real input shell (BET-415): a bordered card with focus-within state
          replaces the old hairline-dividers-around-a-naked-textarea. Voice
          recording is now signalled by THIS border — a fourth treatment
          alongside resting / focus / error (BET-416 §A): border-colour pulses
          to --danger, border only, never the fill, solid under reduced-motion.
          A background refetch still shows as an ambient accent border. Horizontal
          padding is --sp-4 (16px) per the BET-423 spacing ruling. */}
      <div
        className={
          "manta-composer-input-row mb-2 rounded-lg border bg-bg-soft flex flex-col gap-2 px-4 py-3 transition-colors duration-200 " +
          // Resting border is `border-subtle`, the SAME token the tool cards
          // use. It was `border-strong`, which is a control-boundary tone —
          // on the light canvas that reads as a noticeably heavier rule than
          // every card on the screen, so the composer looked outlined rather
          // than contained. Definition now comes from the fill + --shadow-sm;
          // focus-within still paints the accent border.
          (voicePhase === "paused"
            ? "manta-recording-paused"
            : voiceRecording
              ? "manta-recording"
              : refreshing
                ? "border-accent"
                : "border-border-subtle")
        }
        // Route every non-control click in the box to the message field. This
        // is what makes the composer focusable on Windows, where a click could
        // resolve to a sibling and leave the field caret-less (see
        // isComposerControlTarget). Clicking the textarea itself keeps the
        // browser default so native caret PLACEMENT still works — we only add
        // the focus() the platform failed to do.
        onMouseDown={(e) => {
          if (isComposerControlTarget(e.target)) return;
          const el = inputRef.current;
          if (!el) return;
          if (e.target !== el) e.preventDefault();
          if (document.activeElement !== el) el.focus();
        }}
      >
        {/* A11y (BET-836): one polite region for the recording lifecycle
            announcements; a separate assertive region for mic errors. The
            timer is deliberately NOT in any live region. */}
        <span className="sr-only" role="status" aria-live="polite">
          {voiceAnnouncement}
        </span>
        <span className="sr-only" aria-live="assertive">
          {lastError ?? ""}
        </span>
        {/* Attachment chips live INSIDE the box, above the text line (BET-416
            §B). They are part of the message being composed, so they share
            the box; context chips (folder / branch) sit ABOVE the box in the
            SessionHeader because they describe the session. */}
        {attachments.length > 0 && (
          <AttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />
        )}
        {/* The inner input row swaps for the recording row while a take is
            active (BET-836). The outer box and its padding are untouched, so
            the composer never changes height. */}
        {takeActive ? (
          <RecordingRow
            phase={voicePhase}
            elapsedMs={elapsedMs}
            liveWindowRef={liveWindowRef}
            discardArmed={discardArmed}
            onDiscard={requestDiscard}
            onPause={voicePause}
            onResume={voiceResume}
            onSend={voiceSend}
          />
        ) : (
        <div className="flex items-start gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // ⇧Tab toggles plan mode (BET-949). The composer textarea owns its
            // focus, so overriding reverse tab-traversal here is safe — this is
            // composer-scoped, not a window binding. Gated on availability so a
            // box with no `plan` agent can't be toggled into a frozen state.
            if (e.key === "Tab" && e.shiftKey && plan.available) {
              e.preventDefault();
              onTogglePlan();
              return;
            }
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
          placeholder={running ? "Queue a message…  (⏎ to queue · Esc to stop)" : "Reply, or describe the next task…"}
          rows={1}
          spellCheck={false}
          className="flex-1 resize-none bg-transparent text-text text-prose focus:outline-none placeholder:text-text-faint font-sans min-w-0"
          style={{ maxHeight: "140px", lineHeight: "1.5" }}
        />
        {/* The desktop mic + attach buttons moved DOWN into the meta row
            beside the model picker; the box now holds only the message and
            Send. The mobile PTT FAB is still rendered above the composer. */}
        {/* Send button — sits beside the textarea in the composer box (BET-620
            change 4). Accent when there's text to send, muted fill when empty. */}
        <button
          onClick={() => (running ? abort() : submit())}
          disabled={!running && !input.trim()}
          aria-label={running ? "Stop the running turn" : "Send message"}
          title={running ? "Stop (Esc)" : "Send (Enter)"}
          className={
            "w-7 h-7 rounded-sm grid place-items-center shrink-0 transition-colors " +
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
            "disabled:cursor-default " +
            (running || input.trim()
              ? "bg-accent text-on-accent hover:bg-accent/90"
              : "bg-fill text-text-faint")
          }
        >
          {/* Both glyphs are SOLID (BET icon pass): against the accent fill an
              outline reads as a faint sketch, and the hollow square in
              particular did not say "stop". Square keeps its stroke on top of
              the fill so it stays optically the same size as before. */}
          {running ? (
            <Square size={12} fill="currentColor" aria-hidden="true" />
          ) : (
            <SendFilled size={14} />
          )}
        </button>
        </div>
        )}
      </div>
      {/* Meta footer — model ▸ effort split on the left, resource toolbar +
          transient status on the right. Branch + context pill moved to the
          SessionHeader; the footer now owns only composing controls. */}
      <div className="py-1 flex items-center justify-between gap-3 flex-wrap">
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
          />
          {/* Plan mode chip (BET-949) — the counterpart to the model picker.
              Loading renders a chip-sized pulse placeholder (same bg-border
              animate-pulse recipe as ModelPicker's SkeletonBar); unavailable
              renders the chip disabled-equivalent with an explanatory title. */}
          {plan.loading ? (
            <span
              className="inline-flex items-center h-[9px] rounded-full bg-border animate-pulse"
              style={{ width: 64 }}
              aria-hidden="true"
            />
          ) : (
            <Chip
              on={plan.on}
              onClick={onTogglePlan}
              disabled={!plan.available}
              title={plan.title}
              hook="manta-plan-toggle"
            >
              <DraftingCompass size={13} aria-hidden="true" />
              Plan
            </Chip>
          )}
          {/* Input-mode affordances (🎤 / 📎) sit HERE, beside the model
              group, rather than inside the input box. They choose HOW you
              compose — the same category as which model you compose for —
              whereas the box holds the message itself and its send action.
              The mic moved out of the box for this reason; the mobile PTT FAB
              is unaffected (it is positioned by mobile.css, not this row). */}
          {!isMobileShell && (
            <span className="flex items-center gap-3">
              {voiceEnabled && (
                <MicButton
                  phase={voicePhase}
                  onStart={voiceStart}
                  onStop={voiceStop}
                  onCancel={voiceCancel}
                  onSend={voiceSend}
                  busy={voiceProcessing}
                  toggled
                />
              )}
              <AttachButton onFiles={onAttachFiles} />
            </span>
          )}
        </span>
        {/* gap-2 (8px), the SAME gap SessionToolbar uses between its own three
            icons — so the dial + clock + key + webhook read as one evenly
            spaced run instead of a detached dial 12px off the group. */}
        <span className="shrink-0 flex items-center gap-2 flex-wrap">
          <UsageDial providerID={activeProviderID} />
          <SessionToolbar
            scheduleCount={scheduleCount}
            onSchedules={onSchedules}
            onSecrets={onSecrets}
            onWebhooks={onWebhooks}
          />
          {voiceActive && (
            <span className="text-meta text-text-faint">
              {voiceProcessing ? (
                "transcribing… · esc cancels"
              ) : voicePhase === "paused" ? (
                <span className="inline-flex items-center gap-1">
                  <Mic size={14} aria-hidden="true" />
                  paused · space resume · ⏎ send
                  {nearLimit && (
                    <span className="text-warn">
                      {" "}
                      · {Math.max(0, Math.ceil((VOICE_MAX_DURATION_MS - elapsedMs) / 1000))}s left
                    </span>
                  )}
                </span>
              ) : voiceRecording ? (
                <span className="inline-flex items-center gap-1">
                  <Mic size={14} aria-hidden="true" />
                  recording · ⏎ send · space pause · esc discard
                  {nearLimit && (
                    <span className="text-warn">
                      {" "}
                      · {Math.max(0, Math.ceil((VOICE_MAX_DURATION_MS - elapsedMs) / 1000))}s left
                    </span>
                  )}
                </span>
              ) : null}
            </span>
          )}
        </span>
      </div>
      {/* Trust toggle — labelled control with a Shield icon (BET-415).
          Replaces the ▶▶/▷▷ glyphs. Same chatAutoAllow behaviour, same
          config key. Danger colour when bypassing.
          In plan mode (BET-949) nothing is bypassed — the edit tools are gone —
          so this row reports "Plan mode — edits blocked" instead and the
          bypass state is not shown. Two contradictory permission claims stacked
          together is how users stop believing either. */}
      <div className="pb-3 flex items-center">
        {plan.on ? (
          <span className="inline-flex items-center gap-2 text-[11px] leading-none font-normal py-[6px] px-0 text-text-muted">
            <Shield size={14} aria-hidden="true" />
            Plan mode — edits blocked
          </span>
        ) : (
        <button
          onClick={() => setChatAutoAllow(!chatAutoAllow)}
          className={
            // Smaller + regular weight (was 11.5px medium): this is an ambient
            // state line under the composer, not a call to action. The danger
            // colour is what makes the bypassing state read — the type does
            // not need to carry it too.
            "inline-flex items-center gap-2 text-[11px] leading-none font-normal py-[6px] px-0 " +
            (chatAutoAllow
              ? "text-danger hover:text-danger"
              : "text-text-muted hover:text-text-muted")
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
        )}
      </div>
      </MeasureColumn>
    </div>
  );
}
