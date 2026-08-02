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
      // test and that the `--shadow-md` token actually applied (an empty /
      // `none` shadow — or a wrong-step sm/lg value — would make the baseline
      // worthless). The theme difference itself is asserted by the two
      // per-theme pixel baselines below, which render different resolutions
      // of `--shadow-md` from tokens.css.
      const shadow = await surface.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(shadow, `--shadow-md resolved for ${theme}`).toContain("0px 8px 24px");

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
      // change fails this baseline. A shadow is a soft gradient, not a flat
      // fill, so a retune moves pixels by modest deltas — the default
      // per-pixel `threshold` (0.2 ≈ 51 levels) would swallow even a large
      // shadow change. A low threshold (0.03 ≈ 8 levels) is safe HERE and
      // only here: this frame has no text and no subpixel-AA glyphs, so the
      // only pixels that can move are shadow or surface pixels, both of
      // which a real scale change shifts by far more than ~8 levels.
      // (Threshold 0.03 was chosen empirically as the smallest that still
      // leaves the stable baseline green across repeated runs while catching
      // a modest `--shadow-md` retune.)
      await expect(page).toHaveScreenshot(`shadow-surface-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
        threshold: 0.03,
      });
    } finally {
      await context.close();
    }
  });
}
