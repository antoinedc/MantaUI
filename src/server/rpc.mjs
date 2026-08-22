// Channel -> handler dispatch. Handlers are async (...args) => result.
// Mirrors Electron ipcMain.handle semantics.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { transcribeAudio } from "../shared/groq.mjs";
import { expandTilde } from "../shared/paths.mjs";
import {
  computeContextBreakdown,
  selectLatestTokenUsage,
} from "../shared/streamInterpretation.mjs";
import { listJobs as scheduleListJobs, deleteJob as scheduleDeleteJob, createJob as scheduleCreateJob } from "./schedule.mjs";
import { listSnapshots as usageListSnapshots } from "./usage.mjs";
import {
  listStopped as usageStoppedList,
  armStopped as usageStoppedArm,
  disarmStopped as usageStoppedDisarm,
  stampStoppedLastLooked as usageStoppedStampLastLooked,
  markStoppedRan as usageStoppedMarkRan,
} from "./stoppedStore.mjs";
import { getModelPrefs as modelPrefsGetStore, setModelPrefs as modelPrefsSetStore, seedModelPrefs as modelPrefsSeedStore } from "./modelPrefs.mjs";
import { listHooks as webhookListHooks, deleteHook as webhookDeleteHook } from "./webhooks.mjs";
import { listPages as servePageListStore } from "./servePage.mjs";
import { listOutbox } from "./outbox.mjs";import { publicBaseUrl } from "./gatewayRegister.mjs";
import {
  listSecrets as secretsListStore,
  setSecret as secretsSetStore,
  deleteSecret as secretsDeleteStore,
} from "./secrets.mjs";
import { resolveWorkspace } from "./peers.mjs";
import * as providers from "./providers.mjs";
import * as launchers from "./launchers.mjs";
import * as subscriptionProviders from "./subscriptionProviders.mjs";
import { toDeliverModel } from "./delegate.mjs";
import { buildRoutingServices } from "./routingServices.mjs";
import { restartOpencode, runServerSelfUpdate } from "./opencodeAdmin.mjs";
import { pollClaudeLogin, claudeCliStatus, listRoutableModels } from "./opencode.mjs";
import { chooseModel, incumbentStillEligible } from "../shared/modelRouter.mjs";
import { backupClaudeCredentials, CREDENTIALS_PATH } from "./claudeAuth.mjs";
import { addApnsToken } from "./push.mjs";
import { getRegistry as pluginsGetRegistry } from "./plugins.mjs";
import { searchMessages } from "./messageSearch.mjs";
import { ledgerSummary } from "./modelLedger.mjs";
import { allModels as catalogAllModels } from "./modelCatalog.mjs";
import { MIN_CLIENT } from "./version.mjs";
import { forgeDiffForCwd, forgeStatus, pullRequestForCwd, shipPullRequest, shipPreview, mergePullRequest, draftGetForCwd, draftCommentForCwd, draftSubmitForCwd, replyThreadForCwd, forgeInbox, forgeDeviceStart, forgeDevicePoll, forgeDeviceCancel, forgeListRepos, forgeCloneStart, forgeCloneStatus, forgeCloneCancel } from "./forge/index.mjs";
import { listRules as forgeListRules, formatIssueRef, parseIssueRef } from "./forgeRules.mjs";
import { clearStoredToken } from "./forge/auth.mjs";
import { parseRules as parseForgeRules } from "../shared/forgeRules.mjs";

// The number of rules (event entries) in a repo's rules YAML — shown in
// Settings [G1] so a valid repo reads "3 rules".
function countForgeRules(yaml) {
  try {
    const parsed = parseForgeRules(String(yaml ?? ""));
    if (!parsed.ok || !parsed.rules?.on) return 0;
    return Object.keys(parsed.rules.on).length;
  } catch {
    return 0;
  }
}

// Same dirname derivation as src/server/index.mjs (line 83) so the script
// path resolves identically. The script lives at <repoRoot>/scripts/
// self-update.sh — `restartOpencode` invokes an absolute binary on PATH;
// this one is repo-local so we resolve it explicitly. Mirrors how the
// server already passes an absolute cwd to tmux/opencode spawning.
//
// Exported (BET-366 reviewer return) so the regression guard in
// src/server/rpc.test.mjs can match the channel routing against the
// exact path the production wiring passes to `runServerSelfUpdate`.
// Without this, a future path-rename here would silently slip past
// the spawn test in opencodeAdmin.test.mjs (which only checks the
// function — it can't see what the IPC channel passes in).
const __dirname = dirname(fileURLToPath(import.meta.url));
export const SELF_UPDATE_SCRIPT = join(
  __dirname,
  "..",
  "..",
  "scripts",
  "self-update.sh",
);

// ---------------------------------------------------------------------------
// BET-354: Claude connect session registry
// ---------------------------------------------------------------------------
//
// One pty per in-flight `claude auth login`. The sessionKey is generated
// by `startClaudeLogin` (uuid), returned to the renderer, and used by
// `pty:spawn`/`pty:write`/`pty:kill` on the existing pty bus — those
// channels operate on whatever sessionKey the renderer holds, the new
// registry just owns the metadata the connect card needs (startedAt for
// the file-mtime progress check, the spawn cwd, and a way to look up the
// session from the claude-status RPC handler).
//
// We DO NOT spawn a second IPty here — the renderer drives that via
// `pty:spawn({launcher:{id:"claude-auth-login"}, sessionKey})` so the
// data/exit events flow through the same bus everything else does.
// `startClaudeLogin` only stamps the metadata; cancelClaudeLogin tears
// it down.
const _claudeLoginSessions = new Map();

/** Test-only: peek the in-flight Claude connect sessions. */
export function _getClaudeLoginSessions() {
  return new Map(_claudeLoginSessions);
}

/** Test-only: clear between scenarios. */
export function _resetClaudeLoginSessions() {
  _claudeLoginSessions.clear();
}

// Device-flow (oauth-auto) callbacks in flight, keyed by provider id.
// opencode's POST /oauth/callback BLOCKS until the user approves on the
// provider's device page, so it is fired detached and its outcome is read
// back by the `oauth-status` action. One entry per provider: a restarted
// flow calls authorize again, which replaces opencode's own pending entry,
// so overwriting here is correct.
const _oauthCallbacks = new Map();

/** Test-only: peek the in-flight device-flow callbacks. */
export function _getOauthCallbacks() {
  return new Map(_oauthCallbacks);
}

/** Test-only: clear between scenarios. */
export function _resetOauthCallbacks() {
  _oauthCallbacks.clear();
}

/**
 * Fire an oauth-auto (Codex headless) callback DETACHED and record its
 * outcome for the `oauth-status` action to read back. opencode's callback
 * is a blocking device-token poll that settles minutes later — long after
 * the `start` response has gone back to the renderer — so we must not
 * await it here. It can never reject: an unhandled rejection would take
 * the server down, so both settle paths record into the map instead.
 */
function startOauthCallback(oc, id, methodIndex) {
  _oauthCallbacks.set(id, { startedAt: Date.now(), state: "pending" });
  // Detached ON PURPOSE: this promise settles minutes later, long after the
  // `start` response has gone back to the renderer.
  oc.completeProviderOauth(id, methodIndex, "")
    .then((r) => {
      _oauthCallbacks.set(id, r?.ok
        ? { startedAt: Date.now(), state: "ok" }
        : { startedAt: Date.now(), state: "error", error: r?.error ?? "failed" });
      if (!r?.ok) console.warn(`[provider-auth] ${id}: oauth callback failed (${r?.error ?? "failed"})`);
    })
    .catch((e) => {
      _oauthCallbacks.set(id, { startedAt: Date.now(), state: "error", error: "unreachable" });
      console.warn(`[provider-auth] ${id}: oauth callback threw:`, e?.message ?? e);
    });
}

/**
 * Spawn-side metadata registrar for a Claude login flow. Called by the
 * `opencode:provider-auth start` action when `describeConnectShape` returns
 * `claude-login`. Returns `{action:"start", shape:"claude-login", sessionKey,
 * startedAt, cwd}` to the renderer — the renderer then calls
 * `pty:spawn({sessionKey, launcher:{id:"claude-auth-login"}, cwd})` itself,
 * using the SAME pty bus every terminal/CLI uses. Splitting the metadata
 * stamp from the actual pty.spawn lets the renderer mount a Terminal pane
 * with its normal `useEffect`-driven spawn flow (so the pty is sized to
 * the terminal component's actual rendered cols/rows, not a fixed 80x24).
 *
 * BET-359 fold-in: takes a snapshot of the existing credentials file
 * BEFORE returning the sessionKey, so that if `claude auth login` later
 * overwrites it with garbage we can roll back. The backup path is stored
 * on the session entry and plumbed into `pollClaudeLogin` via the
 * `claude-status` RPC handler. A backup failure (e.g. EACCES on the
 * credentials file) does NOT block the connect flow — the metadata is
 * still stamped and the renderer can still attempt OAuth — but the
 * failure is logged so a future operator can see the safety net wasn't
 * in place.
 */
async function startClaudeLogin(id) {
  const sessionKey = `claude-login-${randomUUID()}`;
  const startedAt = Date.now();
  const cwd = homedir();
  // Backup first — strictly BEFORE the renderer can spawn `claude auth
  // login` via the pty bus. If this throws the connect flow dies (we'd
  // rather crash loudly here than silently leave an unprotected file
  // behind); the helper itself is non-throwing, so the only realistic
  // throw is a programmer error (no credentialsFile / no now).
  let backupPath = null;
  let backupResult = null;
  try {
    backupResult = await backupClaudeCredentials({
      credentialsFile: CREDENTIALS_PATH,
      now: startedAt,
    });
    if (backupResult.backedUp) {
      backupPath = backupResult.backupPath;
    } else if (backupResult.reason === "copy-failed") {
      // A real IO error — log so an operator sees the safety net is
      // down, but DO NOT block the connect flow. The renderer's
      // pre-OAuth warning UX lives elsewhere (the connect card already
      // shows the existing login when one's present).
      console.warn(
        "[claude-auth] startClaudeLogin: backup copy failed (%s) — connect flow will proceed without a rollback target",
        backupResult.error,
      );
    }
  } catch (e) {
    // Defensive: backupClaudeCredentials is contractually non-throwing.
    // A throw here is a programmer error in the helper; log + continue
    // so a stale `now` arg or a future code change doesn't take down
    // the whole connect flow.
    console.warn("[claude-auth] startClaudeLogin: backup helper threw:", e?.message ?? e);
  }
  _claudeLoginSessions.set(sessionKey, {
    id,
    startedAt,
    cwd,
    killed: false,
    backupPath,
  });
  return {
    action: "start",
    shape: "claude-login",
    sessionKey,
    startedAt,
    cwd,
  };
}

function cancelClaudeLogin(sessionKey) {
  const entry = _claudeLoginSessions.get(sessionKey);
  if (!entry) return;
  // The renderer's claude:login-cancel is paired with pty:kill(same
  // sessionKey) — pty.kill handles the IPty teardown; here we just drop
  // the metadata so a fresh start can register under the SAME name.
  _claudeLoginSessions.delete(sessionKey);
}

export async function dispatch(handlers, channel, args) {
  const fn = handlers[channel];
  if (!fn) throw new Error(`unknown rpc channel: ${channel}`);
  return fn(...args);
}

// Build the full handler map. Accepts { tmux, oc, pty, bus, local, authPair, push, serverVersion, runServerSelfUpdate } where:
//   tmux                — src/server/tmux.mjs namespace
//   oc                  — src/server/opencode.mjs namespace
//   pty                 — src/server/pty.mjs namespace
//   bus                 — event bus created by createBus() in events.mjs
//   local               — src/server/local.mjs namespace (git/fs/config/clipboard stubs)
//   authPair            — () => authEngine.pair(); the `auth:pair` channel wraps it.
//   push                — src/server/push.mjs namespace (BET-181: APNs token registration dispatch).
//   serverVersion       — string, package.json `version` read once at startup (same
//                         value `GET /api/version` returns). The `server:version`
//                         channel returns it in-process so the renderer avoids an
//                         HTTP round-trip on every Settings mount.
//   opencodeVersion     — string, the box's `opencode --version` output read once
//                         at startup (BET-428). Surfaced in the same `server:version`
//                         response so Settings → About can render it without a new
//                         IPC channel; falls back to FALLBACK_VERSION when opencode
//                         isn't installed.
//   runServerSelfUpdate — the box's self-update spawner (BET-366 reviewer return).
//                         Injected so the regression guard in rpc.test.mjs can
//                         stub the spawn and assert the `server:update-apply`
//                         IPC channel routes to it with the right script path.
//                         Production callers (src/server/index.mjs) pass the
//                         real `runServerSelfUpdate` from opencodeAdmin.mjs.
//                         `restartOpencode` is still module-imported (no IPC
//                         regression guard is pinned to it today).
// Channel key strings MUST match IPC.* values in src/shared/types.ts.
// Arg shapes MUST match what src/preload/index.ts packs per channel.

// Hard cap on the CLI probe inside `server:update-check`. The detector's own
// per-probe timeouts bound version reads, but `fetchLatest` has no AbortSignal
// — a wedged network call could hang the whole click. Matches the renderer's
// 15s server-leg timeout so the two can't disagree about what "a check that
// just didn't answer" means.
const CLI_PROBE_TIMEOUT_MS = 15_000;

/**
 * Bound a CLI-probe promise with a hard timeout. On expiry it REJECTS, which
 * the `server:update-check` handler treats as "return without targets" — a CLI
 * probe must never be able to break the box-update check.
 */
function withCliProbeTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cli probe timeout")), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function buildHandlers({
  tmux,
  oc,
  pty,
  bus,
  local,
  syncState,
  authPair,
  push,
  serverVersion,
  opencodeVersion,
  runServerSelfUpdate,
  checkServerUpdate = () => Promise.resolve({ available: false }),
  // Box-side CLI update detector (BET-1096). Null when not wired — the
  // `server:update-check` handler then returns the box verdict WITHOUT
  // `targets`, exactly as an older box would.
  cliDetector = null,
  // Hard bound on the CLI probe, injectable for tests (defaults to 15s).
  cliProbeTimeoutMs = CLI_PROBE_TIMEOUT_MS,
  // Single-CLI upgrade (BET-1162): upgrades exactly ONE installed CLI by catalog
  // id, reusing the shared cliDetector + runUpgrade spawn. Injected via
  // buildHandlers deps (like runServerSelfUpdate / cliDetector) so the routing
  // test can stub it; production wiring passes src/server/cliUpdates.mjs's
  // upgradeCli. Null when not wired → the channel answers `{ok:false,
  // error:"no upgrade path"}` rather than throwing.
  upgradeCli = null,
  delegate,
  progress,
  voiceNotes,
  contextLimitFor = () => null,
  // BET-1252: the routing-services readers. Null/absent → the assembly degrades
  // to absent services and the router returns the incumbent (routing inert).
  routingCatalogIndex = null,
  routingProviderHealthState = () => null,
  routingEndpointSummary = () => null,
  // BET-1244: the filtered catalogue for routing:choose — listRoutableModels
  // (S1c) is the ONE place routing consent is computed; routing:choose gets the
  // filtered catalogue from it, never a second filter. Injectable for tests.
  routingListRoutableModels = listRoutableModels,
  // BET-1244: the provider-health engine (createProviderHealth) exposing
  // `retry` for the Accounts "Try again" action. Null when not wired → the
  // accounts:retry channel answers a non-empty failure message, never a throw.
  providerHealth = null,
}) {
  // The sole resolver for project cwd — no longer mirrored to a desktop-main
  // copy (the src/main/index.ts duplicate was retired in the HTTP-only
  // migration). Renderer-supplied cwd is preferred when it's a real path, but
  // falls through to the project's stored defaultCwd whenever the renderer
  // sends nothing or the literal "~".
  // opencode's session.create requires an absolute directory; per-pane
  // paneCurrentPath can drift (or be empty for fresh chat-holder panes), so
  // the workspace's defaultCwd is the canonical "where this project lives".
  async function resolveProjectCwd(sessionName, inputCwd) {
    const trimmed = typeof inputCwd === "string" ? inputCwd.trim() : "";
    if (trimmed && trimmed !== "~") return trimmed;
    // 1. Prefer the stored project meta (set by the desktop on project create).
    const cfg = await local.configGet();
    const meta = cfg.projects?.find((p) => p.tmuxSession === sessionName);
    const storedCwd = (meta?.defaultCwd ?? "").trim();
    if (storedCwd && storedCwd !== "~") return storedCwd;
    // 2. Fall back to the LIVE tmux session's directory. The config file is
    //    frequently empty or stale (sessions created outside the desktop
    //    project-create flow have no stored meta), which silently dropped every
    //    new window into $HOME. listProjects() derives defaultCwd from the
    //    session's first window's actual pane path — the canonical "where this
    //    project lives" — so consult it before defaulting to ~.
    try {
      const projects = await tmux.listProjects();
      const live = projects.find((p) => p.tmuxSession === sessionName);
      const liveCwd = (live?.defaultCwd ?? "").trim();
      if (liveCwd && liveCwd !== "~") return liveCwd;
    } catch {
      // tmux unavailable → fall through to the last-resort default below.
    }
    return storedCwd || trimmed || "~";
  }

  // Resolve a caller's manta project (tmux session) name from its opencode
  // sessionID, for project-scoped secret resolution (mobile in-process path).
  async function resolveProjectName(sessionID) {
    if (!sessionID) return null;
    try {
      const projects = await tmux.listProjects();
      const ws = resolveWorkspace(projects, sessionID, undefined);
      return ws?.project?.tmuxSession ?? null;
    } catch {
      return null;
    }
  }

  return {
    // ---- local channels (config/git/fs/clipboard/transport/tmux-config) ----

    // preload: ipcRenderer.invoke(IPC.configGet)  → no args
    "config:get": () => local.configGet(),

    // preload: ipcRenderer.invoke(IPC.configUpdate, patch)  → args[0] = patch (Partial<AppConfig>)
    // BET-675: after a successful write, push the new config into syncState so
    // the materialized config delta is published for sync subscribers.
    //
    // BET-1031: skillRegistryUrls is the one Settings field that must ALSO be
    // applied to opencode itself (its `skills.urls`), not just persisted to
    // config.json. Written to opencode FIRST through the single endpoints
    // writer; only on success is config.json persisted, so a registry change
    // that can't reach opencode fails loudly (renderer reverts + errors)
    // instead of "appears to save but does nothing". opencode re-reads
    // `skills` at startup, like subagents.
    "config:update": async (patch) => {
      if (Array.isArray(patch?.skillRegistryUrls)) {
        const applied = await providers.setSkillRegistryUrls(patch.skillRegistryUrls);
        if (!applied.ok) throw new Error(applied.error);
      }
      const next = await local.configUpdate(patch);
      syncState.applyConfig(next);
      return next;
    },

    // preload: ipcRenderer.invoke(IPC.projectMetaDelete, tmuxSession)  → args[0] = tmuxSession (string)
    "project:meta:delete": (tmuxSession) => local.projectMetaDelete(tmuxSession),

    // preload: ipcRenderer.invoke(IPC.gitListWorktrees, cwd)  → args[0] = cwd (string)
    "git:list-worktrees": (cwd) => local.gitListWorktrees(cwd),

    // BET-246: auto-create a sibling git worktree for a new chat session.
    // preload: ipcRenderer.invoke(IPC.gitAddWorktree, { cwd, name })
    //   → args[0] = { cwd: string, name: string }
    "git:add-worktree": (i) => local.gitAddWorktree(i),

    // BET-246: safe/force remove of a worktree MantaUI created. Returns
    // { removed:false, reason:"dirty" } for the uncommitted-changes case
    // so the renderer can confirm before retrying with --force; throws on
    // any other failure.
    // preload: ipcRenderer.invoke(IPC.gitRemoveWorktree, { path, force })
    //   → args[0] = { path: string, force: boolean }
    "git:remove-worktree": (i) => local.gitRemoveWorktree(i),

    // preload: ipcRenderer.invoke(IPC.fsListDirs, partial)  → args[0] = partial (string)
    "fs:list-dirs": (partial) => local.fsListDirs(partial),

    // BET-1091: create an empty, git-initialised scratch project directory.
    // Returns the real absolute path for stage 4 to feed into the existing
    // session-creation call. Creates a directory and nothing else.
    // preload: ipcRenderer.invoke(IPC.projectCreateScratch, { root, name })
    //   → args[0] = { root: string, name: string }
    "project:create-scratch": (i) => local.createScratchProject(i),

    // BET-786: probe the box for git repos + read origins + detect the gh CLI.
    // Server-side only; no renderer-supplied depth/caps (a renderer-supplied
    // depth would be a DoS on the user's own box).
    // preload: ipcRenderer.invoke(IPC.forgeProbe)  → no args
    "forge:probe": () => local.forgeProbe(),

    // BET-788: forge read path. Both box-side only — the renderer stays
    // ignorant of forge identity. forge:status reports connected/login without
    // ever crossing a token; forge:pull-request takes a session cwd and the
    // server resolves cwd → origin → repo.
    // preload: ipcRenderer.invoke(IPC.forgeStatus)             → no args
    // preload: ipcRenderer.invoke(IPC.forgePullRequest, {cwd}) → args[0] = { cwd }
    "forge:status": (input) => forgeStatus({ validate: input?.validate === true }),
    "forge:pull-request": (input) =>
      pullRequestForCwd(typeof input === "object" && input !== null ? input.cwd : input),
    // A forge ref is either the session cwd ({ cwd }) — resolved box-side to
    // the open PR — or an explicit cross-repo inbox target ({ repoKey, number },
    // BET-850). Pass the whole input so the server reads whichever addressing
    // mode the caller supplied.
    "forge:diff": (input) => forgeDiffForCwd(input),

    // BET-798: box-side rules registry reads + disconnect (the Settings [G1]
    // surface). A forge token never reaches the renderer — list returns rule
    // source + validity only, disconnect clears the box-side credential cache.
    // preload: ipcRenderer.invoke(IPC.forgeRulesList)  → no args
    "forge:rules-list": async () => {
      const rows = await forgeListRules();
      return rows.map((r) => ({
        repoKey: r.repoKey,
        valid: r.valid,
        ...(r.valid && r.yaml ? { ruleCount: countForgeRules(r.yaml) } : {}),
        ...(r.error ? { error: r.error } : {}),
      }));
    },
    // preload: ipcRenderer.invoke(IPC.forgeDisconnect) → no args
    // BET-942: Disconnect is now a PERSISTED opt-out, not a 60s-cache clear.
    // While the flag is set the credential ladder (auth.mjs resolveToken)
    // resolves nothing regardless of env/CLI/secret — so the gh CLI is NOT
    // logged out (not ours to touch) but the box ignores it. We also delete
    // the shared GITHUB_TOKEN secret Manta's own device flow wrote (a missing
    // secret is not an error). A successful device sign-in clears the flag.
    "forge:disconnect": async () => {
      await local.configUpdate({ forgeDisconnected: true });
      await clearStoredToken();
      return { ok: true };
    },

    // BET-795: forge:inbox — the aggregated work inbox. Box-side read; three
    // cross-repo SEARCH queries (assigned, review-requested, my red PRs),
    // cached a full 60s on the search bucket. No per-repo iteration.
    "forge:inbox": () => forgeInbox(),

    // BET-794: forge write path. Both box-side — a forge token never reaches
    // the renderer; the server resolves it. forge:ship previews/creates a PR
    // (push then create) ONLY after the renderer's human confirm card.
    // forge:merge merges with the head SHA the user approved, surfacing the
    // distinguished failure kind (sha_mismatch / cannot_merge / permission).
    "forge:ship": async (input) => {
      const cwd = typeof input === "object" && input !== null ? input.cwd : "";
      const res = await shipPullRequest(
        cwd,
        typeof input === "object" && input !== null ? input : {},
      );
      return res;
    },
    "forge:ship-preview": async (input) => {
      const cwd = typeof input === "object" && input !== null ? input.cwd : "";
      const model = typeof input === "object" && input !== null ? input.model : undefined;
      const sessionId = typeof input === "object" && input !== null ? input.sessionId : undefined;
      // Seed the PR body with a "Closes #N" line from the originating issue
      // (BET-871): resolve the session's window from the shipping cwd and read
      // the `@manta-forge-issue` user-option the inbox's Start-a-session flow
      // stamped. parseIssueRef returns null for a missing/malformed option, so
      // a session started any other way (or from an inbox PR) keeps today's
      // byte-identical body. No second session-link store — the tmux window IS
      // the app session.
      return shipPreview(cwd, {
        model,
        sessionId,
        createSession: oc.createSession,
        sendPrompt: oc.sendPrompt,
        listMessages: oc.listMessages,
        deleteSessionRaw: oc.deleteSessionRaw,
        linkedIssue: async () => {
          if (!cwd) return null;
          const win = await tmux.findWindowForCwd(cwd);
          if (!win) return null;
          const raw = await tmux.getWindowOption(win.sessionName, win.windowIndex, "@manta-forge-issue");
          return raw ? parseIssueRef(raw) : null;
        },
      });
    },
    "forge:merge": (input) =>
      mergePullRequest(
        typeof input === "object" && input !== null ? input.cwd : "",
        typeof input === "object" && input !== null ? input : {},
      ),

    // BET-793: box-buffered draft review. The box owns the draft (§3.4①) —
    // comments accumulate in durable box state and "submit" flushes them as ONE
    // review. All three channels are box-side only (a forge token never reaches
    // the renderer). forge:draft-get reads the current draft (reconciling head
    // movement → stale); forge:draft-comment mutates a comment or sets the
    // verdict; forge:draft-submit flushes and clears only on success.
    "forge:draft-get": (input) => draftGetForCwd(input),
    "forge:draft-comment": (input) =>
      draftCommentForCwd(
        typeof input === "object" && input !== null ? input : "",
        typeof input === "object" && input !== null ? input : {},
      ),
    "forge:draft-submit": (input) =>
      draftSubmitForCwd(
        typeof input === "object" && input !== null ? input : "",
        typeof input === "object" && input !== null ? input : {},
      ),
    "forge:thread-reply": (input) =>
      replyThreadForCwd(
        typeof input === "object" && input !== null ? input : "",
        typeof input === "object" && input !== null ? input : {},
      ),

    // BET-796: fresh-box clone flow. All box-side — a token never reaches the
    // renderer. forge:device-start mints the GitHub device grant (returns a
    // renderer-safe shape, NEVER device_code); forge:device-poll drives the
    // countdown (returns {status:"pending"|"done"|"expired"}); forge:device-
    // cancel backs out to [S4] with nothing changed. forge:repos lists the
    // clone picker's push-to repos; forge:clone-{start,status,cancel} run a
    // clone on the box with real progress.
    "forge:device-start": () => forgeDeviceStart(),
    "forge:device-poll": (input) => forgeDevicePoll(typeof input === "object" && input !== null ? input.grantId : input),
    "forge:device-cancel": (input) => forgeDeviceCancel(typeof input === "object" && input !== null ? input.grantId : input),
    "forge:repos": () => forgeListRepos(),
    "forge:clone-start": (input) =>
      forgeCloneStart(typeof input === "object" && input !== null ? input : {}),
    "forge:clone-status": (input) => forgeCloneStatus(typeof input === "object" && input !== null ? input.id : input),
    "forge:clone-cancel": (input) => forgeCloneCancel(typeof input === "object" && input !== null ? input.id : input),

    // preload: ipcRenderer.invoke(IPC.clipboardWriteText, text)  → args[0] = text (string)
    "clipboard:write-text": (text) => local.clipboardWriteText(text),

    // preload: ipcRenderer.invoke(IPC.clipboardReadImage)  → no args
    "clipboard:read-image": () => local.clipboardReadImage(),

    // preload: ipcRenderer.invoke(IPC.openExternal, url)  → args[0] = url (string)
    "shell:open-external": (url) => local.openExternal(url),

    // preload: ipcRenderer.invoke(IPC.peekRemoteFile, remotePath)  → args[0] = remotePath (string)
    "peek:remote-file": (remotePath) => local.peekRemoteFile(remotePath),

    // preload: ipcRenderer.invoke(IPC.tmuxConfigStatus)  → no args
    "tmux:config-status": () => local.tmuxConfigStatus(),

    // preload: ipcRenderer.invoke(IPC.tmuxSetupConfig)  → no args
    "tmux:setup-config": () => local.tmuxSetupConfig(),

    // preload: ipcRenderer.invoke(IPC.tmuxRestoreConfig)  → no args
    "tmux:restore-config": () => local.tmuxRestoreConfig(),

    // ---- voice (Groq STT + lightweight classifier) ----
    //
    // Same channel names + payload shapes as the desktop IPC, so the
    // renderer code is identical. API key + model overrides come from the
    // mobile-server config (~/.manta/config.json). Stored plaintext —
    // same trust model as the rest of manta's credentials.
    //
    // preload: ipcRenderer.invoke(IPC.voiceTranscribe, { buffer, mime })
    //   → args[0] = { buffer: ArrayBuffer, mime: string }
    // NOTE: over the RPC wire the buffer arrives base64-encoded (see
    // httpApi.ts) because the body is JSON. Decode here before handing
    // to groq.mjs. Detected by typeof === "string".
    "voice:transcribe": async (input) => {
      const cfg = await local.configGet();
      let buf = input?.buffer;
      if (typeof buf === "string") buf = Buffer.from(buf, "base64");
      return transcribeAudio({
        buffer: buf,
        mime: input?.mime ?? "audio/webm",
        apiKey: cfg.groqApiKey ?? "",
        model: cfg.voiceTranscriptionModel,
      });
    },

    // BET-834: list a session's voice notes (metadata only — no audio, no
    // binary). Binary goes over REST (GET /api/voice/<id>), metadata over
    // /rpc — that split is the existing convention. Oldest first. Returned
    // records omit any audio bytes that might have been stored alongside
    // (there are none today, but the split is explicit).
    "voice:list-notes": ({ sessionId } = {}) => voiceNotes.list({ sessionId }),

    // preload: ipcRenderer.invoke(IPC.uploadFiles, { projectName, localPaths })
    // → args[0] = { projectName, localPaths }
    // Mobile stub: returns [] because localPaths are client-device paths unknown
    // to the server. Mobile attachments use uploadBuffer (/api/upload) instead.
    "upload:files": (input) => local.uploadFiles(input),

    // ---- tmux (8 channels) ----
    // BET-675: serve tmux:list from the materialized in-memory sync state
    // instead of shelling out to tmux on every request. A transient tmux
    // failure used to be misclassified as "zero sessions" (empty sidebar,
    // pruned ownership sidecar). From memory we always have a last-known-good
    // list, plus a `stale` flag. Guard: until ANY listProjects tick has ever
    // succeeded, do a synchronous refresh so the first call doesn't return a
    // hardcoded empty list to a box that just booted.
    "tmux:list": async () => {
      if (!syncState.everSucceeded()) {
        await syncState.refreshNow();
      }
      return syncState.snapshot().projects;
    },
    // BET-675: cursor snapshot/delta RPC. Client passes its last-seen
    // { sinceSeq, sinceGen }; the server returns { gen, seq, changed } with
    // only the fields whose version is newer than sinceSeq (or a full
    // snapshot when the cursor is absent / stale generation / impossible).
    // BET-685: same first-tick guard as tmux:list. Until ANY syncTick has
    // succeeded, do a synchronous refresh so a client that calls sync:snapshot
    // right after server boot (BET-678's cold+boot load path) never receives a
    // confident zero-project snapshot.
    "sync:snapshot": async ({ sinceSeq, sinceGen } = {}) => {
      if (!syncState.everSucceeded()) {
        await syncState.refreshNow();
      }
      return syncState.payloadSince(sinceSeq, sinceGen);
    },
    // chatMode (BET-113): when the new-session dialog's "chat mode (opencode)"
    // toggle is on, tmux.newSession must create an opencode session, launch a
    // holder pane, and stamp @manta-session-id — so it needs the `oc` client.
    // Resolve cwd first (createSession requires an absolute-ish dir; the tilde
    // is expanded inside oc.createSession). For new-session the project meta
    // doesn't exist yet, so resolveProjectCwd falls back to the passed cwd.
    // BET-307: persist the workspace's resolved absolute cwd server-side so
    // future `tmux:new-window` / `opencode:clear-session` calls inherit it
    // from config rather than reading it back off the (potentially drifted)
    // live tmux pane. Best-effort (.catch) — a config-write failure never
    // fails project creation. Absolute — a stored `~` path is what this
    // issue is about.
    "tmux:new-session": async (i) => {
      const cwd = await resolveProjectCwd(i.name, i.cwd);
      // BET-871: the inbox's "Start a session" flow passes the originating
      // issue ({ repoKey, number }) for issue-kind items. Format it to the
      // canonical "repoKey#number" ref the newSession stamp carries — done
      // server-side so the format logic lives in one tested place, never in
      // the renderer. formatIssueRef returns null for invalid input, which
      // simply skips the stamp.
      const forgeIssueRef = i?.forgeIssue ? formatIssueRef(i.forgeIssue) : null;
      const result = await tmux.newSession({ ...i, cwd, oc, forgeIssueRef });
      await local
        .projectMetaUpsert({
          tmuxSession: i.name,
          defaultCwd: expandTilde(cwd),
        })
        .catch(() => {});
      // BET: the create returns the new window's { sessionId, windowIndex,
      // projects } so callers can navigate + send the first prompt to the
      // RIGHT session (previously they re-located by name, which mixed new
      // sessions up with existing ones on name collisions).
      // BET-675: refresh materialized state so the sync delta publishes now.
      await syncState.refreshNow();
      return result;
    },
    // Resolve cwd: prefer explicit cwd in input, then fall back to the
    // project's stored defaultCwd (set when the workspace was created).
    // Without this, new chat windows opened in a workspace silently inherit
    // tmux's default cwd (usually $HOME) instead of the workspace path.
    // Pass `oc` so a chatMode window creates + stamps an opencode session
    // (BET-113 regression: this used to silently drop chatMode).
    "tmux:new-window": async (i) => {
      const result = await tmux.newWindow({ ...i, cwd: await resolveProjectCwd(i.sessionName, i.cwd), oc });
      await syncState.refreshNow();
      return result;
    },
    "tmux:rename-session": async (i) => {
      const result = await tmux.renameSession(i);
      await syncState.refreshNow();
      return result;
    },
    "tmux:rename-window": async (i) => {
      const result = await tmux.renameWindow(i);
      await syncState.refreshNow();
      return result;
    },
    "tmux:kill-session": async (n) => {
      const result = await tmux.killSession(n);
      await syncState.refreshNow();
      return result;
    },
    "tmux:kill-window": async (i) => {
      const result = await tmux.killWindow(i);
      await syncState.refreshNow();
      return result;
    },
    "tmux:select-window": async (i) => {
      const result = await tmux.selectWindow(i);
      await syncState.refreshNow();
      return result;
    },

    // ---- opencode: simple pass-throughs ----

    // preload: ipcRenderer.invoke(IPC.opencodeMessages, sessionId, opts?)
    // → args[0] = sessionId (string), args[1] = optional {limit}.
    //
    // The desktop passes `{limit} = {limit: 100}` for the tail-first mount
    // fetch and `{}` (whole history) for "Load earlier"; no limit at all keeps
    // the full transcript. The native iOS client passes {limit, slim}. The
    // duplicated tool stdout is stripped server-side for every client.
    "opencode:messages": (sessionId, opts) => oc.listMessages(sessionId, opts ?? {}),

    // Context usage for a session that may be idle. The live `stream/context`
    // frame is emitted only when an assistant message arrives, so a client
    // opening an existing conversation has nothing to render until the next
    // turn. This derives the same payload from the persisted transcript, using
    // the same shared breakdown function, so an idle session is correct on
    // open. Returns null when the transcript has no billed assistant turn yet.
    "opencode:context": async (sessionId) => {
      const messages = await oc.listMessages(sessionId, { slim: true });
      const found = selectLatestTokenUsage(messages);
      if (!found) return null;
      const limit = contextLimitFor(found.providerID, found.modelID);
      return computeContextBreakdown(found.tokens, limit);
    },

    // Single-message fetch for live-turn splice (returns null on miss).
    "opencode:message": (sessionId, messageId) =>
      oc.getMessage(sessionId, messageId),

    // preload: ipcRenderer.invoke(IPC.opencodePrompt, { sessionId, text, model, attachments, mentions })
    // → args[0] = that object; opencode.mjs sendPrompt expects the same shape
    "opencode:prompt": (input) => oc.sendPrompt(input),

    // preload: ipcRenderer.invoke(IPC.opencodeAbort, sessionId)
    // → args[0] = sessionId (string)
    "opencode:abort": (sessionId) => oc.abortSession(sessionId),

    // preload: ipcRenderer.invoke(IPC.opencodePermissions, sessionId?) → args[0] = sessionId
    // Scope the list to the session's directory — opencode returns [] for a
    // non-default-directory session on the unscoped endpoint, so an unpassed
    // sessionId made the PermissionCard never appear on mobile (turn hangs).
    // Background-job children no longer surface here (BET-418 §A): a job is
    // created with a pre-flight permission ruleset and never asks once running.
    "opencode:permissions": async (sessionId) => oc.listPermissions(sessionId),

    // preload: ipcRenderer.invoke(IPC.opencodePermissionReply, { requestId, reply, sessionId })
    // → args[0] = { requestId, reply, sessionId }; opencode.mjs replyPermission expects same shape
    "opencode:permission-reply": (input) => oc.replyPermission(input),

    // preload: ipcRenderer.invoke(IPC.opencodeQuestions, sessionId?)  → args[0] = sessionId
    // Background-job children no longer surface here (BET-418 §A) — see
    // opencode:permissions above.
    "opencode:questions": async (sessionId) => oc.listQuestions(sessionId),

    // preload: ipcRenderer.invoke(IPC.opencodeQuestionReply, { requestId, answers, sessionId })
    // → opencode.mjs replyQuestion expects { requestId, answers, sessionId }
    "opencode:question-reply": (input) => oc.replyQuestion(input),

    // preload: ipcRenderer.invoke(IPC.opencodeQuestionReject, { requestId, sessionId })
    // → opencode.mjs rejectQuestion expects { requestId, sessionId }
    "opencode:question-reject": (input) => oc.rejectQuestion(input),

    // preload: ipcRenderer.invoke(IPC.opencodeModels)  → no args.
    // Model display overrides (Settings → Models → edit) are applied here so
    // every consumer of opencodeModels() — the settings table AND the composer
    // model picker — sees the same overridden name / description / context.
    "opencode:models": async () => {
      const cfg = await local.configGet();
      return oc.listModels(cfg.modelOverrides ?? {});
    },

    // BET-1244: the read-only, side-effect-free routing decision — the generic
    // routing decision for a surface. It takes the SURFACE explicitly
    // ("main" | "sub"), so the same single decision core (chooseModel — the one
    // the subagent path calls) can answer for either, and returns the decision
    // VERBATIM: { model, reason, alternatives, changed }. No state is written,
    // no prompt is sent. It never throws — on any internal failure it returns
    // the incumbent unchanged with reason "routing unavailable", so a routing
    // failure can never fail a turn (the same guarantee chooseSubagentModel
    // makes).
    "routing:choose": async (input) => {
      const incumbent = input?.incumbent ?? null;
      const agent = input?.agent ?? "general";
      const surface = input?.surface === "sub" ? "sub" : "main";
      // The entire gather + decide is one guarded unit: a failing catalogue,
      // snapshot reader, health tracker or a throwing router all degrade to the
      // incumbent-unchanged fallback below, never a throw to the caller.
      try {
        let cfg = {};
        try {
          cfg = (await local.configGet()) ?? {};
        } catch {
          cfg = {};
        }
        const policy = cfg?.modelRouting ?? {};
        let quota = [];
        try {
          quota = usageListSnapshots();
          if (!Array.isArray(quota)) quota = [];
        } catch {
          quota = [];
        }
        // BET-1244/S1c: the FILTERED catalogue. listRoutableModels is the one
        // place routing consent is computed — do not build a second filter here
        // (use routingListRoutableModels, never raw listModels / oc.listModels).
        let catalog = [];
        try {
          catalog = await routingListRoutableModels(surface, cfg);
          if (!Array.isArray(catalog)) catalog = [];
        } catch {
          catalog = [];
        }
        let services = null;
        try {
          services = await buildRoutingServices(cfg, {
            catalogIndex: routingCatalogIndex,
            endpoints: catalog,
            snapshots: quota,
            providerHealthState: routingProviderHealthState,
            endpointSummary: routingEndpointSummary,
          });
        } catch (e) {
          // 11e: a silently-degrading services build is how "no model passes
          // constraints (identity)" hides. Never fatal — routing degrading is
          // correct, degrading silently is not.
          console.error(`[router] routing services degraded, routing on absent context: ${e?.message ?? e}`);
          services = null;
        }
        // Resolve the incumbent's FULL catalog endpoint (the normalized
        // OpencodeModel with cost/capabilities) so the eligibility gate sees the
        // real endpoint, not a price-less stub. BET-1270 6e reviewer Block: a
        // stripped {providerID, id} fails autoEligibility's Price/Caching gates,
        // forcing `incumbent-ineligible` off a perfectly describable incumbent on
        // every boundary-crossing turn. Fall back to the stripped stub only when
        // the incumbent is absent from the routable catalog (genuinely not
        // routable → honestly ineligible).
        const fullIncumbent = incumbent
          ? (Array.isArray(catalog) ? catalog : []).find(
              (c) =>
                c?.providerID === incumbent.providerID &&
                String(c?.id ?? c?.modelID ?? "") === String(incumbent.modelID ?? incumbent.id ?? ""),
            ) ?? null
          : null;
        const catalogIncumbent =
          fullIncumbent ??
          (incumbent
            ? { providerID: incumbent.providerID, id: incumbent.modelID ?? incumbent.id }
            : null);
        // BET-1270 6e: the box-side facts about the incumbent the renderer
        // sent, reported back on the SAME round trip (no second fetch, no
        // renderer-held health/eligibility state). `incumbentHealthy` is false
        // when the incumbent's provider is excluded or failing; `incumbentStillEligible`
        // is the SAME completeness gate the router uses (autoEligibility), so the
        // renderer's shouldSwitch can force an ineligible/unhealthy incumbent out.
        const incumbentHealthy = !["out-of-credit", "rate-limited", "failing"].includes(
          routingProviderHealthState(incumbent?.providerID) ?? "ok",
        );
        const stillEligible = catalogIncumbent
          ? incumbentStillEligible(catalogIncumbent, services)
          : true;
        const decision = chooseModel({
          intent: {
            kind: surface === "sub" ? "subagent" : "main",
            agent,
            needs: input?.needs ?? {},
            // BET-1267 3b: the renderer sends the REAL conversation size. An
            // absent value is a caller bug — pass undefined through so the
            // headroom check skips instead of silently passing 0 (which would
            // read as "zero tokens").
            contextTokens: typeof input?.contextTokens === "number" ? input.contextTokens : undefined,
            incumbent: catalogIncumbent,
          },
          catalog,
          policy,
          nowMs: Date.now(),
          services,
        });
        // The box-side signal that routing ran (BET-1265). Always logged, no
        // debug flag: a decision nobody watches is a decision not made. Names
        // the winner, the cost basis and whether the mix was measured.
        {
          const t = decision?.trace;
          const basis = t?.winner?.cost?.basis ?? "none";
          const mix = t?.winner?.cost?.mixSource ?? "default";
          const dropped = Array.isArray(t?.dropped) ? t.dropped.reduce((s, d) => s + d.n, 0) : 0;
          const w = decision?.model;
          console.log(
            `[router] ${surface}/${agent} → ${w?.providerID ?? "-"}/${w?.id ?? "-"} · ${basis} · considered=${t?.considered ?? 0} dropped=${dropped} mix=${mix}`
          );
        }
        // On the off-path / no-survivors path chooseModel returns the very
        // catalogIncumbent reference it was handed; map that back to the
        // original structured incumbent so the decision stays byte-identical.
        // A real winner / alternative is normalised into {providerID, modelID}.
        return {
          model:
            decision?.model === catalogIncumbent
              ? incumbent
              : toDeliverModel(decision?.model ?? incumbent),
          reason: decision?.reason ?? "",
          alternatives: Array.isArray(decision?.alternatives)
            ? decision.alternatives.map(toDeliverModel).filter(Boolean)
            : [],
          changed: decision?.changed === true,
          incumbentHealthy,
          incumbentStillEligible: stillEligible,
        };
      } catch (e) {
        console.warn("[router] routing:choose failed, using incumbent:", e?.message ?? e);
        return {
          model: incumbent,
          reason: "routing unavailable",
          alternatives: [],
          changed: false,
          incumbentHealthy: true,
          incumbentStillEligible: true,
        };
      }
    },

    // BET-1244: the Accounts "Try again" action. Delegates straight to
    // providerHealth.retry (S4c), which already encodes the supported-vs-custom
    // behaviour — supported read the meter and clear only on funds; custom clear
    // optimistically with no traffic. `message` is a short factual sentence the
    // row can display and is NEVER empty: the button reports both outcomes
    // (AGENTS.md: it does the thing and says so / fails and says why).
    "accounts:retry": async (input) => {
      const providerID = typeof input?.providerID === "string" ? input.providerID.trim() : "";
      if (!providerID) {
        return { ok: false, state: "unknown", message: "No provider id given to retry." };
      }
      if (!providerHealth || typeof providerHealth.retry !== "function") {
        return {
          ok: false,
          state: "unknown",
          message: "Provider health isn't wired on this box — can't retry.",
        };
      }
      try {
        const r = await providerHealth.retry(providerID);
        const cleared = r?.cleared === true;
        const state = typeof r?.state === "string" && r.state ? r.state : "unknown";
        return {
          ok: cleared,
          state,
          message: cleared
            ? `${providerID} is back in the pool (out-of-credit flag cleared).`
            : `${providerID} still reports out of credit — check the account.`,
        };
      } catch (e) {
        return { ok: false, state: "error", message: `Retry failed: ${e?.message ?? "unknown error"}` };
      }
    },

    // BET-1250: the Accounts list's per-provider health snapshot. The renderer
    // builds its rows from usage readings + subscription status + the health
    // states below — the same providerHealth engine that gates the router, so
    // "what the UI shows" can never drift from "what blocks Auto" (one gate).
    // Degrades to {} when providerHealth isn't wired (routing inert) — never
    // throws. `retryInMs` is present only while a provider is rate-limited.
    "accounts:health": async () => {
      if (!providerHealth || typeof providerHealth.all !== "function") return {};
      const all = providerHealth.all() ?? {};
      const out = {};
      for (const [providerID, state] of Object.entries(all)) {
        const retryInMs =
          state === "rate-limited" && typeof providerHealth.retryIn === "function"
            ? providerHealth.retryIn(providerID)
            : undefined;
        out[providerID] = { state, retryInMs };
      }
      return out;
    },

    // BET-1249: the provider-agnostic model catalogue for the renderer's
    // "Models we couldn't identify" block. Read-only — the renderer builds the
    // matcher (shared modelCatalog.mjs) over the returned entries and persists
    // user declarations through configUpdate, NOT this channel. An empty box
    // catalogue is reported as { supported:false } (never thrown), matching
    // the sibling degradation contract.
    "opencode:model-catalog": async () => {
      try {
        const entries = catalogAllModels();
        return { supported: entries.length > 0, size: entries.length, entries };
      } catch {
        return { supported: false, size: 0, entries: [] };
      }
    },

    // Provider management — now served from the server (BET-82.3).
    // get-providers: read opencode.jsonc and project the configured provider
    // blocks into ProviderEndpoint[] (id/name/baseURL/hasApiKey/enabledModels),
    // which is exactly what the Settings ProvidersCard form consumes. This must
    // NOT return the raw /provider HTTP shape { all, connected, default } — that
    // object has no rows for the card to map over, so custom providers (e.g.
    // "Voska AI") would never be prefilled (BET-114).
    "opencode:get-providers": () => providers.getProviderEndpoints(),

    // discover-models: query an OpenAI-compatible endpoint's /models.
    // POSITIONAL args (baseURL, apiKey) — httpApi/preload both send
    // `rpc(channel, baseURL, apiKey)` and dispatch() spreads args, so an
    // object-destructuring handler here reads `.baseURL` off a STRING and
    // discovery silently ran against "" ("unreachable: could not reach the
    // endpoint" on every Refresh). apiKey "" = recover the stored key from
    // opencode.jsonc server-side (Refresh never re-sends the secret).
    "opencode:discover-models": (baseURL, apiKey) =>
      providers.discoverModelsForEndpoint(baseURL ?? "", apiKey ?? ""),

    // set-providers: apply upsert/remove mutations to opencode.jsonc.
    // Args: { upsert?: ProviderInput[], remove?: string[] }
    "opencode:set-providers": (input) =>
      providers.setProviders(input ?? {}),

    // get-subagents: read configured subagent blocks from opencode.jsonc.
    // Returns SubagentDef[] — the config-reading path backing the SubagentsCard.
    "opencode:get-subagents": () => providers.getSubagents(),

    // set-subagents: apply upsert/remove mutations to opencode.jsonc agent blocks.
    // Args: { upsert?: SubagentInput[], remove?: string[] }
    "opencode:set-subagents": (input) =>
      providers.setSubagents(input ?? {}),

    // sync-subagents (BET-123): reconcile the full model list against the
    // configured agent blocks + the caller's deactivated set, applying only
    // the diff via setSubagents. Args: { models: OpencodeModel[], deactivated:
    // string[] }. Returns the resulting SubagentDef[].
    "opencode:sync-subagents": (input) =>
      providers.syncSubagents(input ?? {}),

    // restart: bounce the box's own opencode systemd --user service so a
    // subagent/provider config write takes effect (opencode only re-reads the
    // `agent`/`provider` blocks at startup). Was a no-op stub pre-BET-123.
    "opencode:restart": () => restartOpencode(),

    // server-update apply (BET-225 stage 3 Part A / BET-357 §3): kick off
    // the box's self-update script (scripts/self-update.sh — git fetch +
    // reset --hard origin/main + npm ci --omit=dev + systemctl --user
    // restart manta-server). The script's final step kills this
    // manta-server process mid-run, so the child is detached via
    // `runServerSelfUpdate` rather than awaited here — the caller
    // (renderer UpdateBar) just sees the RPC promise resolve as soon as
    // execFile returns. No caller-supplied input (no injection surface);
    // script path is the module-level SELF_UPDATE_SCRIPT resolved from
    // `import.meta.url` so cwd never enters the calculation. The
    // `runServerSelfUpdate` reference comes from the `buildHandlers` deps
    // (injected by src/server/index.mjs in production; stubbed in
    // rpc.test.mjs for the regression guard) — see the comment block
    // above buildHandlers for why this isn't a module-level import.
    "server:update-apply": () => runServerSelfUpdate(SELF_UPDATE_SCRIPT),

    // preload: ipcRenderer.invoke(IPC.serverUpdateCheck) → no args.
    // Runs the update poller's own tick on demand and returns its verdict, so
    // Settings → About can answer "up to date" / "0.0.37 available" the moment
    // the user asks instead of waiting up to 30 min for the next poll. The
    // check is the poller's `runTick`, so a manual check that finds something
    // also raises the usual banner + push (deduped per version) rather than
    // reporting an update the rest of the UI knows nothing about.
    // Injected via buildHandlers deps for the same reason as
    // runServerSelfUpdate: the poller owns the state and is wired in
    // src/server/index.mjs.
    "server:update-check": async () => {
      const result = await checkServerUpdate();
      // BET-1096 stage 2: the CLI probe rides the call that already happens so
      // the box-update check gains the box-side CLI targets without a second
      // poller or channel. GUARDED: if detection throws or times out, return
      // the payload WITHOUT `targets` rather than failing the whole check — a
      // CLI probe must never be able to break the box-update check.
      if (cliDetector) {
        try {
          const targets = await withCliProbeTimeout(cliDetector.detect(), cliProbeTimeoutMs);
          if (Array.isArray(targets) && targets.length > 0) result.targets = targets;
        } catch {
          // Detection threw or timed out — return the box verdict untouched.
        }
      }
      return result;
    },

    // single-CLI update (BET-1162, server half): upgrades exactly ONE installed
    // box CLI by catalog id, reusing the cached cliDetector + shared runUpgrade
    // spawn — this is the per-row action behind the renderer's per-row split
    // (BET-1159). Delegate to the injected `upgradeCli` (src/server/cliUpdates.mjs
    // in production; stubbed in rpc.test.mjs). Unknown/blank cliId (or an
    // unwired dep) resolves `{ok:false, error:"no upgrade path"}` rather than
    // ever throwing — the renderer's per-row save button expects a clean
    // result, not a rejection.
    "server:cli-update": async (ctx) => {
      const cliId = ctx?.cliId;
      if (!upgradeCli || typeof cliId !== "string" || !cliId) {
        return Promise.resolve({ ok: false, error: "no upgrade path" });
      }
      const result = await upgradeCli(cliId);
      // A successful CLI upgrade invalidates the shared detector's 5-minute
      // cache so the next server:update-check reflects the new version
      // immediately — the UI's "Claude Code has an update available" clears
      // right away instead of lingering for the TTL.
      if (result?.ok && cliDetector?.invalidate) cliDetector.invalidate();
      return result;
    },

    // preload: ipcRenderer.invoke(IPC.opencodeDefaultModel)  → no args
    "opencode:default-model": () => oc.getDefaultModel(),

    // preload: ipcRenderer.invoke(IPC.opencodeVcsBranch, directory?)
    // → args[0] = directory (string | undefined)
    "opencode:vcs-branch": (directory) => oc.getVcsBranch(directory),

    // preload: ipcRenderer.invoke(IPC.opencodeListSessions, directory?)
    // → args[0] = directory (string | undefined)
    "opencode:list-sessions": (directory) => oc.listSessions(directory),

    // preload: ipcRenderer.invoke(IPC.opencodeCompactSession, sessionId)
    // → args[0] = sessionId (string)
    "opencode:compact-session": (sessionId) => oc.compactSession(sessionId),

    // preload: ipcRenderer.invoke(IPC.opencodeCommands)  → no args
    "opencode:commands": () => oc.listCommands(),

    // preload: ipcRenderer.invoke(IPC.opencodeAgents)  → no args
    "opencode:agents": () => oc.listAgents(),

    // preload: ipcRenderer.invoke(IPC.opencodeSessionAgent, sessionId)
    // → args[0] = sessionId; opencode.mjs getSessionAgent expects the same
    "opencode:session-agent": (sessionId) => oc.getSessionAgent(sessionId),

    // preload: ipcRenderer.invoke(IPC.opencodeFindFiles, { query, directory })
    // → args[0] = { query, directory }; opencode.mjs findFiles expects same shape
    "opencode:find-files": (input) => oc.findFiles(input),

    // BET-1023: read configured opencode references (GET /api/reference) for
    // @-mention autocomplete + the Settings list. No args.
    "opencode:references": () => oc.listReferences(),

    // BET-1023: upsert the user's opencode references through the single
    // config-write path (providers.setReferences → PATCH /global/config).
    // Args { upsert: [{ alias, path|repository, branch?, description? }],
    //        remove?: string[] } — remove is rejected (no delete semantics).
    "opencode:set-references": (input) => providers.setReferences(input ?? {}),

    // BET-698: server-side conversation search over opencode's SQLite
    // (messageSearch.mjs). Args { query, sessionIds } — sessionIds[0] is the
    // active conversation. Degrades to { supported:false } on a box that
    // hasn't taken the Node 24 runtime yet.
    // preload: ipcRenderer.invoke(IPC.opencodeSearchMessages, { query, sessionIds })
    "opencode:search-messages": (input) => searchMessages(input ?? {}),

    // BET-1219: read-only spend/latency ledger over opencode's SQLite
    // (modelLedger.mjs). Args { sinceMs } — filters assistant rows to
    // time_created >= sinceMs (default 0 = all). Measurement only: no
    // routing, no behaviour change. Degrades to { supported:false } on a
    // box that hasn't taken the Node 24 runtime yet / has no opencode.db.
    "ledger:summary": (opts) => ledgerSummary(opts ?? {}),

    // preload: ipcRenderer.invoke(IPC.opencodeRunCommand, { sessionId, command, arguments, model?, attachments? })
    // → args[0] = that object; opencode.mjs runCommand expects same shape
    "opencode:run-command": (input) => oc.runCommand(input),

    // ---- opencode: composite operations (mirror src/main/index.ts behavior) ----

    // opencode:fork-session
    // preload: ipcRenderer.invoke(IPC.opencodeForkSession, { sessionId, sessionName, windowName, cwd, messageID? })
    // desktop behavior (src/main/index.ts):
    //   1. opencodeForkSession(config, sessionId, messageID) → { id: newSessionId, ... }
    //   2. tmuxNewWindow(config, sessionName, windowName, cwd, true, newSessionId)
    //      (chatMode=true stamps @manta-session-id on the new window)
    //   3. return { newSessionId: forked.id, projects: await listProjects() }
    // mobile equivalent: oc.forkSession takes { sessionId, messageID }; then
    // we create a tmux window getting its index back, stamp it, then listProjects.
    "opencode:fork-session": async ({ sessionId, sessionName, windowName, cwd, messageID }) => {
      const forked = await oc.forkSession({ sessionId, messageID });
      const resolvedCwd = await resolveProjectCwd(sessionName, cwd);
      const windowIndex = await tmux.newWindowGetIndex(sessionName, windowName, resolvedCwd);
      await tmux.restampSessionId(sessionName, windowIndex, forked.id);
      const projects = await tmux.listProjects();
      // BET-675: refresh materialized state so the new window's delta publishes now.
      await syncState.refreshNow();
      return { newSessionId: forked.id, projects };
    },

    // opencode:clear-session
    // preload: ipcRenderer.invoke(IPC.opencodeClearSession, { sessionName, windowIndex, cwd, title })
    // desktop behavior (src/main/index.ts):
    //   1. opencodeCreateSession(config, cwd, title) → { id: newSessionId, ... }
    //   2. tmuxRestampSessionId(config, sessionName, windowIndex, newSessionId)
    //   3. return { newSessionId: sess.id, projects: await listProjects() }
    // mobile equivalent: oc.createSession({ directory, title }) then restamp.
    "opencode:clear-session": async ({ sessionName, windowIndex, cwd, title }) => {
      const directory = await resolveProjectCwd(sessionName, cwd);
      const sess = await oc.createSession({ directory, title });
      await tmux.restampSessionId(sessionName, windowIndex, sess.id);
      const projects = await tmux.listProjects();
      // BET-675: refresh materialized state so the change publishes now.
      await syncState.refreshNow();
      return { newSessionId: sess.id, projects };
    },

    // opencode:delete-session
    // preload: ipcRenderer.invoke(IPC.opencodeDeleteSession, { sessionId, sessionName, windowIndex })
    // desktop behavior (src/main/index.ts):
    //   1. opencodeDeleteSession(config, sessionId)
    //   2. tmuxKillWindow(config, sessionName, windowIndex).catch(() => {})
    //   3. return listProjects()
    // mobile equivalent: oc.deleteSessionRaw(sessionId) then tmux.killWindow.
    "opencode:delete-session": async ({ sessionId, sessionName, windowIndex }) => {
      await oc.deleteSessionRaw(sessionId);
      await tmux.killWindow({ sessionName, windowIndex }).catch(() => {});
      const projects = await tmux.listProjects();
      // BET-675: refresh materialized state so the removed window publishes now.
      await syncState.refreshNow();
      return projects;
    },

    // BET-421: bare session lifecycle for the onboarding verifier. create
    // makes a fresh opencode session in `directory` (no tmux window, no
    // project) — mirrors the throwaway session generateSessionTitle uses.
    // deleteRaw drops it by id alone (no tmux window to kill). Together
    // they let the verifier probe the box and leave nothing behind.
    "opencode:create-ephemeral-session": async ({ directory, title }) => {
      try {
        const sess = await oc.createSession({ directory, title });
        return { ok: true, sessionId: sess.id };
      } catch (e) {
        return { ok: false, error: e?.message ? String(e.message) : String(e) };
      }
    },
    "opencode:delete-session-raw": async (sessionId) => {
      try {
        await oc.deleteSessionRaw(sessionId);
        return { ok: true };
      } catch {
        // Best-effort — a session that failed to create, or one already
        // reaped, must not fail the verify flow's cleanup.
        return { ok: true };
      }
    },

    // opencode:generate-title
    // Auto-rename: throwaway-session title generation. Mirror of desktop
    // IPC.opencodeGenerateTitle. Returns the RAW model reply (caller sanitizes).
    "opencode:generate-title": ({ directory, instruction }) =>
      oc.generateSessionTitle({ directory, instruction }),

    // ---- subscription provider auth (BET-308 / BET-309) ----
    // Single discriminated channel: status / start / code / key / disconnect.
    //   "status"      → GET /provider + subscriptionStatuses()
    //   "start"       → GET /provider/auth + resolveAuthMethod + startProviderOauth
    //                   (returns api-key shape when nothing resolved — Kimi
    //                    path has no OAuth methods to resolve to)
    //   "code"        → POST /provider/{id}/oauth/callback
    //   "key"         → PUT /auth/{id} {type:"api", key} (Kimi)
    //   "disconnect"  → DELETE /auth/{id}
    // Policy lives in src/server/subscriptionProviders.mjs; this handler is
    // the wire. The `key` action carries an API-key secret renderer → box
    // and the server returns {ok} only — never the key itself, not in the
    // return value and not in any log line.
    "opencode:provider-auth": async (req) => {
      const action = req?.action;
      if (action === "status") {
        const { connected } = await oc.getProviders();
        return {
          action: "status",
          providers: subscriptionProviders.subscriptionStatuses(connected),
        };
      }
      if (action === "start") {
        const id = String(req?.id ?? "");
        const entry = subscriptionProviders.findSubscriptionProvider(id);
        if (!entry) {
          console.warn(
            `[provider-auth] ${id}: not a known subscription provider — falling back to the API-key form`,
          );
          return { action: "start", shape: "api-key" };
        }
        const auth = await oc.listProviderAuthMethods();
        const methods =
          auth?.ok && auth.methods && typeof auth.methods === "object"
            ? auth.methods[id]
            : null;
        const resolved = subscriptionProviders.resolveAuthMethod(entry, methods);
        if (!resolved) {
          // No OAuth / no usable method → the renderer switches to the
          // API-key form (Kimi path). Mirrors the "use the generic API-key
          // path" contract in resolveAuthMethod's docstring.
          //
          // For anthropic this almost always means the opencode-claude-auth
          // plugin did not load (it is what advertises the "Switch Claude
          // Code account" oauth method), so say so — this branch used to be
          // silent and the resulting API-key prompt was undiagnosable.
          console.warn(
            `[provider-auth] ${id}: no auth method resolved from ${
              methods ? `${methods.length} advertised method(s)` : "no /provider/auth entry"
            } — falling back to the API-key form`,
          );
          return { action: "start", shape: "api-key" };
        }
        const oauth = await oc.startProviderOauth(id, resolved.index);
        // A FRESH box has no ~/.claude/.credentials.json yet, and the Claude
        // auth plugin's authorize() throws when it has no account to switch
        // to (it indexes accounts[0] on an empty list). That is EXACTLY the
        // state the claude-login flow exists to resolve — it runs
        // `claude auth login` ON the box to CREATE those credentials — so
        // returning the API-key form here was a catch-22: the only path that
        // can connect a Claude subscription was unreachable until you were
        // already connected. Every fresh box hit it.
        //
        // So do not bail on a failed authorize. Ask describeConnectShape with
        // a null authorize response: for anthropic + a resolved oauth method
        // it yields "claude-login" (pinned by
        // `describeConnectShape(r, null, "anthropic")` in
        // subscriptionProviders.test.mjs). A provider that genuinely has no
        // OAuth to offer still falls through to the key form below.
        const authorize = oauth?.ok ? oauth : null;
        const shape = subscriptionProviders.describeConnectShape(
          resolved,
          authorize,
          id,
        );
        if (!authorize && shape !== "claude-login") {
          console.warn(
            `[provider-auth] ${id}: authorize failed (${
              oauth?.error ?? "no response"
            }) and shape=${shape} — falling back to the API-key form`,
          );
          return { action: "start", shape: "api-key" };
        }
        // BET-354: when describeConnectShape returns "claude-login", we
        // also need to spawn `claude auth login` on the box. The renderer
        // will drive it via the existing pty bus + the new
        // `claude:login-status` channel. We return the sessionKey + the
        // generated startedAt so the renderer can show a live terminal
        // pane and the poller can detect completion via file mtime.
        if (shape === "claude-login") {
          return await startClaudeLogin(id);
        }
        // oauth-auto (Codex headless): opencode's callback blocks until the
        // user approves on the device page. Fire it detached and let the
        // renderer poll the outcome via `oauth-status`.
        if (shape === "oauth-auto") startOauthCallback(oc, id, resolved.index);
        return {
          action: "start",
          shape,
          url: authorize?.url || undefined,
          instructions: authorize?.instructions || undefined,
          methodIndex: resolved.index,
        };
      }
      if (action === "code") {
        const id = String(req?.id ?? "");
        const methodIndex = Number(req?.methodIndex ?? -1);
        const code = String(req?.code ?? "");
        if (!Number.isInteger(methodIndex) || methodIndex < 0 || !code) {
          return { action: "code", ok: false, error: "bad_response" };
        }
        const r = await oc.completeProviderOauth(id, methodIndex, code);
        return { action: "code", ok: !!r?.ok, error: r?.ok ? undefined : r?.error };
      }
      if (action === "oauth-status") {
        const id = String(req?.id ?? "");
        const result = subscriptionProviders.classifyOauthCallback(
          _oauthCallbacks.get(id),
          Date.now(),
        );
        if (result.state !== "pending") _oauthCallbacks.delete(id);
        return { action: "oauth-status", ...result };
      }
      if (action === "key") {
        const id = String(req?.id ?? "");
        const key = String(req?.key ?? "");
        if (!key) {
          return { action: "key", ok: false, error: "bad_response" };
        }
        const r = await oc.setProviderApiKey(id, key);
        return { action: "key", ok: !!r?.ok, error: r?.ok ? undefined : r?.error };
      }
      if (action === "disconnect") {
        const id = String(req?.id ?? "");
        const r = await oc.removeProviderAuth(id);
        return {
          action: "disconnect",
          ok: !!r?.ok,
          error: r?.ok ? undefined : r?.error,
        };
      }
      // BET-354: Claude login status check. The renderer's connect card
      // polls this on its 1s tick while in the claude-login phase; the
      // server handles the file-stat + opencode-restart + connected-poll
      // logic and returns a structured progress object. The renderer
      // never restarts opencode itself for Claude — the issue's hard rule
      // ("call restartOpencode() unconditionally after the credentials file
      // appears") is enforced here.
      if (action === "claude-status") {
        const sessionKey = String(req?.sessionKey ?? "");
        const startedAt = Number(req?.startedAt ?? NaN);
        const entry = _claudeLoginSessions.get(sessionKey);
        if (!entry || !Number.isFinite(startedAt)) {
          return {
            action: "claude-status",
            ok: false,
            error: "unknown_session",
          };
        }
        const progress = await pollClaudeLogin({
          startedAt,
          restartOpencode,
          getProviders: oc.getProviders,
          // BET-359: plumb the snapshot taken at startClaudeLogin into
          // the completion-side validator. null when the connect flow
          // started against a fresh box (nothing to back up) — pollClaudeLogin
          // routes that through `restoreFromBackup`'s no-backup branch,
          // which is a correct no-op rather than an error.
          backupPath: entry?.backupPath ?? null,
        });
        return { action: "claude-status", ok: true, progress };
      }
      // Unknown action — surface as a generic failure so the renderer's
      // typed result narrows correctly without throwing across the wire.
      return { action: "status", providers: [] };
    },

    // BET-354: explicitly cancel a Claude login session. The renderer calls
    // this when the user closes the connect card (×/Cancel) or retries after
    // a failure. The pty is killed and removed from the registry so a
    // subsequent start generates a fresh sessionKey.
    "claude:login-cancel": (sessionKey) => {
      const key = String(sessionKey ?? "");
      cancelClaudeLogin(key);
      return { ok: true };
    },
    // BET-421 §E: is the `claude` CLI installed on this box? The connect
    // card asks before sign-in so it can run the lazy installer when it
    // isn't. Pure probe over resolveClaudeBin — never spawns anything.
    "opencode:claude-cli-status": () => claudeCliStatus(),    // ---- scheduled prompts (manta-server owned; in-process on mobile) ----
    // Mirror of desktop IPC.scheduleList / scheduleDelete. The store + firing
    // loop live in src/server/schedule.mjs; these just read/mutate it. Delete
    // publishes schedule.updated so the ScheduledTasksCard refetches live.
    // preload: ipcRenderer.invoke(IPC.scheduleList, sessionId)  → args[0] = sessionId?
    "schedule:list": (sessionId) => scheduleListJobs(sessionId || undefined),
    // preload: ipcRenderer.invoke(IPC.scheduleDelete, id)  → args[0] = id
    "schedule:delete": (id) =>
      scheduleDeleteJob(id, { publish: (evt) => bus.publish(evt) }),
    // BET-739: the usage escalation actions ("remind / keep going at reset")
    // create one-shot jobs from the renderer through this channel — same store,
    // same poller, same ⏰ card. Returns { ok, job?, error? }.
    "schedule:create": (input) =>
      scheduleCreateJob(input || {}, { publish: (evt) => bus.publish(evt) }),

    // ---- subscription plan usage (manta-server owned; BET-737) ----
    // Read-only: returns the current UsageSnapshot[] cache maintained by the
    // usage poller started in src/server/index.mjs (startUsagePoller). The
    // poller also publishes `usage.updated` on the bus whenever the snapshot
    // set actually changes — this channel is for the initial paint / refetch.
    // preload: ipcRenderer.invoke(IPC.usageList)  → no args
    "usage:list": () => usageListSnapshots(),

    // ---- usage-stop record (manta-server owned; BET-1047 stage 1) ----
    // Durable box-side record of conversations stopped by a plan-usage limit.
    // The store + enrolment path live in src/server/stoppedStore.mjs +
    // usageStopEnroll.mjs; these channels read/mutate it. Mutations publish
    // `usage-stopped.updated` so the indicator + modal refetch without polling.
    // Mirrors the schedule:* pattern (same store shape, same bus event).
    // preload: ipcRenderer.invoke(IPC.usageStoppedList)  → no args
    "usage-stopped:list": () => usageStoppedList(),
    // Arm an entry for resume (keeps it listed, marks it armed).
    "usage-stopped:arm": (conversation) =>
      usageStoppedArm({ conversation }, { publish: (evt) => bus.publish(evt) }),
    // Disarm = modal uncheck = an explicit "no" → removes the row.
    "usage-stopped:disarm": (conversation) =>
      usageStoppedDisarm({ conversation }, { publish: (evt) => bus.publish(evt) }),
    // Stamp the list-level "last looked" timestamp (modal close).
    "usage-stopped:stamp-last-looked": () =>
      usageStoppedStampLastLooked({}, { publish: (evt) => bus.publish(evt) }),
    // Clear a row because the conversation ran successfully.
    "usage-stopped:mark-ran": (conversation) =>
      usageStoppedMarkRan({ conversation }, { publish: (evt) => bus.publish(evt) }),

    // ---- per-session model prefs (manta-server owned; BET-1279) ----
    // Durable box-side record of per-conversation model selection (provider+
    // model, variant, fast flavour) + the recent-choices list, so the same
    // conversation opened on a second device has the same model. The store +
    // logic live in src/server/modelPrefs.mjs; these channels read/mutate it.
    // Mutations publish `model-prefs.updated` ({sessionId} hint) so clients
    // refetch without polling. seed is the one-shot non-destructive migration.
    // preload: ipcRenderer.invoke(IPC.modelPrefsGet)  → no args
    "model-prefs:get": () => modelPrefsGetStore(),
    // preload: ipcRenderer.invoke(IPC.modelPrefsSet, { sessionId?, selection?, recents? })
    "model-prefs:set": (input) =>
      modelPrefsSetStore(input ?? {}, { publish: (evt) => bus.publish(evt) }),
    // preload: ipcRenderer.invoke(IPC.modelPrefsSeed, { sessions?, recents? })
    "model-prefs:seed": (input) =>
      modelPrefsSeedStore(input ?? {}, { publish: (evt) => bus.publish(evt) }),

    // ---- background jobs (manta-server owned; in-process on mobile) ----
    // Mirror of the /api/delegate REST surface for the renderer. Jobs are
    // CREATED by the AI tool, and — since BET-795 — by the work inbox's
    // "Delegate in background" row action, which routes through the SAME
    // engine (createDelegateEngine wired in src/server/index.mjs) as the
    // REST surface. Start goes through `startJob` exactly as the REST POST
    // does; an inbox delegation declares no tools, so no pre-flight approval
    // card is raised. list/stop/delete route to the engine too. Stop/delete
    // publish delegate.updated so a future UI card refetches live.
    // preload: ipcRenderer.invoke(IPC.delegateList, sessionId) → args[0] = sessionId?
    "delegate:list": (sessionId) =>
      delegate ? delegate.listJobs({ sessionID: sessionId || undefined }) : { jobs: [] },
    // preload: ipcRenderer.invoke(IPC.delegateStop, id) → args[0] = id
    "delegate:stop": (id) => (delegate ? delegate.stopJob(id) : { ok: false, error: "no engine" }),
    // preload: ipcRenderer.invoke(IPC.delegateDelete, id) → args[0] = id
    "delegate:delete": (id) => (delegate ? delegate.deleteJob(id) : { ok: false, error: "no engine" }),
    // preload: ipcRenderer.invoke(IPC.delegateStart, input) → args[0] = { prompt, sessionID, directory, model? }
    // BET-795 inbox "Delegate in background": starts a background job through
    // the existing delegate engine (own worktree + branch + rail row) instead
    // of a foreground session. Same engine, same store, same completion path.
    "delegate:start": (input) => {
      const i = typeof input === "object" && input !== null ? input : {};
      if (!delegate) return { ok: false, error: "no engine" };
      const startArgs = {
        prompt: i.prompt,
        model: i.model,
        parentSessionID: i.sessionID,
        parentDirectory: i.directory,
      };
      if (i.subagent_type) startArgs.subagent_type = i.subagent_type;
      return delegate.startJob(startArgs);
    },

    // ---- session progress (manta-server owned; BET-790) ----
    // Read-only: the durable progress record for a session (written by the AI's
    // progress_report tool → POST /api/progress). The renderer's job card also
    // gets it on the delegate job object; this channel is the general read.
    // preload: ipcRenderer.invoke(IPC.progressGet, sessionId) → args[0] = sessionId
    "progress:get": (sessionID) =>
      progress ? progress.getRecord(sessionID || undefined) : null,

    // ---- background job pre-flight approvals (BET-418 §A) ----
    // The renderer polls pending-approvals for the viewed parent session and
    // shows ONE approval card (Start / Edit access / Not now) before the job
    // is created. approve carries optional edited tools; decline cancels.
    "delegate:pending-approvals": (sessionId) =>
      delegate ? delegate.listPendingApprovals(sessionId || undefined) : [],
    "delegate:approve": (input) =>
      delegate
        ? { ok: delegate.approve(input?.id, input?.tools) }
        : { ok: false },
    "delegate:decline": (id) =>
      delegate ? { ok: delegate.decline(id) } : { ok: false },

    // ---- secrets (manta-server owned; in-process on mobile) ----
    // Mirror of desktop IPC.secretsList / secretsSet / secretsDelete. The store
    // lives in src/server/secrets.mjs; the UI never sees secret VALUES — list
    // returns metadata only. Mutations publish secrets.updated so the
    // SecretsCard refetches live. There is no `provide` channel here: providing
    // a secret to an agent is the opencode-tool path (POST /api/secrets/provide),
    // never a UI action.
    // preload: ipcRenderer.invoke(IPC.secretsList, sessionId, all) → args = [sessionId?, all?]
    "secrets:list": async (sessionId, all) => {
      const project = all ? null : await resolveProjectName(sessionId);
      return secretsListStore({ sessionID: sessionId || undefined, project, includeAll: !!all });
    },
    // preload: ipcRenderer.invoke(IPC.secretsSet, input) → args[0] = {key,value,scope,sessionID,project,hint}
    "secrets:set": async (input) => {
      const i = input ?? {};
      let project = i.project || null;
      if (i.scope === "project" && !project) project = await resolveProjectName(i.sessionID);
      return secretsSetStore({ ...i, project }, { publish: (evt) => bus.publish(evt) });
    },
    // preload: ipcRenderer.invoke(IPC.secretsDelete, id) → args[0] = id
    "secrets:delete": (id) =>
      secretsDeleteStore(id, { publish: (evt) => bus.publish(evt) }),

    // ---- inbound webhooks (manta-server owned; in-process on mobile) ----
    // Mirror of desktop IPC.webhookList / webhookDelete. The registry + public
    // delivery route live in src/server/webhooks.mjs; these just read/mutate it.
    // list returns metadata only (no signing secret); creation is the AI's job
    // via the global `webhook` opencode tool. Delete publishes webhook.updated.
    // preload: ipcRenderer.invoke(IPC.webhookList, sessionId) → args[0] = sessionId?
    "webhook:list": (sessionId) => webhookListHooks(sessionId || undefined),
    // preload: ipcRenderer.invoke(IPC.webhookDelete, id) → args[0] = id
    "webhook:delete": (id) =>
      webhookDeleteHook(id, { publish: (evt) => bus.publish(evt) }),

    // ---- published serve-page registry (manta-server owned; read-only) ----
    // The box already records every page `serve_page` publishes (tagged with
    // the opencode session that created it); this exposes that registry so the
    // artifacts panel can render it. No write counterpart — pages are
    // published/stopped by the AI's global `serve_page`/`stop_page` opencode
    // tools (POST /api/serve-page), not by a UI channel. `publicBaseUrl`
    // reads ~/.manta/auth.json fresh per call, so the list's `url` fields stay
    // correct even if the box's gateway host was provisioned after boot.
    "serve-page:list": async () => servePageListStore({ baseUrl: publicBaseUrl() }),

    // Read-only live listing of the box's outbox (~/.manta-outbox) scoped to
    // the given opencode session, so the artifacts panel's Files tab shows
    // only the active conversation's agent-pushed files alongside user
    // uploads. No write counterpart here — files land via the `send_file` tool
    // (POST /api/outbox/push — see index.mjs). Non-destructive: entries expire
    // via the box's TTL sweep, not on download.
    "outbox:list": async (sessionId) => {
      const list = await listOutbox();
      const sid = typeof sessionId === "string" && sessionId ? sessionId : null;
      return sid ? list.filter((r) => r.sessionID === sid) : list;
    },

    // ---- APNs native-push registration (BET-181) ----
    // iOS Capacitor app registers its APNs device token via the renderer-side
    // 6-site wiring (window.api.pushRegisterApns(token)). Same single
    // source-of-truth as the bare /push/register-apns HTTP route — both call
    // push.addApnsToken so the device-token registry doesn't diverge by
    // transport. De-dupe is handled inside addApnsToken (upsert on token).
    // preload: ipcRenderer.invoke(IPC.pushRegisterApns, token) → args[0] = token
    "push:register-apns": (token) => push.addApnsToken(token),

    // ---- auth pairing code mint (BET-161) ----
    // Mint a one-time mobile pairing code. Runs in-process on the box, so it
    // satisfies the loopback-only minting invariant that the GET /auth/pair
    // HTTP endpoint enforces (a remote httpApi caller can't hit that endpoint
    // — it 403s non-loopback). authEngine.pair() returns snake_case;
    // translate to the camelCase AuthPairResult the renderer expects.
    "auth:pair": async () => {
      try {
        const r = await authPair();
        return {
          ok: true,
          pairingCode: r.pairing_code,
          boxId: r.box_id,
          expiresAt: r.expiresAt,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ---- server version (BET-180, BET-225 stage 2, BET-428) ----
    // Returns the cached package.json version (read once at startup, same
    // value the GET /api/version REST route returns). The renderer hits this
    // channel via window.api.getServerVersion() so it doesn't have to do an
    // HTTP round-trip just to render "Server vX.Y.Z" under the URL field in
    // MobileSettings. Also includes `minClient` so the version-skew guard
    // (BET-225 stage 3, renderer side) can compute `isClientTooOld` from a
    // single response — no second poll, no parallel endpoint. BET-428 added
    // `opencodeVersion` (the box's `opencode --version`, read once at startup)
    // so Settings → About renders it in the same trip — no new IPC channel.
    // The JSON-RPC envelope wraps the body as
    // { result: { version, minClient, opencodeVersion } }.
    "server:version": () => ({ version: serverVersion, minClient: MIN_CLIENT, opencodeVersion }),

    // ---- plugins (BET-189 / BET-190) ----
    // Read the current plugin registry the Mac executor has published.
    // Mirrors the GET /api/plugins/registry REST route — both call the
    // same plugins.getRegistry() so the in-memory registry stays single-
    // source-of-truth regardless of transport. Settings → Plugins tab
    // polls every 10s while open.
    "plugins:registry": () => pluginsGetRegistry(),

    // ---- pty channels (4 channels) ----
    //
    // BET-138: the pty is a shell-in-cwd (or AI CLI TUI launch), not a tmux
    // attach — keyed by sessionKey (`${opencodeSessionId}:${modeId}`), not
    // projectName. See src/server/pty.mjs.
    //
    // BET-346: SpawnOptions now also accepts `tmuxTarget?: string`. When
    // set, the server spawns `tmux attach-session -t <target>` instead,
    // letting Manta open a pre-existing tmux window (one it did not create).
    // `tmuxTarget` wins over `launcher`; nothing sets it yet (renderer
    // follow-up is a separate issue).
    //
    // IPC.ptySpawn   = "pty:spawn"   preload: ipcRenderer.invoke(IPC.ptySpawn, opts)
    //   → args[0] = SpawnOptions { sessionKey, cwd, cols, rows, launcher?, tmuxTarget? }
    //   Side-effect: data/exit events flow to bus as { kind:"pty", payload: PtyEvent }
    //   where PtyEvent = { kind:"data"|"exit", sessionKey, data? / code? }
    //   (matches src/shared/types.ts PtyEvent)
    "pty:spawn": (opts) =>
      pty.spawn(opts, (e) => bus.publish({ kind: "pty", payload: e })),

    // IPC.ptyWrite   = "pty:write"   preload: ipcRenderer.invoke(IPC.ptyWrite, sessionKey, data)
    //   → args[0] = sessionKey, args[1] = data
    "pty:write": (sessionKey, data) => pty.write(sessionKey, data),

    // IPC.ptyResize  = "pty:resize"  preload: ipcRenderer.invoke(IPC.ptyResize, sessionKey, cols, rows)
    //   → args[0] = sessionKey, args[1] = cols, args[2] = rows
    "pty:resize": (sessionKey, cols, rows) => pty.resize(sessionKey, cols, rows),

    // IPC.ptyKill    = "pty:kill"    preload: ipcRenderer.invoke(IPC.ptyKill, sessionKey)
    //   → args[0] = sessionKey
    "pty:kill": (sessionKey) => pty.kill(sessionKey),

    // ---- launcher availability (BET-138 refinement, BET-310) ----
    // IPC.launchersList = "launchers:list" — which AI CLI TUIs (see
    // src/server/launcherRegistry.mjs) are available on this box right now:
    // binary on PATH. Cheap; the renderer fetches on active-session change,
    // no polling.
    "launchers:list": () => launchers.listAvailableLaunchers(),
  };
}

// POST /rpc/<channel>  body: {"args":[...]}  ->  {"result":...} | {"error":"..."}
/** Below this, gzip costs more (CPU + header bytes) than it saves. */
export const GZIP_MIN_BYTES = 1024;

/** Does this request's Accept-Encoding allow a gzipped response? */
export function acceptsGzip(header) {
  return typeof header === "string" && /(^|[,\s])gzip\b/i.test(header);
}

export async function handleRpcRequest(handlers, channel, req, res) {
  let body = "";
  let responded = false;

  // A transcript is highly repetitive JSON and compresses ~8-10×. It was going
  // over the wire raw, which on a phone off Wi-Fi is most of the wait to open
  // a session. Only the /rpc path is compressed — never /events (SSE must not
  // be buffered) and never /pty.
  function sendJson(status, payload) {
    if (responded) return;
    responded = true;
    const json = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    };
    const raw = Buffer.from(json, "utf8");
    if (raw.length >= GZIP_MIN_BYTES && acceptsGzip(req.headers?.["accept-encoding"])) {
      let gz;
      try {
        gz = gzipSync(raw);
      } catch {
        gz = null; // never fail a response over compression
      }
      if (gz) {
        headers["content-encoding"] = "gzip";
        headers["vary"] = "accept-encoding";
        res.writeHead(status, headers);
        res.end(gz);
        return;
      }
    }
    res.writeHead(status, headers);
    res.end(raw);
  }

  req.on("error", (err) => {
    sendJson(400, { error: String(err) });
  });

  req.on("data", (c) => (body += c));

  req.on("end", async () => {
    try {
      const { args = [] } = body ? JSON.parse(body) : {};
      const result = await dispatch(handlers, channel, args);
      sendJson(200, { result: result ?? null });
    } catch (e) {
      sendJson(500, { error: String(e?.message ?? e) });
    }
  });
}
