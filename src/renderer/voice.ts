// voice.ts — renderer-side voice recording + classification helpers.
//
// Push-to-talk MediaRecorder wrapper with a sticky `lastError` so the UI can
// surface mic-permission denials without subscribing to every state change.
// Recording is started on press, stopped on release; on stop we transcribe
// via window.api.voiceTranscribe and (in command mode) classify via
// window.api.voiceClassifyCommand.
//
// Pure helpers (mime selection, model fuzzy match) are at the bottom so
// chatUtils.test.ts-style tests can target them without the MediaRecorder
// surface area. The hook itself is component-coupled (refs/state).

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OpencodeModel,
  VoiceAction,
  VoiceClassifyResult,
} from "../shared/types";

export type VoiceMode = "dictate" | "command";

// Coarse phase exposed by useVoiceRecorder so the UI can render the mic
// button state. Transitions:
//   idle → requesting → recording → processing → idle (or error)
//   idle → requesting → error    (mic permission denied / no device)
export type VoicePhase =
  | "idle"
  | "requesting"  // browser is asking for mic permission / opening device
  | "recording"   // MediaRecorder is collecting chunks
  | "processing"  // recorder stopped, transcribe/classify in flight
  | "error";

export type VoiceResult =
  | { mode: "dictate"; text: string }
  | { mode: "command"; classify: VoiceClassifyResult };

export type UseVoiceRecorderOptions = {
  // Called when a press-and-hold cycle yields a transcribed result. The
  // caller dispatches: dictate → append to textarea; command → router.
  onResult: (r: VoiceResult) => void;
  // Optional error sink — defaults to logging. Use it to surface mic
  // permission denied / no key / network errors in the chat error banner.
  onError?: (err: Error) => void;
  // Hard cap on a single press so a stuck press doesn't burn quota. Default
  // 60s — Groq's whisper-large-v3-turbo handles ~25MB / ~half hour per call,
  // but most conversational use is well under a minute.
  maxDurationMs?: number;
};

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
 * Fuzzy-match a spoken model query to the available OpencodeModel list.
 * Returns the best match or null. Pure so it's testable without React.
 *
 * Strategy (first match wins):
 *   1. Exact lowercase ID hit  (query === m.id).
 *   2. ID contains all whitespace-split tokens from query.
 *   3. Name contains all whitespace-split tokens from query.
 *   4. providerID matches AND any of the above against the trimmed name.
 *
 * Why not Levenshtein: model names are short and the query is small;
 * substring matching is enough for "opus" → claude-opus-4-7,
 * "sonnet 4" → claude-sonnet-4-5, etc.
 */
export function fuzzyMatchModel(
  query: string,
  models: readonly OpencodeModel[],
): OpencodeModel | null {
  if (!query || !models.length) return null;
  const q = query.toLowerCase().trim();
  if (!q) return null;

  const direct = models.find((m) => m.id.toLowerCase() === q);
  if (direct) return direct;

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Tier 2: every token appears in m.id (case-insensitive).
  for (const m of models) {
    const id = m.id.toLowerCase();
    if (tokens.every((t) => id.includes(t))) return m;
  }
  // Tier 3: every token appears in m.name.
  for (const m of models) {
    const name = m.name.toLowerCase();
    if (tokens.every((t) => name.includes(t))) return m;
  }
  // Tier 4: providerID match + ANY token in id/name (loose).
  for (const m of models) {
    if (tokens[0] === m.providerID.toLowerCase()) return m;
  }
  return null;
}

/**
 * Match a spoken option label to a QuestionOption.label list. Returns the
 * exact label string (so the caller can call onReply([[label]])), or null
 * if no match. Numeric `choice` ("1", "2", "three") indexes by position
 * (1-based); everything else is case-insensitive substring.
 */
export function resolveQuestionAnswer(
  choice: string,
  options: readonly { label: string }[],
): string | null {
  if (!options.length) return null;
  const c = choice.trim();
  if (!c) return null;
  // Numeric → 1-based index
  const NUM_WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9,
  };
  const cLower = c.toLowerCase();
  const idx = NUM_WORDS[cLower] ?? Number.parseInt(cLower, 10);
  if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
    return options[idx - 1].label;
  }
  // Exact case-insensitive label match.
  const exact = options.find((o) => o.label.toLowerCase() === cLower);
  if (exact) return exact.label;
  // Substring fallback — "yes" matches "Yes, proceed".
  const sub = options.find((o) => o.label.toLowerCase().includes(cLower));
  if (sub) return sub.label;
  return null;
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
 * Push-to-talk hook. `start(mode)` opens the mic + begins recording.
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
  maxDurationMs = 60_000,
}: UseVoiceRecorderOptions) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  // Refs so concurrent start/stop don't race against React render cycles —
  // we need to know IMMEDIATELY whether we're already mid-press.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const modeRef = useRef<VoiceMode>("dictate");
  const mimeRef = useRef<string>("");
  const cancelledRef = useRef<boolean>(false);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setPhase("error");
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
    [onError],
  );

  const start = useCallback(
    async (mode: VoiceMode) => {
      if (phase === "recording" || phase === "requesting" || phase === "processing") {
        return;
      }
      setLastError(null);
      cancelledRef.current = false;
      modeRef.current = mode;
      const mime = pickRecorderMime();
      mimeRef.current = mime;
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        reportError(new Error("Microphone not available in this environment."));
        return;
      }
      setPhase("requesting");
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
          setPhase("idle");
          return;
        }
        const chunks = chunksRef.current;
        chunksRef.current = [];
        recorderRef.current = null;
        streamRef.current = null;
        if (chunks.length === 0) {
          setPhase("idle");
          return;
        }
        const blob = new Blob(chunks, { type: mimeRef.current || "audio/webm" });
        if (blob.size < 1024) {
          // Too short — Groq returns "audio_too_short". Don't bother.
          setPhase("idle");
          return;
        }
        setPhase("processing");
        try {
          const buffer = await blob.arrayBuffer();
          const res = await window.api.voiceTranscribe({
            buffer,
            mime: mimeRef.current || blob.type || "audio/webm",
          });
          const text = res.text.trim();
          if (!text) {
            setPhase("idle");
            return;
          }
          if (modeRef.current === "command") {
            const classified = await window.api.voiceClassifyCommand({
              transcript: text,
              useLlmFallback: true,
            });
            onResult({ mode: "command", classify: classified });
          } else {
            onResult({ mode: "dictate", text });
          }
          setPhase("idle");
        } catch (e) {
          reportError(e);
        }
      };
      try {
        recorder.start();
      } catch (e) {
        stopRecorder(recorder, stream);
        recorderRef.current = null;
        streamRef.current = null;
        reportError(e);
        return;
      }
      setPhase("recording");
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
    [phase, onResult, reportError, maxDurationMs],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
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
    setPhase("idle");
  }, []);

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

/**
 * Pure dispatcher: given a VoiceAction, return a description string for the
 * caller's switch (mostly for tests / debugging). The real dispatch is in
 * ChatPanel because the action handlers are panel-scoped useCallbacks.
 */
export function describeVoiceAction(a: VoiceAction): string {
  switch (a.kind) {
    case "submit":
      return `submit: ${a.text}`;
    case "append":
      return `append: ${a.text}`;
    case "model":
      return `model: ${a.query}`;
    case "switch-window":
      return `switch-window: ${a.index}`;
    case "answer":
      return `answer: ${a.choice}`;
    case "unknown":
      return `unknown: ${a.transcript}`;
    default:
      return a.kind;
  }
}
