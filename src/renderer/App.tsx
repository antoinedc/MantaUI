import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Sidebar, type SidebarHandle } from "./Sidebar";
import { Terminal } from "./Terminal";
import { ChatPanel } from "./ChatPanel";
import { Settings } from "./Settings";
import { Onboarding } from "./Onboarding";
import { useStore, flatSessions, resolveSessionOwner } from "./store";
import { resolveTransportMode } from "../shared/transport.mjs";
import { getMantaPreload } from "./preloadAccess";
import { describe as describeConnection } from "../shared/net/state.js";
import {
  type SessionMode,
  readSavedMode,
  writeSavedMode,
  resolveLauncherFlags,
} from "./chatShared";
import { chooseUpdateSkewVariant, registerMountedTerminal, type MountedTerminal } from "./chatUtils";
import { useCompatibilityCard } from "./hooks/useCompatibilityCard";
import { MOD_KEY } from "./platform";
import { UpdateBar } from "./UpdateBar";
import { ReconnectingBanner } from "./ReconnectingBanner";
import { parsePairPayload } from "./mobile/pairPayload";
import { channelConfig } from "../shared/channel.mjs";
import type { AvailableLauncher } from "../shared/types";

// BET-373 (channel-aware wire format): the deep-link URL the OS hands this
// app is, by construction, addressed to THIS channel's URL scheme
// (the same scheme the main process registered via
// `setAsDefaultProtocolClient(CHANNEL_CONFIG.urlScheme)`). Parsing with
// that scheme enforces the boundary defensively — a `manta-staging://…`
// link can never be misclaimed by a `manta://`-registered app, and a
// `manta://` link can never silently pass through a staging build.
const PAIR_PARSE_SCHEME = channelConfig(__MANTA_CHANNEL__).urlScheme;

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
    updateError,
    setUpdateError,
    serverUpdatePrompt,
    setServerUpdatePrompt,
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
  // Active window — every tmux window has this; only manta-created windows
  // additionally carry opencodeSessionId, so the terminal layer uses
  // (tmuxSession, windowIndex) directly to avoid the black-pane bug for
  // adopted windows (BET-347).
  const activeWin = activeProjectName
    ? projects
        .find((p) => p.tmuxSession === activeProjectName)
        ?.windows.find((w) => w.index === activeWindowByProject[activeProjectName])
    : null;
  const activeChatSessionId = activeWin?.opencodeSessionId ?? null;
  if (activeChatSessionId) visitedChats.current.add(activeChatSessionId);

  // Resolved early so it can be reused at the activeWinName display site
  // (line ~695) and anywhere else that needs the active project's metadata.
  const activeProject = activeProjectName
    ? projects.find((p) => p.tmuxSession === activeProjectName) ?? null
    : null;

  // Session-mode toggle (BET-138). `mode` tracks the active window's
  // current mode; other windows' last-used modes stay in localStorage. The
  // visitedModes Map is keyed by terminalMountKey so its Terminal is
  // mounted lazily on first use and kept warm (BET-347) — the value carries
  // the fields, the loop never parses the key back apart. The single
  // terminal mount loop below also handles adopted (pre-existing) tmux
  // windows via the `tmuxTarget` field — supersedes BET-348's parallel
  // visitedNonManta loop, removed.
  const visitedModes = useRef<Map<string, MountedTerminal>>(new Map());
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

  // Reset to the persisted mode whenever the active window changes. Adopted
  // windows (no opencodeSessionId) are forced to "terminal" — the dropdown
  // is hidden for them and there's no opencode session id to key
  // localStorage on. Primitive deps so a freshly-derived activeWin per
  // render doesn't re-fire this.
  useEffect(() => {
    const m: SessionMode = activeChatSessionId
      ? readSavedMode(activeChatSessionId, availableLaunchers)
      : activeWin && activeProjectName
        ? "terminal"
        : "chat";
    setModeState(m);
    if (activeWin && activeProjectName && m !== "chat") {
      registerMountedTerminal(
        visitedModes.current,
        activeProjectName,
        activeWin.index,
        m,
        activeWin.paneCurrentPath || "",
        activeChatSessionId,
      );
    }
  }, [activeChatSessionId, availableLaunchers, activeProjectName, activeWin?.index, activeWin?.paneCurrentPath]);

  const setMode = (m: SessionMode) => {
    if (activeChatSessionId && activeWin && activeProjectName) {
      writeSavedMode(activeChatSessionId, m);
      if (m !== "chat") {
        registerMountedTerminal(
          visitedModes.current,
          activeProjectName,
          activeWin.index,
          m,
          activeWin.paneCurrentPath || "",
          activeChatSessionId,
        );
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
    // Bootstrap. In HTTP mode (paired to a manta-server) refresh() can reject
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

  // Background-delegation jobs (BET-381): a single app-level 10s poll feeds
  // the store's `jobs` slice (keyed by childSessionID), which drives the
  // sidebar's per-row activity second line on BOTH desktop and mobile. ONE
  // poll, owned here (not in ChatPanel or Sidebar) so mobile and desktop
  // share it. delegateList() with no arg returns ALL jobs; the per-session
  // card list is a separate fetch in useSessionResources. The renderer never
  // computes activity text — it renders the `activity` field verbatim.
  useEffect(() => {
    if (!window.api.delegateList) return;
    const tick = () => {
      window.api
        .delegateList()
        .then((list) => {
          useStore.getState().setJobs(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          /* server unreachable — leave the prior jobs map; the card surfaces errors */
        });
    };
    tick();
    const poll = setInterval(tick, 10_000);
    return () => clearInterval(poll);
  }, []);

  // Screenshot detection — subscribe ONCE at the app level. Every ChatPanel
  // used to register its own listener, so a single detection fanned out into
  // N toasts (one per mounted chat). Now the toast lives in the store, the
  // active ChatPanel renders it, and accept/dismiss clear it globally.
  // Routes through the typed preload accessor so it no-ops on mobile/web.
  useEffect(() => {
    const preload = getMantaPreload();
    if (!preload) return;
    const off = preload.onScreenshotDetected((ev) => {
      useStore.getState().setScreenshotToast(ev);
    });
    return off;
  }, []);

  // Deep-link pairing (BET-240, BET-335, #277): the OS protocol handler
  // (electron-builder `protocols:` + Electron `setAsDefaultProtocolClient`)
  // delivers a manta://pair?... URL via the preload's `pair:link-received`
  // IPC. Two outcomes:
  //
  //  • Malformed / legacy-shape link (#277): silently dropping leaves the
  //    user staring at a launched-but-empty window — the OS opened us for
  //    the manta:// scheme, so it looked like the link did nothing. Surface
  //    the reason on the pair step via setPairLinkError and open onboarding
  //    if it isn't already up. PairStep renders pairLinkError in the same
  //    inline slot a manual Connect failure uses.
  //
  //  • Valid link (BET-335): stash the URL via setPendingPairLink so
  //    Onboarding jumps to step 1 and PairStep prefills Box ID + code from
  //    prefillFromPairLink. The click on Connect is the confirmation — no
  //    silent auto-claim, the pair page's "click Connect" copy becomes
  //    true.
  useEffect(() => {
    const pre = getMantaPreload();
    if (!pre?.onPairLink) return;
    return pre.onPairLink((url) => {
      const payload = parsePairPayload(url, PAIR_PARSE_SCHEME);
      if (!payload) {
        // Malformed / legacy-shape link (e.g. an old box still minting the
        // `id=`/`token=` form). The OS still LAUNCHED us for the manta://
        // scheme, so silently returning looks exactly like a broken app —
        // the window comes to front and nothing else happens. Surface the
        // reason on the pair step, opening the flow if it isn't already up.
        const st = useStore.getState();
        st.setPairLinkError(
          "That pairing link isn't valid. Generate a fresh one on your box (run `manta pair`) and open the new link.",
        );
        const onboardingOpen =
          st.onboardingForced ||
          resolveTransportMode(st.configSnapshot()) === "onboarding";
        if (!onboardingOpen) void st.relaunchOnboarding();
        return;
      }
      // Valid link (BET-335): stash the URL and open onboarding at step 1.
      // PairStep prefills Box ID + code; the user clicks Connect to claim.
      const st = useStore.getState();
      st.setPendingPairLink(url);
      const alreadyOnboarding =
        st.onboardingForced ||
        resolveTransportMode(st.configSnapshot()) === "onboarding";
      if (!alreadyOnboarding) void st.relaunchOnboarding();
    });
  }, []);

  // Agent → laptop file push. Same single-listener pattern as screenshots: a
  // file the remote AI dropped in ~/.manta-outbox/ surfaces as one global toast
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

  // Terminal auto-update failure. Main only forwards failures the user has to
  // ACT on (integrity / permission — see shared/updateError.mjs); transient
  // network errors never arrive here, so this banner can't nag about a flaky
  // connection. Before this existed every updater error went to console.warn
  // and nowhere else, which is how a broken release feed silently stopped all
  // desktop updates for two versions.
  useEffect(() => {
    if (!window.api.onAutoUpdateError) return;
    const off = window.api.onAutoUpdateError((info) => {
      useStore.getState().setUpdateError(info);
    });
    return off;
  }, []);

  // Server-update available (BET-225 stage 3): main forwards the box's
  // `serverUpdateAvailable` bus event to the renderer via the
  // `serverUpdateAvailable` IPC channel. The renderer renders a "Server
  // update available: {version}" bar via the shared UpdateBar component —
  // same component as the desktop auto-update prompt, just a different
  // message + button label (`serverUpdateApply` runs `scripts/self-update.sh`
  // on the box). On mobile the IPC listener is a no-op (httpApi shim
  // returns `() => {}`); mobile-specific mobile UI is out of scope — this
  // subscription exists so the store field + bus-case stay in sync for a
  // later mobile pass.
  useEffect(() => {
    if (!window.api.onServerUpdateAvailable) return;
    const off = window.api.onServerUpdateAvailable((payload) => {
      useStore.getState().setServerUpdatePrompt({
        version: payload.version,
        notesUrl: payload.notesUrl ?? undefined,
      });
    });
    return off;
  }, []);

  // Version-skew guard (BET-225 stage 3 Part C). After the renderer is
  // mounted, fetch the client + server version pair ONCE (no second poll,
  // per the stage-3 spec) and let `chooseUpdateSkewVariant` decide
  // whether to render the non-dismissible "outdated" banner. Missing
  // versions (mid-bootstrap, transient failure) collapse to "ok" so we
  // never flash the blocking banner on a fresh launch. getServerVersion
  // is the same endpoint MobileSettings already calls for its display
  // — both consume the same `{version, minClient}` payload.
  //
  // BET-357 §3 (BET-366): also capture the box's current `version`
  // (not just `minClient`) so we can run the desktop↔box compatibility
  // matrix check (`isCompatible`). The matrix decides:
  //   - "behind"       → box on the supported major but older than the
  //                       desktop → show "Box needs upgrade" card with
  //                       an action that fires the existing
  //                       `server:update-apply` self-update path.
  //   - "incompatible" → different major → show the supported-versions
  //                       message (no in-app action bridges a wire-
  //                       contract change).
  //   - "match"        → hide the card.
  // The `serverVersion` is the SAME field MobileSettings already reads
  // for "Server vX.Y.Z" under the URL field — single source of truth.
  const {
    clientVersion,
    serverVersion,
    serverMinClient,
    variant: compatibilityVariant,
    showCard: showCompatibilityCard,
    dismiss,
  } = useCompatibilityCard();

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

  // Desktop OS notifications. manta-server's router (push.mjs) decides WHICH
  // device(s) get a notification (no duplicates) and forwards a desktop directive
  // → main → IPC here. We add the final local
  // suppression — if this window is focused AND already showing that exact
  // session, the user is looking at it, so don't pop an OS notification — then
  // show it via the Notification API and deep-link to the session on click.
  useEffect(() => {
    if (!window.api.onDesktopNotify) return;
    const off = window.api.onDesktopNotify((payload) => {
      // Diagnostic log (BET-211): record every directive we receive along
      // with the live Notification.permission value, so the next "no
      // notification" report is a one-Axiom-query lookup by `source=desktop`
      // tag rather than guess-and-check. Mirrors BET-207/210 observability.
      console.log(
        "[desktop-notify] received",
        payload.tag,
        "perm=",
        Notification.permission,
      );
      const sid = payload.sessionId;
      if (document.hasFocus() && sid && activeChatRef.current === sid) return;
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      const show = () => {
        try {
          const n = new Notification(payload.title || "Manta UI", {
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
      show();
    });
    return off;
  }, [setActive]);

  // BET-211: request Notification permission ONCE at startup, not lazily on
  // first event. The lazy request raced with the first directive arriving —
  // macOS would pop the OS prompt AFTER the renderer had already dropped the
  // notify, so the user never saw it. Settling permission at mount means the
  // first event always has a known `granted` / `denied` / `default` answer.
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    void Notification.requestPermission();
  }, []);

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
  // `manta-voice-app-action` CustomEvent for actions it doesn't own
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
    window.addEventListener("manta-voice-app-action", handler as EventListener);
    return () =>
      window.removeEventListener("manta-voice-app-action", handler as EventListener);
  }, [projects, setActive]);

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
        {/* Auto-update prompt bar (BET-225 stage 3: shared UpdateBar).
            Shown when main has downloaded a new version and is waiting for
            the user to restart. Positioned at the top of the main area so
            it's visible regardless of which panel is active. Dismissed by
            the × button (clears store state). The UpdateBar component is
            the shared banner used for all three update prompts — desktop
            auto-update, server update, and the version-skew guard (below). */}
        {!showOnboarding && updatePrompt && (
          <UpdateBar
            text={
              <>
                Update available:{" "}
                <span className="font-medium text-text">
                  {updatePrompt.releaseName || updatePrompt.version}
                </span>
              </>
            }
            actionLabel="Restart to update"
            onAction={() => {
              void window.api.autoUpdateInstall();
            }}
            onDismiss={() => setUpdatePrompt(null)}
          />
        )}
        {/* Terminal auto-update failure. An update exists but this install
            cannot take it (checksum/signature mismatch, or the bundle can't
            be replaced), so the only way forward is a manual download —
            hence the action opens the downloads page rather than retrying an
            install that is guaranteed to fail again. Dismissible: the user
            may not want to deal with it right now, and it re-arms on the
            next failed check. */}
        {!showOnboarding && updateError && (
          <UpdateBar
            text={updateError.message}
            actionLabel="Download"
            onAction={() => {
              void window.api.openExternal("https://mantaui.com/downloads/Manta-latest.dmg");
            }}
            onDismiss={() => setUpdateError(null)}
          />
        )}
        {/* Server-update prompt (BET-225 stage 3 Part A): shown when the
            box's server-update poller sees a newer manifest version. Same
            UpdateBar component as the desktop auto-update above; the action
            button fires `serverUpdateApply` which runs scripts/self-update.sh
            on the box (git fetch + reset --hard origin/main + npm ci
            --omit=dev + systemctl --user restart manta-server). */}
        {!showOnboarding && serverUpdatePrompt && (
          <UpdateBar
            text={
              <>
                Server update available:{" "}
                <span className="font-medium text-text">
                  {serverUpdatePrompt.version}
                </span>
              </>
            }
            actionLabel="Update & restart"
            onAction={() => {
              void window.api.serverUpdateApply();
            }}
            onDismiss={() => setServerUpdatePrompt(null)}
          />
        )}
        {/* Version-skew guard (BET-225 stage 3 Part C). NON-dismissible —
            the client version is older than the server's `minClient` (a
            breaking RPC change shipped in a newer server), so the user
            MUST update before the app can talk to the box safely. The
            button picks the right desktop action based on whether an
            update has already been downloaded (`updatePrompt !== null` →
            autoUpdateInstall; else → autoUpdateDownload). On mobile the
            action is informational (App Store) — mobile skips this branch
            because there's no autoUpdate plumbing. */}
        {!showOnboarding &&
          chooseUpdateSkewVariant(clientVersion, serverMinClient) === "outdated" && (
            <UpdateBar
              text={
                <>
                  This app is out of date and may not work correctly —
                  please update.
                </>
              }
              actionLabel="Update"
              onAction={() => {
                if (updatePrompt) {
                  void window.api.autoUpdateInstall();
                } else {
                  void window.api.autoUpdateDownload();
                }
              }}
              dismissible={false}
            />
          )}
        {/* Desktop↔box compatibility card (BET-357 §3 / BET-366). The
            desktop and the box ship separately and will drift. This card
            is the user's only signal that the box needs an upgrade, and
            it stays dismissible because the "behind" path has a clear
            one-click action and the "incompatible" path is informational
            (no in-app action bridges a wire-contract change). The
            variant comes from the pure `isCompatible` helper over the
            desktop's own version (clientVersion, from
            `getClientVersion`) and the box's reported version
            (serverVersion, from `getServerVersion`). Both sources are
            already in flight for the skew banner above — this card
            reuses the same fetch, no second round-trip.

            "match"/"unknown" → render nothing (mid-bootstrap never
            flashes the card).

            "behind" → "Box needs upgrade: <boxVersion>" with an
            "Upgrade box" button that fires the existing
            `server:update-apply` RPC — the same self-update path the
            server-update-available prompt above uses. Do NOT write a
            second update mechanism; this is wired into the existing
            one intentionally.

            "incompatible" → "This box (vX.Y.Z) is not supported by
            this app (vA.B.C)." with a "Learn more" button that opens
            the install docs — the user must upgrade one half manually
            (different major = different RPC contract). */}
        {!showOnboarding && showCompatibilityCard && (
            <UpdateBar
              text={
                compatibilityVariant === "behind" ? (
                  <>
                    Box needs an upgrade:{" "}
                    <span className="font-medium text-text">
                      {serverVersion ?? "?"}
                    </span>
                  </>
                ) : (
                  <>
                    This box (v
                    <span className="font-medium text-text">
                      {serverVersion ?? "?"}
                    </span>
                    ) is not supported by this app (v
                    <span className="font-medium text-text">
                      {clientVersion ?? "?"}
                    </span>
                    ).
                  </>
                )
              }
              actionLabel={
                compatibilityVariant === "behind" ? "Upgrade box" : "Learn more"
              }
              onAction={() => {
                if (compatibilityVariant === "behind") {
                  void window.api.serverUpdateApply();
                } else {
                  void window.api.openExternal("https://mantaui.com/install");
                }
              }}
              onDismiss={dismiss}
            />
          )}
        {/* Reconnecting banner (BET-365 / BET-357 §1): full-width bar above
            the titlebar that surfaces the events-WebSocket reconnect state.
            Replaces the prior tiny titlebar pill with attempt count, the
            next-backoff delay, and a "Retry now" button that calls
            window.api.connectionRetryNow(). Hidden when connected/idle. */}
        {!showOnboarding && (
          <ReconnectingBanner
            state={connectionState}
            onRetryNow={() => window.api.connectionRetryNow()}
          />
        )}
        <div className="titlebar-drag h-12 border-b border-border flex items-center px-4 gap-2 min-w-0">
          <div className="text-xs text-text-muted flex items-center gap-2 min-w-0">
            {activeProjectName && (
              <span className="text-text-faint shrink-0">
                {activeProjectName}
                {activeWinName && ` / ${activeWinName}`}
              </span>
            )}
            {/* Connection status pill — only shown when the events WS is in a
                non-connected state (reconnecting / stalled / closed). The
                controller fires onState on every transition, so this reflects
                live state without polling. Hidden in SSH mode (no WS) and
                when connected (no signal needed). The full-width
                ReconnectingBanner above surfaces the same state with more
                detail (attempt count, next-backoff delay, Retry button); the
                pill is kept for at-a-glance context inside the titlebar. */}
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
                <span className="text-text-quiet shrink-0">·</span>
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
              — every manta-created window carries one. WebkitAppRegion opts out
              of the titlebar's Electron drag region so the select is clickable. */}
          {activeChatSessionId && (
            <div className="ml-auto" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
              <select
                className="text-xs bg-bg-elev border border-border rounded px-1 py-0.5 text-text cursor-pointer hover:border-border-strong focus:outline-none focus:border-accent"
                style={{ colorScheme: "dark" }}
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
          {/* Trailing spacer — Windows paints min/max/close over the top-right
              of the window; this keeps the mode dropdown from sliding under
              them. Zero-width everywhere else. */}
          <div className="titlebar-inset-right" />
        </div>
        <div className="flex-1 relative">
          {projects.length === 0 ? (
            <div className="h-full flex items-center justify-center text-text-faint text-sm">
              {serverUrl || boxId
                ? `Create a project (${MOD_KEY}N) to start.`
                : "Open Settings to connect to your box."}
            </div>
          ) : (
            <>
              {/* Terminal / AI-TUI layer (BET-138, BET-347): one per
                  (tmuxSession, windowIndex, modeId) triple, kept mounted so
                  the shell/CLI stays warm. Adopted + manta-created windows
                  share this loop — `tmuxTarget` is the only diff (BET-347). */}
              {[...visitedModes.current.entries()].map(([key, m]) => {
                const isActiveThisMode =
                  activeProjectName === m.tmuxSession &&
                  activeWin?.index === m.windowIndex &&
                  mode === (m.modeId === "terminal" ? "terminal" : `tui:${m.modeId}`);
                const launcherDef = m.modeId === "terminal"
                  ? undefined
                  : availableLaunchers.find((l) => l.id === m.modeId);
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
                      cwd={m.cwd}
                      launcher={launcher}
                      tmuxTarget={m.tmuxTarget}
                      active={isActiveThisMode}
                    />
                  </div>
                );
              })}
              {/* Chat panels (opencode chat-mode windows): one per visited */}
              {/* session id, visible only when it's the active session AND */}
              {/* the active session's current mode is "chat". */}
              {[...visitedChats.current].map((sid) => {
                // owner is null if the window was killed remotely but manta
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
