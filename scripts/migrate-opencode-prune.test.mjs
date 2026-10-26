// migrate-opencode-prune.test.mjs — the one-time `compaction.prune: true` default.
// Pure planner cases plus the real-file runner against temp dirs (never the live box's files).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { planPruneMigration, migratePrune } from "./migrate-opencode-prune.mjs";

const COMMENTED = `{
  // my providers
  "provider": { "x": { "name": "X" } }, /* inline */
  "model": "anthropic/claude-sonnet-5-5"
}
`;

test("key absent → compaction.prune added, everything else byte-for-byte", () => {
  const r = planPruneMigration({ configText: COMMENTED, markerPresent: false });
  assert.equal(r.reason, "enabled");
  assert.equal(r.writeConfig, true);
  assert.equal(r.writeMarker, true);
  assert.deepEqual(parse(r.text).compaction, { prune: true });
  assert.ok(r.text.includes("// my providers"));
  assert.ok(r.text.includes("/* inline */"));
  assert.ok(r.text.includes(`"provider": { "x": { "name": "X" } },`));
});

test("compaction exists without prune → prune added alongside, other keys + comments preserved", () => {
  const text = `{
  // keep me
  "compaction": {
    "auto": true, // trailing note
    "reserved": 10000
  },
  "model": "m"
}
`;
  const r = planPruneMigration({ configText: text, markerPresent: false });
  assert.equal(r.reason, "enabled");
  const cfg = parse(r.text);
  assert.deepEqual(cfg.compaction, { auto: true, reserved: 10000, prune: true });
  assert.ok(r.text.includes("// keep me"));
  assert.ok(r.text.includes("// trailing note"));
  assert.ok(r.text.includes(`"model": "m"`));
});

test("prune explicitly true → untouched, marker written", () => {
  const text = `{ "compaction": { "prune": true } }\n`;
  const r = planPruneMigration({ configText: text, markerPresent: false });
  assert.deepEqual([r.writeConfig, r.writeMarker, r.text], [false, true, text]);
});

test("prune explicitly false → untouched, marker written", () => {
  const text = `{ "compaction": { "prune": false } }\n`;
  const r = planPruneMigration({ configText: text, markerPresent: false });
  assert.deepEqual([r.writeConfig, r.writeMarker, r.text], [false, true, text]);
});

test("marker present → no-op", () => {
  const r = planPruneMigration({ configText: COMMENTED, markerPresent: true });
  assert.deepEqual([r.writeConfig, r.writeMarker, r.reason], [false, false, "already-migrated"]);
});

test("unparseable config → no change, warning, marker NOT written", () => {
  const r = planPruneMigration({ configText: "{ not json", markerPresent: false });
  assert.deepEqual([r.writeConfig, r.writeMarker, r.reason], [false, false, "config-unparseable"]);
  assert.match(r.warning, /unparseable/);
});

test("missing config (null) → no-op, marker not written", () => {
  const r = planPruneMigration({ configText: null, markerPresent: false });
  assert.deepEqual([r.writeConfig, r.writeMarker, r.reason], [false, false, "config-missing"]);
});

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "prune-mig-"));
  return { dir, config: join(dir, "opencode.jsonc"), state: join(dir, "state", "config.json") };
}

test("runner: enables once, preserves other state keys, second run is a no-op", async () => {
  const s = await sandbox();
  try {
    await writeFile(s.config, COMMENTED, { mode: 0o600 });
    await mkdir(join(s.dir, "state"));
    await writeFile(s.state, JSON.stringify({ projects: [1], chatAutoAllow: true }));

    const first = await migratePrune({ configPath: s.config, stateFile: s.state, now: () => new Date("2026-10-26T00:00:00Z") });
    assert.equal(first.outcome, "enabled");
    const after = await readFile(s.config, "utf-8");
    assert.deepEqual(parse(after).compaction, { prune: true });
    assert.equal((await stat(s.config)).mode & 0o777, 0o600, "file mode preserved");
    const st = JSON.parse(await readFile(s.state, "utf-8"));
    assert.deepEqual(st.projects, [1]);
    assert.equal(st.chatAutoAllow, true);
    assert.equal(st.migrations.pruneDefault, "2026-10-26T00:00:00.000Z");

    const second = await migratePrune({ configPath: s.config, stateFile: s.state });
    assert.equal(second.outcome, "already-migrated");
    assert.equal(await readFile(s.config, "utf-8"), after);
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("runner: a user value set after the marker is never overridden", async () => {
  const s = await sandbox();
  try {
    await writeFile(s.config, `{ "compaction": { "prune": false } }\n`);
    const r = await migratePrune({ configPath: s.config, stateFile: s.state });
    assert.equal(r.outcome, "already-set");
    assert.equal(await readFile(s.config, "utf-8"), `{ "compaction": { "prune": false } }\n`);
    assert.ok(JSON.parse(await readFile(s.state, "utf-8")).migrations.pruneDefault, "marker written when key already present");
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("runner: unparseable config → warning, config untouched, no marker file", async () => {
  const s = await sandbox();
  try {
    await writeFile(s.config, "{ nope");
    const r = await migratePrune({ configPath: s.config, stateFile: s.state });
    assert.equal(r.outcome, "config-unparseable");
    assert.ok(r.warning);
    assert.equal(await readFile(s.config, "utf-8"), "{ nope");
    await assert.rejects(stat(s.state));
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("runner: missing config file → no throw, no marker", async () => {
  const s = await sandbox();
  try {
    const r = await migratePrune({ configPath: s.config, stateFile: s.state });
    assert.equal(r.outcome, "config-missing");
    await assert.rejects(stat(s.state));
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("runner: unparseable state config → skipped, neither file written", async () => {
  const s = await sandbox();
  try {
    await writeFile(s.config, COMMENTED);
    await mkdir(join(s.dir, "state"));
    await writeFile(s.state, "{ broken");
    const r = await migratePrune({ configPath: s.config, stateFile: s.state });
    assert.equal(r.outcome, "state-unparseable");
    assert.equal(await readFile(s.config, "utf-8"), COMMENTED);
    assert.equal(await readFile(s.state, "utf-8"), "{ broken");
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});
