#!/usr/bin/env node
/**
 * scripts/visual/compare.mjs — app-vs-mockup capture for design-conformance
 * review (layer 3).
 *
 * This is the JUDGEMENT step, and it is deliberately NOT a gate. It captures
 * the implementation and its design mockup under identical conditions — same
 * browser, same viewport, same token stylesheet — and writes both raw PNGs
 * plus ONE labelled side-by-side composite into .visual-out/. A reviewer
 * (human or a vision model) opens the single composite and reports the
 * differences. When the row declares a `region`, only that element is
 * cropped (from the real page, never reconciled in isolation) so the review
 * contains only the thing under review.
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
import sharp from "sharp";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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

// Composite compositing, done with sharp (already a direct dependency).
const LABEL_H = 22; // dark label band above each half
const GAP = 12; // gutter between the two halves

function log(msg) {
  process.stdout.write(`[visual:compare] ${msg}\n`);
}

/** "1440×46 @ (0,0)" — a bounding box as the registry geometry line prints it. */
function fmtBox(box) {
  return `${Math.round(box.width)}×${Math.round(box.height)} @ (${Math.round(box.x)},${Math.round(box.y)})`;
}

/**
 * One-line geometry delta for a region row: app vs mockup crop size, signed.
 * "height +2" / "width -4" / both / "size matches". Not a report format —
 * the reviewer reads the two bounding boxes and the delta in a single line.
 */
function describeRegionDelta(appBox, mockupBox) {
  const parts = [];
  const dW = Math.round(mockupBox.width - appBox.width);
  const dH = Math.round(mockupBox.height - appBox.height);
  if (dW !== 0) parts.push(`width ${dW > 0 ? "+" : ""}${dW}`);
  if (dH !== 0) parts.push(`height ${dH > 0 ? "+" : ""}${dH}`);
  return parts.length ? parts.join(", ") : "size matches";
}

/** Stamp a dark label band with `label` across the top of an image buffer. */
async function withLabel(img, label) {
  const { width } = await sharp(img).metadata();
  const band = Buffer.from(
    `<svg width="${width}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#131318"/>
      <text x="8" y="15" fill="#e6e6ec" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">${label}</text>
    </svg>`,
  );
  return sharp(img)
    .extend({ top: LABEL_H, background: "#131318" })
    .composite([{ input: band, top: 0, left: 0 }])
    .toBuffer();
}

/**
 * Join the app and mockup halves side by side at IDENTICAL scale (both scaled
 * to the taller half's height) and write the single `<id>.compare.png`.
 */
async function writeComposite(appPng, mockupPng, outPath) {
  const [aMeta, mMeta] = await Promise.all([
    sharp(appPng).metadata(),
    sharp(mockupPng).metadata(),
  ]);
  const targetH = Math.max(aMeta.height, mMeta.height);
  const [appScaled, mockScaled] = await Promise.all([
    sharp(appPng).resize({ height: targetH, withoutEnlargement: false }).toBuffer(),
    sharp(mockupPng).resize({ height: targetH, withoutEnlargement: false }).toBuffer(),
  ]);
  const [appLabelled, mockLabelled] = await Promise.all([
    withLabel(appScaled, "app"),
    withLabel(mockScaled, "mockup"),
  ]);
  const [a, m] = await Promise.all([
    sharp(appLabelled).metadata(),
    sharp(mockLabelled).metadata(),
  ]);
  const canvasW = a.width + GAP + m.width;
  const canvasH = a.height;
  await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: "#000000" },
  })
    .composite([
      { input: appLabelled, top: 0, left: 0 },
      { input: mockLabelled, top: 0, left: a.width + GAP },
    ])
    .png()
    .toFile(outPath);
  return canvasW;
}

/** Capture one half (app or mockup), cropping to the region when declared. */
async function captureHalf(page, { region, fullPage }) {
  if (region) {
    const loc = page.locator(region);
    await loc.waitFor({ state: "visible" });
    const box = await loc.boundingBox();
    const png = await loc.screenshot();
    return { png, box };
  }
  const png = await page.screenshot({ fullPage });
  return { png, box: null };
}

async function capture(browser, baseURL, screen) {
  const context = await browser.newContext({
    viewport: screen.viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const page = await context.newPage();
  let app;
  try {
    await preparePage(page, {
      url: `${baseURL}${screen.url}`,
      readySelector: screen.ready,
      finalSelector: screen.final,
      actions: screen.actions,
    });
    app = await captureHalf(page, { region: screen.region, fullPage: true });
  } finally {
    await context.close();
  }
  log(`captured app        → .visual-out/${screen.id}.app.png`);
  await writeFile(join(OUT_DIR, `${screen.id}.app.png`), app.png);

  if (!screen.mockup) {
    log(`NO MOCKUP for "${screen.id}" — conformance cannot be reviewed.`);
    log(`  File one at docs/screens/${screen.id}/mockup.html and set it in`);
    log(`  scripts/visual/screens.mjs. See docs/visual-verification.md.`);
    return;
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
  let mock;
  try {
    await preparePage(mpage, {
      url: `${baseURL}/${screen.mockup}`,
      readySelector: "[data-screen]",
      actions: screen.mockupActions,
    });
    mock = await captureHalf(mpage, {
      region: screen.mockupRegion ?? screen.region,
      fullPage: true,
    });
  } finally {
    await mctx.close();
  }
  log(`captured mockup     → .visual-out/${screen.id}.mockup.png`);
  await writeFile(join(OUT_DIR, `${screen.id}.mockup.png`), mock.png);

  const width = await writeComposite(app.png, mock.png, join(OUT_DIR, `${screen.id}.compare.png`));
  log(`wrote composite     → .visual-out/${screen.id}.compare.png (${width}×…, one file)`);

  if (screen.region) {
    log(
      `region: app ${fmtBox(app.box)} · mockup ${fmtBox(mock.box)} → ${describeRegionDelta(app.box, mock.box)}`,
    );
  }
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
