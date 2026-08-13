// voice.ts — renderer-side voice recording + transcribe helpers.
//
// Push-to-talk MediaRecorder wrapper with a sticky `lastError` so the UI can
// surface mic-permission denials without subscribing to every state change.
// Recording is started on press, stopped on release; on stop we transcribe
// via window.api.voiceTranscribe and hand the raw text to `onResult`.
//
// The hook itself is component-coupled (refs/state).

import { useCallback, useEffect, useRef, useState } from "react";

export type VoicePhase =
  | "idle"
  | "requesting"  // browser is asking for mic permission / opening device
  | "recording"   // MediaRecorder is collecting chunks
  | "processing"  // recorder stopped, transcribe in flight
  | "error";

export type UseVoiceRecorderOptions = {
  // Called when a press-and-hold cycle yields a transcribed result. The
  // caller inserts the text into the composer (dictation-only).
  onResult: (text: string) => void;
  // Optional error sink — defaults to logging. Use it to surface mic
  // permission denied / no key / network errors in the chat error banner.
  onError?: (err: Error) => void;
  // Optional sink for the "recorded but nothing usable came back" case:
  // the clip was too short (< ~1KB) OR Groq returned an empty transcript
  // (silence / unintelligible). This is NOT an error — the pipeline worked,
  // there was just nothing to insert. Without this the hook silently returns
  // to idle and the user sees zero feedback after releasing the mic ("I
  // pressed it, it went red, released, and nothing happened"). `reason`
  // distinguishes the two so the UI can word the hint appropriately.
  onEmpty?: (reason: "too-short" | "no-speech") => void;
  // Hard cap on a single press so a stuck press doesn't burn quota. Default
  // 60s — Groq's whisper-large-v3-turbo handles ~25MB / ~half hour per call,
  // but most conversational use is well under a minute.
  maxDurationMs?: number;
};

// MediaRecorder timeslice. Without a timeslice argument, MediaRecorder is
// spec'd to emit a single `dataavailable` at stop time — and on iOS 17.x
// WKWebView that event sometimes fires AFTER `onstop`, leaving an empty
// chunks array. 250ms forces periodic emission, so the Blob is whole by
// the time onstop runs. The chunks just concatenate downstream — no logic
// change. See PR #4 review (W1).
const RECORDER_TIMESLICE_MS = 250;

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
 * Internal: stop and tear down the recorder + mic stream. Safe to call
 * repeatedly. Used both by release-press and by error/unmount paths.
 */
function stopRecorder(
  recorder: MediaRecorder | null,
  stream: MediaStream | null,
): void {
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch {
    /* already stopped or never started */
  }
  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* track already ended */
      }
    }
  }
}

/**
 * Push-to-talk hook. `start()` opens the mic + begins recording.
 * `stop()` ends recording and dispatches the transcript through
 * `onResult`. `cancel()` discards the current recording without
 * transcribing (escape hatch for "user changed their mind mid-press").
 *
 * Re-entrancy: a second start() while already recording is a no-op.
 * Unmount stops cleanly so the mic LED doesn't stick on.
 */
export function useVoiceRecorder({
  onResult,
  onError,
  onEmpty,
  maxDurationMs = 60_000,
}: UseVoiceRecorderOptions) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  // phaseRef shadows `phase` for synchronous re-entrancy guards. React
  // state lags behind event handlers within the same commit (W4 from
  // review: two pointerdowns could both pass the state-based guard).
  const phaseRef = useRef<VoicePhase>("idle");
  const setPhaseSync = useCallback((p: VoicePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);
  // Refs so concurrent start/stop don't race against React render cycles —
  // we need to know IMMEDIATELY whether we're already mid-press.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const cancelledRef = useRef<boolean>(false);
  // Set when stop() is called during the "requesting" window (mic permission /
  // getUserMedia still pending, recorder not yet constructed). The start path
  // checks this right after getUserMedia resolves and immediately stops the
  // freshly-started recorder so a quick press doesn't record to the 60s cap.
  // Distinct from cancelledRef: a stop is a deliberate "send what I said",
  // whereas cancel discards. (For a too-quick press there's no audio yet, so
  // both behave the same in practice, but keeping them separate means a
  // slightly-slow getUserMedia still captures the tail of speech.)
  const stopRequestedRef = useRef<boolean>(false);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setPhaseSync("error");
      if (onError) {
        try {
          onError(err instanceof Error ? err : new Error(msg));
        } catch {
          /* user-supplied callback threw — ignore */
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn("[voice]", msg);
      }
    },
    [onError, setPhaseSync],
  );

  const start = useCallback(
    async () => {
      // W4: ref-based guard. The state-based phase check used to leak
      // double-presses inside the same React commit; phaseRef is updated
      // synchronously via setPhaseSync so it can't lie.
      if (
        phaseRef.current === "recording" ||
        phaseRef.current === "requesting" ||
        phaseRef.current === "processing"
      ) {
        return;
      }
      setLastError(null);
      cancelledRef.current = false;
      stopRequestedRef.current = false;
      const mime = pickRecorderMime();
      mimeRef.current = mime;
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
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
            ? new Error("Microphone permission denied. Allow it in your browser/OS settings.")
            : (e as Error) ?? new Error("Could not access microphone."),
        );
        return;
      }
      // W3: if the user already released (cancel() flipped cancelledRef
      // while we were awaiting getUserMedia), abandon NOW — tear the mic
      // down, don't construct a recorder that nothing will stop. Without
      // this the maxDurationMs timer would record for the full 60s after
      // a too-quick press.
      if (cancelledRef.current) {
        for (const t of stream.getTracks()) {
          try { t.stop(); } catch { /* ignore */ }
        }
        setPhaseSync("idle");
        return;
      }
      streamRef.current = stream;
      let recorder: MediaRecorder;
      try {
        recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
      } catch (e) {
        stopRecorder(null, stream);
        streamRef.current = null;
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
      recorder.onstop = async () => {
        // Tear down the mic immediately so the OS-level recording indicator
        // disappears even before the transcribe call returns.
        if (streamRef.current) {
          for (const t of streamRef.current.getTracks()) {
            try {
              t.stop();
            } catch {
              /* ignore */
            }
          }
        }
        if (maxTimerRef.current) {
          clearTimeout(maxTimerRef.current);
          maxTimerRef.current = null;
        }
        if (cancelledRef.current) {
          chunksRef.current = [];
          recorderRef.current = null;
          streamRef.current = null;
          setPhaseSync("idle");
          return;
        }
        const chunks = chunksRef.current;
        chunksRef.current = [];
        recorderRef.current = null;
        streamRef.current = null;
        if (chunks.length === 0) {
          setPhaseSync("idle");
          return;
        }
        const blob = new Blob(chunks, { type: mimeRef.current || "audio/webm" });
        if (blob.size < 1024) {
          // Too short — Groq returns "audio_too_short". Don't bother. Tell the
          // UI so the user gets feedback instead of a silent no-op.
          setPhaseSync("idle");
          onEmpty?.("too-short");
          return;
        }
        setPhaseSync("processing");
        try {
          const buffer = await blob.arrayBuffer();
          const res = await window.api.voiceTranscribe({
            buffer,
            mime: mimeRef.current || blob.type || "audio/webm",
          });
          const text = res.text.trim();
          if (!text) {
            // Pipeline worked but Groq heard no speech (silence / too quiet /
            // unintelligible). Surface it so the release isn't a silent no-op.
            setPhaseSync("idle");
            onEmpty?.("no-speech");
            return;
          }
          onResult(text);
          setPhaseSync("idle");
        } catch (e) {
          reportError(e);
        }
      };
      try {
        // W1: 250ms timeslice so ondataavailable fires periodically.
        // Without it, iOS WKWebView occasionally drops the final chunk
        // when it arrives after onstop, leaving an empty Blob.
        recorder.start(RECORDER_TIMESLICE_MS);
      } catch (e) {
        stopRecorder(recorder, stream);
        recorderRef.current = null;
        streamRef.current = null;
        reportError(e);
        return;
      }
      setPhaseSync("recording");
      // The user may have already released DURING the getUserMedia await
      // (stop() set stopRequestedRef before the recorder existed). Honor it
      // now: stop the just-started recorder so onstop fires and transcribes
      // the brief tail instead of running to maxDuration. A genuinely empty
      // clip falls through to the onEmpty("too-short") notice in onstop.
      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        try {
          recorder.stop();
        } catch {
          /* already inactive */
        }
        return;
      }
      // Auto-stop after maxDurationMs so a stuck press doesn't burn quota.
      maxTimerRef.current = setTimeout(() => {
        if (recorderRef.current && recorderRef.current.state === "recording") {
          try {
            recorderRef.current.stop();
          } catch {
            /* already stopped */
          }
        }
      }, maxDurationMs);
    },
    [onResult, onEmpty, reportError, maxDurationMs, setPhaseSync],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    } else if (phaseRef.current === "requesting") {
      // Released before getUserMedia resolved — the recorder doesn't exist
      // yet. Record the intent; the start path stops the recorder the instant
      // it's constructed (see stopRequestedRef check after recorder.start()).
      // Without this the recording would run unstoppable to the 60s cap and
      // the release would appear to do nothing.
      stopRequestedRef.current = true;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recorderRef.current;
    const stream = streamRef.current;
    stopRecorder(rec, stream);
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    setPhaseSync("idle");
  }, [setPhaseSync]);

  // Stop cleanly on unmount so the mic LED doesn't stick on if the user
  // navigates away mid-press.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      stopRecorder(recorderRef.current, streamRef.current);
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    };
  }, []);

  return { phase, lastError, start, stop, cancel };
}
