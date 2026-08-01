/**
 * tests/visual/session-row.visual.ts — the SessionRow density measurement.
 *
 * This is deliberately NOT a row in scripts/visual/screens.mjs. A registry row
 * captures a screen and does structure + pixel snapshots; the whole point of
 * the SessionRow cell is a NUMERIC claim — a rendered row must be 32px in the
 * `comfortable` density scope and 26px in `compact` (BET-536 DoD 3), because
 * the row owns NONE of its own metrics (C2: --row-h/--row-px/--row-py live on
 * [data-density], never on :root). A screenshot baseline cannot assert a
 * height; this measures it.
 *
 * It measures the REAL component: the built app renders live SessionRow
 * components in the sidebar rail. We measure an actual rail row's height (its
 * current comfortable/:root state → 32px), then clone that same row's exact
 * rendered outerHTML inside a `[data-density="compact"]` scope and re-measure
 * (→ 26px), proving the row follows the density token rather than owning its
 * own metrics.
 *
 * The app itself ships no density scope right now (BET-536 C2: the sidebar
 * rail provides no [data-density] ancestor — a product gap filed separately),
 * so the compact scope's token values are supplied here — which is exactly the
 * `[data-density]` contract C2 is about.
 */

import { test, expect } from "@playwright/test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { LAUNCH_OPTIONS, RENDERER_DIR, startStaticServer, ROOT } from "../../scripts/visual/harness.mjs";

let server: { close: () => void } | undefined;
let browser: Browser | undefined;
let baseURL = "";

// The spec's compact density scope. The row must resolve its metrics from
// this and from nothing else (C2).
const COMPACT_CSS = `[data-density="compact"]{--row-h:26px;--row-px:8px;--row-py:3px}`;

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

async function openDemo(page: Page): Promise<void> {
  await page.goto(`${baseURL}/app/index.html?demo&desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-screen="session"]', { state: "visible", timeout: 30_000 });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

// A real SessionRow from the rail — the top-level window rows (role=treeitem
// WITHOUT aria-level/aria-expanded) are the migrated WindowRow SessionRows.
const ROW_SELECTOR = '[role="treeitem"]:not([aria-level]):not([aria-expanded])';

test("SessionRow renders 32px in comfortable and 26px in compact, following the density token (C2)", async () => {
  const page = await browser!.newPage();
  try {
    await openDemo(page);

    // Measurement 1: the real rail row at its current comfortable (:root =
    // 32px) state.
    const row = page.locator(ROW_SELECTOR).first();
    await row.waitFor({ state: "visible" });
    const comfortable = await row.evaluate((el: HTMLElement) => el.getBoundingClientRect().height);
    expect(comfortable).toBe(32);

    // Measurement 2: clone that same real row's outerHTML into a compact
    // scope — the identical component output must drop to the compact height.
    const markup = await row.evaluate((el: HTMLElement) => el.outerHTML);
    await page.addStyleTag({ content: COMPACT_CSS });
    await page.evaluate((html) => {
      const meas = document.createElement("div");
      meas.id = "srow-meas";
      meas.style.cssText = "position:fixed;left:-3000px;top:0;width:264px";
      meas.innerHTML = `<div data-density="compact">${html}</div>`;
      document.body.appendChild(meas);
    }, markup);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    const compact = await page.$eval(
      '#srow-meas [data-density="compact"] [role="treeitem"]',
      (el) => (el as HTMLElement).getBoundingClientRect().height,
    );

    // Quoted measurement (BET-536 DoD 3): comfortable → 32px, compact → 26px.
    expect(compact).toBe(26);
  } finally {
    await page.close();
  }
});
