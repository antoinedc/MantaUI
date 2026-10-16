// Golden replay of recorded opencode V1 event streams through the stream
// interpreter (OpenCode V2 migration, slice A).
//
// Corpus: src/server/fixtures/opencodeV1Events/<name>.jsonl — one raw event per
// line, exactly as the box's opencode (V1, 1.18.34) emitted it, including the
// global + per-directory DOUBLE delivery the interpreter must de-dup. Recorded
// with scripts/record-opencode-events.mjs (scrubbed: home paths, tokens). Each
// has a checked-in <name>.frames.json of the frames the interpreter publishes.
//
//   01-plain-text       text answer streamed as deltas
//   02-slow-bash        bash tool streaming metadata.output (1..5, one per second)
//   03-edit-todo        read/edit tools + todowrite x4 (todo.updated)
//   04-task-subagent    `task` tool -> child session (session.created, child events)
//   05-question         question tool asked + answered (question.asked/replied)
//   06-abort            bash tool aborted mid-run (session.error MessageAbortedError)
//   07-command-compact  slash command (command.executed) then session.compacted
//   synthetic-legacy    HAND-BUILT, not recorded. Covers frames whose raw event the
//                       deployed V1 build never emits and that cannot be provoked
//                       on demand: session.status retry (+ action), the legacy
//                       session.next.step.ended / session.next.compaction.* family,
//                       message.part.removed / message.removed, and a permission
//                       ask (the box's default agent allows every tool and the
//                       box runs in trust mode, so a real permission.asked cannot
//                       be recorded). Shapes follow AGENTS.md ("Subagent
//                       rendering", step-ended / compaction notes).
//
// UPDATE_GOLDEN=1 rewrites the .frames.json files (review the diff by eye).
//
// Clock: the interpreter is replayed with a FAKE clock that advances 20 ms per
// raw event and a fake timer queue driven by that clock, so flush max-age and the
// messageChanged 100 ms coalescing are exercised deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamInterpreter } from "./streamInterp.mjs";
import { scrubEvent, eventSessionIds } from "../../scripts/record-opencode-events.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opencodeV1Events");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const TICK_MS = 20;
const T0 = 1_000_000;

const NEW_SUBS = [
  "retry",
  "stepEnded",
  "toolBoundary",
  "compaction",
  "transcriptStale",
  "messageChanged",
  "commandExecuted",
  "childSession",
  "attention",
  "aborted",
];

const corpus = readdirSync(DIR)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()
  .map((f) => f.replace(/\.jsonl$/, ""));

function readEvents(name) {
  return readFileSync(join(DIR, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Replay raw events through a fresh interpreter; returns the published frames. */
export function replay(events) {
  let clock = T0;
  const frames = [];
  const timers = []; // { at, fn, dead }
  const fireDue = (until) => {
    for (;;) {
      let next = null;
      for (const t of timers) if (!t.dead && t.at <= until && (!next || t.at < next.at)) next = t;
      if (!next) break;
      next.dead = true;
      clock = Math.max(clock, next.at);
      next.fn();
    }
    clock = Math.max(clock, until);
  };
  const interp = createStreamInterpreter({
    publish: (e) => frames.push(e),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.dead = true; },
  });
  events.forEach((ev, i) => {
    fireDue(T0 + i * TICK_MS);
    interp.interpret(ev);
  });
  fireDue(T0 + events.length * TICK_MS + 1_000); // let every trailing edge fire
  interp.flushPending();
  interp.dispose();
  return frames;
}

function serialise(frames) {
  return `[\n${frames.map((f) => JSON.stringify(f)).join(",\n")}\n]\n`;
}

for (const name of corpus) {
  test(`golden: ${name}`, () => {
    const frames = replay(readEvents(name));
    const goldenPath = join(DIR, `${name}.frames.json`);
    if (UPDATE) {
      writeFileSync(goldenPath, serialise(frames));
      return;
    }
    assert.ok(existsSync(goldenPath), `missing ${goldenPath} — run with UPDATE_GOLDEN=1 and review`);
    assert.deepEqual(frames, JSON.parse(readFileSync(goldenPath, "utf8")));
  });

  test(`replay is deterministic: ${name}`, () => {
    const events = readEvents(name);
    assert.deepEqual(replay(events), replay(events));
  });
}

test("every new frame sub appears in at least one golden frames file", () => {
  const seen = new Set();
  for (const name of corpus) {
    const goldenPath = join(DIR, `${name}.frames.json`);
    if (!existsSync(goldenPath)) continue;
    for (const f of JSON.parse(readFileSync(goldenPath, "utf8"))) seen.add(f.sub);
  }
  for (const sub of NEW_SUBS) assert.ok(seen.has(sub), `no golden file contains a "${sub}" frame`);
});

test("double delivery is de-duplicated (synthetic-legacy carries duplicated event ids)", () => {
  // opencode delivers a scoped event on the global AND the per-directory stream on
  // some builds; the recorded 1.18.34 streams happen not to double, so the
  // hand-built file duplicates a few events deliberately.
  const events = readEvents("synthetic-legacy");
  const ids = events.map((e) => e.id);
  assert.ok(new Set(ids).size < ids.length, "expected duplicate event ids in synthetic-legacy");
  const frames = replay(events);
  // Two retry frames with a payload (attempt 2 delivered twice, attempt 3 once) + two clears.
  assert.deepEqual(
    frames.filter((f) => f.sub === "retry").map((f) => f.payload?.attempt ?? null),
    [2, null, 3, null],
  );
  assert.equal(frames.filter((f) => f.sub === "attention").length, 2); // permission, then null
});

test("one toolBoundary per completed tool part despite double delivery", () => {
  for (const name of corpus) {
    const events = readEvents(name);
    const done = new Set();
    for (const e of events) {
      const p = e.properties?.part;
      if (e.type === "message.part.updated" && p?.type === "tool" && ["completed", "error"].includes(p.state?.status)) done.add(p.id);
    }
    const boundaries = replay(events).filter((f) => f.sub === "toolBoundary");
    assert.equal(boundaries.length, done.size, name);
    assert.equal(new Set(boundaries.map((b) => b.payload.partID)).size, done.size, name);
  }
});

test("messageChanged: every touched message is announced, last change is never dropped", () => {
  for (const name of corpus) {
    const events = readEvents(name);
    const touched = new Set();
    for (const e of events) {
      const p = e.properties ?? {};
      if (["message.updated", "message.part.updated", "message.part.removed", "message.removed"].includes(e.type)) {
        touched.add(p.messageID ?? p.part?.messageID ?? p.info?.id);
      }
    }
    const frames = replay(events).filter((f) => f.sub === "messageChanged");
    assert.deepEqual(new Set(frames.map((f) => f.payload.messageID)), touched, name);
    // At most one frame per message per 100 ms of the fake clock is enforced by the
    // interpreter; with 20 ms per event a 30-event run must therefore coalesce.
    assert.ok(frames.length <= events.length, name);
  }
});

test("running state frames still carry the abort/idle edges (06-abort)", () => {
  const frames = replay(readEvents("06-abort"));
  // MessageAbortedError is an intentional abort: it must NOT surface as sessionError.
  assert.equal(frames.filter((f) => f.sub === "sessionError").length, 0);
  assert.ok(frames.some((f) => f.sub === "turnComplete" && f.payload.complete === true));
  // …but the user Stop IS announced, as its own frame, before the idle edge.
  const aborted = frames.filter((f) => f.sub === "aborted");
  assert.equal(aborted.length, 1);
  assert.deepEqual(aborted[0].payload, {});
});

test("05-question: attention goes question -> null around the reply", () => {
  const att = replay(readEvents("05-question")).filter((f) => f.sub === "attention").map((f) => f.payload.kind);
  assert.deepEqual(att, ["question", null]);
});

test("04-task-subagent: the child session is announced under the PARENT", () => {
  const events = readEvents("04-task-subagent");
  const created = events.find((e) => e.type === "session.created");
  const frames = replay(events).filter((f) => f.sub === "childSession");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sessionId, created.properties.info.parentID);
  assert.deepEqual(frames[0].payload, {
    childSessionId: created.properties.info.id,
    parentSessionId: created.properties.info.parentID,
  });
});

test("corpus is scrubbed: no home paths, bearer tokens, keys or token fields", () => {
  for (const f of readdirSync(DIR)) {
    const text = readFileSync(join(DIR, f), "utf8");
    assert.ok(!text.includes("/home/dev"), `${f}: /home/dev`);
    assert.ok(!/Bearer /i.test(text), `${f}: Bearer`);
    assert.ok(!/\bsk-[A-Za-z0-9]/.test(text), `${f}: sk- key`);
    // `"tokens":` is the usage object and is expected; a bare "token" field is not.
    assert.ok(!/"(token|accessToken|refreshToken|apiKey|api_key|auth|authorization)"\s*:/i.test(text), `${f}: credential field`);
  }
});

test("recorder scrub: home + scratch paths rewritten, credential-looking fields dropped", () => {
  const out = scrubEvent(
    {
      type: "x",
      properties: {
        path: "/home/alice/proj/file.js",
        cwd: "/tmp/manta-rec-AbC123/sub",
        token: "abc",
        nested: { apiKey: "k", Authorization: "Bearer z", keep: ["/home/alice"] },
        tokens: { input: 1 }, // the usage object is NOT a credential
      },
    },
    { scratchDir: "/tmp/manta-rec-AbC123", home: "/home/alice" },
  );
  assert.deepEqual(out, {
    type: "x",
    properties: {
      path: "/home/user/proj/file.js",
      cwd: "/tmp/manta-rec/sub",
      nested: { keep: ["/home/user"] },
      tokens: { input: 1 },
    },
  });
});

test("recorder ownership filter reads every place an event can name its session", () => {
  assert.deepEqual([...eventSessionIds({ type: "message.updated", properties: { info: { sessionID: "a" } } })], ["a"]);
  assert.deepEqual([...eventSessionIds({ type: "message.part.updated", properties: { part: { sessionID: "b" } } })], ["b"]);
  assert.deepEqual([...eventSessionIds({ type: "session.created", properties: { sessionID: "c", info: { id: "c", parentID: "p" } } })], ["c"]);
  assert.equal(eventSessionIds({ type: "server.heartbeat", properties: {} }).size, 0);
});

test("stepEnded: exactly one frame per step-finish part in every recorded stream", () => {
  let total = 0;
  for (const name of corpus) {
    const events = readEvents(name);
    const parts = new Set();
    for (const e of events) {
      const p = e.properties?.part;
      if (e.type === "message.part.updated" && p?.type === "step-finish") parts.add(p.id);
    }
    total += parts.size;
    const steps = replay(events).filter((f) => f.sub === "stepEnded");
    // synthetic-legacy announces its steps via the legacy session.next.step.ended event, not parts.
    if (name !== "synthetic-legacy") assert.equal(steps.length, parts.size, name);
  }
  assert.ok(total > 0, "the recorded corpus contains step-finish parts");
});

test("05-question: the connect-time snapshot taken while the question is pending carries attention", () => {
  const events = readEvents("05-question");
  const askedAt = events.findIndex((e) => e.type === "question.asked");
  assert.ok(askedAt >= 0);
  const interp = createStreamInterpreter({ publish: () => {}, now: () => T0, setTimer: () => ({}), clearTimer: () => {} });
  for (const e of events.slice(0, askedAt + 1)) interp.interpret(e);
  const snap = interp.snapshotState().filter((f) => f.sub === "attention");
  assert.deepEqual(snap.map((f) => f.payload.kind), ["question"]);
  for (const e of events.slice(askedAt + 1)) interp.interpret(e);
  assert.equal(interp.snapshotState().filter((f) => f.sub === "attention").length, 0, "cleared after the reply");
});
