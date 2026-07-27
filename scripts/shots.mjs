#!/usr/bin/env node
/**
 * scripts/shots.mjs — capture product screenshots from the demo-mode build
 * (BET-303) and write them into `website/` for the marketing site.
 *
 * Pipeline:
 *   1. Build the renderer bundle (mobile/www/) with `vite build --config
 *      electron.vite.config.mobile.ts` so the browser can serve the demo URL.
 *   2. Spin up a tiny local static server rooted at mobile/www/.
 *   3. Launch Chromium against system Chrome (`/usr/bin/google-chrome`) and
 *      visit `?demo&desktop` / `?demo&mobile` per shot.
 *   4. Wait on stable DOM selectors (NEVER a fixed timeout), capture each
 *      shot, then encode to `.webp` at quality 82.
 *   5. Composite `shot-sync.webp` (desktop hero + phone list, side-by-side)
 *      with sharp.
 *
 * Determinism gates — every one is required, every run must produce
 * byte-identical files. Two back-to-back invocations on an unchanged UI
 * MUST yield the same SHA.
 *
 *   - prefers-reduced-motion: reduce via Playwright `emulateMedia`.
 *   - Inject `* { animation: none !important; }` to kill the running-dot
 *     pulse on the sidebar (status indicator) and any other pulse.
 *   - Inject `.xterm-cursor { opacity: 0 !important; }` to kill blinking
 *     cursor in the terminal-mode shot.
 *   - `viewport` + `deviceScaleFactor: 2` per shot table.
 *   - `page.screenshot` only after a `page.waitForSelector` resolves,
 *     never after `waitForTimeout`.
 *
 * Captures:
 *
 *   | File                    | Viewport       | URL            |
 *   |-------------------------|----------------|----------------|
 *   | shot-hero.webp          | desktop 1440x900  | ?demo&desktop, infra session |
 *   | shot-approvals.webp     | desktop 1440x900  | ?demo&desktop, infra session, scrolled to cards |
 *   | shot-terminal.webp      | desktop 1440x900  | ?demo&desktop, marketing/Build pipeline |
 *   | shot-phone-list.webp    | phone 393x852    | ?demo&mobile   |
 *   | shot-phone-session.webp | phone 393x852    | ?demo&mobile, infra session |
 *   | shot-sync.webp          | composite        | both           |
 *
 * Usage:
 *   node scripts/shots.mjs [--skip-build] [--serve-dir <path>]
 *
 * --skip-build reuses the existing mobile/www/ build. The default is to
 * rebuild — caller scripts (CI) can skip when the bundle hasn't changed.
 *
 * Exit codes:
 *   0 — every shot captured + composed + size-checked
 *   1 — at least one shot missing, >250KB, or capture failed
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RENDERER_DIR = join(ROOT, "mobile/www");
const WEBSITE_DIR = join(ROOT, "website");
const CHROME_PATH = "/usr/bin/google-chrome";
const MAX_SIZE_KB = 250;
const WEBP_QUALITY = 82;

// CSS injected via `addStyleTag` per page. Two effects:
//   - Disable the sidebar running-dot pulse + every other CSS animation
//     so a screenshot never catches a mid-pulse frame.
//   - Hide the xterm.js blinking cursor so the terminal shot is stable.
const NO_ANIMATION_CSS = `
*, *::before, *::after {
  animation: none !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition: none !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
}
.xterm-cursor { opacity: 0 !important; }
`;

function log(msg) {
  process.stdout.write(`[shots] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[shots] error: ${msg}\n`);
  process.exitCode = 1;
}

// Spawn a child process with `stdio: 'inherit'` so npm/vite output is
// visible in the parent terminal. Throws on non-zero exit.
async function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  const code = await new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  if (code !== 0) throw new Error(`${cmd} exited with code ${code}`);
}

// Minimal static server — only the extensions our build emits.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function startServer(rootDir) {
  const server = createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (urlPath === "/") urlPath = "/index.html";
      const filePath = join(rootDir, urlPath);
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(`server error: ${e.message}`);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function buildRenderer() {
  if (!existsSync(RENDERER_DIR)) mkdirSync(RENDERER_DIR, { recursive: true });
  await run("npx", ["vite", "build", "--config", "electron.vite.config.mobile.ts"]);
}

// Navigate, wait on the readiness selector, run per-shot actions, then
// settle for the final stable selector. Both selectors must be DOM elements
// that exist after render — never a fixed timeout.
async function prepareShot(page, shot) {
  await page.goto(`${shot.baseURL}/${shot.urlQuery}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  // Boot/transport-install settles after the React commit; wait for the
  // shared "everything is rendered" selector before doing anything else.
  await page.waitForSelector(shot.readySelector, { state: "visible", timeout: 30_000 });
  if (shot.beforeScreenshot) {
    await shot.beforeScreenshot(page);
  }
  // Inject the animation/cursor overrides AFTER the user-perceived UI is
  // up, so the override applies to the same paint as the screenshot.
  await page.addStyleTag({ content: NO_ANIMATION_CSS });
  // Final stable selector — never a timeout. The screenshot captures the
  // DOM as it is at this moment.
  await page.waitForSelector(shot.finalSelector, { state: "visible", timeout: 30_000 });
  // Two rAFs: the minimum number of frames needed for the addStyleTag to
  // be reflected in the GPU framebuffer. NOT a fixed delay on app logic.
  await page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      ),
  );
}

// Common "open the sidebar row for project X" interaction. The desktop
// sidebar renders project rows as <div class="..."><span>{w.name}</span>...
// The text content of w.name is unique within the sidebar; we click the
// ancestor container via a chain of Playwright locators.
async function clickDesktopSession(page, windowName) {
  const row = page.locator(`.flex-1.truncate:has-text("${windowName}")`).first();
  await row.click();
}

async function clickMobileSession(page, projectName, windowName) {
  // Mobile uses aria-label="Open <project> / <window>" on the row button.
  await page.getByRole("button", { name: new RegExp(`Open ${projectName}\\s*/\\s*${escapeRegExp(windowName)}`, "i") }).click();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function captureShot(browser, baseURL, shot, outPath) {
  const ctx = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    // Fresh storage every shot so a previous interaction never leaks.
    storageState: undefined,
  });
  const page = await ctx.newPage();
  shot.baseURL = baseURL;
  try {
    log(`→ ${shot.name}`);
    await prepareShot(page, shot);
    const buffer = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: shot.viewport.width,
        height: shot.viewport.height,
      },
    });
    await sharp(buffer)
      .webp({ quality: WEBP_QUALITY })
      .toFile(outPath);
    log(`  ${buffer.length} bytes → ${shot.name}`);
    return outPath;
  } finally {
    await page.close();
    await ctx.close();
  }
}

// Scroll the chat panel. The ChatPanel auto-pins to bottom on every commit,
// so programmatic scrolls must use a non-react-fired setter (the React
// effect doesn't fire on direct property assignment). We re-set several
// times to defeat the post-render re-stick. Multiple matching containers
// exist (App keeps every visited ChatPanel mounted and hidden with
// display:none) — we scroll the one that's actually visible.
async function scrollChatTo(page, scrollQuery) {
  await page.evaluate((q) => {
    const chatRoots = [
      ...document.querySelectorAll(".flex-1.overflow-y-auto.overflow-x-hidden"),
    ].filter((el) => el.offsetParent !== null);
    const chatRoot = chatRoots[0];
    if (!chatRoot) return;
    let target = 0;
    if (q === "bottom") {
      target = chatRoot.scrollHeight;
    } else if (q === "top") {
      target = 0;
    } else if (q === "bash") {
      // Scroll so the bash tool body sits roughly 100px below the
      // container's top — the bash + step-finish + visible text + context
      // bar should land inside the viewport together.
      const all = [...chatRoot.querySelectorAll("*")];
      const bashTitle = all.find((n) => n.textContent === "Bash");
      if (!bashTitle) {
        target = Math.max(0, chatRoot.scrollHeight - 500);
      } else {
        const tool =
          bashTitle.closest("[class*='group']") || bashTitle.parentElement;
        const containerRect = chatRoot.getBoundingClientRect();
        const toolRect = tool.getBoundingClientRect();
        target = Math.max(
          0,
          chatRoot.scrollTop + (toolRect.top - containerRect.top) - 100,
        );
      }
    }
    // Two consecutive writes — the first shifts layout, the second lands
    // on the same value after any post-commit layout effect that tried to
    // re-stick to bottom.
    chatRoot.scrollTop = target;
    requestAnimationFrame(() => {
      chatRoot.scrollTop = target;
    });
  }, scrollQuery);
  // Settle: let the rAF and any deferred layout effects land.
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

const SHOTS = [
  {
    name: "shot-hero.webp",
    viewport: { width: 1440, height: 900 },
    urlQuery: "?demo&desktop",
    // Sidebar row for `ethernal:1` — stable text, visible from the first
    // paint, no chat panel interaction needed.
    readySelector: "text=Refactor auth middleware",
    // The bash tool's title appears in the chat panel header; wait for it
    // before screenshotting so the bash body is also rendered.
    finalSelector: "text=Customer-friendly",
    beforeScreenshot: async (page) => {
      await clickDesktopSession(page, "Deploy new billing service");
      // Scroll the chat panel so the bash body + context bar are in view.
      await scrollChatTo(page, "bash");
    },
  },
  {
    name: "shot-approvals.webp",
    viewport: { width: 1440, height: 900 },
    urlQuery: "?demo&desktop",
    readySelector: "text=Refactor auth middleware",
    // Wait on the question card heading — present only when both cards
    // have rendered (the question card is the lower one).
    finalSelector: "text=Customer-friendly",
    beforeScreenshot: async (page) => {
      await clickDesktopSession(page, "Deploy new billing service");
      // Pinned-to-bottom already keeps the cards in view; one extra nudge
      // ensures both card buttons are visible above the composer.
      await scrollChatTo(page, "bottom");
    },
  },
  {
    name: "shot-terminal.webp",
    viewport: { width: 1440, height: 900 },
    urlQuery: "?demo&desktop",
    readySelector: "text=Refactor auth middleware",
    // The terminal pane renders an xterm container; that's our stable signal.
    finalSelector: ".xterm",
    beforeScreenshot: async (page) => {
      // Switch into a chat-mode window first so the mode `<select>` is
      // rendered, then flip it to "Terminal" — bare-terminal windows
      // (opencodeSessionId=null) have no mode toggle in the header.
      await clickDesktopSession(page, "Deploy new billing service");
      const modeSelect = page.locator("select").first();
      await modeSelect.waitFor({ state: "visible", timeout: 15_000 });
      await modeSelect.selectOption("terminal");
    },
  },
  {
    name: "shot-phone-list.webp",
    viewport: { width: 393, height: 852 },
    urlQuery: "?demo&mobile",
    readySelector: "text=Refactor auth middleware",
    finalSelector: "text=Build pipeline",
  },
  {
    name: "shot-phone-session.webp",
    viewport: { width: 393, height: 852 },
    urlQuery: "?demo&mobile",
    readySelector: "text=Refactor auth middleware",
    // The composer textarea is the bottom-anchored input; once it renders
    // we know the chat panel mount completed and the demo transcript has
    // been laid out.
    finalSelector: 'textarea',
    beforeScreenshot: async (page) => {
      await clickMobileSession(page, "infra", "Deploy new billing service");
    },
  },
];

async function composeSync(heroPath, phonePath, outPath) {
  // Desktop hero on the left, phone list on the right. Both shots are
  // already at 2x device-pixel-ratio; the output is also high-DPI. The
  // phone shot is letterboxed (or pillarboxed) to match the hero's height
  // by re-rendering on a #0B1020 background to match the renderer's
  // `bg-bg` token.
  const heroMeta = await sharp(heroPath).metadata();
  const phoneMeta = await sharp(phonePath).metadata();
  const phoneScale = heroMeta.height / phoneMeta.height;
  const phoneW = Math.round(phoneMeta.width * phoneScale);
  const phoneResized = await sharp(phonePath)
    .resize({ width: phoneW, height: heroMeta.height, fit: "fill" })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  await sharp({
    create: {
      width: heroMeta.width + phoneW,
      height: heroMeta.height,
      channels: 3,
      background: { r: 11, g: 16, b: 32 },
    },
  })
    .composite([
      { input: heroPath, top: 0, left: 0 },
      { input: phoneResized, top: 0, left: heroMeta.width },
    ])
    .webp({ quality: WEBP_QUALITY })
    .toFile(outPath);
}

async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes("--skip-build");
  const serveDirIdx = args.indexOf("--serve-dir");
  const serveDir = serveDirIdx >= 0 ? resolve(args[serveDirIdx + 1]) : RENDERER_DIR;

  if (!existsSync(serveDir)) {
    fail(`serve directory missing: ${serveDir}. Pass --serve-dir or run without --skip-build.`);
    return;
  }
  if (!existsSync(CHROME_PATH)) {
    fail(`system Chrome not found at ${CHROME_PATH}`);
    return;
  }
  if (!existsSync(WEBSITE_DIR)) mkdirSync(WEBSITE_DIR, { recursive: true });

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (e) {
    fail(`could not load playwright: ${e.message}`);
    return;
  }

  if (!skipBuild) {
    await buildRenderer();
  }

  const { server, port } = await startServer(serveDir);
  const baseURL = `http://127.0.0.1:${port}`;
  log(`serving ${serveDir} on ${baseURL}`);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    channel: "chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
    ],
  });

  const producedPaths = {};
  try {
    for (const shot of SHOTS) {
      const outPath = join(WEBSITE_DIR, shot.name);
      await captureShot(browser, baseURL, shot, outPath);
      producedPaths[shot.name] = outPath;
    }

    const heroSrc = producedPaths["shot-hero.webp"];
    const phoneSrc = producedPaths["shot-phone-list.webp"];
    if (heroSrc && phoneSrc) {
      const syncOut = join(WEBSITE_DIR, "shot-sync.webp");
      await composeSync(heroSrc, phoneSrc, syncOut);
      producedPaths["shot-sync.webp"] = syncOut;
    } else {
      fail("cannot compose shot-sync.webp: hero or phone source missing");
    }

    // Size-check every output. The acceptance criterion is ≤ 250KB.
    for (const name of [
      "shot-hero.webp",
      "shot-approvals.webp",
      "shot-terminal.webp",
      "shot-phone-list.webp",
      "shot-phone-session.webp",
      "shot-sync.webp",
    ]) {
      const p = join(WEBSITE_DIR, name);
      if (!existsSync(p)) {
        fail(`shot missing: ${name}`);
        continue;
      }
      const kb = statSync(p).size / 1024;
      if (kb > MAX_SIZE_KB) {
        fail(`${name} is ${kb.toFixed(1)}KB (> ${MAX_SIZE_KB}KB)`);
      } else {
        log(`✓ ${name} ${kb.toFixed(1)}KB`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  fail(e.stack || e.message);
});
