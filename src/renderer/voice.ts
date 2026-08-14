// voice.ts — renderer-side voice recording.
//
// A toggled recording SESSION, not a press-and-hold one-shot: start/pause/
// resume/stop/cancel, with live level capture for the waveform UI. The hook
// CAPTURES audio + levels and hands back an artifact; it does not upload,
// transcribe, or touch the composer. Orchestration (transcription, insertion,
// keybinds) lives in useVoice.ts. Keeping this line is what lets iOS mirror
// the hook later without inheriting web concerns.
//
//     onComplete({ blob, mime, durationMs, peaks })
//
// `peaks` is already downsampled (downsamplePeaks) at stop time.
//
// The hook itself is component-coupled (refs/state) but all the pure maths
// (elapsed bookkeeping across pause/resume, the near-limit threshold, the
// too-short discard) is extracted below so it can be unit-tested without a
// MediaRecorder.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  downsamplePeaks,
  VOICE_LIVE_WINDOW_BARS,
  VOICE_MAX_DURATION_MS,
  VOICE_MIN_DURATION_MS,
  VOICE_SAMPLE_INTERVAL_MS,
  VOICE_WARN_REMAINING_MS,
} from "../shared/waveform.mjs";

// The state machine the hook actually enters. `processing` is deliberately
// gone — transcription is the orchestration layer's (useVoice's) business,
// never the recorder's. Do not add a phase this hook never enters; that is
// exactly the dead-state problem the iOS recorder has.
export type VoicePhase =
  | "idle"
  | "requesting"  // browser is asking for mic permission / opening device
  | "recording"   // MediaRecorder is collecting chunks
  | "paused"      // take held open, sampler + recorder paused
  | "error";

export type VoiceArtifact = {
  blob: Blob;
  mime: string;
  durationMs: number;
  peaks: Uint8Array;
};

export type UseVoiceRecorderOptions = {
  // Called when a take ends (stop, hard cap, or mic loss) with the captured
  // audio + downsampled waveform. The caller (useVoice) transcribes/uploads.
  onComplete: (artifact: VoiceArtifact) => void;
  // Optional error sink — defaults to logging. Use it to surface mic
  // permission denied / device loss in the chat error banner.
  onError?: (err: Error) => void;
  // The take was a mis-tap — under the minimum duration or a sub-1KB blob.
  // Discarded silently; the UI shows "held too short" instead of silence.
  onEmpty?: (reason: "too-short") => void;
  // A non-fatal warning (e.g. the underlying source muted temporarily).
  // Recording continues; the caller decides whether/how to surface it.
  onWarning?: (msg: string) => void;
};

// MediaRecorder timeslice. Without a timeslice argument, MediaRecorder is
// spec'd to emit a single `dataavailable` at stop time — and on iOS 17.x
// WKWebView that event sometimes fires AFTER `onstop`, leaving an empty
// chunks array. 250ms forces periodic emission, so the Blob is whole by
// the time onstop runs. The chunks just concatenate downstream — no logic
// change. See PR #4 review (W1).
const RECORDER_TIMESLICE_MS = 250;

// ===== Pure elapsed / limit maths (unit-testable) =====

// Elapsed-time tracker that excludes paused spans from the running total.
// `accumMs` is the frozen total from finished segments; `segStartAt` marks
// the start of the current live segment (null while paused). current =
// accumMs + live segment.
export type ElapsedState = { accumMs: number; segStartAt: number | null };

export function elapsedReset(): ElapsedState {
  return { accumMs: 0, segStartAt: null };
}

export function elapsedCurrent(s: ElapsedState, now: number): number {
  return s.accumMs + (s.segStartAt == null ? 0 : now - s.segStartAt);
}

export function elapsedPause(s: ElapsedState, now: number): ElapsedState {
  return {
    accumMs: elapsedCurrent(s, now),
    segStartAt: null,
  };
}

export function elapsedResume(s: ElapsedState, now: number): ElapsedState {
  return { ...s, segStartAt: now };
}

// True once remaining time is under the warn threshold.
export function nearLimitAt(elapsedMs: number): boolean {
  return VOICE_MAX_DURATION_MS - elapsedMs < VOICE_WARN_REMAINING_MS;
}

// A take under the minimum duration, or a blob under 1 KB, is a mis-tap and
// is discarded silently (onEmpty("too-short")) — keep today's behaviour.
export function isTooShort(durationMs: number, blobSize: number): boolean {
  return durationMs < VOICE_MIN_DURATION_MS || blobSize < 1024;
}

/**
 * Pick the best mimeType MediaRecorder supports on this platform. Order is
 * tuned for what Groq's whisper endpoint decodes well AND what each browser
 * actually produces:
 *   - audio/webm;codecs=opus   — Chromium desktop + Android WebView
 *   - audio/webm                — Chromium fallback
 *   - audio/mp4                 — iOS Safari / WKWebView (the ONLY thing Apple ships)
 *   - audio/ogg;codecs=opus     — Firefox
 * Returns "" if MediaRecorder is missing entirely (very old WebView). Caller
 * should treat "" as a hard "voice unavailable" signal.
 */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // isTypeSupported throws on some old WebViews — try the next one
    }
  }
  // Last resort: empty string lets MediaRecorder pick its own default; we'll
  // record at whatever the platform supports and the server is content-sniffed.
  return "";
}

/**
 * Toggled recording-session hook. `start()` opens the mic + begins recording;
 * `pause()`/`resume()` pause and continue the same take; `stop()` ends the
 * take and fires `onComplete({blob, mime, durationMs, peaks})`; `cancel()`
 * discards the current take with no callback.
 *
 * Also captures live input levels into `liveWindowRef` (a rolling Float32Array
 * ring, one value per sample) so the composer can render a live meter without
 * re-rendering through React state — the canvas reads the ref in its own
 * requestAnimationFrame loop. A flat copy of every sample is kept and
 * downsampled into `peaks` at stop time.
 *
 * Re-entrancy: start() while requesting/recording/paused is a no-op. Unmount
 * stops cleanly so the mic LED doesn't stick on.
 */
export function useVoiceRecorder({
  onComplete,
  onError,
  onEmpty,
  onWarning,
}: UseVoiceRecorderOptions) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [nearLimit, setNearLimit] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // phaseRef shadows `phase` for synchronous re-entrancy guards. React state
  // lags behind event handlers within the same commit (W4 from review: two
  // pointerdowns could both pass the state-based guard).
  const phaseRef = useRef<VoicePhase>("idle");
  const setPhaseSync = useCallback((p: VoicePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // Live level window — a REF, never state. At 40 ms that is 25 updates a
  // second; routing it through useState would re-render the whole composer
  // 25 times a second. This is not a micro-optimisation — this panel has a
  // documented history of keystroke-lag regressions from far less.
  const liveWindowRef = useRef<Float32Array>(
    new Float32Array(VOICE_LIVE_WINDOW_BARS),
  );

  // Every sampled peak (the whole take), downsampled at stop time.
  const storedPeaksRef = useRef<number[]>([]);

  // Elapsed bookkeeping (excludes paused time).
  const elapsedRef = useRef<ElapsedState>(elapsedReset());

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");

  const cancelledRef = useRef<boolean>(false);
  // Set when stop() is called during the "requesting" window (mic permission /
  // getUserMedia still pending, recorder not yet constructed). The start path
  // checks this right after getUserMedia resolves and immediately stops the
  // freshly-started recorder so a quick press doesn't record to the cap.
  const stopRequestedRef = useRef<boolean>(false);
  // Set when the underlying audio track reports `ended` (device lost). The
  // stop path then surfaces an error even though it keeps a valid take.
  const endedRef = useRef<boolean>(false);

  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Latest-callback refs so the sampling/elapsed intervals (created once per
  // start) never read a stale callback if the caller's closure identity
  // changes mid-take.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onEmptyRef = useRef(onEmpty);
  onEmptyRef.current = onEmpty;
  const onWarningRef = useRef(onWarning);
  onWarningRef.current = onWarning;
  const setPhaseSyncRef = useRef(setPhaseSync);
  setPhaseSyncRef.current = setPhaseSync;

  const reportError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setPhaseSync("error");
      if (onErrorRef.current) {
        try {
          onErrorRef.current(err instanceof Error ? err : new Error(msg));
        } catch {
          /* user-supplied callback threw — ignore */
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn("[voice]", msg);
      }
    },
    [setPhaseSync],
  );

  // Stop every track (so the OS recording indicator clears), close the
  // AudioContext, and drop the recorder/stream references. Safe to call
  // repeatedly. Used by stop/cancel/unmount/error paths.
  const teardownMedia = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          /* track already ended */
        }
      }
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      // Closing is async; fire-and-forget — we only hold the context to
      // release the OS recording indicator, not to read anything after.
      audioCtxRef.current.close().catch(() => {});
    }
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    recorderRef.current = null;
  }, []);

  const clearIntervals = useCallback(() => {
    if (sampleTimerRef.current) {
      clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  // One sampling callback shared by start() and resume(). Reads the analyser
  // and pushes each peak to BOTH the rolling live window (liveWindowRef) and
  // the flat stored array (downsampled into `peaks` at stop).
  const sampleTick = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    // clamp to 0..1
    peak = peak > 1 ? 1 : peak;
    const win = liveWindowRef.current;
    win.copyWithin(0, 1);
    win[win.length - 1] = peak;
    storedPeaksRef.current.push(peak);
  }, []);

  const start = useCallback(
    async () => {
      // ref-based re-entrancy guard (W4).
      if (
        phaseRef.current === "requesting" ||
        phaseRef.current === "recording" ||
        phaseRef.current === "paused"
      ) {
        return;
      }
      setLastError(null);
      setNearLimit(false);
      setElapsedMs(0);
      cancelledRef.current = false;
      stopRequestedRef.current = false;
      endedRef.current = false;
      storedPeaksRef.current = [];
      liveWindowRef.current = new Float32Array(VOICE_LIVE_WINDOW_BARS);
      elapsedRef.current = elapsedReset();

      const mime = pickRecorderMime();
      mimeRef.current = mime;
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        reportError(new Error("Microphone not available in this environment."));
        return;
      }
      setPhaseSync("requesting");

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        reportError(
          e instanceof Error && e.name === "NotAllowedError"
            ? new Error(
                "Microphone permission denied. Allow it in your browser/OS settings.",
              )
            : (e as Error) ?? new Error("Could not access microphone."),
        );
        return;
      }
      // W3: if the user already released / cancelled while we awaited
      // getUserMedia, abandon NOW — tear the mic down, don't construct a
      // recorder that nothing will stop.
      if (cancelledRef.current) {
        for (const t of stream.getTracks()) {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
        setPhaseSync("idle");
        return;
      }
      streamRef.current = stream;

      // ===== Level capture — the part that is easy to get wrong =====
      // Wire an AnalyserNode off the SAME MediaStream driving the recorder:
      //   AudioContext -> createMediaStreamSource(stream) -> analyser.
      // fftSize = 32 is NOT about frequency resolution — it is a short buffer
      // for responsive peak detection. We read with getFloatTimeDomainData
      // (time-domain), never getByteFrequencyData (that is a spectrum
      // analyser — a different picture entirely).
      try {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new AC();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 32;
        source.connect(analyser);
        // Note: NOT connected to ctx.destination — we only measure, we do not
        // monitor the mic through the speakers.
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
      } catch (e) {
        teardownMedia();
        reportError(e);
        return;
      }

      // ===== Microphone loss =====
      // The audio track fires `ended` when the device (or its permission) is
      // gone, and `mute` when the source briefly stops supplying data. A user
      // muting via hardware or the OS sets `track.enabled`, which fires NO
      // events at all and cannot be observed — build no UI promising to
      // detect it.
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          endedRef.current = true;
          const rec = recorderRef.current;
          if (rec && rec.state !== "inactive") {
            try {
              rec.stop();
            } catch {
              /* already inactive */
            }
          }
        };
        track.onmute = () => {
          // Source temporarily silent but may unmute — keep recording, just
          // warn so the user isn't confused by a flat waveform.
          onWarningRef.current?.(
            "Microphone muted — recording may come out silent.",
          );
        };
      }

      let recorder: MediaRecorder;
      try {
        recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
      } catch (e) {
        teardownMedia();
        reportError(e);
        return;
      }
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onerror = (ev) => {
        // MediaRecorder error events carry the underlying DOMException on
        // .error in some browsers, on event.error in others.
        const err =
          (ev as unknown as { error?: Error }).error ??
          new Error("MediaRecorder error");
        reportError(err);
      };
      recorder.onstop = () => {
        clearIntervals();
        const chunks = chunksRef.current;
        const stored = storedPeaksRef.current;
        const wasCancelled = cancelledRef.current;
        const wasEnded = endedRef.current;
        chunksRef.current = [];
        storedPeaksRef.current = [];
        teardownMedia();
        if (wasCancelled) {
          setPhaseSyncRef.current("idle");
          return;
        }
        const blob = new Blob(chunks, { type: mimeRef.current || "audio/webm" });
        const mime = mimeRef.current || blob.type || "audio/webm";
        const durationMs = Math.round(
          elapsedCurrent(elapsedRef.current, performance.now()),
        );
        const tooShort = isTooShort(durationMs, blob.size);
        if (wasEnded) {
          // Device gone mid-take. Keep whatever we captured (over the
          // minimum), but surface an error so the user isn't left wondering.
          if (!tooShort) {
            onCompleteRef.current({
              blob,
              mime,
              durationMs,
              peaks: downsamplePeaks(stored),
            });
          }
          reportError(new Error("Microphone disconnected during recording."));
          return;
        }
        if (tooShort) {
          // Mis-tap — discard silently, keep today's behaviour.
          setPhaseSyncRef.current("idle");
          onEmptyRef.current?.("too-short");
          return;
        }
        setPhaseSyncRef.current("idle");
        onCompleteRef.current({
          blob,
          mime,
          durationMs,
          peaks: downsamplePeaks(stored),
        });
      };

      try {
        // W1: 250ms timeslice so ondataavailable fires periodically. Without
        // it, iOS WKWebView occasionally drops the final chunk when it
        // arrives after onstop, leaving an empty Blob.
        recorder.start(RECORDER_TIMESLICE_MS);
      } catch (e) {
        teardownMedia();
        reportError(e);
        return;
      }
      // The user may have already released DURING the getUserMedia await
      // (stop() set stopRequestedRef before the recorder existed). Honor it
      // now: stop the just-started recorder so onstop fires and completes the
      // brief tail instead of running to the cap.
      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        try {
          recorder.stop();
        } catch {
          /* already inactive */
        }
        return;
      }

      elapsedRef.current = { accumMs: 0, segStartAt: performance.now() };
      setPhaseSync("recording");

      // Peak sampling cadence. deliberately setInterval, NOT
      // requestAnimationFrame: rAF is throttled/stopped when the window is
      // hidden, and recording deliberately continues through blur — sampling
      // on rAF would silently drop level data whenever the user switched away.
      sampleTimerRef.current = setInterval(sampleTick, VOICE_SAMPLE_INTERVAL_MS);

      // Elapsed display tick. React re-renders only when the displayed second
      // (or the near-limit flag) actually changes — floor() + useState bail-out.
      elapsedTimerRef.current = setInterval(() => {
        const ms = elapsedCurrent(elapsedRef.current, performance.now());
        setElapsedMs(Math.round(ms));
        setNearLimit(nearLimitAt(ms));
        // Hard cap: behaves exactly as if the user hit send — the take is
        // kept, never dropped (recorder.stop() -> onstop -> onComplete).
        if (ms >= VOICE_MAX_DURATION_MS) {
          const rec = recorderRef.current;
          if (rec && (rec.state === "recording" || rec.state === "paused")) {
            try {
              rec.stop();
            } catch {
              /* already stopped */
            }
          }
        }
      }, 250);
    },
    [reportError, teardownMedia, clearIntervals, setPhaseSync, sampleTick],
  );

  const pause = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      try {
        // requestData() BEFORE pause() flushes the buffered data so the chunk
        // boundary is well-defined. Without the flush the paused segment can
        // be lost — this is a real MediaRecorder trap, not a theoretical one.
        rec.requestData();
      } catch {
        /* ignore */
      }
      try {
        rec.pause();
      } catch {
        /* ignore */
      }
    }
    // Freeze elapsed at the pause moment so paused time never counts toward
    // the duration cap.
    elapsedRef.current = elapsedPause(
      elapsedRef.current,
      performance.now(),
    );
    setElapsedMs(Math.round(elapsedRef.current.accumMs));
    // Stop the sampling interval so the waveform freezes rather than filling
    // with silence.
    if (sampleTimerRef.current) {
      clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    setPhaseSync("paused");
  }, [setPhaseSync]);

  const resume = useCallback(() => {
    if (phaseRef.current !== "paused") return;
    const rec = recorderRef.current;
    if (rec && rec.state === "paused") {
      try {
        rec.resume();
      } catch {
        /* ignore */
      }
    }
    // Re-base the time origin so elapsed excludes the paused span.
    elapsedRef.current = elapsedResume(
      elapsedRef.current,
      performance.now(),
    );
    sampleTimerRef.current = setInterval(sampleTick, VOICE_SAMPLE_INTERVAL_MS);
    setPhaseSync("recording");
  }, [setPhaseSync, sampleTick]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && (rec.state === "recording" || rec.state === "paused")) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    } else if (phaseRef.current === "requesting") {
      // Released before getUserMedia resolved — the recorder doesn't exist
      // yet. Record the intent; the start path stops the recorder the instant
      // it's constructed (see stopRequestedRef after outstanding start).
      stopRequestedRef.current = true;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    teardownMedia();
    clearIntervals();
    chunksRef.current = [];
    storedPeaksRef.current = [];
    setPhaseSync("idle");
  }, [teardownMedia, clearIntervals, setPhaseSync]);

  // Stop cleanly on unmount so the mic LED doesn't stick on if the user
  // navigates away mid-take.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      teardownMedia();
      clearIntervals();
    };
  }, [teardownMedia, clearIntervals]);

  return {
    phase,
    elapsedMs,
    nearLimit,
    lastError,
    liveWindowRef,
    start,
    pause,
    resume,
    stop,
    cancel,
  };
}
