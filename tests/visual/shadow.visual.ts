/**
 * tests/visual/shadow.visual.ts — the dedicated shadow-capture gate.
 *
 * A registry row in tests/visual/screens.visual.ts is the wrong home for this,
 * and the reason is the exact bug BET-571 exists to fix. Every screen and
 * region the `SCREENS` registry captures either (a) applies no shadow token,
 * or (b) crops a region to an element's box — and a box-shadow paints OUTSIDE
 * the border box, so a locator screenshot of that element never shows its
 * shadow. That is why BET-563's shadow-scale retune moved 0/20 baselines:
 * the gate could not see a shadow change because no capture ever showed one.
 *
 * This file closes the gap. It captures a large `--shadow-md` surface (the
 * floating-panel shadow the issue names) through the themed-panel machinery
 * the component companion already uses — a `[data-theme]` scope rendering
 * `box-shadow: var(--shadow-md)` — ONCE PER THEME, against a committed
 * baseline each. The surface and its shadow dominate the frame, so a future
 * change to the shadow scale shifts well over the gate's
 * maxDiffPixelRatio (0.002) and fails the run loudly, instead of being
 * swallowed by a full-page composition shot where the shadow is <0.2% of
 * the pixels.
 *
 * The theme is driven the same way the real app resolves it — `data-theme`
 * on <html> — and the fixture links the app's REAL tokens.css, so each
 * baseline covers that theme's actual `--shadow-md` value:
 *   shadow-surface-light  ← 0 8px 24px rgb(26 24 21 / 0.10)
 *   shadow-surface-dark   ← 0 8px 24px rgb(0 0 0 / 0.5)
 */

import { test, expect } from "@playwright/test";
import { chromium, type Browser } from "@playwright/test";
import { LAUNCH_OPTIONS, RENDERER_DIR, startStaticServer, ROOT } from "../../scripts/visual/harness.mjs";

let server: { close: () => void } | undefined;
let browser: Browser | undefined;
let baseURL = "";

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const FIXTURE = "/tests/visual/fixtures/shadow-surface.html";

test.beforeAll(async () => {
  const started = await startStaticServer({ "/app": RENDERER_DIR, "/": ROOT });
  server = started.server;
  baseURL = started.baseURL;
  browser = await chromium.launch(LAUNCH_OPTIONS);
});

test.afterAll(async () => {
  await browser?.close();
  server?.close();
});

for (const theme of THEMES) {
  test(`shadowed surface renders the --shadow-md token in ${theme}`, async () => {
    const context = await browser!.newContext({
      viewport: { width: 720, height: 640 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    const page = await context.newPage();
    try {
      // Drive the theme via data-theme=<theme> on <html>, mirroring how the
      // app's applyTheme writes the resolved theme. The fixture's script picks
      // the value from the query string.
      await page.goto(`${baseURL}${FIXTURE}?theme=${theme}`, { waitUntil: "load" });
      const surface = page.locator(".shsurf");
      await surface.waitFor({ state: "visible", timeout: 30_000 });

      // Resolve the framed shadow to prove this is the themed panel under
      // test and that the shadow is actually applied (an empty/`none` shadow
      // would make the baseline worthless).
      const shadow = await surface.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(shadow, `--shadow-md resolved for ${theme}`).not.toBe("none");
      expect(shadow, `theme drives the token for ${theme}`).toContain(
        theme === "light" ? "rgb(26 24 21" : "rgb(0 0 0",
      );

      // Same settle primitive as preparePage — two rAFs so any in-flight
      // layout/paint reaches the framebuffer before the capture.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );

      // Structure: the .tp themed panel contains exactly the shadowed surface.
      await expect(page.locator(".tp")).toMatchAriaSnapshot({
        name: `shadow-${theme}.aria.yml`,
      });
      // Pixels: the surface + its shadow fill the frame, so a shadow-scale
      // change fails this baseline.
      await expect(page).toHaveScreenshot(`shadow-surface-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    } finally {
      await context.close();
    }
  });
}
