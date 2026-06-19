import { useEffect, useRef, useState } from "react";
import { useStore, resolveSessionOwner } from "../store";
import { SessionListScreen } from "./SessionListScreen";
import { SessionScreen } from "./SessionScreen";
import { MobileSettings } from "./MobileSettings";
import { reportFocus } from "./push";

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
    refresh().catch((e: unknown) =>
      setBootError(e instanceof Error ? e.message : "Could not reach the server."),
    );
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
    void useStore.getState().replayChatAttention();
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
  // `agentFile` events when the AI drops a file in ~/.bui-outbox/. On a device
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
  // bui-scroll-to-question handler.
  const openSessionForNotif = (
    projectName: string,
    windowIndex: number,
    sessionId: string,
  ) => {
    (window as Window & { __buiScrollQuestionSession?: string | null }).__buiScrollQuestionSession =
      sessionId;
    openSession(projectName, windowIndex);
    window.dispatchEvent(
      new CustomEvent("bui-scroll-to-question", { detail: { sessionId } }),
    );
  };

  // Push focus reporting — tell the server which session is on screen and
  // whether the app is visible, so the "Claude is done" push is suppressed
  // only for the session the user is actively watching. Re-sent on session
  // change and on every visibility flip; pagehide marks not-visible so a
  // backgrounded/closed app gets all "done" pushes.
  useEffect(() => {
    const send = () =>
      reportFocus(
        activeSessionId,
        document.visibilityState === "visible" && nav.screen === "session",
      );
    send();
    const onVis = () => send();
    const onHide = () => reportFocus(activeSessionId, false);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
    };
  }, [activeSessionId, nav.screen]);

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
      if (d?.type === "bui-open-session" && d.sessionId) {
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
