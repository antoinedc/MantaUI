// demoApi.ts — fake transport for the renderer demo build (BET-302).
//
// Backed by `demoFixture.ts` (the fictional project / session / transcript
// state). The renderer treats it as `window.api`; the real React app then
// renders from this snapshot, with zero network calls.
//
// Shape contract: matches `Api` in src/shared/api.ts — the same contract
// httpApi satisfies. Demo callers SHOULD hit one of the explicit methods
// below; everything else falls through the Proxy to a benign no-op:
//
//   - Promises resolve to `null` (so destructuring / array checks get a
//     clean "nothing here" signal and the renderer's optional-chaining
//     guards stay quiet).
//   - Subscription methods (`on…`) return `() => {}` so listener cleanup
//     runs harmlessly.
//
// The set of explicit methods is the minimum the UI touches during
// load and first render. They were discovered by running the demo build
// with the Proxy in place and watching the warnings fall out — these are
// the ones that actually fired during mount:
//
//   configGet, tmuxList, onStatusEvent,
//   opencodeMessages, opencodeMessagesCached,
//   opencodePermissions, opencodeQuestions, opencodeVcsBranch,
//   opencodeListSessions, opencodeModels, opencodeDefaultModel,
//   opencodeOpenStream, opencodeCloseStream, onOpencodeEvent,
//   launchersList,
//   getClientVersion, getServerVersion
//
// Anything beyond that is a click-through or interaction that the demo
// doesn't have to support visually — the Proxy handles it. If a future
// consumer needs richer demo behavior, add the method here; do NOT add a
// parallel setWindowApi seam (the existing transportInstall.ts setWindowApi
// is the single install point).

import type { Api } from "../../shared/api.js";
import { demoState } from "./demoFixture.js";

// ===========================================================================
// Explicit methods — the ones the renderer actually calls during load +
// first render. Listed in the order they appear in demoFixture.ts.
// ===========================================================================

const configGet = (): Promise<typeof demoState.config> =>
  Promise.resolve(demoState.config);

const tmuxList = (): Promise<typeof demoState.projects> =>
  Promise.resolve(demoState.projects);

// SSE-style push subscription. The renderer (App.tsx) registers one
// onStatusEvent listener; we call it back once with the full fixture status
// batch so the sidebar dots render with the right colors from frame 1. The
// returned unsubscribe is a no-op — there's nothing to tear down.
const onStatusEvent = (
  cb: (batch: unknown[]) => void,
): (() => void) => {
  const batch = Object.entries(demoState.status).flatMap(([session, byWindow]) =>
    Object.entries(byWindow).map(([windowIndex, s]) => ({
      session,
      windowIndex: Number(windowIndex),
      running: s.running,
      subagents: s.subagents,
    })),
  );
  // Microtask defer — matches the real SSE "fire on the next tick" cadence
  // so the renderer's first render isn't blocked by us.
  queueMicrotask(() => cb(batch));
  return () => {};
};

// `opencodeMessages` is the chat-panel mount-time transcript fetch. We
// return the demo transcript for the active session; empty arrays for
// anything else (a future consumer would only ever ask for the active
// session at first render).
const opencodeMessages = (sessionId: string): Promise<unknown[]> => {
  if (sessionId === demoState.activeSessionId) {
    return Promise.resolve(demoState.messages);
  }
  return Promise.resolve([]);
};

// The renderer uses `opencodeMessagesCached` as a fast first paint; a null
// cache miss means "fall through to opencodeMessages". Match that exact
// contract — a real cache hit would be the full transcript.
const opencodeMessagesCached = (_sessionId: string): Promise<unknown[] | null> =>
  Promise.resolve(null);

// Pending question + permission lists are session-scoped (see
// opencodePermissions/opencodeQuestions in shared/api.ts). The active
// session has both pending in the fixture; other sessions have none.
const opencodePermissions = (sessionId?: string): Promise<unknown[]> => {
  if (!sessionId || sessionId === demoState.activeSessionId) {
    return Promise.resolve([demoState.permission]);
  }
  return Promise.resolve([]);
};

const opencodeQuestions = (sessionId?: string): Promise<unknown[]> => {
  if (!sessionId || sessionId === demoState.activeSessionId) {
    return Promise.resolve([demoState.question]);
  }
  return Promise.resolve([]);
};

// Footer branch chip — single string for the active window's cwd.
const opencodeVcsBranch = (_directory?: string): Promise<string | null> =>
  Promise.resolve(demoState.branch);

// Session list drives `backfillLastMessageTimes` (BET-119). The fixture
// carries `time.updated` for each session; the renderer stamps that onto
// the sidebar's age label so even idle windows show a sensible elapsed.
const opencodeListSessions = (_directory?: string): Promise<typeof demoState.sessions> =>
  Promise.resolve(demoState.sessions);

const opencodeModels = (): Promise<typeof demoState.models> =>
  Promise.resolve(demoState.models);

const opencodeDefaultModel = (): Promise<{ providerID: string; modelID: string } | null> =>
  Promise.resolve(demoState.config.defaultModel ?? null);

// Stream open/close are no-ops in demo mode — there's no real SSE bus. The
// real httpApi also no-ops these for the same reason (no per-directory
// stream in the server). Return undefined so the renderer's
// optional-chaining guards stay quiet.
const opencodeOpenStream = (_sessionId: string): Promise<void> =>
  Promise.resolve();

const opencodeCloseStream = (_sessionId: string): Promise<void> =>
  Promise.resolve();

const onOpencodeEvent = (_cb: (ev: unknown) => void): (() => void) => () => {};

// Available AI CLI TUI launchers. Demo returns an empty list — the chat
// session's mode dropdown will show just Chat + Terminal.
const launchersList = (): Promise<unknown[]> => Promise.resolve([]);

// Version skew guard (BET-225 stage 3 Part C). Pretend the client and
// server are perfectly aligned — the renderer reads these in an effect and
// decides whether to render the non-dismissible "outdated" banner.
const getClientVersion = (): Promise<{ version: string }> =>
  Promise.resolve({ version: "0.0.13" });

const getServerVersion = (): Promise<{ version: string; minClient: string }> =>
  Promise.resolve({ version: "0.0.13", minClient: "0.0.0" });

// Subscription provider auth (BET-308 / BET-309). Demo returns the three
// disconnected rows so the connect-card UI still renders the registry
// correctly; the `start` / `code` / `key` / `disconnect` actions are
// unimplemented and resolve to a status payload (the Proxy fallback would
// also work, but routing non-status requests through here keeps the
// explicit-method list honest about demo coverage). Matches the real
// httpApi's status shape so any future consumer that mounts the card in
// demo mode gets the same row layout.
const opencodeProviderAuth = (req: unknown): Promise<{ action: "status"; providers: Array<{ id: string; label: string; plan: string; console: string | null; docs: string; connected: boolean }> }> => {
  // Status is the only meaningful action in demo mode — everything else
  // (start / code / key / disconnect) would need a fake opencode server
  // behind it, which is out of scope for the demo fixture.
  void req;
  return Promise.resolve({
    action: "status",
    providers: [
      { id: "anthropic", label: "Claude", plan: "Claude Pro / Max", console: null, docs: "https://claude.com/pricing", connected: true },
      { id: "openai", label: "Codex", plan: "ChatGPT Plus / Pro", console: null, docs: "https://openai.com/chatgpt/pricing", connected: false },
      { id: "kimi-for-coding", label: "Kimi", plan: "Kimi For Coding", console: "https://www.kimi.com/code/console", docs: "https://kimi.com/code/docs/en/third-party-tools/opencode.html", connected: false },
    ],
  });
};

// BET-354: no-op cancel for demo mode. Demo cards never mount the Claude
// login flow (status always shows anthropic connected), so this is purely
// present so the typed `claudeLoginCancel` method doesn't 404 when a
// future demo mount calls it.
const claudeLoginCancel = (_sessionKey: string): Promise<{ ok: boolean }> => {
  return Promise.resolve({ ok: true });
};

// ===========================================================================
// `demoApi` — the explicit methods exposed by name. Everything else falls
// through the Proxy in the `unknown` handler.
// ===========================================================================
const explicitMethods = {
  configGet,
  tmuxList,
  onStatusEvent,
  opencodeMessages,
  opencodeMessagesCached,
  opencodePermissions,
  opencodeQuestions,
  opencodeVcsBranch,
  opencodeListSessions,
  opencodeModels,
  opencodeDefaultModel,
  opencodeOpenStream,
  opencodeCloseStream,
  onOpencodeEvent,
  launchersList,
  getClientVersion,
  getServerVersion,
  opencodeProviderAuth,
  claudeLoginCancel,
} as const;

// ===========================================================================
// Proxy fallback — every property access not in `explicitMethods` lands
// here. Two patterns:
//   - `on*` returns a no-op subscribe that, when called with a callback,
//     returns a no-op unsubscribe function. The renderer's App-level
//     effects (onStatusEvent, onAgentFileReady, ...) register a callback
//     and keep the returned unsubscribe around for cleanup; both halves
//     must be callable without side effects.
//   - Everything else returns a Promise that resolves to `null` so
//     destructuring / `.catch(() => {})` stays quiet.
// ===========================================================================
type AnyMethod = (...args: unknown[]) => unknown;
const subscriptionMethod = /^on[A-Z]/;
const proxyTarget = explicitMethods as unknown as Record<string, AnyMethod>;
const demoApiProxy = new Proxy(proxyTarget, {
  get(target, prop: string | symbol): AnyMethod | undefined {
    if (typeof prop === "symbol") return undefined;
    const explicit = target[prop];
    if (explicit) return explicit;
    // Subscription methods: calling the returned function with a callback
    // hands back a no-op unsubscribe so the renderer's cleanup logic stays
    // happy. Non-subscription methods: call returns a Promise<null>.
    if (subscriptionMethod.test(prop)) {
      return () => () => {};
    }
    return () => Promise.resolve(null);
  },
});

// `demoApi` is typed as `Api` so the renderer sees the same contract
// httpApi satisfies; at runtime it's a Proxy whose fallback covers every
// missing method with the benign no-op above.
export const demoApi = demoApiProxy as unknown as Api;
