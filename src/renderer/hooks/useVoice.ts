// ===== useVoice =====
//
// Extracted from ChatPanel.tsx (BET-64). Wraps `useVoiceRecorder` from
// `./voice.ts` and adds the dictation-only behaviour, keybinds, gating, and
// (BET-836) the recording composer's discard-confirmation + a11y
// announcements. Orchestration lives HERE, on top of the recorder's
// onComplete artifact: we transcribe via `voice:transcribe`, insert into the
// composer at the caret, and keep the desktop keyboard driving the session.
//
// The hook owns:
//   - The voiceRecorder instance (via useVoiceRecorder)
//   - The desktop voice keybinds (CmdOrCtrl+Shift+M / Enter / Space / Esc)
//   - The voiceEnabled gate (groqApiKey + MediaRecorder support)
//   - The transcription step (recorder hands back {blob, mime, peaks})
//   - The discard-with-confirmation state (BET-836)
//   - The aria-live announcements for the recording lifecycle (BET-836)
//
// No Electron-only deps — only `window.api.*`, which the mobile HTTP server
// shims.

import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceRecorder } from "../voice";
import type { VoiceArtifact, VoicePhase } from "../voice";
import { VOICE_TAP_HOLD_MS, VOICE_CONFIRM_DISCARD_MS } from "../../shared/waveform.mjs";
import { IS_MAC } from "../platform";

export type Voice = {
  voiceEnabled: boolean;
  voiceRecording: boolean;
  voiceProcessing: boolean;
  // Shown in the visually-hidden aria-live region (Recording started / paused /
  // resumed / discarded). Not a timer — the timer must never live in a region.
  voiceAnnouncement: string;
  voiceRecorder: {
    phase: VoicePhase;
    elapsedMs: number;
    nearLimit: boolean;
    lastError: string | null;
    liveWindowRef: React.RefObject<Float32Array>;
    start: () => void;
    pause: () => void;
    resume: () => void;
    // Stop the take and submit the transcript — the send button, Enter, a
    // push-to-talk release.
    send: () => void;
    // End the take WITHOUT submitting — transcribe and insert at the caret
    // only. The non-toggled dictation mic (release-to-insert) uses this.
    stop: () => void;
    // Discard, subject to the confirmation rule under VOICE_CONFIRM_DISCARD_MS.
    requestDiscard: () => void;
    // Immediate discard (OS gesture abort — the pointer-cancel path).
    cancel: () => void;
    discardArmed: boolean;
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

  // When the user presses Enter, or ends a push-to-talk hold (the
  // CmdOrCtrl+Shift+M shortcut or a mic hold-release), WHILE the desktop voice
  // recorder is active, we want the transcribed text to land in the composer
  // AND immediately submit, in one keystroke.
  const submitAfterTranscribeRef = useRef(false);
  // Transcription in flight — the recorder's own phases don't include
  // "processing" (that is our business now), so we track it here for the UI.
  const [transcribing, setTranscribing] = useState(false);

  // Discard-with-confirmation state (BET-836). Under VOICE_CONFIRM_DISCARD_MS
  // the first discard discards immediately; at or above it the first discard
  // ARMS (the trash button reads "Discard?"), and a second discard within the
  // window confirms. Anything else cancels the arming.
  const [discardArmed, setDiscardArmed] = useState(false);
  const [voiceAnnouncement, setVoiceAnnouncement] = useState("");
  const discardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unarmDiscard = useCallback(() => {
    if (discardTimerRef.current) {
      clearTimeout(discardTimerRef.current);
      discardTimerRef.current = null;
    }
    setDiscardArmed(false);
  }, []);

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
  const voiceElapsedMsRef = useRef(voiceRecorder.elapsedMs);
  voiceElapsedMsRef.current = voiceRecorder.elapsedMs;

  // Announcement + discard wrappers around the recorder's primitives. Every
  // public action (start/pause/resume/send/stop/cancel/discard) clears any
  // pending discard-arming and, where it begins a lifecycle transition,
  // announces it in the polite aria-live region.
  const start = useCallback(() => {
    unarmDiscard();
    setVoiceAnnouncement("Recording started");
    voiceRecorder.start();
  }, [voiceRecorder, unarmDiscard]);
  const pause = useCallback(() => {
    unarmDiscard();
    setVoiceAnnouncement("Recording paused");
    voiceRecorder.pause();
  }, [voiceRecorder, unarmDiscard]);
  const resume = useCallback(() => {
    unarmDiscard();
    setVoiceAnnouncement("Recording resumed");
    voiceRecorder.resume();
  }, [voiceRecorder, unarmDiscard]);
  const send = useCallback(() => {
    unarmDiscard();
    submitAfterTranscribeRef.current = true;
    voiceRecorder.stop();
  }, [voiceRecorder, unarmDiscard]);
  const stop = useCallback(() => {
    unarmDiscard();
    voiceRecorder.stop();
  }, [voiceRecorder, unarmDiscard]);
  const cancel = useCallback(() => {
    unarmDiscard();
    voiceRecorder.cancel();
  }, [voiceRecorder, unarmDiscard]);
  const requestDiscard = useCallback(() => {
    const phase = voicePhaseRef.current;
    if (phase !== "recording" && phase !== "paused") return;
    if (discardArmed) {
      // Second discard within the window — confirm.
      unarmDiscard();
      setVoiceAnnouncement("Recording discarded");
      voiceRecorder.cancel();
      return;
    }
    if (voiceElapsedMsRef.current < VOICE_CONFIRM_DISCARD_MS) {
      // Short take — discard immediately.
      setVoiceAnnouncement("Recording discarded");
      voiceRecorder.cancel();
      return;
    }
    // Long take — arm.
    setDiscardArmed(true);
    discardTimerRef.current = setTimeout(unarmDiscard, 3000);
  }, [discardArmed, unarmDiscard, voiceRecorder]);

  // "Anything else cancels the arming": leaving recording/paused unarms.
  useEffect(() => {
    const phase = voiceRecorder.phase;
    if (phase !== "recording" && phase !== "paused" && discardArmed) {
      unarmDiscard();
    }
  }, [voiceRecorder.phase, discardArmed, unarmDiscard]);

  // Stop cleanly: clear the arming timer on unmount.
  useEffect(() => {
    return () => {
      if (discardTimerRef.current) clearTimeout(discardTimerRef.current);
    };
  }, []);

  const voiceStartRef = useRef(start);
  voiceStartRef.current = start;
  const voiceStopRef = useRef(stop);
  voiceStopRef.current = stop;
  const voiceSendRef = useRef(send);
  voiceSendRef.current = send;
  const voicePauseRef = useRef(pause);
  voicePauseRef.current = pause;
  const voiceResumeRef = useRef(resume);
  voiceResumeRef.current = resume;
  const voiceRequestDiscardRef = useRef(requestDiscard);
  voiceRequestDiscardRef.current = requestDiscard;
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
  // textarea is NOT focused, so typing a space never pauses); Esc discards
  // (with confirmation above VOICE_CONFIRM_DISCARD_MS). Enter/Space/Esc
  // stopPropagation while a take is active so the composer's own handlers do
  // not also fire.
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
        if (phase === "recording" || phase === "requesting" || phase === "paused") {
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
        voiceSendRef.current();
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
        voiceRequestDiscardRef.current();
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
    voiceAnnouncement,
    voiceRecorder: {
      phase: voiceRecorder.phase,
      elapsedMs: voiceRecorder.elapsedMs,
      nearLimit: voiceRecorder.nearLimit,
      lastError: voiceRecorder.lastError,
      liveWindowRef: voiceRecorder.liveWindowRef,
      start,
      pause,
      resume,
      send,
      stop,
      requestDiscard,
      cancel,
      discardArmed,
    },
  };
}
