#!/usr/bin/env node
/**
 * scripts/shots.mjs — capture product screenshots from the demo-mode build
 * (BET-303) and write them into `website/` for the marketing site. Also
 * extracts the hero video's poster frame (BET-304 stage 2) from
 * `website/hero.mp4` so the same pipeline produces every `website/*.webp`
 * asset (the BET-322 acceptance criterion "npm run shots extracts
 * hero-poster.webp from frame 0 of the rendered video").
 *
 * Pipeline:
 *   1. Build the renderer bundle (out/renderer/) with `npm run build`
 *      (electron-vite) so the browser can serve the demo URL. BET-559: the
 *      web/PWA bundle build and the phone web-client are retired, so only
 *      desktop screenshots remain (the native iPhone app's art is BET-577).
 *   2. Spin up a tiny local static server rooted at out/renderer/.
 *   3. Launch Chromium against the Playwright-bundled browser and visit
 *      `?demo&desktop` per shot.
 *   4. Wait on stable DOM selectors (NEVER a fixed timeout), capture each
 *      shot, then encode to `.webp` at quality 82.
 *   5. Extract frame 0 of `website/hero.mp4` (the BET-304 stage-2 render)
 *      to `website/hero-poster.webp` via ffmpeg. The same sharp pipeline
 *      re-encodes to webp for size parity with the rest of the site assets.
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
 *   | hero-poster.webp        | 1920x1080      | ffmpeg -ss 0 -i hero.mp4 (BET-322) |
 *
 * Usage:
 *   node scripts/shots.mjs [--skip-build] [--serve-dir <path>]
 *
 * --skip-build reuses the existing out/renderer/ build. The default is to
 * rebuild — caller scripts (CI) can skip when the bundle hasn't changed.
 *
 * Exit codes:
 *   0 — every shot captured + composed + size-checked
 *   1 — at least one shot missing, >250KB, or capture failed
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
// One browser recipe (scripts/visual/harness.mjs): the static server, the
// NO_ANIMATION_CSS override, and preparePage are shared with the visual gate,
// not copied (BET-559 dedupe).
import { LAUNCH_OPTIONS, startStaticServer, preparePage } from "./visual/harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RENDERER_DIR = join(ROOT, "out", "renderer");
const WEBSITE_DIR = join(ROOT, "website");
const MAX_SIZE_KB = 250;
const WEBP_QUALITY = 82;
const POSTER_MAX_SIZE_KB = 250;

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

// Minimal static server + MIME table were the shots.mjs copies of
// harness.mjs's; shots now uses harness's startStaticServer (see bottom).

async function buildRenderer() {
  // BET-559: desktop renderer build via electron-vite (the web/PWA bundle build
  // that produced mobile/www/ is retired).
  await run("npm", ["run", "build"]);
}

// Common "open the sidebar row for project X" interaction. The desktop
// sidebar renders window rows; the name lives in a `.truncate` span (BET-381
// split the old `flex-1 truncate` into a `flex-1` flex-col wrapper holding an
// inner `.truncate` name span + an optional activity line). Clicking the
// inner name span bubbles to the row div's onClick. `.truncate:has-text`
// matches both the old single-span shape and the new wrapper+inner shape.
async function clickDesktopSession(page, windowName) {
  const row = page.locator(`.truncate:has-text("${windowName}")`).first();
  await row.click();
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
  try {
    log(`→ ${shot.name}`);
    // Shared page-prep recipe imported from harness.mjs (goto → ready →
    // actions → settle → final → fonts → networkidle → 2 rAF).
    await preparePage(page, {
      url: `${baseURL}/${shot.urlQuery}`,
      readySelector: shot.readySelector,
      finalSelector: shot.finalSelector,
      actions: shot.beforeScreenshot,
    });
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
    // Wait on `.xterm .xterm-screen` — the DOM container that wraps
    // whichever renderer xterm picked (canvas2d, WebGL, or DOM). The
    // bare `.xterm` selector fires earlier when the container is in
    // the DOM but the rows haven't been laid out yet, and the
    // `.xterm canvas` selector only fires for canvas-based renderers
    // (the demo build now skips the WebGL addon and xterm falls back
    // to the DOM renderer, which has no canvas).
    finalSelector: ".xterm .xterm-screen",
    beforeScreenshot: async (page) => {
      // Switch into a chat-mode window first so the session header's mode
      // toggle is rendered, then activate it to flip the session to
      // "Terminal" — bare-terminal windows (opencodeSessionId=null) have no
      // mode toggle in the header. BET-459 replaced the mode `<select>` with
      // a terminal icon button; its accessible name is the target mode
      // ("Terminal" from chat), so clicking the button named "Terminal" does
      // what the old selectOption("terminal") did.
      await clickDesktopSession(page, "Deploy new billing service");
      const modeToggle = page.getByRole("button", { name: "Terminal" });
      await modeToggle.waitFor({ state: "visible", timeout: 15_000 });
      await modeToggle.click();
    },
  },
];

// BET-559: the web/PWA phone client is retired, so there are no phone shots
// (`shot-phone-list` / `shot-phone-session`) or the hero+phone `shot-sync`
// composite. The native iPhone app's marketing art is tracked in BET-577.

// Extract frame 0 of `hero.mp4` to `hero-poster.webp` (BET-322). The video
// is rendered by `npm run video` (Remotion, see video/package.json); the
// poster is the static fallback the website's hero `<video poster=…>`
// element shows until the video buffers, and what reduced-motion users see
// outright. ffmpeg handles the frame extraction; sharp re-encodes to webp
// at the same quality as the rest of the site assets.
//
// Why ffmpeg instead of Playwright + Chrome: BET-303's screenshot harness
// captures LIVE web pages via Playwright. The poster is a frame FROM a
// video file, not a page in a browser — driving Chromium to load the mp4,
// seek to frame 0, and screenshot is much heavier than `ffmpeg -ss 0 -i
// hero.mp4 -frames:v 1 -f image2pipe` for the same byte-identical output.
// ffmpeg is a system dependency and is NOT implied by anything else here —
// the "present wherever Chrome is" assumption this comment used to make was
// wrong, and cost a red main when CI moved to a GitHub-hosted image that
// ships no ffmpeg. CI installs it explicitly (.github/workflows/ci.yml).
//
// `-ss 0` (before `-i`) seeks to the keyframe at frame 0; combined with
// `-frames:v 1` this returns exactly one PNG-equivalent frame. `-update 1`
// is implicit when piping; we pipe into sharp so we never touch disk for
// the intermediate PNG.
async function extractPoster(videoPath, outPath) {
  log(`→ hero-poster.webp (ffmpeg frame 0 of ${videoPath})`);
  // Spawn ffmpeg and pipe its stdout (a single-frame PNG) into sharp.
  // Using a child process rather than `-frames:v 1` + a temp file keeps
  // the working directory clean.
  //
  // Resolved from PATH by BARE NAME — never an absolute path. This used to
  // be a hardcoded `/usr/bin/ffmpeg` + existsSync guard, which is only
  // correct on a Linux box that apt-installed it: Homebrew puts ffmpeg in
  // /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel), so the
  // macOS box path could never have run this at all. Absence now surfaces
  // as the child's ENOENT, handled below with the same clear message.
  const ff = spawn(
    "ffmpeg",
    [
      "-y",
      "-ss",
      "0",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-loglevel",
      "error",
      "-",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  // A missing binary rejects the child with ENOENT rather than exiting
  // non-zero, and it can fire before or after stdout closes — so latch it
  // here and re-throw with a message that names the actual problem.
  let spawnError = null;
  ff.on("error", (e) => {
    spawnError = e;
  });
  const chunks = [];
  for await (const chunk of ff.stdout) chunks.push(chunk);
  const exitCode = await new Promise((resolve) => ff.on("close", resolve));
  if (spawnError) {
    throw new Error(
      spawnError.code === "ENOENT"
        ? "ffmpeg not found on PATH — required for poster extraction (apt install ffmpeg / brew install ffmpeg)"
        : `ffmpeg failed to start: ${spawnError.message}`,
    );
  }
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with code ${exitCode}`);
  }
  const buf = Buffer.concat(chunks);
  await sharp(buf).webp({ quality: WEBP_QUALITY }).toFile(outPath);
  log(`  ${buf.length} bytes → hero-poster.webp`);
}

async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes("--skip-build");
  const serveDirIdx = args.indexOf("--serve-dir");
  const serveDir = serveDirIdx >= 0 ? resolve(args[serveDirIdx + 1]) : RENDERER_DIR;

  if (!existsSync(WEBSITE_DIR)) mkdirSync(WEBSITE_DIR, { recursive: true });

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (e) {
    fail(`could not load playwright: ${e.message}`);
    return;
  }

  if (!skipBuild) {
    // Default flow: rebuild the renderer bundle (out/renderer/) from scratch
    // on a fresh clone, so we deliberately don't pre-check the serve-dir here
    // — build is the source of truth for "the bundle exists".
    await buildRenderer();
  } else {
    // Skip-build is a debugging aid that reuses an existing bundle.
    // Fail loudly if the caller pointed at a directory that isn't there
    // so we don't silently serve nothing.
    if (!existsSync(serveDir)) {
      fail(`--skip-build but serve directory missing: ${serveDir}. Run without --skip-build or pass --serve-dir.`);
      return;
    }
  }

  const { server, port } = await startStaticServer({ "/": serveDir });
  const baseURL = `http://127.0.0.1:${port}`;
  log(`serving ${serveDir} on ${baseURL}`);

  // Shared with the visual gate — ONE browser recipe (scripts/visual/harness.mjs).
  // Was pinned to /usr/bin/google-chrome; Chrome 148 began refusing every
  // loopback navigation with ERR_ACCESS_DENIED, which took this script — and
  // therefore the drift gate in ci.yml, on the REQUIRED job — down for every
  // PR. Playwright's bundled Chromium is pinned by package-lock.json, so the
  // renderer these baselines hash can only change in a reviewed commit.
  const browser = await chromium.launch(LAUNCH_OPTIONS);
  let browserVersion = "?";
  try {
    browserVersion = await browser.version();
  } catch {
    // Best-effort: never let version detection break the capture run.
  }
  log(`chromium ${browserVersion} via ${chromium.executablePath()}`);

  try {
    for (const shot of SHOTS) {
      const outPath = join(WEBSITE_DIR, shot.name);
      await captureShot(browser, baseURL, shot, outPath);
    }

    // Hero video poster (BET-304 stage 2 / BET-322). Extract frame 0 of
    // `website/hero.mp4` (rendered by `npm run video`) to a webp the
    // website's hero <video> element uses as the static fallback. Uses the
    // same sharp webp encoder as the rest of the site assets so byte-
    // comparable CI checks against it are apples-to-apples.
    const heroVideo = join(WEBSITE_DIR, "hero.mp4");
    const posterOut = join(WEBSITE_DIR, "hero-poster.webp");
    if (existsSync(heroVideo)) {
      try {
        await extractPoster(heroVideo, posterOut);
      } catch (e) {
        fail(`hero-poster.webp extraction failed: ${e.message}`);
      }
    } else {
      log(
        `[shots] ${heroVideo} not present; skipping poster extraction (run \`npm run video\` first)`,
      );
    }

    // Size-check every output. The acceptance criterion is ≤ 250KB.
    for (const name of [
      "shot-hero.webp",
      "shot-approvals.webp",
      "shot-terminal.webp",
      "hero-poster.webp",
    ]) {
      const p = join(WEBSITE_DIR, name);
      if (!existsSync(p)) {
        // hero-poster is opt-in (the video may not exist yet on a fresh
        // checkout that ran `npm run shots` before `npm run video`). Skip
        // that one silently; the rest are mandatory.
        if (name === "hero-poster.webp") continue;
        fail(`shot missing: ${name}`);
        continue;
      }
      const kb = statSync(p).size / 1024;
      const ceiling = name === "hero-poster.webp" ? POSTER_MAX_SIZE_KB : MAX_SIZE_KB;
      if (kb > ceiling) {
        fail(`${name} is ${kb.toFixed(1)}KB (> ${ceiling}KB)`);
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
