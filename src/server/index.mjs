// manta mobile server — runs on the Linux box, exposes tmux over HTTP+WS.
// Serves a touch-friendly single-page client at /.
//
// Why local-exec: this process IS the remote. tmux + node-pty run in the same
// box, so we skip any transport hop entirely — desktop + mobile both reach
// this server over HTTPS (paired, Bearer-token auth). One less moving part,
// one less auth surface.

import { createServer } from "node:http";
import { readFile, stat, mkdir, rm } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, resolve, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { pipeline } from "node:stream/promises";
import { uploadRoot, outboxRoot } from "../shared/paths.mjs";
import { synthesizeSpeech } from "../shared/groq.mjs";
import { WebSocketServer } from "ws";
import * as tmux from "./tmux.mjs";
import * as oc from "./opencode.mjs";
import * as pty from "./pty.mjs";
import * as local from "./local.mjs";
import { createPeekHandler } from "./peek.mjs";
import { createLogShipper, captureConsole, resolveAxiomConfig } from "../shared/logShip.mjs";

// BET-187: ship every console.* (and any startup banner / poller log) to
// Axiom when MANTA_AXIOM_TOKEN is set in env AND AppConfig.shareAnalytics
// is not explicitly false (BET-217 dropped the user-typed axiomToken field;
// the gating boolean is the sole opt-out). Without a token or when opted
// out, resolveAxiomConfig returns null and this block is a silent no-op —
// the server behaves EXACTLY as before, no fetches to axiom.co, no console
// noise. Must run BEFORE createBus() / any subsequent `console.log` so the
// existing `[push]` / `[opencode-pump]` / `[push]` / `[opencode-pump]` /
// `[auth]` call sites ship transparently.
{
  const axiomCfg = resolveAxiomConfig({ env: process.env, config: await local.configGet() });
  if (axiomCfg) {
    captureConsole(createLogShipper({ ...axiomCfg, source: "server", device: hostname() }));
  }
}
import { createBus, handleEventsRequest, attachEventsWs } from "./events.mjs";
import { attachPtyWs } from "./ptyWs.mjs";
import { attachCallWs, createCallRegistry } from "./callWs.mjs";
import { buildHandlers, handleRpcRequest } from "./rpc.mjs";
import { startStatusPoller } from "./status.mjs";
import { createSyncState } from "./syncState.mjs";
import { createStreamInterpreter } from "./streamInterp.mjs";
import { startOutboxPoller, pushArtifact, createArtifactSweep } from "./outbox.mjs";
import { startUploadCleanupPoller } from "./uploads.mjs";
import {
  uploadVoiceNote,
  retryTranscript,
  resolvePlayback,
  loadNotes,
  startVoiceSweep,
} from "./voiceNotes.mjs";
import { startServerUpdatePoller, createOpencodeUpdateForwarder } from "./serverUpdate.mjs";
import { createCliDetector, upgradeCli } from "./cliUpdates.mjs";
import { runServerSelfUpdate } from "./opencodeAdmin.mjs";
import { startSchedulePoller, createJob, listJobs, deleteJob } from "./schedule.mjs";
import { startUsagePoller, recheckAdapterAtLimit, providerIDForAdapter, listSnapshots } from "./usage.mjs";
import {
  createCapJob,
  getJob,
  listJobs as listCapJobs,
  startJob as startCapJob,
  appendLog as appendCapLog,
  completeJob as completeCapJob,
  startCapSweeper,
} from "./capabilities.mjs";
import { notifyCapSession } from "./capNotifier.mjs";
import { createDelegateEngine, buildPermissionRuleset as delegateBuildPermissionRuleset, resolveForgeOwner, loadJobs as loadDelegateJobs } from "./delegate.mjs";
import {
  reportProgress,
  readProgressRecord,
  listProgress,
  clearProgress,
  startProgressSweeper,
} from "./progress.mjs";
import {
  startCleanupPoller,
  registerPage,
  unregisterPage,
  listPages,
  readPage,
  pageResponseHeaders,
  isValidSubdomain,
} from "./servePage.mjs";
import { publishPlanBundle } from "./planRender.mjs";
import { listPeers, inspectPeer, sendPeerMessage, resolveWorkspace } from "./peers.mjs";
import { upsertStopped, markStoppedRan, bumpStoppedAttempts, listStopped } from "./stoppedStore.mjs";
import { createUsageStopEngine } from "./usageStopEnroll.mjs";
import { createUsageResumeEngine } from "./usageResume.mjs";
import * as appControl from "./appControl.mjs";
import * as cto from "./cto.mjs";
import { searchMessages } from "./messageSearch.mjs";
import {
  dispatch as mediaDispatch,
  createPendingMediaStore,
  createMediaSweep,
} from "./media.mjs";
import { setSecret, deleteSecret, listSecrets, provideSecret } from "./secrets.mjs";
import { createPromptDelivery } from "./promptDelivery.mjs";
import { ensureMantaPlanAgent, ensureCtoAgent } from "./providers.mjs";
import {
  createWebhookEngine,
  createHook,
  listHooks,
  deleteHook,
  createRateLimiter,
  findForgeHook,
  listForgeHooks,
} from "./webhooks.mjs";
import { putRegistry as pluginsPutRegistry, getRegistry as pluginsGetRegistry } from "./plugins.mjs";
import {
  getRules as forgeGetRules,
  listRules as forgeListRules,
  saveRules as forgeSaveRules,
  forgeIngest,
} from "./forgeRules.mjs";
import { createRulesEngine, eventLinkRef } from "./forge/rules.mjs";
import {
  createForgePoller,
  repoPollPlan,
  pollChecksFailed,
  pollIssueLabels,
  pollReviewRequested,
} from "./forge/poller.mjs";
import { ensureCommentByTopic, pushSinkAction } from "./forge/sinks.mjs";
import { parseRepoKey as forgeParseRepoKey } from "./forgeRules.mjs";
import { getAdapter } from "./forge/index.mjs";
import { resolveToken as forgeResolveToken } from "./forge/auth.mjs";
import { detectForgeWithHosts } from "./forge/selfhost.mjs";
import { startForgeHealthCheck, healthCheckRepoHook } from "./forge/webhook.mjs";
import { parseRules as parseForgeRules } from "../shared/forgeRules.mjs";
import { detectForge as detectForgeUrl } from "../shared/forge.mjs";
import { sessionLink as readSessionLink } from "../shared/sessionLink.mjs";
import {
  ensureAuth,
  createAuthEngine,
  isLocalDirectRequest,
  parseBearer,
  authorizationForRequest,
  AUTH_RL_CAPACITY,
  AUTH_RL_REFILL_PER_SEC,
} from "./auth.mjs";
import {
  validatePairQrQuery,
  renderPairQr,
  readPairAsset,
} from "./pairPage.mjs";
import * as push from "./push.mjs";
import { registerWithGateway, publicBaseUrl, loadAuthFile, DEFAULT_AUTH_PATH } from "./gatewayRegister.mjs";
import { readServerVersion, readOpencodeVersion, writeVersionResponse } from "./version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

const bus = createBus();
// Model context windows for the interpreter's context reading. listModels() is
// a provider round-trip, so it is fetched once and refreshed only when a model
// we have never seen appears (a newly connected provider). A miss returns null
// and the interpreter falls back to the assumed window rather than blocking.
let modelContextLimits = null;
let modelContextRefresh = null;
function refreshModelContextLimits() {
  if (modelContextRefresh) return modelContextRefresh;
  modelContextRefresh = (async () => {
    try {
      const models = await oc.listModels();
      const next = new Map();
      for (const m of models ?? []) {
        const ctx = m?.limit?.context;
        if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) {
          next.set(`${m.providerID}/${m.id}`, ctx);
        }
      }
      modelContextLimits = next;
    } catch {
      modelContextLimits = modelContextLimits ?? new Map();
    } finally {
      modelContextRefresh = null;
    }
  })();
  return modelContextRefresh;
}
function contextLimitFor(providerID, modelID) {
  if (!providerID || !modelID) return null;
  if (modelContextLimits === null) {
    void refreshModelContextLimits();
    return null;
  }
  const hit = modelContextLimits.get(`${providerID}/${modelID}`);
  if (hit) return hit;
  void refreshModelContextLimits();
  return null;
}

// Box-side stream interpretation (BET-551): interprets the opencode stream on
// the box and republishes derived events on THIS bus (single stream/endpoint).
const streamInterp = createStreamInterpreter({
  publish: (evt) => bus.publish(evt),
  contextLimitFor,
});
// BET-913 + BET-916 + BET-922: when a client (re)connects mid-state, replay the
// current edge-only state so frames that only fire on an edge aren't lost —
// the COMPLETE running picture as one authoritative `runningSet` frame (the
// reconcile-on-reconnect fix; a session absent from the set is not running,
// which is what clears a client latched on a turn that ended while it was
// disconnected) plus pending `questions` / `permissions` (lets a pending
// interactive card reappear and stay answerable on a thin client).
// `snapshotState()` returns these events; the bus replays them to each new
// subscriber.
bus.setSnapshot(() => streamInterp.snapshotState());
// Shared deps passed to store-mutating helpers so they can publish the
// `*.updated` bus event the renderer cards listen for (JobCard, WebhooksCard,
// etc). Single source of truth — every endpoint that creates/deletes a
// store entry uses this same deps object.
const BUS_PUBLISH_DEPS = { publish: (evt) => bus.publish(evt) };

// BET-675: materialized in-memory session/config state. tmux:list is served
// from memory (never a per-request tmux shell-out), and `sync` deltas are
// published on the bus as state changes so clients can recover just what they
// missed. `refreshNow()` is driven by the poller below; `tmux:list` lazily
// guarantees a first tick before serving anything.
const syncState = createSyncState({
  listProjects: () => tmux.listProjects(),
  publish: (env) => bus.publish(env),
});
// Seed the config baseline at startup so the first snapshot already carries it.
syncState.applyConfig(await local.configGet());

// DELETE handler for /api/<store> endpoints: `?id=<id>` → store.deleteFn(id,
// BUS_PUBLISH_DEPS) → 200 {deleted:bool}. The boilerplate (id-required 400,
// the await + publish-deps call, the success response) is identical across
// /api/schedule, /api/webhook, and /api/secrets — extracting it removes a
// 22-line intra-file clone jscpd flagged in BET-155.
async function handleApiDelete(req, url, res, deleteFn) {
  const id = url.searchParams.get("id");
  if (!id) {
    respondJson(res, 400, { error: "id is required" });
    return;
  }
  const result = await deleteFn(id, BUS_PUBLISH_DEPS);
  respondJson(res, 200, { deleted: result.deleted });
}

// rpcHandlers is built further down — after authEngine exists — so the
// `auth:pair` channel can call authEngine.pair() in-process. The dispatch
// only fires inside the HTTP request handler below, which runs lazily once
// the listen() callback returns, so the late binding is safe.
let rpcHandlers = null;

// Resolve a caller's manta project (tmux session) name from its opencode
// sessionID and/or cwd, so project-scoped secrets resolve to the right
// workspace. Reuses the same logic peers.mjs uses. Best-effort: returns null
// if tmux is unreachable or the session/dir isn't matched.
async function resolveProjectName({ sessionID, directory }) {
  if (!sessionID && !directory) return null;
  try {
    const projects = await tmux.listProjects();
    const ws = resolveWorkspace(projects, sessionID, directory);
    return ws?.project?.tmuxSession ?? null;
  } catch {
    return null;
  }
}

// Desktop notification leg: the notification router (push.mjs) publishes a
// `desktopNotify` bus envelope when it decides the desktop should be notified.
// The Electron app subscribes to GET /events and renders it as an OS
// Notification. push.mjs stays bus-decoupled via this sink.
push.setDesktopSink((payload) =>
  bus.publish({ kind: "desktopNotify", payload }),
);

// Periodically capture every tmux pane and push WindowStatus[] batches so the
// mobile sidebar's activity/attention dots work (parity with desktop status.ts).
// eslint-disable-next-line no-unused-vars
const { stop: stopStatusPoller } = startStatusPoller(bus, { intervalMs: 2000 });

// BET-675: sync-state poller — materialize tmux session/config state in memory
// every 2s. Follows the exact shape of the other pollers (in-flight guard +
// unref'd timer so the poller alone never holds the process open). Fire one
// tick immediately at startup (not awaited) so state is warm without waiting a
// full interval.
let syncInFlight = false;
async function syncTick() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    await syncState.refreshNow();
  } finally {
    syncInFlight = false;
  }
}
void syncTick();
const syncTimer = setInterval(() => void syncTick(), 2000);
syncTimer.unref();

// Agent → device file push: watch ~/.manta-outbox/ for files the AI drops and
// publish `agentFile` bus events so connected devices show a "Save" toast
// (parity with the desktop outbox poller; see src/server/outbox.mjs).
// eslint-disable-next-line no-unused-vars
const { stop: stopOutboxPoller } = startOutboxPoller(bus, { intervalMs: 3000 });

// Upload cleanup (BET-427): hourly sweep of ~/.manta-uploads/ that deletes
// per-batch <ts> dirs older than `uploadCleanupHours` (box config, default
// 24, 0 disables) and prunes session dirs left empty. Runs box-server-side
// (the box is a persistent service; the desktop is often offline) and reads
// box config via configGet — same channel worktreePerSession rides. See
// src/server/uploads.mjs.
// eslint-disable-next-line no-unused-vars
const { stop: stopUploadCleanupPoller } = startUploadCleanupPoller({
  configGet: local.configGet,
  uploadRoot: uploadRoot(),
});

// Shared prompt-delivery engine (BET-375). ONE instance, shared by every
// sender that injects a prompt into an opencode session: the scheduled-prompt
// poller, the capability-job notifier, peer messages, and inbound webhooks.
// It tracks per-session busy state from the opencode event firehose
// (observeEvent, called in the pump below) and DEFERS a delivery when its
// target session is mid-turn — so a scheduled tick, a peer agent, a plugin
// job finishing, or an external webhook can NEVER abort the user's in-flight
// model turn. See src/server/promptDelivery.mjs.
const promptDelivery = createPromptDelivery({
  sendPrompt: (args) => oc.sendPrompt(args),
});

// Scheduled-prompt engine: durable jobs in ~/.manta/schedule.json, fired
// by re-submitting the stored prompt into its opencode session — the
// scheduled work then streams into the user's open ChatPanel as a new turn.
// Server-owned (survives Mac-app-close / reboot). The remote AI creates jobs
// via the global opencode `schedule` tool → POST /api/schedule (below). See
// src/server/schedule.mjs + docs/. Delivery routes through the shared
// prompt-delivery engine so a firing while the session is busy is deferred,
// not aborted.
// eslint-disable-next-line no-unused-vars
const { stop: stopSchedulePoller } = startSchedulePoller(
  {
    sendPrompt: (args) => promptDelivery.deliver(args),
    fireNotify: (args) => push.fireNotify(args),
    publish: (evt) => bus.publish(evt),
  },
  { intervalMs: 30000 },
);

// Deferred mobile-push deliveries (BET-1044): every 30s, resolve notifications
// parked by the router (deferMobile) against the live desktop state and deliver
// the ones whose user has gone away. See push.mjs / startDeferredMobilePoller.
// eslint-disable-next-line no-unused-vars
const { stop: stopDeferredMobilePoller } = push.startDeferredMobilePoller();

// Subscription plan usage engine (BET-737): polls each connected provider
// adapter (claude/codex/kimi — src/server/usageAdapters/) for its rolling-5h
// + weekly plan usage and publishes `usage.updated` on the bus whenever the
// snapshot set actually changes. State is an in-memory cache (the poll
// interval IS the cache TTL); the read side is the `usage:list` RPC channel
// (src/server/rpc.mjs → usage.mjs listSnapshots()). NOT the context-window
// indicator — see src/server/usage.mjs for that boundary.
// eslint-disable-next-line no-unused-vars
const { stop: stopUsagePoller, tick: usagePollerTick } = startUsagePoller(bus);

// Usage-stop resume engine (BET-1048): watches the ARMED entries in the
// usage-stopped record and resumes them once their provider's usage genuinely
// recovers — sending the literal "Keep going" on the model pinned in the
// record, staggered a few seconds apart, via the shared prompt-delivery engine
// (so a mid-turn conversation defers until idle). It reuses THIS usage poller:
// every `usage.updated` snapshot drives a check, and a one-shot re-check timer
// at the earliest still-limited provider reset forces usagePollerTick() to
// re-fetch immediately — no second polling loop. observeEvent is fed the
// opencode pump below. This engine replaces (and only the engine replaces) the
// old renderer-side reset+60s continuation path, which is deleted.
const resumeEngine = createUsageResumeEngine({
  markRan: (input) => markStoppedRan(input, { publish: (evt) => bus.publish(evt) }),
  bumpAttempts: (input) => bumpStoppedAttempts(input, { publish: (evt) => bus.publish(evt) }),
  deliver: (args) => promptDelivery.deliver(args),
  providerIDForAdapter,
  forceRecheck: () => usagePollerTick(),
  publish: (evt) => bus.publish(evt),
});
// eslint-disable-next-line no-unused-vars
const stopUsageResume = bus.subscribe((evt) => {
  if (evt?.kind === "usage.updated" && Array.isArray(evt.payload?.snapshots)) {
    void resumeEngine.deliverSnapshots(evt.payload.snapshots).catch((e) =>
      console.warn("[usage-resume] deliverSnapshots failed:", e?.message ?? e),
    );
  }
});
// Prime on startup: covers the poller's immediate first tick racing our
// subscription, and the "box asleep across the reset -> run on wake, however
// late" case — evaluate now against whatever the poller already has cached.
// Safe by construction: with no reading yet (the pre-first-poll cache is
// empty) the engine WAITS, so this warmup can never send "Keep going" before
// the first real poll confirms quota returned. Recovery is then driven by the
// first real `usage.updated`.
void resumeEngine.deliverSnapshots(listSnapshots()).catch((e) =>
  console.warn("[usage-resume] initial deliverSnapshots failed:", e?.message ?? e),
);

// Usage-stop enrolment (BET-1047 stage 1): derives durable "stopped
// conversation" records from the opencode stream (see usageStopEnroll.mjs).
// Either a refusal-word match or the provider's meter sitting at its limit
// (re-checked on the failure via the EXISTING usage adapters) enrols a
// conversation into the stoppedStore. observeEvent is called from the pump
// below. Scope: the three subscription providers only.
const usageStopEngine = createUsageStopEngine({
  upsert: (input) => upsertStopped(input, { publish: (evt) => bus.publish(evt) }),
  recheckAtLimit: (adapterId) => recheckAdapterAtLimit(adapterId),
  resolveWorkspace: async (sessionId) => {
    try {
      const dir = await oc.getSessionDirectory(sessionId);
      if (!dir) return "";
      const leaf = basename(dir);
      return leaf || dir;
    } catch {
      return "";
    }
  },
});

// Capability-job sweeper: same shape as startSchedulePoller — fails out stale
// `running` jobs (30 min) and expired `queued` jobs (24h), then prunes terminal
// jobs past retention/cap. Notifies the originating session on every
// transition, so the user sees a fresh turn when a job times out. See
// src/server/capabilities.mjs + docs/mantaui-plugins.md §Layer 1.
// Capability-job completion → opencode session notification. Wired via
// src/server/capNotifier.mjs (see that file for why the field translation
// lives in one place). Shared by the sweeper and the /api/cap/:id/done REST
// handler below — one definition, two callers. The notifier routes through
// the shared prompt-delivery engine so a completion notice defers while busy.
const capNotify = (args) => notifyCapSession(args, { deliver: promptDelivery.deliver });
// eslint-disable-next-line no-unused-vars
const { stop: stopCapSweeper } = startCapSweeper({
  publish: (evt) => bus.publish(evt),
  notifySession: capNotify,
});

// Inbound webhook engine: external actors POST to the public /hook/<token>
// route (below) to wake a chat session with an event — the push counterpart to
// the schedule poller. The engine owns the per-token rate limiter and delegates
// busy-tracking + the defer-until-idle queue to the shared prompt-delivery
// engine. See src/server/webhooks.mjs + docs.
// The rules engine (BET-798) is built after the delegate engine it dispatches
// through (created further down); the webhook-engine closure references it by
// the `let` binding, so it is always the live single instance at delivery time.
let forgeRulesEngine = null;

const webhookEngine = createWebhookEngine({
  sendPrompt: (args) => oc.sendPrompt(args),
  delivery: promptDelivery,
  publish: (evt) => bus.publish(evt),
  // Forge hooks route to the forge ingest path instead of waking a session.
  // Ingest verifies + dedupes + filters (all in webhooks.mjs), RECORDS every
  // verified delivery to the box-side event log, then — when the rules engine
  // is live — dispatches through it (the pay-off: an event can start an agent
  // in its own worktree). With the global toggle off nothing routes (no forge
  // hooks exist anyway — registration is gated; this check is
  // belt-and-suspenders).
  forgeIngest: async (args) => {
    const cfg = await local.configGet();
    if (cfg?.forgeRulesEnabled !== true) return null;
    const rec = await forgeIngest(args);
    if (forgeRulesEngine) await forgeRulesEngine.handleEvent(args);
    return rec;
  },
});

// Background-job engine (BET-378): durable jobs that run in their own
// worktree + chat-mode window, detect completion from the opencode event
// stream, and report their result back to the parent session (deferred until
// the parent is idle via the shared prompt-delivery engine). See
// src/server/delegate.mjs. Completion detection runs in the opencode pump
// below (delegateEngine.observeEvent); the sweeper fails out stale running
// jobs (30 min) and prunes terminal retention; the 10s activity poller
// refreshes the `activity` summary for running jobs. The AI tool + UI are
// Stage 3 — this server wiring is Stage 2 only.
const delegateEngine = createDelegateEngine({
  publish: (evt) => bus.publish(evt),
  deliver: (args) => promptDelivery.deliver(args),
  listProjects: () => tmux.listProjects(),
  newWindow: (input) => tmux.newWindow(input),
  killWindow: (input) => tmux.killWindow(input),
  gitAddWorktree: (input) => local.gitAddWorktree(input),
  gitRemoveWorktree: (input) => local.gitRemoveWorktree(input),
  gitRun: (args) => tmux.run("git", args),
  listMessages: (sid) => oc.listMessages(sid),
  listModels: (overrides) => oc.listModels(overrides),
  abortSession: (sid) => oc.abortSession(sid),
  // BET-418 §B: detect a running job whose parent opencode session is gone so
  // the sweeper can stop + clean it up (nobody left to report to).
  // Direct lookup, NOT a listSessions scan: `GET /session` is capped at 100
  // and the unscoped form is box-wide, so a healthy parent that simply isn't
  // among the 100 most recent sessions read as "gone" and the sweeper stopped
  // the job. See opencode.mjs:sessionExists.
  sessionExists: (sid) => oc.sessionExists(sid),
  oc,
  // BET-790: the job card shows the child's live progress record and clears it
  // when the job ends. Reads the same progress.json store delegate reads —
  // no second store/event.
  readProgress: (sid) => readProgressRecord(sid),
  clearProgress: (sid) => clearProgress(sid),
});
// eslint-disable-next-line no-unused-vars
const { stop: stopDelegateSweeper } = delegateEngine.startSweeper();
// eslint-disable-next-line no-unused-vars
const { stop: stopDelegateActivityPoller } = delegateEngine.startActivityPoller();

// Progress-store sweeper (BET-790): prunes records not updated within 7 days.
// Same startPoller shape as the other pollers (immediate first tick, inFlight
// guard, timer.unref()).
// eslint-disable-next-line no-unused-vars
const { stop: stopProgressSweeper } = startProgressSweeper({ publish: (evt) => bus.publish(evt) });

// ---- rules engine + polling fallback + progress sinks (BET-798) ----------
//
// The rules engine is pure composition: matched rule in, existing engine
// called. Nothing is spun up here that does not already exist:
//   - delegate → the EXISTING delegate engine (delegateEngine.startJob).
//   - notify   → the EXISTING notification router (push.fireNotify).
//   - inbox    → invalidate the inbox cache.
// The engine is OFF by default (forgeRulesEnabled, read live from config).
//
// The box's own forge identity (its gh login) is used to ignore self-caused
// events; resolved lazily once. When it cannot be resolved, self-filtering is
// simply off (the cap + fork guards still hold).
let forgeSelf = null;
local
  .detectForgeCli()
  .then((cli) => {
    if (cli?.login) forgeSelf = cli.login;
  })
  .catch(() => {});
const forgeRefusalLog = new (class {
  // A plain box-side refusal record; never a queue. Appended to the same
  // box-side events log forge ingest already writes.
  append(entry) {
    console.warn(`[forge-rules] refusal: ${entry?.reason ?? ""} (${entry?.repoKey ?? "?"})`);
  }
})();
const forgePollSeen = new Map(); // repoKey -> { issues, checks, reviews } seen-sets (poller de-dup)

forgeRulesEngine = createRulesEngine({
  enabled: async () => (await local.configGet())?.forgeRulesEnabled === true,
  startDelegate: async ({ prompt, repoKey, event, rule }) => {
    // Resolve a parent directory to branch the worktree off: the box's own
    // local checkout of the linked repo (found via the same repo scan the
    // forge probe uses, matched by repoKey). This replaces the BET-798 stopgap
    // that required a hand-made directory at ~/.manta/forge-checkouts/<repo>.
    const cwd = await resolveForgeParentDirectory(repoKey);
    if (!cwd) {
      return {
        ok: false,
        error: "no local checkout of this repo to branch the job worktree off",
      };
    }
    // Session-link primitive (§3.4⑥, BET-844): carry the triggering issue / PR
    // on the job's session record so the forge progress sink comments on the
    // ISSUE, not a job-own-PR guess. checks.failed has no issue/PR number →
    // no link → the sink no-ops (no distinct target), which is correct.
    const link = eventLinkRef(repoKey, event);
    // Resolve the real parent: the tmux project that owns this repo's checkout,
    // so the job's window has a home (the stopgap's synthetic "forge" parent
    // could never resolve an owner, so a forge delegate could not actually
    // launch). Refused when no local project wraps the checkout.
    const owner = resolveForgeOwner(await tmux.listProjects(), cwd);
    if (!owner) {
      return {
        ok: false,
        error: "no local project wraps this repo checkout to host the job window",
      };
    }
    const permission = delegateBuildPermissionRuleset([
      { permission: "bash", pattern: "**" },
      { permission: "write", pattern: "**" },
      { permission: "edit", pattern: "**" },
      { permission: "webfetch", pattern: "**" },
    ]);
    return delegateEngine.startJob({
      prompt,
      parentSessionID: owner.parentSessionID,
      parentDirectory: cwd,
      permission,
      link,
    });
  },
  notify: async ({ message, event }) =>
    push.fireNotify({
      message: message ?? "Forge event",
      title: event?.type ?? "Forge",
      urgent: false,
    }),
  invalidateInbox: async ({ repoKey }) => {
    // The inbox cache is invalidated on the bus; the engine never logs or
    // wakes a session for an inbox verb.
    bus.publish({ kind: "forge.inbox.invalidated", payload: { repoKey } });
  },
  recordRefusal: (entry) => forgeRefusalLog.append(entry),
  self: () => forgeSelf,
});

// The polling fallback — a required peer for boxes with no public ingress
// (Tailscale-only / macOS) and for forges that kill failing webhooks. Reuses
// startPoller (via createForgePoller) and the forge request layer's ETag/304;
// never polls a repo that has a working webhook.
const { stop: stopForgePoller } = createForgePoller({
  intervalMs: 60_000,
  listRepos: async () => {
    const cfg = await local.configGet();
    if (cfg?.forgeRulesEnabled !== true) return [];
    const rows = await forgeListRules();
    const hostKinds = cfg?.forgeHosts ?? [];
    const out = [];
    for (const row of rows) {
      if (!row.valid) continue; // invalid rules never dispatch (listed in Settings)
      // Provider-aware poll plan (BET-855): a GitLab hook is stored under
      // `provider: "gitlab"`, so webhookRegistered must be resolved with the
      // repo's forge kind or the poller would poll a repo that has a working
      // webhook — violating "never both: a working webhook wins".
      const plan = await repoPollPlan(
        { repoKey: row.repoKey, yaml: row.yaml ?? "", hostKinds, findHook: findForgeHook },
        { parse: parseForgeRules },
      );
      if (!plan) continue;
      out.push(plan);
    }
    return out;
  },
  pollRepo: async (repo) => {
    const tok = await forgeResolveToken(repo.parts.host).catch(() => null);
    if (!tok) return { events: [] };
    // Use the repo's forge kind, not a hardcoded github adapter — a GitLab repo
    // on a box that cannot register webhooks is polled against the GitLab API.
    const adapter = getAdapter(repo.kind ?? "github", tok.token);
    const prRepo = { owner: repo.parts.owner, repo: repo.parts.repo };
    let state = forgePollSeen.get(repo.repoKey);
    if (!state) {
      state = { issues: new Set(), checks: new Set(), reviews: new Set() };
      forgePollSeen.set(repo.repoKey, state);
    }
    const events = [];
    if (repo.label) {
      const { events: ev } = await pollIssueLabels(
        { repo: prRepo, label: repo.label, listIssues: (r, f) => adapter.listIssues(r, f) },
        { seen: state.issues },
      );
      events.push(...ev);
    }
    if (repo.pollChecksFailed) {
      const { events: ev } = await pollChecksFailed(
        { repo: prRepo, listPullRequests: (r, f) => adapter.listPullRequests(r, f), getChecks: (r, sha) => adapter.getChecks(r, sha) },
        { seen: state.checks },
      );
      events.push(...ev);
    }
    if (repo.pollReviewRequested) {
      const { events: ev } = await pollReviewRequested(
        { repo: prRepo, listPullRequests: (r, f) => adapter.listPullRequests(r, f) },
        { seen: state.reviews },
      );
      events.push(...ev);
    }
    return { events: events.map((e) => ({ ...e, repoKey: repo.repoKey })) };
  },
  handleEvent: (ev) => forgeRulesEngine.handleEvent(ev),
});

// The forge hook health check (BET-855) — the production caller for the
// re-enable capability in forge/webhook.mjs. GitLab permanently disables a
// failing webhook with no automatic recovery, so a periodic pass iterates the
// persisted forge-hook store, resolves each GitLab host's token, and re-enables
// (`PUT {active:true}`) any hook GitLab disabled. Same startPoller cadence as
// the forge poller above; does nothing while the forge-rules toggle is off (no
// gitlab hooks exist then anyway). Github hooks are skipped — GitHub never
// auto-disables. 15 min: a box that sleeps at night falls a few checks behind
// but re-arms promptly on wake, far below GitLab's permanent-disable threshold.
const FORGE_HEALTH_INTERVAL_MS = 15 * 60_000;
// eslint-disable-next-line no-unused-vars
const { stop: stopForgeHealthCheck } = startForgeHealthCheck({
  intervalMs: FORGE_HEALTH_INTERVAL_MS,
  listHooks: async () => {
    const cfg = await local.configGet();
    if (cfg?.forgeRulesEnabled !== true) return [];
    return (await listForgeHooks().catch(() => []))
      .map((h) => {
        const parts = forgeParseRepoKey(h.repoKey);
        if (!parts) return null;
        return {
          kind: h.provider ?? "github",
          host: parts.host,
          owner: parts.owner,
          repo: parts.repo,
          hookId: h.hookId,
        };
      })
      .filter(Boolean);
  },
  resolveToken: async (host) => ((await forgeResolveToken(host).catch(() => null))?.token) ?? null,
  checkHook: healthCheckRepoHook,
});

// Resolve a parent directory to branch a forge-triggered job's worktree off.
// The parent-directory the session-link primitive names (spec §3.4⑥, BET-844):
// the box's own local checkout of the linked repo — found via the same repo
// scan the forge probe uses, matched by repoKey — rather than the BET-798
// stopgap convention of a hand-made ~/.manta/forge-checkouts/<repo> directory.
// Returns the checkout path, or null when the repo isn't checked out on this
// box (the job is then refused: you cannot branch a worktree off a clone you
// don't have).
async function resolveForgeParentDirectory(repoKey) {
  if (typeof repoKey !== "string" || !forgeParseRepoKey(repoKey)) return null;
  try {
    const { repos } = await local.scanRepos({ roots: local.buildRoots() });
    const hit = (repos ?? []).find((r) => r.repoKey === repoKey);
    return hit?.path ?? null;
  } catch {
    return null;
  }
}

// Resolve the forge progress sink target from the session-link primitive
// (spec §3.4⑥, BET-844): the LINKED pull request or issue on the job's own
// session record — the triggering issue. Replaces the BET-798 stopgap that
// walked worktree → origin → open PR (which could only ever reach a job's own
// PR, never the issue that started it). Returns { adapter, repo, number } or
// null (the sink no-ops) when the job has no link — e.g. checks.failed, which
// carries no issue/PR number in its event.
async function resolveForgeSinkTarget(childSessionID) {
  try {
    const { jobs } = await delegateEngine.listJobs();
    const job = jobs?.find((j) => j.childSessionID === childSessionID);
    const link = readSessionLink(job ?? null);
    const ref = link?.pr ?? link?.issue;
    if (!ref) return null;
    const parts = forgeParseRepoKey(ref.repoKey);
    if (!parts) return null;
    const forge = detectForgeUrl(`https://${parts.host}/${parts.owner}/${parts.repo}`);
    if (!forge) return null;
    const tok = await forgeResolveToken(forge.host).catch(() => null);
    if (!tok) return null;
    const adapter = getAdapter(forge.kind, tok.token);
    return { adapter, repo: { owner: forge.owner, repo: forge.repo }, number: ref.number };
  } catch {
    return null;
  }
}

// Single-box auth gate (M1, job zero). Every request must carry the box_token
// as `Authorization: Bearer <token>` except the pairing handshake (/auth/*) and
// the public webhook delivery leg (/hook/<token>, self-authenticated). The box
// identity ({box_id, box_token}) is generated + persisted 0600 on first run.
//
// Enforcement is ON by default. MANTA_AUTH_DISABLED=1 is an escape hatch for an
// existing self-hoster mid-upgrade who hasn't paired yet — it disables the gate
// and prints a loud warning. New deployments should never set it.
const authEnforced = process.env.MANTA_AUTH_DISABLED !== "1";
const boxAuth = await ensureAuth();
const authEngine = createAuthEngine({ auth: boxAuth, enforce: authEnforced });
// Rate limiter for the unauthenticated /auth/* surface (the brute-force target).
const authRateLimit = createRateLimiter({
  capacity: AUTH_RL_CAPACITY,
  refillPerSec: AUTH_RL_REFILL_PER_SEC,
});
if (!authEnforced) {
  console.warn(
    "[auth] ⚠️  MANTA_AUTH_DISABLED=1 — the server is UNAUTHENTICATED. " +
      "Anyone who can reach this port has full access. Unset it and pair a device.",
  );
} else {
  console.log(`[auth] gate enabled — box_id ${boxAuth.box_id}`);
}

// Now that authEngine exists, wire the /rpc dispatch — the `auth:pair` channel
// needs authEngine.pair() (GET /auth/pair is loopback-only, so the renderer can
// only reach it through this in-process call, not as an HTTP round-trip).
//
// `serverVersion` is the SAME value `GET /api/version` returns — read once at
// startup from package.json and threaded into both the REST route handler
// below and the `server:version` RPC channel here, so the two surfaces can
// never drift apart on a given box. The renderer goes through the RPC channel
// (in-process, no HTTP round-trip); curl + future non-renderer clients use the
// REST route.
const SERVER_VERSION = await readServerVersion(PROJECT_ROOT);
// BET-428: opencode's HTTP API exposes no version endpoint, so shell out to
// `opencode --version` ONCE at startup (sync, cached here — never per-request).
// Falls back to FALLBACK_VERSION if opencode isn't installed / errors, so the
// boot sequence is never blocked. Surfaced in the same `server:version` RPC
// response + `/api/version` body as `version` + `minClient` — no new IPC
// channel; Settings → About reads it in the single getServerVersion trip.
const OPENCODE_VERSION = readOpencodeVersion();
rpcHandlers = buildHandlers({
  tmux,
  oc,
  pty,
  bus,
  local,
  syncState,
  authPair: () => authEngine.pair(),
  push,
  serverVersion: SERVER_VERSION,
  opencodeVersion: OPENCODE_VERSION,
  delegate: delegateEngine,
  // BET-790: renderer read channel for a session's progress record (the
  // server store from src/server/progress.mjs). The write side is the AI's
  // progress_report tool → POST /api/progress.
  progress: { getRecord: (sessionID) => readProgressRecord(sessionID) },
  // BET-366 reviewer return: production wiring for the
  // `server:update-apply` IPC channel. The handler in rpc.mjs calls this
  // with SELF_UPDATE_SCRIPT (resolved at module load from `import.meta.url`).
  // The unit test in rpc.test.mjs passes a stub instead so the channel
  // routing can be exercised without actually spawning a child. The bound
  // `publish` lets the updater tail its log and republish progress markers
  // (`serverUpdateProgress` bus events) so the renderer can render a
  // determinate progress bar.
  runServerSelfUpdate: (scriptPath) =>
    runServerSelfUpdate(scriptPath, undefined, { publish: (e) => bus.publish(e) }),
  // On-demand form of the update-poller's tick, behind the
  // `server:update-check` channel. Wrapped in a thunk rather than passed by
  // value because the poller is started BELOW this call (it has to be, so it
  // can capture SERVER_VERSION) — the arrow resolves `checkServerUpdate` when
  // an RPC actually arrives, long after module init, so there is no TDZ.
  // Still guarded: if a future reorder ever left it unset, a check should
  // report "no update" rather than throw at the renderer.
  checkServerUpdate: () =>
    typeof checkServerUpdate === "function"
      ? checkServerUpdate()
      : Promise.resolve({ available: false }),
  // BET-1096 stage 2: the box-side CLI detector rides the existing
  // `server:update-check` call, so the response gains the CLI targets (behind
  // a timeout + try/catch in the handler — a CLI probe can never break the
  // box-update check). 5-minute cached, in-flight-joining probe; no second
  // poller, no new channel, no second bus event kind.
  cliDetector: createCliDetector(),
  // BET-1162: per-row single-CLI upgrade (the `server:cli-update` channel).
  // Shares the SAME cached detector instance above (wired to the
  // `server:update-check` probe) so a manual per-row upgrade reuses the fresh
  // probe rather than spawning a second detector.
  upgradeCli,
  // BET-834: voice-note metadata over /rpc (audio goes over REST). Oldest
  // first, filtered by session, no audio bytes.
  voiceNotes: {
    list: ({ sessionId } = {}) => {
      const notes = loadNotes();
      const sid = typeof sessionId === "string" && sessionId ? sessionId : null;
      return notes
        .filter((n) => (sid ? n.sessionId === sid : true))
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .map(({ id, sessionId: s, transcript, mime, durationMs, peaks, createdAt, expiresAt, audioAvailable }) => ({
          id,
          sessionId: s,
          transcript,
          mime,
          durationMs,
          peaks,
          createdAt,
          expiresAt,
          audioAvailable: audioAvailable !== false,
        }));
    },
  },
  contextLimitFor,
});

// Server-update checker: polls https://mantaui.com/updates/server.json every
// 6h, publishes a `serverUpdateAvailable` bus event on a newer release (the
// stage-3 renderer banner consumes this), and fires ONE informational
// notification through the existing push.fireNotify path so a closed app
// still learns. Dedup is per-version. See src/server/serverUpdate.mjs +
// docs/manta-update-system.md (BET-225 stage 2). Wired here — AFTER
// SERVER_VERSION is read — so the poller can capture the box's running
// version (reviewer caught a TDZ when this was placed next to the other
// pollers above, before `SERVER_VERSION` was initialised).
// `check` is the on-demand form of the same tick, reached over the
// `server:update-check` RPC by Settings → About's "Check for updates" button
// and by the desktop's check-on-connect. Sharing the poller's own tick is the
// point: a second fetch+compare could report something different from the
// banner, and "the button says up to date while a banner says otherwise" is
// worse than no button.
// eslint-disable-next-line no-unused-vars
const { stop: stopServerUpdatePoller, check: checkServerUpdate } =
  startServerUpdatePoller({
    bus,
    currentVersion: SERVER_VERSION,
    notify: push.fireNotify,
  });

// Cleanup sweep for expired pages (runs every 5 min).
// eslint-disable-next-line no-unused-vars
const { stop: stopServePageCleanup } = startCleanupPoller();

// Best-effort install of the MantaUI-owned `manta-plan` primary agent (BET-984).
// Reads ~/.config/opencode/opencode.jsonc; writes the manta-plan agent block
// (mode "primary", plan_enter/plan_exit allow) via the existing writer and
// restarts opencode only when the config changed. Idempotent + fire-and-forget
// so a failure here never blocks or fails server startup.
void ensureMantaPlanAgent().catch((e) => console.error("[manta-plan] ensure failed:", e));

// On-call CTO (BET-1164): build the engine lazily once, wired to the box's
// real engines (all read-only). The engine's `dispatch` seam is what the
// `/api/cto` route (and, later, issues 2/3) consume. Building lazily keeps it
// off the hot startup path and lets every dep resolve after module init.
let ctoEngine = null;
function getCtoEngine() {
  if (!ctoEngine) {
    ctoEngine = cto.createCtoEngine({
      listProjects: () => tmux.listProjects(),
      listSessions: (dir) => oc.listSessions(dir),
      listMessages: (sid, opts) => oc.listMessages(sid, opts),
      listModels: () => oc.listModels(),
      getSessionAgent: (sid) => oc.getSessionAgent(sid),
      listSnapshots,
      listStopped,
      searchMessages,
      configGet: () => local.configGet(),
    });
  }
  return ctoEngine;
}

// Best-effort install of the `cto` primary agent (BET-1164) — ONLY when the
// feature is enabled (default off until shipped). Reads/writes opencode.jsonc
// via the existing writer, restarts opencode only when the block changed.
async function maybeEnsureCtoAgent() {
  try {
    let cfg;
    try {
      cfg = await local.configGet();
    } catch {
      cfg = {};
    }
    if (!cfg?.cto?.enabled) return;
    const model =
      cfg?.defaultModel?.providerID && cfg?.defaultModel?.modelID
        ? `${cfg.defaultModel.providerID}/${cfg.defaultModel.modelID}`
        : undefined;
    await ensureCtoAgent({ model });
  } catch (e) {
    console.error("[cto] ensure failed:", e);
  }
}
void maybeEnsureCtoAgent();

// On-call CTO inbound funnel (Issue 2): the single place a CTO-bound event
// enters the box. Producers (the send_to_cto tool, the watcher poller, a
// scheduled prompt targeting the CTO, a webhook routed to the CTO) all call
// `inbound()`. The server-side "call active" flag is FALSE this issue (Issue 3
// sets it), so every event takes the PARKED route → dedupe → the existing
// notification router (fireNotify). No parallel notify path.
const ctoInbound = cto.createCtoInbound({
  isCallActive: () => callActive,
  ctoSessionID: null, // issue 3 wires the live route below via the active call engine
  fireNotify: (args) => push.fireNotify(args),
  sendPrompt: async ({ text }) => {
    // LIVE route (issue 3): while a call is open, inject the inbound event as
    // a turn into the active Realtime session so the CTO speaks it. Parked
    // events never reach here (isCallActive guards the branch).
    const engine = activeCallEngine;
    if (engine && text) {
      try {
        engine.injectTurn(typeof text === "string" ? text : String(text ?? ""));
      } catch (e) {
        console.warn("[cto] live inject failed:", e?.message ?? e);
      }
    }
  },
});

// The server-side "call active" flag issue 2's inbound funnel reads. Set by
// the /call WS handler (issue 3): true while a call window is connected, with
// a reference to its engine so live inbound events can be spoken. Parked state
// (window hidden) keeps the flag false → events take the existing push route.
let callActive = false;
let activeCallEngine = null;
function setCallActive(active, engine) {
  callActive = !!active;
  activeCallEngine = active && engine ? engine : null;
}
// Single-call guard (BET-1185, Cause 2): exactly one live /call at a time. A
// new /call while one is active displaces (tears down) the previous one; the
// registry is passed to every attach so the takeover logic runs inside
// callWs.mjs where it is unit-testable.
const callRegistry = createCallRegistry();

// Which read a watcher's surface maps to. NATIVE surfaces (schedule, delegate)
// go through the box's own stores. `session` needs no poller read — session
// events arrive directly via send_to_cto.
async function ctoSurfaceRead(surface, query) {
  switch (surface) {
    case "schedule":
      return { ok: true, data: { jobs: await listJobs() } };
    case "delegate":
      return { ok: true, data: { jobs: await loadDelegateJobs() } };
    case "session":
    default:
      return { ok: true, data: {} };
  }
}

// Watcher poller (Issue 2): probes each active watch against its surface's
// existing read and routes a matching + unseen event into the inbound funnel.
// In-flight-guarded + timer.unref(), mirroring the schedule/delegate pollers.
const watcherPoller = cto.createWatcherPoller({
  loadWatches: async () => Array.isArray(cto.loadCtoStore()?.watches) ? cto.loadCtoStore().watches : [],
  saveWatches: async (watches) => {
    const store = cto.loadCtoStore();
    store.watches = Array.isArray(watches) ? watches : [];
    await cto.saveCtoStore(store);
  },
  readSurface: ctoSurfaceRead,
  sendToInbound: (input) => ctoInbound.inbound(input),
});
// eslint-disable-next-line no-unused-vars
const stopWatcherPoller = watcherPoller.start({ intervalMs: 15_000 });

// Sweep expired artifact-mailbox files (TTL past) every 5 min — non-destructive
// otherwise: downloads do not delete, the sweep is what reclaims disk.
// eslint-disable-next-line no-unused-vars
const artifactSweep = createArtifactSweep();
artifactSweep.start();

// Inline-media orphan poller (BET-1147): in-memory pending placeholders for
// `media_begin`. A `begin` with no matching `show` after 10 minutes publishes
// `action:"fail"` and is dropped. Same sweep shape as createArtifactSweep
// (inFlight guard + timer.unref()). See src/server/media.mjs.
const mediaPending = createPendingMediaStore();
const mediaSweep = createMediaSweep({
  pending: mediaPending,
  publish: (payload) => bus.publish({ kind: "media", payload }),
});
mediaSweep.start();

// Voice-note audio TTL sweep (BET-834): deletes EXPIRED audio files every 5
// min but KEEPS the records (transcript + waveform outlive the clip), flipping
// each note's audioAvailable to false so a client renders a disabled play
// button without probing. Same cadence as the servePage/outbox/schedule
// pollers. See src/server/voiceNotes.mjs.
// eslint-disable-next-line no-unused-vars
const { stop: stopVoiceSweep } = startVoiceSweep();

// Proactive pre-expiry Claude credential refresh (BET-281): clocks
// ~/.claude/.credentials.json every 10 min and refreshes ~30 min ahead of
// expiry. Reactive recovery (BET-280) becomes a backup. See
// src/server/opencode.mjs (startCredentialRefreshPoller) — same shape as
// the other timer pollers above.
// eslint-disable-next-line no-unused-vars
const { stop: stopCredentialRefreshPoller } = oc.startCredentialRefreshPoller();

// Forward every opencode SSE event into the bus so mobile clients
// subscribed to /events receive live chat updates.
// subscribeEvents reconnects silently on failure (opencode may not be up
// yet at server start — that's fine, it retries with 1.5s backoff).
//
// Trust mode (mirrors src/main/index.ts opencodeBusLoop):
// When a permission.asked event arrives and chatAutoAllow is true, we
// auto-reply "always" and suppress the event (no permission card reaches
// the client). Config is read live per event so toggling Trust takes
// effect immediately. On any error in the auto-allow path we fall back
// to publishing the event normally so the user can approve manually.
//
// subscribeEvents calls onEvent() synchronously (no await), so we wrap
// the async trust-mode logic in an immediately-invoked async function
// with .catch() to avoid unhandled rejection warnings if the async work
// rejects — the pump loop itself is unaffected.
// Compute live chat-session directories once at startup (best-effort). Used to
// eagerly open their scoped opencode event streams so the first turn streams
// live on a fresh box. Bounded to actual chat windows (those stamped with an
// opencode session id) — not the full catalog. Top-level `await` is available
// in this module (index.mjs is ESM and runs top-level awaits already).
let eagerChatDirs = [];
try {
  const projects = await tmux.listProjects();
  eagerChatDirs = [
    ...new Set(
      (projects ?? [])
        .flatMap((p) => p.windows ?? [])
        .filter((w) => typeof w.opencodeSessionId === "string" && w.opencodeSessionId.length > 0)
        .map((w) => w.paneCurrentPath)
        .filter((d) => typeof d === "string" && d.length > 0),
    ),
  ];
} catch { /* non-fatal */ }

// Forward opencode's own `installation.update-available` onto the shared
// serverUpdateAvailable banner. Dedup state is held in the forwarder closure.
const forwardOpencodeUpdate = createOpencodeUpdateForwarder();

// eslint-disable-next-line no-unused-vars
const stopOpencodePump = oc.subscribeEvents((evt) => {
  // Map opencode's own installation.update-available onto the EXISTING
  // serverUpdateAvailable banner (BET-1016). The forwarder is dedup-gated by
  // opencode version and returns null for non-update events, so this is a no-op
  // for everything else and never re-raises a version already shown.
  const forwardedUpdate = forwardOpencodeUpdate(evt);
  if (forwardedUpdate) {
    bus.publish(forwardedUpdate);
  }
  // Box-side stream interpretation (BET-551 / §17): derive interpreted events
  // from the raw opencode stream and publish them on the SAME bus (no second
  // stream/endpoint). Consumers (S1b) demux by `kind:"stream"`.
  try {
    streamInterp.interpret(evt);
  } catch (e) {
    console.warn("[stream-interp] interpret failed:", e?.message ?? e);
  }
  // Track per-session busy state for the defer-until-idle queue shared by all
  // prompt senders (schedule, capability, peer, webhook). Cheap, runs for
  // every event; never throws into the pump.
  try {
    promptDelivery.observeEvent(evt);
  } catch (e) {
    console.warn("[promptDelivery] observeEvent failed:", e?.message ?? e);
  }
  try {
    webhookEngine.observeEvent(evt);
  } catch (e) {
    console.warn("[webhook] observeEvent failed:", e?.message ?? e);
  }
  try {
    delegateEngine.observeEvent(evt);
  } catch (e) {
    console.warn("[delegate] observeEvent failed:", e?.message ?? e);
  }
  try {
    usageStopEngine.observeEvent(evt);
  } catch (e) {
    console.warn("[usage-stop] observeEvent failed:", e?.message ?? e);
  }
  // Resume engine outcome watching: a refused "Keep going" re-queues (or is
  // flagged at the cap); an idle/step without a refusal clears the record.
  try {
    resumeEngine.observeEvent(evt);
  } catch (e) {
    console.warn("[usage-resume] observeEvent failed:", e?.message ?? e);
  }
  // Auto-recover expired Claude credentials (server-side; works with no client attached).
  oc.maybeRecoverCredentials(evt).catch(() => {});
  if (evt && evt.type === "permission.asked") {
    (async () => {
      try {
        const cfg = await local.configGet();
        if (cfg.chatAutoAllow) {
          const permId = evt.properties?.id;
          // Scope the reply to the permission's session directory. Without
          // this the unscoped reply 404s (PermissionNotFoundError) — the
          // exact failure seen in the manta-server logs — so trust-mode
          // auto-allow never actually allowed the tool and the turn hung.
          const permSessionId = evt.properties?.sessionID;
          if (permId) {
            try {
              await oc.replyPermission({
                requestId: permId,
                reply: "always",
                sessionId: permSessionId,
              });
            } catch (e) {
              console.warn("[opencode-pump] auto-allow failed:", e?.message ?? e);
              // Fall back: forward the event so the user can approve manually.
              bus.publish({ kind: "opencode", payload: evt });
            }
            // Suppress: don't publish when auto-allow succeeded (mirrors desktop continue).
            // No push either — there's nothing for the user to act on.
            return;
          }
        }
      } catch (e) {
        console.warn("[opencode-pump] trust-mode config read failed:", e?.message ?? e);
        // Fall back: forward the event so the user can approve manually.
      }
      // chatAutoAllow is false, or permId was missing, or configGet threw — publish normally.
      bus.publish({ kind: "opencode", payload: evt });
      // The user must approve manually → notify (best-effort, never throws).
      push.firePush(evt);
    })().catch((e) => {
      console.warn("[opencode-pump] unexpected error:", e?.message ?? e);
    });
    return;
  }
  bus.publish({ kind: "opencode", payload: evt });
  // Notify on question/error/done (and track busy→idle). firePush decides
  // what (if anything) to send; permission.asked is handled in the branch
  // above so it isn't double-fired here.
  push.firePush(evt);
}, {
  eagerDirectories: () => eagerChatDirs,
});

const PORT = Number(process.env.MANTA_MOBILE_PORT ?? 8787);
const HOST = process.env.MANTA_MOBILE_HOST ?? "0.0.0.0";
const TAILNET_HOST = process.env.MANTA_TAILNET_HOST ?? "";

// ---------- static file serving ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webmanifest": "application/manifest+json",
};

async function serveFile(res, filePath, fallbackStatus = 404) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error("not a file");
    const data = await readFile(filePath);
    const ext = extname(filePath);
    // HTML entry point + manifest are unhashed and must NEVER be cached, or an
    // installed iOS PWA keeps booting a stale bundle that references old asset
    // hashes — features land server-side but the phone never sees them.
    // `no-cache` only forces revalidation, and with no ETag/Last-Modified the
    // WKWebView sometimes serves its snapshot anyway; `no-store` is the
    // belt-and-suspenders that guarantees a fresh fetch on every launch.
    // sw.js is also unhashed AND its updates must propagate immediately —
    // Cloudflare otherwise edge-caches .js for hours, delaying SW updates.
    // Vite's JS/CSS are content-hashed (immutable), so they stay cacheable.
    const base = filePath.split("/").pop() ?? "";
    const noStore =
      ext === ".html" || ext === ".webmanifest" || base === "sw.js";
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": noStore
        ? "no-store, must-revalidate"
        : "no-cache",
      "content-length": data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(fallbackStatus, { "content-type": "text/plain" });
    res.end(fallbackStatus === 404 ? "not found" : "error");
  }
}

function safeJoin(root, sub) {
  const target = normalize(join(root, sub));
  if (!target.startsWith(root)) return null; // path traversal guard
  return target;
}

// Drain a request body into a single Buffer, capped at `limit` bytes. Shared
// by every body reader below (single source of truth for the read-up-to-N /
// reject + destroy on overflow loop). On overflow it rejects with "body too
// large" and destroys the request so the excess bytes aren't buffered and the
// connection is freed.
function readBodyChunks(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Read a request body, capped at 64KB (push subscriptions are ~1KB; the cap
// guards against a runaway/hostile body).
//   parse=true  → JSON.parse the bytes (the common path for /api/* POSTs).
//   parse=false → return the EXACT UTF-8 string (webhook delivery needs the
//                 raw bytes to recompute the HMAC; parsing + re-serializing
//                 would change whitespace).
function readBody(req, { parse = true, limit = 64 * 1024 } = {}) {
  return readBodyChunks(req, limit).then((buf) => {
    const raw = buf.toString("utf-8");
    if (!parse) return raw;
    const trimmed = raw.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed);
  });
}

// JSON-parse variant. Thin shim kept for the /api/* call sites so each one
// reads as `await readJsonBody(req)` instead of `await readBody(req, { parse: true })`.
const readJsonBody = (req, limit) => readBody(req, { parse: true, limit });
// Raw-bytes variant for webhook HMAC. Thin shim — see `readBody` for why we
// need exact bytes (parsing + re-serializing would change whitespace).
const readRawBody = (req, limit) => readBody(req, { parse: false, limit });

// Raw BINARY body for octet-stream uploads (voice audio). Returns the exact
// Buffer via readBodyChunks. Unlike readBody its parse:false path coerces to a
// UTF-8 string, which would mangle audio bytes — so it keeps its own Buffer
// contract. Capped so a hostile/runaway body can't OOM the box; 16 MB
// comfortably covers a 5-minute opus/webm clip.
function readRawBuffer(req, limit = 16 * 1024 * 1024) {
  return readBodyChunks(req, limit);
}

// ---------- tiny HTTP helpers ----------
//
// respondJson — write a JSON response (the most common response shape in this
// file). Pulling it out eliminates verbatim writeHead+end boilerplate that
// the duplication-gate flagged across JSON-shaped handlers — every
// JSON-shaped handler in this file now goes through here. Status code +
// body shape stay identical to the inline versions they replace.
//
// requireLoopback — gate a handler on the loopback-direct check (currently
// used by /auth/pair). Returns true (proceed) when the request is
// loopback-direct; on a non-loopback caller it writes the standard 403 and
// returns false, so the caller MUST `return` immediately. The error message
// is passed in so each endpoint can phrase the rejection for its own
// surface. The check itself is unchanged (isLocalDirectRequest in auth.mjs)
// — this is a pure refactor, the loopback gate's semantics are preserved
// bit-for-bit.
function respondJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// /api/peek handler with the real route logic in src/server/peek.mjs (tested
// directly in peek.test.mjs — no mock). Injected with the real fs/homedir.
const peekHandler = createPeekHandler({
  homedir,
  stat,
  createReadStream,
  pipeline,
  MIME,
});

function requireLoopback(req, res, errorMessage) {
  if (
    isLocalDirectRequest({
      remoteAddress: req.socket?.remoteAddress,
      headers: req.headers,
    })
  ) {
    return true;
  }
  respondJson(res, 403, { error: errorMessage });
  return false;
}

// ---------- uploads ----------
//
// Layout: ~/.manta-uploads/<session>/<ts>/<file>. A server-side poller
// (`startUploadCleanupPoller` above, src/server/uploads.mjs) sweeps this dir
// hourly, deleting batch dirs older than `uploadCleanupHours` (box config,
// default 24, 0 disables) and pruning empty session dirs. Client sends one
// request per file with raw bytes; filename + batch id come in headers. No
// multipart parser.

const UPLOAD_ROOT = uploadRoot();
// Agent → device download root. The mobile mirror of the desktop outbox pull:
// the device fetches a server-local file the AI dropped here. Constrained to
// this dir so a crafted ?path= can't read arbitrary files off the box.
const OUTBOX_ROOT = outboxRoot();
const SESSION_RE = /^[A-Za-z0-9._-]+$/;
const BATCH_RE = /^[0-9]{6,20}$/;

function safeBasename(name) {
  // Strip path separators and control chars; collapse oddballs to "_".
  let n = String(name).replace(/[\x00-\x1f\\/:*?"<>|]/g, "_");
  if (n === "." || n === "..") n = "file";
  if (!n) n = "file";
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

async function handleUpload(req, res, url) {
  const session = url.searchParams.get("session");
  if (!session || !SESSION_RE.test(session)) {
    respondJson(res, 400, { error: "bad session" });
    return;
  }
  const rawName = req.headers["x-filename"];
  if (typeof rawName !== "string" || !rawName) {
    respondJson(res, 400, { error: "missing X-Filename" });
    return;
  }
  let decoded;
  try { decoded = decodeURIComponent(rawName); } catch { decoded = rawName; }
  const filename = safeBasename(decoded);

  const batchHeader = req.headers["x-batch-id"];
  const batch = typeof batchHeader === "string" && BATCH_RE.test(batchHeader)
    ? batchHeader
    : String(Date.now());

  const dir = join(UPLOAD_ROOT, session, batch);
  const target = join(dir, filename);

  try {
    await mkdir(dir, { recursive: true });
    await pipeline(req, createWriteStream(target));
  } catch (e) {
    respondJson(res, 500, { error: String(e?.message ?? e) });
    return;
  }
  respondJson(res, 200, { path: target });
}

// Agent → device download: stream a file from ~/.manta-outbox/ back to the
// device as a browser download. Path-traversal guarded — the resolved path
// must stay inside OUTBOX_ROOT. NON-destructive: the source is left in place;
// the artifact's lifetime is its TTL, swept by `expireArtifacts`, not by a
// download. Re-download is always allowed until then.
async function handleDownload(req, res, url) {
  const raw = url.searchParams.get("path") ?? "";
  const resolved = resolve(raw);
  if (resolved !== OUTBOX_ROOT && !resolved.startsWith(OUTBOX_ROOT + "/")) {
    respondJson(res, 403, { error: "path outside outbox" });
    return;
  }
  try {
    const st = await stat(resolved);
    if (!st.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(st.size),
      "content-disposition": `attachment; filename="${basename(resolved).replace(/"/g, "")}"`,
    });
    await pipeline(createReadStream(resolved), res);
  } catch (e) {
    if (!res.headersSent) {
      respondJson(res, 404, { error: String(e?.message ?? e) });
    } else {
      res.destroy();
    }
  }
}

// ---------- voice notes (BET-834) ----------
//
// POST /api/voice?session=<opencodeSessionId>
//   Raw audio bytes (application/octet-stream) + headers x-mime, x-duration-ms,
//   x-peaks (base64). Server writes the file then transcribes in one round
//   trip — the client must not upload and transcribe separately. Then stores
//   the note and replies { id, transcript, durationMs, expiresAt }.
//
// GET /api/voice/<id>
//   Streams the audio with the record's mime + Cache-Control: private.
//   404 when unknown / expired / file gone (file-gone prunes the record).
//
// POST /api/voice/<id>/retry
//   Re-runs transcription for a record whose transcript is empty.
//   404 unknown/expired, 409 if the retry fails again.
async function handleVoiceUpload(req, res, url) {
  const sessionId = url.searchParams.get("session");
  let bytes;
  try {
    bytes = await readRawBuffer(req);
  } catch {
    return respondJson(res, 413, { error: "audio body too large" });
  }
  const cfg = await local.configGet();
  const mime = typeof req.headers["x-mime"] === "string" ? req.headers["x-mime"] : "audio/webm";
  const durationMs = Number(req.headers["x-duration-ms"] ?? 0) || 0;
  const peaks = typeof req.headers["x-peaks"] === "string" ? req.headers["x-peaks"] : "";
  const result = await uploadVoiceNote(
    {
      sessionId,
      mime,
      durationMs,
      peaks,
      bytes,
      ttlHours: cfg.voiceNoteTtlHours ?? undefined,
      apiKey: cfg.groqApiKey,
      model: cfg.voiceTranscriptionModel,
    },
  );
  if (!result.ok) {
    const body = result.status === 409 ? { error: result.error, id: result.record?.id } : { error: result.error };
    return respondJson(res, result.status, body);
  }
  const { record } = result;
  return respondJson(res, 200, {
    id: record.id,
    transcript: record.transcript,
    durationMs: record.durationMs,
    expiresAt: record.expiresAt,
  });
}

async function handleVoicePlayback(req, res, id) {
  const playback = await resolvePlayback(id);
  if (!playback.ok) return respondJson(res, playback.status, { error: "not found" });
  res.writeHead(200, {
    "content-type": playback.note.mime || "audio/webm",
    "content-length": String(playback.bytes.length),
    "cache-control": "private, max-age=3600",
  });
  res.end(playback.bytes);
}

async function handleVoiceRetry(req, res, id) {
  const cfg = await local.configGet();
  const result = await retryTranscript(id, {
    apiKey: cfg.groqApiKey,
    model: cfg.voiceTranscriptionModel,
  });
  if (!result.ok) {
    return respondJson(res, result.status, { error: result.error });
  }
  return respondJson(res, 200, { id, transcript: result.transcript });
}

// ---------- HTTP ----------

const handleRequest = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // The Capacitor shell loads from http://localhost and calls this server
  // cross-origin. Allow any origin (the server is the user's own box) and
  // answer CORS preflight so the mobile WebView's fetch() isn't blocked.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // `*` covers every custom header a client sends (x-filename on uploads;
  // x-mime / x-duration-ms / x-peaks on voice notes) so this can never drift
  // behind a new route again. `Authorization` is NOT covered by the wildcard
  // per the Fetch spec and must stay listed by name. The wildcard is only
  // honoured for non-credentialed requests — every client here sends the box
  // token in an Authorization header, never a cookie.
  res.setHeader("Access-Control-Allow-Headers", "*, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // ---------- Auth pairing handshake (UNAUTHENTICATED, rate-limited) ----------
  // GET    /auth/pair            → {pairing_code, box_id, expiresAt}
  //                                Mint a one-time, ~5-min code. The desktop
  //                                shows it (and encodes box_id+code in a QR
  //                                for mobile).
  // POST   /auth/claim {pairing_code, device_id?, name?} → {box_token, box_id, device_id}
  //                                Exchange a valid code for a device credential.
  //                                One-time; 403 on wrong/expired/reused code.
  //                                A claim carrying `device_id` OR `name`
  //                                provisions/resumes a DISTINCT device; a bare
  //                                claim → legacy primary token. A stray
  //                                `verify` field is ignored (unread).
  // POST   /auth/check {pairing_code} → {box_id}
  //                                NON-consuming validation for the /pair web
  //                                page; the code stays claimable (BET-699).
  // DELETE /auth/revoke           → 200 on success; 400/401 on bad token.
  //                                "Remove this box from the device that holds
  //                                the current box_token" (BET-357 §2). Mints
  //                                a fresh identity and clears the pairing
  //                                cache so the next device must pair again.
  // These are the ONLY pre-token surface, so they're the brute-force target and
  // are throttled by a shared token-bucket limiter (per client IP). See auth.mjs.
  if (
    path === "/auth/pair" ||
    path === "/auth/claim" ||
    path === "/auth/check" ||
    path === "/auth/revoke"
  ) {
    const ip =
      (typeof req.headers["x-forwarded-for"] === "string" &&
        req.headers["x-forwarded-for"].split(",")[0].trim()) ||
      req.socket?.remoteAddress ||
      "unknown";
    if (!authRateLimit(ip)) {
      respondJson(res, 429, { error: "rate limited" });
      return;
    }
    try {
      if (req.method === "GET" && path === "/auth/pair") {
        // Minting a code is LOCAL-ONLY (the `manta pair` CLI / SSH forward).
        // Remote-reachable minting would let anyone claim the box_token in two
        // requests. Loopback alone is insufficient — cloudflared proxies public
        // traffic from 127.0.0.1 — so also reject proxy-injected forwarding
        // headers. See isLocalDirectRequest in auth.mjs (reused via
        // requireLoopback below).
        if (
          !requireLoopback(
            req,
            res,
            "pairing codes can only be minted from the server itself (run `manta pair` locally)",
          )
        ) {
          return;
        }
        const result = authEngine.pair();
        respondJson(res, 200, {
          pairing_code: result.pairing_code,
          box_id: result.box_id,
          expiresAt: result.expiresAt,
        });
        return;
      }
      if (req.method === "POST" && path === "/auth/claim") {
        const body = await readJsonBody(req);
        // Accept both `pairing_code` and the shorter `code` spelling emitted
        // by the mobile QR / deep-link payload — coalesce so both work.
        const pairing_code = body?.pairing_code ?? body?.code;
        // Optional per-device identity (BET-490): a client that already holds
        // a device_id resumes its entry (same distinct token) instead of
        // minting a new device. A claim with no device_id returns the shared
        // primary box_token exactly as before (back-compat).
        const device_id = body?.device_id ?? body?.deviceId ?? null;
        const name = body?.name ?? null;
        // A stray `verify` field (old clients) is intentionally not read — the
        // claim keys on device_id/name instead (see authEngine.claim).
        const result = authEngine.claim({ pairing_code, device_id, name });
        if (!result.ok) {
          respondJson(res, result.status ?? 400, { error: result.error });
          return;
        }
        respondJson(res, 200, {
          box_token: result.box_token,
          box_id: result.box_id,
          device_id: result.device_id ?? null,
        });
        return;
      }
      if (req.method === "POST" && path === "/auth/check") {
        const body = await readJsonBody(req);
        const pairing_code = body?.pairing_code ?? body?.code;
        const result = authEngine.check({ pairing_code });
        if (!result.ok) {
          respondJson(res, result.status ?? 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { box_id: result.box_id });
        return;
      }
      if (req.method === "DELETE" && path === "/auth/revoke") {
        // Manual auth check (this route is exempt from the standard gate so
        // we can distinguish malformed-token → 400 from missing-token → 401;
        // the gate collapses both into 401). The shape of the response is
        // whatever authEngine.revoke returns: { ok, status?, error? }.
        // BET-490: `device_id` targets ONE device for per-device revoke;
        // absent → legacy whole-box reset.
        const token = parseBearer(req.headers["authorization"]);
        const q = Object.fromEntries(url.searchParams);
        const result = await authEngine.revoke({
          token,
          device_id: q.device_id ?? q.deviceId ?? null,
        });
        if (!result.ok) {
          respondJson(res, result.status ?? 401, { error: result.error });
          return;
        }
        respondJson(res, 200, {
          ok: true,
          box_id: result.box_id,
          device_id: result.device_id ?? null,
          reset: !!result.reset,
        });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // GET /pair* — box-served onboarding page (auth-exempt like /auth/claim:
  // it IS the pairing entry point, and the code travels in the URL fragment
  // which never reaches the server). See pairPage.mjs.
  if (req.method === "GET" && path === "/pair") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(readPairAsset("pair.html"));
    return;
  }
  if (req.method === "GET" && path === "/pair/logo.png") {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(readPairAsset("pair-logo.png"));
    return;
  }
  if (req.method === "GET" && path === "/pair/qr.png") {
    const query = Object.fromEntries(url.searchParams);
    const v = validatePairQrQuery(query);
    if (!v.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: v.error }));
      return;
    }
    const png = await renderPairQr(v.payload);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    });
    res.end(png);
    return;
  }

  // ---------- Hosted pages (PUBLIC, sandboxed) ----------
  // GET /pages/<sub>  or  GET /pages/<sub>/   — one index.html per page.
  // Pages share an origin with the SPA, so the response headers (sandbox CSP
  // without allow-same-origin) put the document in an opaque origin: its
  // scripts can't read localStorage or send credentialed same-origin requests
  // and therefore can't reach the box_token. The route is auth-exempt (see
  // isExemptPath) — a visitor by definition holds no token. See
  // src/server/servePage.mjs.
  if (req.method === "GET" && path.startsWith("/pages/")) {
    const sub = path.slice("/pages/".length).replace(/\/+$/, "");
    if (!sub || sub.includes("/") || !isValidSubdomain(sub)) {
      respondJson(res, 404, { error: "not found" });
      return;
    }
    const result = await readPage(sub);
    if (!result.ok) {
      respondJson(res, 404, { error: `page "${sub}" not found` });
      return;
    }
    res.writeHead(200, pageResponseHeaders());
    res.end(result.html);
    return;
  }

  // ---------- Auth gate ----------
  // Every route below this line requires a valid box_token, EXCEPT the public
  // webhook delivery leg (/hook/<token>, self-authenticated via its own
  // token+HMAC). /auth/* handled above; OPTIONS handled above. When the gate is
  // disabled (MANTA_AUTH_DISABLED=1) authorize() allows everything.
  {
    // The HTTP /events route can also be consumed as an EventSource (SSE) by a
    // non-WS client, which likewise can't set an Authorization header — so honor
    // the ?token= fallback here too, scoped to /events ONLY. Every other
    // route ignores ?token= and still requires a real Bearer header.
    const gate = authEngine.authorize({
      method: req.method,
      path,
      authorization: authorizationForRequest(
        path,
        req.headers["authorization"],
        url.searchParams.get("token"),
      ),
    });
    if (!gate.ok) {
      res.writeHead(gate.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: gate.error }));
      return;
    }
  }

  // ---------- Auth status (AUTHENTICATED) ----------
  // GET /auth/status → {authenticated:true, box_id, enforced}
  // Reaching here means the gate already passed, so the caller is authenticated
  // (or the gate is disabled). Lets a paired client confirm its token still works.
  if (req.method === "GET" && path === "/auth/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        authenticated: true,
        box_id: authEngine.box_id,
        enforced: authEngine.enforce,
      }),
    );
    return;
  }

  // ---------- Linked-device list (AUTHENTICATED) ----------
  // GET /auth/devices → { box_id, devices: [{device_id, name, last_seen, created_at, primary}] }
  // Reaching here means the gate passed, so the caller holds a live device
  // token. Serves §6.3's linked-device list (with last_seen) so the desktop
  // (Stage 5) and any paired device can render the alert + revoke one-tap.
  // NEVER exposes tokens — only per-device public metadata.
  if (req.method === "GET" && path === "/auth/devices") {
    respondJson(res, 200, { box_id: authEngine.box_id, devices: authEngine.listDevices() });
    return;
  }

  // ---------- Server version (AUTHENTICATED) ----------
  // GET /api/version → { version }
  //
  // Returns the repo's package.json version (read once at startup above, held
  // in `SERVER_VERSION` so per-request IO never happens). The renderer hits
  // the SAME value via the `server:version` RPC channel (in-process, no HTTP
  // round-trip); this REST surface exists for curl / integration tests +
  // future non-renderer clients. Display-only foundation — the BET-181
  // gating / banner / force-update logic lives behind this once skew is
  // visible.
  if (req.method === "GET" && path === "/api/version") {
    writeVersionResponse(res, { version: SERVER_VERSION, opencodeVersion: OPENCODE_VERSION });
    return;
  }

  if (req.method === "GET" && path === "/events") {
    return handleEventsRequest(bus, req, res);
  }
  if (req.method === "POST" && path.startsWith("/rpc/")) {
    const channel = decodeURIComponent(path.slice("/rpc/".length));
    return handleRpcRequest(rpcHandlers, channel, req, res);
  }

  if (req.method === "GET" && path === "/api/projects") {
    try {
      const projects = await tmux.listProjects();
      respondJson(res, 200, projects);
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  if (req.method === "POST" && path === "/api/upload") {
    return handleUpload(req, res, url);
  }

  if (req.method === "GET" && path === "/api/download") {
    return handleDownload(req, res, url);
  }

  // ---------- Push a file as a workspace artifact (send_file tool) ----------
  // POST /api/outbox/push { filePath, sessionID, ttlHours?, messageID? }
  // Copies the AI-generated file into ~/.manta-outbox/<sessionID>/ so it shows
  // in the artifacts panel's Files tab (workspace-linked, TTL'd, not deleted
  // on download) and announces it via the outbox scanner's agentFile toast.
  // `messageID` stamps the calling opencode turn on the file so the Artifacts
  // panel's "Jump to message" works; absent/non-string values are ignored.
  if (req.method === "POST" && path === "/api/outbox/push") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return respondJson(res, 400, { error: "invalid JSON body" });
    }
    const result = await pushArtifact(body?.filePath, body?.sessionID, {
      ttlHours: body?.ttlHours,
      messageID:
        typeof body?.messageID === "string" && body.messageID.trim()
          ? body.messageID
          : undefined,
    });
    return result.ok
      ? respondJson(res, 200, { ok: true, row: result.row })
      : respondJson(res, 400, { error: result.error });
  }

  // ---------- Voice notes (BET-834) ----------
  // POST /api/voice?session=<sid>       — raw audio bytes → store + transcribe
  // GET  /api/voice/<id>                — stream the audio back
  // POST /api/voice/<id>/retry          — re-run transcription
  // The id segment is validated against /^[a-f0-9]{32}$/ by the regex BEFORE
  // touching the filesystem — that regex is the path-traversal guard.
  const voiceRoute = path.match(
    /^\/api\/voice(?:\/([a-f0-9]{32}))?(?:\/(retry))?$/,
  );
  if (voiceRoute) {
    const [, vId, vAction] = voiceRoute;
    if (req.method === "POST" && !vId) return handleVoiceUpload(req, res, url);
    if (!vId) return respondJson(res, 404, { error: "not found" });
    if (req.method === "GET" && !vAction) return handleVoicePlayback(req, res, vId);
    if (req.method === "POST" && vAction === "retry") return handleVoiceRetry(req, res, vId);
    return respondJson(res, 404, { error: "not found" });
  }

  // ---------- File peek (HTTP-mode desktop) ----------
  // GET /api/peek?path=<url-encoded-absolute-path>
  // Streams the file bytes back to the caller. The desktop main process
  // fetches this, writes to a temp file, and opens with shell.openPath.
  // Path is resolved against the caller's home dir (~ expansion) and
  // constrained to stay inside it (path-traversal guard). Content-Type is
  // inferred from the file extension; falls back to application/octet-stream.
  // Supports single byte ranges (206/416, `accept-ranges: bytes`); absent,
  // unparseable, or multi-range headers serve the whole file (200). The logic
  // lives in src/server/peek.mjs so it is tested directly, not via a mock.
  if ((req.method === "GET" || req.method === "HEAD") && path === "/api/peek") {
    await peekHandler(req, res, url);
    return;
  }

  // ---------- Scheduled prompts ----------
  // POST   /api/schedule        body {cron, prompt, recurring, label, sessionID,
  //                             directory} → {id, cron, recurring} (400 bad cron)
  // GET    /api/schedule?sessionID=  → {jobs:[...]} (filtered when sessionID set)
  // DELETE /api/schedule?id=     → {deleted:bool}
  // Created by the remote AI's global opencode `schedule` tool; listed/deleted
  // by the ScheduledTasksCard UI (via schedule:* window.api channels → rpc.mjs).
  // Store mutations publish a `schedule.updated` bus event so the card
  // refetches live.
  if (path === "/api/schedule") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await createJob(
          {
            cron: body?.cron,
            prompt: body?.prompt,
            recurring: body?.recurring,
            label: body?.label,
            sessionID: body?.sessionID,
            directory: body?.directory,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: result.job.id,
            cron: result.job.cron,
            recurring: result.job.recurring,
          }),
        );
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const jobs = await listJobs(sessionID);
        respondJson(res, 200, { jobs });
        return;
      }
      if (req.method === "DELETE") {
        await handleApiDelete(req, url, res, deleteJob);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Capability jobs (MantaUI plugin system, Layer 1) ----------
  // Generic queue for AI-invokable capabilities that run on the box OR on a
  // connected Mac (the plugin system). The transport envelope is
  // {capability, input, host} — no `iosBuild`-specific fields here. Created
  // by the AI's plugin tool (docs/opencode-tools/<plugin>.ts); claimed by an
  // executor (Stage 2: Mac, src/main/capExecutor.ts) via /start; streamed
  // logs via /log; completed via /done. Completion is injected back into the
  // originating opencode session via the SAME oc.sendPrompt leg the scheduler
  // uses — see docs/mantaui-plugins.md §Layer 1. All routes below are behind
  // the existing Bearer auth gate (/api/* is gated wholesale).
  if (path === "/api/cap" || /^\/api\/cap\/([0-9a-f]{8})(?:\/(start|log|done))?$/.test(path)) {
    // Detail routes: /api/cap/:id, /api/cap/:id/start, /api/cap/:id/log,
    // /api/cap/:id/done. Matched BEFORE the generic create/list block so the
    // regex captures the action verb. Id must be exactly 8 lowercase hex
    // characters (genId()).
    const detailRe = /^\/api\/cap\/([0-9a-f]{8})(?:\/(start|log|done))?$/;
    const detailMatch = path.match(detailRe);
    try {
      if (detailMatch) {
        const [, id, action] = detailMatch;
        if (action === "start") {
          if (req.method !== "POST") {
            respondJson(res, 405, { error: "method not allowed" });
            return;
          }
          const result = await startCapJob(id);
          if (!result.ok) {
            // Wrong status (already running, or terminal) → 409 conflict.
            respondJson(res, 409, { error: result.error, status: result.status });
            return;
          }
          respondJson(res, 200, { ok: true });
          return;
        }
        if (action === "log") {
          if (req.method !== "POST") {
            respondJson(res, 405, { error: "method not allowed" });
            return;
          }
          const body = await readJsonBody(req);
          const result = await appendCapLog(id, body?.chunk ?? "");
          if (!result.ok) {
            // Job missing OR not running (e.g. timed out and already failed)
            // → 409. The executor must NOT be allowed to resurrect a
            // timed-out job by appending a late log chunk.
            respondJson(res, 409, { error: result.error, status: result.status });
            return;
          }
          respondJson(res, 200, { ok: true });
          return;
        }
        if (action === "done") {
          if (req.method !== "POST") {
            respondJson(res, 405, { error: "method not allowed" });
            return;
          }
          const body = await readJsonBody(req);
          const result = await completeCapJob(
            id,
            { status: body?.status, result: body?.result, error: body?.error },
            {
              ...BUS_PUBLISH_DEPS,
              notifySession: capNotify,
            },
          );
          if (!result.ok) {
            respondJson(res, 400, { error: result.error, status: result.status });
            return;
          }
          respondJson(res, 200, { ok: true, alreadyTerminal: !!result.alreadyTerminal });
          return;
        }
        // No action verb → GET /api/cap/:id → status + log tail.
        if (req.method !== "GET") {
          respondJson(res, 405, { error: "method not allowed" });
          return;
        }
        const job = await getJob(id);
        if (!job) {
          respondJson(res, 404, { error: "not found" });
          return;
        }
        respondJson(res, 200, job);
        return;
      }
      // Collection routes (/api/cap): create + list.
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await createCapJob(
          {
            capability: body?.capability,
            input: body?.input,
            host: body?.host,
            sessionID: body?.sessionID,
            directory: body?.directory,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { id: result.job.id });
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const host = url.searchParams.get("host") || undefined;
        const status = url.searchParams.get("status") || undefined;
        const jobs = await listCapJobs({ sessionID, host, status });
        respondJson(res, 200, { jobs });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Background jobs (BET-378, server-side only) ----------
  // POST   /api/delegate           body {prompt, model?, sessionID, directory, tools?}
  //                               → 200 {ok, job} (400 refused: cap/nesting/bad input; 202 pending approval)
  // GET    /api/delegate?sessionID= → {jobs:[...]} (jobs for that parent session)
  // POST   /api/delegate/:id/stop  → 200 {ok} (409 not running / 404 not found)
  // DELETE /api/delegate/:id       → 200 {ok} (409 dirty worktree → {error:"dirty"})
  // GET    /api/delegate/approvals?sessionID= → pending pre-flight approvals (BET-418 §A)
  // POST   /api/delegate/approve/:id  body {tools?} → 200 {ok} (approve + start the job)
  // POST   /api/delegate/decline/:id             → 200 {ok} (decline; the delegate call returns declined)
  //
  // Behind the existing Bearer auth gate (every route below the gate is
  // gated wholesale). Jobs are created by the AI tool (Stage 3) — there is
  // deliberately no `delegate:create` RPC channel; the UI only lists/stops/
  // deletes via the delegate:* channels in rpc.mjs.
  if (
    path === "/api/delegate" ||
    path === "/api/delegate/approvals" ||
    /^\/api\/delegate\/approve\/([0-9a-f]{8})$/.test(path) ||
    /^\/api\/delegate\/decline\/([0-9a-f]{8})$/.test(path) ||
    /^\/api\/delegate\/([0-9a-f]{8})(?:\/(stop))?$/.test(path)
  ) {
    const detailRe = /^\/api\/delegate\/([0-9a-f]{8})(?:\/(stop))?$/;
    const detailMatch = path.match(detailRe);
    const approveMatch = path.match(/^\/api\/delegate\/approve\/([0-9a-f]{8})$/);
    const declineMatch = path.match(/^\/api\/delegate\/decline\/([0-9a-f]{8})$/);
    try {
      if (approveMatch) {
        if (req.method !== "POST") {
          respondJson(res, 405, { error: "method not allowed" });
          return;
        }
        const body = await readJsonBody(req);
        const ok = delegateEngine.approve(approveMatch[1], body?.tools);
        respondJson(res, 200, { ok });
        return;
      }
      if (declineMatch) {
        if (req.method !== "POST") {
          respondJson(res, 405, { error: "method not allowed" });
          return;
        }
        const ok = delegateEngine.decline(declineMatch[1]);
        respondJson(res, 200, { ok });
        return;
      }
      if (path === "/api/delegate/approvals") {
        if (req.method !== "GET") {
          respondJson(res, 405, { error: "method not allowed" });
          return;
        }
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const approvals = delegateEngine.listPendingApprovals(sessionID);
        respondJson(res, 200, { approvals });
        return;
      }
      if (detailMatch) {
        const [, id, action] = detailMatch;
        if (action === "stop") {
          if (req.method !== "POST") {
            respondJson(res, 405, { error: "method not allowed" });
            return;
          }
          const result = await delegateEngine.stopJob(id);
          if (!result.ok) {
            respondJson(res, 409, { error: result.error, status: result.status });
            return;
          }
          respondJson(res, 200, { ok: true });
          return;
        }
        // No action verb, DELETE /api/delegate/:id → delete the job.
        if (req.method !== "DELETE") {
          respondJson(res, 405, { error: "method not allowed" });
          return;
        }
        const result = await delegateEngine.deleteJob(id);
        if (!result.ok) {
          // Dirty worktree → keep worktree + record; 409 so the UI explains it.
          respondJson(res, 409, { error: result.error, reason: result.reason });
          return;
        }
        respondJson(res, 200, { ok: true });
        return;
      }
      // Collection routes (/api/delegate): create + list.
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        // BET-418 §A: trust mode (chatAutoAllow) skips the approval card.
        const cfg = await local.configGet();
        const trustMode = !!cfg?.chatAutoAllow;
        const result = await delegateEngine.startJobWithApproval({
          prompt: body?.prompt,
          model: body?.model,
          parentSessionID: body?.sessionID,
          parentDirectory: body?.directory,
          tools: body?.tools,
          trustMode,
        });
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { ok: true, id: result.job.id, job: result.job });
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const jobs = await delegateEngine.listJobs({ sessionID });
        respondJson(res, 200, { jobs });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Plugin registry (BET-189 / BET-190) ----------
  // PUT  /api/plugins/registry  body: PluginRegistryRow[]  → 200 {count}
  // GET  /api/plugins/registry                          → 200 {rows:[...]}
  //
  // Published by the Mac executor (src/main/capExecutor.ts) on every SSE
  // (re)connect + on every fs.watch burst over ~/.manta/plugins/. The
  // renderer reads the same registry via GET to render the installed-
  // plugins list in Settings → Plugins. Invalid manifests are accepted
  // and surfaced in the response (`valid: false` rows with an `error`
  // string) so the user can SEE why their YAML didn't load — a 500 here
  // would just leave the UI silently empty.
  if (path === "/api/plugins/registry") {
    try {
      if (req.method === "PUT") {
        // NOT the default 64KB cap. This body carries the FULL YAML of
        // EVERY installed manifest, so it scales with plugin count (~7.5KB
        // per row in practice) — 64KB silently capped the registry at ~8
        // plugins. Worse, exceeding a readBody limit destroys the socket,
        // so the executor's PUT failed as a network error it could not see
        // and the registry FROZE at the last payload that happened to fit
        // (real incident: adding a 9th plugin stopped every subsequent
        // publish, and both sides logged nothing). 2MB ≈ 260 plugins; the
        // route is Bearer-authenticated, so this is a sizing bound, not a
        // trust boundary.
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        const size = pluginsPutRegistry(body);
        respondJson(res, 200, { count: size });
        return;
      }
      if (req.method === "GET") {
        const rows = pluginsGetRegistry();
        respondJson(res, 200, { rows });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Plugin authoring docs (BET-189 / BET-191) ----------
  // GET /api/plugins/docs → 200 {docs:"<markdown>"} from docs/plugins-authoring.md
  //
  // Surfaced to the AI through plugin_docs() (docs/opencode-tools/plugins.ts)
  // so the authoring guide is always reachable from inside a chat session.
  // The file is resolved RELATIVE TO THE SERVER MODULE'S DIR (PROJECT_ROOT
  // — derived from `__dirname`), NEVER `process.cwd()`. The server may be
  // launched from anywhere; cwd is untrustworthy. If the file is missing
  // the route 500s with a clear error — a silent 404 would let the AI think
  // the docs are empty.
  if (path === "/api/plugins/docs") {
    try {
      if (req.method !== "GET") {
        respondJson(res, 405, { error: "method not allowed" });
        return;
      }
      const docsPath = join(PROJECT_ROOT, "docs", "plugins-authoring.md");
      const text = await readFile(docsPath, "utf-8");
      respondJson(res, 200, { docs: text });
    } catch (e) {
      respondJson(
        res,
        500,
        { error: `failed to read docs/plugins-authoring.md: ${String(e?.message ?? e)}` },
      );
    }
    return;
  }

  // ---------- Forge rules (BET-797) ----------
  // POST   /api/forge-rules        body {repo, yaml} → {ok, webhook?} on valid,
  //                               {ok:false, errors:[{path,message}...]} (nothing written)
  //                               on a validation failure; {ok:false, error} when disabled
  //                               or the repo identity is unsafe.
  // GET    /api/forge-rules?repo=  → {yaml} for one repo | {error:"not found"}
  // GET    /api/forge-rules        → {rules:[{repoKey, valid, error?, yaml}]} — includes
  //                               INVALID rule files with their reason (a rules file that
  //                               silently fails to load is worse than one that loudly refuses).
  // GET    /api/forge-rules/docs   → {docs:"<markdown>"} from docs/forge-rules-authoring.md
  //
  // Driven by the forge_rules opencode tool (docs/opencode-tools/forge-rules.ts). The
  // store lives on the box (~/.manta/forge-rules/) and is gated by the global
  // AppConfig.forgeRulesEnabled toggle — with it off, no registration, no ingest
  // routing, no dispatch.
  if (path === "/api/forge-rules") {
    try {
      const cfg = await local.configGet();
      const enabled = cfg?.forgeRulesEnabled === true;
      if (req.method === "POST") {
        if (!enabled) {
          respondJson(res, 403, { error: "forge rules are disabled" });
          return;
        }
        const body = await readJsonBody(req);
        const res2 = await forgeSaveRules(
          { repo: body?.repo, yaml: body?.yaml },
          { enabled: () => cfg?.forgeRulesEnabled === true },
        );
        if (res2.ok !== true) {
          if (res2.errors) {
            respondJson(res, 400, { errors: res2.errors });
          } else {
            respondJson(res, 400, { error: res2.error ?? "invalid rules" });
          }
          return;
        }
        respondJson(res, 200, { ok: true, repo: res2.repoKey, webhook: res2.webhook });
        return;
      }
      if (req.method === "GET") {
        const repo = url.searchParams.get("repo");
        if (repo) {
          const g = await forgeGetRules(repo);
          if (g.ok) respondJson(res, 200, { repo, yaml: g.yaml });
          else respondJson(res, 404, { error: g.error ?? "not found" });
          return;
        }
        const rules = await forgeListRules();
        respondJson(res, 200, { rules });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // GET /api/forge-rules/docs — the authoring guide, resolved relative to the
  // server module dir (PROJECT_ROOT), never process.cwd().
  if (path === "/api/forge-rules/docs") {
    try {
      if (req.method !== "GET") {
        respondJson(res, 405, { error: "method not allowed" });
        return;
      }
      const docsPath = join(PROJECT_ROOT, "docs", "forge-rules-authoring.md");
      const text = await readFile(docsPath, "utf-8");
      respondJson(res, 200, { docs: text });
    } catch (e) {
      respondJson(
        res,
        500,
        { error: `failed to read docs/forge-rules-authoring.md: ${String(e?.message ?? e)}` },
      );
    }
    return;
  }

  // ---------- Inbound webhooks (management) ----------
  // POST   /api/webhook        body {label, instructions, sessionID, directory,
  //                            unsigned?} → {id, url, secret} (secret returned ONCE)
  // GET    /api/webhook?sessionID=  → {hooks:[meta...]} (secret + token stripped)
  // DELETE /api/webhook?id=    → {deleted:bool}
  // Created by the remote AI's global opencode `webhook` tool; listed/deleted by
  // the WebhooksCard UI (webhook:* window.api channels → rpc.mjs). The PUBLIC
  // delivery route is POST /hook/<token> (separate, below). Store mutations
  // publish a `webhook.updated` bus event so the card refetches live.
  if (path === "/api/webhook") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await createHook(
          {
            label: body?.label,
            instructions: body?.instructions,
            sessionID: body?.sessionID,
            directory: body?.directory,
            unsigned: body?.unsigned,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ id: result.hook.id, url: result.url, secret: result.secret }),
        );
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const hooks = await listHooks(sessionID);
        respondJson(res, 200, { hooks });
        return;
      }
      if (req.method === "DELETE") {
        await handleApiDelete(req, url, res, deleteHook);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Inbound webhook delivery (PUBLIC) ----------
  // POST /hook/<token>  — the ONLY externally-reachable manta route. The raw body
  // is read verbatim (HMAC needs the exact bytes); the engine resolves the
  // token, rate-limits, verifies the signature (unless the hook is unsigned),
  // and wakes the session (or defers until idle if it's busy). Status codes:
  // 200 delivered · 202 queued · 400 bad body · 401 bad sig · 404 unknown ·
  // 429 rate-limited. See src/server/webhooks.mjs.
  if (path.startsWith("/hook/")) {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "method not allowed" });
      return;
    }
    const token = path.slice("/hook/".length);
    try {
      const rawBody = await readRawBody(req);
      // Pass the raw headers so a forge hook can verify via
      // X-Hub-Signature-256 (GitHub) as well as X-Manta-Signature.
      const result = await webhookEngine.deliver({
        token,
        rawBody,
        headers: req.headers,
      });
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          result.ok ? { ok: true, queued: !!result.queued } : { error: result.error },
        ),
      );
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Serve page (web page hosting) ----------
  // POST   /api/serve-page        body {subdomain, filePath, ttlHours, sessionID}
  //                             → {ok, url, subdomain, expiresAt} (400 bad request)
  // GET    /api/serve-page        → {pages:[{subdomain, url, expiresAt, ...}]}
  // DELETE /api/serve-page?subdomain= → {deleted:bool}
  // Created by the remote AI's global opencode `serve_page` tool. Source files
  // are copied into ~/.manta/pages/<subdomain>/index.html and served from
  // manta-server itself at GET /pages/<subdomain> under the box's own
  // published hostname. Pages expire after TTL (default 24h).
  if (path === "/api/serve-page") {
    try {
      const baseUrl = publicBaseUrl();
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await registerPage(
          {
            subdomain: body?.subdomain,
            filePath: body?.filePath,
            ttlHours: body?.ttlHours,
            sessionID: body?.sessionID,
          },
          { ...BUS_PUBLISH_DEPS, baseUrl },
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            url: result.url,
            subdomain: result.subdomain,
            expiresAt: result.expiresAt,
          }),
        );
        return;
      }
      if (req.method === "GET") {
        const pages = listPages({ baseUrl });
        respondJson(res, 200, { pages });
        return;
      }
      if (req.method === "DELETE") {
        const subdomain = url.searchParams.get("subdomain");
        if (!subdomain) {
          respondJson(res, 400, { error: "subdomain is required" });
          return;
        }
        const result = await unregisterPage(subdomain, BUS_PUBLISH_DEPS);
        respondJson(res, 200, { deleted: result.deleted });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Single-HTML plan publish (BET-987) ----------
  // POST /api/plan-render  body {sessionID, file}
  //                      → {ok:true, url}   (400 {ok:false, error} on failure)
  // Called by the remote manta-plan agent's `plan_render` tool. `file` is an
  // UNTRUSTED path to the authored plan HTML bundle; it is resolved against
  // the session directory and REJECTED if it escapes (same confinement as
  // readPlanMarkdown, but no `.md` requirement — the bundle is HTML). The
  // bundle is parsed + rendered (planDoc.mjs) and published through the
  // EXISTING serve-page subsystem under the stable `plan-<shortSessionId>`
  // subdomain with TTL 0 (never expires). The URL is whatever
  // publishPlanBundle / registerPage returns — never constructed here.
  if (path === "/api/plan-render") {
    try {
      const baseUrl = publicBaseUrl();
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const sessionID = body?.sessionID;
        const sessionDir = await oc.getSessionDirectory(sessionID);
        const ref = (loadAuthFile(DEFAULT_AUTH_PATH) ?? {}).box_id ?? "";
        const result = await publishPlanBundle(
          { sessionID, file: body?.file, sessionDir, ref },
          { ...BUS_PUBLISH_DEPS, baseUrl },
        );
        if (!result.ok) {
          respondJson(res, 400, { ok: false, error: result.error });
          return;
        }
        respondJson(res, 200, { ok: true, url: result.url });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
    return;
  }

  // POST /api/notify  body {message, title?, urgent?, sessionID}
  //                 → {ok:true}  (400 if message missing)
  // Created by the remote AI's global opencode `notify` tool. Runs through the
  // same cross-device router as opencode events (push.mjs fireNotify →
  // routeNotification): desktop OS notification and/or mobile Web Push, with
  // desktop-first escalation when away. See docs/manta-tools-notify.md.
  if (path === "/api/notify") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) {
          respondJson(res, 400, { error: "message is required" });
          return;
        }
        await push.fireNotify({
          message,
          title: typeof body?.title === "string" ? body.title : undefined,
          urgent: !!body?.urgent,
          sessionID: body?.sessionID,
        });
        respondJson(res, 200, { ok: true });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Progress (AI-triggered "where are we right now") ----------
  // POST /api/progress  body {sessionID, label?, step?, total?, state?,
  //                           detail?, sinks?} → {ok:true, record}
  //                 (400 invalid state/step/total, or missing sessionID)
  // Created by the remote AI's global opencode `progress_report` tool. A
  // durable, session-scoped status record (replace, never append) plus a
  // progress.updated bus event for the ui sink. No notification — progress is
  // ambient and costs nothing; `notify` is what takes a human's attention.
  // See src/server/progress.mjs. Behind the /api/* Bearer gate (no exemption).
  if (path === "/api/progress") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await reportProgress(body || {}, {
          publish: (evt) => bus.publish(evt),
          // BET-798: the forge + push progress sinks. `push` is fully wired;
          // `forge` resolves the job's own PR when one exists (the session-link
          // primitive that names the target is a later issue) and no-ops
          // otherwise — a sink failure never fails the report.
          sinks: {
            push: async ({ record, sessionID }) => {
              const action = pushSinkAction(record);
              if (!action) return;
              await push.fireNotify({
                message: action.message,
                title: action.title,
                urgent: action.urgent,
                sessionID,
              });
            },
            forge: async ({ record, sessionID }) => {
              const target = await resolveForgeSinkTarget(sessionID);
              if (!target) return;
              await ensureCommentByTopic({
                repo: target.repo,
                number: target.number,
                topic: sessionID,
                text: record.label || record.detail || record.state || "Progress update",
                listComments: (r, n) => target.adapter.listIssueComments(r, n),
                createComment: (r, n, b) => target.adapter.createIssueComment(r, n, b),
                updateComment: (r, n, id, b) => target.adapter.updateIssueComment(r, n, id, b),
              });
            },
          },
        });
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { ok: true, record: result.record });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Peer-session awareness ----------
  // GET  /api/peers?sessionID=&directory=          → {ok, workspace, self, peers:[...]}
  // GET  /api/peers?sessionID=&directory=&target=  → {ok, peer:{...}} (deep inspect)
  // POST /api/peers  body {sessionID, directory, target, message}
  //                  → {ok, workspace, from, to, targetSessionId} (inject a
  //                    message into a peer chat session as a new turn)
  // Lets an opencode session see what OTHER sessions in the same workspace (tmux
  // session) are doing, and message them. Called by the remote AI's global
  // opencode `peers_list` / `peers_inspect` / `peers_message` tools.
  // See src/server/peers.mjs.
  if (path === "/api/peers") {
    try {
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const directory = url.searchParams.get("directory") || undefined;
        const target = url.searchParams.get("target") || undefined;
        const result = target
          ? await inspectPeer({ sessionID, directory, target })
          : await listPeers({ sessionID, directory });
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, result);
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await sendPeerMessage(
          {
            sessionID: body?.sessionID,
            directory: body?.directory,
            target: body?.target,
            message: body?.message,
          },
          { sendPrompt: (args) => promptDelivery.deliver(args) },
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, result);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- App control ----------
  // POST /api/app-control  body {action, sessionID, directory, ...args}
  //   → {ok, ...} on success, or {ok:false, error} (400) on a bad request.
  // Lets an opencode session drive the app the user is looking at: switch its
  // model, rename the session, compact it, or list the caller's workspace
  // sessions. Called by the remote AI's global opencode `manta_*` tools. See
  // src/server/appControl.mjs.
  //
  // The client-visible effects are published on the bus as ONE kind,
  // `appControl`, with an `action` discriminator — the renderer subscribes
  // once (the sibling ticket) and switches on payload.action.
  if (path === "/api/app-control") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const deps = { publish: (payload) => bus.publish({ kind: "appControl", payload }) };
        const result = await appControl.dispatch(body?.action, body || {}, deps);
        // Rename mutates the tmux window list; re-materialize sync state so the
        // `sync` delta publishes now (parity with the tmux:rename-window RPC,
        // which already refreshes). Without this the sidebar lags until the 2s
        // poller. Only on success, only for the mutating action.
        if (result?.ok && body?.action === "rename-session") {
          await syncState.refreshNow();
        }
        respondJson(res, result.ok ? 200 : 400, result);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      // Errors return a message the model can act on, never a bare 500.
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- On-call CTO (BET-1164) ----------
  // POST /api/cto  body {tool, args, sessionID, directory}
  //   → 200 {ok:true, data} or 400 {ok:false, error}.
  // The deterministic read-only tool belt. Called by the remote AI's global
  // `cto` opencode tool (docs/opencode-tools/cto.ts) and consumed by the
  // on-call CTO agent. dispatch wraps every tool so a quiet box / bad engine
  // returns a structured error, never a throw. `ctx.onNarrate` is a server-side
  // seam (wired by issue 3's voice window), never read off the HTTP body.
  // ---------- On-call CTO inbound (Issue 2) ----------
  // POST /api/cto/inbound  body {surface?, payload, seenId?} → {ok:true, ...}
  // The single entry point for CTO-bound events. Producers: the global
  // send_to_cto tool, the watcher poller, a scheduled prompt targeting the
  // CTO, or a webhook routed to the CTO. With no live call (this issue) events
  // are deduped + surfaced via the existing notification router; Issue 3 flips
  // the live route on. See src/server/cto.mjs (createCtoInbound).
  if (path === "/api/cto/inbound") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await ctoInbound.inbound({
          surface: body?.surface,
          payload: body?.payload ?? {},
          seenId: body?.seenId,
        });
        respondJson(res, result.ok ? 200 : 400, result);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  if (path === "/api/cto") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const engine = getCtoEngine();
        // Text-loop gate (Issue 2): an `approve` id re-authorizes the previously
        // needConfirmation'd (tool, args) — the user said "go ahead". "no" is
        // rejectConfirm; both drive the in-conversation loop (Issue 3 replaces it
        // with voice).
        if (typeof body?.approve === "string" && body.approve) engine.approveConfirm(body.approve);
        let cfg = {};
        try {
          cfg = (await local.configGet()) ?? {};
        } catch {
          cfg = {};
        }
        // The gate reports each tool's declared mode: read-only auto tools run
        // freely; confirm-mode tools (watch) pause for the user's go-ahead
        // (handled inside dispatch via trustedActions / the approve loop).
        const toolModes = new Map(engine.listTools().map((t) => [t.name, t.mode]));
        const gate = (toolName) => (toolModes.get(toolName) === "confirm" ? "confirm" : "allow");
        const result = await engine.dispatch(body?.tool, body?.args ?? {}, {
          sessionID: body?.sessionID,
          cwd: body?.directory,
          trustedActions: Array.isArray(cfg?.cto?.trustedActions) ? cfg.cto.trustedActions : [],
          gate,
        });
        respondJson(res, result.ok ? 200 : 400, result);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Inline media ----------
  // POST /api/media  body {action, sessionID, messageID, ...action-specific}
  //   → {ok, ...} on success, or {ok:false, error} (400) on a bad request.
  // Three AI-facing tools with ONE route + an `action` discriminator (save |
  // begin | show), mirroring /api/app-control:
  //   save  — write media (base64 blob or existing file) into the artifact
  //           mailbox and measure it.
  //   begin — declare INTENDED metadata before a slow generation (returns a
  //           handle; the orphan poller fails it after 10 min).
  //   show  — swap in an existing local file (home-only path, measured).
  // Client-visible placeholder events publish on the bus as ONE kind, `media`,
  // with the matching `action` discriminator. See src/server/media.mjs.
  if (path === "/api/media") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const deps = {
          publish: (payload) => bus.publish({ kind: "media", payload }),
          pending: mediaPending,
        };
        const result = await mediaDispatch(body?.action, body || {}, deps);
        respondJson(res, result.ok ? 200 : 400, result);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      // Errors return a message the model can act on, never a bare 500.
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Secrets (secure key→value store) ----------
  // The user stores secrets (a GitHub PAT, an API key…) via the manta UI; the
  // value lives ONLY here on the box and is NEVER returned to the AI. The
  // remote AI's global opencode `secret_list` / `secret_provide` tools read
  // through here. `secret_provide` materializes the value to a 0600 file and
  // returns ONLY the path, so nothing secret reaches the transcript.
  //
  // GET    /api/secrets?sessionID=         → {secrets:[meta...]}  (values stripped;
  //                                          shared + this session's scoped)
  // GET    /api/secrets?all=1              → {secrets:[meta...]}  (everything, for the
  //                                          desktop "all" management view)
  // POST   /api/secrets        body {key, value, scope, sessionID, hint}
  //                                          → {ok, meta}  (400 bad input)  — UI only
  // POST   /api/secrets/provide body {key, sessionID}
  //                                          → {ok, path, key, hint}  — AI tool only
  // DELETE /api/secrets?id=                → {deleted:bool}  — UI only
  // Store mutations publish a `secrets.updated` bus event so the SecretsCard
  // refetches live. See src/server/secrets.mjs.
  if (path === "/api/secrets/provide") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const project = await resolveProjectName({
          sessionID: body?.sessionID,
          directory: body?.directory,
        });
        const result = await provideSecret({
          key: body?.key,
          sessionID: body?.sessionID,
          project,
        });
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { path: result.path, key: result.key, hint: result.hint });
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }
  if (path === "/api/secrets") {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        // Project scope: use an explicit project (migration script) or resolve
        // it from the caller's session/dir (the "this project" UI option).
        let project = body?.project || null;
        if (body?.scope === "project" && !project) {
          project = await resolveProjectName({
            sessionID: body?.sessionID,
            directory: body?.directory,
          });
        }
        const result = await setSecret(
          {
            key: body?.key,
            value: body?.value,
            scope: body?.scope,
            sessionID: body?.sessionID,
            project,
            hint: body?.hint,
          },
          BUS_PUBLISH_DEPS,
        );
        if (!result.ok) {
          respondJson(res, 400, { error: result.error });
          return;
        }
        respondJson(res, 200, { meta: result.meta });
        return;
      }
      if (req.method === "GET") {
        const sessionID = url.searchParams.get("sessionID") || undefined;
        const directory = url.searchParams.get("directory") || undefined;
        const all = url.searchParams.get("all") === "1";
        const project = all ? null : await resolveProjectName({ sessionID, directory });
        const secrets = listSecrets({ sessionID, project, includeAll: all });
        respondJson(res, 200, { secrets });
        return;
      }
      if (req.method === "DELETE") {
        await handleApiDelete(req, url, res, deleteSecret);
        return;
      }
      respondJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // ---------- Native push (APNs) ----------
  // POST /push/focus       body = { sessionId, visible }  (suppress "done" for
  //                        the session the user is actively viewing)
  // POST /push/desktop-presence body = { idleSeconds, lockedSeconds }  (desktop
  //                        Electron heartbeat — raw system-idle + screen-lock;
  //                        server decides away/present/gone)
  // POST /push/register-apns body = { token }  (BET-181: iOS app registers its
  //                        APNs device token. Same Bearer gate as every other
  //                        /push/* route. Server-side mirror of the
  //                        /rpc/push:register-apns IPC channel so curl /
  //                        integration tests can drive it without a renderer.)
  // BET-559: the Web Push routes (/push/vapid, /push/subscribe,
  // /push/unsubscribe) served the retired mobile PWA and are deleted with it.
  if (req.method === "POST" && path.startsWith("/push/")) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      respondJson(res, 400, { error: "bad json" });
      return;
    }
    try {
      let result = { ok: true };
      if (path === "/push/focus") {
        result = push.setFocus({
          sessionId: body?.sessionId,
          visible: body?.visible,
        });
      } else if (path === "/push/desktop-presence") {
        // Desktop (Electron) heartbeat: raw system-idle + screen-lock
        // observations, posted unconditionally every 30s. Away/present/gone is
        // decided server-side (computeAwayAt / desktopState). Version skew is
        // deliberately unhandled: an old desktop posting {visible} sends no
        // idleSeconds, so the record shows idle 0 and reads "present" until its
        // heartbeats lapse the TTL, after which it is "gone" and mobile resumes.
        result = push.setDesktopPresence({
          idleSeconds: body?.idleSeconds,
          lockedSeconds: body?.lockedSeconds,
        });
        console.log(
          `[push] desktop-presence idle=${body?.idleSeconds}s locked=${body?.lockedSeconds ?? "-"}`,
        );
      } else if (path === "/push/answer") {
        // Direct reply to a Question tool from a notification action button.
        // answers is string[][] (one array per question); the SW sends
        // [[label]] for the single-question quick-reply case.
        await oc.replyQuestion({
          requestId: body?.requestId,
          answers: body?.answers,
          sessionId: body?.sessionId,
        });
        result = { ok: true };
      } else if (path === "/push/register-apns") {
        // iOS Capacitor native push registration (BET-181 §3.2). The
        // renderer calls this via window.api.pushRegisterApns(token) (6-site
        // pattern → /rpc/push:register-apns → rpc.mjs dispatch → push.addApnsToken),
        // but we expose the bare HTTP route here too so curl tests and
        // future non-Capacitor clients can register a token directly. Same
        // addApnsToken path either way — single source of truth.
        if (typeof body?.token !== "string" || !body.token) {
          respondJson(res, 400, { error: "token is required" });
          return;
        }
        result = await push.addApnsToken(body.token);
      } else {
        respondJson(res, 404, { error: "not found" });
        return;
      }
      respondJson(res, 200, result);
    } catch (e) {
      respondJson(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  // BET-559: the web/PWA client bundle is retired, so there is no static SPA
  // fallback to serve. Any GET that reached here matches no backend route —
  // 404 it. The server no longer hosts a web client.
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
};

const server = createServer(handleRequest);

// ---------- WebSocket: /events live stream + /pty terminal bridge ----------
//
// /events — SSE alternative for iOS standalone PWAs, which can't reliably
// receive EventSource. Same bus + envelope as the HTTP /events SSE route.
//
// /pty (BET-158) — binary-safe terminal WS. Bridges to the ephemeral
// pty module (src/server/pty.mjs) the same way Terminal.tsx uses pty:* RPC
// channels. Client→server is JSON control strings (typed messages:
// data/resize); server→client is raw terminal bytes. The endpoint is gated
// like the rest of the surface; browsers without an Authorization header
// use ?token=<box_token>.

const wss = new WebSocketServer({ noServer: true });

const handleUpgrade = (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Auth gate for WS upgrades. Browsers can't set an Authorization header on a
  // WebSocket, so the token also travels as a ?token= query param; non-browser
  // clients may still use the header. /events + /pty are gated. The ?token=
  // fallback is scoped to those paths ONLY by authorizationForRequest (a
  // header always wins; the query token is honored only on the allowlisted
  // stream paths). Reject with an HTTP 401 handshake response before the
  // upgrade.
  const wsAuth = authEngine.authorize({
    method: "GET",
    path: url.pathname,
    authorization: authorizationForRequest(
      url.pathname,
      req.headers["authorization"],
      url.searchParams.get("token"),
    ),
  });
  if (!wsAuth.ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.pathname === "/events") {
    // Live event stream over WS (SSE alternative for iOS standalone PWAs,
    // which can't reliably receive EventSource). Same bus + envelope.
    wss.handleUpgrade(req, socket, head, (ws) => attachEventsWs(bus, ws));
    return;
  }
  if (url.pathname === "/pty") {
    // Binary-safe terminal bridge (BET-158). Direct clients (header bearer
    // or ?token=<box_token>) connect here for a low-latency raw-byte
    // terminal stream.
    wss.handleUpgrade(req, socket, head, (ws) => attachPtyWs(ws, url));
    return;
  }
  if (url.pathname === "/call") {
    // On-call CTO voice window (BET-1166). The renderer's call window streams
    // opus mic frames here; the box relays to OpenAI Realtime (key server-side).
    wss.handleUpgrade(req, socket, head, (ws) =>
      attachCallWs(ws, url, {
        dispatchCto: (name, args, ctx) => getCtoEngine().dispatch(name, args, { ...ctx }),
        approveConfirm: (id) => getCtoEngine().approveConfirm(id),
        rejectConfirm: (id) => getCtoEngine().rejectConfirm(id),
        configGet: () => local.configGet(),
        listTools: () => getCtoEngine().listTools(),
        setCallActive,
        registry: callRegistry,
        // Narration (spec #6): the box synthesizes tool-boundary narration with
        // Groq Orpheus (key server-side) and streams it down /call as audio.
        synthesizeSpeech,
        onNarrate: () => {}, // callWs wraps onNarrate → narrator
      }),
    );
    return;
  }
  socket.destroy();
};

server.on("upgrade", handleUpgrade);

server.listen(PORT, HOST, () => {
  console.log(`manta listening on http://${HOST}:${PORT}`);

  // Register this box with the hosted gateway so push (APNs) works and so the
  // gateway can publish the per-box DNS A record (BET-198 / BET-199).
  // Fire-and-forget: the call is best-effort (it never throws) and a slow /
  // failing gateway must NOT hold up the HTTP server. Retried on next boot.
  // The box must have run ensureAuth() first so box_id is on disk.
  registerWithGateway().catch((err) => {
    console.warn(`[gateway-register] unexpected: ${String(err?.message ?? err)}`);
  });
});

if (TAILNET_HOST) {
  const tailnetServer = createServer(handleRequest);
  tailnetServer.on("upgrade", handleUpgrade);
  const listenTailnet = () => {
    tailnetServer.listen(PORT, TAILNET_HOST, () => {
      console.log(`manta listening on http://${TAILNET_HOST}:${PORT} (tailnet)`);
    });
  };
  tailnetServer.on("error", (err) => {
    console.warn(`[tailnet] listener error (${err.code ?? err.message}); retrying in 30s`);
    const t = setTimeout(listenTailnet, 30_000);
    t.unref();
  });
  listenTailnet();
}
