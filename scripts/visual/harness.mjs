/**
 * scripts/visual/harness.mjs — the ONE deterministic browser-capture recipe.
 *
 * Extracted verbatim from scripts/shots.mjs, which had already solved this
 * problem for the marketing screenshots: serve the built renderer, drive it
 * in demo mode, and get byte-identical pixels on every run. Visual
 * verification needs exactly the same recipe, so it imports this module
 * rather than growing a second, subtly-different copy. shots.mjs now imports
 * it too — one recipe, two consumers.
 *
 * The determinism rules encoded here are load-bearing. Every one of them
 * exists because a screenshot was flaky without it:
 *
 *   - Wait on DOM selectors, NEVER a fixed timeout.
 *   - Kill every animation/transition + the caret AFTER first paint, so the
 *     override applies to the same frame the screenshot reads.
 *   - Await document.fonts.ready — a webfont that lands after the capture
 *     changes every glyph.
 *   - Two rAFs so the style override and any in-flight layout reach the
 *     framebuffer before the capture.
 *
 * If you are tempted to add `waitForTimeout` here: don't. It trades a
 * deterministic failure for an intermittent one.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file so callers never guess a cwd. */
export const ROOT = resolve(__dirname, "../..");

/** Where `vite build --config electron.vite.config.mobile.ts` puts the SPA. */
export const RENDERER_DIR = join(ROOT, "mobile/www");

/**
 * Chromium launch options. Every flag is load-bearing:
 *   --no-sandbox / --disable-setuid-sandbox  the runner has no user namespace
 *   --disable-dev-shm-usage                  small /dev/shm in containers
 *   --font-render-hinting=none               hinting varies with the
 *                                            framebuffer; without this the
 *                                            same text hashes differently
 *                                            between runs.
 *
 * We use Playwright's BUNDLED Chromium — no `executablePath`, no `channel`.
 * That is deliberate: the bundled build is pinned by package-lock.json and
 * installed identically in CI, so the browser can only change in a reviewed
 * commit. A visual baseline is a hash of a specific renderer; pointing it at
 * a system browser that auto-updates means every Chrome release can silently
 * invalidate every baseline.
 *
 * This is not hypothetical. scripts/shots.mjs pins /usr/bin/google-chrome,
 * and as of 2026-07-31 that binary refuses every loopback navigation on this
 * box with ERR_ACCESS_DENIED — so the marketing-shot drift gate cannot run
 * at all. See docs/visual-verification.md ("Known issue: shots.mjs").
 */

export const LAUNCH_OPTIONS = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--font-render-hinting=none",
  ],
};

/**
 * Injected per page. Disables every animation/transition so a capture can
 * never catch a mid-pulse frame, and hides the xterm caret.
 */
export const NO_ANIMATION_CSS = `
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

// Only the extensions our build + docs emit.
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
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/**
 * Refuse to run against a stale build.
 *
 * The visual project serves `mobile/www/`, which is a BUILD ARTIFACT. Run
 * the Playwright project without rebuilding and it happily verifies the
 * previous bundle — a green run that proves nothing. That is not theoretical:
 * it is exactly what happened the first time this harness was exercised
 * (a token was changed, the suite passed, because the served bundle predated
 * the edit).
 *
 * So: compare the newest renderer source against the built entry point and
 * fail loudly if the build is behind. The npm scripts chain `build:mobile`,
 * but nothing stops a human or a CI step from calling playwright directly.
 */
export function assertRendererFresh() {
  const entry = join(RENDERER_DIR, "index.html");
  if (!existsSync(entry)) {
    throw new Error(
      `no built renderer at ${RENDERER_DIR}\n` +
        `  run: npm run visual   (which builds first)`,
    );
  }
  const builtAt = statSync(entry).mtimeMs;
  let newest = 0;
  let newestPath = "";
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > newest) {
          newest = m;
          newestPath = p;
        }
      }
    }
  };
  walk(join(ROOT, "src/renderer"));
  if (newest > builtAt) {
    throw new Error(
      `built renderer is STALE — it predates ${newestPath.replace(ROOT + "/", "")}\n` +
        `  the visual suite would verify the previous bundle and pass for the wrong reason.\n` +
        `  run: npm run visual   (or npm run visual:update to re-baseline)`,
    );
  }
}

/**
 * Minimal static server.
 *
 * `mounts` maps a URL prefix to a directory, longest prefix wins. The visual
 * harness needs two roots at once — the built app AND the repo (so a mockup
 * at /docs/screens/<id>/mockup.html can <link> the real
 * /src/renderer/tokens.css instead of copying token values). Serving them
 * from one origin is what makes app-vs-mockup an apples-to-apples capture:
 * same browser, same fonts, same viewport, no cross-origin anything.
 *
 * Returns { server, port, baseURL }.
 */
export function startStaticServer(mounts) {
  const table = Object.entries(mounts)
    .map(([prefix, dir]) => [prefix.replace(/\/$/, ""), resolve(dir)])
    .sort((a, b) => b[0].length - a[0].length);

  const server = createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const hit = table.find(
        ([prefix]) => prefix === "" || urlPath === prefix || urlPath.startsWith(`${prefix}/`),
      );
      if (!hit) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const [prefix, dir] = hit;
      let rel = urlPath.slice(prefix.length);
      if (rel === "" || rel === "/") rel = "/index.html";
      const filePath = join(dir, rel);
      if (!filePath.startsWith(dir)) {
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

  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      res({ server, port, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Navigate to `url` and leave the page in a state that is safe to capture.
 *
 * `readySelector` gates on "the app has rendered"; `actions` runs any clicks
 * needed to reach the target state; `finalSelector` gates on "the target
 * state is on screen". Both selectors are required — the first proves boot
 * finished, the second proves the actions landed.
 */
export async function preparePage(page, { url, readySelector, finalSelector, actions }) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector(readySelector, { state: "visible", timeout: 30_000 });
  if (actions) await actions(page);
  // Inject AFTER first paint so the override applies to the captured frame.
  await page.addStyleTag({ content: NO_ANIMATION_CSS });
  await page.waitForSelector(finalSelector ?? readySelector, {
    state: "visible",
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch {}
    }
  });
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    // Sessions hold SSE streams open that never go idle — expected.
  }
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/**
 * Await a settled, phase-applied frame before a mid-stream capture.
 *
 * For a phased row the demo advances its stepped stream via
 * window.__mantaDemoStream.advance(), which emits a `message.updated` SSE
 * event the REAL transcript assembler consumes → a 300ms-debounced splice.
 * Screenshotting immediately would hit the pre-splice (still the PREVIOUS
 * phase) frame, and two identical pre-splice frames would "converge" early —
 * so every phase would capture the same image. We therefore FIRST wait,
 * deterministically, for the demo to report the phase applied
 * (`pending` → `served`): the same async-settle idea as preparePage awaiting
 * `document.fonts.ready`, never a blind timeout.
 *
 * Then the convergence guard, ported from the native
 * spike/native-visual/capture.sh behaviour:
 *   1. Two consecutive identical frames before a capture is kept — without
 *      it you capture a frame mid-paint.
 *   2. No retry-until-pass — if the frame never settles, the run FAILS
 *      LOUDLY naming the phase, rather than silently recording a wrong frame.
 *
 * The bounded y2k of frame comparisons is what decides "converged vs broken",
 * and it is the ONE implementation every phased capture calls.
 */
export async function awaitStableFrame(page, phase) {
  await page.waitForFunction(
    () => {
      // Absent window handle (never a stream state) or no pending advance:
      // nothing to wait for. Otherwise hold until the assembler has applied it.
      const s = window.__mantaDemoStream;
      return !s || !s.pending || s.served === true;
    },
    { timeout: 10_000 },
  );

  const MAX_ATTEMPTS = 12;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const a = await page.screenshot();
    // Yield between captures so any in-flight layout/paint reaches the
    // framebuffer — same proven settle primitive as preparePage.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const b = await page.screenshot();
    if (a.equals(b)) return;
  }
  throw new Error(
    `frame never converged for phase "${phase}" after ${MAX_ATTEMPTS} attempts`,
  );
}
