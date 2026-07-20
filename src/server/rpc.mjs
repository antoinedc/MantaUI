// Channel -> handler dispatch. Handlers are async (...args) => result.
// Mirrors Electron ipcMain.handle semantics.

import { transcribeAudio, classifyVoiceCommand } from "../shared/groq.mjs";
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
import { restartOpencode } from "./opencodeAdmin.mjs";
import { addApnsToken } from "./push.mjs";
import { getRegistry as pluginsGetRegistry } from "./plugins.mjs";

export async function dispatch(handlers, channel, args) {
  const fn = handlers[channel];
  if (!fn) throw new Error(`unknown rpc channel: ${channel}`);
  return fn(...args);
}

// Build the full handler map. Accepts { tmux, oc, pty, bus, local, authPair, push, serverVersion } where:
//   tmux          — src/server/tmux.mjs namespace
//   oc            — src/server/opencode.mjs namespace
//   pty           — src/server/pty.mjs namespace
//   bus           — event bus created by createBus() in events.mjs
//   local         — src/server/local.mjs namespace (git/fs/config/clipboard stubs)
//   authPair      — () => authEngine.pair(); the `auth:pair` channel wraps it.
//   push          — src/server/push.mjs namespace (BET-181: APNs token registration dispatch).
//   serverVersion — string, package.json `version` read once at startup (same
//                   value `GET /api/version` returns). The `server:version`
//                   channel returns it in-process so the renderer avoids an
//                   HTTP round-trip on every Settings mount.
// Channel key strings MUST match IPC.* values in src/shared/types.ts.
// Arg shapes MUST match what src/preload/index.ts packs per channel.
export function buildHandlers({ tmux, oc, pty, bus, local, authPair, push, serverVersion }) {
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

  // Resolve a caller's bui project (tmux session) name from its opencode
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

    // preload: ipcRenderer.invoke(IPC.projectMetaUpsert, meta)  → args[0] = meta (ProjectMeta)
    "project:meta:upsert": (meta) => local.projectMetaUpsert(meta),

    // preload: ipcRenderer.invoke(IPC.projectMetaDelete, tmuxSession)  → args[0] = tmuxSession (string)
    "project:meta:delete": (tmuxSession) => local.projectMetaDelete(tmuxSession),

    // preload: ipcRenderer.invoke(IPC.gitListWorktrees, cwd)  → args[0] = cwd (string)
    "git:list-worktrees": (cwd) => local.gitListWorktrees(cwd),

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
    // same trust model as the rest of bui's credentials.
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
    "tmux:new-session": async (i) =>
      tmux.newSession({ ...i, cwd: await resolveProjectCwd(i.name, i.cwd), oc }),
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
    "opencode:permissions": (sessionId) => oc.listPermissions(sessionId),

    // preload: ipcRenderer.invoke(IPC.opencodePermissionReply, { requestId, reply, sessionId })
    // → args[0] = { requestId, reply, sessionId }; opencode.mjs replyPermission expects same shape
    "opencode:permission-reply": (input) => oc.replyPermission(input),

    // preload: ipcRenderer.invoke(IPC.opencodeQuestions, sessionId?)  → args[0] = sessionId
    "opencode:questions": (sessionId) => oc.listQuestions(sessionId),

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

    // preload: ipcRenderer.invoke(IPC.opencodeDefaultModel)  → no args
    "opencode:default-model": () => oc.getDefaultModel(),

    // preload: ipcRenderer.invoke(IPC.opencodeVcsBranch, directory?)
    // → args[0] = directory (string | undefined)
    "opencode:vcs-branch": (directory) => oc.getVcsBranch(directory),

    // preload: ipcRenderer.invoke(IPC.opencodeRefreshCredentials)  → no args
    "opencode:refresh-credentials": () => oc.refreshClaudeCredentials(),

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

    // ---- scheduled prompts (bui-server owned; in-process on mobile) ----
    // Mirror of desktop IPC.scheduleList / scheduleDelete. The store + firing
    // loop live in src/server/schedule.mjs; these just read/mutate it. Delete
    // publishes schedule.updated so the ScheduledTasksCard refetches live.
    // preload: ipcRenderer.invoke(IPC.scheduleList, sessionId)  → args[0] = sessionId?
    "schedule:list": (sessionId) => scheduleListJobs(sessionId || undefined),
    // preload: ipcRenderer.invoke(IPC.scheduleDelete, id)  → args[0] = id
    "schedule:delete": (id) =>
      scheduleDeleteJob(id, { publish: (evt) => bus.publish(evt) }),

    // ---- secrets (bui-server owned; in-process on mobile) ----
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

    // ---- inbound webhooks (bui-server owned; in-process on mobile) ----
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

    // ---- server version (BET-180) ----
    // Returns the cached package.json version (read once at startup, same
    // value the GET /api/version REST route returns). The renderer hits this
    // channel via window.api.getServerVersion() so it doesn't have to do an
    // HTTP round-trip just to render "Server vX.Y.Z" under the URL field in
    // MobileSettings. Returns the snake_case payload the renderer expects;
    // the JSON-RPC envelope wraps it as { result: { version } }.
    "server:version": () => ({ version: serverVersion }),

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
    // IPC.ptySpawn   = "pty:spawn"   preload: ipcRenderer.invoke(IPC.ptySpawn, opts)
    //   → args[0] = SpawnOptions { sessionKey, cwd, cols, rows, launcher? }
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

    // ---- launcher availability (BET-138 refinement) ----
    // IPC.launchersList = "launchers:list" — which AI CLI TUIs (see
    // src/server/launcherRegistry.mjs) are available on this box right now:
    // binary on PATH AND (if the launcher declares one) opencode reports its
    // provider connected. Cheap; the renderer fetches on active-session
    // change, no polling.
    "launchers:list": () =>
      launchers.listAvailableLaunchers({ getProviders: providers.getProviders }),
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
