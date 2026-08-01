// ===== Composer helper components =====
//
// Extracted from InputArea.tsx (M0.5) to keep each module under ~500 LoC.
// These are the small presentational pieces the composer row is assembled
// from: the footer toolbar, the attachment chip strip, the completion popup,
// and the press-and-hold mic button. InputArea.tsx composes them.

import { useRef } from "react";
import { Clock, Key, Webhook, X, Mic, Loader2 } from "lucide-react";
import type { VoiceMode, VoicePhase } from "./voice";
import { type Attachment, type TypeaheadRow } from "./chatShared";
import { ALT_KEY } from "./platform";

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
  return (
    <span className="manta-session-toolbar flex items-center gap-2 text-meta">
      <button
        onClick={onSchedules}
        className="px-2 py-px rounded text-text-faint hover:text-text-muted inline-flex items-center gap-1"
        title="View / cancel scheduled tasks"
        aria-label="schedules"
      >
        <Clock size={16} strokeWidth={2} aria-hidden="true" />
        {scheduleCount > 0 && (
          <span className="text-text-muted text-label tabular-nums" aria-hidden="true">
            {scheduleCount}
          </span>
        )}
      </button>
      <button
        onClick={onSecrets}
        className="px-2 py-px rounded text-text-faint hover:text-text-muted inline-flex items-center"
        title="Manage secrets the agent can use (values never enter the chat)"
        aria-label="secrets"
      >
        <Key size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        onClick={onWebhooks}
        className="px-2 py-px rounded text-text-faint hover:text-text-muted inline-flex items-center"
        title="View / revoke inbound webhooks (external events that wake this session)"
        aria-label="webhooks"
      >
        <Webhook size={16} strokeWidth={2} aria-hidden="true" />
      </button>
    </span>
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
            className={`rounded-md border px-2 py-px flex items-center gap-1 bg-bg-elev ${color}`}
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
      })}
    </div>
  );
}

// ===== Typeahead popup =====
//
// Anchored above the composer box's top edge. Card elevation (--card bg,
// --border, --shadow-md), 12px radius, max-height with scroll. Keyboard
// up/down/Enter/Tab/Esc nav is handled by InputArea — this component is
// purely visual + mouse selection. The selected row uses --accent-bg.

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
    <div
      className="shrink-0 mx-4 mb-1 max-h-[240px] overflow-y-auto rounded-xl border border-border bg-card text-meta font-mono"
      style={{ boxShadow: "var(--shadow-md)" }}
    >
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
          <button
            key={`${row.kind}:${row.key}`}
            onClick={() => onSelect(row)}
            onMouseEnter={() => onHover(idx)}
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
export function MicButton({
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
        : `hold to speak (${ALT_KEY} = command)`;

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

  // Active colour follows the MODE the hook owns (BET-416 §C): dictate →
  // --danger, command → --accent. Idle is --tx3 (text-faint). The hook is the
  // single source of truth for mode — do NOT add a second mode ref here (that
  // was PR #4's W2 bug).
  const activeColor = mode === "command" ? "text-accent" : "text-danger";

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
          ? `${activeColor} cursor-progress`
          : recording
            ? `${activeColor} animate-pulse`
            : phase === "error"
              ? "text-danger hover:text-danger"
              : "text-text-faint hover:text-text-muted")
      }
      style={{ touchAction: "none" }}  // suppress mobile pull-to-refresh
    >
      {busy ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Mic size={16} aria-hidden="true" />}
    </button>
  );
}
