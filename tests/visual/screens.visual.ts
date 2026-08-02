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
 *      baseline, OR (when the row declares a `region`) that region's element
 *      against its own small baseline. Either way it compares the app to
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
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  LAUNCH_OPTIONS,
  RENDERER_DIR,
  assertRendererFresh,
  ROOT,
  awaitStableFrame,
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

/**
 * Shared, single-copy assertion path — a phased row MUST reuse these, never
 * get its own copies. Each takes a `name` so a phased row can badge every
 * capture with its phase (`<id>-<phase>`), producing one structure + one
 * pixel baseline per phase.
 */
async function assertStructure(page: Page, screen: { snapshot?: string; region?: string; ready: string }, name: string) {
  await expect(page.locator(screen.snapshot ?? screen.region ?? screen.ready)).toMatchAriaSnapshot({
    name: `${name}.aria.yml`,
  });
}

async function assertPixels(page: Page, screen: { region?: string }, name: string) {
  if (screen.region) {
    await expect(page.locator(screen.region)).toHaveScreenshot(`${name}.png`, {
      animations: "disabled",
    });
  } else {
    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  }
}

async function assertSurfacesClosed(page: Page, screen: { surfacesClosed?: string[] }, id: string) {
  const closed = await page.evaluate(() =>
    [...document.querySelectorAll("[aria-haspopup]")]
      .filter((el) => el.getAttribute("aria-expanded") !== "true")
      .map((el) => [...el.classList].find((c) => c.startsWith("manta-")) ?? "")
      .filter(Boolean)
      .sort(),
  );
  expect(
    closed,
    `surface coverage for "${id}": closed triggers ${JSON.stringify(closed)} ` +
      `vs surfacesClosed ${JSON.stringify(screen.surfacesClosed ?? [])}. ` +
      "A NEW entry = a popup trigger no capture opens (add a row that opens it, " +
      "or record it here as unverified). A MISSING entry = a row now opens it " +
      "(delete the class from this row's list).",
  ).toEqual(screen.surfacesClosed ?? []);
}

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

        if (screen.phases) {
          // A phased row captures the SAME screen once per phase, advancing
          // the demo's stepped stream between captures and asserting
          // structure + pixels per phase, inside THIS one test.
          for (let i = 0; i < screen.phases.length; i++) {
            const phase = screen.phases[i];
            if (i > 0) {
              await page.evaluate(() => (window as any).__mantaDemoStream.advance());
              await awaitStableFrame(page, phase);
            }
            await assertStructure(page, screen, `${screen.id}-${phase}`);
            await assertPixels(page, screen, `${screen.id}-${phase}`);
          }
          // Surface coverage is a per-row property, asserted once (not
          // re-asserted per phase — the popups don't change between phases).
          await assertSurfacesClosed(page, screen, screen.id);
        } else {
          await assertStructure(page, screen, screen.id);
          await assertPixels(page, screen, screen.id);
          await assertSurfacesClosed(page, screen, screen.id);
        }
      } finally {
        await context.close();
      }
    });
  });
}
