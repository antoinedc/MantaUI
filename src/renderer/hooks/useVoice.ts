// ===== useVoice =====
//
// Extracted from ChatPanel.tsx (BET-64). Wraps `useVoiceRecorder` from
// `./voice.ts` and adds the dictation-only behaviour, keybinds, and gating.
// Orchestration lives HERE, on top of the recorder's onComplete artifact:
// we transcribe via `voice:transcribe`, insert into the composer at the
// caret, and keep the desktop keyboard driving the session.
//
// The hook owns:
//   - The voiceRecorder instance (via useVoiceRecorder)
//   - The desktop voice keybinds (Ctrl+M / Enter / Esc)
//   - The voiceEnabled gate (groqApiKey + MediaRecorder support)
//   - The transcription step (recorder hands back {blob, mime, peaks})
//
// No Electron-only deps — only `window.api.*`, which the mobile HTTP server
// shims.

import { useEffect, useRef, useState } from "react";
import { useVoiceRecorder } from "../voice";
import type { VoiceArtifact, VoicePhase } from "../voice";

export type Voice = {
  voiceEnabled: boolean;
  voiceRecording: boolean;
  voiceProcessing: boolean;
  voiceRecorder: {
    phase: VoicePhase;
    elapsedSec: number;
    nearLimit: boolean;
    start: () => void;
    pause: () => void;
    resume: () => void;
    stop: () => void;
    cancel: () => void;
  };
};

export function useVoice(params: {
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  submitRef: React.RefObject<() => void>;
  setSendError: (e: string | null) => void;
  setSystemNotice: (n: string | null) => void;
  groqApiKey: string;
}): Voice {
  const {
    input,
    setInput,
    inputRef,
    submitRef,
    setSendError,
    setSystemNotice,
    groqApiKey,
  } = params;

  // When the user presses Enter (or Ctrl+M) WHILE the desktop voice recorder
  // is active, we want the transcribed text to land in the composer AND
  // immediately submit, in one keystroke.
  const submitAfterTranscribeRef = useRef(false);
  // Transcription in flight — the recorder's own phases don't include
  // "processing" (that is our business now), so we track it here for the UI.
  const [transcribing, setTranscribing] = useState(false);

  // Insert text at the caret, mirroring the composer's append behaviour.
  const insertAtCaret = (text: string) => {
    const el = inputRef.current;
    if (el) {
      const start = el.selectionStart ?? input.length;
      const end = el.selectionEnd ?? input.length;
      const prefix = input.slice(0, start);
      const suffix = input.slice(end);
      const sep = prefix && !prefix.endsWith(" ") ? " " : "";
      const tail = suffix && !suffix.startsWith(" ") ? " " : "";
      const next = `${prefix}${sep}${text}${tail}${suffix}`;
      setInput(next);
      setTimeout(() => {
        if (!inputRef.current) return;
        const pos = (prefix + sep + text).length;
        try {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(pos, pos);
        } catch { /* ignore */ }
      }, 0);
    } else {
      setInput(input ? `${input} ${text}` : text);
    }
  };

  const voiceRecorder = useVoiceRecorder({
    onComplete: async (artifact: VoiceArtifact) => {
      // Transcribe the artifact the recorder handed back. The new upload
      // route is NOT used yet — that lands with the transcript ticket.
      setTranscribing(true);
      try {
        const buffer = await artifact.blob.arrayBuffer();
        const res = await window.api.voiceTranscribe({
          buffer,
          mime: artifact.mime,
        });
        const text = res.text.trim();
        if (!text) {
          // Pipeline worked but Groq heard no speech (silence / too quiet /
          // unintelligible). Surface it so the release isn't a silent no-op.
          submitAfterTranscribeRef.current = false;
          setSystemNotice(
            "Didn't catch any speech. Try again, a little louder or closer to the mic.",
          );
          return;
        }
        insertAtCaret(text);
        if (submitAfterTranscribeRef.current) {
          submitAfterTranscribeRef.current = false;
          setTimeout(() => submitRef.current?.(), 0);
        }
      } catch (e) {
        submitAfterTranscribeRef.current = false;
        setSendError(e instanceof Error ? e.message : String(e));
      } finally {
        setTranscribing(false);
      }
    },
    onError: (e) => {
      submitAfterTranscribeRef.current = false;
      setSendError(e.message);
    },
    onEmpty: (reason) => {
      submitAfterTranscribeRef.current = false;
      setSystemNotice(
        reason === "too-short"
          ? "Didn't catch that — the recording was too short. Hold a bit longer."
          : "Didn't catch any speech. Try again, a little louder or closer to the mic.",
      );
    },
    onWarning: (msg) => {
      setSystemNotice(msg);
    },
  });

  const voiceEnabled =
    !!groqApiKey &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const voicePhaseRef = useRef(voiceRecorder.phase);
  voicePhaseRef.current = voiceRecorder.phase;
  const voiceStartRef = useRef(voiceRecorder.start);
  voiceStartRef.current = voiceRecorder.start;
  const voiceStopRef = useRef(voiceRecorder.stop);
  voiceStopRef.current = voiceRecorder.stop;
  const voiceCancelRef = useRef(voiceRecorder.cancel);
  voiceCancelRef.current = voiceRecorder.cancel;
  const voiceRecording =
    voiceRecorder.phase === "recording" ||
    voiceRecorder.phase === "requesting" ||
    voiceRecorder.phase === "paused";
  const voiceProcessing = transcribing;

  // Desktop voice keybinds (Ctrl+M / Enter / Esc)
  useEffect(() => {
    if (!voiceEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        const phase = voicePhaseRef.current;
        if (
          phase === "recording" ||
          phase === "requesting" ||
          phase === "paused"
        ) {
          submitAfterTranscribeRef.current = false;
          voiceStopRef.current();
        } else if (phase === "idle" || phase === "error") {
          void voiceStartRef.current();
        }
        return;
      }
      const phase = voicePhaseRef.current;
      if (phase === "idle" || phase === "error") return;
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (phase !== "recording" && phase !== "paused") return;
        e.preventDefault();
        e.stopPropagation();
        submitAfterTranscribeRef.current = true;
        voiceStopRef.current();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        submitAfterTranscribeRef.current = false;
        voiceCancelRef.current();
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [voiceEnabled]);

  return {
    voiceEnabled,
    voiceRecording,
    voiceProcessing,
    voiceRecorder: {
      phase: voiceRecorder.phase,
      elapsedSec: voiceRecorder.elapsedSec,
      nearLimit: voiceRecorder.nearLimit,
      start: voiceRecorder.start,
      pause: voiceRecorder.pause,
      resume: voiceRecorder.resume,
      stop: voiceRecorder.stop,
      cancel: voiceRecorder.cancel,
    },
  };
}
