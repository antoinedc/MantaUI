import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMilestone,
  applyChecklist,
  applyModelReport,
  computeJobView,
  defaultJobProgress,
  formatDuration,
  initialCeilingMs,
  mergeUsage,
  plainLine,
  recomputeSteps,
  stepsOf,
  validateMaxDurationMinutes,
  viewSignature,
  withLivenessDefaults,
} from "./jobProgressView.mjs";

const T = 1_000_000;
const todo = (content, status = "pending") => ({ content, status, priority: "medium" });
const jp0 = defaultJobProgress;

test("checklist steps: cancelled items are excluded from both counts; current = the first in_progress", () => {
  let jp = applyChecklist(jp0(), [todo("a", "completed"), todo("b", "in_progress"), todo("c", "in_progress"), todo("d", "cancelled"), todo("e")], T);
  const s = stepsOf(jp);
  assert.equal(s.source, "checklist");
  assert.equal(s.total, 4);
  assert.equal(s.done, 1);
  assert.equal(s.current, "b");
  assert.deepEqual(s.items.map((i) => i.status), ["done", "current", "pending", "pending"], "the second in_progress is not 'current'");
  jp = applyChecklist(jp, [todo("a"), todo("b")], T);
  assert.equal(stepsOf(jp).current, null);
});

test("a one-item checklist is not a plan: the report is used, else no steps", () => {
  let jp = applyChecklist(jp0(), [todo("only", "in_progress")], T);
  assert.equal(stepsOf(jp), null);
  jp = applyModelReport(jp, { input: { label: "x" }, record: { state: "working", step: 3, total: 5 }, now: T });
  const s = stepsOf(jp);
  assert.equal(s.source, "reported");
  assert.equal(s.done, 2, "step 3 of 5 is the CURRENT step");
  assert.deepEqual(s.items, []);
});

test("reported steps: step 0, a missing step or total are unusable; a step past the total clamps", () => {
  const rep = (step, total) => stepsOf(applyModelReport(jp0(), { input: {}, record: { state: "working", step, total }, now: T }));
  assert.equal(rep(0, 5), null);
  assert.equal(rep(null, 5), null);
  assert.equal(rep(2, null), null);
  assert.equal(rep(7, 5).done, 5);
  assert.equal(rep(1, 5).done, 0);
});

test("both: the checklist wins the steps, the model's label wins the headline", () => {
  let jp = applyChecklist(jp0(), [todo("a", "completed"), todo("b", "in_progress"), todo("c")], T);
  jp = applyModelReport(jp, { input: { label: "wiring the parser" }, record: { state: "working", step: 2, total: 9 }, now: T });
  const job = { id: "j", status: "running", startedAt: T, ceilingMs: 1e7, jobProgress: jp, activity: "reading x" };
  const v = computeJobView(job, null, { now: T + 1000, manta: true });
  assert.equal(v.steps.source, "checklist");
  assert.equal(v.steps.total, 3);
  assert.equal(v.headline, "wiring the parser");
  assert.equal(v.headlineSource, "model");
});

test("headline falls through: stale label → checklist item → running tool → activity → none; first line, plain, ≤120", () => {
  const job = (jp, extra = {}) => ({ id: "j", status: "running", startedAt: T, ceilingMs: 1e7, jobProgress: jp, ...extra });
  let jp = applyChecklist(applyModelReport(jp0(), { input: { label: "old label" }, record: { state: "working" }, now: T }), [todo("a"), todo("current item", "in_progress")], T);
  const fresh = computeJobView(job(jp), null, { now: T + 29 * 60_000, manta: true });
  assert.equal(fresh.headlineSource, "model");
  const aged = computeJobView(job(jp), null, { now: T + 31 * 60_000, manta: true });
  assert.deepEqual([aged.headline, aged.headlineSource], ["current item", "checklist"]);
  const tool = computeJobView(job(jp0()), { tool: { tool: "bash", target: "npm test", startedAt: T }, lastProgressAt: T }, { now: T, manta: true });
  assert.deepEqual([tool.headline, tool.headlineSource], ["bash: npm test", "tool"]);
  const act = computeJobView(job(jp0(), { activity: "editing a.ts" }), null, { now: T, manta: true });
  assert.deepEqual([act.headline, act.headlineSource], ["editing a.ts", "activity"]);
  assert.deepEqual(computeJobView(job(jp0()), null, { now: T, manta: true }).headlineSource, "none");
  assert.equal(plainLine("<b>bold</b> **x**\nsecond line"), "<b>bold</b> **x**", "markup stays literal: no stripping, no rendering");
  assert.equal(plainLine("x".repeat(300)).length, 120);
  assert.equal(plainLine("a\u0007b"), "a b");
});

test("the bar: monotonic within a revision, drops on a new one (and records grewAt), caps at 0.95, is 1 only on done", () => {
  const list = (n, doneCount) => Array.from({ length: n }, (_, i) => todo(`s${i}`, i < doneCount ? "completed" : "pending"));
  let jp = applyChecklist(jp0(), list(4, 2), T);
  assert.equal(jp.bar, 0.5);
  assert.equal(jp.planRevision, 1);
  assert.equal(jp.grewAt, null);
  jp = applyChecklist(jp, list(4, 1), T + 1); // an item un-completed: same plan, the bar never backs up
  assert.equal(jp.bar, 0.5);
  assert.equal(jp.planRevision, 1);
  jp = applyChecklist(jp, list(8, 2), T + 2); // the plan grew: a new revision, the bar may drop
  assert.equal(jp.planRevision, 2);
  assert.equal(jp.bar, 0.25);
  assert.equal(jp.grewAt, T + 2);
  jp = applyChecklist(jp, list(8, 8), T + 3);
  assert.equal(jp.bar, 0.95, "capped while not terminal");
  assert.equal(recomputeSteps(jp, { now: T, terminal: { status: "done", endedBlocked: false } }).bar, 1);
  assert.equal(recomputeSteps(jp, { now: T, terminal: { status: "done", endedBlocked: true } }).bar, 0.95, "needs a decision is not done");
  assert.equal(recomputeSteps(jp, { now: T, terminal: { status: "failed" } }).bar, 0.95);
  jp = applyChecklist(jp, list(5, 5), T + 4); // the plan shrank: a revision, but not "grew"
  assert.equal(jp.grewAt, T + 2);
});

test("a model `done` while running does not change the state; blocked is needs-decision; an end while blocked is too", () => {
  const job = (jp, extra = {}) => ({ id: "j", status: "running", startedAt: T, ceilingMs: 1e7, jobProgress: jp, ...extra });
  const state = (j) => computeJobView(j, null, { now: T, manta: true }).state;
  assert.equal(state(job(applyModelReport(jp0(), { input: {}, record: { state: "done" }, now: T }))), "working");
  assert.equal(state(job(applyModelReport(jp0(), { input: {}, record: { state: "failed" }, now: T }))), "working");
  assert.equal(state(job(applyModelReport(jp0(), { input: {}, record: { state: "blocked" }, now: T }))), "needs-decision");
  assert.equal(state(job(jp0(), { status: "done", endedBlocked: true })), "needs-decision");
  assert.equal(state(job(jp0(), { status: "done" })), "done");
  assert.equal(state(job(jp0(), { status: "paused" })), "paused");
});

test("milestones: bounded to 8, an exact duplicate of the newest dropped, empty ignored, ≤160, newest first in the view", () => {
  let jp = jp0();
  for (let i = 0; i < 12; i++) jp = addMilestone(jp, `m${i}`, T + i);
  assert.equal(jp.milestones.length, 8);
  assert.equal(jp.milestones[0].text, "m4");
  const same = addMilestone(jp, "m11", T + 99);
  assert.equal(same, jp, "duplicate of the newest");
  assert.equal(addMilestone(jp, "   ", T), jp);
  assert.equal(addMilestone(jp0(), "x".repeat(400), T).milestones[0].text.length, 160);
  const v = computeJobView({ id: "j", status: "running", startedAt: T, ceilingMs: 1e7, jobProgress: jp }, null, { now: T, manta: true });
  assert.equal(v.milestones[0].text, "m11");
  assert.equal(v.milestones.at(-1).text, "m4");
});

test("usage: tokens add, costUsd stays null until a cost is seen, costPartial is sticky", () => {
  let u = mergeUsage(undefined, { tokens: 100, costUsd: null, partial: true });
  assert.deepEqual(u, { tokens: 100, costUsd: null, costPartial: true });
  u = mergeUsage(u, { tokens: 50, costUsd: 0.5, partial: false });
  assert.deepEqual(u, { tokens: 150, costUsd: 0.5, costPartial: true });
  assert.deepEqual(mergeUsage(mergeUsage(undefined, null), { tokens: 1, costUsd: 0.25, partial: false }), { tokens: 1, costUsd: 0.25, costPartial: false });
});

test("the view: anchors, quantized progress time, null ceiling / usage for an opencode-owned job, files, ended time", () => {
  const job = { id: "j", status: "running", startedAt: T, ceilingMs: 4 * 3_600_000, model: "p/m", jobProgress: { ...jp0(), files: { changed: 3, at: T }, usage: { tokens: 10, costUsd: null, costPartial: false } } };
  const v = computeJobView(job, { lastProgressAt: T + 65_000, usageDelta: { tokens: 5, costUsd: 1, partial: false }, tool: null }, { now: T + 70_000, manta: true });
  assert.equal(v.lastProgressAt, Math.floor((T + 65_000) / 30_000) * 30_000, "quantized to 30 s");
  assert.equal(v.ceilingAt, T + 4 * 3_600_000);
  assert.deepEqual(v.usage, { tokens: 15, costUsd: 1, costPartial: false });
  assert.deepEqual(v.files, { changed: 3 });
  assert.equal(v.endedAt, null);
  assert.equal(v.asOf, T + 70_000);
  const oc = computeJobView(job, null, { now: T, manta: false });
  assert.deepEqual([oc.ceilingAt, oc.usage, oc.files], [null, null, null]);
  const done = computeJobView({ ...job, status: "done", finishedAt: T + 9, filesChanged: 4, jobProgress: { ...job.jobProgress, files: null } }, null, { now: T + 99, manta: true });
  assert.equal(done.endedAt, T + 9);
  assert.equal(done.lastProgressAt, null);
  assert.equal(done.ceilingAt, null);
  assert.deepEqual(done.files, { changed: 4 });
});

test("the signature ignores asOf only", () => {
  const job = { id: "j", status: "running", startedAt: T, ceilingMs: 1e7, jobProgress: jp0() };
  const a = computeJobView(job, { lastProgressAt: T, tool: null, usageDelta: null }, { now: T, manta: true });
  const b = computeJobView(job, { lastProgressAt: T + 10_000, tool: null, usageDelta: null }, { now: T + 10_000, manta: true });
  assert.equal(viewSignature(a), viewSignature(b), "inside one 30 s quantum");
  const c = computeJobView(job, { lastProgressAt: T + 40_000, tool: null, usageDelta: null }, { now: T + 40_000, manta: true });
  assert.notEqual(viewSignature(a), viewSignature(c));
});

test("ceiling arithmetic and formatting", () => {
  assert.equal(initialCeilingMs({}), 4 * 3_600_000);
  assert.equal(initialCeilingMs({ maxDurationMinutes: 90 }), 90 * 60_000);
  assert.equal(initialCeilingMs({ sweepAllowanceMs: 300_000 }), 300_000, "the CTO's allowance is the ceiling");
  assert.equal(initialCeilingMs({ sweepAllowanceMs: 300_000, maxDurationMinutes: 600 }), 300_000);
  assert.equal(formatDuration(4 * 3_600_000), "4 hours");
  assert.equal(formatDuration(9_000_000), "2 hours 30 minutes");
  assert.equal(formatDuration(3_600_000), "1 hour");
  assert.equal(formatDuration(60_000), "1 minute");
  for (const bad of [9, 721, 1.5, "60"]) assert.equal(validateMaxDurationMinutes(bad), "maxDurationMinutes must be an integer between 10 and 720");
  assert.equal(validateMaxDurationMinutes(10), null);
  assert.equal(validateMaxDurationMinutes(undefined), null);
});

test("a legacy running record gets every new field (the CTO's allowance as its ceiling)", () => {
  const legacy = { id: "j", status: "running", sweepAllowanceMs: 90 * 60_000 };
  const j = withLivenessDefaults(legacy);
  assert.equal(j.ceilingMs, 90 * 60_000);
  assert.equal(j.baseCeilingMs, 90 * 60_000);
  assert.deepEqual(j.extensions, []);
  assert.equal(j.endReason, null);
  assert.equal(j.endedBlocked, false);
  assert.deepEqual(j.jobProgress, defaultJobProgress());
  assert.equal(withLivenessDefaults({ id: "k", status: "running" }).ceilingMs, 4 * 3_600_000);
});
