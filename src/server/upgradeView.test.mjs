import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradeView, formatEtaSeconds, describeDiskShortfall, diskSentence } from "./upgradeView.mjs";

const GiB = 2 ** 30;
const IDS = ["preflight", "stop", "copy", "migrate", "verify", "cutover"];
const steps = (at, status, extra = {}) =>
  IDS.map((id, i) => ({ id, label: id, status: i < IDS.indexOf(at) ? "done" : i === IDS.indexOf(at) ? status : "pending", progress: i === IDS.indexOf(at) ? extra.progress ?? null : null, ...(i === IDS.indexOf(at) && extra.error ? { error: extra.error } : {}) }));
const status = (over) => ({ state: "running", steps: steps("migrate", "running"), overall: 0.5, etaSeconds: 240, error: null, ...over });

test("idle / completed carry no wording", () => {
  assert.deepEqual(buildUpgradeView(null), { kind: "idle" });
  assert.deepEqual(buildUpgradeView(status({ state: "completed" })), { kind: "completed" });
  assert.deepEqual(buildUpgradeView(status({ state: "idle" })), { kind: "idle" });
});

test("running: current step, fraction, eta text and the details text", () => {
  const s = status({ steps: steps("migrate", "running", { progress: { numerator: 1, denominator: 4, label: "Sessions" } }) });
  const v = buildUpgradeView(s);
  assert.equal(v.kind, "running");
  assert.equal(v.currentStepId, "migrate");
  assert.equal(v.currentFraction, 0.25);
  assert.equal(v.etaText, "about 4 min left");
  assert.match(v.details, /^Manta box upgrade — running\n/);
  assert.match(v.details, /migrate: running \(1\/4\) — Sessions/);
});

test("running without a measurable step is indeterminate", () => {
  assert.equal(buildUpgradeView(status({ steps: steps("stop", "running") })).currentFraction, null);
  assert.equal(buildUpgradeView(status({ etaSeconds: null })).etaText, null);
});

test("eta strings", () => {
  assert.equal(formatEtaSeconds(10), "less than a minute left");
  assert.equal(formatEtaSeconds(3600), "about 1 h left");
  assert.equal(formatEtaSeconds(3600 + 600), "about 1 h 10 min left");
  assert.equal(formatEtaSeconds(-1), null);
  assert.equal(formatEtaSeconds(null), null);
});

test("failed on disk: Check again, no rollback, disk sentence and details", () => {
  const v = buildUpgradeView(status({
    state: "failed",
    steps: steps("preflight", "failed"),
    error: { step: "preflight", message: "There isn't enough free disk space.", retryable: true, needBytes: 31 * GiB, haveBytes: 3 * GiB },
  }));
  assert.equal(v.kind, "failed");
  assert.equal(v.retryLabel, "Check again");
  assert.equal(v.canRollback, false);
  assert.equal(v.canRetry, true);
  assert.equal(v.disk, "needs 31 GB free, has 3 GB");
  assert.equal(v.diskSentence, "Needs 31 GB free, has 3 GB.");
  assert.match(v.details, /error \(preflight\): There isn't enough free disk space\.\ndisk: needs 31 GB free, has 3 GB/);
});

test("failed in migrate: Retry + Roll back; a non-retryable failure disables Retry with its reason", () => {
  const base = status({ state: "failed", steps: steps("migrate", "failed"), error: { step: "migrate", message: "boom", retryable: true } });
  const v = buildUpgradeView(base);
  assert.deepEqual([v.retryLabel, v.canRollback, v.canRetry, v.retryDisabledReason], ["Retry", true, true, null]);
  const dead = buildUpgradeView({ ...base, error: { step: "migrate", message: "boom", retryable: false } });
  assert.equal(dead.canRetry, false);
  assert.match(dead.retryDisabledReason, /roll back instead/);
});

test("verify failures are fixed in place: Check again, no rollback", () => {
  const v = buildUpgradeView(status({ state: "failed", steps: steps("verify", "failed"), error: { step: "verify", message: "Sign in to Claude again.", retryable: true } }));
  assert.deepEqual([v.retryLabel, v.canRollback], ["Check again", false]);
});

test("failed with no error object falls back to the failed step's own text", () => {
  const v = buildUpgradeView(status({ state: "failed", steps: steps("copy", "failed", { error: "disk gone" }), error: null }));
  assert.equal(v.message, "disk gone");
  assert.equal(v.failedStep, "copy");
});

test("rolled_back carries the details text", () => {
  const v = buildUpgradeView(status({ state: "rolled_back" }));
  assert.equal(v.kind, "rolled_back");
  assert.match(v.details, /rolled back/);
});

test("disk helpers", () => {
  assert.equal(describeDiskShortfall({ needBytes: 31 * GiB }), "needs 31 GB free");
  assert.equal(describeDiskShortfall({ needBytes: 31 * GiB, haveBytes: 0 }), "needs 31 GB free, has 0 B");
  assert.equal(describeDiskShortfall({}), null);
  assert.equal(diskSentence(""), "");
});
