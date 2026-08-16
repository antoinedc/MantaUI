// ===== Composer helper components =====
//
// Extracted from InputArea.tsx (M0.5) to keep each module under ~500 LoC.
// These are the small presentational pieces the composer row is assembled
// from: the footer toolbar, the attachment chip strip, the completion popup,
// and the press-and-hold mic button. InputArea.tsx composes them.

import { useRef } from "react";
import { Clock, Key, Webhook, X, Mic, Loader2, Paperclip, Trash2, Pause, Play } from "lucide-react";
import type { VoicePhase } from "./voice";
import { type Attachment, type TypeaheadRow } from "./chatShared";
import type { PendingScreenshot } from "./store";
import { IconButton } from "./IconButton";
import { IS_MAC } from "./platform";
import { VoiceWaveform } from "./VoiceWaveform";
import { formatClock, VOICE_TAP_HOLD_MS } from "../shared/waveform.mjs";
// BET-726 Task 1: same scrollIntoView idiom the ⌘K / ⌘F palettes and the
// model/effort menus use (PaletteShell.tsx) — keeps the keyboard-selected
// @-file row visible when it moves past the popup's scroll fold.
import { useSelectedIntoView } from "./PaletteShell";
import { MeasureColumn } from "./MeasureColumn";

/**
 * The send glyph: lucide's paper plane as a SOLID shape.
 *
 * Not `<Send fill="currentColor"/>` — lucide's Send is two paths, the plane
 * body plus a separate diagonal line for the fold. Filling the component fills
 * the body but leaves that second path a stroke, so a hairline crease cuts
 * across the solid plane. Dropping it is what "filled send" means, and the
 * component API gives no way to render one path of two, so the body is inlined
 * here (the same inline-SVG escape hatch CopyButton uses).
 *
 * The path is lucide-react v1.28.0's `send` body, verbatim; the light stroke on
 * top of the fill is what keeps a 14px solid shape from looking eroded at its
 * points.
 */
export function SendFilled({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
    </svg>
  );
}

// The chrome every icon button in the recording row shares — the EXISTING
// send button's chrome, verbatim: 27px hit box, --r-sm radius, centred. The
// recording row does not use IconButton (fixed 24/32px hit areas that don't
// match this row and no className escape hatch by design).
const recBtn =
  "w-7 h-7 rounded-sm grid place-items-center shrink-0 transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

// ===== Recording row (BET-836) =====
//
// Replaces the textarea + send row INSIDE the composer box while a take is
// active (recording / paused). The box's outer element and its padding are
// untouched, so the composer never changes height; only this inner row swaps.
// The footer (model picker, mic, attach, usage dial, toolbar) stays visible
// and interactive throughout.
export function RecordingRow({
  phase,
  elapsedMs,
  liveWindowRef,
  discardArmed,
  onDiscard,
  onPause,
  onResume,
  onSend,
}: {
  phase: VoicePhase;
  elapsedMs: number;
  liveWindowRef: React.RefObject<Float32Array>;
  discardArmed: boolean;
  onDiscard: () => void;
  onPause: () => void;
  onResume: () => void;
  onSend: () => void;
}) {
  const recording = phase === "recording" || phase === "requesting";
  const paused = phase === "paused";
  const wavePhase: "recording" | "paused" = paused ? "paused" : "recording";
  return (
    <div className="flex items-center gap-2">
      {/* 1 · State dot — pulses while recording (CSS), static red when paused
          is handled elsewhere; paused uses the warn treatment + no animation. */}
      <span
        aria-hidden="true"
        className={
          "w-2 h-2 rounded-full shrink-0 " +
          (paused ? "bg-warn" : `bg-danger ${recording ? "manta-recording-dot" : ""}`)
        }
      />
      {/* 2 · Timer — NOT inside a live region (per-second region floods SR). */}
      <span
        aria-hidden="true"
        className={
          "font-mono text-label tabular-nums shrink-0 w-10 " +
          (paused ? "text-warn" : "text-danger")
        }
      >
        {formatClock(elapsedMs)}
      </span>
      {/* 3 · Live waveform — reads the recorder's level window directly. */}
      <VoiceWaveform phase={wavePhase} liveWindowRef={liveWindowRef} />
      {/* 4 · Discard — arms above the confirm threshold. */}
      <button
        type="button"
        onClick={onDiscard}
        aria-label={discardArmed ? "Confirm discard" : "Discard recording"}
        title={discardArmed ? "Discard? (tap again to confirm)" : "Discard recording"}
        className={
          `${recBtn} ${discardArmed ? "text-danger bg-danger-bg" : "text-danger hover:bg-danger-bg"}`
        }
      >
        {discardArmed ? (
          <span className="text-label leading-none">Discard?</span>
        ) : (
          <Trash2 size={14} aria-hidden="true" />
        )}
      </button>
      {/* 5 · Pause / Resume. */}
      <button
        type="button"
        onClick={paused ? onResume : onPause}
        aria-label={paused ? "Resume recording" : "Pause recording"}
        title={paused ? "Resume (space)" : "Pause (space)"}
        className={`${recBtn} ${paused ? "" : "bg-accent-solid text-on-accent"}`}
      >
        {paused ? (
          <Play size={12} aria-hidden="true" />
        ) : (
          <Pause size={12} aria-hidden="true" />
        )}
      </button>
      {/* 6 · Send — stop + submit. */}
      <button
        type="button"
        onClick={onSend}
        aria-label="Send recording"
        title="Send (Enter)"
        className={`${recBtn} bg-accent-solid text-on-accent hover:bg-accent-solid/90`}
      >
        <SendFilled size={14} />
      </button>
    </div>
  );
}

// Shared chrome for the composer's icon-row buttons (BET-620 change 6): the
// three SessionToolbar resource buttons AND UsageDial's trigger (BET-738) —
// exported so UsageDial imports this exact string rather than copying it,
// which is exactly how the row would drift. 27px hit, --r-sm radius, --tx3
// rest tone, matches the mockup's `.mbtn`.
export const mbtn =
  "inline-flex items-center gap-[6px] h-[27px] px-2 rounded-sm text-text-faint hover:bg-fill-hover hover:text-text transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

// Human-readable form of the voice shortcut (CmdOrCtrl+Shift+M). Shared by
// the mic button title/aria-label and the composer's transient status hint so
// both name the binding in one place.
export const VOICE_SHORTCUT_LABEL = IS_MAC ? "⇧⌘M" : "Ctrl+Shift+M";

// SessionToolbar — footer affordances. fork / compact / delete moved out of the
// footer (they live in the header ⋯ menu); only the ⏰ schedules toggle remains
// here so its live count is always visible next to the composer.
//
// BET-460: the three resource buttons render ICON-ONLY (clock / key / hook) at
// 16px @ 2px stroke. Their accessible names come from `aria-label`, NOT visible
// text, so `button "schedules"` / `"secrets"` / `"webhooks"` stay nameable for
// screen-readers (the session.aria.yml snapshot enforces this). Schedules keeps
// its pending-count badge (aria-hidden so it joins the visual, not the name);
// secrets and webhooks are not time-sensitive and get no badge.
export function SessionToolbar({
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
  const cnum =
    "font-mono text-[11px] leading-none font-semibold text-text-muted tabular-nums";
  return (
    <span className="flex items-center gap-2 text-meta">
      <button
        onClick={onSchedules}
        className={mbtn}
        title="View / cancel scheduled tasks"
        aria-label="schedules"
      >
        <Clock size={16} strokeWidth={2} aria-hidden="true" />
        {scheduleCount > 0 && (
          <span className={cnum} aria-hidden="true">
            {scheduleCount}
          </span>
        )}
      </button>
      <button
        onClick={onSecrets}
        className={mbtn}
        title="Manage secrets the agent can use (values never enter the chat)"
        aria-label="secrets"
      >
        <Key size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        onClick={onWebhooks}
        className={mbtn}
        title="View / revoke inbound webhooks (external events that wake this session)"
        aria-label="webhooks"
      >
        <Webhook size={16} strokeWidth={2} aria-hidden="true" />
      </button>
    </span>
  );
}

// AttachButton — the composer's explicit "attach a file" affordance.
//
// Attaching used to be discoverable only by DRAGGING a file onto the panel or
// PASTING an image; mobile got a picker in its ⋯ sheet but the desktop
// composer had no visible entry point at all. This is that entry point: a
// glyph button next to the model chip that opens the OS file picker and hands
// the chosen File[] to the SAME `addDroppedFiles` path drag-drop uses (chips,
// mime split, upload). No new upload code — only a new way to reach it.
//
// The <input type="file"> is hidden and reset to "" after each pick so that
// choosing the same file twice in a row still fires `change`.
export function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        label="Attach files"
        icon={<Paperclip />}
        onClick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

// ===== Attachment chips =====
//
// Chip row for pending uploads. Per BET-416 §B attachment chips live INSIDE
// the composer box, above the text line (they are part of the message being
// composed) — so this component renders ONLY the chip row and carries no
// outer padding; the bordered input box that contains it owns the padding +
// the gap to the textarea. Context chips (folder / branch) sit ABOVE the box
// in the SessionHeader instead, because they describe the session.

export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 text-label">
      {attachments.map((a) => {
        const color =
          a.status === "error"
            ? "text-danger border-danger/30"
            : a.status === "uploading"
              ? "text-text-faint border-border"
              : "text-text border-border-strong";
        return (
          <span
            key={a.id}
            className={`rounded-sm border px-2 py-px flex items-center gap-1 bg-bg-elev ${color}`}
            title={a.status === "error" ? a.errorMsg : a.remotePath}
          >
            {a.status === "uploading" && (
              <span className="inline-block animate-spin" style={{ color: "var(--accent)" }}>
                ↻
              </span>
            )}
            <span className="truncate max-w-[200px]">{a.filename}</span>
            <button
              onClick={() => onRemove(a.id)}
              className="text-text-faint hover:text-danger leading-none px-px inline-flex items-center"
              title="Remove"
              aria-label="Remove attachment"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </span>
        );
      }      )}
    </div>
  );
}

// ===== Pending screenshot strip =====
//
// One preview per screenshot the OS detector saw, waiting to be attached.
// Sits ABOVE the composer box (unlike AttachmentStrip, which sits inside it):
// these are not part of the message yet, and being outside the box is what
// aligns the row's left edge with the model pill below — the box's own px-4
// would inset it. Purely presentational; ChatPanel owns the attach + discard.
export function PendingScreenshotStrip({
  shots,
  onAccept,
  onDiscard,
}: {
  shots: PendingScreenshot[];
  onAccept: (shots: PendingScreenshot[]) => void;
  onDiscard: (id: string) => void;
}) {
  if (shots.length === 0) return null;
  return (
    <div className="pb-2 flex flex-wrap items-center gap-2 text-meta">
      {shots.map((s) => (
        <span key={s.id} className="relative shrink-0">
          <button
            onClick={() => onAccept([s])}
            className="block w-[52px] h-[36px] rounded-sm overflow-hidden border border-border bg-fill hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            title={`Add ${s.filename} to the message`}
            aria-label={`Add ${s.filename} to the message`}
          >
            <img src={s.previewUrl} alt="" className="w-full h-full object-cover" />
          </button>
          <button
            onClick={() => onDiscard(s.id)}
            className="absolute top-1 right-1 w-4 h-4 rounded-full grid place-items-center bg-text/60 text-bg hover:bg-danger focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            title="Discard"
            aria-label={`Discard ${s.filename}`}
          >
            <X size={10} aria-hidden="true" />
          </button>
        </span>
      ))}
      <button
        onClick={() => onAccept(shots)}
        className="shrink-0 rounded-sm bg-accent/20 px-2 py-px text-accent hover:bg-accent/30 font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {shots.length === 1 ? "Add to chat" : `Add all ${shots.length}`}
      </button>
    </div>
  );
}

// ===== Typeahead popup =====
//
// Sits directly above the composer box in normal flow, inside the same 72ch
// measure column so its edges align with the input box. Card elevation
// (--card bg, --border, --shadow-md), 12px radius, max-height with scroll.
// Keyboard up/down/Enter/Tab/Esc nav is handled by InputArea — this component
// is purely visual + mouse selection. The selected row uses --accent-bg.

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
    <div className="shrink-0">
      <MeasureColumn>
        <div className="mb-1 max-h-[240px] overflow-y-auto rounded-lg border border-border bg-bg-soft text-meta font-mono shadow-md">
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
                  className="px-2 py-1 flex items-center gap-2 text-danger bg-danger-bg cursor-default"
                >
                  <span className="truncate flex-1">{row.primary}</span>
                  {row.secondary && (
                    <span className="text-danger/70 truncate max-w-[50%] text-label">
                      {row.secondary}
                    </span>
                  )}
                </div>
              );
            }
            return (
              <TypeaheadRowButton
                key={`${row.kind}:${row.key}`}
                row={row}
                active={active}
                onSelect={() => onSelect(row)}
                onHover={() => onHover(idx)}
              />
            );
          })}
        </div>
      </MeasureColumn>
    </div>
  );
}

// A single @-file typeahead row. Split out (rather than an inline map
// closure) so it can call the roving-highlight hook itself — Hooks may only
// be called from a component function, not from inside `Array.prototype.map`
// (same shape as Sidebar's SessionRow / SearchPalette's row).
function TypeaheadRowButton({
  row,
  active,
  onSelect,
  onHover,
}: {
  row: TypeaheadRow;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const ref = useSelectedIntoView<HTMLButtonElement>(active);
  return (
    <button
      ref={ref}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={
        "w-full text-left px-2 py-1 flex items-center gap-2 " +
        (active ? "bg-accent-bg text-text" : "text-text-muted hover:bg-bg-soft")
      }
    >
      <span className="truncate flex-1">{row.primary}</span>
      {row.secondary && (
        <span className="text-text-faint truncate max-w-[50%] text-label">
          {row.secondary}
        </span>
      )}
    </button>
  );
}

// ===== Input area =====

// Press-and-hold mic button. Dictation-only: the transcript is inserted at
// the caret (the orchestration hook inserts it after transcription).
//
// Visual states (phase):
//   - idle       → microphone glyph in text-muted
//   - requesting → spinner in text-faint (waiting on mic permission)
//   - recording  → filled circle pulsing in red, hint text "release to send"
//   - error      → muted-red mic; click to retry by pressing again
//
// Transcription is tracked by the orchestration layer (useVoice), not the
// recorder hook's phases, so the "transcribing" spinner is driven by the
// `busy` prop rather than a hook phase.
export function MicButton({
  phase,
  onStart,
  onStop,
  onCancel,
  busy = false,
  floating = false,
  toggled = false,
  onSend,
}: {
  phase: VoicePhase;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  // Transcription in flight — blocks a new press and shows "transcribing…".
  busy?: boolean;
  // `floating` = the mobile WhatsApp-style push-to-talk FAB (bottom-right,
  // above the composer). It is dictation-only, the same as the inline
  // button — transcription is always plain text into the composer.
  floating?: boolean;
  // `toggled` = the recorder-composer gesture (BET-836): tap toggles
  // recording on/off, hold is push-to-talk (stop + send on release). When
  // false (default) the button is plain press-and-hold dictate — every
  // release stops. The NewSessionScreen dictation mic and the mobile PTT FAB
  // are the non-toggled consumers.
  toggled?: boolean;
  // Required for the toggled gesture — the "send" that a hold-release and a
  // click-while-recording both resolve to. Falls back to onStop.
  onSend?: () => void;
}) {
  const recording = phase === "recording" || phase === "requesting";

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
  // When the press started — used by the toggled gesture to separate a tap
  // (< VOICE_TAP_HOLD_MS) from a hold (push-to-talk).
  const pressDownAtRef = useRef(0);

  // Pointer-based handlers — single code path for mouse + touch + pen so
  // we don't have to worry about emulated mouse events firing AFTER touch
  // on iOS / Android WebView (the classic "double-tap" bug).
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (busy || pressActiveRef.current) return;
    e.preventDefault();
    pressActiveRef.current = true;
    pressDownAtRef.current = performance.now();
    if (toggled && (phase === "recording" || phase === "requesting" || phase === "paused")) {
      // Already recording → stop and send. Same outcome as releasing a hold,
      // so both gestures agree.
      (onSend ?? onStop)();
      // Capture so onPointerUp fires even if the cursor leaves the button.
      try {
        (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
      } catch { /* not all browsers support pointer capture */ }
      return;
    }
    // Idle → start recording immediately, on press — never on the threshold,
    // else the first quarter-second of speech is swallowed.
    onStart();
    // Capture so onPointerUp fires even if the cursor leaves the button.
    try {
      (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    } catch { /* not all browsers support pointer capture */ }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressActiveRef.current) return;
    pressActiveRef.current = false;
    e.preventDefault();
    if (toggled) {
      const held = performance.now() - pressDownAtRef.current;
      if (held < VOICE_TAP_HOLD_MS) {
        // A tap → stay recording (toggled on). Nothing to stop.
        return;
      }
      // Held past the threshold → push-to-talk → stop and send.
      (onSend ?? onStop)();
      return;
    }
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
      ? toggled
        ? "recording — tap to send"
        : floating
          ? `release to insert · ${VOICE_SHORTCUT_LABEL}`
          : `release · dictate · ${VOICE_SHORTCUT_LABEL}`
      : toggled
        ? "hold to talk · tap to record"
        : floating
          ? `hold to talk · ${VOICE_SHORTCUT_LABEL}`
          : `hold to speak · ${VOICE_SHORTCUT_LABEL}`;

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
        {busy ? <Loader2 size={20} aria-hidden="true" className="animate-spin" /> : <Mic size={20} aria-hidden="true" />}
      </button>
    );
  }

  // Active colour is always the danger red while recording (BET-416 §C).
  // Idle is --tx3 (text-faint).
  const activeColor = "text-danger";

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
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
        (busy
          ? `${activeColor} cursor-progress`
          : recording
            ? `${activeColor} animate-pulse`
            : phase === "error"
              ? "text-danger hover:text-danger"
              : "text-text-faint hover:bg-fill-hover hover:text-text")
      }
      style={{ touchAction: "none" }}  // suppress mobile pull-to-refresh
    >
      {busy ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Mic size={16} aria-hidden="true" />}
    </button>
  );
}
