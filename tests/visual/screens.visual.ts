/**
 * tests/visual/screens.visual.ts — the whole visual gate, for every screen.
 *
 * There is deliberately ONE test file. It loops `SCREENS` from
 * scripts/visual/screens.mjs, so putting a new screen under verification is
 * a data edit, never a code edit. If you find yourself adding a second
 * visual spec file, the thing you actually want is another row in the
 * registry.
 *
 * Two assertions per screen, and they catch different failures:
 *
 *   1. STRUCTURE (toMatchAriaSnapshot) — which controls exist, their order,
 *      their accessible names. This is a TEXT snapshot, so a diff is
 *      readable in a PR: "the model picker moved above the input", "the
 *      attachment button lost its label". It does not care about pixels, so
 *      it never flakes on font rendering. This is the assertion that would
 *      have caught the composer shipping with the right elements in the
 *      wrong arrangement.
 *
 *   2. PIXELS (toHaveScreenshot) — the full-page render against a committed
 *      baseline. This catches unintended drift: a spacing token retune, a
 *      stray border, a colour change nobody meant. It compares the app to
 *      ITS OWN approved past, never to a design mockup — mockups render in a
 *      different context and diffing against them produces noise, not signal.
 *      Design conformance is a separate, judgement-based step; see
 *      docs/visual-verification.md.
 *
 * Baselines are environment-specific by nature (fonts, renderer). We
 * generate and verify them on the same self-hosted runner, and they are
 * refreshed only via `npm run visual:update` + review of the diff.
 */

import { test, expect } from "@playwright/test";
import { chromium, type Browser } from "@playwright/test";
import {
  LAUNCH_OPTIONS,
  RENDERER_DIR,
  assertRendererFresh,
  ROOT,
  preparePage,
  startStaticServer,
} from "../../scripts/visual/harness.mjs";
import { SCREENS } from "../../scripts/visual/screens.mjs";

let server: { close: () => void } | undefined;
let baseURL = "";
let browser: Browser | undefined;

test.beforeAll(async () => {
  // A build artifact is being served — verifying a stale one is a green run
  // that proves nothing. Fail before any browser starts.
  assertRendererFresh();
  const started = await startStaticServer({
    // Two mounts, one origin: the built app under /app, the repo under /.
    // The repo mount is what lets a mockup <link> the real token stylesheet.
    "/app": RENDERER_DIR,
    "/": ROOT,
  });
  server = started.server;
  baseURL = started.baseURL;
  // System Chrome with the shared determinism flags — same binary and same
  // font-hinting settings the marketing shots are baselined against.
  browser = await chromium.launch(LAUNCH_OPTIONS);
});

test.afterAll(async () => {
  await browser?.close();
  server?.close();
});

for (const screen of SCREENS) {
  test.describe(`screen: ${screen.id}`, () => {
    test(`${screen.id} — structure and pixels match the baseline`, async () => {
      const context = await browser!.newContext({
        viewport: screen.viewport,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      const page = await context.newPage();
      try {
        await preparePage(page, {
          url: `${baseURL}${screen.url}`,
          readySelector: screen.ready,
          finalSelector: screen.final,
          actions: screen.actions,
        });

        // 1. Structure — text snapshot, readable in a PR diff. Rooted at
        // `snapshot` when the screen declares one: `ready` gates BOOT, which
        // for an action-driven screen is a different element from the one
        // being captured (see screens.mjs).
        await expect(page.locator(screen.snapshot ?? screen.ready)).toMatchAriaSnapshot({
          name: `${screen.id}.aria.yml`,
        });

        // 2. Pixels — against this screen's own approved baseline.
        await expect(page).toHaveScreenshot(`${screen.id}.png`, {
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    });
  });
}
