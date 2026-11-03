#!/usr/bin/env node
// Validates CHANGELOG.md with the same parser the server uses and says what the
// desktop's "What's new" window will show for the newest entry.
//
//   node scripts/release/check-changelog.mjs [--file <path>]
//
// Exits non-zero on an invalid highlights block, an unknown icon or action, or a
// file with no versioned entries.

import { readFileSync } from "node:fs";
import { parseChangelog, CHANGELOG_PATH } from "../../src/server/changelog.mjs";

const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === "--file")) {
  console.error("usage: check-changelog.mjs [--file <path>]");
  process.exit(2);
}
const path = args.length === 2 ? args[1] : CHANGELOG_PATH;

let text;
try {
  text = readFileSync(path, "utf8");
} catch (e) {
  console.error(`check-changelog: cannot read ${path}: ${e.message}`);
  process.exit(1);
}

const { entries, warnings } = parseChangelog(text);

if (warnings.length > 0) {
  console.error(`check-changelog: ${warnings.length} problem(s) in ${path}:`);
  for (const w of warnings) console.error(`  - ${w}`);
}
if (entries.length === 0) {
  console.error(`check-changelog: no versioned entries found in ${path}`);
}

const [newest] = entries;
if (newest) {
  const label = `${newest.version}${newest.date ? ` (${newest.date})` : ""} [${newest.components.join(", ") || "no components"}]`;
  if (newest.highlights.length > 0) {
    console.log(`Newest entry ${label}: window B — "${newest.headline ?? `What's new in Manta ${newest.version}`}", ${newest.highlights.length} card(s):`);
    for (const h of newest.highlights) console.log(`  - ${h.title} [${h.icon}] → ${h.action ?? "no link"}`);
  } else {
    console.log(`Newest entry ${label}: window A — release notes only (no highlights block)`);
  }
}

process.exit(warnings.length > 0 || entries.length === 0 ? 1 : 0);
