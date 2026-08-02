/**
 * scripts/visual/screens.mjs — THE screen registry.
 *
 * This file is data. It is the only thing you edit to put a screen under
 * visual verification; no test file, no CI step and no script changes.
 * Everything downstream loops over this list:
 *
 *   tests/visual/screens.visual.ts   structure snapshot + pixel baseline
 *   scripts/visual/compare.mjs       app-vs-mockup side-by-side for review
 *
 * Adding a screen:
 *   1. Write docs/screens/<id>/mockup.html (see docs/visual-verification.md).
 *   2. Add a row here.
 *   3. `npm run visual:update` to record the baseline, and commit it.
 *
 * Field notes:
 *   url       Demo-mode URL, relative to the served app. `?demo` boots the
 *             fixture-backed transport — no box, no network, no clock skew.
 *             `&desktop` forces the desktop shell in a browser.
 *   ready     Selector proving boot finished. Gate on something structural.
 *   final     Selector proving the target state is on screen (defaults to
 *             `ready`). Required when `actions` navigates somewhere.
 *   snapshot  Element whose accessibility tree IS the structure contract.
 *             Defaults to `ready`, which is correct whenever `ready` is the
 *             screen's container. It is NOT correct when `ready` merely gates
 *             boot — a text selector snapshots that one text node, producing a
 *             one-line "contract" that would accept any regression. Set this
 *             whenever the captured state lives in a container that does not
 *             exist yet at boot (a dialog opened by `actions`).
 *   actions   Optional async (page) => {} to reach a state that is not a URL.
 *             Keep these to real user gestures — a click a person could make.
 *             If reaching a state needs internal poking, that is a signal the
 *             state should be URL-addressable instead.
 *   viewport  Fixed. Baselines are per-viewport; changing it invalidates them.
 *   mockup    Path (repo-relative) to the design. `null` means "no design
 *             filed yet" — the screen still gets a structure snapshot and a
 *             pixel baseline, but conformance review will report it as
 *             unspecified. Prefer filing the mockup.
 *
 *   region    Optional CSS selector for the element to capture instead of the
 *             full page. When set, the pixel assertion captures page.locator(
 *             region) rather than the full-page render, so a component can own
 *             a small baseline that only changes when that component changes —
 *             the header, the composer, a settings card — without re-recording
 *             a whole screen every time. A region row is a SEPARATE row whose
 *             url/ready/final/actions it inherits from its screen; the screen's
 *             own full-page row stays and remains the composition gate. The
 *             region crops the REAL page — it never renders the component in
 *             isolation, because an isolated render can be perfect while the
 *             page it lives on is broken.
 *   mockupRegion Optional CSS selector inside the mockup HTML, used by
 *             compare.mjs to find the matching region in the design. Defaults
 *             to `region`. It exists because the mockup is a different DOM and
 *             the selector usually differs (e.g. app `nav[role="tablist"]` vs
 *             mockup `.snav`).
 *   surfacesClosed  Hook classes (see AGENTS.md "Mobile CSS hook-class
 *                   contract") of every popup trigger present in this capture
 *                   but NOT opened by it. Committed inventory: a surface that
 *                   appears in EVERY row's list is opened by no capture and is
 *                   therefore unverified. Generate it from the assertion's own
 *                   failure output — never hand-write it.
 *
 *   Structure-root precedence: `snapshot ?? region ?? ready`. Explicit
 *   `snapshot` wins (a dialog opened by actions), then `region` when the row
 *   is a region crop (the component IS the structure contract the reviewer
 *   compares), then `ready`. The comparator and the release gate only ever
 *   cite this one annotation, so the precedence is the spec.
 */

/** @typedef {{
 *   id: string,
 *   title: string,
 *   url: string,
 *   ready: string,
 *   final?: string,
 *   snapshot?: string,
 *   region?: string,
 *   mockupRegion?: string,
 *   surfacesClosed?: string[],
 *   actions?: (page: any) => Promise<void>,
 *   viewport: { width: number, height: number },
 *   mockup: string | null,
 * }} Screen */

/** Desktop viewport every desktop screen is captured at. One number, one place. */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

/** @type {Screen[]} */
export const SCREENS = [
  {
    id: "welcome",
    title: "Welcome / new session composer (zero projects)",
    // The zero-project state IS this screen: App renders the new-session
    // composer full-panel when the box has no projects yet.
    url: "/app/index.html?demo&desktop&state=empty",
    ready: '[data-screen="welcome"]',
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/welcome/mockup.html",
    surfacesClosed: ["manta-effort-picker-btn", "manta-model-picker-btn"],
  },
  {
    id: "session",
    title: "Session view — rail, header, transcript, ask card, composer",
    // The product's main screen, and the one the marketing hero shows. The
    // fixture's `Deploy new billing service` session is the state the mockup
    // is drawn against: a permission card open, a tool call above it.
    url: "/app/index.html?demo&desktop",
    // The shell root exists from first paint, and it is also the structure
    // contract — the mockup covers rail + header + transcript + composer.
    ready: '[data-screen="session"]',
    // The permission card's heading proves the transcript rendered AND the
    // blocking ask is on screen — the state the design is specified for.
    final: "text=Run a shell command?",
    actions: async (page) => {
      await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/session/mockup.html",
    surfacesClosed: [
      "manta-ctx-pill",
      "manta-effort-picker-btn",
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
      "manta-session-menu-trigger",
    ],
  },
  {
    // The version-skew banner is a blocking, non-dismissible bar that no
    // capture has ever rendered. Same screen, same fixture, one URL param.
    id: "session-version-skew",
    title: "Session view with the version-skew banner (state)",
    url: "/app/index.html?demo&desktop&state=version-skew",
    ready: '[data-screen="session"]',
    final: '[data-screen="session"]',
    viewport: DESKTOP_VIEWPORT,
    // No mockup draws the banner; `null` is the registry's documented way to
    // say "no design filed" and the row still gets structure + pixels.
    mockup: null,
    // Same session shell as the `session` row, rendered without the click
    // action, so it closes the model/effort picker and session-menu triggers
    // (but not the click-only ctx pill). From the coverage gate's failure
    // output — BET-486 requires every non-opening row to declare this.
    surfacesClosed: [
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
    ],
  },
  {
    // The reconnecting banner (top-severity bar) — driven by the demo state
    // selector reporting a degraded events-WebSocket connection. No design
    // exists; `null` is the registry's documented way to say so.
    id: "session-reconnecting",
    title: "Session view with the reconnecting banner (state)",
    url: "/app/index.html?demo&desktop&state=reconnecting",
    ready: '[data-screen="session"]',
    final: '[data-screen="session"]',
    viewport: DESKTOP_VIEWPORT,
    mockup: null,
    surfacesClosed: [
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
    ],
  },
  {
    // The incompatible (wire-contract) card — driven by the box being on a
    // different major than the desktop. No design exists.
    id: "session-incompatible",
    title: "Session view with the incompatible banner (state)",
    url: "/app/index.html?demo&desktop&state=incompatible",
    ready: '[data-screen="session"]',
    final: '[data-screen="session"]',
    viewport: DESKTOP_VIEWPORT,
    mockup: null,
    surfacesClosed: [
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
    ],
  },
  {
    // The update-failed banner — driven by the fake transport reporting an
    // auto-update integrity failure. No design exists.
    id: "session-update-failed",
    title: "Session view with the update-failed banner (state)",
    url: "/app/index.html?demo&desktop&state=update-failed",
    ready: '[data-screen="session"]',
    final: '[data-screen="session"]',
    viewport: DESKTOP_VIEWPORT,
    mockup: null,
    surfacesClosed: [
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
    ],
  },
  {
    // The server-update "Box needs an upgrade" card — driven by the box being
    // older than the desktop on the same major. No design exists.
    id: "session-server-update",
    title: "Session view with the server-update banner (state)",
    url: "/app/index.html?demo&desktop&state=server-update",
    ready: '[data-screen="session"]',
    final: '[data-screen="session"]',
    viewport: DESKTOP_VIEWPORT,
    mockup: null,
    surfacesClosed: [
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
    ],
  },
  {
    // REGION ROWS for the session view (BET-468). The header strip and the
    // composer each own a small baseline, so two issues touching different
    // session components land in parallel instead of contending over
    // `session-visual-linux.png`. They reuse the `session` row's url/ready/
    // final/actions; only what gets cropped changes. The full-page `session`
    // row stays and remains the composition gate.
    id: "session-header",
    title: "Session — header strip (region)",
    url: "/app/index.html?demo&desktop",
    ready: '[data-screen="session"]',
    final: "text=Run a shell command?",
    // Each chat window stays mounted with its pane hidden (display:none),
    // so scope to the visible pane's header — only the active one is shown.
    region: ".manta-session-header:visible",
    mockupRegion: ".topb",
    actions: async (page) => {
      await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/session/mockup.html",
    surfacesClosed: [
      "manta-ctx-pill",
      "manta-effort-picker-btn",
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
      "manta-session-menu-trigger",
    ],
  },
  {
    id: "session-composer",
    title: "Session — composer (region)",
    url: "/app/index.html?demo&desktop",
    ready: '[data-screen="session"]',
    final: "text=Run a shell command?",
    // See session-header: only the active chat pane's composer is visible.
    region: ".manta-composer:visible",
    mockupRegion: ".composer",
    actions: async (page) => {
      await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/session/mockup.html",
    surfacesClosed: [
      "manta-ctx-pill",
      "manta-effort-picker-btn",
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
      "manta-session-menu-trigger",
    ],
  },
  {
    id: "settings",
    title: "Settings — section rail + the first section",
    // Opened by the same click a person makes: the sidebar footer's entry.
    // Settings is local component state, not a route, so there is no URL for
    // it; this is exactly the "real user gesture" the actions field is for.
    url: "/app/index.html?demo&desktop",
    ready: "text=Refactor auth middleware",
    final: '[role="dialog"][aria-labelledby="settings-title"]',
    // `ready` only gates boot here — the dialog does not exist until the click
    // below. Without this the structure snapshot would be the sidebar row's
    // text node rather than the dialog.
    snapshot: '[role="dialog"][aria-labelledby="settings-title"]',
    actions: async (page) => {
      await page.getByText("Settings…", { exact: false }).first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/settings/mockup.html",
    surfacesClosed: ["manta-effort-picker-btn", "manta-model-picker-btn", "manta-session-menu-trigger"],
  },
  {
    // REGION ROWS — a component that owns its own small baseline. These are
    // SEPARATE rows (not fields on the `settings` row above) so they do not
    // disturb the existing full-page baseline. They reuse the screen's
    // url/ready/final/actions and only change what gets cropped.
    id: "settings-rail",
    title: "Settings — section rail (region)",
    url: "/app/index.html?demo&desktop",
    ready: "text=Refactor auth middleware",
    final: '[role="dialog"][aria-labelledby="settings-title"]',
    // No `snapshot`: the rail itself is the structure contract (`snapshot ??
    // region ?? ready` resolves to `region`).
    region: 'nav[role="tablist"][aria-label="Settings sections"]',
    mockupRegion: ".snav",
    actions: async (page) => {
      await page.getByText("Settings…", { exact: false }).first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/settings/mockup.html",
    surfacesClosed: ["manta-effort-picker-btn", "manta-model-picker-btn", "manta-session-menu-trigger"],
  },
  {
    id: "settings-general",
    title: "Settings — first section (General) card (region)",
    url: "/app/index.html?demo&desktop",
    ready: "text=Refactor auth middleware",
    final: '[role="dialog"][aria-labelledby="settings-title"]',
    region: '[role="tabpanel"]',
    mockupRegion: '[data-panel="general"]',
    actions: async (page) => {
      await page.getByText("Settings…", { exact: false }).first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/settings/mockup.html",
    surfacesClosed: ["manta-effort-picker-btn", "manta-model-picker-btn", "manta-session-menu-trigger"],
  },
  {
    // Extensions panel — the four settings sections (box/accounts/extensions)
    // are custom-rendered and were previously in NO captured state (BET-473).
    // The Extensions panel is not the default section, so this row clicks its
    // rail tab on the app AND runs mockupActions to reveal the matching panel
    // in the mockup (which is static HTML; see mockup.html's section script).
    id: "settings-extensions",
    title: "Settings — Extensions section (region)",
    url: "/app/index.html?demo&desktop",
    ready: "text=Refactor auth middleware",
    final: '[role="dialog"][aria-labelledby="settings-title"]',
    region: '[role="tabpanel"]',
    mockupRegion: '[data-panel="ext"]',
    actions: async (page) => {
      await page.getByText("Settings…", { exact: false }).first().click();
      await page.getByRole("tab", { name: "Extensions" }).click();
    },
    mockupActions: async (page) => {
      await page.locator('[data-tab="ext"]').click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/settings/mockup.html",
    surfacesClosed: ["manta-effort-picker-btn", "manta-model-picker-btn", "manta-session-menu-trigger"],
  },
  {
    // The ⋯ session menu is the only entry point for AI-CLI launcher modes
    // (BET-467). It is closed in every other captured state, so without this
    // row the launcher entries appear in no capture at all — the gap that let
    // BET-459 drop them.
    id: "session-menu",
    title: "Session menu — mode switch + session actions (region)",
    url: "/app/index.html?demo&desktop",
    ready: '[data-screen="session"]',
    final: '[role="menu"]',
    region: ".manta-session-menu-dropdown",
    actions: async (page) => {
      await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
      await page.getByRole("button", { name: "Session actions" }).click();
    },
    viewport: DESKTOP_VIEWPORT,
    // No design exists for the OPEN menu — docs/screens/session/mockup.html
    // draws the ⋯ button (line 375) but not its dropdown. `null` is the
    // registry's documented way to say "no design filed"; the row still gets
    // a structure snapshot and a pixel baseline.
    mockup: null,
    surfacesClosed: [
      "manta-ctx-pill",
      "manta-effort-picker-btn",
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
    ],
  },
  // BET-511: the model picker's dropdown was previously opened by NO capture —
  // BET-486 recorded it as unverified with every row leaving the trigger
  // closed. This row does the real gesture a user makes (click the model
  // button) so the OPEN dropdown gets a structure snapshot + pixel baseline.
  // Once opened here, `manta-model-picker-btn` is removed from this row's
  // surfacesClosed (it appears once, for the non-active pane still closed).
  {
    id: "model-picker",
    title: "Model picker — open model dropdown (region)",
    url: "/app/index.html?demo&desktop",
    ready: '[data-screen="session"]',
    final: ".manta-model-dropdown",
    region: ".manta-model-dropdown",
    actions: async (page) => {
      await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
      await page.locator(".manta-model-picker-btn:visible").first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    // No design exists for the OPEN dropdown — docs/screens/session/mockup.html
    // draws the closed model/effort pills but not their menus. `null` is the
    // registry's documented way to say "no design filed".
    mockup: null,
    surfacesClosed: [
      "manta-ctx-pill",
      "manta-effort-picker-btn",
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
      "manta-session-menu-trigger",
    ],
  },
  {
    // The effort picker is only openable when the active model has selectable
    // variants; the fixture's two default models have none, so the effort
    // button starts disabled ("High"). This row first selects a variant-bearing
    // model (a real user gesture through the model picker), which enables the
    // effort button, then clicks it to open the effort dropdown.
    id: "effort-picker",
    title: "Effort picker — open effort/variant dropdown (region)",
    url: "/app/index.html?demo&desktop",
    ready: '[data-screen="session"]',
    final: ".manta-effort-dropdown",
    region: ".manta-effort-dropdown",
    actions: async (page) => {
      await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
      await page.locator(".manta-model-picker-btn:visible").first().click();
      await page.getByRole("button", { name: "Claude Opus 4.7 Rationale" }).click();
      await page.locator(".manta-effort-picker-btn:visible").first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: null,
    surfacesClosed: [
      "manta-ctx-pill",
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
      "manta-session-menu-trigger",
    ],
  },
  {
    // The context pill's popover was also opened by no capture (BET-511). This
    // row clicks the pill — the one real gesture that reveals the context
    // breakdown — so the OPEN popover gets structure + pixels. Once opened,
    // `manta-ctx-pill` is gone from this row's surfacesClosed; the model/effort
    // pickers and session menu remain closed here.
    id: "ctx-pill",
    title: "Context pill — open context popover (region)",
    url: "/app/index.html?demo&desktop",
    ready: '[data-screen="session"]',
    final: ".manta-ctx-popover",
    region: ".manta-ctx-popover",
    actions: async (page) => {
      await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
      await page.locator(".manta-ctx-pill:visible").first().click();
    },
    viewport: DESKTOP_VIEWPORT,
    mockup: null,
    surfacesClosed: [
      "manta-effort-picker-btn",
      "manta-effort-picker-btn",
      "manta-model-picker-btn",
      "manta-model-picker-btn",
      "manta-session-menu-trigger",
      "manta-session-menu-trigger",
    ],
  },
];

/** Look up one screen by id, or throw with the list of valid ids. */
export function getScreen(id) {
  const hit = SCREENS.find((s) => s.id === id);
  if (!hit) {
    throw new Error(
      `unknown screen "${id}" — known ids: ${SCREENS.map((s) => s.id).join(", ")}`,
    );
  }
  return hit;
}
