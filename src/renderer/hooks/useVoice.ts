// ===== useVoice =====
//
// Extracted from ChatPanel.tsx (BET-64). Wraps `useVoiceRecorder` from
// `./voice.ts` and adds the voice-specific dispatch logic, keybinds, and
// gating. Most self-contained of the four hooks — the main coupling is
// `dispatchVoiceAction` which references callbacks from other hooks
// (submit, abort, etc.) — these are injected as props.
//
// The hook owns:
//   - The voiceRecorder instance (via useVoiceRecorder)
//   - The dispatchVoiceAction callback (routes VoiceAction to panel callbacks)
//   - The desktop voice keybinds (Ctrl+M / Enter / Esc)
//   - The voiceEnabled gate (groqApiKey + MediaRecorder support)
//
// No Electron-only deps — only `window.api.*`, which the mobile HTTP server
// shims.

import { useCallback, useEffect, useRef } from "react";
import type { VoiceAction } from "../../shared/types";
import { useVoiceRecorder, fuzzyMatchModel, resolveQuestionAnswer } from "../voice";
import type { VoicePhase, VoiceMode } from "../voice";
import { findLast } from "../chatShared";

export type Voice = {
  voiceEnabled: boolean;
  voiceRecording: boolean;
  voiceProcessing: boolean;
  voiceRecorder: {
    phase: VoicePhase;
    mode: VoiceMode;
    start: (mode: VoiceMode) => void;
    stop: () => void;
    cancel: () => void;
  };
  dispatchVoiceAction: (action: VoiceAction) => void;
};

export function useVoice(params: {
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  models: import("../../shared/types").OpencodeModel[] | null;
  permissions: import("../../shared/types").PermissionRequest[];
  questions: import("../../shared/types").QuestionRequest[];
  sessionId: string;
  chatAutoAllow: boolean;
  setChatAutoAllow: (v: boolean) => void;
  selectModel: (m: { providerID: string; modelID: string }) => void;
  compactSession: () => void;
  forkSession: () => void;
  abort: () => void;
  replyPermission: (id: string, reply: string) => void;
  replyQuestion: (q: import("../../shared/types").QuestionRequest, answers: string[][]) => void;
  rejectQuestion: (q: import("../../shared/types").QuestionRequest) => void;
  submitRef: React.RefObject<() => void>;
  setSendError: (e: string | null) => void;
  setSystemNotice: (n: string | null) => void;
  groqApiKey: string;
}): Voice {
  const {
    input,
    setInput,
    inputRef,
    models,
    permissions,
    questions,
    sessionId,
    chatAutoAllow,
    setChatAutoAllow,
    selectModel,
    compactSession,
    forkSession,
    abort,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    submitRef,
    setSendError,
    setSystemNotice,
    groqApiKey,
  } = params;

  // When the user presses Enter (or Ctrl+M) WHILE the desktop voice
  // recorder is active, we want the transcribed text to land in the
  // composer AND immediately submit, in one keystroke.
  const submitAfterTranscribeRef = useRef(false);

  const dispatchVoiceAction = useCallback(
    (action: VoiceAction) => {
      switch (action.kind) {
        case "append": {
          const el = inputRef.current;
          if (el) {
            const start = el.selectionStart ?? input.length;
            const end = el.selectionEnd ?? input.length;
            const prefix = input.slice(0, start);
            const suffix = input.slice(end);
            const sep = prefix && !prefix.endsWith(" ") ? " " : "";
            const tail = suffix && !suffix.startsWith(" ") ? " " : "";
            const next = `${prefix}${sep}${action.text}${tail}${suffix}`;
            setInput(next);
            setTimeout(() => {
              if (!inputRef.current) return;
              const pos = (prefix + sep + action.text).length;
              try {
                inputRef.current.focus();
                inputRef.current.setSelectionRange(pos, pos);
              } catch { /* ignore */ }
            }, 0);
          } else {
            setInput(input ? `${input} ${action.text}` : action.text);
          }
          return;
        }
        case "submit": {
          setInput(action.text);
          setTimeout(() => submitRef.current?.(), 0);
          return;
        }
        case "clear":
          setInput("/clear");
          setTimeout(() => submitRef.current?.(), 0);
          return;
        case "compact": compactSession(); return;
        case "fork":    forkSession();    return;
        case "abort":   abort();          return;
        case "help":    setSystemNotice("/help output"); return;
        case "toggle-trust":
          setChatAutoAllow(!chatAutoAllow);
          return;
        case "model": {
          const match = fuzzyMatchModel(action.query, models ?? []);
          if (match) selectModel({ providerID: match.providerID, modelID: match.id });
          else setSendError(`No model matched "${action.query}".`);
          return;
        }
        case "allow-once":
        case "allow-always":
        case "reject": {
          const lastPerm = findLast(permissions, (p) => p.sessionID === sessionId);
          if (lastPerm) {
            const reply =
              action.kind === "allow-once" ? "once"
                : action.kind === "allow-always" ? "always"
                  : "reject";
            replyPermission(lastPerm.id, reply);
            return;
          }
          if (action.kind === "reject") {
            const lastQ = findLast(questions, (q) => q.sessionID === sessionId);
            if (lastQ) {
              rejectQuestion(lastQ);
              return;
            }
          }
          setSendError("No pending permission request to respond to.");
          return;
        }
        case "answer": {
          const pending = findLast(
            questions,
            (q) => q.sessionID === sessionId && q.questions.length > 0,
          );
          if (!pending) {
            setSendError("No pending question to answer.");
            return;
          }
          const answers: string[][] = [];
          for (const sub of pending.questions) {
            const label = resolveQuestionAnswer(action.choice, sub.options);
            if (!label) {
              setSendError(
                `Couldn't match "${action.choice}" to an option. ` +
                `Available: ${sub.options.map((o) => o.label).join(", ")}.`,
              );
              return;
            }
            answers.push([label]);
          }
          replyQuestion(pending, answers);
          return;
        }
        case "switch-window":
        case "new-session":
        case "open-settings":
          window.dispatchEvent(
            new CustomEvent("manta-voice-app-action", { detail: action }),
          );
          return;
        case "unknown": {
          const text = action.transcript.trim();
          if (text) setInput(input ? `${input} ${text}` : text);
          return;
        }
      }
    },
    [
      input,
      models,
      permissions,
      questions,
      sessionId,
      chatAutoAllow,
      setChatAutoAllow,
      selectModel,
      compactSession,
      forkSession,
      abort,
      replyPermission,
      replyQuestion,
      rejectQuestion,
    ],
  );

  const voiceRecorder = useVoiceRecorder({
    onResult: (r) => {
      if (r.mode === "dictate") {
        dispatchVoiceAction({ kind: "append", text: r.text });
        if (submitAfterTranscribeRef.current) {
          submitAfterTranscribeRef.current = false;
          setTimeout(() => submitRef.current?.(), 0);
        }
      } else {
        dispatchVoiceAction(r.classify.action);
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
    voiceRecorder.phase === "requesting";
  const voiceProcessing = voiceRecorder.phase === "processing";

  // Desktop voice keybinds (Ctrl+M / Enter / Esc)
  useEffect(() => {
    if (!voiceEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        const phase = voicePhaseRef.current;
        if (phase === "recording" || phase === "requesting") {
          submitAfterTranscribeRef.current = false;
          voiceStopRef.current();
        } else if (phase === "idle" || phase === "error") {
          void voiceStartRef.current("dictate");
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
        if (phase !== "recording") return;
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
      mode: voiceRecorder.mode,
      start: voiceRecorder.start,
      stop: voiceRecorder.stop,
      cancel: voiceRecorder.cancel,
    },
    dispatchVoiceAction,
  };
}
