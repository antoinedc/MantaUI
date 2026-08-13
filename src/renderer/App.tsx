import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { Terminal as TerminalIcon } from "lucide-react";
import { Sidebar, type SidebarHandle } from "./Sidebar";
import { Terminal } from "./Terminal";
import { ChatPanel } from "./ChatPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { GlobalToasts } from "./GlobalToasts";
import { Settings } from "./Settings";
import { SearchPalette } from "./SearchPalette";
import { SETTING_SECTIONS, type SettingSectionId } from "../shared/settingsSchema";
import { Onboarding } from "./Onboarding";
import { NewSessionScreen } from "./NewSessionScreen";
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
import type { SyncPayload } from "../shared/api";
import { chooseUpdateSkewVariant, isTransientUpdateNetworkError, isUnknownChannelError, pruneVisitedSessions, registerMountedTerminal, shouldResyncWindowsForJobs, type MountedTerminal } from "./chatUtils";
import { useCompatibilityCard } from "./hooks/useCompatibilityCard";
import { UpdateBar } from "./UpdateBar";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { ReconnectingBanner } from "./ReconnectingBanner";
import { pickBanner, type BannerState } from "./bannerPriority";
import { parsePairPayload } from "../shared/pairPayload";
import { channelConfig } from "../shared/channel.mjs";
import { ErrorBoundary } from "./ErrorBoundary";
import { MantaLoader } from "./MantaLoader";
import type { AvailableLauncher } from "../shared/types";
import {
  buildLimitMessage,
  buildUsageLevels,
  buildWarnMessage,
  describeResetDistance,
  formatResetClock,
  shouldFireUsageAlert,
  shouldWarnStaleCache,
  type UsageAlertLevel,
} from "./usageEscalation";
import { cronForInstant } from "../shared/scheduleCron.mjs";
import { providerLabel } from "./UsageDial";

// BET-373 (channel-aware wire format): the deep-link URL the OS hands this
// app is, by construction, addressed to THIS channel's URL scheme
// (the same scheme the main process registered via
// `setAsDefaultProtocolClient(CHANNEL_CONFIG.urlScheme)`). Parsing with
// that scheme enforces the boundary defensively — a `manta-staging://…`
// link can never be misclaimed by a `manta://`-registered app, and a
// `manta://` link can never silently pass through a staging build.
const PAIR_PARSE_SCHEME = channelConfig(__MANTA_CHANNEL__).urlScheme;

// BET-659: Artifacts panel open/closed — device-local, default CLOSED. Lazy
// read with try/catch (repo convention — localStorage can throw).
function loadArtifactsOpen(): boolean {
  try {
    return localStorage.getItem("manta:artifacts:open") === "1";
  } catch {
    return false;
  }
}

// PanelShell (BET-680 step 2): the always-mounted session/chat pane wrappers.
// Panels stay mounted (that is the transcript cache) and are toggled with
// display:none — UNCHANGED here. When a pane becomes visible we add a short
// 120ms fade-in (`panel-enter` class, see index.css) so switching sessions
// reads as a subtle cross-fade instead of a hard blank-frame swap. Purely
// visual: focus handling runs unchanged, and the fade is dropped under
// prefers-reduced-motion via the CSS guard.
function PanelShell({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    el.classList.add("panel-enter");
    const onEnd = (e: AnimationEvent) => {
      if (e.target === el) el.classList.remove("panel-enter");
    };
    el.addEventListener("animationend", onEnd);
    return () => el.removeEventListener("animationend", onEnd);
  }, [active]);
  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={{ display: active ? "block" : "none" }}
    >
      {children}
    </div>
  );
}

// The whole app tree is wrapped once in an ErrorBoundary so an uncaught render
// throw anywhere degrades to a minimal centered "Something went wrong — Reload"
// (using existing tokens) instead of React 18 unmounting the root to a white
// screen. AppInner holds the real component; App is the boundary wrapper.
export function App() {
  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <div className="h-full w-full flex items-center justify-center bg-bg text-text">
          <div className="bg-danger-bg border border-danger rounded-md px-4 py-3 text-meta text-center">
            <div className="text-text mb-2 break-words">
              Something went wrong{err.message ? ` — ${err.message}` : ""}
            </div>
            <button
              type="button"
              onClick={reset}
              className="text-accent hover:underline"
            >
              Reload
            </button>
          </div>
        </div>
      )}
    >
      {/* App-level reduced motion (BET-677): wraps the whole tree so EVERY
          framer-motion animation — chat entry, CardMount card mounts, toast
          in/out — respects the OS `prefers-reduced-motion` setting, not just
          the transcript's. The old transcript-local duplicate was removed. */}
      <MotionConfig reducedMotion="user">
        <AppInner />
      </MotionConfig>
    </ErrorBoundary>
  );
}

function AppInner() {
  // BET-730: per-field selectors, never a bare useStore() — a no-selector
  // destructure re-renders this whole component tree (incl. every mounted
  // ChatPanel) on EVERY store write, e.g. each streaming transcript splice
  // (setChatMessages ~4Hz) and the 2s status poller.
  const loaded = useStore((s) => s.loaded);
  const projects = useStore((s) => s.projects);
  const activeProjectName = useStore((s) => s.activeProjectName);
  const activeWindowByProject = useStore((s) => s.activeWindowByProject);
  const setActive = useStore((s) => s.setActive);
  const refresh = useStore((s) => s.refresh);
  const applyStatusBatch = useStore((s) => s.applyStatusBatch);
  const onboardingForced = useStore((s) => s.onboardingForced);
  const finishOnboarding = useStore((s) => s.finishOnboarding);
  const configSnapshot = useStore((s) => s.configSnapshot);
  const updatePrompt = useStore((s) => s.updatePrompt);
  const updateError = useStore((s) => s.updateError);
  const setUpdateError = useStore((s) => s.setUpdateError);
  const boxIncompatible = useStore((s) => s.boxIncompatible);
  const setBoxIncompatible = useStore((s) => s.setBoxIncompatible);
  const serverUpdatePrompt = useStore((s) => s.serverUpdatePrompt);
  const setServerUpdatePrompt = useStore((s) => s.setServerUpdatePrompt);
  const serverUpdateProgress = useStore((s) => s.serverUpdateProgress);
  const connectionState = useStore((s) => s.connectionState);
  const launcherFlags = useStore((s) => s.launcherFlags);
  const createDraft = useStore((s) => s.createDraft);
  const boxStale = useStore((s) => s.boxStale);

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

  // BET-708: first-time pairing swaps window.api in place with no reload
  // (transportInstall), so an app-level effect that guards on an httpApi-only
  // method (onSyncDelta, onStatusEvent, onOpencodeEvent,
  // delegateList/onDelegateUpdated, onAgentFileReady, onServerUpdateProgress)
  // bails at mount and never re-subscribes for the whole first session.
  // transportInstall dispatches `manta-api-installed` after every swap; bump
  // this generation to re-run exactly those effects (added below).
  const [apiGeneration, setApiGeneration] = useState(0);
  useEffect(() => {
    const bump = () => setApiGeneration((g) => g + 1);
    window.addEventListener("manta-api-installed", bump);
    return () => window.removeEventListener("manta-api-installed", bump);
  }, []);
  const showOnboarding = enterOnboarding || onboardingLatched;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ⌘F conversation search palette (SearchPalette). Only reachable in chat
  // mode with an active session (see the keydown handler).
  const [searchOpen, setSearchOpen] = useState(false);
  // Activate a tmux window locally AND on the box (so the PTY follows). Shared
  // by ⌥⌘↑↓, ⌘1..9, the voice switch-window handler, and the ⌘F cross-
  // conversation jump. Implemented by the store's activateWindow action.
  const activateWindow = useStore((s) => s.activateWindow);
  const jumpToWindow = useCallback(
    (tmuxSession: string, windowIndex: number) => {
      void activateWindow(tmuxSession, windowIndex).catch(() => {});
    },
    [activateWindow],
  );
  // Section the Settings modal lands on when the `manta-open-settings` bridge
  // fires (e.g. "Manage models…" → Models). The modal re-targets to it on
  // mount and on every later request.
  const [settingsSection, setSettingsSection] = useState<SettingSectionId>("general");
  const sidebarRef = useRef<SidebarHandle>(null);
  // BET-640: latch so the job poll raises the incompatible banner at most ONCE
  // (a box that can't implement the jobs endpoint will 500 on every 30s tick).
  const incompatibleFlaggedRef = useRef(false);

  // BET-417 (draft model): a "new session" is an in-memory store DRAFT, not an
  // overlay. Clicking + / ⌘N / ⌘T creates a draft (createDraft) and makes it
  // the ACTIVE view (activeDraftId). The draft renders as a layer over the
  // always-mounted session panels, so switching to a real session (setActive
  // clears activeDraftId) reveals the session with its state intact, and
  // switching back re-mounts the composer from the stored draft. The
  // zero-project state (projects.length === 0) auto-creates a new-project
  // draft so the composer is never a dead placeholder.
  const activeDraft = useStore((s) =>
    s.activeDraftId != null
      ? s.drafts.find((d) => d.id === s.activeDraftId) ?? null
      : null,
  );
  // One-shot first-prompt for a freshly-created session (draft → new session):
  // App passes it to the matching ChatPanel, which auto-submits then clears it.
  const autoSubmitPrompt = useStore((s) => s.autoSubmitPrompt);
  const openNewProject = () => createDraft("new-project");
  const openNewSessionInProject = (name: string) =>
    createDraft({ projectName: name });

  // Zero-project state: ensure a new-project draft exists so the composer
  // (welcome screen) is always the visible view. Re-creates it if the user
  // abandons the only draft while there are still no projects.
  useEffect(() => {
    if (loaded && projects.length === 0 && !activeDraft) {
      createDraft("new-project");
    }
  }, [loaded, projects.length, activeDraft, createDraft]);

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

  // BET-730: record the active chat in an effect, not during render (render-
  // time ref mutation is a StrictMode hazard). A re-render that just touches
  // unrelated fields must never mutate the visited set.
  useEffect(() => {
    if (!activeChatSessionId) return;
    if (visitedChats.current.has(activeChatSessionId)) return;
    visitedChats.current.add(activeChatSessionId);
    setVisitEpoch((e) => e + 1);
  }, [activeChatSessionId]);

  // M6/BET-730: a visited chat whose session no longer exists in any project
  // window is a zombie — unmount its panel (frees its transcript, SSE filters,
  // intervals, and the store.chatMessages copy via the panel's unmount
  // cleanup). Session ids that are gone but were /clear-ed or deleted must not
  // stay mounted forever.
  const [visitEpoch, setVisitEpoch] = useState(0);
  useEffect(() => {
    const live = new Set<string>();
    for (const p of projects) for (const w of p.windows) {
      if (w.opencodeSessionId) live.add(w.opencodeSessionId);
    }
    const toRemove = pruneVisitedSessions(
      visitedChats.current,
      live,
      activeChatSessionId,
    );
    if (toRemove.length > 0) {
      for (const sid of toRemove) visitedChats.current.delete(sid);
      setVisitEpoch((e) => e + 1);
    }
  }, [projects, activeChatSessionId]);

  // Render the visited-chat loop from a snapshot keyed on visitEpoch so the
  // panel list re-runs (and the zombie panel unmounts) right after a prune.
  const visitedChatIds = useMemo(
    () => [...visitedChats.current],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visitEpoch],
  );

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

  // ---- Subscription usage escalation (BET-739) ----
  // Fire-once level map (per `provider:window.kind`); see usageEscalation.ts.
  const usageLevelsRef = useRef<Record<string, UsageAlertLevel>>({});
  // "Keep going at reset" confirm-modal payload. null = closed.
  const [keepGoing, setKeepGoing] = useState<{
    providerLabel: string;
    windowLabel: string;
    fireAt: number;
    sessionID: string;
  } | null>(null);
  const cacheTtl = useStore((s) => s.cacheTtl);

  useEffect(() => {
    // Bootstrap (BET-678). The first paint is INSTANT — read from the persisted
    // local snapshot restored in main.tsx (zero round trips). This effect only
    // needs to SYNC the cursor with the box: one refresh() on mount, retried on
    // a plain 10s interval while it fails (cleared on first success). After the
    // first success, live `sync` deltas + the reconnect marker (below) own
    // freshness — no polling.
    //
    // refresh() can still reject with AuthRequiredError when the box answers
    // 401 — a revoked/rotated box_token mid-session. Route that to the pairing
    // screen (onboarding step 1) instead of letting the app sit dead with no
    // sessions and no explanation. relaunchOnboarding() forces the full-screen
    // flow open even for an otherwise-"http" config; a successful re-claim
    // persists a fresh token and finishOnboarding() re-runs the bootstrap.
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const attempt = async (): Promise<boolean> => {
      try {
        await refresh();
        return true;
      } catch (e) {
        const isAuth =
          (e as { name?: string })?.name === "AuthRequiredError" ||
          (e as { status?: number })?.status === 401;
        if (isAuth) {
          void useStore.getState().relaunchOnboarding();
          return true; // onboarding owns the flow now — stop the retry loop
        }
        return false; // transient failure — keep retrying
      }
    };
    void attempt().then((ok) => {
      if (cancelled) return;
      if (!ok) {
        timer = setInterval(() => {
          if (cancelled) return;
          void attempt().then((ok2) => {
            if (ok2 && timer) {
              clearInterval(timer);
              timer = null;
            }
          });
        }, 10_000);
      }
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    // BET-678: live sync deltas own freshness after the initial sync. The box
    // publishes `{kind:"sync"}` envelopes (full current values for changed
    // fields); the events stream ALSO fires a synthetic `{ resync: true }`
    // marker on every reconnect so we re-pull from our cursor for anything we
    // missed while disconnected.
    if (!window.api.onSyncDelta) return;
    const off = window.api.onSyncDelta((delta) => {
      const isResync = "resync" in delta && delta.resync === true;
      if (isResync) {
        void refresh();
        return;
      }
      // applySyncPayload owns the stale-envelope guard (same gen, lower seq).
      useStore.getState().applySyncPayload(delta as SyncPayload);
    });
    return off;
  }, [refresh, apiGeneration]);

  useEffect(() => {
    if (!window.api.onStatusEvent) return;
    const off = window.api.onStatusEvent(applyStatusBatch);
    return off;
  }, [applyStatusBatch, apiGeneration]);

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

  // Background-delegation jobs (BET-381): a single app-level poll feeds
  // the store's `jobs` slice (keyed by childSessionID), which drives the
  // sidebar's per-row activity second line on BOTH desktop and mobile. ONE
  // poll, owned here (not in ChatPanel or Sidebar) so mobile and desktop
  // share it. delegateList() with no arg returns ALL jobs; the per-session
  // card list is a separate fetch in useSessionResources. The renderer never
  // computes activity text — it renders the `activity` field verbatim.
  //
  // BET-414: the poll is now a 30s FALLBACK. The box publishes a
  // `delegate.updated` bus event on every job status/activity change, and we
  // subscribe to it here so a new job nests under its parent within ~1s
  // instead of waiting up to 30s. The event payload is a hint (id/status);
  // we refetch the full slice on every event so the store stays consistent.
  useEffect(() => {
    if (!window.api.delegateList) return;
    const tick = () => {
      window.api
        .delegateList()
        .then((list) => {
          const store = useStore.getState();
          store.setJobs(Array.isArray(list) ? list : []);
          // A job's tmux window is created ON THE BOX, so nothing here has
          // re-listed windows since bootstrap and the tree is missing it.
          // computeJobNesting drops a job whose window it can't find, so
          // without this the job is invisible in the sidebar even though the
          // slice above holds it. Re-list only when the tree actually
          // disagrees (window created for a running job, or still present for
          // a finished one) — not on every event, which would mean a tmux call
          // per job per activity tick.
          const after = useStore.getState();
          if (shouldResyncWindowsForJobs(after.projects, after.jobs)) {
            void after.refresh().catch(() => {
              /* transport blip — the next tick re-evaluates the invariant */
            });
          }
        })
        .catch((e) => {
          // BET-640: a transport blip keeps today's silent behaviour (leave
          // the prior jobs map; the card surfaces errors). But a box that does
          // NOT implement the jobs endpoint at all rejects the RPC with
          // `unknown rpc channel` every tick — before this, that rendered as a
          // permanently empty sidebar, indistinguishable from "no jobs". Raise
          // the existing incompatible banner ONCE instead of hiding the cause.
          const msg = e instanceof Error ? e.message : String(e);
          if (isUnknownChannelError(msg) && !incompatibleFlaggedRef.current) {
            incompatibleFlaggedRef.current = true;
            useStore.getState().setBoxIncompatible(true);
          }
        });
    };
    tick();
    const poll = setInterval(tick, 30_000);
    // Immediate refetch on delegate.updated — kills the old 10s nesting lag.
    let off: (() => void) | null = null;
    if (window.api.onDelegateUpdated) {
      off = window.api.onDelegateUpdated(() => tick());
    }
    return () => {
      clearInterval(poll);
      if (off) off();
    };
  }, [apiGeneration]);

  // Subscription plan usage (BET-738): prime the store's `usage` slice with
  // ONE window.api.usageList() call on mount, then stay live via the box's
  // `usage.updated` bus event. Deliberately NOT a poll — the box's usage
  // poller (src/server/usage.mjs, 3-minute interval) is the only timer;
  // adding a second one here would just be two clocks disagreeing.
  useEffect(() => {
    if (!window.api.usageList) return;
    window.api
      .usageList()
      .then((snapshots) => {
        useStore.getState().setUsage(Array.isArray(snapshots) ? snapshots : []);
      })
      .catch(() => {
        // Transport blip or an older box that doesn't implement the channel
        // yet — leave the slice as-is (UsageDial's own null-snapshot path
        // already renders nothing).
      });
    let off: (() => void) | null = null;
    if (window.api.onUsageUpdated) {
      off = window.api.onUsageUpdated(({ snapshots }) => {
        useStore.getState().setUsage(Array.isArray(snapshots) ? snapshots : []);
      });
    }
    return () => {
      if (off) off();
    };
  }, [apiGeneration]);

  // ---- Subscription usage escalation (BET-739) ----
  // The warn (>=90%) / limit (>=100%) toasts, pushed through the existing
  // global host via pushAppToast. Consumes the SAME `usage.updated` bus event
  // as the store-priming effect above — this must work no matter which pane is
  // in front, which is why it lives here at App (same BET-723 reasoning as the
  // toast host). All transition logic is pure; the fire-once level map lives
  // in usageLevelsRef (re-armed by writing back the new levels, so a window
  // that resets and later crosses up again fires once more).
  const pushAppToastStore = useStore((s) => s.pushAppToast);
  const dismissAppToastStore = useStore((s) => s.dismissAppToast);

  const fireAtFor = (resetsAt: number | undefined): number | null =>
    resetsAt != null ? resetsAt + 60_000 : null;

  // A one-shot job at `fireAt` via the existing scheduler store (window.api
  // schedule path). Same store/poller/⏰ card as the AI `schedule` tool.
  const scheduleAtReset = useCallback(
    async (input: {
      kind: "prompt" | "notify";
      prompt: string;
      label: string;
      fireAt: number;
      sessionID: string;
    }) => {
      try {
        return await window.api.scheduleCreate({
          cron: cronForInstant(new Date(input.fireAt)),
          prompt: input.prompt,
          recurring: false,
          label: input.label,
          sessionID: input.sessionID,
          kind: input.kind,
        });
      } catch (err) {
        return { ok: false as const, error: String((err as Error)?.message ?? err) };
      }
    },
    [],
  );

  const confirmKeepGoing = useCallback(async () => {
    if (!keepGoing) return;
    const { fireAt, sessionID, providerLabel: pLabel, windowLabel } = keepGoing;
    const res = await scheduleAtReset({
      kind: "prompt",
      prompt: "Keep going",
      label: `Keep going: ${pLabel} ${windowLabel} reset`,
      fireAt,
      sessionID,
    });
    setKeepGoing(null);
    pushAppToastStore(
      res.ok && res.job
        ? {
            message: `⏰ “Keep going” will be sent ${formatResetClock(fireAt, true)}.`,
            actions: [
              {
                label: "Undo",
                onClick: () => {
                  if (res.job?.id) void window.api.scheduleDelete(res.job.id);
                },
              },
            ],
          }
        : {
            tone: "error",
            message: `Couldn't schedule “Keep going”: ${res.error ?? "unknown error"}`,
          },
    );
  }, [keepGoing, scheduleAtReset, pushAppToastStore]);

  useEffect(() => {
    if (!window.api.onUsageUpdated) return;
    const off = window.api.onUsageUpdated(({ snapshots }) => {
      const next = Array.isArray(snapshots) ? snapshots : [];
      const fired = shouldFireUsageAlert(usageLevelsRef.current, next);
      for (const alert of fired) {
        const label = providerLabel(alert.provider);
        const windowLabel = alert.window.label;
        const resetsAt = alert.window.resetsAt;
        if (alert.level === "limit") {
          const fireAt = fireAtFor(resetsAt);
          const sessionID = activeChatRef.current;
          const toastId = `usage-limit-${alert.key}-${Date.now()}`;
          // Actions are hidden when the window has no resetsAt (can't compute a
          // fireAt) OR when no chat session is active (a job needs a sessionID).
          // The toast still shows its message either way.
          const hasActions = fireAt != null && sessionID != null;
          pushAppToastStore({
            id: toastId,
            tone: "error",
            message: buildLimitMessage(label, windowLabel, resetsAt),
            actions: hasActions
              ? [
                  {
                    label: "Remind me at reset",
                    onClick: () => {
                      if (fireAt == null || !sessionID) return;
                      dismissAppToastStore(toastId);
                      void (async () => {
                        const res = await scheduleAtReset({
                          kind: "notify",
                          prompt: `${label} ${windowLabel} has reset — you can keep working.`,
                          label: `Reminder: ${label} ${windowLabel} reset`,
                          fireAt,
                          sessionID,
                        });
                        if (res.ok && res.job) {
                          const jobId = res.job.id;
                          pushAppToastStore({
                            message: `⏰ Reminder set for ${formatResetClock(fireAt, true)}.`,
                            actions: [
                              {
                                label: "Undo",
                                onClick: () => {
                                  if (jobId) void window.api.scheduleDelete(jobId);
                                },
                              },
                            ],
                          });
                        } else {
                          pushAppToastStore({
                            tone: "error",
                            message: `Couldn't set a reminder: ${res.error ?? "unknown error"}`,
                          });
                        }
                      })();
                    },
                  },
                  {
                    label: "Keep going at reset",
                    onClick: () => {
                      if (fireAt == null || !sessionID) return;
                      setKeepGoing({
                        providerLabel: label,
                        windowLabel,
                        fireAt,
                        sessionID,
                      });
                    },
                  },
                ]
              : undefined,
          });
        } else {
          pushAppToastStore({
            message: buildWarnMessage(label, windowLabel, alert.window.pct, resetsAt),
          });
        }
      }
      // Write back the CURRENT levels so a holding level doesn't re-fire and a
      // drop (after reset) re-arms the key for the next crossing.
      usageLevelsRef.current = buildUsageLevels(next);
    });
    return off;
  }, [apiGeneration, scheduleAtReset, pushAppToastStore, dismissAppToastStore]);

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
  }, [apiGeneration]);

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

  // Server-update progress (this ticket): while the box runs
  // scripts/self-update.sh, manta-server tails its log and republishes each
  // MANTA_PROGRESS marker as a `serverUpdateProgress` bus event. The renderer
  // renders a determinate progress bar in the server-update UpdateBar so the
  // update reads as advancing rather than a frozen button. Mirrors the
  // onServerUpdateAvailable subscription above.
  useEffect(() => {
    if (!window.api.onServerUpdateProgress) return;
    const off = window.api.onServerUpdateProgress((p) => {
      useStore.getState().setServerUpdateProgress(p);
    });
    return off;
  }, [apiGeneration]);

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
  const [updateRefreshKey, setUpdateRefreshKey] = useState(0);
  const {
    clientVersion,
    serverVersion,
    serverMinClient,
    variant: compatibilityVariant,
    showCard: showCompatibilityCard,
    dismiss,
  } = useCompatibilityCard(updateRefreshKey);

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
        if (sid)         useStore.getState().setChatAttention(sid, null);
        return;
      }
    });
    return off;
  }, [apiGeneration]);

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
          jumpToWindow(target.project.tmuxSession, target.window.index);
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
      // Cmd+K = session search palette (BET-414)
      if ((e.key === "k" || e.key === "K") && !e.shiftKey && !e.altKey) {
        sidebarRef.current?.openPalette();
        e.preventDefault();
        return;
      }
      // Cmd+F = conversation search. Chat-scoped like ⌘I: terminal mode keeps
      // xterm's own ⌘F (Terminal.tsx find), Settings keeps its ⌘F filter (it
      // binds while open, so we bail when settingsOpen). Same key toggles closed.
      if (
        (e.key === "f" || e.key === "F") &&
        !e.shiftKey &&
        !e.altKey &&
        !settingsOpen &&
        activeChatSessionId != null &&
        mode === "chat"
      ) {
        setSearchOpen((v) => !v);
        e.preventDefault();
        return;
      }
      // Cmd+I = toggle the Artifacts panel (BET-659). Only meaningful when a
      // chat pane is active — the panel + its header toggle exist only there.
      if (
        (e.key === "i" || e.key === "I") &&
        !e.shiftKey &&
        !e.altKey &&
        activeChatSessionId != null &&
        mode === "chat"
      ) {
        setArtifactsOpen((v) => !v);
        e.preventDefault();
        return;
      }
      // Cmd+1..9 = jump to nth (project, window) tuple in sidebar order
      if (/^[1-9]$/.test(e.key) && !e.altKey) {
        const idx = parseInt(e.key, 10) - 1;
        const flat = flatSessions(projects);
        const target = flat[idx];
        if (target) {
          jumpToWindow(target.project.tmuxSession, target.window.index);
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [projects, activeProjectName, activeWindowByProject, jumpToWindow, settingsOpen, activeChatSessionId, mode]);

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
        jumpToWindow(target.project.tmuxSession, target.window.index);
      }
    };
    window.addEventListener("manta-voice-app-action", handler as EventListener);
    return () =>
      window.removeEventListener("manta-voice-app-action", handler as EventListener);
  }, [projects, jumpToWindow]);

  // Generic "open Settings on section X" bridge, the same window-CustomEvent
  // convention as the schedules/secrets bridges. The composer-level menus
  // dispatch it; App owns the Settings modal, so it consumes it here — it
  // validates the requested section and falls back to General on garbage.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ section?: string }>).detail;
      const requested = detail?.section
        ? SETTING_SECTIONS.find((s) => s.id === detail.section)?.id
        : undefined;
      setSettingsSection(requested ?? "general");
      setSettingsOpen(true);
    };
    window.addEventListener("manta-open-settings", handler as EventListener);
    return () =>
      window.removeEventListener("manta-open-settings", handler as EventListener);
  }, []);

  const activeWinName = activeProject?.windows.find(
    (w) => w.index === activeWindowByProject[activeProjectName!],
  )?.name ?? null;

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

  // ===== Banner collapse (BET-416 §E) =====
  //
  // At most ONE full-width bar is visible, chosen by severity
  // (reconnecting > incompatible > version skew > update failed > server
  // update). "Update available" (a downloaded desktop auto-update) is NOT a
  // bar — it is demoted to a small --accent dot on the Settings entry in the
  // sidebar footer (see Sidebar.tsx, reads `updatePrompt` from the store);
  // the bar is reserved for states that actually block you. The "behind"
  // compatibility variant folds into `server-update` (it is an upgrade prompt
  // with the same self-update action, not a blocking incompatibility).
  const reconnecting = connectionState.state !== "connected" && connectionState.state !== "idle";
  const incompatible =
    boxIncompatible || (showCompatibilityCard && compatibilityVariant === "incompatible");
  const versionSkew = chooseUpdateSkewVariant(clientVersion, serverMinClient) === "outdated";
  const updateFailed = !!updateError;
  const serverUpdate = !!serverUpdatePrompt || (showCompatibilityCard && compatibilityVariant === "behind");
  const bannerState: BannerState = { reconnecting, incompatible, versionSkew, updateFailed, serverUpdate };
  const activeBanner = pickBanner(bannerState);

  // BET-640: running the box's self-update can now fail EARLY (before the
  // server restart) — e.g. a packaged box that can't resolve its release
  // manifest, or a git box whose fetch dies. The RPC resolves {ok:false} in
  // that case; surface it in the EXISTING update-failed banner (the same
  // state the auto-update path already feeds) instead of silently reporting
  // success and leaving the box stale.
  // Restarting opencode ends every in-flight agent turn, so the box
  // self-update is gated behind an explicit confirm dialog. The two
  // server-update UpdateBars open it; "Update & restart" in the dialog is what
  // actually fires applyServerUpdate().
  const [confirmServerUpdate, setConfirmServerUpdate] = useState(false);

  // BET-659: Artifacts panel open/closed. Owned here because the toggle lives
  // in the SessionHeader (deep inside ChatPanel) while the panel mounts as a
  // sibling of <main> — both need the same value.
  const [artifactsOpen, setArtifactsOpen] = useState(loadArtifactsOpen);
  useEffect(() => {
    try {
      localStorage.setItem("manta:artifacts:open", artifactsOpen ? "1" : "0");
    } catch {
      /* best-effort persist */
    }
  }, [artifactsOpen]);

  // BET-713 fix: a SUCCESSFUL box self-upgrade restarts manta-server before the
  // `server:update-apply` RPC resolves, so the renderer's fetch dies with a bare
  // "Failed to fetch". That restart is the success signal, not a failure — we
  // only raise the update-failed banner for a STRUCTURED early failure
  // (`{ok:false, error}`) the RPC reports.
  //
  // The graceful flow: while `boxUpgrading` the server-update banner renders an
  // in-flight state (determinate steps while the box streams them, then an
  // indeterminate "Restarting the box…" once the restart drops the connection —
  // the frozen-step look is avoided because the server properly dies mid-step
  // 5/6 and the bar must not sit on a stale step). On reconnect we re-fetch the
  // version; once the box is no longer "behind" the whole banner + any stale
  // error/progress clear.
  const [boxUpgrading, setBoxUpgrading] = useState(false);

  // Reconnect after a box self-upgrade → re-fetch the version pair so the
  // compatibility check re-evaluates against the box's NEW version. `boxUpgrading`
  // stays true until the refetch confirms the box advanced (bind in the reconcile
  // effect below) so the banner never flashes back to a re-clickable state mid-restart.
  useEffect(() => {
    if (connectionState.state !== "connected" && connectionState.state !== "idle") return;
    if (!boxUpgrading) return;
    setUpdateRefreshKey((k) => k + 1);
  }, [connectionState.state, boxUpgrading]);

  // Once the box has advanced (variant is no longer "behind"), end the in-flight
  // state and clear any stale update-failed banner + frozen progress — the upgrade
  // landed. A REAL early failure leaves the box behind, so `compatibilityVariant`
  // stays "behind", `boxUpgrading` is cleared directly in applyServerUpdate, and
  // the actionable banner persists for retry.
  useEffect(() => {
    if (!boxUpgrading) return;
    if (compatibilityVariant === "match" || compatibilityVariant === "unknown") {
      setBoxUpgrading(false);
      useStore.getState().setServerUpdateProgress(null);
      setUpdateError(null);
    }
  }, [boxUpgrading, compatibilityVariant]);

  // Safety net: never leave the banner stuck in the in-flight state (e.g. the box
  // reconnected but somehow never advanced). Cap it; the user can then retry.
  useEffect(() => {
    if (!boxUpgrading) return;
    const t = setTimeout(() => {
      setBoxUpgrading(false);
      useStore.getState().setServerUpdateProgress(null);
    }, 120_000);
    return () => clearTimeout(t);
  }, [boxUpgrading]);

  // True while the box is restarting mid-upgrade (connection dropped). Drives the
  // indeterminate "Restarting the box…" presentation instead of a frozen step.
  const boxRestarting =
    boxUpgrading && connectionState.state !== "connected" && connectionState.state !== "idle";

  const applyServerUpdate = async () => {
    setBoxUpgrading(true);
    try {
      const res = await window.api.serverUpdateApply();
      if (res && res.ok === false) {
        setBoxUpgrading(false);
        setUpdateError({ message: res.error || "Server update failed", raw: res.error ?? "" });
      }
    } catch (e) {
      // A bare connection error is the box restarting itself mid-update (the
      // success path) — swallow it; the reconnect + version re-check above
      // resolves the real outcome. Structured failures still raise the banner.
      if (isTransientUpdateNetworkError(e)) return;
      setBoxUpgrading(false);
      setUpdateError({
        message: e instanceof Error ? e.message : String(e),
        raw: String(e),
      });
    }
  };

  // BET-459: when a chat session is the visible pane, the SessionHeader owns
  // the single top-of-pane row (breadcrumb + mode toggle) — the app titlebar
  // is hidden so the two don't stack. Non-chat panes (terminal / AI-TUI /
  // new-session) keep the titlebar's drag region + breadcrumb + toggle.
  const isChatPaneActive = activeChatSessionId != null && mode === "chat";
  // BET-723: the global toast host can route a screenshot "Add to chat" only
  // when the foreground pane is a real chat session (not a draft over it).
  const screenshotCanAddToChat = activeChatSessionId != null && !activeDraft && mode === "chat";

  return (
    // data-screen is the visual harness's handle on the app shell (see
    // scripts/visual/screens.mjs), matching NewSessionScreen's. One stable
    // attribute per screen root, so the harness never depends on a class name
    // or a DOM position — both of which a redesign is expected to change.
    <div data-screen="session" className="h-full w-full flex bg-bg text-text">
      <Sidebar
        ref={sidebarRef}
        onOpenSettings={() => setSettingsOpen(true)}
        onNewProject={openNewProject}
        onNewSessionInProject={openNewSessionInProject}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {/* At most ONE full-width bar (BET-416 §E). `activeBanner` is the
            single highest-severity condition across reconnecting / incompatible
            / version-skew / update-failed / server-update. "Update available"
            (a downloaded desktop auto-update) is no longer a bar — it is a
            small --accent dot on the Settings entry in the sidebar footer; the
            bar is reserved for states that actually block you. A downloaded
            update's install action is still reachable via the version-skew
            bar's button (it picks autoUpdateInstall when an update is ready). */}
        {!showOnboarding && activeBanner === "reconnecting" && (
          <ReconnectingBanner
            state={connectionState}
            onRetryNow={() => window.api.connectionRetryNow()}
          />
        )}
        {!showOnboarding && activeBanner === "incompatible" && (
          <UpdateBar
            text={
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
            }
            actionLabel="Learn more"
            onAction={() => {
              void window.api.openExternal("https://mantaui.com/install");
            }}
            onDismiss={() => {
              setBoxIncompatible(false);
              dismiss();
            }}
          />
        )}
        {!showOnboarding && activeBanner === "version-skew" && (
          <UpdateBar
            text={
              <>This app is out of date and may not work correctly — please update.</>
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
        {!showOnboarding && activeBanner === "update-failed" && (
          <UpdateBar
            text={updateError!.message}
            actionLabel="Download"
            onAction={() => {
              void window.api.openExternal("https://mantaui.com/downloads/Manta-latest.dmg");
            }}
            onDismiss={() => setUpdateError(null)}
          />
        )}
        {!showOnboarding && activeBanner === "server-update" && serverUpdatePrompt && (
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
            onAction={() => setConfirmServerUpdate(true)}
            onDismiss={() => setServerUpdatePrompt(null)}
            busy={boxUpgrading}
            progress={boxUpgrading && !boxRestarting ? serverUpdateProgress ?? undefined : undefined}
            busyLabel={boxRestarting ? "Restarting the box…" : "Updating the box…"}
          />
        )}
        {!showOnboarding &&
          activeBanner === "server-update" &&
          !serverUpdatePrompt &&
          showCompatibilityCard &&
          compatibilityVariant === "behind" && (
            <UpdateBar
              text={
                <>
                  Box needs an upgrade:{" "}
                  <span className="font-medium text-text">
                    {serverVersion ?? "?"}
                  </span>
                </>
              }
              actionLabel="Upgrade box"
              onAction={() => setConfirmServerUpdate(true)}
              onDismiss={dismiss}
              busy={boxUpgrading}
              progress={boxUpgrading && !boxRestarting ? serverUpdateProgress ?? undefined : undefined}
              busyLabel={boxRestarting ? "Restarting the box…" : "Updating the box…"}
            />
          )}
        {!isChatPaneActive && (
        <div className="titlebar-drag h-12 border-b border-border flex items-center px-4 gap-2 min-w-0">
          <div className="text-meta text-text-muted flex items-center gap-2 min-w-0">
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
            {/* BET-678: the box's tmux is unreachable — its last refresh tick
                failed. Keep serving the last-known session list but surface a
                subtle amber marker so "stale data" isn't read as "the box is
                empty". */}
            {boxStale && (
              <span
                className="shrink-0 inline-flex items-center gap-1 text-text-faint"
                title="The box's tmux is unreachable — showing the last known session list."
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-warn"
                  aria-hidden="true"
                />
                last known state
              </span>
            )}
          </div>

          {/* Session-mode toggle (BET-459): a terminal glyph that swaps
              Terminal ↔ Chat — the icon-button presentation of the old
              <select>, keeping its accessible name. WebkitAppRegion opts out
              of the titlebar's Electron drag region so the button is
              clickable. Only shown for an active chat session (the non-chat
              pane header). */}
          {activeChatSessionId && (
            <button
              type="button"
              onClick={() => setMode(mode === "terminal" ? "chat" : "terminal")}
              className="text-text-faint hover:text-text hover:bg-fill-hover rounded-xs p-1 inline-flex items-center ml-auto"
              style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
              title={`Switch to ${mode === "terminal" ? "Chat" : "Terminal"}`}
              aria-label={mode === "terminal" ? "Chat" : "Terminal"}
            >
              <TerminalIcon size={16} aria-hidden="true" />
            </button>
          )}
          {/* Trailing spacer — Windows paints min/max/close over the top-right
              of the window; this keeps the mode button from sliding under
              them. Zero-width everywhere else. */}
          <div className="titlebar-inset-right" />
        </div>
      )}
        <div className="flex-1 relative">
          {projects.length === 0 && !loaded ? (
            // Config hasn't arrived yet. `loaded` is false on the FIRST paint
            // (it flips in applyConfig, after main.tsx's async configGet), so
            // without this gate the zero-project branch below mounts for one
            // commit on every boot — including a fresh, unpaired install where
            // `window.api` is still the preload OS-bridge subset. The
            // composer's mount effect then called httpApi-only methods and
            // threw "opencodeModels is not a function" from the commit phase,
            // unmounting the tree BEFORE onboarding could ever render (the
            // whole app went blank on first launch). Onboarding needs `loaded`
            // too, so neither branch may render until config is in.
            <div className="h-full w-full flex items-center justify-center">
              <MantaLoader size="screen" />
            </div>
          ) : projects.length === 0 ? (
            // Zero-project state (BET-416 §F / BET-417 §A): the new-session
            // composer IS the app's zero state. An unpaired config routes to
            // onboarding, so this branch is only reached when the box IS
            // paired but has no projects yet. The auto-create effect above
            // guarantees an active new-project draft here; use it when present
            // (and render a blank for the one frame before it lands).
            activeDraft ? (
              <NewSessionScreen draftId={activeDraft.id} />
            ) : (
              <div className="h-full w-full flex items-center justify-center">
                <MantaLoader />
              </div>
            )
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
                  <PanelShell key={`term:${key}`} active={isActiveThisMode}>
                    <Terminal
                      sessionKey={key}
                      cwd={m.cwd}
                      launcher={launcher}
                      tmuxTarget={m.tmuxTarget}
                      active={isActiveThisMode}
                    />
                  </PanelShell>
                );
              })}
              {/* Chat panels (opencode chat-mode windows): one per visited */}
              {/* session id, visible only when it's the active session AND */}
              {/* the active session's current mode is "chat". */}
              {visitedChatIds.map((sid) => {
                // owner is null if the window was killed remotely but manta
                // still has the panel mounted — fork/delete buttons
                // gracefully no-op then.
                const owner = resolveSessionOwner(projects, sid);
                const isActiveChat = sid === activeChatSessionId && mode === "chat";
                const ownerWinName = owner
                  ? (projects
                      .find((p) => p.tmuxSession === owner.tmuxSession)
                      ?.windows.find((w) => w.index === owner.windowIndex)?.name ?? null)
                  : null;
                return (
                  <PanelShell key={`chat:${sid}`} active={isActiveChat}>
                    <ChatPanel
                      sessionId={sid}
                      tmuxSession={owner?.tmuxSession ?? null}
                      windowIndex={owner?.windowIndex ?? null}
                      cwd={owner?.cwd ?? ""}
                      isActive={isActiveChat}
                      projectName={owner?.tmuxSession ?? null}
                      winName={ownerWinName}
                      mode={mode}
                      onModeChange={setMode}
                      availableLaunchers={availableLaunchers}
                      artifactsOpen={artifactsOpen}
                      onToggleArtifacts={() => setArtifactsOpen((v) => !v)}
                      autoSubmit={
                        autoSubmitPrompt?.sid === sid ? autoSubmitPrompt : undefined
                      }
                    />
                  </PanelShell>
                );
              })}
              {/* New-session DRAFT layer: shown over the always-mounted
                  session panels when a draft is the active view (user hit +
                  / Cmd+N/T). The session panels below stay mounted, so
                  switching back to a real session (setActive clears
                  activeDraftId) reveals it with state intact. The sidebar
                  stays visible so the user can click another session. */}
              {activeDraft && (
                <div className="absolute inset-0 z-30 bg-bg">
                  <NewSessionScreen draftId={activeDraft.id} />
                </div>
              )}
            </>
          )}
        </div>
      </main>
      {/* BET-723 §D4: ONE global toast host, rendered over every pane type
          (terminal / TUI / draft / chat) as a sibling of <main>. */}
      {!showOnboarding && (
        <GlobalToasts
          activeChatSessionId={activeChatSessionId}
          canAddToChat={screenshotCanAddToChat}
        />
      )}
      {/* BET-659: the Artifacts panel — a fixed-width sibling of <main>, so a
          chat pane is required for it to show (there's no panel to open in a
          terminal). The outer shell is already `flex` and <main> is
          `flex-1 min-w-0`, so this needs no layout change. */}
      {isChatPaneActive && (
        <ArtifactsPanel
          sessionId={activeChatSessionId}
          open={artifactsOpen}
        />
      )}
      {settingsOpen && (
        <Settings onClose={() => setSettingsOpen(false)} initialSection={settingsSection} />
      )}
      {searchOpen && activeChatSessionId != null && (
        <SearchPalette
          sessionId={activeChatSessionId}
          projects={projects}
          onJumpToWindow={jumpToWindow}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {/* Box self-update confirm: restarting opencode ends every in-flight
          agent turn, so the destructive restart needs explicit consent before
          the update starts. */}
      <Modal
          open={confirmServerUpdate}
          size="md"
          label="Update the box?"
          onDismiss={() => setConfirmServerUpdate(false)}
        >
          <div className="space-y-4">
            <h3 className="text-title font-semibold">Update the box?</h3>
            <div className="text-body text-text-faint">
              This restarts opencode, which will end every agent turn currently
              running in any session. Any unsaved work in a running turn is lost.
            </div>
            <div className="flex justify-end gap-2">
              <Button
                tone="ghost"
                onClick={() => setConfirmServerUpdate(false)}
              >
                Cancel
              </Button>
              <Button
                tone="primary"
                onClick={() => {
                  setConfirmServerUpdate(false);
                  void applyServerUpdate();
                }}
              >
                Update &amp; restart
              </Button>
            </div>
          </div>
        </Modal>

      {/* Keep going at reset — BET-739 usage escalation confirm. Rendered at
          App level (like the toasts) so it works over any pane. */}
      {keepGoing && (
        <Modal
          open
          size="sm"
          label="Send an automatic message at reset?"
          onDismiss={() => setKeepGoing(null)}
        >
          <div className="space-y-4">
            <h3 className="text-title font-semibold">Send an automatic message at reset?</h3>
            <div className="text-body text-text-faint">
              At {formatResetClock(keepGoing.fireAt, true)} MantaUI will send “Keep going” to this
              session on your behalf and the agent will resume unattended. You can cancel it any
              time from ⏰ scheduled tasks.
            </div>
            {shouldWarnStaleCache(keepGoing.fireAt, Date.now(), cacheTtl) && (
              <Callout tone="warn">
                The reset is {describeResetDistance(keepGoing.fireAt - Date.now())} away — well past
                your {cacheTtl === "5m" ? "5 minute" : "1 hour"} prompt-cache window. The whole
                conversation will be re-sent and re-billed as fresh input, which costs significantly
                more than a reply now.
              </Callout>
            )}
            <div className="flex justify-end gap-2">
              <Button tone="ghost" onClick={() => setKeepGoing(null)}>
                Cancel
              </Button>
              <Button tone="primary" onClick={() => void confirmKeepGoing()}>
                Schedule it
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
