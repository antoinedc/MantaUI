// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// ctoFactSurfacesWiring.test.mjs — BET-1409 wiring gate. index.mjs cannot be
// imported (it boots the server on import), so the wiring is asserted by a
// brace-balanced source scan (same discipline as ctoBudgetWiring.test.mjs):
// the three §6.7 seams MUST sit inside the `createCtoEngine({...})`
// construction that feeds the facts engine, and MUST reference the
// factSurfaces bundle. A seam stranded in any other deps literal is silently
// ignored by createCtoEngine — the feature would stay dormant behind green
// unit tests, exactly the failure mode this gate exists for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "index.mjs"), "utf8");

function depsBlock(source, openMarker) {
  const call = source.indexOf(openMarker);
  if (call === -1) return "";
  const open = source.indexOf("{", call);
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const prev = i > 0 ? source[i - 1] : "";
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

function engineDeps() {
  return depsBlock(indexSource, "ctoEngine.createCtoEngine({");
}

test("BET-1409: the three §6.7 fact seams are wired inside createCtoEngine's deps", () => {
  const deps = engineDeps();
  assert.ok(deps.length > 0, "createCtoEngine deps block found");
  for (const seam of ["factSurfaceExists", "factVerify", "factResolveRef"]) {
    assert.ok(deps.includes(`${seam}:`), `${seam} must sit inside the createCtoEngine deps block`);
  }
  assert.ok(deps.includes("factSurfaces.surfaceExists"), "factSurfaceExists delegates to the factSurfaces bundle");
  assert.ok(deps.includes("factSurfaces.verify"), "factVerify delegates to the factSurfaces bundle");
  assert.ok(deps.includes("factSurfaces.resolveRef"), "factResolveRef delegates to the factSurfaces bundle");
});

test("BET-1409: the factSurfaces bundle is constructed with the real surface deps", () => {
  const open = indexSource.indexOf("createFactSurfaces({");
  assert.ok(open !== -1, "createFactSurfaces construction present in index.mjs");
  const block = depsBlock(indexSource, "createFactSurfaces({");
  for (const dep of ["cwdsFor", "runGit", "hasBinary", "gitRepoReady", "issueLookup", "ciLatestConclusion", "messageExists", "issueToolConsented"]) {
    assert.ok(block.includes(`${dep}:`), `factSurfaces dep ${dep} must be wired`);
  }
  // The issue surface is consent-gated through the §7 tool registry.
  assert.ok(block.includes("getTools().listTools()"), "issueToolConsented must read the tool registry");
  // The message-id leg rides the shared read-only opencode db handle.
  assert.ok(block.includes("getDb()"), "messageExists must ride the opencodeDb handle");
});

// BET-1504: the ci conclusion seam must accept a branch scope and pass it to
// `gh run list --branch <name>` — a statement that names a branch is judged
// by that branch's run, not the repo-wide latest.
test("BET-1504: the ci conclusion seam scopes gh run list to the statement's branch", () => {
  const block = depsBlock(indexSource, "ciLatestConclusion:");
  assert.ok(block.length > 0, "ciLatestConclusion block found in index.mjs");
  assert.ok(block.includes("branch"), "ciLatestConclusion must take a branch parameter");
  assert.ok(block.includes('"--branch"'), "gh run list must support --branch scoping");
});
