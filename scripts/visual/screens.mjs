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
 */

/** @typedef {{
 *   id: string,
 *   title: string,
 *   url: string,
 *   ready: string,
 *   final?: string,
 *   snapshot?: string,
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
    url: "/app/index.html?demo&desktop&empty",
    ready: '[data-screen="welcome"]',
    viewport: DESKTOP_VIEWPORT,
    mockup: "docs/screens/welcome/mockup.html",
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
