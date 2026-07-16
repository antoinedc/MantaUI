// Tests for servePage.mjs pure logic — no live HTTP, no real page I/O.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSubdomain, extractSubdomain, createCleanupSweep } from "./servePage.mjs";

// ---------------------------------------------------------------------------
// isValidSubdomain
// ---------------------------------------------------------------------------

test("isValidSubdomain accepts simple lowercase names", () => {
  assert.equal(isValidSubdomain("preview"), true);
  assert.equal(isValidSubdomain("my-design"), true);
  assert.equal(isValidSubdomain("a"), true);
  assert.equal(isValidSubdomain("page123"), true);
});

test("isValidSubdomain rejects invalid names", () => {
  assert.equal(isValidSubdomain("Bad_Sub"), false); // underscore + uppercase
  assert.equal(isValidSubdomain("UPPER"), false);
  assert.equal(isValidSubdomain("-leading"), false);
  assert.equal(isValidSubdomain("trailing-"), false);
  assert.equal(isValidSubdomain("has.dot"), false);
  assert.equal(isValidSubdomain(""), false);
  assert.equal(isValidSubdomain("a".repeat(64)), false); // too long
  assert.equal(isValidSubdomain(null), false);
  assert.equal(isValidSubdomain(123), false);
});

test("isValidSubdomain accepts max 63-char name", () => {
  assert.equal(isValidSubdomain("a".repeat(63)), true);
});

// ---------------------------------------------------------------------------
// extractSubdomain
// ---------------------------------------------------------------------------

test("extractSubdomain pulls the page name from a Host header", () => {
  assert.equal(extractSubdomain("preview.pages.mantaui.com"), "preview");
  assert.equal(extractSubdomain("my-design.pages.mantaui.com"), "my-design");
});

test("extractSubdomain strips the port and lowercases", () => {
  assert.equal(extractSubdomain("Preview.pages.mantaui.com:20080"), "preview");
});

test("extractSubdomain returns null for non-matching hosts", () => {
  assert.equal(extractSubdomain("example.com"), null);
  assert.equal(extractSubdomain("pages.mantaui.com"), null); // no subdomain
  assert.equal(extractSubdomain(""), null);
  assert.equal(extractSubdomain(null), null);
});

test("extractSubdomain rejects multi-level subdomains", () => {
  // a.b.pages.mantaui.com — "a.b" contains a dot, not a valid page name
  assert.equal(extractSubdomain("a.b.pages.mantaui.com"), null);
});

test("extractSubdomain honors a custom suffix", () => {
  assert.equal(extractSubdomain("x.example.test", ".example.test"), "x");
});

// ---------------------------------------------------------------------------
// createCleanupSweep — expiry filtering (injected load/save, no real FS)
// ---------------------------------------------------------------------------

test("cleanup sweep removes only expired entries", async () => {
  const NOW = 1_000_000;
  const pages = [
    { subdomain: "fresh", expiresAt: NOW + 10_000 },
    { subdomain: "stale", expiresAt: NOW - 10_000 },
    { subdomain: "noexp", expiresAt: 0 }, // 0 = never expires
  ];
  let saved = null;
  const { sweep } = createCleanupSweep({
    load: () => pages,
    save: async (next) => {
      saved = next;
    },
    now: () => new Date(NOW),
  });
  await sweep();
  assert.deepEqual(
    saved.map((p) => p.subdomain),
    ["fresh", "noexp"],
  );
});

test("cleanup sweep is a no-op when nothing is expired", async () => {
  const NOW = 1_000_000;
  const pages = [{ subdomain: "fresh", expiresAt: NOW + 10_000 }];
  let saveCalled = false;
  const { sweep } = createCleanupSweep({
    load: () => pages,
    save: async () => {
      saveCalled = true;
    },
    now: () => new Date(NOW),
  });
  await sweep();
  assert.equal(saveCalled, false);
});
