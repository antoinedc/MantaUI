# File explorer follow-up — window corners, sidebar button, motion

Status: agreed 2026-11-03 · Branch `feat/explorer-followup` · Builds on
`2026-11-02-file-explorer.md` (PR #1664) · Design sources
`docs/screens/explorer/{mockup.html,contract.md}` (updated by this change).

## Problems

1. **Top-left mash-up (macOS).** With the sidebar hidden and a banner showing
   (update / reconnecting / incompatible), the banner starts at x=0 under the
   traffic lights, and the floating sidebar button sits on top of the banner
   text. Cause: the left clearance (`--sidebar-hidden-inset`) is applied to
   every pane header, but never to the banner. The banner is the element that
   is actually at the window's top-left. The floating button is absolutely
   positioned at a fixed `top: 10px`, so it lands on whatever happens to be at
   the top.
2. **Sidebar button placement.** It floats over content instead of sitting
   in a header.
3. **The Explorer opens and closes in one frame.** The Artifacts panel slides
   instead.
4. **Rendered / Source switch (`Segmented`) jumps.** The Artifacts kind tabs
   glide instead.
5. **Windows.** The minimize/maximize/close buttons cover the top-right of the
   window. Problems found:
   - The Artifacts header doesn't reserve room for them, so its search
     button sits under them.
   - The session header reserves the corner even when a panel to its right
     already owns it. That wastes ~138 px.
   - Settings reserves the corner twice.
   - The buttons are 40 px tall, but the headers are 44 px.
   - The buttons stay dark in light mode.

User decisions (2026-11-03):
- the sidebar button goes next to the sidebar search icon;
- the Windows buttons follow the theme;
- a real-Windows CI check is deferred.

The overriding requirement: **no control is ever hidden under OS window
controls, on any OS.**

## Libraries considered

| Need | Chosen | Considered → why not |
|---|---|---|
| Know where Windows caption buttons are | Electron's built-in Window Controls Overlay: CSS `env(titlebar-area-*)`. It is already in `tokens.css`, and updates on maximize/DPI/zoom. | `custom-electron-titlebar` 4.4.1 (~3.4k/wk): draws fake caption buttons, peer `electron>36` (we are on 31). `@electron-uikit/titlebar` (~98/wk): fake buttons, tiny adoption. `frameless-titlebar` / `electron-titlebar-windows`: unmaintained. `navigator.windowControlsOverlay` JS API: not needed, since CSS env already reflows live. `matchMedia('(display-mode: window-controls-overlay)')`: broken in Electron (#51393). |
| Theme the caption buttons | `BrowserWindow.setTitleBarOverlay` (Electron built-in) | Transparent overlay colour: not reliable on Electron 31 and changes hover behaviour; matching the header colour is deterministic. |
| Explorer open/close slide | `react-resizable-panels` 4.16.1 (in use) `collapsible` Panel + a CSS `flex-grow` transition while toggling. The library sizes panels with `flex-grow`. | framer-motion width animation (the Artifacts approach; already a dependency): it would fight the library, which owns the panel's size. Imperative `setLayout` per frame: hand-rolled tweening, and it breaks the user's stored ratio. The library has no built-in animation option. |
| Rendered/Source sliding pill | framer-motion (in use) `layoutId` shared-layout pill, scoped by `useId`, with `layoutDependency={value}` | Hand-measured `offsetLeft`/`offsetWidth` + CSS transform (the Artifacts tabs' approach): own measuring + resize code where the library already does it. Pure `calc()` widths only work for equal-width segments. Rendered/Source are unequal. |
| Overlap test | Playwright `visual` project (in use) | A Windows Electron CI job: deferred by decision. Screenshots can't see native buttons anyway. |
| Sidebar button, clearance variables | Own code (~30 lines, layout only) | Nothing to adopt: app-specific layout. |

## 1. One owner for each window corner

### Top-left (macOS traffic lights)

The traffic lights sit at x 14 … ~70, y 14 … ~28.

They only cover app content when the sidebar is hidden; otherwise they sit
over the sidebar's own drag strip, as today.

App sets these CSS variables on the app root (replacing
`--sidebar-hidden-inset`, which is deleted along with
`SIDEBAR_HIDDEN_INSET_PX` / `sidebarHiddenInsetPx`):

| Variable | Value |
|---|---|
| `--tl-inset-x` | `76px` when macOS and the sidebar is hidden, else `0px` (`TRAFFIC_LIGHT_INSET_PX = 76` in `explorer/layout.ts`, same number as today's toggle `left`). |
| `--banner-inset-x` | `--tl-inset-x` when a top banner is showing, else `0px`. |
| `--pane-inset-x` | `0px` when a top banner is showing, else `--tl-inset-x`. |
| `--pane-inset-top` | `40px` when macOS, sidebar hidden and no banner, else `0px`. Used only by the Explorer's Expanded rail, which is narrower than the traffic lights. |

"A top banner is showing" means exactly one of these renders:
- `ReconnectingBanner`;
- the incompatible `UpdateBar`;
- the in-flight `UpdateBar`;
- the updates `UpdateBar`.

Compute it once, from the same conditions that gate those four renders, as a
`topBannerShown` boolean, and reuse that boolean in the render instead of
repeating the conditions.

Who reads the variables:
- **Banners** (`UpdateBar`, `ReconnectingBanner`):
  `padding-left: max(var(--sp-3), var(--banner-inset-x, 0px))`.
- **Banners — window dragging.** A banner that is the window's top edge must
  still let the user drag the window. Add `titlebar-drag` to the banner row and
  `titlebar-no-drag` to its buttons/links.
- **Pane headers:**
  - `SessionHeader`
  - the App titlebar for terminal / new-session panes
  - `CtoChat` header
  - `RoutinesParts` header
  - the Explorer top bar in Expanded mode

  Each sets `padding-left: max(var(--sp-3 | --sp-4 as today), var(--pane-inset-x, 0px))`.
  The Explorer top bar in Expanded mode uses `calc(var(--pane-inset-x) - 44px)`
  as today, because the rail is 44 px.
- **Expanded rail:** `padding-top: max(var(--sp-3), var(--pane-inset-top, 0px))`.
  This replaces the `railClearsTrafficLights` / `pt-10` logic.

### Top-right (Windows caption buttons)

`--titlebar-inset-right` (tokens.css, unchanged) is 0 on macOS/Linux and equals
the caption-button width on Windows.

**Exactly one header reserves it in each column stack.** That header is the
one touching the window's right edge:

| Right panel shown for the visible session | Header that reserves |
|---|---|
| none | `SessionHeader` (and the App titlebar / CTO / Routines for their panes) |
| Explorer (split or Expanded) | Explorer top bar (already does) |
| Artifacts | **Artifacts header — new**: `padding-right: calc(var(--sp-3) + var(--titlebar-inset-right))` on its title row |

How `SessionHeader` decides:
- It drops its reservation while `useShownRightPanel(sessionId) !== "none"`.
- It reads this from the explorer store (no new state).
- Its right padding then becomes plain `var(--sp-3)`.

Other rules:
- **Banners** keep their existing right reservation.
- **Headers under a banner still reserve.** The banner (~37 px) is shorter
  than the caption buttons (44 px), so the buttons can still reach into the
  header below it.
- **Settings:** remove the redundant `.titlebar-inset-right` spacer from the
  row under its drag strip. The strip already sits beside the buttons. Make the
  strip `h-11` so the row starts below them.

**Height.**
- `titleBarOverlay.height` becomes **44**, matching the `h-11` headers.
- The App titlebar for terminal / new-session panes goes `h-12` → `h-11`.
- The doc comment in `windowChrome.ts` names the coupled heights: SessionHeader,
  Explorer top bar, App titlebar, Routines, Settings strip.

**Theme.** The caption buttons follow the theme.
- New preload bridge `setTitleBarOverlay({ color, symbolColor })`, exposed on
  `window.__mantaPreload`. Main validates both values as `#RRGGBB` and calls
  `BrowserWindow.fromWebContents(sender).setTitleBarOverlay` on **win32 only**.
  It is a no-op elsewhere. This is a background sync, not a user control.
- A small renderer effect (in App) sends it on:
  - first mount,
  - every resolved-theme change,
  - every change of the visible session's right panel.

  `color` = the resolved background of the header under the buttons:
  - `--bg-elev` when the Explorer or Artifacts is shown,
  - otherwise the session/titlebar header background.

  `symbolColor` = resolved `--text-muted`.

  Read the colours with `getComputedStyle(document.documentElement)`. Never
  hardcode hex in the renderer.
- Initial `titleBarOptions` colours stay as today, until the first sync.

**RTL.** On RTL Windows the caption buttons sit on the left. Define
`--titlebar-inset-left: env(titlebar-area-x, 0px)` in tokens.css and fold it
into `--tl-inset-x`:
`max(<macOS value>, var(--titlebar-inset-left))`. Also apply it to the sidebar
header's left padding. It is 0 everywhere else, so it costs nothing.

## 2. Sidebar button

The floating `SidebarToggle` (absolute, `z-40`) is deleted. The button is the
same `IconButton`, with:
- `PanelLeft` icon
- `hook="manta-sidebar-toggle"`
- label "Hide sidebar" / "Show sidebar"
- title `… (⌘B)`

It lives in one of two places:

- **Sidebar visible:**
  - The button sits in the sidebar's Workspace header, immediately left of the
    search button, in the same `gap-1` group.
  - The Windows `pl-12` on that header is removed (it only made room for the
    floating button).
  - The header's left padding becomes `max(var(--sp-3), var(--titlebar-inset-left))`.
- **Sidebar hidden:**
  - The button is the **first control** of the top-left pane header, after
    the `--pane-inset-x` clearance:
    - `SessionHeader`
    - the App titlebar (terminal / new-session panes)
    - `CtoChat` header
    - `RoutinesParts` header
    - in Expanded mode, the Explorer top bar, before the tree toggle. Here
      `SessionHeader` is folded away.
  - Implement this once, as `<SidebarRevealButton/>` in `SidebarToggle.tsx`:
    - It renders nothing while the sidebar is visible.
    - It carries `titlebar-no-drag`.
  - Each of the headers above renders it as its first child.
  - `SessionHeader` renders it only while the session's Explorer is not
    Expanded, so exactly one copy shows.

⌘B, the localStorage key and the sidebar's slide are unchanged. Remove the
`SIDEBAR_TOGGLE_TOP_PX` / `sidebarToggleLeftPx` constants and their tests,
along with the old floating-toggle comment in App.

## 3. Explorer open / close slide

- The Explorer `Panel` becomes `collapsible` with `collapsedSize={0}`, and
  stays mounted for the visible chat while `active`.
- "Closed" = collapsed. Opening expands it to the stored ratio, the same
  restore path as today.
- The resize `Separator` is not rendered while collapsed.
- The Explorer's **contents** (`ExplorerPanel`) mount on open and unmount after
  the close animation ends, so a closed Explorer runs no effects or fetches.
- Other visited (inactive) chats keep a single Panel, as today.

**Motion.**
- While an open/close (and an Expanded ↔ split toggle) is in progress, the
  split root carries `data-animating`.
- CSS:
  `.manta-explorer-split[data-animating] > [data-panel] { transition: flex-grow var(--motion-base) var(--ease-out); }`.
  Use the library's actual panel attribute.
- `data-animating` is cleared on `transitionend`, with a timeout fallback of
  the token value + 50 ms.
- It is never set during a drag or a keyboard resize, so dragging stays 1:1.
- `--motion-base` (200 ms) + `--ease-out` match the Artifacts panel, the other
  right-hand panel (`MOTION_BASE` / `MOTION_EASE`).
- `@media (prefers-reduced-motion: reduce)` → no transition.

**No reflow while sliding.** Like Artifacts, the Explorer content holds a fixed
pixel width during the animation: its target open width, measured from the
group width × ratio. It sits inside an `overflow: hidden` panel, so it slides
in from the right edge rather than re-wrapping every frame. Width goes back to
`100%` when the animation ends.

**Unchanged:**
- ratio persistence: a collapse/expand is not a user interaction, so it is not
  stored;
- narrow auto-Expand;
- Esc;
- the per-session state.

## 4. Segmented sliding pill

`Segmented` gets the sliding highlight itself, so both adopters change
together: the Artifacts mode switch and the Markdown Rendered | Source switch.

- The active segment no longer paints `bg-raised shadow-sm`.
- Inside the active button, render
  `<motion.span layoutId={`${id}-pill`} layoutDependency={value} className="absolute inset-0 rounded-sm bg-raised shadow-sm" aria-hidden />`
  behind the label (`id` from `useId()`, label `relative z-10`).
- Transition: `{ type: "tween", duration: MOTION_SLOW, ease: MOTION_EASE }`.
  This is the Artifacts kind tabs' `--motion-slow` + `--ease-out`.
- `layoutDependency` means only a value change animates. A container resize (a
  panel drag) moves the pill with its button, with no lag.
- Reduced motion: the app's `MotionConfig reducedMotion="user"` already
  disables it.
- At rest the look is pixel-identical to today. Existing Segmented baselines
  must not change.

Record the behaviour in `docs/components.md` (Segmented row) and the explorer
contract.

## 5. Docs

- `docs/screens/explorer/contract.md`:
  - E1a (button placement, `SidebarRevealButton`)
  - the inset variables table (§Constants)
  - E0 motion
  - the Segmented P1 pill
  - Windows reservation table
- `mockup.html`:
  - the button in the sidebar header next to search;
  - the hidden-sidebar header with the button first;
  - a banner-above-header frame showing the banner owning the traffic-light
    clearance.
- Update `conformance.md` and `Last reviewed:` to the commit that adds the
  re-recorded baselines.

## 6. Tests

**Unit (vitest / node:test):**
- `windowChrome.test.ts`: win32 overlay height 44; the setTitleBarOverlay
  handler validates colours and is a no-op off win32.
- Inset helpers in `explorer/layout.ts`: pure functions for the four variables,
  given `{isMac, sidebarHidden, bannerShown}`.
- `SidebarRevealButton` renders nothing when visible.
- `SessionHeader` drops the right reservation when a right panel is shown
  (class/style assertion).
- `Segmented` renders exactly one pill, in the active button.

**Geometric overlap test** (new `tests/visual/window-controls.visual.ts`,
`visual` project, no screenshots). For each case it collects every visible
`button, a[href], input, [role=tab], [role=treeitem]`, and asserts none
intersects the OS-control rectangle.

- **Windows emulation.**
  - Setup:
    - `navigator.platform` / `userAgentData.platform` = Win32 via `addInitScript`;
    - inject `:root{--titlebar-inset-right:138px!important}`;
    - viewport 1280×800.
  - Forbidden rect: `x ≥ innerWidth − 138, y < 44`.
  - Cases: right panel none / Explorer / Explorer Expanded / Artifacts; sidebar
    hidden and visible; with and without a banner (`state=reconnecting`).
- **macOS emulation.**
  - Setup: platform `MacIntel`, sidebar hidden via the
    `manta:sidebarHidden` localStorage key.
  - Forbidden rect: `x < 76, y < 40`.
  - Same panel cases, with and without a banner.
  - Also assert the banner's text starts at x ≥ 76 when a banner shows.
  - The sidebar-visible case is exempt: the lights sit over the sidebar strip.

The test must fail on today's `main` for:
- the Artifacts search button (Windows case);
- the banner (macOS case).

Show that once, during implementation, then keep the test.

**Visual baselines:**
- Re-record the rows whose pixels legitimately change:
  - the explorer rows,
  - any row showing the sidebar header,
  - the terminal titlebar `h-11`.
- Every other row must stay unchanged; review the diff list.
- Add one row: explorer with sidebar hidden + reconnecting banner (macOS
  emulation), the reported bug.

## Out of scope

- The Electron 31 → current upgrade: 31 is end-of-life, and there is a known
  1 px DPI sliver bug (#52208). Flag it separately.
- A real Windows CI job (`windows-latest` + Playwright-Electron): deferred.
- Moving the Artifacts kind tabs onto the new pill: they are a tablist with
  counts, not a Segmented.
