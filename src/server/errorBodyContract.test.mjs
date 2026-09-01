// errorBodyContract.test.mjs — BET-1460 wiring gate.
//
// index.mjs cannot be imported (it boots the server on import), so the
// 500-body contract is asserted by a source scan, the same pattern as
// ctoSweeperWiring.test.mjs:
//
//   - every remaining `respondJson(res, 500, String(e?.message ?? e))` site
//     in index.mjs must be a class-2 route, carrying the
//     `class-2 (BET-1460)` marker comment within the 3 lines above it;
//   - every class-1 route writes its 500 through respondSafe500 (imported
//     from safeApiError.mjs) — 21 CTO-family sites in index.mjs plus the
//     upload handler extracted into uploadRoute.mjs.
//
// This is the regression gate: a new route that reaches for raw
// String(e?.message ?? e) without classifying itself fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "index.mjs"), "utf8");
const indexLines = indexSource.split("\n");

test("wiring: every remaining raw 500 in index.mjs is an annotated class-2 route (BET-1460)", () => {
  const rawSites = [];
  indexLines.forEach((line, i) => {
    if (line.includes("respondJson(res, 500")) rawSites.push(i); // 0-based
  });
  assert.ok(rawSites.length > 0, "expected the class-2 sites to still be present");
  for (const i of rawSites) {
    const above = indexLines.slice(Math.max(0, i - 3), i).join("\n");
    assert.match(
      above,
      /class-2 \(BET-1460\)/,
      `raw 500 at line ${i + 1} is missing its class-2 (BET-1460) marker comment`,
    );
  }
});

test("wiring: class-1 CTO routes write their 500 through respondSafe500 (BET-1460)", () => {
  assert.match(
    indexSource,
    /import \{ CTO_SAFE_500_MESSAGE, respondSafe500 \} from "\.\/safeApiError\.mjs"/,
    "index.mjs must import the safe-500 writer",
  );
  // 21 CTO-family conversions in index.mjs (the 22nd — upload — lives in
  // uploadRoute.mjs and is asserted in its own test).
  const uses = indexSource.match(/respondSafe500\(res, "cto\//g) ?? [];
  assert.equal(
    uses.length,
    21,
    "expected exactly the 21 CTO-family class-1 conversions through respondSafe500",
  );
  assert.ok(
    !indexSource.includes('respondSafe500(res, "upload"'),
    "the upload 500 lives in uploadRoute.mjs, not index.mjs",
  );
});

test("wiring: POST /api/upload is extracted into uploadRoute.mjs (projectsRoute pattern)", () => {
  assert.match(
    indexSource,
    /import \{ createUploadHandler \} from "\.\/uploadRoute\.mjs"/,
    "index.mjs must import the extracted upload handler",
  );
  assert.match(
    indexSource,
    /const uploadHandler = createUploadHandler\(\{ uploadRoot: UPLOAD_ROOT \}\);/,
    "the upload handler must be wired with the box's upload root",
  );
  assert.ok(
    indexSource.includes("return uploadHandler(req, res, url);"),
    "the /api/upload call site must route through the extracted handler",
  );
  assert.ok(
    !indexSource.includes("async function handleUpload("),
    "the inline upload handler must be gone from index.mjs",
  );
});

test("docs: the 500-body contract rule is recorded in AGENTS.md (BET-1460 deliverable 4)", () => {
  const agents = readFileSync(join(here, "..", "..", "AGENTS.md"), "utf8");
  assert.match(agents, /BET-1460/, "AGENTS.md must document the BET-1460 contract");
  assert.match(agents, /class-1/, "AGENTS.md must name the two consumer classes");
  assert.match(agents, /respondSafe500/, "AGENTS.md must point at the safe writer");
});
