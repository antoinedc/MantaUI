// onboardingVerify.ts — pure orchestrator for the onboarding verification
// (BET-421 §B "Verify by working, not by exit code").
//
// Replaces the old finalizeOnboarding, which created a real ~/projects/welcome
// project, opened a chat window, sent "hi", and left all of it behind. Every
// install therefore billed a model turn, littered the box, and put a junk
// session in the sidebar before the user had done anything.
//
// The new flow spins up an EPHEMERAL opencode session (no tmux project, no
// sidebar entry), sends one probe prompt, waits for a real assistant reply,
// and deletes the session the moment the reply lands. Nothing is left on
// the box. Three named stages drive the ProcessPanel:
//
//   1. Reached opencode on your box       — createEphemeralSession succeeds.
//   2. <Provider> credentials accepted    — the probe prompt is accepted.
//   3. Getting a reply from <model>       — a completed assistant reply.
//
// The failure state always names which stage failed; the caller renders
// Try again / Back to the model step / Copy diagnostics. There is no
// "continue anyway" — a working model is mandatory.
//
// Pure + framework-free (deps injected); the renderer wires `window.api`
// into it at the call site. Tests stub the deps so the orchestrator can be
// exercised without a real box.

// ---------- Types injected from the renderer ----------

// The minimal shape of window.api the verify path consumes — a Pick of the
// canonical Api interface so a wrong assumption about any of these five
// methods is a typecheck failure, not a silent runtime bug.
import type { Api } from "../shared/api";

export type VerifyApi = Pick<
  Api,
  | "opencodeCreateEphemeralSession"
  | "opencodeDeleteSessionRaw"
  | "opencodePrompt"
  | "opencodeMessages"
  | "opencodeProviderAuth"
>;

// A verify stage index (0-based) the caller feeds to ProcessPanel.activeIndex.
export type VerifyStageIndex = 0 | 1 | 2;

export type VerifyProgress = {
  // 0-based index of the stage that is currently running (or that failed).
  stage: VerifyStageIndex;
  status: "running" | "done" | "error";
};

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; failedStage: VerifyStageIndex; message: string };

export const VERIFY_DEFAULT_TIMEOUT_MS = 90_000;
export const VERIFY_POLL_INTERVAL_MS = 1_000;
export const VERIFY_PROBE_TEXT = "hi";
// The ephemeral session is created in the box's home dir — no project, no
// worktree, nothing to clean up beyond the session itself.
export const VERIFY_DIRECTORY = "~";

// Build the three stage labels the ProcessPanel renders. Provider and model
// labels come from the caller (the onboarding shell reads them from the
// connected-provider status + the configured default model). Pure so the
// test can assert the exact strings.
export function verifyStageLabels(
  providerLabel: string,
  _modelLabel?: string,
): [string, string, string] {
  return [
    "Reached opencode on your box",
    `${providerLabel} credentials accepted`,
    "Waiting for a reply — cold models can take a minute…",
  ];
}

// Send the probe prompt + wait for a real assistant reply inside an
// EPHEMERAL session that is deleted the moment the function returns (success
// OR failure). Reports stage progress via `onProgress` so the caller can
// advance its ProcessPanel live.
//
// `now` is injected so the deadline math is pure-testable; production wires
// `Date.now`.
export async function verifyOnboarding(deps: {
  api: VerifyApi;
  providerLabel: string;
  modelLabel?: string;
  directory?: string;
  probeText?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  onProgress?: (p: VerifyProgress) => void;
}): Promise<VerifyOutcome> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? VERIFY_POLL_INTERVAL_MS;
  const directory = deps.directory ?? VERIFY_DIRECTORY;
  const probeText = deps.probeText ?? VERIFY_PROBE_TEXT;
  const onProgress = deps.onProgress ?? (() => {});

  // Stage 1 — reach opencode by creating an ephemeral session.
  onProgress({ stage: 0, status: "running" });
  const created = await deps.api.opencodeCreateEphemeralSession({
    directory,
    title: "manta-verify",
  });
  if (!created.ok || typeof created.sessionId !== "string" || !created.sessionId) {
    onProgress({ stage: 0, status: "error" });
    return {
      ok: false,
      failedStage: 0,
      message:
        created && typeof created.error === "string" && created.error.length > 0
          ? `Couldn't reach opencode on your box: ${created.error}`
          : "Couldn't reach opencode on your box. Check that the box service is running and try again.",
    };
  }
  const sessionId = created.sessionId;

  try {
    // Stage 2 — send the probe prompt. opencodePrompt resolves with nothing
    // on success and THROWS on failure — there is no return value to test.
    onProgress({ stage: 1, status: "running" });
    try {
      await deps.api.opencodePrompt(sessionId, probeText);
    } catch (e) {
      onProgress({ stage: 1, status: "error" });
      const detail = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        failedStage: 1,
        message: detail
          ? `${deps.providerLabel} rejected the request: ${detail}`
          : `${deps.providerLabel} isn't ready. Reconnect the provider and try again.`,
      };
    }

    // Stage 3 — wait for a completed assistant reply.
    onProgress({ stage: 2, status: "running" });
    const baseline = await safeFetchMessages(deps.api, sessionId);
    const baselineAssistantIds = new Set(extractAssistantIds(baseline));

    const deadline = now() + timeoutMs;
    while (true) {
      if (now() >= deadline) {
        onProgress({ stage: 2, status: "error" });
        return {
          ok: false,
          failedStage: 2,
          message:
            "The box accepted the install but the model didn't reply. Open the chat and try sending a message to diagnose — a bad credential or a misconfigured provider shows up here.",
        };
      }
      await sleep(pollIntervalMs);
      const msgs = await safeFetchMessages(deps.api, sessionId);
      if (!msgs) continue; // transient fetch failure — keep polling.
      for (const id of extractAssistantIds(msgs)) {
        if (baselineAssistantIds.has(id)) continue;
        // Succeed on the FIRST streamed token — a brand-new assistant
        // message with any text part, even before it completes. A cold
        // provider (first-ever call, model warm-up) can legitimately take
        // well past 30s to produce a COMPLETED reply even when healthy, so
        // the verification is "the model started talking", not "the model
        // finished talking".
        if (hasCompletedAssistantMessage(msgs, id) || hasAssistantTextStarted(msgs, id)) {
          onProgress({ stage: 2, status: "done" });
          return { ok: true };
        }
      }
    }
  } finally {
    // Delete the ephemeral session no matter the outcome — success or
    // failure. A session that fails to delete is non-fatal (the caller
    // still surfaces the real verify result); best-effort, never throws.
    try {
      await deps.api.opencodeDeleteSessionRaw(sessionId);
    } catch {
      /* ignore — nothing left behind that the user would see */
    }
  }
}

// Resolve a (providerLabel, modelLabel) pair for the stage labels from the
// status probe. The first connected provider's label + the configured
// default model. Pure so the test can assert; returns nulls when nothing
// is connected (the caller shouldn't call verify without a provider, but
// the resolver is defensive).
export function pickVerifyLabels(
  statusResult: unknown,
  defaultModel?: { providerID: string; modelID: string } | null,
): { providerLabel: string; modelLabel: string } | null {
  if (!statusResult || typeof statusResult !== "object") return null;
  const providers = (statusResult as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return null;
  const connected = providers.find(
    (p) =>
      typeof p === "object" &&
      p !== null &&
      (p as { connected?: unknown }).connected === true,
  );
  if (!connected) return null;
  const providerLabel =
    (connected as { label?: unknown }).label ?? "the provider";
  const modelLabel = defaultModel?.modelID ?? "the model";
  return {
    providerLabel: String(providerLabel),
    modelLabel: String(modelLabel),
  };
}

// ---------- helpers ----------

async function safeFetchMessages(
  api: VerifyApi,
  sessionId: string,
): Promise<unknown> {
  try {
    return await api.opencodeMessages(sessionId);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MessageLike = {
  info?: {
    id?: unknown;
    role?: unknown;
    time?: { completed?: unknown } | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function isMessageLike(x: unknown): x is MessageLike {
  return typeof x === "object" && x !== null;
}

function extractAssistantIds(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (const m of messages) {
    if (!isMessageLike(m)) continue;
    const role = m.info?.role;
    const id = m.info?.id;
    if (role === "assistant" && typeof id === "string" && id.length > 0) {
      out.push(id);
    }
  }
  return out;
}

function hasCompletedAssistantMessage(
  messages: unknown,
  id: string,
): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!isMessageLike(m)) continue;
    const mid = m.info?.id;
    if (mid !== id) continue;
    const completed = m.info?.time?.completed;
    return typeof completed === "number" && Number.isFinite(completed) && completed > 0;
  }
  return false;
}

// True when the assistant message `id` has started producing text — any
// non-empty text part, whether or not the message has completed. Used to
// accept the first streamed token so healthy-but-cold setups pass.
function hasAssistantTextStarted(messages: unknown, id: string): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!isMessageLike(m)) continue;
    const mid = m.info?.id;
    if (mid !== id) continue;
    const parts = m.parts;
    if (!Array.isArray(parts)) return false;
    for (const p of parts) {
      if (typeof p !== "object" || p === null) continue;
      const part = p as { type?: unknown; text?: unknown };
      if (part.type !== "text") continue;
      const text = part.text;
      if (typeof text === "string" && text.trim().length > 0) return true;
    }
    return false;
  }
  return false;
}
