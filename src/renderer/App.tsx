import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Sidebar, type SidebarHandle } from "./Sidebar";
import { Terminal } from "./Terminal";
import { ChatPanel } from "./ChatPanel";
import { Settings } from "./Settings";
import { Onboarding } from "./Onboarding";
import { useStore, flatSessions, resolveSessionOwner } from "./store";
import { resolveTransportMode } from "../shared/transport.mjs";
import { getBuiPreload } from "./preloadAccess";
import { describe as describeConnection } from "../shared/net/state.js";
import {
  type SessionMode,
  readSavedMode,
  writeSavedMode,
  resolveLauncherFlags,
} from "./chatShared";
import type { AvailableLauncher } from "../shared/types";

// mode -> the composite-key "modeId" segment used for the PTY sessionKey and
// the visitedModes tracking set. "chat" has no PTY, so it's never called with
// mode==="chat" (callers guard first).
function modeIdFor(m: SessionMode): string {
  return m === "terminal" ? "terminal" : m.slice("tui:".length);
}

export function App() {
  const {
    loaded,
    serverUrl,
    boxId,
    projects,
    activeProjectName,
    activeWindowByProject,
    setActive,
    refresh,
    applyStatusBatch,
    onboardingForced,
    finishOnboarding,
    configSnapshot,
    updatePrompt,
    setUpdatePrompt,
    connectionState,
    launcherFlags,
  } = useStore();

  // Entry gating: a fresh config (no host, no boxToken, not skipped) resolves
  // to "onboarding" → show the full-screen flow instead of the normal shell.
  // "Run setup again" (Settings) sets onboardingForced to re-show it even for
  // an already-paired/host config. SSH-mode configs (host set) NEVER onboard.
  // Gate on `loaded` so we never flash onboarding before config arrives.
  const enterOnboarding =
    loaded && (onboardingForced || resolveTransportMode(configSnapshot()) === "onboarding");
  // LATCH: once the flow is open, keep it mounted until the user explicitly
  // finishes or skips (finishOnboarding / skipOnboarding call onDone). Without
  // this, Step 1's successful pairing writes a boxToken → resolveTransportMode
  // flips to "http" → enterOnboarding goes false → App would tear the flow down
  // mid-way, and Steps 2–4 (providers/model/project) would be unreachable. The
  // latch is cleared in onDone (below), which re-reads config for the shell.
  const [onboardingLatched, setOnboardingLatched] = useState(false);
  useEffect(() => {
    if (enterOnboarding && !onboardingLatched) setOnboardingLatched(true);
  }, [enterOnboarding, onboardingLatched]);
  const showOnboarding = enterOnboarding || onboardingLatched;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sidebarRef = useRef<SidebarHandle>(null);

  // Same pattern for chat-mode windows: mount a ChatPanel for each opencode
  // session we've ever opened, keep it mounted so scroll position + in-flight
  // streaming state are preserved when switching back.
  const visitedChats = useRef<Set<string>>(new Set());
  // Active chat session id (set if active window is chat-mode, else null).
  const activeWin = activeProjectName
    ? projects
        .find((p) => p.tmuxSession === activeProjectName)
        ?.windows.find((w) => w.index === activeWindowByProject[activeProjectName])
    : null;
  const activeChatSessionId = activeWin?.opencodeSessionId ?? null;
  if (activeChatSessionId) visitedChats.current.add(activeChatSessionId);

  // Session-mode toggle (BET-138): each chat session shows Chat, a bare
  // shell-in-cwd Terminal, or an AI CLI TUI launcher (e.g. Claude Code).
  // `mode` tracks the ACTIVE chat session's current mode; other sessions'
  // last-used modes stay in localStorage (read lazily when they're
  // activated). `visitedModes` tracks every `${sessionId}:${modeId}`
  // composite key ever opened, so its Terminal is mounted lazily on first
  // use and then kept warm (mirrors visitedChats above).
  const visitedModes = useRef<Set<string>>(new Set());
  const [mode, setModeState] = useState<SessionMode>("chat");
  const [availableLaunchers, setAvailableLaunchers] = useState<AvailableLauncher[]>([]);

  // Which AI CLI TUIs (if any) this box has set up. Cheap; refetched whenever
  // the active session changes (and once on mount, since it starts null).
  // Guarded like the other httpApi-only calls in this file (onStatusEvent,
  // onAgentFileReady, ...): on a fresh/unpaired desktop boot, window.api is
  // still the raw preload OS-bridge subset (no launchersList) until the
  // http-mode transport swap in main.tsx completes — this effect runs on
  // every App render regardless of onboarding state, so it must not assume
  // the swap already happened.
  useEffect(() => {
    if (!window.api.launchersList) {
      setAvailableLaunchers([]);
      return;
    }
    window.api
      .launchersList()
      .then(setAvailableLaunchers)
      .catch(() => setAvailableLaunchers([]));
  }, [activeChatSessionId]);

  // Reset to the persisted mode whenever the active chat session changes. A
  // saved `tui:<id>` whose launcher isn't in `availableLaunchers` downgrades
  // to "chat" (readSavedMode's fallback).
  useEffect(() => {
    const m = activeChatSessionId ? readSavedMode(activeChatSessionId, availableLaunchers) : "chat";
    setModeState(m);
    if (activeChatSessionId && m !== "chat") {
      visitedModes.current.add(`${activeChatSessionId}:${modeIdFor(m)}`);
    }
  }, [activeChatSessionId, availableLaunchers]);

  const setMode = (m: SessionMode) => {
    if (activeChatSessionId) {
      writeSavedMode(activeChatSessionId, m);
      if (m !== "chat") {
        visitedModes.current.add(`${activeChatSessionId}:${modeIdFor(m)}`);
      }
    }
    setModeState(m);
  };

  // Latest projects + active session for the desktop-notification handler,
  // so its subscription doesn't churn on every render.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const activeChatRef = useRef(activeChatSessionId);
  activeChatRef.current = activeChatSessionId;

  useEffect(() => {
    // Bootstrap. In HTTP mode (paired to a bui-server) refresh() can reject
    // with AuthRequiredError when the box answers 401 — a revoked/rotated
    // box_token mid-session. Route that to the pairing screen (onboarding step
    // 1) instead of letting the app sit dead with no sessions and no
    // explanation. relaunchOnboarding() forces the full-screen flow open even
    // for an otherwise-"http" config; a successful re-claim persists a fresh
    // token and finishOnboarding() re-runs the bootstrap. SSH mode never throws
    // this (no Bearer gate), so this is a no-op there.
    refresh().catch((e: unknown) => {
      const isAuth =
        (e as { name?: string })?.name === "AuthRequiredError" ||
        (e as { status?: number })?.status === 401;
      if (isAuth) {
        void useStore.getState().relaunchOnboarding();
      }
      // Non-auth bootstrap failures (SSH unreachable, etc.) keep the existing
      // behavior — the app renders its empty/needs-config state.
    });
  }, [refresh]);

  useEffect(() => {
    if (!window.api.onStatusEvent) return;
    const off = window.api.onStatusEvent(applyStatusBatch);
    return off;
  }, [applyStatusBatch]);

  // Startup attention replay. opencode SSE is forward-only, so a chat window
  // already blocked on a question/permission when the app (re)connects never
  // re-fires question.asked/permission.asked — the sidebar dot would stay
  // dark until the user manually focuses the window. Once the projects tree
  // has chat-mode windows, query each session's live pending state and latch
  // the indicator. Keyed on the sorted set of chat session ids so it re-runs
  // when a new chat window appears (e.g. a session adopted after launch),
  // not on every projects mutation.
  const chatSessionKey = projects
    .flatMap((p) => p.windows.map((w) => w.opencodeSessionId).filter(Boolean))
    .sort()
    .join(",");
  useEffect(() => {
    if (!chatSessionKey) return;
    // runBackgroundSync fires replayChatAttention + backfillLastMessageTimes
    // together (unchanged behavior — both still run in parallel), bounding
    // each fan-out's concurrency and toggling `backgroundSyncing` for the
    // sidebar's "Syncing…" indicator (BET-135).
    void useStore.getState().runBackgroundSync();
  }, [chatSessionKey]);

  // Screenshot detection — subscribe ONCE at the app level. Every ChatPanel
  // used to register its own listener, so a single detection fanned out into
  // N toasts (one per mounted chat). Now the toast lives in the store, the
  // active ChatPanel renders it, and accept/dismiss clear it globally.
  // Routes through the typed preload accessor so it no-ops on mobile/web.
  useEffect(() => {
    const preload = getBuiPreload();
    if (!preload) return;
    const off = preload.onScreenshotDetected((ev) => {
      useStore.getState().setScreenshotToast(ev);
    });
    return off;
  }, []);

  // Agent → laptop file push. Same single-listener pattern as screenshots: a
  // file the remote AI dropped in ~/.bui-outbox/ surfaces as one global toast
  // the active ChatPanel renders. Guarded — the mobile httpApi shim doesn't
  // implement onAgentFileReady (no outbox concept when the server IS the box).
  useEffect(() => {
    if (!window.api.onAgentFileReady) return;
    const off = window.api.onAgentFileReady((ev) => {
      useStore.getState().setAgentFileToast(ev);
    });
    return off;
  }, []);

  // Auto-update: main checks for updates on launch and pushes
  // updateAvailable / updateDownloaded events to the renderer. We only care
  // about updateDownloaded (an update is ready to install) — updateAvailable
  // just means a check happened and there's something newer, but we don't
  // prompt until the download completes. The renderer stores the version
  // info in the global store so the active shell renders the "Restart to
  // update" bar. Guarded — the mobile httpApi shim's onAutoUpdate* are
  // no-ops (desktop-only feature).
  useEffect(() => {
    if (!window.api.onAutoUpdateDownloaded) return;
    const off = window.api.onAutoUpdateDownloaded((info) => {
      useStore.getState().setUpdatePrompt({
        version: info.version,
        releaseName: info.releaseName,
      });
    });
    return off;
  }, []);

  // Sidebar status for chat-mode windows. The PTY-pane poller
  // (src/main/status.ts) can't see chat-mode state — the holder pane
  // runs `sleep infinity`, so `capture-pane` returns nothing claude-
  // looking and BUSY_RE never matches. Without this subscription, chat
  // windows' sidebar dot would always be off even mid-generation, and
  // there'd be no signal at all for pending questions or permission
  // requests.
  //
  // App-level (not per-ChatPanel) so signals fire even for chat windows
  // the user hasn't visited yet this session — opencode SSE delivers
  // events for ALL active sessions on every connected directory's
  // scoped stream, not just the one the user has open.
  //
  // Driven entirely from opencode SSE events main/server already forward:
  //   - session.status{type:"busy"|"retry"} → running:true
  //   - session.status{type:"idle"} / session.idle → running:false
  //                                                  (latches "idle"
  //                                                  attention if user
  //                                                  isn't on the
  //                                                  window — same
  //                                                  logic as the poller)
  //   - question.asked   → attention "question"
  //   - question.replied / question.rejected → clear attention
  //   - permission.asked → attention "permission"
  //   - permission.replied / permission.rejected → clear attention
  //
  // chatAutoAllow suppresses permission.asked at the bus layer in
  // both transports, so the sidebar correctly stays quiet in trust
  // mode without any extra branching here.
  useEffect(() => {
    if (!window.api.onOpencodeEvent) return;
    const off = window.api.onOpencodeEvent((ev) => {
      const props = (ev.properties ?? {}) as Record<string, unknown>;
      // Running / idle / error transitions.
      if (ev.type === "session.idle" || ev.type === "session.error") {
        const sid = typeof props.sessionID === "string" ? props.sessionID : "";
        if (sid) useStore.getState().setChatRunning(sid, false);
        return;
      }
      if (ev.type === "session.status") {
        const sid = typeof props.sessionID === "string" ? props.sessionID : "";
        if (!sid) return;
        const status = props.status as { type?: string } | undefined;
        const t = status?.type;
        if (t === "busy" || t === "retry") {
          useStore.getState().setChatRunning(sid, true);
        } else if (t === "idle") {
          useStore.getState().setChatRunning(sid, false);
        }
        return;
      }
      // Question and permission lifecycle — both use `properties.sessionID`
      // (verified in chatUtils.applyQuestionEvent and the in-ChatPanel
      // handler). Treat `.asked` as latch-on, `.replied`/`.rejected`
      // as latch-off.
      if (ev.type === "question.asked") {
        const sid = typeof props.sessionID === "string" ? props.sessionID : "";
        if (sid) useStore.getState().setChatAttention(sid, "question");
        return;
      }
      if (ev.type === "permission.asked") {
        const sid = typeof props.sessionID === "string" ? props.sessionID : "";
        if (sid) useStore.getState().setChatAttention(sid, "permission");
        return;
      }
      if (
        ev.type === "question.replied" ||
        ev.type === "question.rejected" ||
        ev.type === "permission.replied" ||
        ev.type === "permission.rejected"
      ) {
        const sid = typeof props.sessionID === "string" ? props.sessionID : "";
        if (sid) useStore.getState().setChatAttention(sid, null);
        return;
      }
    });
    return off;
  }, []);

  // Desktop OS notifications. bui-server's router (push.mjs) decides WHICH
  // device(s) get a notification (no duplicates) and relays a desktop directive
  // → main → IPC here. We add the final local
  // suppression — if this window is focused AND already showing that exact
  // session, the user is looking at it, so don't pop an OS notification — then
  // show it via the Notification API and deep-link to the session on click.
  useEffect(() => {
    if (!window.api.onDesktopNotify) return;
    const off = window.api.onDesktopNotify((payload) => {
      const sid = payload.sessionId;
      if (document.hasFocus() && sid && activeChatRef.current === sid) return;
      if (typeof Notification === "undefined") return;
      const show = () => {
        try {
          const n = new Notification(payload.title || "Better UI", {
            body: payload.body || "",
            tag: payload.tag,
          });
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* no-op */
            }
            if (!sid) return;
            for (const p of projectsRef.current) {
              const w = p.windows.find((win) => win.opencodeSessionId === sid);
              if (w) {
                setActive(p.tmuxSession, w.index);
                break;
              }
            }
          };
        } catch {
          /* Notification construction can throw if permission was revoked */
        }
      };
      if (Notification.permission === "granted") show();
      else if (Notification.permission !== "denied")
        void Notification.requestPermission().then((perm) => {
          if (perm === "granted") show();
        });
    });
    return off;
  }, [setActive]);

  // Without this, dropping a file anywhere outside the terminal area causes
  // Chromium to navigate the renderer to the file:// URL.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files"))
        e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      if (e.key === "," && !e.shiftKey && !e.altKey) {
        setSettingsOpen(true);
        e.preventDefault();
        return;
      }
      // Option+Cmd+Up/Down = step through (project, window) tuples in sidebar
      // order, wrapping around at both ends.
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const flat = flatSessions(projects);
        if (flat.length === 0) return;
        const curIdx = activeProjectName
          ? flat.findIndex(
              (f) =>
                f.project.tmuxSession === activeProjectName &&
                f.window.index === activeWindowByProject[activeProjectName],
            )
          : -1;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const nextIdx =
          curIdx < 0
            ? dir === 1 ? 0 : flat.length - 1
            : (curIdx + dir + flat.length) % flat.length;
        const target = flat[nextIdx];
        if (target && nextIdx !== curIdx) {
          setActive(target.project.tmuxSession, target.window.index);
          window.api
            .tmuxSelectWindow({
              sessionName: target.project.tmuxSession,
              windowIndex: target.window.index,
            })
            .catch(() => {});
        }
        e.preventDefault();
        return;
      }
      // Cmd+N = new workspace (project)
      if ((e.key === "n" || e.key === "N") && !e.shiftKey && !e.altKey) {
        sidebarRef.current?.openNewProject();
        e.preventDefault();
        return;
      }
      // Cmd+T = new session in active project
      if ((e.key === "t" || e.key === "T") && !e.shiftKey && !e.altKey) {
        sidebarRef.current?.openNewSessionInActive();
        e.preventDefault();
        return;
      }
      // Cmd+1..9 = jump to nth (project, window) tuple in sidebar order
      if (/^[1-9]$/.test(e.key) && !e.altKey) {
        const idx = parseInt(e.key, 10) - 1;
        const flat = flatSessions(projects);
        const target = flat[idx];
        if (target) {
          setActive(target.project.tmuxSession, target.window.index);
          // Also tell tmux to switch the window so the PTY follows.
          window.api
            .tmuxSelectWindow({
              sessionName: target.project.tmuxSession,
              windowIndex: target.window.index,
            })
            .catch(() => {});
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [projects, activeProjectName, activeWindowByProject, setActive]);

  // Voice command → app-scoped action bus. ChatPanel dispatches a
  // `bui-voice-app-action` CustomEvent for actions it doesn't own
  // (switch-window / new-session / open-settings). Keeping the routing
  // here avoids drilling refs into every panel and matches how the
  // ⌘1..9 / ⌥⌘↑↓ shortcuts already work above.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ kind: string; index?: number }>).detail;
      if (!detail) return;
      if (detail.kind === "open-settings") {
        setSettingsOpen(true);
        return;
      }
      if (detail.kind === "new-session") {
        sidebarRef.current?.openNewSessionInActive();
        return;
      }
      if (detail.kind === "switch-window" && typeof detail.index === "number") {
        const flat = flatSessions(projects);
        const target = flat[detail.index - 1];
        if (!target) return;
        setActive(target.project.tmuxSession, target.window.index);
        window.api
          .tmuxSelectWindow({
            sessionName: target.project.tmuxSession,
            windowIndex: target.window.index,
          })
          .catch(() => {});
      }
    };
    window.addEventListener("bui-voice-app-action", handler as EventListener);
    return () =>
      window.removeEventListener("bui-voice-app-action", handler as EventListener);
  }, [projects, setActive]);

  const activeProject = activeProjectName
    ? projects.find((p) => p.tmuxSession === activeProjectName) ?? null
    : null;
  const activeWinName = activeProject?.windows.find(
    (w) => w.index === activeWindowByProject[activeProjectName!],
  )?.name ?? null;
  // CWD for the active (project, window). tmux's `paneCurrentPath` is always
  // absolute and follows shell-side `cd`s, so prefer it; fall back to the
  // project's configured `defaultCwd` for chat-mode holder panes that haven't
  // emitted a path yet.
  const activeCwdRaw = activeWin?.paneCurrentPath || activeProject?.defaultCwd || "";
  const activeCwd = activeCwdRaw;

  // Full-screen onboarding replaces the entire shell (no sidebar/header/footer).
  // finishOnboarding clears the force flag + re-reads config → normal shell,
  // no app restart.
  if (showOnboarding) {
    return (
      <Onboarding
        onDone={() => {
          // Clear the latch first so App drops to the normal shell once
          // finishOnboarding re-reads config (or skipOnboarding persisted the
          // opt-out). Both paths route through onDone.
          setOnboardingLatched(false);
          void finishOnboarding();
        }}
      />
    );
  }

  return (
    <div className="h-full w-full flex bg-bg text-text">
      <Sidebar ref={sidebarRef} onOpenSettings={() => setSettingsOpen(true)} />
      <main className="flex-1 flex flex-col min-w-0">
        {/* Auto-update prompt bar. Shown when main has downloaded a new
            version and is waiting for the user to restart. Positioned at the
            top of the main area so it's visible regardless of which panel
            is active. Dismissed by the × button (clears store state). */}
        {!showOnboarding && updatePrompt && (
          <div className="shrink-0 bg-accent/10 border-b border-accent/30 px-3 py-1.5 text-[12px] text-text flex items-center gap-2">
            <span className="flex-1 truncate">
              Update available:{" "}
              <span className="font-medium text-text">
                {updatePrompt.releaseName || updatePrompt.version}
              </span>
            </span>
            <button
              onClick={() => {
                void window.api.autoUpdateInstall();
              }}
              className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30 font-medium"
            >
              Restart to update
            </button>
            <button
              onClick={() => setUpdatePrompt(null)}
              className="shrink-0 text-text-faint hover:text-text leading-none"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        <div className="titlebar-drag h-10 border-b border-border flex items-center px-3 gap-2 min-w-0">
          <div className="text-xs text-text-muted flex items-center gap-2 min-w-0">
            <span className="shrink-0">
              {serverUrl
                ? (() => { try { return new URL(serverUrl).hostname; } catch { return serverUrl; } })()
                : boxId
                  ? boxId.slice(0, 8) + "…"
                  : "Not configured"}
            </span>
            {activeProjectName && (
              <span className="text-text-faint shrink-0">
                · {activeProjectName}
                {activeWinName && ` / ${activeWinName}`}
              </span>
            )}
            {/* Connection status pill — only shown when the events WS is in a
                non-connected state (reconnecting / stalled / closed). The
                controller fires onState on every transition, so this reflects
                live state without polling. Hidden in SSH mode (no WS) and
                when connected (no signal needed). */}
            {connectionState.state !== "connected" &&
              connectionState.state !== "idle" && (
                <span
                  className="shrink-0 text-text-faint"
                  title={describeConnection(connectionState)}
                >
                  · {describeConnection(connectionState)}
                </span>
              )}
            {/* Active cwd — last segment in the chain so it can shrink and */}
            {/* truncate when the title bar is narrow. `direction:rtl` keeps */}
            {/* the *tail* of the path visible (the meaningful subdir name) */}
            {/* when truncation hits, instead of cutting it off mid-name. */}
            {/* The `·` separator lives OUTSIDE the rtl span so it renders */}
            {/* before the path (rtl would otherwise flip it to the right */}
            {/* side, leaving an orphan dot trailing the cwd). */}
            {activeCwd && (
              <>
                <span className="text-text-faint shrink-0">·</span>
                <span
                  className="text-text-faint min-w-0 truncate"
                  style={{ direction: "rtl", textAlign: "left" }}
                  title={activeCwdRaw}
                >
                  <bdi style={{ direction: "ltr" }}>{activeCwd}</bdi>
                </span>
              </>
            )}
          </div>

          {/* Session-mode dropdown (BET-138): Chat / Terminal / one entry per
              available AI CLI launcher. Only shown for an active chat session
              — every bui-created window carries one. WebkitAppRegion opts out
              of the titlebar's Electron drag region so the select is clickable. */}
          {activeChatSessionId && (
            <div className="ml-auto" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
              <select
                className="text-xs bg-surface border border-border rounded px-1 py-0.5 text-text"
                value={mode}
                onChange={(e) => setMode(e.target.value as SessionMode)}
              >
                <option value="chat">Chat</option>
                <option value="terminal">Terminal</option>
                {availableLaunchers.map((l) => (
                  <option key={l.id} value={`tui:${l.id}`}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex-1 relative">
          {projects.length === 0 ? (
            <div className="h-full flex items-center justify-center text-text-faint text-sm">
              {serverUrl || boxId
                ? "Create a project (⌘N) to start."
                : "Open Settings to connect to your box."}
            </div>
          ) : (
            <>
              {/* Terminal / AI-TUI layer (BET-138): one per `${sessionId}:${modeId}` */}
              {/* composite key ever opened, kept mounted so the shell/CLI */}
              {/* stays warm across mode toggles. Visible only when it's the */}
              {/* active session's CURRENT mode. modeId is "terminal" (bare */}
              {/* shell) or an available launcher's id (AI CLI TUI). */}
              {[...visitedModes.current].map((key) => {
                const sepIdx = key.lastIndexOf(":");
                const sid = key.slice(0, sepIdx);
                const modeId = key.slice(sepIdx + 1);
                const owner = resolveSessionOwner(projects, sid);
                const wantMode: SessionMode =
                  modeId === "terminal" ? "terminal" : `tui:${modeId}`;
                const isActiveThisMode = sid === activeChatSessionId && mode === wantMode;
                const launcherDef =
                  modeId === "terminal" ? undefined : availableLaunchers.find((l) => l.id === modeId);
                const launcher = launcherDef
                  ? { id: launcherDef.id, flags: resolveLauncherFlags(launcherDef.flags, launcherFlags[launcherDef.id]) }
                  : undefined;
                return (
                  <div
                    key={`term:${key}`}
                    className="absolute inset-0"
                    style={{ display: isActiveThisMode ? "block" : "none" }}
                  >
                    <Terminal
                      sessionKey={key}
                      cwd={owner?.cwd ?? ""}
                      launcher={launcher}
                      active={isActiveThisMode}
                    />
                  </div>
                );
              })}
              {/* Chat panels (opencode chat-mode windows): one per visited */}
              {/* session id, visible only when it's the active session AND */}
              {/* the active session's current mode is "chat". */}
              {[...visitedChats.current].map((sid) => {
                // owner is null if the window was killed remotely but bui
                // still has the panel mounted — fork/delete buttons
                // gracefully no-op then.
                const owner = resolveSessionOwner(projects, sid);
                const isActiveChat = sid === activeChatSessionId && mode === "chat";
                return (
                  <div
                    key={`chat:${sid}`}
                    className="absolute inset-0"
                    style={{ display: isActiveChat ? "block" : "none" }}
                  >
                    <ChatPanel
                      sessionId={sid}
                      tmuxSession={owner?.tmuxSession ?? null}
                      windowIndex={owner?.windowIndex ?? null}
                      cwd={owner?.cwd ?? ""}
                      isActive={isActiveChat}
                    />
                  </div>
                );
              })}
            </>
          )}
        </div>
      </main>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
