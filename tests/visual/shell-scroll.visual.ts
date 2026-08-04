/**
 * tests/visual/shell-scroll.visual.ts — the app shell must never scroll.
 *
 * A registry row in screens.visual.ts cannot catch this, and the bug it
 * guards is the reason: nothing throws, nothing logs, and the DOM is intact
 * — the whole shell is simply parked off-screen, so a full-page capture of a
 * healthy state stays green while the app is one click away from being
 * unusable.
 *
 * THE BUG. Every option row in the question card is a `<label>` wrapping a
 * visually-hidden `<input>` (the real control, kept for keyboard + screen
 * readers). Clicking the row focuses that input, and the browser scrolls
 * EVERY scrollable ancestor to reveal whatever just took focus. `#root`
 * carried `overflow: hidden`, which removes the scrollbars but still leaves
 * the box a scroll container — so when the card sat below the fold the
 * browser scrolled the entire shell (rail, header, transcript, composer) out
 * of the window to reveal a 1px invisible input. With no scrollbar and no
 * wheel/trackpad scroll on that element there is no way back: the window
 * stays blank until a reload. `overflow: clip` is not scrollable at all, so
 * it can never become a scroll-into-view target.
 *
 * The assertion is therefore on SCROLL OFFSET, not pixels: after a real
 * click on a hidden-control row, `html`/`body`/`#root` must all still read
 * scrollTop/scrollLeft 0. The viewport is deliberately short so the card
 * lands below the fold — at a tall viewport focus needs no scroll and the
 * bug hides, which is exactly why it read as intermittent.
 */

import { test, expect } from "@playwright/test";
import { chromium, type Browser } from "@playwright/test";
import { LAUNCH_OPTIONS, RENDERER_DIR, startStaticServer, ROOT } from "../../scripts/visual/harness.mjs";

let server: { close: () => void } | undefined;
let browser: Browser | undefined;
let baseURL = "";

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

test("clicking a question-card option never scrolls the app shell", async () => {
  // Short enough that the question card is below the fold — the state in
  // which focusing the hidden input needs a scroll to be revealed.
  const context = await browser!.newContext({ viewport: { width: 900, height: 600 } });
  const page = await context.newPage();

  await page.goto(`${baseURL}/app/index.html?demo&desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-screen="session"]', { state: "visible" });
  // The fixture's question card lives on this session.
  await page.locator('.truncate:has-text("Deploy new billing service")').first().click();
  await page.waitForSelector('label:has-text("Custom (specify in notes)")', { state: "visible" });

  const shellScroll = () =>
    page.evaluate(() => ({
      htmlTop: document.documentElement.scrollTop,
      htmlLeft: document.documentElement.scrollLeft,
      bodyTop: document.body.scrollTop,
      bodyLeft: document.body.scrollLeft,
      rootTop: document.getElementById("root")?.scrollTop ?? -1,
      rootLeft: document.getElementById("root")?.scrollLeft ?? -1,
    }));

  const ZERO = {
    htmlTop: 0,
    htmlLeft: 0,
    bodyTop: 0,
    bodyLeft: 0,
    rootTop: 0,
    rootLeft: 0,
  };

  expect(await shellScroll()).toEqual(ZERO);

  // A real click on the option row — the gesture that focuses the hidden
  // input. `force` because the input itself is visually hidden; the label is
  // what a person clicks.
  await page.locator('label:has-text("Custom (specify in notes)")').first().click({ force: true });
  // The option is now selected, so the click landed and focus moved.
  await expect(page.locator('label:has-text("Custom (specify in notes)") input')).toBeChecked();

  expect(await shellScroll()).toEqual(ZERO);
});
