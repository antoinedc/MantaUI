// Tests for optimizer/telemetry.mjs — the count-only context telemetry for the
// optimizer (Optimizer P2.5, BET-1347). The sink is injected/reset directly;
// no Axiom network is ever touched (without a sink the module is a no-op).
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTelemetrySink, shipCtxEvent } from "./telemetry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fakeSink() {
  const events = [];
  return {
    events,
    log(level, msg, fields) {
      events.push({ level, msg, fields });
    },
  };
}

test("no sink -> shipCtxEvent is a silent no-op, never throws", () => {
  setTelemetrySink(null);
  let threw = false;
  try {
    shipCtxEvent({ kind: "tune", param: "maskAfterUses", from: 12, to: 10, sessionID: "abc" });
  } catch {
    threw = true;
  }
  assert.equal(threw, false); // still silent, no throw
});

test("fields pass through on the ctx channel with a sink set", () => {
  const sink = fakeSink();
  setTelemetrySink(sink);
  try {
    shipCtxEvent({ kind: "mask", maskedTokens: 120, maskedParts: 3, applied: 1, mode: "act", sessionID: "s1" });
    assert.equal(sink.events.length, 1);
    const e = sink.events[0];
    assert.equal(e.level, "info");
    assert.equal(e.msg, "ctx");
    assert.equal(e.fields.channel, "ctx");
    assert.equal(e.fields.kind, "mask");
    assert.equal(e.fields.maskedTokens, 120);
    assert.equal(e.fields.sessionID, "s1");
  } finally {
    setTelemetrySink(null);
  }
});

// ---- Content-field grep gate -------------------------------------------------
// The privacy contract: ctx telemetry ships COUNTS ONLY. No field named
// text/content/prompt/message may ever be emitted. This greps the actual
// emission call sites (and the telemetry module itself) so a future change
// that leaks content fails here, not in review.

const EMITTER_FILES = ["telemetry.mjs", "tuner.mjs"].map((f) => join(__dirname, f)).concat([
  join(__dirname, "..", "..", "index.mjs"),
  join(__dirname, "..", "rpc.mjs"),
]);

const INDICES = ["text:", "content:", "prompt:", "message:"];test("grep gate: no ctx emission ever ships a content field name", () => {
  const offenders = [];
  for (const file of EMITTER_FILES) {
    let src = "";
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // Find every shipCtxEvent({ ... }) call and capture its object literal.
    const re = /shipCtxEvent\s*\(\s*\{([\s\S]*?)\n?\s*\}\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const body = m[1];
      for (const idx of INDICES) {
        if (body.includes(idx)) {
          offenders.push(`${file}: near shipCtxEvent with '${idx}'`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
