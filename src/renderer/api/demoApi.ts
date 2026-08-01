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
import type { AvailableLauncher } from "../../shared/types.js";
import { demoState } from "./demoFixture.js";
import { pickDemoState } from "../demoLayout.js";

// Resolved once at module load — the demo transport is only ever imported
// from bootDemo(), which has already decided we are in demo mode. The state
// is a single selector (see pickDemoState), so each fixture state is a URL
// value rather than a boolean flag per state.
const DEMO_STATE =
  typeof window === "undefined"
    ? "full"
    : pickDemoState(new URLSearchParams(window.location.search));

// ===========================================================================
// Explicit methods — the ones the renderer actually calls during load +
// first render. Listed in the order they appear in demoFixture.ts.
// ===========================================================================

const configGet = (): Promise<typeof demoState.config> =>
  Promise.resolve(demoState.config);

const tmuxList = (): Promise<typeof demoState.projects> =>
  Promise.resolve(DEMO_STATE === "empty" ? [] : demoState.projects);

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

// Session-scoped fixture read. The active session carries content; every
// other session is legitimately empty — this is NOT a coverage gap, it is
// the product's real behaviour. An absent id means "the active one": the
// pending-ask channels may omit it, and `opencodeMessages`' signature makes
// it required, so unifying the two shapes cannot change behaviour.
const forActiveSession = <T>(sessionId: string | undefined, value: T[]): Promise<T[]> =>
  Promise.resolve(!sessionId || sessionId === demoState.activeSessionId ? value : []);

const opencodeMessages = (sessionId: string) => forActiveSession(sessionId, demoState.messages);

// The renderer uses `opencodeMessagesCached` as a fast first paint; a null
// cache miss means "fall through to opencodeMessages". Match that exact
// contract — a real cache hit would be the full transcript.
const opencodeMessagesCached = (_sessionId: string): Promise<unknown[] | null> =>
  Promise.resolve(null);

const opencodePermissions = (sessionId?: string) => forActiveSession(sessionId, [demoState.permission]);
const opencodeQuestions = (sessionId?: string) => forActiveSession(sessionId, [demoState.question]);

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

const launchersList = (): Promise<AvailableLauncher[]> =>
  Promise.resolve(demoState.launchers);

// Version skew guard (BET-225 stage 3 Part C). Pretend the client and
// server are perfectly aligned — the renderer reads these in an effect and
// decides whether to render the non-dismissible "outdated" banner.
const getClientVersion = (): Promise<{ version: string }> =>
  Promise.resolve({ version: "0.0.13" });

const getServerVersion = (): Promise<{ version: string; minClient: string; opencodeVersion: string }> =>
  Promise.resolve({
    version: "0.0.13",
    // "version-skew" makes the client (0.0.13) older than the floor, which is
    // what drives App.tsx's non-dismissible skew banner. Every other state
    // keeps the never-skewed default.
    minClient: DEMO_STATE === "version-skew" ? "0.1.0" : "0.0.0",
    opencodeVersion: "0.0.0",
  });

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
export const explicitMethods = {
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
