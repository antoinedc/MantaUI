// measure-first-token-latency.mjs — reproduce the §17 "first token → rendered
// text" measurement for BET-553 (see docs/mobile-redesign/DECISIONS.md §17).
//
// Not a gate: a one-off measurement probe, run via `node scripts/measure-first-token-latency.mjs`
// after `npm run build` (the desktop renderer build; BET-559 retired the web bundle). It drives the `stream` demo state and reads the
// number the committed instrumentation actually produced:
//
//   - instrumented ms per path — `window.__mantaDemoStream.latency` is populated
//     by src/renderer/firstTokenLatency.ts (markFirstToken/markRendered fire on
//     the interpreted `stream.flush` and the raw `message.updated`). This is the
//     dispatch→commit hop measured by the instrumentation itself.
//   - painted ms per path — the probe wraps each advance in two rAF yields, so
//     this is the commit→painted-frame cost, i.e. "to rendered text".
//
// The demo has no network, so both figures are the device-side hop in isolation
// (a live box adds the box→device network hop on top — exactly what §17's <1s
// threshold protects against).

import { chromium } from "playwright";
import {
  RENDERER_DIR,
  ROOT,
  startStaticServer,
  preparePage,
} from "./visual/harness.mjs";

const started = await startStaticServer({ "/app": RENDERER_DIR, "/": ROOT });
const server = started.server;
const baseURL = started.baseURL;

async function openStreamPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const page = await context.newPage();
  await preparePage(page, {
    url: `${baseURL}/app/index.html?demo&desktop&state=stream`,
    readySelector: '[data-screen="session"]',
    finalSelector: "text=Run a shell command?",
    actions: async (p) => {
      await p.locator('.truncate:has-text("Deploy new billing service")').first().click();
    },
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return { context, page };
}

// Drive one phase advance and time it on a given path. Returns {instrumented,
// painted} ms from the app's own instrumentation (read off the window handle)
// and from the probe's paint wrap respectively.
async function measureAdvance(page, kind) {
  return page.evaluate(async (k) => {
    const settle = () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t0 = performance.now();
    window.__mantaDemoStream.advance();
    await settle();
    const painted = performance.now() - t0;
    const lat = window.__mantaDemoStream.latency;
    return { instrumented: k === "interpreted" ? lat.interpreted : lat.raw, painted };
  }, kind);
}

const browser = await chromium.launch({
  args: ["--disable-gpu", "--disable-animations", "--force-prefers-reduced-motion"],
});

const results = { interpreted: { instrumented: [], painted: [] }, raw: { instrumented: [], painted: [] } };
const ITER = 16;
for (let i = 0; i < ITER; i++) {
  for (const kind of ["interpreted", "raw"]) {
    const { context, page } = await openStreamPage(browser);
    const m = await measureAdvance(page, kind);
    results[kind].instrumented.push(m.instrumented ?? 0);
    results[kind].painted.push(m.painted);
    await context.close();
  }
}

await browser.close();
server.close();

for (const kind of ["interpreted", "raw"]) {
  for (const metric of ["instrumented", "painted"]) {
    const v = results[kind][metric];
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const max = Math.max(...v);
    console.log(`path=${kind} ${metric} mean=${mean.toFixed(3)}ms max=${max.toFixed(3)}ms samples=[${v.map((x) => x.toFixed(3)).join(", ")}]`);
  }
}
