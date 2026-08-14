// ===== VoiceNote — the text-first voice-note bubble (BET-880) =====
//
// The rendered side of a stored voice note. A dictated message keeps its
// transcript fully visible as normal text (text-first); below it a single
// always-visible player renders the waveform + playback.
//
// There is deliberately NO collapsed chip and NO expand/collapse state. The
// earlier shape kept a chip AND appended a player below it on click, so two
// controls both reading as "the player" stacked in the same column and the
// first click cost the user a turn without playing anything. The player is now
// the affordance: always visible, first click plays. Do not reintroduce a
// collapsed variant.
//
// Component split:
//   - VoiceBars        — static waveform, DOM not canvas. 40 bars is cheap,
//                        the played/unplayed split and future seeking are
//                        trivial in DOM, and it themes itself. The LIVE meter
//                        stays canvas (VoiceWaveform) because it redraws
//                        60×/s — do NOT unify them; the two genuinely differ
//                        in rate and purpose.
//   - VoicePlayerFrame — the presentational shell and the ONLY place the
//                        player's chrome is described. No hooks, no fetching,
//                        no <audio>: every visual is a prop, so the ready,
//                        expired and pending states cannot drift apart.
//   - VoicePlayer      — binds a stored note to playback and renders the frame.
//   - PendingVoiceRow  — the not-yet-real row shown while a recording uploads +
//                        transcribes; renders the same frame, non-interactive.

import { memo, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { bucketPeaks, formatClock, normalizeForDisplay } from "../shared/waveform.mjs";
import type { VoiceNoteRecord } from "../shared/types";
import { MantaLoader } from "./MantaLoader";

// The transient pending row's shape — captured peaks/duration the moment the
// take ends, plus the upload's note id + error once it resolves (409).
export type PendingVoiceNote = {
  peaks: Uint8Array;
  durationMs: number;
  noteId?: string;
  error?: string;
};

// ===== VoiceBars — static DOM waveform =====
//
// `progress` is a 0..1 fraction of the clip played; bars left of it are the
// accent "played" colour, the rest neutral. When undefined (not playing) every
// bar is neutral. Bars are `flex-1` across the row; each one's height comes
// from `bucketPeaks(peaks, bars)` scaled through `normalizeForDisplay` (2px
// minimum, 24px maximum). Fewer peaks than bars → fewer bars (the caller draws
// what there is; it must not stretch).
export const VoiceBars = memo(function VoiceBars({
  peaks,
  bars = 40,
  progress,
}: {
  peaks: Uint8Array;
  bars?: number;
  progress?: number;
}) {
  const values = normalizeForDisplay(bucketPeaks(peaks, bars));
  return (
    <div className="flex items-center gap-px h-6 flex-1 min-w-0" aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(2, Math.min(24, Math.round(2 + v * 22)));
        const played = progress != null && bars > 0 && i / bars < progress;
        return (
          <div
            key={i}
            className={`flex-1 rounded-full ${played ? "bg-accent" : "bg-border-strong"}`}
            style={{ height: h }}
          />
        );
      })}
    </div>
  );
});

const SPEEDS = [1, 1.5, 2];

// ===== VoicePlayerFrame — the presentational shell =====
//
// Fixed left-to-right order: disc, waveform, clock, speed. The three states are
// expressed purely through props so there is exactly one set of chrome classes
// and they cannot drift apart:
//   ready   — onToggle + speed supplied.
//   expired — `expired` set. Dashed + dimmed, muted disc, "· expired" suffix,
//             no speed control, not interactive.
//   pending — neither onToggle nor speed. Muted disc, not interactive.
// The frame owns NO outer margin — vertical spacing belongs to the parent.
export const VoicePlayerFrame = memo(function VoicePlayerFrame({
  peaks,
  clockMs,
  progress,
  playing = false,
  onToggle,
  speed,
  onCycleSpeed,
  expired = false,
}: {
  peaks: Uint8Array;
  /** Milliseconds on the clock: REMAINING while a clip is loaded, total otherwise. */
  clockMs: number;
  /** 0..1 played fraction; undefined = every bar neutral. */
  progress?: number;
  playing?: boolean;
  /** Absent => non-interactive (pending / not-yet-fetched / expired). */
  onToggle?: () => void;
  /** Both present => the speed control renders. */
  speed?: number;
  onCycleSpeed?: () => void;
  expired?: boolean;
}) {
  const interactive = !expired && !!onToggle;
  return (
    <div
      className={
        "flex items-center gap-3 rounded-md border border-border-subtle bg-bg-soft px-3 py-2 w-full max-w-[420px] " +
        (expired ? "border-dashed opacity-50" : "")
      }
      title={expired ? "Audio expired — transcript kept" : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!interactive}
        aria-label={playing ? "Pause voice note" : `Play voice note, ${formatClock(clockMs)}`}
        className={
          "w-7 h-7 shrink-0 rounded-full grid place-items-center transition-opacity " +
          (interactive
            ? "bg-accent-solid text-on-accent hover:opacity-90 cursor-pointer"
            : "bg-border-strong text-on-accent")
        }
      >
        {playing ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
      </button>
      <VoiceBars peaks={peaks} progress={progress} />
      <span className="text-meta font-mono text-text-quiet tabular-nums shrink-0">
        {expired ? `${formatClock(clockMs)} · expired` : formatClock(clockMs)}
      </span>
      {speed != null && onCycleSpeed && (
        <button
          type="button"
          onClick={onCycleSpeed}
          aria-label={`Playback speed ${speed}×`}
          className="text-micro font-mono text-text-faint border border-border rounded-full px-2 py-px shrink-0 hover:text-text hover:border-border-strong transition-colors cursor-pointer"
        >
          {speed}×
        </button>
      )}
    </div>
  );
});

// ===== VoicePlayer — a stored note bound to playback =====
//
// Drives ONE <audio> from a fetched blob URL (never a `?token=` URL) and hands
// the frame its visual state. An expired note skips the fetch entirely.
export const VoicePlayer = memo(function VoicePlayer({ note }: { note: VoiceNoteRecord }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const audioAvailable = note.audioAvailable;

  // CHANGE 1: skip the fetch for an expired note — it can only 404.
  useEffect(() => {
    if (!audioAvailable) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    window.api
      .voiceFetchNote(note.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // Audio swept/expired between the list and the tap — leave the row
        // silent rather than throwing (the frame already reads as inactive).
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
      setPlaying(false);
    };
  }, [note.id, audioAvailable]);

  const durationMs =
    note.durationMs > 0 ? note.durationMs : Math.round((audioRef.current?.duration ?? 0) * 1000);
  const progress = durationMs > 0 ? Math.min(1, currentMs / durationMs) : 0;
  const remainingMs = Math.max(0, durationMs - currentMs);

  const toggle = () => {
    const a = audioRef.current;
    if (!a || !url) return;
    if (playing) a.pause();
    // CHANGE 2: drop the `a.currentTime = a.currentTime || 0;` line — it
    // assigns currentTime to itself and is a no-op.
    else void a.play().catch(() => { /* autoplay block — ignore */ });
  };

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  };

  if (!audioAvailable) {
    return <VoicePlayerFrame peaks={note.peaks} clockMs={note.durationMs} expired />;
  }

  return (
    <>
      <VoicePlayerFrame
        peaks={note.peaks}
        clockMs={remainingMs}
        progress={progress}
        playing={playing}
        // CHANGE 3: withholding onToggle until the blob has arrived replaces the
        // old `disabled={!url}` — the disc reads as not-yet-ready instead of
        // being a live button that silently does nothing.
        onToggle={url ? toggle : undefined}
        speed={SPEEDS[speedIdx]}
        onCycleSpeed={cycleSpeed}
      />
      <audio
        ref={audioRef}
        src={url ?? undefined}
        onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentMs(durationMs); }}
        onLoadedMetadata={() => setCurrentMs(0)}
      />
    </>
  );
});

// ===== PendingVoiceRow — the not-yet-real row =====
//
// Rendered after the message list, before the running indicator, while a take
// uploads + transcribes. Right-aligned like a normal user message, but its
// left rule is neutral (`border-border-strong`) instead of the accent so it
// reads as pending, not-yet-real. Two shimmer bars stand in for the transcript
// text, a non-interactive player frame draws the already-captured waveform
// (which is what makes the wait read as "almost done"), and a status line
// reports progress — or the failure + a Retry against the returned note id.
export const PendingVoiceRow = memo(function PendingVoiceRow({
  pending,
  onRetry,
}: {
  pending: PendingVoiceNote | null;
  onRetry: (noteId: string) => void;
}) {
  if (!pending) return null;
  return (
    <div className="flex justify-end">
      <div className="flex flex-col gap-2 max-w-[88%] w-full">
        <div className="border-l-2 border-border-strong bg-bg-soft rounded-md px-4 py-3 flex flex-col gap-2">
          <div className="flex flex-col gap-1" aria-hidden>
            <div className="manta-shimmer h-3 rounded-xs" style={{ width: "88%" }} />
            <div className="manta-shimmer h-3 rounded-xs" style={{ width: "54%" }} />
          </div>
          <VoicePlayerFrame peaks={pending.peaks} clockMs={pending.durationMs} />
        </div>
        {pending.error && pending.noteId ? (
          <div className="flex items-center gap-2 text-label">
            <span className="text-danger font-mono">transcription failed</span>
            <button
              type="button"
              onClick={() => pending.noteId && onRetry(pending.noteId)}
              className="text-text-muted font-mono rounded-xs px-2 py-px border border-border hover:border-border-strong hover:text-text transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-meta font-mono text-accent-tx">
            <MantaLoader />
            <span>transcribing…</span>
          </div>
        )}
      </div>
    </div>
  );
});
