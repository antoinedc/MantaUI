import { useEffect, useRef, useState } from "react";
import { useStore, resolveSessionOwner } from "../store";
import { SessionListScreen } from "./SessionListScreen";
import { SessionScreen } from "./SessionScreen";
import { MobileSettings } from "./MobileSettings";
import { PairingScreen } from "./PairingScreen";
import { SetupScreen } from "./SetupScreen";
import { reportFocus } from "./push";
import { registerApns, NATIVE_NOTIF_TAP_EVENT_NAME } from "./nativePush";
import { AuthRequiredError, ServerNotConfiguredError, triggerResumeReconnect } from "../api/httpApi";
import { shouldReconnectOnAppStateChange } from "../chatUtils";
import { getCapacitorApp, handlePairUrl } from "./deepLink";

type Nav =
  | { screen: "list" }
  | { screen: "session"; projectName: string; windowIndex: number }
  | { screen: "settings" };

export function MobileApp() {
  const refresh = useStore((s) => s.refresh);
  const setActive = useStore((s) => s.setActive);
  const applyStatusBatch = useStore((s) => s.applyStatusBatch);
  const setScreenshotToast = useStore((s) => s.setScreenshotToast);
  const setAgentFileToast = useStore((s) => s.setAgentFileToast);
  const projects = useStore((s) => s.projects);

  const [nav, setNav] = useState<Nav>({ screen: "list" });
  const [bootError, setBootError] = useState<string | null>(null);
  // True when bui-server answered the bootstrap with 401 (unpaired, or a stored
  // token was revoked/rotated). Routes the whole app to the pairing screen
  // instead of the session list — this IS the re-pair path too, since a rotated
  // token 401s exactly like a fresh browser.
  const [authRequired, setAuthRequired] = useState(false);
  // True on first-run when serverBase() threw ServerNotConfiguredError — no
  // localStorage["manta_server"] AND no same-origin http(s) page (the iOS
  // Capacitor shell's `capacitor://localhost` falls in this branch). Routes
  // to SetupScreen so the user can supply the URL + pairing code, instead of
  // hitting the dead-end Retry screen.
  const [setupRequired, setSetupRequired] = useState(false);

  // The opencode session id of the on-screen chat (null on list/settings or a
  // terminal window). Drives push focus-suppression: the server skips the
  // "Claude is done" notification for the session you're actively viewing.
  const activeSessionId =
    nav.screen === "session"
      ? (projects
          .find((p) => p.tmuxSession === nav.projectName)
          ?.windows.find((w) => w.index === nav.windowIndex)
          ?.opencodeSessionId ?? null)
      : null;

  // Bootstrap: load projects/config. Surface failure with a retry (mobile has
  // no SSH layer; the box can simply be unreachable).
  const doRefresh = () => {
    setBootError(null);
    refresh().catch((e: unknown) => {
      // First-run: serverBase() couldn't resolve a URL (no localStorage
      // override AND no same-origin http(s) page). Route to SetupScreen so
      // the user can supply the URL + pairing code instead of hitting the
      // dead-end Retry screen. Same defensive `instanceof || name ===` pattern
      // we use for AuthRequiredError below — `name` covers cross-realm throws
      // where instanceof can fail.
      if (
        e instanceof ServerNotConfiguredError ||
        (e as { name?: string })?.name === "ServerNotConfiguredError"
      ) {
        setSetupRequired(true);
        return;
      }
      // A 401 from the box means we're unpaired (or the stored token was
      // revoked/rotated) — route to the pairing screen instead of the generic
      // "could not reach the server" error, which offers only a dead Retry.
      if (e instanceof AuthRequiredError || (e as { name?: string })?.name === "AuthRequiredError") {
        setAuthRequired(true);
        return;
      }
      setBootError(e instanceof Error ? e.message : "Could not reach the server.");
    });
  };

  // Called by SetupScreen after a successful claim (serverUrl persisted to
  // localStorage["manta_server"], token persisted to localStorage["manta_token"]
  // by claimAgainst). Drop the gate and re-run the bootstrap so the session
  // list loads with the now-resolved serverBase() + now-valid Bearer credential.
  const onConnected = () => {
    setSetupRequired(false);
    doRefresh();
  };

  // Called by PairingScreen after a successful claim (token already persisted).
  // Drop the gate and re-run the bootstrap so the session list loads with the
  // now-valid Bearer credential.
  const onPaired = () => {
    setAuthRequired(false);
    doRefresh();
  };
  useEffect(() => {
    doRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live status dots (store already maps batches → status).
  useEffect(() => {
    if (!window.api.onStatusEvent) return;
    return window.api.onStatusEvent(applyStatusBatch);
  }, [applyStatusBatch]);

  // Startup attention replay (mirror of App.tsx). opencode SSE is forward-
  // only, so a chat window already blocked on a question/permission when the
  // page (re)connects never re-fires the *.asked event — the dot would stay
  // dark. Once chat-mode windows are known, query each session's live pending
  // state and latch the indicator. See App.tsx / store.replayChatAttention.
  const chatSessionKey = projects
    .flatMap((p) => p.windows.map((w) => w.opencodeSessionId).filter(Boolean))
    .sort()
    .join(",");
  useEffect(() => {
    if (!chatSessionKey) return;
    // runBackgroundSync (mirror of App.tsx) fires both fan-outs in parallel
    // with bounded per-fan-out concurrency + a `backgroundSyncing` flag
    // (BET-135).
    void useStore.getState().runBackgroundSync();
  }, [chatSessionKey]);

  // Sidebar status for chat-mode windows (mirror of the desktop App.tsx
  // listener; same logic, same store actions). The mobile server's PTY
  // poller has the same blindspot as desktop status.ts — capture-pane
  // returns nothing for the `sleep infinity` holder — so chat-mode
  // running / question / permission signals must come from the
  // opencode SSE stream the server already forwards through /events.
  // See App.tsx for the full rationale.
  useEffect(() => {
    if (!window.api.onOpencodeEvent) return;
    const off = window.api.onOpencodeEvent((ev) => {
      const props = (ev.properties ?? {}) as Record<string, unknown>;
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

  // Screenshot toast — mirror of the App.tsx subscription (lines ~55-60).
  // The mobile server doesn't actually emit screenshot events today (there's
  // no desktop-watcher or clipboard-poller on the Linux box), so this
  // listener is dormant in current deployments. Wiring it now means: if a
  // future server-side screenshot detector or Capacitor share-sheet handler
  // pushes a "screenshot" event, the existing ChatPanel toast UI renders
  // automatically — no further mobile-side changes needed. Pre-emptive, but
  // cheap (single ref-counted subscription, no polling).
  useEffect(() => {
    if (!window.api.onScreenshotDetected) return;
    return window.api.onScreenshotDetected((s) => setScreenshotToast(s));
  }, [setScreenshotToast]);

  // Agent → device file push. The mobile server's outbox poller publishes
  // `agentFile` events when the AI drops a file in ~/.manta-outbox/. On a device
  // these arrive as a Save toast (the active ChatPanel renders it); tapping
  // Save triggers a browser download via GET /api/download.
  useEffect(() => {
    if (!window.api.onAgentFileReady) return;
    return window.api.onAgentFileReady((ev) => setAgentFileToast(ev));
  }, [setAgentFileToast]);

  const goList = () => setNav({ screen: "list" });
  const openSession = (projectName: string, windowIndex: number) => {
    setActive(projectName, windowIndex);
    setNav({ screen: "session", projectName, windowIndex });
  };
  const openSettings = () => setNav({ screen: "settings" });

  // Open a session from a notification tap, and ask its ChatPanel to scroll the
  // pending QuestionCard into view. The window global is a latch for the
  // cold-start case (panel mounts after this runs); the event covers the warm
  // case (panel already mounted on that session). See ChatPanel's
  // manta-scroll-to-question handler.
  const openSessionForNotif = (
    projectName: string,
    windowIndex: number,
    sessionId: string,
  ) => {
    (window as Window & { __buiScrollQuestionSession?: string | null }).__buiScrollQuestionSession =
      sessionId;
    openSession(projectName, windowIndex);
    window.dispatchEvent(
      new CustomEvent("manta-scroll-to-question", { detail: { sessionId } }),
    );
  };

  // Push focus reporting — tell the server which session is on screen and
  // whether the app is visible, so the "Claude is done" push is suppressed
  // only for the session the user is actively watching. Re-sent on session
  // change and on every visibility flip; pagehide marks not-visible so a
  // backgrounded/closed app gets all "done" pushes.
  //
  // On the iOS Capacitor shell (BET-177 §4.1) we ALSO subscribe to
  // `appStateChange` and feed its `isActive` into the same `send()` closure
  // — WKWebView's visibilitychange is unreliable during app backgrounding,
  // but Capacitor's native event fires every transition. The native signal
  // wins once it has arrived; document.visibilityState is the pre-first-
  // event fallback (and the only signal on the frozen PWA / desktop).
  // One code path: the listener set differs by platform, the reporting
  // function does not.
  const nativeActiveRef = useRef<boolean | null>(null);
  useEffect(() => {
    const cap = getCapacitorApp(window);
    const send = (visible: boolean) =>
      reportFocus(activeSessionId, visible && nav.screen === "session");
    const capActive = nativeActiveRef.current;
    const docVisible = document.visibilityState === "visible";
    // Prefer the native signal once it has arrived; otherwise fall back to
    // document.visibilityState. (On the first render before any Capacitor
    // event has fired, `capActive` is null and we use the document signal.)
    send(capActive !== null ? capActive : docVisible);
    const onVis = () =>
      send(nativeActiveRef.current !== null
        ? nativeActiveRef.current
        : document.visibilityState === "visible");
    // pagehide is the "going away" terminal event — always mark not-visible
    // regardless of any prior signal. (Going through send() would also
    // report false here, but the direct call documents the intent and
    // matches the original behavior verbatim.)
    const onHide = () => reportFocus(activeSessionId, false);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    let listenerPromise:
      | Promise<{ remove: () => Promise<void> }>
      | { remove: () => Promise<void> }
      | undefined;
    if (cap) {
      listenerPromise = cap.addListener(
        "appStateChange",
        (event: { isActive: boolean }) => {
          nativeActiveRef.current = event.isActive;
          send(event.isActive);
        },
      );
    }
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      if (listenerPromise) {
        // Capacitor's addListener handle is a Promise<{remove}> in v6+;
        // older versions return the handle directly. Normalize both shapes
        // (same pattern as the appUrlOpen cleanup further down).
        void Promise.resolve(listenerPromise).then((h) => {
          const remove = (h as { remove?: () => Promise<void> } | null | undefined)?.remove;
          if (typeof remove === "function") void remove();
        });
      }
    };
  }, [activeSessionId, nav.screen]);

  // Resume reconnect (BET-177 §4.2). iOS suspends sockets while backgrounded,
  // so on the inactive→active transition we force a reconnect + resync of
  // state missed during the suspend. Goes through the SAME
  // triggerResumeReconnect path the visibility-based resume watchdog uses
  // in httpApi.ts (extended, not duplicated) — see shouldReconnectOnAppStateChange
  // in chatUtils.ts for the pure predicate.
  useEffect(() => {
    const cap = getCapacitorApp(window);
    if (!cap) return;
    const handle = cap.addListener(
      "appStateChange",
      (event: { isActive: boolean }) => {
        if (shouldReconnectOnAppStateChange(event.isActive === true)) {
          triggerResumeReconnect();
        }
      },
    );
    return () => {
      // Capacitor's addListener handle is a Promise<{remove}> in v6+;
      // older versions return the handle directly. Normalize both shapes.
      void Promise.resolve(handle).then((h) => {
        const remove = (h as { remove?: () => Promise<void> } | null | undefined)?.remove;
        if (typeof remove === "function") void remove();
      });
    };
  }, []);

  // Notification deep-link — a tapped push opens the app with ?notif=<sid>
  // (cold start) or posts a message from the service worker (warm). Stash the
  // requested session id; the effect below resolves it to a (project, window)
  // once projects have loaded and navigates there.
  const pendingNotif = useRef<string | null>(null);
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const n = u.searchParams.get("notif");
      if (n) {
        pendingNotif.current = n;
        u.searchParams.delete("notif");
        window.history.replaceState({}, "", u.toString());
      }
    } catch {
      /* ignore malformed URL */
    }
    if (!navigator.serviceWorker) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: string } | undefined;
      if (d?.type === "manta-open-session" && d.sessionId) {
        pendingNotif.current = d.sessionId;
        const owner = resolveSessionOwner(useStore.getState().projects, d.sessionId);
        if (owner) {
          pendingNotif.current = null;
          openSessionForNotif(owner.tmuxSession, owner.windowIndex, d.sessionId);
        }
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native APNs push registration (BET-181). Runs once after projects +
  // auth are settled; the request-permission flow wants a fresh user
  // gesture but on iOS the app launch is treated as one. No-op on the
  // frozen PWA build (isNativePushAvailable returns false there).
  useEffect(() => {
    registerApns().catch((e: unknown) =>
      console.warn("[nativePush] registerApns failed:", e),
    );
  }, []);

  // Native APNs tap routing — Capacitor dispatches a CustomEvent with the
  // sessionId in `detail` (no service worker involved). Reuse the same
  // `pendingNotif` ref + resolveSessionOwner path the Web Push SW message
  // uses (the single source of truth for "navigate from a notification").
  useEffect(() => {
    const onNativeTap = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      const sid = typeof detail?.sessionId === "string" ? detail.sessionId : null;
      if (!sid) return;
      pendingNotif.current = sid;
      const owner = resolveSessionOwner(useStore.getState().projects, sid);
      if (owner) {
        pendingNotif.current = null;
        openSessionForNotif(owner.tmuxSession, owner.windowIndex, sid);
      }
    };
    window.addEventListener(NATIVE_NOTIF_TAP_EVENT_NAME, onNativeTap);
    return () =>
      window.removeEventListener(NATIVE_NOTIF_TAP_EVENT_NAME, onNativeTap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve a stashed deep-link once projects are available.
  useEffect(() => {
    if (!pendingNotif.current || projects.length === 0) return;
    const sid = pendingNotif.current;
    const owner = resolveSessionOwner(projects, sid);
    if (owner) {
      pendingNotif.current = null;
      openSessionForNotif(owner.tmuxSession, owner.windowIndex, sid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // Capacitor `manta://pair?…` deep-link handler (BET-177 §2.2). On the iOS
  // shell, the user scans a QR with the Camera → iOS opens the app via the
  // `manta://` scheme (Info.plist CFBundleURLTypes). The Capacitor App
  // plugin delivers the URL two ways:
  //   • cold start → `getLaunchUrl()` resolves once with the launch URL
  //   • warm start → `appUrlOpen` event fires with the new URL
  // On the desktop / PWA bundle the Capacitor bridge is absent (feature
  // detect via getCapacitorApp → null) and this effect is a clean no-op.
  // On "paired" we clear the first-run setup gate AND any stale 401 re-pair
  // gate (same triggers the SetupScreen / PairingScreen onConnected/onPaired
  // handlers fire) and re-run doRefresh so the session list loads with the
  // newly-resolved serverBase() + Bearer credential.
  useEffect(() => {
    const cap = getCapacitorApp(window);
    if (!cap) return;
    let cancelled = false;
    const handle = (raw: string) => {
      void handlePairUrl(raw, {
        authClaim: window.api.authClaim,
        persistServer: (serverUrl) => {
          try {
            localStorage.setItem("manta_server", serverUrl);
          } catch {
            /* localStorage unavailable — nothing to do */
          }
        },
      }).then((outcome) => {
        if (cancelled || outcome !== "paired") return;
        setSetupRequired(false);
        setAuthRequired(false);
        doRefresh();
      });
    };
    // Cold start: the URL the app was launched with (may be null on warm
    // resumes). The promise resolves once the bridge has had a chance to
    // observe the launch — we don't care if the URL is undefined (warm).
    void cap
      .getLaunchUrl()
      .then((res) => {
        if (cancelled) return;
        const url = res?.url;
        if (typeof url === "string" && url !== "") handle(url);
      })
      .catch(() => {
        /* bridge refused — nothing to do */
      });
    // Warm start: subsequent URLs (the user scans a fresh QR while the app
    // is already open). The returned handle exposes remove() which is the
    // Capacitor convention; we call it on unmount.
    const listenerPromise = cap.addListener("appUrlOpen", (event) => {
      if (typeof event?.url === "string" && event.url !== "") handle(event.url);
    });
    return () => {
      cancelled = true;
      // Capacitor's addListener handle is a Promise<{remove}> in v6+;
      // older versions return the handle directly. Normalize both shapes.
      void Promise.resolve(listenerPromise).then((h) => {
        const remove = (h as { remove?: () => Promise<void> } | null | undefined)?.remove;
        if (typeof remove === "function") void remove();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Android hardware back / browser back → pop to list. Both session and
  // settings screens collapse back to the list on back gesture.
  useEffect(() => {
    const onPop = () => {
      if (nav.screen === "session" || nav.screen === "settings") {
        goList();
      }
    };
    window.addEventListener("popstate", onPop);
    if (nav.screen === "session" || nav.screen === "settings") {
      window.history.pushState({ s: nav.screen }, "");
    }
    return () => window.removeEventListener("popstate", onPop);
  }, [nav.screen]);

  // Left-edge swipe → back (recognized only from the screen edge so it does
  // not fight xterm or wide code blocks inside the body). Active on every
  // non-list screen.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t.clientX <= 24 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s || nav.screen === "list") return;
    const t = e.changedTouches[0];
    if (t.clientX - s.x > 60 && Math.abs(t.clientY - s.y) < 50) goList();
  };

  if (setupRequired) {
    return <SetupScreen onConnected={onConnected} />;
  }

  if (authRequired) {
    return <PairingScreen onPaired={onPaired} />;
  }

  if (bootError) {
    return (
      <div className="mobile">
        <div className="h-full flex flex-col items-center justify-center gap-4 px-8 text-center">
          <div className="text-text-muted text-sm">{bootError}</div>
          <button
            className="mobile-tap px-5 rounded-lg bg-accent-soft text-white"
            onClick={doRefresh}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mobile"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="mobile-stack">
        <div
          className={
            "mobile-screen" +
            (nav.screen === "session" || nav.screen === "settings"
              ? " mobile-screen--list-behind"
              : "")
          }
        >
          <SessionListScreen
            onOpenSession={openSession}
            onRefresh={doRefresh}
            onOpenSettings={openSettings}
          />
        </div>
        {nav.screen === "session" && (
          <SessionScreen
            projectName={nav.projectName}
            windowIndex={nav.windowIndex}
            onBack={goList}
          />
        )}
        {nav.screen === "settings" && <MobileSettings onClose={goList} />}
      </div>
    </div>
  );
}
