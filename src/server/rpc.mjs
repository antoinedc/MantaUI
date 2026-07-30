// Channel -> handler dispatch. Handlers are async (...args) => result.
// Mirrors Electron ipcMain.handle semantics.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { transcribeAudio, classifyVoiceCommand } from "../shared/groq.mjs";
import { expandTilde } from "../shared/paths.mjs";
import { listJobs as scheduleListJobs, deleteJob as scheduleDeleteJob } from "./schedule.mjs";
import { listHooks as webhookListHooks, deleteHook as webhookDeleteHook } from "./webhooks.mjs";
import {
  listSecrets as secretsListStore,
  setSecret as secretsSetStore,
  deleteSecret as secretsDeleteStore,
} from "./secrets.mjs";
import { resolveWorkspace } from "./peers.mjs";
import * as providers from "./providers.mjs";
import * as launchers from "./launchers.mjs";
import * as subscriptionProviders from "./subscriptionProviders.mjs";
import { restartOpencode, runServerSelfUpdate } from "./opencodeAdmin.mjs";
import { pollClaudeLogin } from "./opencode.mjs";
import { backupClaudeCredentials, CREDENTIALS_PATH } from "./claudeAuth.mjs";
import { addApnsToken } from "./push.mjs";
import { getRegistry as pluginsGetRegistry } from "./plugins.mjs";
import { MIN_CLIENT } from "./version.mjs";

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
export function buildHandlers({
  tmux,
  oc,
  pty,
  bus,
  local,
  authPair,
  push,
  serverVersion,
  runServerSelfUpdate,
  delegate,
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
    "config:update": (patch) => local.configUpdate(patch),

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

    // preload: ipcRenderer.invoke(IPC.voiceClassifyCommand, { transcript, useLlmFallback? })
    "voice:classify-command": async (input) => {
      const cfg = await local.configGet();
      return classifyVoiceCommand({
        transcript: input?.transcript ?? "",
        apiKey: cfg.groqApiKey ?? "",
        model: cfg.voiceCommandModel,
        useLlmFallback: input?.useLlmFallback,
      });
    },

    // preload: ipcRenderer.invoke(IPC.uploadFiles, { projectName, localPaths })
    // → args[0] = { projectName, localPaths }
    // Mobile stub: returns [] because localPaths are client-device paths unknown
    // to the server. Mobile attachments use uploadBuffer (/api/upload) instead.
    "upload:files": (input) => local.uploadFiles(input),

    // ---- tmux (8 channels) ----
    "tmux:list": () => tmux.listProjects(),
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
      const projects = await tmux.newSession({ ...i, cwd, oc });
      await local
        .projectMetaUpsert({
          tmuxSession: i.name,
          defaultCwd: expandTilde(cwd),
        })
        .catch(() => {});
      return projects;
    },
    // Resolve cwd: prefer explicit cwd in input, then fall back to the
    // project's stored defaultCwd (set when the workspace was created).
    // Without this, new chat windows opened in a workspace silently inherit
    // tmux's default cwd (usually $HOME) instead of the workspace path.
    // Pass `oc` so a chatMode window creates + stamps an opencode session
    // (BET-113 regression: this used to silently drop chatMode).
    "tmux:new-window": async (i) =>
      tmux.newWindow({ ...i, cwd: await resolveProjectCwd(i.sessionName, i.cwd), oc }),
    "tmux:rename-session": (i) => tmux.renameSession(i),
    "tmux:rename-window": (i) => tmux.renameWindow(i),
    "tmux:kill-session": (n) => tmux.killSession(n),
    "tmux:kill-window": (i) => tmux.killWindow(i),
    "tmux:select-window": (i) => tmux.selectWindow(i),

    // ---- opencode: simple pass-throughs ----

    // preload: ipcRenderer.invoke(IPC.opencodeMessages, sessionId)
    // → args[0] = sessionId (string)
    "opencode:messages": (sessionId) => oc.listMessages(sessionId),

    // Reconcile == full pull on the server (no transcript cache to merge
    // against; the tail-merge win is desktop-only). Same renderer API on both.
    "opencode:messages-reconcile": (sessionId) =>
      oc.reconcileMessages(sessionId),

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
    // The job records are passed so the server can widen the filter to
    // non-terminal background-job child sessions and stamp `fromJobName`
    // (BET-380): a job's asks surface in the PARENT's panel.
    "opencode:permissions": async (sessionId) => {
      const jobs = delegate ? await delegate.cachedListJobs() : [];
      return oc.listPermissions(sessionId, jobs);
    },

    // preload: ipcRenderer.invoke(IPC.opencodePermissionReply, { requestId, reply, sessionId })
    // → args[0] = { requestId, reply, sessionId }; opencode.mjs replyPermission expects same shape
    "opencode:permission-reply": (input) => oc.replyPermission(input),

    // preload: ipcRenderer.invoke(IPC.opencodeQuestions, sessionId?)  → args[0] = sessionId
    // Job records passed so a background job's questions surface in the
    // parent's panel with `fromJobName` (BET-380) — see opencode:permissions.
    "opencode:questions": async (sessionId) => {
      const jobs = delegate ? await delegate.cachedListJobs() : [];
      return oc.listQuestions(sessionId, jobs);
    },

    // preload: ipcRenderer.invoke(IPC.opencodeQuestionReply, { requestId, answers, sessionId })
    // → opencode.mjs replyQuestion expects { requestId, answers, sessionId }
    "opencode:question-reply": (input) => oc.replyQuestion(input),

    // preload: ipcRenderer.invoke(IPC.opencodeQuestionReject, { requestId, sessionId })
    // → opencode.mjs rejectQuestion expects { requestId, sessionId }
    "opencode:question-reject": (input) => oc.rejectQuestion(input),

    // preload: ipcRenderer.invoke(IPC.opencodeModels)  → no args
    "opencode:models": () => oc.listModels(),

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

    // preload: ipcRenderer.invoke(IPC.opencodeFindFiles, { query, directory })
    // → args[0] = { query, directory }; opencode.mjs findFiles expects same shape
    "opencode:find-files": (input) => oc.findFiles(input),

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
      return tmux.listProjects();
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
          return { action: "start", shape: "api-key" };
        }
        const oauth = await oc.startProviderOauth(id, resolved.index);
        if (!oauth?.ok) {
          return {
            action: "start",
            shape: "api-key",
          };
        }
        const shape = subscriptionProviders.describeConnectShape(
          resolved,
          oauth,
          id,
        );
        // BET-354: when describeConnectShape returns "claude-login", we
        // also need to spawn `claude auth login` on the box. The renderer
        // will drive it via the existing pty bus + the new
        // `claude:login-status` channel. We return the sessionKey + the
        // generated startedAt so the renderer can show a live terminal
        // pane and the poller can detect completion via file mtime.
        if (shape === "claude-login") {
          return await startClaudeLogin(id);
        }
        return {
          action: "start",
          shape,
          url: oauth.url || undefined,
          instructions: oauth.instructions || undefined,
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
    },    // ---- scheduled prompts (manta-server owned; in-process on mobile) ----
    // Mirror of desktop IPC.scheduleList / scheduleDelete. The store + firing
    // loop live in src/server/schedule.mjs; these just read/mutate it. Delete
    // publishes schedule.updated so the ScheduledTasksCard refetches live.
    // preload: ipcRenderer.invoke(IPC.scheduleList, sessionId)  → args[0] = sessionId?
    "schedule:list": (sessionId) => scheduleListJobs(sessionId || undefined),
    // preload: ipcRenderer.invoke(IPC.scheduleDelete, id)  → args[0] = id
    "schedule:delete": (id) =>
      scheduleDeleteJob(id, { publish: (evt) => bus.publish(evt) }),

    // ---- background jobs (manta-server owned; in-process on mobile) ----
    // Mirror of the /api/delegate REST surface for the renderer. Jobs are
    // CREATED by the AI tool (Stage 3), NOT by the UI — there is deliberately
    // no `delegate:create` channel. list/stop/delete route to the engine
    // wired in src/server/index.mjs (createDelegateEngine). Stop/delete
    // publish delegate.updated so a future UI card refetches live.
    // preload: ipcRenderer.invoke(IPC.delegateList, sessionId) → args[0] = sessionId?
    "delegate:list": (sessionId) =>
      delegate ? delegate.listJobs({ sessionID: sessionId || undefined }) : { jobs: [] },
    // preload: ipcRenderer.invoke(IPC.delegateStop, id) → args[0] = id
    "delegate:stop": (id) => (delegate ? delegate.stopJob(id) : { ok: false, error: "no engine" }),
    // preload: ipcRenderer.invoke(IPC.delegateDelete, id) → args[0] = id
    "delegate:delete": (id) => (delegate ? delegate.deleteJob(id) : { ok: false, error: "no engine" }),

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
        return { ok: true, pairingCode: r.pairing_code, boxId: r.box_id, expiresAt: r.expiresAt };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ---- server version (BET-180, BET-225 stage 2) ----
    // Returns the cached package.json version (read once at startup, same
    // value the GET /api/version REST route returns). The renderer hits this
    // channel via window.api.getServerVersion() so it doesn't have to do an
    // HTTP round-trip just to render "Server vX.Y.Z" under the URL field in
    // MobileSettings. Also includes `minClient` so the version-skew guard
    // (BET-225 stage 3, renderer side) can compute `isClientTooOld` from a
    // single response — no second poll, no parallel endpoint. The
    // JSON-RPC envelope wraps the body as { result: { version, minClient } }.
    "server:version": () => ({ version: serverVersion, minClient: MIN_CLIENT }),

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
export async function handleRpcRequest(handlers, channel, req, res) {
  let body = "";
  let responded = false;

  function sendJson(status, payload) {
    if (responded) return;
    responded = true;
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(payload));
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
