// opencode.cachewrite.test.mjs — source-reading guard for the bare cache-write
// bug class.
//
// AGENTS.md documents (twice) a gotcha on `src/server/opencode.mjs`:
//
//   "GOTCHA — every cache write MUST go through `rememberSessionDirectory`,
//    never a bare `sessionDirectoryCache.set`."
//
// Only `rememberSessionDirectory` fires the `onSessionDirectoryAdded`
// listeners that make the bus open a SCOPED `/event?directory=` stream for a
// session directory. A bare `sessionDirectoryCache.set(...)` populates the map
// but the bus never learns to open the scoped stream — the exact "SSE broken
// in *existing* sessions, fine in new ones" bug: an existing/restored session
// resolved on its first prompt, but its response events vanished because the
// matching scoped stream never opened. The renderer shows the user message
// optimistically then a blank assistant turn forever, with no JS error.
//
// This repo has no ESLint config, so the guard is a source-reading node:test
// (the repo's established canary pattern — see stateSandbox.test.mjs): read
// the opencode.mjs source and assert that every `sessionDirectoryCache.set(`
// call sits inside one of the two sanctioned functions ONLY
// (`rememberSessionDirectory`, `cacheSessionDirectoryQuiet` — the latter is
// for the subscribe bootstrap, which intentionally does NOT open a scoped
// stream). If a future edit adds a bare `.set` anywhere else, this fails RED
// with a message pointing at `rememberSessionDirectory`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "opencode.mjs"), "utf8");

// Find the [start, end) character range of a `function <name>(...) { ... }`
// body: from the function declaration up to the NEXT top-level function
// declaration. Kept deliberately simple (end at the next `\nfunction `).
function functionRange(name) {
  const needle = `function ${name}`;
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `opencode.mjs is missing its sanctioned function ${name} — has it been renamed/deleted?`);
  const nextFn = source.indexOf("\nfunction ", start + 1);
  const end = nextFn >= 0 ? nextFn : source.length;
  return { start, end };
}

const remember = functionRange("rememberSessionDirectory");
const quiet = functionRange("cacheSessionDirectoryQuiet");

test("every sessionDirectoryCache.set lives in a sanctioned function", () => {
  const calls = [...source.matchAll(/sessionDirectoryCache\.set\(/g)];
  // Exactly the two sanctioned calls, and no others, may exist.
  assert.equal(
    calls.length,
    2,
    `expected exactly 2 sessionDirectoryCache.set() calls (in ` +
      `rememberSessionDirectory + cacheSessionDirectoryQuiet), found ${calls.length}. ` +
      `AGENTS.md: every cache write MUST go through rememberSessionDirectory — a bare ` +
      `.set silently breaks scoped SSE streams in *existing* sessions.`,
  );

  let inSanctioned = 0;
  for (const m of calls) {
    const at = m.index;
    const inRemember = at >= remember.start && at < remember.end;
    const inQuiet = at >= quiet.start && at < quiet.end;
    assert.ok(
      inRemember || inQuiet,
      `sessionDirectoryCache.set() at char ${at} (` +
        source.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, "\\n") +
        `) is OUTSIDE both sanctioned functions. It must go through ` +
        `rememberSessionDirectory so the scoped-stream listeners fire ` +
        `(AGENTS.md: bare .set = "SSE broken in existing sessions").`,
    );
    if (inRemember || inQuiet) inSanctioned += 1;
  }
  assert.equal(inSanctioned, 2);
});
