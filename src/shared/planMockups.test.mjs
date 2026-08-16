// Tests for the shared mockup-link detector — pure, no I/O, no deps.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlanMockups } from "./planMockups.mjs";

test("image link", () => {
  assert.deepEqual(
    extractPlanMockups("![home page](https://x.com/pages/home)"),
    [{ title: "home page", url: "https://x.com/pages/home", sub: "home" }],
  );
});

test("text link", () => {
  assert.deepEqual(
    extractPlanMockups("See [the mockup](https://x.com/pages/alpha)."),
    [{ title: "the mockup", url: "https://x.com/pages/alpha", sub: "alpha" }],
  );
});

test("bare URL on its own line", () => {
  assert.deepEqual(
    extractPlanMockups("Preview:\nhttps://x.com/pages/landing\nDone."),
    [{ title: "landing", url: "https://x.com/pages/landing", sub: "landing" }],
  );
});

test("non-/pages/ URLs are dropped", () => {
  assert.deepEqual(
    extractPlanMockups("[docs](https://x.com/docs).\n![img](a.png)\nhttps://x.com/plain"),
    [],
  );
});

test("bare URL in prose (not own line) is ignored", () => {
  assert.deepEqual(
    extractPlanMockups("open https://x.com/pages/alpha here"),
    [],
  );
});

test("empty sub dropped", () => {
  assert.deepEqual(
    extractPlanMockups("[empty](https://x.com/pages/) and [slash](https://x.com/pages//)"),
    [],
  );
});

test("title falls back to sub", () => {
  assert.deepEqual(
    extractPlanMockups("![](https://x.com/pages/alpha)"),
    [{ title: "alpha", url: "https://x.com/pages/alpha", sub: "alpha" }],
  );
});

test("sub lowercased and trailing slash stripped", () => {
  assert.deepEqual(
    extractPlanMockups("[X](https://x.com/pages/ALPHA/)"),
    [{ title: "X", url: "https://x.com/pages/ALPHA/", sub: "alpha" }],
  );
});

test("dedupe by url, first occurrence wins", () => {
  const md = [
    "[first](https://x.com/pages/alpha)",
    "[second](https://x.com/pages/alpha)",
  ].join("\n");
  assert.deepEqual(extractPlanMockups(md), [
    { title: "first", url: "https://x.com/pages/alpha", sub: "alpha" },
  ]);
});

test("empty input -> []", () => {
  assert.deepEqual(extractPlanMockups(""), []);
  assert.deepEqual(extractPlanMockups("no mockups here"), []);
});

test("non-string input -> [] without throwing", () => {
  assert.deepEqual(extractPlanMockups(null), []);
  assert.deepEqual(extractPlanMockups(undefined), []);
  assert.deepEqual(extractPlanMockups(42), []);
  assert.deepEqual(extractPlanMockups({}), []);
});
