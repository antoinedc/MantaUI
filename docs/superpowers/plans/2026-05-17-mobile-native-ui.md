# Mobile-Native UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shrunk-desktop mobile UI with a mobile-native shell (drill-down navigation, touch-sized session list, keyboard-aware composer) that reuses the existing `ChatPanel` and `Terminal` unchanged, leaving the desktop Electron UI provably untouched.

**Architecture:** `main.tsx` already branches on `!window.api` (no Electron preload). After installing the HTTP shim it renders a new `<MobileApp/>` instead of `<App/>`. `MobileApp` (new, under `src/renderer/mobile/`) owns a navigation stack and consumes the shared `useStore()`. `SessionListScreen` renders touch-sized project-grouped rows; `SessionScreen` drills in and renders the reused `ChatPanel` or `Terminal` (gated on `opencodeSessionId`, mirroring desktop). A pure `resolveSessionOwner()` helper in `store.ts` (unit-tested) maps a session id → ChatPanel props, factoring the logic currently inline in `App.tsx`. Mobile CSS is scoped under a root `.mobile` class so it can never match in the desktop tree.

**Tech Stack:** React 18, TypeScript, Zustand (`useStore`), Tailwind CSS, Vitest (pure-logic unit tests only — no jsdom/RTL in this repo), Capacitor/Android for device verification.

---

## File Structure

**New files:**
- `src/renderer/mobile/MobileApp.tsx` — root mobile shell: nav stack, store bootstrap, status/back handling, root `.mobile` class, retry-on-boot-failure.
- `src/renderer/mobile/SessionListScreen.tsx` — home screen: project-grouped touch rows + `SessionRow` subcomponent, `+` create action, empty state.
- `src/renderer/mobile/SessionScreen.tsx` — drilled-in view: compact header, `⋯` actions sheet, body gate (`ChatPanel` vs `Terminal`), pop-on-vanish.
- `src/renderer/mobile/mobile.css` — `.mobile`-scoped overrides (composer above keyboard, ≥48px targets, full-width transcript).

**Modified files:**
- `src/renderer/store.ts` — add exported pure helper `resolveSessionOwner(projects, sessionId)` + its return type.
- `src/renderer/store.test.ts` — **new test file** for `resolveSessionOwner` (vitest, pure-logic, matches `chatUtils.test.ts` style).
- `src/renderer/main.tsx` — render `<MobileApp/>` on the no-`window.api` branch; import `mobile.css`.

**Untouched (invariant):** `src/renderer/App.tsx`, `Sidebar.tsx`, `ChatPanel.tsx`, `Terminal.tsx`, `Settings.tsx`, all `src/main/*`, all `src/preload/*`, all `src/server/*`, the Capacitor wrapper protocol.

---

## Task 1: Pure session-owner resolver in the store

Factor the session-id → owner mapping (currently inline in `App.tsx:209-220`) into a tested pure helper the mobile shell will use. App.tsx is **not** modified (it keeps its inline copy — changing it would risk desktop regression and is out of scope); this helper is the mobile-shell's equivalent, and being pure it is unit-testable in the existing vitest setup.

**Files:**
- Modify: `src/renderer/store.ts` (add export near `flatSessions`, around line 218)
- Test: `src/renderer/store.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveSessionOwner } from "./store";
import type { Project } from "../shared/types";

function proj(over: Partial<Project> & { tmuxSession: string }): Project {
  return {
    tmuxSession: over.tmuxSession,
    defaultCwd: over.defaultCwd ?? "~",
    attached: over.attached ?? false,
    windows: over.windows ?? [],
  };
}

describe("resolveSessionOwner", () => {
  it("returns null when no window owns the session id", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        windows: [
          { index: 0, name: "main", active: true, paneCurrentPath: "/x", opencodeSessionId: null },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_missing")).toBeNull();
  });

  it("finds the owning window and prefers paneCurrentPath over defaultCwd", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        defaultCwd: "~/bui",
        windows: [
          { index: 2, name: "feat", active: false, paneCurrentPath: "/abs/feat", opencodeSessionId: "ses_a" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_a")).toEqual({
      tmuxSession: "bui",
      windowIndex: 2,
      cwd: "/abs/feat",
    });
  });

  it("falls back to project defaultCwd when paneCurrentPath is empty", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        defaultCwd: "~/bui",
        windows: [
          { index: 1, name: "w", active: false, paneCurrentPath: "", opencodeSessionId: "ses_b" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_b")).toEqual({
      tmuxSession: "bui",
      windowIndex: 1,
      cwd: "~/bui",
    });
  });

  it("returns the first matching window across multiple projects", () => {
    const projects = [
      proj({ tmuxSession: "a", windows: [] }),
      proj({
        tmuxSession: "b",
        defaultCwd: "~/b",
        windows: [
          { index: 0, name: "w", active: true, paneCurrentPath: "/b", opencodeSessionId: "ses_c" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_c")).toEqual({
      tmuxSession: "b",
      windowIndex: 0,
      cwd: "/b",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/store.test.ts`
Expected: FAIL — `resolveSessionOwner` is not exported / not a function.

- [ ] **Step 3: Add the helper to `store.ts`**

In `src/renderer/store.ts`, immediately after the `flatSessions` function (it ends around line 218, before `function clearAttention`), add:

```typescript
// (sessionId) -> the tmux window that owns it, plus the cwd ChatPanel needs.
// Prefer paneCurrentPath (always an absolute path from tmux) over the
// project's defaultCwd (may be a literal "~/..." opencode's /find/file
// cannot expand). Returns null if no window carries this session id (window
// killed remotely but a panel is still mounted) — callers no-op gracefully.
export type SessionOwner = {
  tmuxSession: string;
  windowIndex: number;
  cwd: string;
};

export function resolveSessionOwner(
  projects: Project[],
  sessionId: string,
): SessionOwner | null {
  for (const p of projects) {
    const w = p.windows.find((x) => x.opencodeSessionId === sessionId);
    if (w) {
      return {
        tmuxSession: p.tmuxSession,
        windowIndex: w.index,
        cwd: w.paneCurrentPath || p.defaultCwd,
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full vitest suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, including the existing `chatUtils.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store.ts src/renderer/store.test.ts
git commit -m "feat(store): add tested resolveSessionOwner helper for mobile shell

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 2: Mobile CSS (scoped, cannot touch desktop)

Create the `.mobile`-scoped stylesheet first so later components can rely on its classes. Every selector is prefixed `.mobile` so it never matches the desktop `<App/>` tree.

**Files:**
- Create: `src/renderer/mobile/mobile.css`
- Modify: `src/renderer/main.tsx` (add the import only — render branch comes in Task 5)

- [ ] **Step 1: Create `src/renderer/mobile/mobile.css`**

```css
/* All rules scoped under .mobile (set by MobileApp's root div) so they can
   reshape the reused ChatPanel/Terminal internals WITHOUT ever matching in
   the desktop <App/> tree. Do not add an unscoped selector to this file. */

.mobile {
  height: 100dvh;
  width: 100vw;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none;
}

/* Drill-down stack: two screens slide horizontally. */
.mobile-stack {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
}
.mobile-screen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #0e0f12;
  transition: transform 220ms ease;
  will-change: transform;
}
.mobile-screen--list-behind {
  transform: translateX(-22%);
}
.mobile-screen--session-offscreen {
  transform: translateX(100%);
}

/* Touch-sized session rows: the desktop sidebar rows were py-0.5 (~6px) and
   broke automated tapping. Mobile rows are >=48px. */
.mobile-row {
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  margin: 0 8px 6px;
  border-radius: 12px;
  background: #15171c;
  border: 1px solid transparent;
}
.mobile-row:active {
  border-color: #383c47;
  background: #1b1e25;
}
.mobile-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}

.mobile-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 8px 12px;
  border-bottom: 1px solid #262932;
  flex: none;
}
.mobile-tap {
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Reused ChatPanel/Terminal fill the body region below the mobile header. */
.mobile-body {
  flex: 1;
  position: relative;
  min-height: 0;
}
.mobile-body > * {
  position: absolute;
  inset: 0;
}

/* Keyboard-aware composer: keep ChatPanel's input above the on-screen
   keyboard. ChatPanel's footer is its last flex child; pad for safe area. */
.mobile .chat-input-area,
.mobile [data-chat-input] {
  padding-bottom: max(env(safe-area-inset-bottom), 8px);
}

/* Bottom-sheet for session actions (fork/compact/delete/rename). */
.mobile-sheet-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  z-index: 50;
}
.mobile-sheet {
  width: 100%;
  background: #15171c;
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding: 8px 8px max(env(safe-area-inset-bottom), 12px);
}
.mobile-sheet button {
  width: 100%;
  text-align: left;
  padding: 14px 16px;
  border-radius: 10px;
  color: #e6e7ea;
  font-size: 15px;
}
.mobile-sheet button:active {
  background: #1b1e25;
}
.mobile-sheet button.danger {
  color: #f87171;
}
```

- [ ] **Step 2: Add the CSS import to `main.tsx`**

In `src/renderer/main.tsx`, after the existing `import "./index.css";` line (line 4), add:

```typescript
import "./mobile/mobile.css";
```

(Importing it globally is safe — every rule is `.mobile`-scoped, so it is inert in Electron where the root never has the `.mobile` class.)

- [ ] **Step 3: Verify the build still compiles**

Run: `npx tsc --noEmit`
Expected: no new errors (CSS import is type-free; `main.tsx` otherwise unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/mobile/mobile.css src/renderer/main.tsx
git commit -m "feat(mobile): scoped mobile.css (touch targets, drill-down, composer)

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 3: SessionListScreen (home screen)

Touch-sized, project-grouped session list reading the shared store.

**Files:**
- Create: `src/renderer/mobile/SessionListScreen.tsx`

- [ ] **Step 1: Create `src/renderer/mobile/SessionListScreen.tsx`**

```tsx
import { useStore } from "../store";
import type { Project, TmuxWindow } from "../../shared/types";

type Props = {
  onOpenSession: (projectName: string, windowIndex: number) => void;
  onCreate: () => void;
};

function dotColor(running: boolean, attention: boolean): string {
  if (attention) return "#f59e0b";
  if (running) return "#22c55e";
  return "#6b7280";
}

function typeLabel(w: TmuxWindow, running: boolean, attention: boolean): string {
  const kind = w.opencodeSessionId ? "chat" : "terminal";
  if (w.opencodeSessionId && attention) return `${kind} · needs you`;
  if (w.opencodeSessionId && running) return `${kind} · running`;
  return kind;
}

function SessionRow({
  project,
  window: w,
  onOpen,
}: {
  project: Project;
  window: TmuxWindow;
  onOpen: () => void;
}) {
  const status = useStore((s) => s.status[project.tmuxSession]?.[w.index]);
  const running = status?.running ?? false;
  const attention = status?.attention ?? false;
  return (
    <button
      className="mobile-row w-full text-left"
      onClick={onOpen}
      aria-label={`Open ${project.tmuxSession} / ${w.name}`}
    >
      <span
        className="mobile-dot"
        style={{ background: dotColor(running, attention) }}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-text text-sm font-semibold truncate">
          {w.name}
        </span>
        <span className="block text-text-muted text-xs truncate">
          {typeLabel(w, running, attention)}
        </span>
      </span>
      <span className="text-text-faint text-lg leading-none">›</span>
    </button>
  );
}

export function SessionListScreen({ onOpenSession, onCreate }: Props) {
  const projects = useStore((s) => s.projects);
  const host = useStore((s) => s.host);

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <div className="flex-1 text-text font-bold text-base px-1">Sessions</div>
        <button
          className="mobile-tap rounded-lg bg-accent-soft text-white text-xl"
          onClick={onCreate}
          aria-label="New session"
        >
          +
        </button>
      </div>
      <div className="flex-1 overflow-auto py-2">
        {projects.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-faint text-sm px-8 text-center">
            {host
              ? "No sessions yet. Tap + to create one."
              : "Server not configured."}
          </div>
        ) : (
          projects.map((p) => (
            <div key={p.tmuxSession}>
              <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wide text-text-faint">
                {p.tmuxSession}
              </div>
              {p.windows.map((w) => (
                <SessionRow
                  key={w.index}
                  project={p}
                  window={w}
                  onOpen={() => onOpenSession(p.tmuxSession, w.index)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors referencing `SessionListScreen.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/mobile/SessionListScreen.tsx
git commit -m "feat(mobile): touch-sized session list screen

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 4: SessionScreen (drilled-in chat/terminal view)

Compact header + actions sheet + reused-body gate. Mirrors desktop's `opencodeSessionId` gate exactly.

**Files:**
- Create: `src/renderer/mobile/SessionScreen.tsx`

- [ ] **Step 1: Create `src/renderer/mobile/SessionScreen.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useStore, resolveSessionOwner } from "../store";
import { ChatPanel } from "../ChatPanel";
import { Terminal } from "../Terminal";

type Props = {
  projectName: string;
  windowIndex: number;
  onBack: () => void;
};

export function SessionScreen({ projectName, windowIndex, onBack }: Props) {
  const projects = useStore((s) => s.projects);
  const [sheetOpen, setSheetOpen] = useState(false);

  const project = projects.find((p) => p.tmuxSession === projectName);
  const win = project?.windows.find((w) => w.index === windowIndex);

  // Pop back to the list if the window vanished (killed remotely / status
  // poller dropped it) instead of rendering a dead body.
  useEffect(() => {
    if (projects.length > 0 && !win) onBack();
  }, [projects.length, win, onBack]);

  if (!project || !win) return null;

  const sid = win.opencodeSessionId;
  const owner = sid ? resolveSessionOwner(projects, sid) : null;

  const sessionAction = (
    fn: (a: { sessionId: string }) => Promise<unknown>,
  ) => {
    if (!sid) return;
    fn({ sessionId: sid }).catch(() => {});
    setSheetOpen(false);
  };

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <button
          className="mobile-tap text-accent text-2xl leading-none"
          onClick={onBack}
          aria-label="Back to sessions"
        >
          ‹
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-text font-bold text-sm truncate">{win.name}</div>
          <div className="text-text-faint text-xs truncate">
            {projectName}
            {sid ? " · chat" : " · terminal"}
          </div>
        </div>
        {sid && (
          <button
            className="mobile-tap text-text-muted text-xl"
            onClick={() => setSheetOpen(true)}
            aria-label="Session actions"
          >
            ⋯
          </button>
        )}
      </div>

      <div className="mobile-body">
        {sid ? (
          <ChatPanel
            sessionId={sid}
            tmuxSession={owner?.tmuxSession ?? null}
            windowIndex={owner?.windowIndex ?? null}
            cwd={owner?.cwd ?? ""}
            isActive={true}
          />
        ) : (
          <Terminal projectName={projectName} active={true} />
        )}
      </div>

      {sheetOpen && sid && (
        <div
          className="mobile-sheet-backdrop"
          onClick={() => setSheetOpen(false)}
        >
          <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => sessionAction(window.api.opencodeForkSession)}>
              Fork session
            </button>
            <button
              onClick={() => sessionAction(window.api.opencodeCompactSession)}
            >
              Compact context
            </button>
            <button
              className="danger"
              onClick={() => {
                if (sid) window.api.opencodeDeleteSession({ sessionId: sid }).catch(() => {});
                setSheetOpen(false);
                onBack();
              }}
            >
              Delete session
            </button>
            <button onClick={() => setSheetOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the ChatPanel/Terminal prop contracts match**

Confirm against source (no code change — verification only):

Run: `grep -n "sessionId: string;\|tmuxSession: string | null;\|windowIndex: number | null;\|cwd: string;\|isActive: boolean;" src/renderer/ChatPanel.tsx && grep -n "projectName: string;\|active: boolean;" src/renderer/Terminal.tsx`
Expected: prints the `Props` fields — confirms `<ChatPanel>` and `<Terminal>` are called with exactly their declared props.

- [ ] **Step 3: Verify the opencode action signatures exist**

Run: `grep -n "opencodeForkSession\|opencodeCompactSession\|opencodeDeleteSession" src/renderer/api/httpApi.ts`
Expected: all three appear (they are part of the shim's `window.api` surface). If `opencodeCompactSession` is absent or named differently, drop that one button — fork + delete are sufficient for slice 4; note the deviation.

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors referencing `SessionScreen.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/mobile/SessionScreen.tsx
git commit -m "feat(mobile): session screen reusing ChatPanel/Terminal as body

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 5: MobileApp shell + wire into main.tsx

The root shell: nav stack, store bootstrap, status subscription, edge-swipe/back, retry-on-failure. Then flip `main.tsx` to render it on the no-Electron branch.

**Files:**
- Create: `src/renderer/mobile/MobileApp.tsx`
- Modify: `src/renderer/main.tsx` (render branch)

- [ ] **Step 1: Create `src/renderer/mobile/MobileApp.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { SessionListScreen } from "./SessionListScreen";
import { SessionScreen } from "./SessionScreen";

type Nav =
  | { screen: "list" }
  | { screen: "session"; projectName: string; windowIndex: number };

export function MobileApp() {
  const refresh = useStore((s) => s.refresh);
  const setActive = useStore((s) => s.setActive);
  const applyStatusBatch = useStore((s) => s.applyStatusBatch);

  const [nav, setNav] = useState<Nav>({ screen: "list" });
  const [bootError, setBootError] = useState<string | null>(null);

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

  const goList = () => setNav({ screen: "list" });
  const openSession = (projectName: string, windowIndex: number) => {
    setActive(projectName, windowIndex);
    setNav({ screen: "session", projectName, windowIndex });
  };

  // Android hardware back / browser back → pop to list.
  useEffect(() => {
    const onPop = () => {
      if (nav.screen === "session") {
        goList();
      }
    };
    window.addEventListener("popstate", onPop);
    if (nav.screen === "session") window.history.pushState({ s: "session" }, "");
    return () => window.removeEventListener("popstate", onPop);
  }, [nav.screen]);

  // Left-edge swipe → back (recognized only from the screen edge so it does
  // not fight xterm or wide code blocks inside the body).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t.clientX <= 24 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s || nav.screen !== "session") return;
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
            (nav.screen === "session" ? " mobile-screen--list-behind" : "")
          }
        >
          <SessionListScreen
            onOpenSession={openSession}
            onCreate={doRefresh}
          />
        </div>
        {nav.screen === "session" && (
          <SessionScreen
            projectName={nav.projectName}
            windowIndex={nav.windowIndex}
            onBack={goList}
          />
        )}
      </div>
    </div>
  );
}
```

Note: `onCreate` is wired to `doRefresh` for this slice (a working create flow — lifting Sidebar's new-session/new-project modal into a mobile sheet — is a documented follow-up, not in the success-criteria slices; `+` re-syncs the list so externally-created sessions appear). Record this as a known limitation in the completion notes.

- [ ] **Step 2: Flip `main.tsx` to render MobileApp on the mobile branch**

Current `src/renderer/main.tsx` (verified contents):

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import "./mobile/mobile.css";
import { httpApi } from "./api/httpApi";

if (!(window as unknown as { api?: unknown }).api) {
  (window as unknown as { api: unknown }).api = httpApi;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Replace its entire contents with:

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MobileApp } from "./mobile/MobileApp";
import "./index.css";
import "./mobile/mobile.css";
import { httpApi } from "./api/httpApi";

// No Electron preload → this is the mobile/web client. Install the HTTP shim
// and render the mobile-native shell. Electron (preload set window.api) keeps
// the desktop <App/> exactly as before — desktop cannot reach mobile code.
const isMobile = !(window as unknown as { api?: unknown }).api;
if (isMobile) {
  (window as unknown as { api: unknown }).api = httpApi;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isMobile ? <MobileApp /> : <App />}</React.StrictMode>,
);
```

- [ ] **Step 3: Verify the whole renderer type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full test suite (desktop logic must be untouched)**

Run: `npx vitest run`
Expected: PASS — `chatUtils.test.ts` and `store.test.ts` green. No desktop source files were modified, so no behavior change.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/mobile/MobileApp.tsx src/renderer/main.tsx
git commit -m "feat(mobile): MobileApp shell + render gate in main.tsx

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 6: Desktop non-regression gate

Prove the desktop Electron UI is byte-identical before touching the device. This is the spec's hard invariant.

**Files:** none (verification only).

- [ ] **Step 1: Confirm no desktop source changed**

Run: `git diff --stat main -- src/renderer/App.tsx src/renderer/Sidebar.tsx src/renderer/ChatPanel.tsx src/renderer/Terminal.tsx src/renderer/Settings.tsx src/main src/preload`
Expected: **empty output** (zero lines changed in any desktop-path file). If anything prints, STOP — an invariant is violated; revert that change.

- [ ] **Step 2: Build the Electron renderer**

Run: `npm run build` (or the project's Electron build script — check `package.json` `scripts`; do not run `build:mobile` here)
Expected: build succeeds.

- [ ] **Step 3: Launch the desktop app and sanity-check**

Run the Electron app (project's normal dev/run command, e.g. `npm run dev`). Verify: sidebar renders, a session opens into the desktop ChatPanel/Terminal, layout unchanged. Because `main.tsx` injects `window.api` via Electron preload, `isMobile` is false and `<App/>` renders — the mobile code is unreachable.
Expected: desktop behaves exactly as before this branch.

- [ ] **Step 4: Commit (gate marker, no code)**

```bash
git commit --allow-empty -m "test: desktop non-regression gate verified (no desktop files changed)

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 7: Device verification — slice 1 (shell + list)

**Files:** none (device verification).

- [ ] **Step 1: Build the mobile bundle and APK**

Run:
```bash
npm run build:mobile
cd mobile && npm run apk && adb -s R83W80ERC6A install -r android/app/build/outputs/apk/debug/app-debug.apk
cd ..
```
Expected: build + APK install succeed. (No `src/server/*` changes → the `bui-server` tmux session is NOT restarted; other work sessions untouched.)

- [ ] **Step 2: Launch on device and verify the list**

Open the app on device `R83W80ERC6A` (app id `com.antoinedc.bui`). Verify:
- App boots into the **Sessions** list (not the desktop layout).
- Rows are project-grouped, each ≥48px tall, with status dot + name + type label.
- Status dots reflect running/attention live (trigger activity in a session, watch the dot).

Capture: `adb -s R83W80ERC6A exec-out screencap -p > /tmp/bui-slice1.png` and review it.
Expected: a native-looking touch list; tapping a row is easy (the tiny-tap-target bug is gone).

- [ ] **Step 2b: If the list is wrong, debug before proceeding**

If rows are missing/cramped or the desktop layout still shows: inspect via Chrome DevTools (`chrome://inspect` → the WebView). Confirm `isMobile` is true and the root has class `mobile`. Fix in the relevant Task 2/3/5 file, re-run Step 1, re-verify. Do not proceed to Task 8 until slice 1 passes.

- [ ] **Step 3: Commit (slice marker)**

```bash
git commit --allow-empty -m "test(mobile): device slice 1 verified — shell + touch session list

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 8: Device verification — slice 2 (drill-down + chat)

**Files:** none (device verification).

- [ ] **Step 1: Drill into a chat session**

On device, tap a session whose type label is `chat`. Verify:
- The session screen slides in; header shows back chevron, name, `projectName · chat`, and `⋯`.
- The reused `ChatPanel` renders the transcript.

- [ ] **Step 2: Send a prompt and verify streaming + composer**

Type a short prompt, send. Verify:
- The response streams in (ChatPanel's existing SSE path works through the shim).
- The composer/input sits **above** the on-screen keyboard (not hidden behind it). If it is hidden, adjust the `.mobile .chat-input-area` rule in `mobile.css` (inspect the actual input wrapper class via DevTools, update the selector to match), rebuild (Task 7 Step 1), re-verify.

- [ ] **Step 3: Verify back navigation**

Press the back chevron, the Android hardware back button, and a left-edge swipe. Each returns to the Sessions list. Re-opening the session shows the same conversation.

Capture: `adb -s R83W80ERC6A exec-out screencap -p > /tmp/bui-slice2.png` and review.
Expected: native drill-down feel; streaming intact; keyboard-aware composer.

- [ ] **Step 4: Commit (slice marker)**

```bash
git commit --allow-empty -m "test(mobile): device slice 2 verified — drill-down chat + composer

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 9: Device verification — slice 3 (terminal session)

**Files:** none (device verification).

- [ ] **Step 1: Drill into a terminal session**

On device, tap a session whose type label is `terminal` (no opencode session id). Verify:
- `Terminal` (xterm.js) fills the body region below the mobile header.
- It fits correctly (Terminal's existing <50px guard + ResizeObserver handle the full-screen mobile size).
- Keyboard input reaches the terminal; output renders.

- [ ] **Step 2: Verify back + no gesture conflict**

Left-edge swipe returns to the list. A horizontal scroll/drag *inside* the terminal (not from the edge) does NOT trigger back.

Capture: `adb -s R83W80ERC6A exec-out screencap -p > /tmp/bui-slice3.png` and review.
Expected: full-screen working terminal; edge-swipe back only from the edge.

- [ ] **Step 3: Commit (slice marker)**

```bash
git commit --allow-empty -m "test(mobile): device slice 3 verified — terminal session full-screen

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 10: Device verification — slice 4 (actions + questions/permissions)

**Files:** none (device verification).

- [ ] **Step 1: Session actions sheet**

In a chat session, tap `⋯`. Verify the bottom sheet opens with Fork / Compact / Delete / Cancel. Tap **Fork** — verify the RPC fires (a forked session appears on next list refresh). Tap **Delete** on a throwaway session — verify it deletes and the app pops back to the list.

- [ ] **Step 2: QuestionCard + permission reply in mobile chat**

Drive a session to ask a question / request a permission (run a prompt that triggers one). Verify the reused `ChatPanel`'s QuestionCard and permission UI render and are tappable on mobile (targets large enough), and that replying works end-to-end.

- [ ] **Step 3: Create affordance**

Tap `+` on the Sessions list. Verify the list re-syncs (known limitation: full create-modal flow is a documented follow-up; `+` currently refreshes so externally-created sessions appear).

Capture: `adb -s R83W80ERC6A exec-out screencap -p > /tmp/bui-slice4.png` and review.
Expected: actions + interactive cards work on mobile.

- [ ] **Step 4: Final full-suite + non-regression re-check**

Run:
```bash
npx vitest run
git diff --stat main -- src/renderer/App.tsx src/renderer/Sidebar.tsx src/renderer/ChatPanel.tsx src/renderer/Terminal.tsx src/main src/preload
```
Expected: vitest PASS; the `git diff --stat` is **empty** (desktop still untouched).

- [ ] **Step 5: Commit (slice marker)**

```bash
git commit --allow-empty -m "test(mobile): device slice 4 verified — actions + questions/permissions

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Task 11: Update AGENTS.md (document what shipped)

**Files:**
- Modify: `AGENTS.md` (the "Open work" section, ~line 421; and the Mobile/web client section ~line 102)

- [ ] **Step 1: Update the AGENTS.md mobile section and open-work list**

In `AGENTS.md`, under `## Mobile / web client (src/server/)`, add a short paragraph after the `**Capacitor wrapper**` paragraph (~line 148):

```markdown
**Mobile-native shell** (`src/renderer/mobile/`): on the no-`window.api`
branch `main.tsx` renders `<MobileApp/>` instead of `<App/>` — a drill-down
shell (`SessionListScreen` → `SessionScreen`) that reuses `ChatPanel` /
`Terminal` unchanged. CSS is `.mobile`-scoped (`mobile/mobile.css`) so it
never matches the desktop tree. Desktop `App.tsx`/`Sidebar.tsx` are untouched.
Session owner→props mapping is the tested `resolveSessionOwner()` in
`store.ts`.
```

In the `## Open work` section (~line 421), add:

```markdown
- **Mobile create flow** — `+` on the mobile session list currently only
  re-syncs; the new-session/new-project modal (desktop `Sidebar.tsx`) is not
  yet lifted into a mobile sheet.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document mobile-native shell in AGENTS.md

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

## Done

All success-criteria slices device-verified, desktop provably untouched, full vitest suite green. Out-of-scope follow-ups (auth/open-port, markdown links, subagent rendering, mobile create-modal) remain documented and unfolded.
