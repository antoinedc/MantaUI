// ===== useComposerController =====
//
// The ONE reusable composer container (BET — CTO full composer). Everything in
// `ChatPanel` that existed SOLELY to feed `<Composer>` — the input value +
// prompt history, the @-mention / command typeahead, voice, attachments (upload
// lifecycle, drop, paste, pending screenshots), model selection / override /
// routing / effort / Auto, plan mode, and the `chatAutoAllow` trust toggle —
// lives here, so both `ChatPanel` and `CtoChat` reach the SAME code path
// through the SAME components instead of each hand-rolling a lookalike.
//
// WHY A HOOK (not a container component): the divergent pieces — how a send is
// assembled, whether a running turn queues client-side or server-side, what the
// history key is — are OWNED BY THE HOST. ChatPanel's `submit` is entangled
// with routing decisions, optimistic-transcript append, and compaction state
// that are NOT composer state; hoisting it into a shared component would force
// all of that back down as props. A hook instead LETS THE HOST KEEP ITS SEND
// PATH while the hook owns the input surface, and returns a ready-to-spread
// `composerProps` bundle plus the raw state the host's own `submit` reads
// (attachments, agent mentions, the resolved model, plan). One source of truth
// for the composer; the host decides only what a send DOES.
//
// PARAMETERISED OVER EXACTLY WHAT DIFFERS, AND NOTHING ELSE:
//   - `submit` / `abort` / `running` / `refreshing` / `sendError` — the send
//     transport and its status, host-owned. A session composer wires these to
//     opencode + its client-side queue; the CTO conversation wires them to the
//     durable server-side admission seam (docs/cto-admission-contract.md).
//     The CTO chat can use the SAME send CALL as a session because
//     `src/server/ctoConversation.mjs` already reroutes an `opencode:prompt`
//     aimed at the CTO session through the admission queue — but its rich
//     per-state errors are host-owned, so `sendError` is supplied, not owned.
//   - Queue semantics (the ONE real divergence). A session composer owns a
//     CLIENT-side queue and pops the last queued message back into the box
//     (`onQueuePop`). The CTO conversation's queue is SERVER-owned and
//     deliberately NOT client-drainable — its `onQueuePop` is a no-op and it
//     renders the server's queue projection as pending bubbles itself. This
//     hook keeps that difference explicit; it never gives the CTO a client
//     queue nor strips the session's.
//   - `historyScope` — prompt history is keyed by tmux session + window index
//     (`historyKey` in chatShared). The CTO conversation has NO tmux window, so
//     the host supplies a stable SYNTHETIC scope (a reserved sentinel session
//     name that cannot collide with a real project's window key).
//   - `uploadProjectName` — the SSH/HTTP upload target for drop/paste/
//     screenshot attachments. A session uses its tmux project; a surface with
//     none passes null and the upload paths early-return (no chip is stranded).
//
// Session-only chrome (fork / clear / delete, the tmux-window affordances)
// stays OUT of this hook — it is not composer state and each host renders its
// own. NewSessionScreen still uses only the leaf parts today; this hook is
// shaped so it could adopt the same container later without a rewrite.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpencodeMessage, OpencodeModel } from "../../shared/types";
import type { PendingScreenshot } from "../store";
import { useStore } from "../store";
import { useModelCatalog } from "../modelCatalog";
import {
  sessionBoxSelection,
  setSessionChoice,
  useSessionModelChoice,
} from "../modelPrefs";
import {
  type AgentMention,
  type Attachment,
  type ModelSelection,
  modelFromChoice,
  modelSupportsAttachments,
  resolveActiveModel,
  readPlanSaved,
  writePlanSaved,
} from "../chatShared";
import { resolvePlanToggle, type PlanToggleState } from "../chatUtils";
import { isPlanAgent } from "../../shared/planMode.mjs";
import { useAgentCatalog } from "../agentCatalog";
import { useComposerAttachments } from "./useComposerAttachments";
import { useTypeahead } from "./useTypeahead";
import { useInputHistory } from "./useInputHistory";
import { useVoice, type Voice } from "./useVoice";
import type { VoiceNoteRecord } from "../../shared/types";
import type { PendingVoiceNote } from "../VoiceNote";

// The prompt-history key scope. Real windows carry an integer window index; the
// CTO conversation, which has none, supplies a reserved sentinel `tmuxSession`
// (see CTO_HISTORY_SCOPE) so its `manta:window:<sentinel>:0:history` key can
// never collide with a real project's window key.
export type HistoryScope = {
  tmuxSession: string | null;
  windowIndex: number | null;
};

// A stable synthetic history scope for the ONE CTO conversation. `tmuxSession`
// is a sentinel that is NOT a valid tmux/project session name (real ones are
// project directory names — never this literal), so the resulting history key
// cannot collide with any real window's key. windowIndex 0 completes the key.
export const CTO_HISTORY_SCOPE: HistoryScope = {
  tmuxSession: "__manta_cto_conversation__",
  windowIndex: 0,
};

// The CTO conversation's upload target. `uploadProjectName` is NOT a project
// lookup — POST /api/upload treats it as an opaque `session` label, validated
// against /^[A-Za-z0-9._-]+$/ and used as the batch directory name under
// ~/.manta-uploads (see uploadRoute.mjs). So a surface with no tmux project
// does not need a server change to upload; it needs a stable label. This one
// matches the history sentinel so both of the CTO conversation's box-side
// namespaces read as obviously the same surface, and neither can collide with
// a real project's (a project label is a directory name, never this literal).
export const CTO_UPLOAD_SCOPE = "__manta_cto_conversation__";

export type ComposerControllerConfig = {
  // The opencode session id this composer targets. Model choice + effort are
  // keyed by it (the same box-backed store the session composer uses), so the
  // CTO surface's picks persist on every device exactly like a session's.
  sessionId: string;
  // The transcript — prompt history is derived from its user turns and the
  // composer's model-name pill reads the last assistant model from it.
  messages: OpencodeMessage[] | null;
  // Where prompt history is keyed. Session: the owning tmux window. CTO:
  // CTO_HISTORY_SCOPE.
  historyScope: HistoryScope;
  // The upload target for drop / paste / screenshot attachments (SSH project
  // name). null → no target; the upload paths early-return so no chip strands.
  uploadProjectName: string | null;
  // Ambient refetch tint on the composer border (warm-stale reopen). Available
  // before the send transport, so it rides in config; the send transport
  // itself (submit / abort / running) is host-owned and spread onto <Composer>
  // by the host — kept OUT of this hook so it breaks no ordering (useSseBus,
  // which produces `running`, is constructed AFTER this hook).
  refreshing: boolean;
  // The generic composer send-error surface. Owned by the host so a surface
  // with richer send errors (the CTO admission seam) routes them through the
  // same banner. The controller only WRITES it (attachment upload gate); it
  // never renders it.
  sendError: string | null;
  setSendError: (v: string | null) => void;
  // The resource toolbar (⏰ schedules / 🔑 secrets / 🪝 webhooks). Host-owned
  // because each surface opens its own panels.
  scheduleCount: number;
  onSchedules: () => void;
  onSecrets: () => void;
  onWebhooks: () => void;
  // Pop the last CLIENT-queued message back into the box. Session: wired to
  // the client queue, returning true IFF a queued item was actually popped.
  // CTO: omitted entirely (the queue is server-owned and not client-drainable).
  // Either way the shared ArrowUp gesture falls through to prompt history
  // when nothing was popped — a surface with no client queue item never
  // swallows the keypress.
  onQueuePop?: () => boolean;
  // Only the ACTIVE panel renders pending screenshots + drives the OS detector
  // toast. A hidden/secondary surface passes false so it neither shows nor
  // consumes them.
  isActive?: boolean;
  // Bumped by the host after each successful send so useInputHistory re-reads
  // localStorage (storage is not reactive) and the just-persisted prompt is
  // immediately cyclable. Optional — a surface that does not persist on send
  // omits it.
  historyEpoch?: number;
  // Voice-note bridge (BET-837). The send flow lives in useVoice; the pending
  // row + the session's stored notes are surface state, so their setters are
  // injected. Optional so a surface without voice notes can skip them.
  setPendingVoiceNote?: (p: PendingVoiceNote | null) => void;
  setVoiceNotes?: React.Dispatch<React.SetStateAction<VoiceNoteRecord[]>>;
  // cwd for the @-file typeahead search (opencode /find/file is directory
  // scoped). "" disables file search (the CTO conversation has no cwd).
  cwd?: string;
  // The optimizer savings pill value + routing preset label, host-derived
  // (they read session/routing state the host owns). Optional.
  optSavingPct?: number | null;
  presetLabel?: string;
  // Config-default model — the global fallback the per-session choice seeds
  // from. Supplied by the host (it reads the store) so the hook does not add a
  // second store subscription for it.
  configDefaultModel: ModelSelection | null;
  // Accessible name for the message field, threaded to InputArea. Session:
  // undefined (placeholder-named). CTO: "Message the CTO".
  textareaAriaLabel?: string;
  // Host-computed placeholder override (the CTO admission-seam copy). Session:
  // undefined (the two-state session placeholder is used).
  placeholderOverride?: string;
  // OPTIONAL controlled input. A session lets the controller OWN the input
  // (useState) — omit both. The CTO conversation instead owns the input in its
  // OUTER component because its admission send path restores the draft on a
  // definitive / stale-generation rejection (docs/cto-admission-contract.md) and
  // that restore must survive the inner remount on a rebind — so it passes the
  // value + setter in and the controller becomes a controlled consumer of them.
  // Both must be supplied together or neither.
  inputValue?: string;
  setInputValue?: React.Dispatch<React.SetStateAction<string>>;
};

// Everything the controller owns and the host's own send path reads. Returned
// alongside `composerProps` so ChatPanel's `submit` keeps reading attachments /
// mentions / the resolved model / plan without a second copy of that state.
export type ComposerController = {
  // Raw composer state (host send path reads these). `setInput` is the RAW
  // state dispatch (accepts a functional updater) — the host's own quote /
  // seed / drain paths pass `(prev) => …`. The typeahead-aware typing path is
  // `updateInputWithHistoryReset` (below), which is what <Composer> gets.
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  agentMentions: AgentMention[];
  setAgentMentions: React.Dispatch<React.SetStateAction<AgentMention[]>>;
  // Model / routing state (host send path + routing reads these).
  models: OpencodeModel[] | null;
  defaultModel: ModelSelection | null;
  modelOverride: ModelSelection | null;
  setModelOverride: React.Dispatch<React.SetStateAction<ModelSelection | null>>;
  // The three-state box-backed model choice (for the host's /clear carry-forward).
  sessionChoice: ReturnType<typeof useSessionModelChoice>;
  autoActive: boolean;
  setAutoActive: React.Dispatch<React.SetStateAction<boolean>>;
  activeModel: OpencodeModel | null;
  selectModel: (m: ModelSelection | null) => void;
  applyRouted: (model: ModelSelection | null, reason: string) => ModelSelection | null;
  routedModelRef: React.MutableRefObject<ModelSelection | null>;
  pendingAutoUserRef: React.MutableRefObject<boolean>;
  setRouted: React.Dispatch<
    React.SetStateAction<{ reason: string; incumbent: { providerID: string; modelID: string } | null } | null>
  >;
  setRoutedModel: React.Dispatch<React.SetStateAction<ModelSelection | null>>;
  setRoutedReason: React.Dispatch<React.SetStateAction<string | null>>;
  // Plan mode (host send path resolves the plan agent from this).
  plan: PlanToggleState;
  planOn: boolean;
  setPlanOn: React.Dispatch<React.SetStateAction<boolean>>;
  // Attachment lifecycle (host wires drag-drop / mobile-attach bridges to it).
  addDroppedFiles: (files: FileList | File[]) => Promise<void>;
  patchAttachment: (id: string, patch: Partial<Attachment>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  // Voice (the host's SSE bus registers submitRef for the take → send flow).
  // MUTABLE ref: the host assigns its latest `submit` into `.current` each render
  // (the always-current-ref pattern) and the voice / drain paths read it.
  voice: Voice;
  submitRef: React.MutableRefObject<(textOverride?: string, attachmentsOverride?: Attachment[]) => void>;
  // Typeahead (the host reads these for the drain/quote paths).
  typeahead: ReturnType<typeof useTypeahead>["typeahead"];
  setTypeaheadFromHook: ReturnType<typeof useTypeahead>["setTypeahead"];
  commands: ReturnType<typeof useTypeahead>["commands"];
  updateInput: ReturnType<typeof useTypeahead>["updateInput"];
  updateInputWithHistoryReset: (next: string) => void;
  navigateHistory: (dir: 1 | -1) => void;
  // The active model's friendly name (for the host's send-time attachment-
  // refusal message) — resolved the same way the composer pill resolves it.
  currentModelName: string;
  // The single ready-to-spread bundle for <Composer />. Exactly the shape
  // <Composer> expects MINUS the host-owned submit/abort/running/refreshing,
  // which the host spreads on top (kept out here so the host owns the send).
  composerProps: ComposerRenderProps;
};

// The props the controller can supply for <Composer>. The host adds
// submit/abort/running/refreshing (its send transport) when it renders.
type ComposerRenderProps = {
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  onAttachFiles: (files: File[]) => void;
  pendingScreenshots: PendingScreenshot[];
  onAcceptScreenshots: (shots: PendingScreenshot[]) => void;
  onDiscardScreenshot: (id: string) => void;
  typeahead: ReturnType<typeof useTypeahead>["typeahead"];
  typeaheadRows: ReturnType<typeof useTypeahead>["typeaheadRows"];
  onTypeaheadSelect: ReturnType<typeof useTypeahead>["onTypeaheadSelect"];
  onTypeaheadHover: (idx: number) => void;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  modelLabel: string | null;
  chatAutoAllow: boolean;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  voice: Voice;
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: ModelSelection | null;
  auto: boolean;
  autoReason?: string | null;
  onSelectAuto: () => void;
  routed: { reason: string; incumbent: { providerID: string; modelID: string } | null } | null;
  onRoutedUndone: () => void;
  plan: PlanToggleState;
  onTogglePlan: () => void;
  activeProviderID: string | null;
  deactivatedMainModels: string[];
  optInModels: string[];
  onOptInModel: (key: string) => void;
  onOpenModels: () => void;
  onSelectModel: (m: ModelSelection | null) => void;
  onSelectEffort: (m: ModelSelection) => void;
  presetLabel?: string;
  optSavingPct?: number | null;
  scheduleCount: number;
  onSchedules: () => void;
  onSecrets: () => void;
  onWebhooks: () => void;
  typeaheadOpen: boolean;
  typeaheadExactMatch: boolean;
  onTypeaheadConfirm: () => void;
  onTypeaheadMove: (dir: 1 | -1) => void;
  onTypeaheadCancel: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onQueuePop: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  refreshing: boolean;
  textareaAriaLabel?: string;
  placeholderOverride?: string;
};

export function useComposerController(config: ComposerControllerConfig): ComposerController {
  const {
    sessionId,
    messages,
    historyScope,
    uploadProjectName,
    setSendError,
    scheduleCount,
    onSchedules,
    onSecrets,
    onWebhooks,
    onQueuePop,
    isActive = true,
    historyEpoch,
    setPendingVoiceNote,
    setVoiceNotes,
    cwd = "",
    optSavingPct,
    presetLabel,
    configDefaultModel,
    textareaAriaLabel,
    placeholderOverride,
    refreshing,
  } = config;

  // ---- Trust toggle (a single global config value) ----
  const chatAutoAllow = useStore((s) => s.chatAutoAllow);
  const setChatAutoAllow = useStore((s) => s.setChatAutoAllow);
  const deactivatedMainModels = useStore((s) => s.deactivatedMainModels);
  const optInModels = useStore((s) => s.optInModels);
  const optInModel = useStore((s) => s.optInModel);
  const setSystemNotice = useStore((s) => s.setSystemNotice);
  const groqApiKey = useStore((s) => s.groqApiKey);

  // ---- Input value + the send-ref the SSE bus / voice drives ----
  // The input is EITHER controller-owned (a session) OR host-controlled (the
  // CTO conversation — see the config comment on inputValue). A hook must call
  // useState unconditionally, so the internal state always exists; when the host
  // supplies controlled input, the controller reads/writes THOSE instead. This
  // keeps the surface a single code path — the only difference is who holds the
  // string.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [ownInput, setOwnInput] = useState("");
  const controlled = config.inputValue !== undefined && config.setInputValue !== undefined;
  const input = controlled ? (config.inputValue as string) : ownInput;
  const setInput = (controlled ? config.setInputValue! : setOwnInput) as React.Dispatch<
    React.SetStateAction<string>
  >;
  const submitRef = useRef<(textOverride?: string, attachmentsOverride?: Attachment[]) => void>(() => {});

  // ---- Model catalog (shared module cache — no per-session flash) ----
  const { models, defaultModel } = useModelCatalog();

  // ---- Pending attachments + agent @-mentions (consumed by the host's send) ----
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [agentMentions, setAgentMentions] = useState<AgentMention[]>([]);

  // ===== Per-session model override (BET-1245/1247/1248/1281) =====
  // Seeded from the box-backed per-session choice, falling back to the global
  // default. Auto seeds the override to null (the chip reads "Auto" until the
  // router resolves one). The exact behaviour ChatPanel had — moved verbatim.
  const sessionChoice = useSessionModelChoice(sessionId);
  const [autoActive, setAutoActive] = useState<boolean>(() => sessionChoice.kind === "auto");
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(() =>
    modelFromChoice(sessionChoice, configDefaultModel),
  );
  const [routed, setRouted] = useState<{
    reason: string;
    incumbent: { providerID: string; modelID: string } | null;
  } | null>(null);
  const [routedModel, setRoutedModel] = useState<ModelSelection | null>(null);
  const [routedReason, setRoutedReason] = useState<string | null>(null);
  const routedModelRef = useRef<ModelSelection | null>(null);
  useEffect(() => {
    routedModelRef.current = routedModel;
  }, [routedModel]);
  // The single producer of `routed`: apply a boundary-routing decision, carrying
  // forward the user's current in-memory effort so a just-chosen effort is not
  // dropped by a route (BET-1274 10c).
  const applyRouted = useCallback((model: ModelSelection | null, reason: string) => {
    const incumbent = routedModelRef.current;
    setRouted({
      reason,
      incumbent: incumbent
        ? { providerID: incumbent.providerID, modelID: incumbent.modelID }
        : null,
    });
    routedModelRef.current = model;
    setRoutedModel(model);
    setRoutedReason(reason);
    const override =
      model && modelOverride?.variant ? { ...model, variant: modelOverride.variant } : model;
    setModelOverride(override);
    return override;
  }, [modelOverride]);
  // The user re-picked Auto while a routed model may exist — the next turn
  // re-decides (user-requested boundary). Detected as an autoActive flip.
  const pendingAutoUserRef = useRef(false);
  const priorAutoRef = useRef(autoActive);
  useEffect(() => {
    if (autoActive && !priorAutoRef.current && routedModelRef.current) {
      pendingAutoUserRef.current = true;
    }
    priorAutoRef.current = autoActive;
  }, [autoActive]);
  // Keep the panel's local override + Auto flag in sync with the box-backed
  // choice (BET-1281). Runs on mount and whenever the memoized choice changes.
  useEffect(() => {
    setAutoActive(sessionChoice.kind === "auto");
    setModelOverride(modelFromChoice(sessionChoice, configDefaultModel));
    priorAutoRef.current = sessionChoice.kind === "auto";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionChoice, configDefaultModel]);
  // Reset per-session routed state on session change (and on /clear).
  useEffect(() => {
    setRoutedModel(null);
    setRoutedReason(null);
    routedModelRef.current = null;
    pendingAutoUserRef.current = false;
    setAttachments([]);
    setAgentMentions([]);
  }, [sessionId]);

  // If the saved model references one that isn't in the current list, clear it
  // (BET-1281) — otherwise the server rejects the prompt with a not-found error.
  useEffect(() => {
    if (!models) return;
    const sel = sessionBoxSelection(sessionId);
    if (!sel) return;
    if (models.some((m) => m.providerID === sel.providerID && m.id === sel.modelID)) return;
    setSessionChoice(sessionId, { kind: "server-default" });
    setModelOverride(null);
  }, [models, sessionId, sessionChoice]);

  // A manual model choice is THE off switch for Auto (BET-1247/1274): writes the
  // three-state choice, flips the UI off Auto, ends any routed pill state.
  const selectModel = useCallback(
    (m: ModelSelection | null) => {
      setModelOverride(m);
      setSessionChoice(sessionId, m ? { kind: "model", model: m } : { kind: "server-default" });
      setAutoActive(false);
      setRouted(null);
    },
    [sessionId],
  );
  // The user explicitly re-picked Auto (BET-1248).
  const onSelectAuto = useCallback(() => {
    setSessionChoice(sessionId, { kind: "auto" });
    setAutoActive(true);
    setModelOverride(null);
    setRouted(null);
    if (routedModelRef.current) pendingAutoUserRef.current = true;
  }, [sessionId]);
  // Effort / ⚡ fast write a VARIANT, not a model choice — must not change the
  // ModelChoice kind and must not turn Auto off (BET-1274 10c). Verbatim.
  const onSelectEffort = useCallback(
    (value: ModelSelection) => {
      const choice = sessionChoice;
      if (choice.kind === "model") {
        const merged = { ...choice.model, ...value };
        setSessionChoice(sessionId, { kind: "model", model: merged });
        setModelOverride(merged);
      } else if (choice.kind === "auto") {
        setModelOverride((prev) => (prev ? { ...prev, variant: value.variant } : prev));
      } else {
        setSessionChoice(sessionId, {
          kind: "model",
          model: { providerID: value.providerID, modelID: value.modelID, variant: value.variant },
        });
        setModelOverride({ ...value });
      }
    },
    [sessionId, sessionChoice],
  );
  // Undo a routed model choice through the SAME per-session override path.
  const undoRouted = useCallback(() => {
    if (!routed?.incumbent) return;
    selectModel({
      providerID: routed.incumbent.providerID,
      modelID: routed.incumbent.modelID,
    });
    setRouted(null);
  }, [routed, selectModel]);

  // The active model used for the NEXT prompt — capability lookups + the pill.
  const activeModel = useMemo<OpencodeModel | null>(
    () => resolveActiveModel(models, modelOverride, defaultModel),
    [models, modelOverride, defaultModel],
  );
  const currentModelSupportsAttachments = modelSupportsAttachments(activeModel);
  const currentModelName = activeModel?.name ?? "this model";

  // ===== Per-session plan mode (BET-949) =====
  const [planOn, setPlanOn] = useState<boolean>(() => readPlanSaved(sessionId));
  const { agents } = useAgentCatalog();
  const plan = useMemo(() => resolvePlanToggle(agents, planOn), [agents, planOn]);
  const togglePlan = useCallback(() => {
    const next = !planOn;
    setPlanOn(next);
    writePlanSaved(sessionId, next);
  }, [planOn, sessionId]);
  // Re-seed plan mode on session change from the stored key, then from the
  // session's OWN agent field when the box reports it (a session pre-set to
  // plan outside MantaUI). Session.agent takes precedence over the stored key.
  useEffect(() => {
    const planOnStart = readPlanSaved(sessionId);
    setPlanOn(planOnStart);
    const api = window.api as Partial<typeof window.api>;
    if (api.opencodeSessionAgent) {
      api
        .opencodeSessionAgent(sessionId)
        .then((agent) => {
          if (agent && agent.length > 0) {
            const planNow = isPlanAgent(agent);
            setPlanOn(planNow);
            writePlanSaved(sessionId, planNow);
          }
        })
        .catch(() => {
          /* non-fatal — stored-key seed stands */
        });
    }
  }, [sessionId]);

  // ===== Typeahead (@-file / @-agent / /command) =====
  const {
    typeahead,
    setTypeahead: setTypeaheadFromHook,
    typeaheadRows,
    commands,
    onTypeaheadSelect: applyTypeahead,
    onTypeaheadMove: moveTypeaheadSelection,
    updateInput,
  } = useTypeahead({
    input,
    setInput,
    inputRef,
    cwd,
    currentModelSupportsAttachments,
    currentModelName,
    agentMentions,
    setAgentMentions,
  });

  // ===== Voice (press-and-hold dictation / recorder-composer) =====
  const voice = useVoice({
    input,
    setInput,
    inputRef,
    submitRef,
    setSendError,
    setSystemNotice,
    groqApiKey,
    sessionId,
    setPendingVoiceNote: setPendingVoiceNote ?? (() => {}),
    setVoiceNotes: setVoiceNotes ?? (() => {}),
  });

  // ===== Attachment upload lifecycle (drag-drop / paste / screenshots) =====
  // Split into a companion hook (useComposerAttachments) to keep this module
  // near the codebase's ~500-line guideline, the same reason ComposerParts was
  // split out of InputArea. It owns the "uploading" → "ready"/"error" transition
  // and the drop/paste/screenshot paths; the chips themselves stay in THIS hook's
  // `attachments` so the host's send path reads them without a second copy.
  const {
    patchAttachment,
    addDroppedFiles,
    removeAttachment,
    onPaste,
    pendingScreenshots,
    acceptScreenshots,
    removePendingScreenshots,
  } = useComposerAttachments({ uploadProjectName, setAttachments });

  // ===== Prompt-history navigation (Up/Down) + the typing exit path =====
  const { navigateHistory, updateInputWithHistoryReset } = useInputHistory({
    messages,
    inputRef,
    setInput,
    setTypeahead: setTypeaheadFromHook,
    updateInput,
    tmuxSession: historyScope.tmuxSession,
    windowIndex: historyScope.windowIndex,
    historyEpoch,
  });

  // The composer's model-name pill reads the last assistant model from the
  // transcript (identical derivation in both surfaces).
  const modelLabel = useMemo(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info;
      if (info.role === "assistant" && info.modelID) {
        return info.providerID ? `${info.providerID}/${info.modelID}` : info.modelID;
      }
    }
    return null;
  }, [messages]);

  // The typeahead's "exact match" (Enter sends instead of completing) —
  // computed here from the CURRENT input so the host does not recompute it.
  const typeaheadExactMatch = useMemo(() => {
    if (!typeahead || typeaheadRows.length === 0) return false;
    const idx = Math.min(typeahead.selectedIdx, typeaheadRows.length - 1);
    const row = typeaheadRows[idx];
    return input.trim() === row.primary;
  }, [typeahead, typeaheadRows, input]);

  const onTypeaheadConfirm = useCallback(() => {
    if (typeahead && typeaheadRows.length > 0) {
      const idx = Math.min(typeahead.selectedIdx, typeaheadRows.length - 1);
      applyTypeahead(typeaheadRows[idx]);
    }
  }, [typeahead, typeaheadRows, applyTypeahead]);

  const composerProps: ComposerRenderProps = {
    attachments,
    onRemoveAttachment: removeAttachment,
    onAttachFiles: (files) => void addDroppedFiles(files),
    pendingScreenshots: isActive ? pendingScreenshots : [],
    onAcceptScreenshots: acceptScreenshots,
    onDiscardScreenshot: (id) => removePendingScreenshots([id]),
    typeahead,
    typeaheadRows,
    onTypeaheadSelect: applyTypeahead,
    onTypeaheadHover: (idx) =>
      setTypeaheadFromHook((prev) => (prev ? { ...prev, selectedIdx: idx } : prev)),
    input,
    setInput: updateInputWithHistoryReset,
    inputRef,
    modelLabel,
    chatAutoAllow,
    setChatAutoAllow,
    voice,
    models,
    modelOverride,
    defaultModel,
    auto: autoActive,
    autoReason: routedReason,
    onSelectAuto,
    routed,
    onRoutedUndone: () => void undoRouted(),
    plan,
    onTogglePlan: togglePlan,
    activeProviderID: activeModel?.providerID ?? null,
    deactivatedMainModels,
    optInModels,
    onOptInModel: optInModel,
    // Kept for the picker button's onOpen — a no-op now that models pre-fetch.
    onOpenModels: () => {},
    onSelectModel: selectModel,
    onSelectEffort,
    presetLabel,
    optSavingPct,
    scheduleCount,
    onSchedules,
    onSecrets,
    onWebhooks,
    typeaheadOpen: typeahead != null && typeaheadRows.length > 0,
    typeaheadExactMatch,
    onTypeaheadConfirm,
    onTypeaheadMove: moveTypeaheadSelection,
    onTypeaheadCancel: () => setTypeaheadFromHook(null),
    onHistoryUp: () => navigateHistory(-1),
    onHistoryDown: () => navigateHistory(1),
    // ArrowUp on an empty box while running (the queue-pop gesture, shared
    // with InputArea): pop the client-queued message when the surface HAS
    // one; otherwise the honest gesture is prompt history — exactly what the
    // same keypress does when idle. Never a swallowed no-op that also steals
    // history from a surface whose queue is server-owned (the CTO) or whose
    // client queue is momentarily empty (a session).
    onQueuePop: () => {
      if (onQueuePop?.() === true) return;
      navigateHistory(-1);
    },
    onPaste,
    refreshing,
    textareaAriaLabel,
    placeholderOverride,
  };

  return {
    input,
    setInput,
    inputRef,
    attachments,
    setAttachments,
    agentMentions,
    setAgentMentions,
    models,
    defaultModel,
    modelOverride,
    setModelOverride,
    sessionChoice,
    autoActive,
    setAutoActive,
    activeModel,
    selectModel,
    applyRouted,
    routedModelRef,
    pendingAutoUserRef,
    setRouted,
    setRoutedModel,
    setRoutedReason,
    plan,
    planOn,
    setPlanOn,
    addDroppedFiles,
    patchAttachment,
    onPaste,
    voice,
    submitRef,
    typeahead,
    setTypeaheadFromHook,
    commands,
    updateInput,
    updateInputWithHistoryReset,
    navigateHistory,
    currentModelName,
    composerProps,
  };
}
