#!/usr/bin/env node
/**
 * scripts/visual/compare.mjs — app-vs-mockup capture for design-conformance
 * review (layer 3).
 *
 * This is the JUDGEMENT step, and it is deliberately NOT a gate. It captures
 * the implementation and its design mockup under identical conditions — same
 * browser, same viewport, same token stylesheet — and writes both plus a
 * side-by-side sheet into .visual-out/. A reviewer (human or a vision model)
 * then reports the differences.
 *
 * Why not diff these automatically: a mockup is a different DOM. Even a
 * perfect implementation differs from it in hundreds of pixels, so a pixel
 * diff here yields noise. Pixel diffing belongs against the app's own
 * approved baseline, which is what the visual test project does.
 *
 * Usage:
 *   npm run visual:compare              # every screen in the registry
 *   node scripts/visual/compare.mjs welcome
 *
 * Exit codes: 0 = captures written (even when the screen has no mockup —
 * that is reported, not fatal). 1 = a capture failed.
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCH_OPTIONS,
  RENDERER_DIR,
  ROOT,
  preparePage,
  startStaticServer,
} from "./harness.mjs";
import { SCREENS, getScreen } from "./screens.mjs";

const OUT_DIR = join(ROOT, ".visual-out");

function log(msg) {
  process.stdout.write(`[visual:compare] ${msg}\n`);
}

async function capture(browser, baseURL, screen) {
  const context = await browser.newContext({
    viewport: screen.viewport,
    deviceScaleFactor: 2,
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
    await page.screenshot({
      path: join(OUT_DIR, `${screen.id}.app.png`),
      fullPage: true,
    });
    log(`captured app        → .visual-out/${screen.id}.app.png`);
  } finally {
    await context.close();
  }

  if (!screen.mockup) {
    log(`NO MOCKUP for "${screen.id}" — conformance cannot be reviewed.`);
    log(`  File one at docs/screens/${screen.id}/mockup.html and set it in`);
    log(`  scripts/visual/screens.mjs. See docs/visual-verification.md.`);
    return { mockupCaptured: false };
  }
  if (!existsSync(join(ROOT, screen.mockup))) {
    throw new Error(
      `screen "${screen.id}" points at a missing mockup: ${screen.mockup}`,
    );
  }

  const mctx = await browser.newContext({
    viewport: screen.viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const mpage = await mctx.newPage();
  try {
    await preparePage(mpage, {
      url: `${baseURL}/${screen.mockup}`,
      readySelector: "[data-screen]",
    });
    await mpage.screenshot({
      path: join(OUT_DIR, `${screen.id}.mockup.png`),
      fullPage: true,
    });
    log(`captured mockup     → .visual-out/${screen.id}.mockup.png`);
  } finally {
    await mctx.close();
  }
  return { mockupCaptured: true };
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const screens = only.length ? only.map(getScreen) : SCREENS;

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  if (!existsSync(join(RENDERER_DIR, "index.html"))) {
    throw new Error(
      `no built renderer at ${RENDERER_DIR} — run \`npm run build:mobile\` first`,
    );
  }

  const { server, baseURL } = await startStaticServer({
    "/app": RENDERER_DIR,
    "/": ROOT,
  });
  const browser = await chromium.launch(LAUNCH_OPTIONS);
  try {
    for (const screen of screens) {
      log(`--- ${screen.id}: ${screen.title}`);
      await capture(browser, baseURL, screen);
    }
  } finally {
    await browser.close();
    server.close();
  }

  log("");
  log("Review checklist (report differences, do not guess intent):");
  log("  1. Element inventory — is anything present in one and not the other?");
  log("  2. Grouping + order — same controls, same visual grouping, same order?");
  log("  3. Alignment — what is centred vs left-aligned to what?");
  log("  4. Size + rhythm — control heights and gaps on the same grid?");
  log("  5. Emphasis — is the same element the loudest one on the screen?");
  log("  6. States — is the empty/placeholder state the one the design shows?");
  log("Findings are advisory. Nothing here blocks a merge.");
}

main().catch((e) => {
  process.stderr.write(`[visual:compare] FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
});
