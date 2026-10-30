import { test } from "node:test";
import assert from "node:assert/strict";
import { RECORD_RETENTION_MAX, RECORD_RETENTION_MS, continuationUnconsumed, emptyState, mintRecordId, normalizeState, pruneLinks, pruneRecords, publicEvent, publicRecord, rewriteAvailable, rewriteBlockedReason } from "./state.mjs";

const DAY = 24 * 3600_000;
const rec = (id, state, updatedAt, successorId) => ({ id, fromSessionId: "ses_p", kind: "auto", trigger: "auto", state, text: "t", createdAt: updatedAt, updatedAt, successorId, internal: { secret: 1 } });

test("record ids are hof_ + 20 base36 characters", () => {
  assert.match(mintRecordId(), /^hof_[0-9a-z]{20}$/);
  assert.notEqual(mintRecordId(), mintRecordId());
});

test("normalizeState degrades garbage to empty sections", () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState({ records: [], held: { a: [], b: "x", c: [{ id: "m" }] } }).held, { c: [{ id: "m" }] });
});

test("retention: terminal records older than 30 days go; in-flight and ready ones never", () => {
  const now = 100 * DAY;
  const s = emptyState();
  s.records = {
    old: rec("old", "committed", now - RECORD_RETENTION_MS - 1),
    fresh: rec("fresh", "committed", now - DAY),
    ready: rec("ready", "ready", now - 90 * DAY),
    starting: rec("starting", "starting", now - 90 * DAY),
  };
  assert.deepEqual(pruneRecords(s, now), ["old"]);
  assert.deepEqual(Object.keys(s.records).sort(), ["fresh", "ready", "starting"]);
});

test("retention: beyond 500 terminal records the oldest go", () => {
  const now = 10 * DAY;
  const s = emptyState();
  for (let i = 0; i < RECORD_RETENTION_MAX + 5; i++) s.records[`r${i}`] = rec(`r${i}`, "failed", now - i);
  const removed = pruneRecords(s, now);
  assert.equal(removed.length, 5);
  assert.ok(!s.records[`r${RECORD_RETENTION_MAX + 4}`] && s.records.r0);
});

test("retention keeps records whose continuation is unconsumed — however old", () => {
  const now = 400 * DAY;
  const s = emptyState();
  s.records = {
    armed: rec("armed", "committed", 1, "ses_armed"),
    draft: rec("draft", "committed", 1, "ses_draft"),
    send: rec("send", "committed", 1, "ses_send"),
    claimed: rec("claimed", "committed", 1, "ses_claimed"),
    done: rec("done", "committed", 1, "ses_done"),
    consumedDraft: rec("consumedDraft", "committed", 1, "ses_cd"),
  };
  s.continuations = {
    ses_armed: { recordId: "armed", preamble: "p" },
    ses_draft: { recordId: "draft", draft: "d", draftRevision: 1 },
    ses_send: { recordId: "send", send: { confirmed: false } },
    ses_claimed: { recordId: "claimed", claim: { messageId: "m" } },
    ses_done: { recordId: "done", send: { confirmed: true } },
    ses_cd: { recordId: "consumedDraft", draft: "d", draftRevision: 1, draftConsumed: 1 },
  };
  assert.deepEqual(pruneRecords(s, now).sort(), ["consumedDraft", "done"]);
  for (const id of ["armed", "draft", "send", "claimed"]) assert.ok(s.records[id], `${id} kept`);
  assert.ok(s.continuations.ses_armed && !s.continuations.ses_done, "a consumed continuation of a pruned record is dropped, an unconsumed one never");
  assert.equal(continuationUnconsumed({ draft: "d", draftRevision: 2, draftConsumed: 1 }), true);
  assert.equal(continuationUnconsumed(undefined), false);
});

test("links are kept while either end exists and pruned when neither does", async () => {
  const s = emptyState();
  s.links = { a: { replacedBy: "b", branches: [] }, b: { replaces: "a", branches: [] }, x: { replacedBy: "y", branches: [] } };
  await pruneLinks(s, async (sid) => sid === "b");
  assert.deepEqual(Object.keys(s.links).sort(), ["a", "b"], "b still exists so both ends' links stay; x/y are both gone");
});

test("the public record exposes the contract fields only", () => {
  const p = publicRecord(rec("r", "ready", 5));
  assert.equal(p.internal, undefined);
  assert.deepEqual(Object.keys(p).sort(), ["canRewrite", "createdAt", "fromSessionId", "id", "kind", "state", "text", "trigger", "updatedAt"]);
});

test("rewriteAvailable: settled + condensed estimate + not a send + not replaced; each missing piece names its cause", () => {
  const est = { providerID: "p", modelID: "m", estTokens: 1, estCostUsd: null, subscription: false };
  const base = { ...rec("r", "ready", 5), rewriteEstimate: est, internal: {} };
  assert.equal(rewriteAvailable(base), true);
  assert.equal(rewriteAvailable({ ...base, state: "failed" }), true);
  assert.equal(rewriteAvailable({ ...base, state: "generating" }), false);
  assert.match(rewriteBlockedReason({ ...base, state: "generating" }), /being written right now/);
  for (const state of ["requested", "starting", "committed", "dismissed", "cancelled"]) assert.equal(rewriteAvailable({ ...base, state }), false, state);
  assert.equal(rewriteAvailable({ ...base, rewriteEstimate: undefined }), false);
  assert.match(rewriteBlockedReason({ ...base, rewriteEstimate: undefined }), /trimmed transcript/);
  assert.equal(rewriteAvailable({ ...base, internal: { plan: { disposition: "send" } } }), false);
  assert.equal(rewriteAvailable({ ...base, disposition: "send" }), false);
  assert.match(rewriteBlockedReason({ ...base, disposition: "send" }), /new conversation/);
  assert.equal(rewriteAvailable(base, { replaced: true }), false);
  assert.match(rewriteBlockedReason(base, { replaced: true }), /already handed off/);
  assert.equal(rewriteAvailable(null), false);
});

test("publicRecord / publicEvent carry writer, rewriteEstimate and a boolean canRewrite — never the internals", () => {
  const est = { providerID: "p", modelID: "m", estTokens: 9, estCostUsd: 1.5, subscription: true };
  const r = { ...rec("r", "ready", 5), writer: { path: "condensed", providerID: "x", modelID: "y", inputTokens: 3 }, rewriteEstimate: est, internal: { attempt: { id: "a" }, lastWriter: "condensed" } };
  const p = publicRecord(r);
  assert.deepEqual(p.writer, r.writer);
  assert.deepEqual(p.rewriteEstimate, est);
  assert.equal(p.canRewrite, true);
  assert.equal(publicRecord(r, { replaced: true }).canRewrite, false);
  assert.equal(p.internal, undefined);
  const e = publicEvent(r);
  assert.equal(e.canRewrite, true);
  assert.deepEqual(e.writer, r.writer);
  assert.deepEqual(e.rewriteEstimate, est);
  assert.equal(publicEvent({ ...r, state: "generating" }).canRewrite, false);
  assert.equal(publicEvent(rec("r2", "ready", 5)).canRewrite, false);
});
