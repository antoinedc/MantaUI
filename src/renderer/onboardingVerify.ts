// onboardingVerify.ts — pure orchestrator for the final onboarding actions
// (BET-356 §4 "Verify by working, not by exit code").
//
// Two responsibilities, kept together because they always run in this order:
//
//   1. ensureWelcomeProject — auto-create a "welcome" project on the box the
//      user just paired with, so they land somewhere real (the sidebar shows
//      a project, the chat panel mounts against an existing session). No
//      dedicated onboarding step — BET-356 demotes the project step out of
//      onboarding. Skips if any project already exists on the box.
//
//   2. verifyBoxAnswers — send a one-line prompt to the box's opencode and
//      wait for a real assistant response. An install that exits zero but
//      cannot answer is a failure the user must know about immediately, not
//      discover later. The check is intentionally a real round-trip: any
//      cheaper proxy (TCP probe, /provider ping) would pass on a misconfigured
//      provider that cannot serve a turn.
//
// Both helpers are framework-free + pure (deps injected); the renderer wires
// `window.api` and `useStore.getState()` into them at the call site. Tests
// stub the deps so the orchestrator can be exercised without a real box.

// ---------- Types injected from the renderer ----------

// Minimal shape of window.api the verify path actually consumes. Declared
// here as a type so the test fixture doesn't need to construct the whole
// preload surface — see onboardingVerify.test.ts.
export type VerifyApi = {
  tmuxNewSession: (input: {
    name: string;
    cwd: string;
    windowName?: string;
    chatMode?: boolean;
    createDir?: boolean;
  }) => Promise<TmuxNewSessionResult>;
  opencodeProviderAuth: (input: {
    action: string;
    [k: string]: unknown;
  }) => Promise<unknown>;
  opencodePrompt: (
    sessionId: string,
    text: string,
    modelOverride?: unknown,
    attachments?: unknown,
    mentions?: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
  opencodeMessages: (sessionId: string) => Promise<unknown>;
};

// TmuxNewSessionResult — the relevant fields only. The renderer reads the
// full object from `useStore.getState().projects`, but for our purposes we
// only need to know "did creation succeed and what session name was used".
export type TmuxNewSessionResult =
  | { ok: true; sessionName: string }
  | { ok: false; error: string };

// Minimal store surface — provides `projects` (the live projects list) and
// `refresh`/`setActive` actions to re-sync after auto-creating a project.
export type VerifyStore = {
  projects: Array<{
    tmuxSession: string;
    windows: Array<{ opencodeSessionId: string | null }>;
  }>;
  refresh: () => Promise<void>;
  setActive: (projectName: string, windowIndex?: number) => void;
};

// ---------- ensureWelcomeProject ----------

export const WELCOME_PROJECT_NAME = "welcome";
export const WELCOME_PROJECT_CWD = "~/projects/welcome";

// Create a "welcome" project + chat-mode window if none exists yet. Returns
// the opencode session id of the new project's first chat-mode window, or
// `null` if no auto-create was needed (a project already exists) AND none
// of the existing projects carry a chat-mode session id (caller will not
// have anything to verify against — see verifyBoxAnswers for the empty-
// projects early return).
//
// Pure orchestrator: the only I/O is `api.tmuxNewSession` and
// `store.refresh`/`store.setActive`. Both deps are injected.
export async function ensureWelcomeProject(deps: {
  api: VerifyApi;
  store: VerifyStore;
}): Promise<string | null> {
  // Skip when a project already exists. The sidebar shows real things; the
  // user can rename / move them later. This is the common resume path: the
  // user already had a project from a previous run.
  if (deps.store.projects.length > 0) {
    const existing = firstChatSessionId(deps.store.projects);
    if (existing) return existing;
    // Projects exist but none has a chat-mode window — fall through and
    // create one anyway, so the verify path has somewhere to send the
    // probe prompt. (The user will see their existing project with one
    // new chat-mode window added.)
  }

  const result = await deps.api.tmuxNewSession({
    name: WELCOME_PROJECT_NAME,
    cwd: WELCOME_PROJECT_CWD,
    windowName: "default",
    chatMode: true,
    createDir: true,
  });
  if (!result.ok) {
    throw new Error(`Couldn't create a starter project: ${result.error}`);
  }
  // Refresh the store so the new project + window is visible, then select
  // the new session so the user lands on it. setActive's windowIndex is
  // omitted on purpose — the project's first window is the chat-mode one
  // we just minted, and the store's setActive defaults to index 0.
  await deps.store.refresh();
  deps.store.setActive(result.sessionName);

  // After refresh, the store carries the new project. Find its chat session.
  const refreshed = firstChatSessionId(deps.store.projects);
  if (!refreshed) {
    throw new Error("Welcome project created but no chat session was opened.");
  }
  return refreshed;
}

// Pick the first chat-mode opencode session id across all projects + windows.
// Used by both `ensureWelcomeProject` and the verify helper so they agree on
// "what counts as the chat session we're verifying against".
export function firstChatSessionId(
  projects: VerifyStore["projects"],
): string | null {
  for (const p of projects) {
    for (const w of p.windows) {
      if (typeof w.opencodeSessionId === "string" && w.opencodeSessionId.length > 0) {
        return w.opencodeSessionId;
      }
    }
  }
  return null;
}

// ---------- verifyBoxAnswers ----------

export const VERIFY_DEFAULT_TIMEOUT_MS = 15_000;
export const VERIFY_POLL_INTERVAL_MS = 1_000;
export const VERIFY_PROBE_TEXT = "hi";

// Outcome of a single verification attempt. The caller surfaces `message` to
// the user (Plain-language cause + one action, per BET-356 §5 failure UX).
export type VerifyOutcome =
  | { ok: true }
  | { ok: false; message: string };

// Send the probe prompt + wait for a real assistant response. Polls
// `opencodeMessages` at 1Hz; an assistant message with `time.completed`
// set is the success signal (the turn has fully ended server-side, so an
// empty/timed-out reply won't false-positive).
//
// `now` is injected so the deadline math is pure-testable; production wires
// `Date.now`.
export async function verifyBoxAnswers(deps: {
  api: VerifyApi;
  sessionId: string;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<VerifyOutcome> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? VERIFY_POLL_INTERVAL_MS;

  // Snapshot the transcript BEFORE we send so we can detect "a NEW assistant
  // message appeared after the prompt" rather than "any assistant message
  // is present" (the latter would falsely pass on a project that already
  // had a turn before onboarding was re-entered).
  const baseline = await safeFetchMessages(deps.api, deps.sessionId);
  const baselineAssistantIds = new Set(extractAssistantIds(baseline));

  const send = await deps.api.opencodePrompt(deps.sessionId, VERIFY_PROBE_TEXT);
  if (!send || send.ok === false) {
    return {
      ok: false,
      message:
        send && typeof send.error === "string"
          ? `Couldn't send the test prompt: ${send.error}`
          : "Couldn't send the test prompt to the box.",
    };
  }

  const deadline = now() + timeoutMs;
  while (true) {
    if (now() >= deadline) {
      return {
        ok: false,
        message:
          "The box accepted the install but didn't answer the test prompt. Open the chat and try sending a message to diagnose.",
      };
    }
    await sleep(pollIntervalMs, deps.api);
    const msgs = await safeFetchMessages(deps.api, deps.sessionId);
    if (!msgs) {
      // Transient fetch failure — keep polling until the deadline.
      continue;
    }
    for (const id of extractAssistantIds(msgs)) {
      if (baselineAssistantIds.has(id)) continue;
      // New assistant message found. Verify it has actually completed
      // (time.completed is server-stamped only when the turn fully ended).
      if (hasCompletedAssistantMessage(msgs, id)) {
        return { ok: true };
      }
    }
  }
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

function sleep(ms: number, _api: VerifyApi): Promise<void> {
  // Pure setTimeout; the api param is in the signature so future tests can
  // swap in a fake clock without rewriting call sites.
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

// ---------- orchestrator: finalizeOnboarding ----------

// Compose the two helpers above into the single "we're done" transition
// from the onboarding shell. Called when:
//   - step 1 (Connect) onPaired fires AND the box already has a provider
//     connected (skip step 2, jump straight to finalization), or
//   - step 2 (Provider) onContinue fires after a fresh provider connect.
//
// Throws on failure — the caller renders the message in the same inline
// error slot a manual claim failure uses (BET-356 §5).
export async function finalizeOnboarding(deps: {
  api: VerifyApi;
  store: VerifyStore;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const sessionId = await ensureWelcomeProject({
    api: deps.api,
    store: deps.store,
  });
  if (!sessionId) {
    // No project and no chat session to verify against. This shouldn't
    // happen on a fresh box (ensureWelcomeProject creates one), but if a
    // user closed onboarding mid-create we treat it as a verification
    // failure rather than a silent pass.
    throw new Error(
      "Couldn't open a chat session to verify the box. Try again from the welcome project in the sidebar.",
    );
  }
  const outcome = await verifyBoxAnswers({
    api: deps.api,
    sessionId,
    now: deps.now,
    timeoutMs: deps.timeoutMs,
    pollIntervalMs: deps.pollIntervalMs,
  });
  if (!outcome.ok) {
    throw new Error(outcome.message);
  }
}

// ---------- pre-connect provider check ----------

// Quick `is there at least one provider connected` probe — used by the
// Connect step to decide whether to skip step 2 entirely. Same source
// (`opencodeProviderAuth({action:"status"})`) that ProvidersStep consumes
// for its Continue gate, so the two paths agree by construction.
export async function hasConnectedProvider(api: VerifyApi): Promise<boolean> {
  try {
    const res = await api.opencodeProviderAuth({ action: "status" });
    if (!res || typeof res !== "object") return false;
    const providers = (res as { providers?: unknown }).providers;
    if (!Array.isArray(providers)) return false;
    return providers.some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as { connected?: unknown }).connected === true,
    );
  } catch {
    return false;
  }
}
