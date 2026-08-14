// ===== VoiceNote — the text-first voice-note bubble (BET-837) =====
//
// The rendered side of a stored voice note. A dictated message keeps its
// transcript fully visible as normal text (text-first); below it a collapsed
// `VoiceNoteChip` marks the row as spoken, and clicking it expands a
// `VoicePlayer` with a DOM waveform (`VoiceBars`) + playback.
//
// Component split:
//   - VoiceBars   — static waveform, DOM not canvas. 40 bars is cheap, the
//                   played/unplayed split and future seeking are trivial in
//                   DOM, and it themes itself. The LIVE meter stays canvas
//                   (VoiceWaveform) because it redraws 60×/s — do NOT unify
//                   them; the two genuinely differ in rate and purpose.
//   - VoiceNoteChip — the collapsed affordance (disc + duration, "expired"
//                   when the audio has been swept). Optional `peaks` renders a
//                   mini waveform, used by the pending row where the waveform
//                   is fully formed instantly.
//   - VoicePlayer — expanded: play/pause disc, VoiceBars, remaining time, and
//                   a 1× → 1.5× → 2× speed cycle. Drives a single <audio> from
//                   a fetched blob URL (never a `?token=` URL).
//   - PendingVoiceRow — the not-yet-real row shown while a recording uploads +
//                   transcribes; resolves into a normal user message on success.

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

// ===== VoiceNoteChip — the collapsed affordance =====
//
// A pill marking a message as spoken: a filled disc holding a tiny
// Play glyph, then the clock. Expired notes (audio swept, transcript kept)
// render dimmed + dashed with a "· expired" suffix and are disabled — the chip
// stays visible so the message keeps its identity as something spoken.
export const VoiceNoteChip = memo(function VoiceNoteChip({
  audioAvailable,
  durationMs,
  peaks,
  onToggle,
}: {
  audioAvailable: boolean;
  durationMs: number;
  peaks?: Uint8Array;
  onToggle?: () => void;
}) {
  const expired = !audioAvailable;
  // Interactive only when the row is playable AND the caller wired a toggle.
  // The pending row passes no onToggle → a non-interactive pill. Use <span>
  // for that (not a disabled <button>) so nothing about it invites a click.
  const inner = (
    <>
      <span
        className={`w-5 h-5 rounded-full grid place-items-center shrink-0 ${
          expired ? "bg-border-strong" : "bg-accent-solid text-on-accent"
        }`}
      >
        <Play size={9} aria-hidden />
      </span>
      {peaks && peaks.length > 0 && <VoiceBars peaks={peaks} bars={14} />}
      <span>{expired ? `${formatClock(durationMs)} · expired` : formatClock(durationMs)}</span>
    </>
  );
  const base =
    "inline-flex items-center gap-2 rounded-full border border-border bg-fill pl-1 pr-3 py-px mt-2 text-meta font-mono text-text-faint " +
    (expired ? "opacity-50 border-dashed" : "hover:border-border-strong hover:text-text hover:bg-fill-hover transition-colors");
  if (expired || !onToggle) {
    return (
      <span className={base} title={expired ? "Audio expired — transcript kept" : undefined}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Replay voice note"
      aria-label={`Play voice note, ${formatClock(durationMs)}`}
      className={`${base} cursor-pointer`}
    >
      {inner}
    </button>
  );
});

const SPEEDS = [1, 1.5, 2];

// ===== VoicePlayer — expanded playback =====
//
// Play/pause disc, the VoiceBars filling the row (played portion tinted by
// `progress`), the remaining clock, and a speed control cycling 1× → 1.5× →
// 2×. Drives ONE <audio> element from a fetched blob URL; `timeupdate` feeds
// progress. Pauses and revokes the object URL on unmount or note change.
export const VoicePlayer = memo(function VoicePlayer({
  note,
}: {
  note: VoiceNoteRecord;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);

  // Fetch audio → blob URL. Never a `?token=` URL (box token must not leak
  // into a URL); the bearer header rides the fetch. Revoke on unmount/id change.
  useEffect(() => {
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
        // silent rather than throwing (the chip already reads as inactive).
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
      setPlaying(false);
    };
  }, [note.id]);

  const durationMs = note.durationMs > 0 ? note.durationMs : Math.round((audioRef.current?.duration ?? 0) * 1000);
  const progress = durationMs > 0 ? Math.min(1, currentMs / durationMs) : 0;
  const remainingMs = Math.max(0, durationMs - currentMs);

  const toggle = () => {
    const a = audioRef.current;
    if (!a || !url) return;
    if (playing) {
      a.pause();
    } else {
      a.currentTime = a.currentTime || 0;
      void a.play().catch(() => { /* autoplay block — ignore */ });
    }
  };

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-soft px-3 py-2 mt-2 min-w-0">
      <button
        type="button"
        onClick={toggle}
        disabled={!url}
        aria-label={playing ? "Pause" : "Play"}
        className="w-7 h-7 shrink-0 rounded-full bg-accent-solid text-on-accent grid place-items-center hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        {playing ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
      </button>
      <VoiceBars peaks={note.peaks} progress={progress} />
      <span className="text-meta font-mono text-text-quiet tabular-nums shrink-0">
        {formatClock(remainingMs)}
      </span>
      <button
        type="button"
        onClick={cycleSpeed}
        className="text-micro font-mono text-text-faint border border-border rounded-full px-2 py-px shrink-0 hover:text-text hover:border-border-strong transition-colors"
        aria-label={`Playback speed ${SPEEDS[speedIdx]}×`}
      >
        {SPEEDS[speedIdx]}×
      </button>
      <audio
        ref={audioRef}
        src={url ?? undefined}
        onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentMs(durationMs); }}
        onLoadedMetadata={() => setCurrentMs(0)}
      />
    </div>
  );
});

// ===== PendingVoiceRow — the not-yet-real row =====
//
// Rendered after the message list, before the running indicator, while a take
// uploads + transcribes. Right-aligned like a normal user message, but its
// left rule is neutral (`border-border-strong`) instead of the accent so it
// reads as pending, not-yet-real. Two shimmer bars stand in for the transcript
// text, a non-interactive chip draws the already-captured waveform (which is
// what makes the wait read as "almost done"), and a status line reports
// progress — or the failure + a Retry against the returned note id.
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
          <VoiceNoteChip
            audioAvailable
            durationMs={pending.durationMs}
            peaks={pending.peaks}
          />
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
