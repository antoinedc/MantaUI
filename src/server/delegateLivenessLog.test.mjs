import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLivenessLog } from "./delegateLivenessLog.mjs";

const dir = () => mkdtempSync(join(process.env.MANTA_STATE_HOME ?? tmpdir(), "live-log-"));

test("one JSON line per segment; the deployed line is written once per box", async () => {
  const d = dir();
  const log = createLivenessLog({ path: join(d, "l.jsonl"), markerPath: join(d, "l.deployed"), now: () => 1234 });
  assert.equal(await log.recordDeployed({ version: "1.2.3", gitSha: "abc" }), true);
  assert.equal(await log.recordDeployed({ version: "1.2.4", gitSha: "def" }), false);
  await log.appendSegment({ jobId: "j", status: "failed", endReason: "stalled" });
  const lines = readFileSync(join(d, "l.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { type: "deployed", at: 1234, version: "1.2.3", gitSha: "abc" });
  assert.deepEqual(lines[1], { at: 1234, jobId: "j", status: "failed", endReason: "stalled" });
  assert.equal(lines.length, 2);
});

test("rotated at the size limit; rotated files older than 90 days are removed; a failure never throws", async () => {
  const d = dir();
  let t = Date.now();
  const log = createLivenessLog({ path: join(d, "l.jsonl"), markerPath: join(d, "m"), now: () => t, maxBytes: 50, retentionMs: 1000 });
  await log.appendSegment({ n: 1, pad: "x".repeat(60) });
  t += 1;
  await log.appendSegment({ n: 2 });
  const rotated = readdirSync(d).filter((f) => f.startsWith("l.jsonl."));
  assert.equal(rotated.length, 1);
  assert.equal(JSON.parse(readFileSync(join(d, "l.jsonl"), "utf8")).n, 2);
  utimesSync(join(d, rotated[0]), 1, 1); // ancient
  t += 5;
  await log.appendSegment({ n: 3, pad: "y".repeat(60) });
  t += 5;
  await log.appendSegment({ n: 4 });
  assert.equal(existsSync(join(d, rotated[0])), false, "the 90-day (here 1 s) retention pruned it");
  const broken = createLivenessLog({ path: join(d, "no", "such", "dir", "l.jsonl"), markerPath: join(d, "m2") });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await broken.appendSegment({ n: 1 });
  } finally {
    console.warn = warn;
  }
  writeFileSync(join(d, "ok"), "x");
});
