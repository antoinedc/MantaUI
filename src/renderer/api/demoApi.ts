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
//   opencodeMessages,
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
import type { AvailableLauncher, OpencodeMessage, OutboxFile, ServedPageMeta, WorktreeInfo, DirListing } from "../../shared/types.js";
import { DEMO_T0, demoFsListDirs, demoGitListWorktrees, demoState } from "./demoFixture.js";
import { pickDemoState, type DemoState } from "../demoLayout.js";
import { useStore } from "../store.js";
import { lastMeasurement, onMeasurement } from "../firstTokenLatency.js";

// Resolved once at module load — the demo transport is only ever imported
// from bootDemo(), which has already decided we are in demo mode. The state
// is a single selector (see pickDemoState), so each fixture state is a URL
// value rather than a boolean flag per state.
const DEMO_STATE =
  typeof window === "undefined"
    ? "full"
    : pickDemoState(new URLSearchParams(window.location.search));

// "reconnecting" — the real transport (httpApi) reports the events-WebSocket
// connection state into the store via `setConnectionState`; demo mode has no
// socket, so the fake transport reports the degraded state directly over the
// SAME seam httpApi uses (useStore.getState().setConnectionState). This is the
// only input the reconnecting banner's predicate reads, and no version value
// in the fixture can reach it — so the state is URL-addressable only through
// the transport reporting it. Skipped everywhere else (idle default).
if (typeof window !== "undefined" && DEMO_STATE === "reconnecting") {
  useStore.getState().setConnectionState({
    state: "reconnecting",
    attempt: 2,
    backoffMs: 5000,
  });
}

// ===========================================================================
// Stream state (BET-560) — the mid-stream capture harness.
//
// In every other state the demo serves the FULL settled transcript. In the
// `stream` state it serves the same transcript INCREMENTALLY — a few parts
// of the in-flight assistant message at a time — and exposes
// `window.__mantaDemoStream` so the visual harness can advance it phase by
// phase between captures.
//
// The three phases are NAMED (early/mid/late), not numeric. They sit at the
// same 60-tick scale as the native PoC (spike/native-visual/capture.sh→
// HierarchyDumpUITests.swift), but the raw native sample points (8/17/26)
// only ever revealed reasoning+tools — the assistant's text part (the last
// of the seven in-flight parts) needs the fraction to reach the whole
// message, which no native point does. BET-569 widens the points to 14/26/34
// so the revealed counts land on [2,3,4] of the seven part slots and the
// flushed text part IS visible across every captured phase — otherwise the
// interpreted `stream.flush` path renders in no baseline and a flush-boundary
// regression ships a green gate.
//
// Design difference from native (deliberate, do not "fix"): on a device the
// app-under-test raises SHOT markers mid-stream, because there is no control
// over the stream. On web the demo transport OWNS the stream, so phases are
// driven from the fixture instead — `advance()` emits the `message.updated`
// events the real transcript assembler consumes, so the assembled result is
// exercised over time, not just in its settled end state. No marker plumbing
// in shipped product code.
// ===========================================================================

/** Total stream positions — mirrors the native 60-tick stream so the phase
 *  fractions below are literally on the native scale, not invented for web. */
const DEMO_STREAM_TOTAL = 60;

/** The three named phase boundaries, at ticks 14/26/34 of 60.
 *  (The native 8/17/26 points are here widened so the revealed count reaches
 *  the assistant's text part in every phase — see the header comment.) */
const DEMO_STREAM_PHASE_STEPS = { early: 14, mid: 26, late: 34 } as const;

/** The order in which the in-flight assistant's parts are revealed as the
 *  stream advances. Deliberately NOT the fixture's canonical index order:
 *  the assistant's text part is the LAST of the seven settled parts, so a
 *  canonical prefix reveal would only surface it once all seven are shown.
 *  The mid-stream reveal instead surfaces the flushed text early (right
 *  after reasoning) so every captured phase renders the assistant's text —
 *  the part that `stream.flush` → `applyStreamFlush` feeds. A wrong
 *  flush-boundary / half-rendered-code-fence regression in the interpreted
 *  text path can no longer hide behind a reasoning/tool-only baseline. */
const DEMO_STREAM_REVEAL_ORDER = [
  "prt_a1_reasoning", // hidden by default (Ctrl+O), first to appear
  "prt_a1_text", // the assistant's partial reply — flushed text (BET-569)
  "prt_a1_todo",
  "prt_a1_read",
  "prt_a1_edit",
  "prt_a1_bash",
  "prt_a1_step_finish",
] as const;

/** Ordered phase names — the registry's `phases` field, and the harness's
 *  advance cadence. */
export const DEMO_STREAM_PHASES = ["early", "mid", "late"] as const;

/** Module state for the stepped stream. Only ever read/written when
 *  DEMO_STATE === "stream". */
let streamStep: number = DEMO_STREAM_PHASE_STEPS.early;
let streamPending = false;
let streamServed = false;
const opencodeListeners = new Set<(ev: unknown) => void>();
// Box-derived interpreted event subscribers (stream.running, stream.turnComplete…).
// Mirrors httpApi's `onStreamEvent` (`/events` `kind:"stream"`), delivering the
// `{ sub, sessionId, payload }` envelope so useSseBus's interpreted consumer
// (S1b) is exercised by the demo too, not just a live box.
const streamListeners = new Set<(ev: { sub: string; sessionId: string; payload: unknown }) => void>();

function phaseForStep(step: number): string {
  const entries = Object.entries(DEMO_STREAM_PHASE_STEPS);
  let current = entries[0][0];
  for (const [name, s] of entries) {
    if (step >= s) current = name;
  }
  return current;
}

function nextPhaseStep(step: number): number | null {
  for (const s of Object.values(DEMO_STREAM_PHASE_STEPS)) {
    if (s > step) return s;
  }
  return null;
}

/** How many of the in-flight assistant's parts are revealed at a given
 *  stream position — the stream fraction applied to the reveal order's part
 *  count. The reveal ORDER (not the fixture's index order) is what decides
 *  WHICH parts those are; see `DEMO_STREAM_REVEAL_ORDER`. */
export function revealedAssistantPartCount(step: number): number {
  return Math.round(
    (Math.min(step, DEMO_STREAM_TOTAL) / DEMO_STREAM_TOTAL) * DEMO_STREAM_REVEAL_ORDER.length,
  );
}

/** The transcript the demo serves at a stream position: every settled message
 *  unchanged, plus the in-flight assistant message limited to the parts whose
 *  ids fall within the first `revealedAssistantPartCount(step)` of the reveal
 *  order, presented in canonical order. `demoState.messages` stays the full
 *  settled transcript — this is a read-only view over it, not a mutation. */
export function revealedTranscript(step: number): OpencodeMessage[] {
  const revealed = new Set<string>(DEMO_STREAM_REVEAL_ORDER.slice(0, revealedAssistantPartCount(step)));
  const shown = demoState.messages.map((m) =>
    m.info.role === "assistant" && !m.info.time?.completed
      ? { ...m, parts: m.parts.filter((p) => revealed.has(p.id)) }
      : m,
  );
  // Rebuild the array (never alias demoState.messages) so a consumer holding
  // the earlier snapshot can't count on identity.
  return shown;
}

/** The in-flight assistant's text part (the one a real box would stream via
 *  `stream.flush`). Now revealed by the phase fractions (see
 *  `DEMO_STREAM_REVEAL_ORDER`), so the demo's flush for it lands on the
 *  rendered part — exercising the interpreted `stream.flush` consumption
 *  (`applyStreamFlush`) + latency instrumentation with flushed text actually
 *  in the frame, which is the gap BET-569 closes. */
function streamTextFlushPayload(): { messageID: string; partID: string; text: string } {
  const assistant = demoState.messages.find(
    (m) => m.info.role === "assistant" && !m.info.time?.completed,
  );
  const textPart = assistant?.parts.find(
    (p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string",
  );
  return {
    messageID: assistant?.info?.id ?? "",
    partID: (textPart as { id?: string } | undefined)?.id ?? "",
    text: (textPart as { text?: string } | undefined)?.text ?? "",
  };
}

/** The box-derived interpreted envelopes that a real streamInterp would emit
 *  for the demo's raw event sequence on a phase advance: the streaming `flush`
 *  for the in-flight assistant's text, a `running` and a not-complete
 *  `turnComplete`. The demo owns the stream and, like the fixture, only ever
 *  emits `message.updated` for the in-flight turn — it never emits a
 *  `session.status busy`, so the interpreter's `running` flag stays `false`.
 *  Mirroring that exact semantics (rather than hand-asserting `running:true`)
 *  is what keeps the demo's rendered state identical to the committed
 *  baseline: the composer stays in its idle state, the assistant turn reports
 *  `complete:false`, and the flush's text targets a part the phases never
 *  reveal (so it is applied to nothing). Pure so the emission shape is
 *  assertable without booting React. */
export function buildStreamAdvanceEnvelopes(
  sessionId: string,
): Array<{ sub: string; sessionId: string; payload: unknown }> {
  const flush = streamTextFlushPayload();
  return [
    {
      sub: "flush",
      sessionId,
      payload: {
        messageID: flush.messageID,
        partID: flush.partID,
        field: "text",
        text: flush.text,
      },
    },
    { sub: "running", sessionId, payload: { running: false } },
    { sub: "turnComplete", sessionId, payload: { complete: false, running: false } },
  ];
}

/** `advance()` — move the stepped stream to its next named phase and tell
 *  every live subscriber the in-flight message grew, so the rendered
 *  transcript follows without a navigation. No-op once `late` is reached.
 *
 *  The demo mirrors the box here: it emits BOTH the raw opencode event that
 *  reveals new canonical message parts (the box forwards the raw stream; the
 *  renderer's spliceMessage → opencodeMessage refetch is how new tool parts
 *  appear on a live box too) AND the box-derived interpreted envelopes
 *  (running / turnComplete) consumed via onStreamEvent. */
function streamAdvance(): void {
  const next = nextPhaseStep(streamStep);
  if (next == null) return;
  streamStep = next;
  streamPending = true;
  streamServed = false;
  const assistant = demoState.messages.find((m) => m.info.role === "assistant");
  const sessionId = demoState.activeSessionId;
  const ev = {
    type: "message.updated",
    properties: {
      sessionID: sessionId,
      messageID: assistant?.info?.id ?? "",
    },
  };
  for (const cb of opencodeListeners) cb(ev);
  for (const env of buildStreamAdvanceEnvelopes(sessionId)) {
    for (const cb of streamListeners) cb(env);
  }
}

/** Install the harness window handle. Exported+pure so a test can assert the
 *  "undefined in every state except stream" contract without booting React or
 *  re-pointing window.location. Returns whether the flag was set.
 *
 *  Besides the phase-stepping surface it exposes `latency` — the most recent
 *  first-token→rendered measurement from firstTokenLatency — so a probe or
 *  the visual harness can read the number the demo actually produced (BET-553
 *  §17), rather than the number being unreproducible from outside. */
export function installDemoStreamWindow(
  state: DemoState,
  win: { __mantaDemoStream?: unknown },
): boolean {
  if (state !== "stream") return false;
  win.__mantaDemoStream = {
    steps: DEMO_STREAM_PHASES.length,
    get phase() {
      return phaseForStep(streamStep);
    },
    advance: streamAdvance,
    get pending() {
      return streamPending;
    },
    get served() {
      return streamServed;
    },
    get latency() {
      return lastMeasurement();
    },
  };
  return true;
}

// Install only in the `stream` demo state. The demo transport is only ever
// loaded by bootDemo (never in production), and the `stream` guard is what
// keeps it out of every other demo state — no production path can reach it.
if (typeof window !== "undefined") {
  installDemoStreamWindow(DEMO_STATE, window);
}

// The demo build is the consumer that makes the "logs the measurement to the
// console" claim in firstTokenLatency.ts true: every completed first-token
// measurement (interpreted flush or raw opencode event) is printed, so the §17
// number is observable in a demo run and reproducible by a probe reading it.
if (DEMO_STATE === "stream" && typeof window !== "undefined") {
  onMeasurement(({ path, ms }) => {
    // eslint-disable-next-line no-console
    console.info(`[demo first-token-latency] ${path}: ${ms.toFixed(2)} ms`);
  });
}

// ===========================================================================
// Explicit methods — the ones the renderer actually calls during load +
// first render. Listed in the order they appear in demoFixture.ts.
// ===========================================================================

const configGet = (): Promise<typeof demoState.config> =>
  Promise.resolve(demoState.config);

// BET-678: refresh() now boots + resyncs via the single syncSnapshot RPC
// instead of configGet→tmuxList. The demo transport must satisfy it with a
// full fixture snapshot so the bootstrap effect paints the sidebar.
const syncSnapshot = (): Promise<{
  gen: string;
  seq: number;
  changed: {
    projects: unknown[];
    config: typeof demoState.config;
    stale: boolean;
  };
}> =>
  Promise.resolve({
    gen: "demo",
    seq: 1,
    changed: {
      projects: DEMO_STATE === "empty" ? [] : demoState.projects,
      config: demoState.config,
      stale: false,
    },
  });

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

const isStream = DEMO_STATE === "stream";

// BET-661: an image artifact fixture for the preview-overlay SCREENS capture.
// Served ONLY in the `artifacts` demo state — never the shared default — so the
// default fixture and every other committed baseline stay untouched. The file
// part points at a data: URL, so the preview renders it directly with no box
// (no HEAD/GET needed). The filename matches the preview mockup's screenshot
// row so the overlay header reads identically; the fixture decodes to a small
// 640x360 SVG (dims/size differ from the mockup's prose, acceptable for a
// self-referential layer-2 baseline).
const previewArtifactsImageMessage = {
  info: {
    id: "msg_preview_img",
    sessionID: demoState.activeSessionId,
    role: "user",
    time: { created: DEMO_T0 - 45_000 },
  },
  parts: [
    {
      type: "file",
      id: "prt_preview_img",
      messageID: "msg_preview_img",
      mime: "image/svg+xml",
      filename: "Screenshot 2026-08-05 at 10.45.17.png",
      url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NDAiIGhlaWdodD0iMzYwIj48cmVjdCB3aWR0aD0iNjQwIiBoZWlnaHQ9IjM2MCIgZmlsbD0iIzMzNDA2YiIvPjxjaXJjbGUgY3g9IjMyMCIgY3k9IjE4MCIgcj0iMTIwIiBmaWxsPSIjNWU2YzliIi8+PC9zdmc+",
    },
  ],
} as OpencodeMessage;

const opencodeMessages = (sessionId: string, _opts?: { limit?: number }) =>
  forActiveSession(
    sessionId,
    DEMO_STATE === "artifacts"
      ? [...demoState.messages, previewArtifactsImageMessage]
      : isStream
        ? revealedTranscript(streamStep)
        : demoState.messages,
  );

// The targeted single-message read the transcript assembler's splice uses.
// In the `stream` state this returns the message as revealed at the CURRENT
// stream position, so a message.updated event causes the rendered copy to
// grow one phase at a time. Served marks the phase as applied so the harness
// knows not to screenshot while the splice debounce is still pending.
const opencodeMessage = (_sessionId: string, messageId: string) => {
  const list = isStream ? revealedTranscript(streamStep) : demoState.messages;
  const hit = list.find((m) => m.info.id === messageId) ?? null;
  if (isStream && hit && !hit.info.time?.completed) {
    streamServed = true;
  }
  return Promise.resolve(hit);
};

// The renderer fetches transcripts through `opencodeMessages` (with an
// optional {limit} tail). There is no separate cached/reconcile channel.

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

// In the `stream` state this keeps the registered assembler subscribers so
// advance() can push message.updated events into them (the demo OWNs the
// stream, so it drives the phases from the fixture rather than raising
// markers from inside the app). Every other state is the pre-existing no-op.
const onOpencodeEvent = (cb: (ev: unknown) => void): (() => void) => {
  if (isStream) {
    opencodeListeners.add(cb);
    return () => opencodeListeners.delete(cb);
  }
  return () => {};
};

// Box-interpreted stream events (BET-551 / §17). In the `stream` state the
// demo registers the renderer's onStreamEvent consumer and drives it with the
// same derived envelopes the box emits on advance (see buildStreamAdvanceEnvelopes),
// so the renderer's interpreted consumption path (useSseBus's `stream.*`
// switch, added S1b) is exercised by the demo too. Every other state is the
// pre-existing no-op — the Proxy fallback would also serve one.
const onStreamEvent = (cb: (ev: unknown) => void): (() => void) => {
  if (isStream) {
    streamListeners.add(cb as (ev: { sub: string; sessionId: string; payload: unknown }) => void);
    return () =>
      streamListeners.delete(cb as (ev: { sub: string; sessionId: string; payload: unknown }) => void);
  }
  return () => {};
};

const launchersList = (): Promise<AvailableLauncher[]> =>
  Promise.resolve(demoState.launchers);

// Served pages (BET-660). Returns the fixture's hosted pages so the artifacts
// panel's Links tab renders live/soon/expired state pills in the demo capture.
const servePageList = (): Promise<ServedPageMeta[]> => Promise.resolve(demoState.pages);

// Outbox mailbox listing for the artifacts panel's Files tab — empty in demo
// captures (the demo has no ~/.manta-outbox), so the Proxy fallback would also
// have resolved a no-op; keep it explicit for parity with servePageList.
const outboxList = (): Promise<OutboxFile[]> => Promise.resolve([]);

// Folder picker listing (BET-562). Without these the Proxy fallback resolves
// null and the picker's folder list renders a raw "Cannot read properties of
// null" error in the empty-state capture. The listing is fictional (see
// demoFixture); worktrees are empty so the footer reads "not a git repo".
const fsListDirs = (partial: string): Promise<DirListing> =>
  Promise.resolve(demoFsListDirs(partial));

const gitListWorktrees = (cwd: string): Promise<WorktreeInfo[]> =>
  Promise.resolve(demoGitListWorktrees(cwd));

// BET-1091: create a scratch project dir. Fictional — the demo has no box
// filesystem tree to create a directory in, so it returns a plausible path
// named after the requested (already-slugified) name. Stubbed explicitly so
// the coverage test's unimplemented list stays accurate.
const projectCreateScratch = (input: { root: string; name: string }): Promise<{ path: string; name: string }> =>
  Promise.resolve({ path: "/home/demo/projects/" + input.name, name: input.name });

// Version guard (BET-225 stage 3 Part C + BET-357 §3). Pretend the client and
// server are the aligned default unless the demo state needs a specific version
// pair to drive a banner — the renderer reads these in an effect and derives
// the mismatch/skew/behind state from them:
//   - "version-skew"  → minClient raised above the client (0.0.13), which is
//                       what drives App.tsx's non-dismissible skew banner.
//   - "incompatible"  → the box on a different major (1.0.0) than the desktop
//                       (0.0.13), which drives the wire-contract card.
//   - "server-update" → the box one patch behind the desktop (0.0.10) on the
//                       same major, which drives the "Box needs an upgrade"
//                       card. minClient stays 0.0.0 so it isn't ALSO a skew.
// Every other state keeps the aligned default (same major, match, no skew).
const getClientVersion = (): Promise<{ version: string }> =>
  Promise.resolve({ version: "0.0.13" });

const getServerVersion = (): Promise<{ version: string; minClient: string; opencodeVersion: string }> =>
  Promise.resolve({
    version: DEMO_STATE === "incompatible" ? "1.0.0" : DEMO_STATE === "server-update" ? "0.0.10" : "0.0.13",
    minClient: DEMO_STATE === "version-skew" ? "0.1.0" : "0.0.0",
    opencodeVersion: "0.0.0",
  });

// Desktop auto-update failure (BET-226 / shared/updateError.mjs). The real
// transport forwards only integrity/permission-class failures the user must
// act on; demo mode has no updater, so the fake transport reports one only for
// the "update-failed" state. The renderer's consumer (onAutoUpdateError in
// App.tsx) writes the store field the update-failed banner reads. Every other
// state returns the benign no-op subscribe (never fires).
const onAutoUpdateError = (cb: (info: { message: string; raw: string }) => void): (() => void) => {
  if (DEMO_STATE === "update-failed") {
    queueMicrotask(() =>
      cb({
        message:
          "Update failed to verify — the download's checksum did not match. Please reinstall Manta from the downloads page.",
        raw: "sha512 mismatch: expected a3f1…, got b7c9…",
      }),
    );
  }
  return () => {};
};

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
  syncSnapshot,
  onStatusEvent,
  opencodeMessages,
  opencodeMessage,
  opencodePermissions,
  opencodeQuestions,
  opencodeVcsBranch,
  opencodeListSessions,
  opencodeModels,
  opencodeDefaultModel,
  opencodeOpenStream,
  opencodeCloseStream,
  onOpencodeEvent,
  onStreamEvent,
  launchersList,
  servePageList,
  outboxList,
  fsListDirs,
  gitListWorktrees,
  projectCreateScratch,
  getClientVersion,
  getServerVersion,
  onAutoUpdateError,
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
