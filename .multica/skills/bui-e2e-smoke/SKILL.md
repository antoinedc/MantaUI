---
name: bui-e2e-smoke
description: Drive BUI's built Electron app in a real renderer context (Playwright's electron launcher) and assert that key UI surfaces render correctly — no crash, no blank screen, sidebar/chat/terminal present. Load BEFORE marking any frontend/UI task done, and when bui-pr-workflow or bui-handle-reviewer-return verifies a renderer change. Catches the runtime/render/layout failures that `npm run typecheck && npm test` + `npm run build` all miss.
---

# bui-e2e-smoke

`typecheck` proves the code **compiles**. Unit tests prove **isolated logic**.
`npm run build` proves the **bundle produces artifacts**. NONE of them prove the
Electron app **renders correctly in a real renderer with real IPC wiring**.

This gate exists because an empty renderer, a crashed main process, or a layout
regression (sidebar collapsed onto nothing, chat panel off-screen) all pass a
green build and green unit tests. A text fetch cannot see any of these. A real
Electron renderer can. This skill is that renderer.

> **PUSH YOUR BRANCH BEFORE RUNNING THIS GATE.** The Electron launch below can
> hang (first-run download, a wedged renderer, no display teardown) long enough
> to trip multica's 30-min "no new messages" force-stop. If you ran this gate
> *before* `git push`, that timeout discards your entire implementation — the
> workdir is ephemeral and the rerun starts from a clean `origin` clone. Per
> `bui-pr-workflow` step 8, your committed work must already be on `origin`
> before you get here. If it isn't, `git push -u origin <branch>` NOW, then run
> the gate. Push any post-gate fixes again afterward.

> **You CAN run this — do not claim you can't.** Playwright's `electron.launch`
> spawns the actual built app. On the FIRST call it does a one-time Electron
> fetch + launch (~15-30s) — that is normal init, not a failure; wait for it.
> "My sandbox has no Electron / no display" is FALSE for this runtime on Linux
> — Playwright handles the headless display internally. The ONLY legitimate
> "I couldn't run it" is a launch step that *actually errors* — capture and
> quote that exact error.

## When to run

- **`bui-frontend` / `bui-backend`**: before marking ANY change to:
  - `src/renderer/` (ChatPanel, Terminal, Sidebar, Settings, App, ProvidersCard)
  - `src/preload/` (IPC bridge surface)
  - `src/main/` (IPC handlers, setup, transport)
  - `src/shared/` (types consumed by renderer)
  Paste the result into the `Test results` block. A green build does NOT prove
  the sidebar renders, the chat panel mounts, or the app didn't crash on load.
- **`bui-pr-workflow` / `bui-handle-reviewer-return`**: when verifying a
  delivered frontend feature (the per-task "verify on dev" step). This is the
  check that makes "renders in Electron, confirm no crash" a REAL gate instead
  of an unenforceable instruction.

## Prerequisites

1. **The app must be built.** Run `npm run build` before launching. The
   launcher expects `out/main/index.js` (main) and `out/renderer/index.html`
   (renderer). Without a build, the launcher exits immediately with no window.
2. **`@playwright/test` must be installed.** It is in `devDependencies` — if
   `node_modules/@playwright/test` is missing, run `npm install` first.
3. **Linux CI / headless:** Playwright's Electron launcher handles display
   internally. If you MUST run outside Playwright (e.g. manual `electron out/`),
   wrap with `xvfb-run`. This skill does NOT need that — it goes through
   Playwright.

## Procedure

1. Run `npm run build` (only if `out/main/index.js` doesn't exist or is stale).
2. Launch the app via Playwright's Electron launcher:
   ```ts
   import * as electron from '@playwright/test';
   const app = await electron.launch({
     args: ['out/main/index.js'],
     env: { ...process.env, NODE_ENV: 'test' },
   });
   const mainWindow = app.firstWindow();
   await mainWindow.waitForLoadState('domcontentloaded');
   // Wait for the renderer to finish initial mount.
   await app.evaluate(async ({ BrowserWindow }) => {
     const win = BrowserWindow.getAllWindows()[0];
     await new Promise<void>((resolve) => {
       if (win.isDestroyed()) return resolve();
       win.once('ready-to-show', () => resolve());
       if (!win.isDestroyed() && win.isVisible()) resolve();
     });
   });
   ```
3. Run the **invariant assertions** below via `mainWindow.evaluate`.
4. `mainWindow.evaluate(() => [...window.__playwrightErrors ?? []])` → assert no
   uncaught `pageerror` / `console.error` (allowlist: resource 404s for missing
   favicons are fine). ANY React error or `TypeError`/`ReferenceError` fails
   the gate.
5. Paste the assertion results into the issue/PR. PASS only if every invariant
   holds.

## Invariant assertions (the load-bearing part)

Run with `mainWindow.evaluate`. Each assertion returns a result object; the
caller asserts `.OK` is true.

```js
// A. Main process alive, window not closed.
() => {
  const closed = mainWindow.closed().catch(() => true);
  const title = mainWindow.title();
  return {
    windowClosed: closed,
    windowTitle: title,
    A_OK: !closed && !!title,
  };
}

// B. Sidebar is rendered and non-empty (aside.w-64).
//    The sidebar is the left `<aside>` with class `w-64` containing the
//    "Workspace" heading. Even with zero projects it must render the heading
//    and the "+" button — a missing sidebar means the App component failed
//    to mount or the sidebar was conditionally hidden by a regression.
() => {
  const aside = document.querySelector('aside.w-64');
  const workspaceHeader = document.querySelector('h2')?.textContent;
  const plusButton = document.querySelector('button[title="New project (⌘N)"]');
  return {
    sidebar_present: !!aside,
    sidebar_width: aside?.getBoundingClientRect().width,
    workspace_heading: workspaceHeader,
    new_project_button: !!plusButton,
    B_OK: !!aside && !!workspaceHeader && !!plusButton,
  };
}

// C. Main content area exists with the titlebar-drag region.
//    The <main> holds the titlebar (`.titlebar-drag`) and the panel area.
//    If <main> is missing or empty, the renderer mounted but the App layout
//    collapsed — usually a CSS regression or conditional render bug.
() => {
  const main = document.querySelector('main');
  const titlebar = document.querySelector('.titlebar-drag');
  const titlebarText = titlebar?.querySelector('.text-xs')?.textContent ?? '';
  return {
    main_present: !!main,
    titlebar_present: !!titlebar,
    titlebar_content: titlebarText,
    C_OK: !!main && !!titlebar,
  };
}

// D. Terminal container exists (xterm.js mounts into a div).
//    The Terminal component renders `<div ref={containerRef} />` and xterm
//    appends a `.xterm` canvas/paragraph inside it. When no projects exist
//    the Terminal is not mounted (App.tsx only mounts visited projects), so
//    this assertion is conditional: if the sidebar shows ≥1 project, the
//    terminal must be present. If zero projects, skip the terminal check.
() => {
  const projectItems = document.querySelectorAll('aside.w-64 [class*="font-semibold"]');
  const hasProjects = projectItems.length > 0;
  const xterm = document.querySelector('.xterm');
  const xtermCanvas = document.querySelector('.xterm canvas');
  return {
    has_projects_in_sidebar: hasProjects,
    xterm_present: !!xterm,
    xterm_canvas_present: !!xtermCanvas,
    // Only fail if projects exist but terminal is missing.
    D_OK: !hasProjects || (!!xterm && !!xtermCanvas),
  };
}

// E. Chat panel renders when a chat-mode window is active.
//    ChatPanel mounts inside the main content area with a `.chat-panel` or
//    equivalent container. Without a chat-mode session active, this is
//    skipped (App.tsx only mounts visited chat sessions). When active, the
//    panel must have the transcript scroll container and the input area.
() => {
  const chatPanel = document.querySelector('[class*="chat"]')
    || document.querySelector('[class*="transcript"]')
    || document.querySelector('[class*="message"]');
  const inputArea = document.querySelector('textarea')
    || document.querySelector('[class*="input"]');
  const hasActiveChat = !!chatPanel;
  return {
    chat_panel_present: hasActiveChat,
    input_area_present: !!inputArea,
    // Pass if no chat session is active (ChatPanel not mounted).
    E_OK: !hasActiveChat || (!!chatPanel && !!inputArea),
  };
}

// F. No uncaught errors in the renderer console.
//    Allowlist: resource 404s (missing favicon, etc.) are benign. Everything
//    else — React errors, TypeError, ReferenceError, "Cannot read properties
//    of undefined" — is a real failure.
() => {
  const errors = [...window.__playwrightErrors ?? []];
  const benignPatterns = [/favicon/, /\.ico/, /404/];
  const realErrors = errors.filter(e =>
    !benignPatterns.some(p => p.test(e))
  );
  return {
    total_console_errors: errors.length,
    real_errors: realErrors.length,
    real_error_samples: realErrors.slice(0, 3),
    F_OK: realErrors.length === 0,
  };
}
```

### Assertion failure diagnostics

- **A fails** (window closed, no title) → main process crashed on launch.
  Check the Electron devtools console (`app.evaluate` can grab `console.error`
  output) and the main process logs. Common causes: missing preload script,
  IPC handler crash, unhandled promise rejection in main.
- **B fails** (no sidebar) → App component failed to mount, or Sidebar
  conditionally renders nothing. Check for React errors in F. If F is clean
  but sidebar is missing, the `<aside>` may be off-screen (CSS regression:
  `display:none`, `width:0`, or the flex layout collapsed it).
- **C fails** (no main/titlebar) → the App layout tree is broken. Usually a
  conditional render path (e.g. `!loaded` showing nothing) or a CSS class
  rename that the layout depends on.
- **D fails** (projects exist but no xterm) → Terminal component failed to
  mount or xterm.js failed to initialize. Check console for xterm errors
  (usually WebGL context loss or missing font).
- **E fails** (chat panel present but no input) → ChatPanel mounted but the
  input area's selector didn't match. Improve the selector or check that the
  input is rendered (it may be a `div[contenteditable]` instead of `textarea`).
- **F fails** (real errors) → whatever the error samples say. React errors
  usually point to a missing prop or failed IPC call.

## Hard rules

- This skill **does not deploy** and **does not edit source**. It only launches
  the built app + asserts.
- **Always build first.** If `out/main/index.js` doesn't exist, run
  `npm run build`. A stale build serves stale code — if the rendered UI doesn't
  match the expected post-fix behavior AND `git -C <repo> log -1` predates the
  merge, the build is stale; note that on the issue and ask the human to
  rebuild.
- Selectors here are intentionally structural (class names, aria labels,
  attribute selectors). If an assertion can't locate a component that
  visibly exists, improve the selector (or add a stable `data-*` hook in a
  follow-up), don't pass by default.
- **Focus on rendering, not functionality.** SSH connections, tmux sessions,
  opencode SSE streams — these require live remote infrastructure. The smoke
  test asserts the UI *would* work (components mount, layout is correct), not
  that the backend is reachable.
- If the launcher genuinely fails to start Electron, quote the exact error on
  the issue and fall back to requiring the implementer's pasted render
  evidence — never claim the app "renders fine" on a green build alone.

## Limitations

- Requires a built app (`npm run build` first). This skill does not run it —
  the implementer or CI must ensure the build is current.
- Electron on headless Linux CI may need `xvfb-run` if running outside
  Playwright. Playwright's launcher handles this internally.
- Some features (SSH, tmux, opencode SSE) require live remote connections —
  tests focus on UI rendering, not end-to-end functionality.
- The app's first launch may show a blank screen briefly while the renderer
  initializes. The `ready-to-show` wait in the procedure handles this.
