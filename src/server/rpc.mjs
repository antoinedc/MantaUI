// Channel -> handler dispatch. Handlers are async (...args) => result.
// Mirrors Electron ipcMain.handle semantics.

import { transcribeAudio, classifyVoiceCommand } from "../shared/groq.mjs";

export async function dispatch(handlers, channel, args) {
  const fn = handlers[channel];
  if (!fn) throw new Error(`unknown rpc channel: ${channel}`);
  return fn(...args);
}

// Build the full handler map. Accepts { tmux, oc, pty, bus, local } where:
//   tmux  — src/server/tmux.mjs namespace
//   oc    — src/server/opencode.mjs namespace
//   pty   — src/server/pty.mjs namespace
//   bus   — event bus created by createBus() in events.mjs
//   local — src/server/local.mjs namespace (git/fs/config/clipboard stubs)
// Channel key strings MUST match IPC.* values in src/shared/types.ts.
// Arg shapes MUST match what src/preload/index.ts packs per channel.
export function buildHandlers({ tmux, oc, pty, bus, local }) {
  // Mirror of resolveProjectCwd() in src/main/index.ts. Renderer-supplied cwd
  // is preferred when it's a real path, but falls through to the project's
  // stored defaultCwd whenever the renderer sends nothing or the literal "~".
  // opencode's session.create requires an absolute directory; per-pane
  // paneCurrentPath can drift (or be empty for fresh chat-holder panes), so
  // the workspace's defaultCwd is the canonical "where this project lives".
  async function resolveProjectCwd(sessionName, inputCwd) {
    const trimmed = typeof inputCwd === "string" ? inputCwd.trim() : "";
    if (trimmed && trimmed !== "~") return trimmed;
    const cfg = await local.configGet();
    const meta = cfg.projects?.find((p) => p.tmuxSession === sessionName);
    return (meta?.defaultCwd ?? "").trim() || trimmed || "~";
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

    // preload: ipcRenderer.invoke(IPC.transportInfo)  → no args
    "transport:info": () => local.transportInfo(),

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

    // Setup wizard — desktop-only feature today. Mobile server runs
    // locally on the box (no SSH hop), so the wizard's "ssh → tmux →
    // opencode → auth" probe doesn't map onto its environment. We
    // return allOk:false with explanatory n/a details so the UI shows
    // "not applicable" rather than silently lying "all green" if a user
    // ever opens Settings on mobile.
    "setup:probe": () => ({
      checks: [
        { name: "ssh", ok: false, detail: "n/a — mobile server runs locally on the box" },
        { name: "tmux", ok: false, detail: "n/a — desktop-only wizard" },
        { name: "opencode", ok: false, detail: "n/a — desktop-only wizard" },
        { name: "opencodeAuthPlugin", ok: false, detail: "n/a — desktop-only wizard" },
        { name: "anthropicAuth", ok: false, detail: "n/a — desktop-only wizard" },
      ],
      allOk: false,
    }),
    "setup:bootstrap": () => ({
      ok: false,
      log: ["Bootstrap is a desktop-only feature. Run the wizard from the bui Mac app."],
    }),

    // ---- voice (Groq STT + lightweight classifier) ----
    //
    // Same channel names + payload shapes as the desktop IPC, so the
    // renderer code is identical. API key + model overrides come from the
    // mobile-server config (~/.bui-mobile/config.json). Stored plaintext —
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

    // ---- tmux (8 channels, unchanged) ----
    "tmux:list": () => tmux.listProjects(),
    "tmux:new-session": (i) => tmux.newSession(i),
    // Resolve cwd: prefer explicit cwd in input, then fall back to the
    // project's stored defaultCwd (set when the workspace was created).
    // Without this, new chat windows opened in a workspace silently inherit
    // tmux's default cwd (usually $HOME) instead of the workspace path.
    "tmux:new-window": async (i) =>
      tmux.newWindow({ ...i, cwd: await resolveProjectCwd(i.sessionName, i.cwd) }),
    "tmux:rename-session": (i) => tmux.renameSession(i),
    "tmux:rename-window": (i) => tmux.renameWindow(i),
    "tmux:kill-session": (n) => tmux.killSession(n),
    "tmux:kill-window": (i) => tmux.killWindow(i),
    "tmux:select-window": (i) => tmux.selectWindow(i),

    // ---- opencode: simple pass-throughs ----

    // preload: ipcRenderer.invoke(IPC.opencodeMessages, sessionId)
    // → args[0] = sessionId (string)
    "opencode:messages": (sessionId) => oc.listMessages(sessionId),

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
    //      (chatMode=true stamps @bui-session-id on the new window)
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

    // ---- pty channels (4 channels) ----
    //
    // IPC.ptySpawn   = "pty:spawn"   preload: ipcRenderer.invoke(IPC.ptySpawn, opts)
    //   → args[0] = SpawnOptions { projectName, cols, rows }
    //   Side-effect: data/exit events flow to bus as { kind:"pty", payload: PtyEvent }
    //   where PtyEvent = { kind:"data"|"exit", projectName, data? / code? }
    //   (matches src/shared/types.ts PtyEvent and src/main/pty.ts emit shape)
    "pty:spawn": (opts) =>
      pty.spawn(opts, (e) => bus.publish({ kind: "pty", payload: e })),

    // IPC.ptyWrite   = "pty:write"   preload: ipcRenderer.invoke(IPC.ptyWrite, projectName, data)
    //   → args[0] = projectName, args[1] = data
    "pty:write": (projectName, data) => pty.write(projectName, data),

    // IPC.ptyResize  = "pty:resize"  preload: ipcRenderer.invoke(IPC.ptyResize, projectName, cols, rows)
    //   → args[0] = projectName, args[1] = cols, args[2] = rows
    "pty:resize": (projectName, cols, rows) => pty.resize(projectName, cols, rows),

    // IPC.ptyKill    = "pty:kill"    preload: ipcRenderer.invoke(IPC.ptyKill, projectName)
    //   → args[0] = projectName
    "pty:kill": (projectName) => pty.kill(projectName),
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
