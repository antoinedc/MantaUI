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
//   - The desktop voice keybinds (CmdOrCtrl+Shift+M / Enter / Space / Esc)
//   - The voiceEnabled gate (groqApiKey + MediaRecorder support)
//   - The transcription step (recorder hands back {blob, mime, peaks})
//
// No Electron-only deps — only `window.api.*`, which the mobile HTTP server
// shims.

import { useEffect, useRef, useState } from "react";
import { useVoiceRecorder } from "../voice";
import type { VoiceArtifact, VoicePhase } from "../voice";
import { VOICE_TAP_HOLD_MS } from "../../shared/waveform.mjs";
import { IS_MAC } from "../platform";

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

  // When the user presses Enter (or holds the CmdOrCtrl+Shift+M shortcut into
  // push-to-talk) WHILE the desktop voice recorder is active, we want the
  // transcribed text to land in the composer AND immediately submit, in one
  // keystroke.
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
  const voicePauseRef = useRef(voiceRecorder.pause);
  voicePauseRef.current = voiceRecorder.pause;
  const voiceResumeRef = useRef(voiceRecorder.resume);
  voiceResumeRef.current = voiceRecorder.resume;
  // Timestamp the shortcut's keydown so keyup can decide tap-vs-hold.
  const voiceKeyDownAtRef = useRef<number | null>(null);
  const voiceRecording =
    voiceRecorder.phase === "recording" ||
    voiceRecorder.phase === "requesting" ||
    voiceRecorder.phase === "paused";
  const voiceProcessing = transcribing;

  // Desktop voice keybinds (CmdOrCtrl+Shift+M / Enter / Space / Esc).
  //
  // CmdOrCtrl+Shift+M mirrors the mic button's tap-versus-hold model:
  //   keydown while idle → start recording immediately (never wait for the
  //                        threshold — that would swallow the first
  //                        quarter-second of speech) and timestamp the press.
  //   keyup while a take → held >= VOICE_TAP_HOLD_MS → it was push-to-talk →
  //                        stop and send (insert at the caret). Held <
  //                        threshold → it was a tap → stay recording (toggle
  //                        stays ON).
  //   keydown while recording/paused → stop and send (tap toggles OFF).
  // Enter stops+submits; Space pauses/resumes (only while the composer
  // textarea is NOT focused, so typing a space never pauses); Esc discards.
  // Enter/Space/Esc stopPropagation while a take is active so the composer's
  // own handlers do not also fire.
  useEffect(() => {
    if (!voiceEnabled) return;

    const isShortcut = (e: KeyboardEvent) => {
      if (e.altKey || !e.shiftKey) return false;
      if (e.key.toLowerCase() !== "m") return false;
      // CmdOrCtrl = meta on macOS, ctrl elsewhere.
      return IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    };

    const takeActive = () => {
      const p = voicePhaseRef.current;
      return p === "requesting" || p === "recording" || p === "paused";
    };
    // The shortcut's end-a-take path: stop and insert at the caret (dictate),
    // but do NOT auto-submit — Enter is the act of sending.
    const stopAndSendShortcut = () => {
      submitAfterTranscribeRef.current = false;
      voiceStopRef.current();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const phase = voicePhaseRef.current;
        if (
          phase === "recording" ||
          phase === "requesting" ||
          phase === "paused"
        ) {
          // keydown while a take is active → tap toggles OFF: stop and send.
          voiceKeyDownAtRef.current = null;
          stopAndSendShortcut();
        } else if (phase === "idle" || phase === "error") {
          // keydown while idle → start immediately + timestamp for tap/hold.
          voiceKeyDownAtRef.current = performance.now();
          void voiceStartRef.current();
        }
        return;
      }
      if (!takeActive()) return;
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const p = voicePhaseRef.current;
        if (p !== "recording" && p !== "paused") return;
        e.preventDefault();
        e.stopPropagation();
        submitAfterTranscribeRef.current = true;
        voiceStopRef.current();
        return;
      }
      if (
        e.key === " " &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        // Space pauses/resumes but never while the composer textarea is
        // focused — typing a space into the message must not pause a take.
        if (inputRef.current && document.activeElement === inputRef.current) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (voicePhaseRef.current === "recording") voicePauseRef.current();
        else if (voicePhaseRef.current === "paused") voiceResumeRef.current();
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

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const downAt = voiceKeyDownAtRef.current;
      voiceKeyDownAtRef.current = null;
      if (downAt == null) return;
      if (!takeActive()) return;
      const held = performance.now() - downAt;
      if (held >= VOICE_TAP_HOLD_MS) {
        // It was push-to-talk → stop and send (insert at the caret).
        stopAndSendShortcut();
      }
      // else: it was a tap → stay recording (toggle stays ON).
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [voiceEnabled, inputRef]);

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
