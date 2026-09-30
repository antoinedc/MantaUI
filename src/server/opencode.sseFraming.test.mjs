import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseFramer, stripMessageSummaryDiffs } from "./opencode.mjs";

// Reference: the old quadratic framer, kept here only as a behavioural oracle.
function oldFrame(pieces) {
  let buf = "";
  const out = [];
  for (const p of pieces) {
    buf += p;
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
      }
      if (data) out.push(data);
    }
  }
  return out;
}

function frameAll(pieces) {
  const f = createSseFramer();
  const out = [];
  for (const p of pieces) out.push(...f.push(p));
  return out;
}

function splitEvery(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

test("sse framer: many events in one chunk", () => {
  const text = 'data: {"a":1}\n\ndata: {"b":2}\n\nevent: x\ndata: {"c":3}\n\n';
  assert.deepEqual(frameAll([text]), ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("sse framer: separator split exactly across a chunk boundary", () => {
  assert.deepEqual(frameAll(['data: {"a":1}\n', '\ndata: {"b":2}\n\n']), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(frameAll(['data: {"a":1}\n', "\n"]), ['{"a":1}']);
});

test("sse framer: multi-line data joined with newline; non-data lines ignored; empty events dropped", () => {
  const text = "id: 1\nevent: m\nretry: 5\ndata: line1\ndata:line2\n\n: comment\n\n";
  assert.deepEqual(frameAll([text]), ["line1\nline2"]);
});

test("sse framer: matches the old framer on every split point of a mixed stream", () => {
  const text =
    'data: {"a":1}\n\n: hb\n\nid: 7\ndata: {"b":\ndata: 2}\n\ndata: {"c":"x\\ny"}\n\ndata: tail-no-sep';
  for (let size = 1; size <= text.length; size++) {
    const pieces = splitEvery(text, size);
    assert.deepEqual(frameAll(pieces), oldFrame(pieces), `chunk size ${size}`);
  }
});

test("sse framer: a 5 MB event in 64 KB pieces is framed correctly and fast", () => {
  const big = JSON.stringify({ type: "message.updated", blob: "x".repeat(5 * 1024 * 1024) });
  const text = `data: ${big}\n\ndata: {"after":1}\n\n`;
  const pieces = splitEvery(text, 64 * 1024);
  const t0 = performance.now();
  const out = frameAll(pieces);
  const ms = performance.now() - t0;
  assert.equal(out.length, 2);
  assert.equal(out[0], big);
  assert.equal(out[1], '{"after":1}');
  assert.ok(ms < 500, `framing took ${ms.toFixed(0)} ms`);
});

test("stripMessageSummaryDiffs: drops summary.diffs from message.updated only", () => {
  const ev = {
    type: "message.updated",
    properties: { info: { id: "m", summary: { title: "t", additions: 3, diffs: [{ file: "a", patch: "..." }] } } },
  };
  stripMessageSummaryDiffs(ev);
  assert.deepEqual(ev.properties.info.summary, { title: "t", additions: 3 });

  const other = { type: "session.updated", properties: { info: { summary: { diffs: [1] } } } };
  stripMessageSummaryDiffs(other);
  assert.deepEqual(other.properties.info.summary.diffs, [1]);

  const noSummary = { type: "message.updated", properties: { info: { id: "m" } } };
  assert.deepEqual(stripMessageSummaryDiffs(noSummary), { type: "message.updated", properties: { info: { id: "m" } } });

  const nonArray = { type: "message.updated", properties: { info: { summary: { diffs: "x" } } } };
  stripMessageSummaryDiffs(nonArray);
  assert.equal(nonArray.properties.info.summary.diffs, "x");

  for (const odd of [null, undefined, 42, "s", { type: "message.updated" }, { type: "message.updated", properties: null }]) {
    assert.doesNotThrow(() => stripMessageSummaryDiffs(odd));
  }
});
