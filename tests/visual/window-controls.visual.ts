/**
 * tests/visual/window-controls.visual.ts — nothing is ever hidden under the OS
 * window controls (spec 2026-11-03-explorer-followup §1, §6).
 *
 * Native caption buttons are not in the DOM, so a screenshot can't see them and
 * a baseline row can't guard them. This test is geometric instead: it emulates
 * each OS's control rectangle and asserts that no interactive element a person
 * can reach overlaps it.
 *
 *   - macOS: the traffic lights cover x 0…76, y 0…40 of the window — but only
 *     over APP content while the sidebar is hidden (visible, they sit over the
 *     sidebar's own drag strip, so that case is exempt).
 *   - Windows: the caption buttons cover the top-right 138×44.
 *
 * The platform comes from `navigator` (evaluated once at module load in
 * src/renderer/platform.ts), so it is set with an init script. The Windows
 * strip width is the real CSS variable, overridden the way Electron would
 * define it. Both are emulation: a real Windows run is a deferred CI job.
 *
 * "Reachable" = the element's own box overlaps the rectangle AND something in it
 * is actually hit-testable there (an element clipped by a zero-width panel, or
 * covered by another surface, is not under the controls).
 */

import { test, expect } from "@playwright/test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { LAUNCH_OPTIONS, NO_ANIMATION_CSS, RENDERER_DIR, startStaticServer, ROOT } from "../../scripts/visual/harness.mjs";

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

type Panel = "none" | "explorer" | "expanded" | "artifacts";
const PANELS: Panel[] = ["none", "explorer", "expanded", "artifacts"];

const WIN_STRIP = { w: 138, h: 44 };
const MAC_LIGHTS = { w: 76, h: 40 };

type Os = "windows" | "mac";

async function openCase(os: Os, o: { panel: Panel; sidebarHidden: boolean; banner: boolean }): Promise<Page> {
  const context = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(
    ({ os, hidden }) => {
      const platform = os === "windows" ? "Win32" : "MacIntel";
      Object.defineProperty(navigator, "platform", { get: () => platform });
      Object.defineProperty(navigator, "userAgentData", {
        get: () => ({ platform: os === "windows" ? "Windows" : "macOS" }),
      });
      if (hidden) localStorage.setItem("manta:sidebarHidden", "1");
    },
    { os, hidden: o.sidebarHidden },
  );
  const state = o.banner ? "reconnecting" : "explorer";
  await page.goto(`${baseURL}/app/index.html?demo&desktop&state=${state}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".manta-session-header", { state: "visible" });
  await page.addStyleTag({ content: NO_ANIMATION_CSS });
  if (os === "windows") {
    await page.addStyleTag({ content: `:root{--titlebar-inset-right:${WIN_STRIP.w}px!important}` });
  }
  if (o.banner) await page.waitForSelector('[role="status"]', { state: "visible" });

  if (o.panel === "explorer" || o.panel === "expanded") {
    await page.getByRole("button", { name: "Show file explorer" }).click();
    await page.waitForSelector(".manta-explorer", { state: "visible" });
    if (o.panel === "expanded") {
      await page.getByRole("button", { name: "Expand" }).click();
      await page.waitForSelector(".manta-explorer-rail", { state: "visible" });
    }
  } else if (o.panel === "artifacts") {
    await page.getByRole("button", { name: "Show artifacts" }).click();
    await page.getByRole("button", { name: "Search artifacts" }).waitFor({ state: "visible" });
  }
  await settle(page);
  return page;
}

/** Layout is final once every control's box is unchanged across consecutive polls. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const sig = [...document.querySelectorAll("button, a[href], input, [role=tab], [role=treeitem]")]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
        })
        .join("|");
      const w = window as unknown as { __sig?: string; __stable?: number };
      w.__stable = sig === w.__sig ? (w.__stable ?? 0) + 1 : 0;
      w.__sig = sig;
      return w.__stable >= 3;
    },
    undefined,
    { polling: 100 },
  );
}

/** Every reachable control whose box overlaps the OS-control rectangle, described. */
async function overlaps(page: Page, rect: { x0: number; y0: number; x1: number; y1: number }): Promise<string[]> {
  return page.evaluate((zone) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input, [role=tab], [role=treeitem]")) {
      // Transient toasts float over everything (the demo's reconnecting state
      // raises some of its own); they are not window chrome.
      if (el.closest(".fixed.z-\\[60\\]")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      // The Expanded rail is one big button whose top padding is deliberate
      // clearance for the traffic lights; what a person sees and aims at is its
      // content box.
      const box = el.classList.contains("manta-explorer-rail")
        ? {
            left: r.left + parseFloat(cs.paddingLeft),
            right: r.right - parseFloat(cs.paddingRight),
            top: r.top + parseFloat(cs.paddingTop),
            bottom: r.bottom - parseFloat(cs.paddingBottom),
          }
        : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      const x0 = Math.max(box.left, zone.x0);
      const x1 = Math.min(box.right, zone.x1);
      const y0 = Math.max(box.top, zone.y0);
      const y1 = Math.min(box.bottom, zone.y1);
      if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
      const pts = [
        [(x0 + x1) / 2, (y0 + y1) / 2],
        [x0 + 1, y0 + 1],
        [x1 - 1, y0 + 1],
        [x0 + 1, y1 - 1],
        [x1 - 1, y1 - 1],
      ];
      const reachable = pts.some(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      });
      if (!reachable) continue;
      const name = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 30) || el.getAttribute("placeholder") || "";
      out.push(
        `<${el.tagName.toLowerCase()} "${name}" ${el.className.toString().split(" ").find((c) => c.startsWith("manta-")) ?? ""}> at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      );
    }
    return out;
  }, rect);
}

for (const panel of PANELS) {
  for (const sidebarHidden of [false, true]) {
    for (const banner of [false, true]) {
      const label = `panel=${panel} sidebar=${sidebarHidden ? "hidden" : "visible"} banner=${banner ? "yes" : "no"}`;

      test(`windows: nothing under the caption buttons — ${label}`, async () => {
        const page = await openCase("windows", { panel, sidebarHidden, banner });
        const w = await page.evaluate(() => document.documentElement.clientWidth);
        const hits = await overlaps(page, { x0: w - WIN_STRIP.w, y0: 0, x1: w, y1: WIN_STRIP.h });
        await page.context().close();
        expect(hits, `controls under the Windows caption buttons (${label})`).toEqual([]);
      });

      // The sidebar-visible case is exempt: the lights sit over the sidebar's own strip.
      if (!sidebarHidden) continue;

      test(`macOS: nothing under the traffic lights — ${label}`, async () => {
        const page = await openCase("mac", { panel, sidebarHidden, banner });
        const hits = await overlaps(page, { x0: 0, y0: 0, x1: MAC_LIGHTS.w, y1: MAC_LIGHTS.h });
        let bannerLeft: number | null = null;
        if (banner) {
          bannerLeft = await page.evaluate(() => {
            const text = document.querySelector('[role="status"] span');
            if (!text) return null;
            const range = document.createRange();
            range.selectNodeContents(text);
            return range.getBoundingClientRect().left;
          });
        }
        await page.context().close();
        expect(hits, `controls under the macOS traffic lights (${label})`).toEqual([]);
        if (banner) {
          expect(bannerLeft, "banner text exists").not.toBeNull();
          expect(bannerLeft!, "banner text starts right of the traffic lights").toBeGreaterThanOrEqual(MAC_LIGHTS.w);
        }
      });
    }
  }
}
