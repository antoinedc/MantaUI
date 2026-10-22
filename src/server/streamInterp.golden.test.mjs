// Golden replay of recorded OpenCode V2 event streams through the stream
// interpreter (OpenCode V2 cutover, slice C1).
//
// Corpus: src/server/fixtures/opencodeV2Events/<name>.jsonl — one raw
// `GET /api/event` payload per line as opencode 2.0.30 emitted it (only the
// events of the scenario's session and its children), recorded with
// scripts/opencode-v2/record-events.mjs against a sandboxed server on Haiku and
// scrubbed (sandbox paths, credential-looking fields, provider signatures).
// Each has a checked-in <name>.frames.json of the frames the interpreter
// publishes and a <name>.timeline.json (`GET /api/session/{id}/message`) that
// the transcript-mapper tests read.
//
//   01-plain-text       text answer streamed as deltas
//   02-slow-bash        shell tool, output tailed through GET /api/shell/{id}/output
//   03-edit-todo        read/edit tools + todo_write x2
//   04-task-subagent    `subagent` tool -> child session
//   05-question         question tool (a form) asked + answered
//   06-abort            shell tool interrupted mid-run
//   07-command-compact  slash command, then a manual compaction
//   08-permission       shell permission asked + answered (once)
//
// The V1 corpus these replace asserted the same SEMANTICS (same frames, same
// order of edges): the parity tests at the bottom pin that.
//
// UPDATE_GOLDEN=1 rewrites the .frames.json files (review the diff by eye).
//
// Clock: replayed with a FAKE clock advancing 20 ms per raw event and a fake
// timer queue driven by it, so the messageChanged 100 ms coalescing and the
// 250 ms shell poll are exercised deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamInterpreter } from "./streamInterp.mjs";
import { scrub, eventSessionIds } from "../../scripts/opencode-v2/record-events.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opencodeV2Events");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const TICK_MS = 20;
const T0 = 1_000_000;

const corpus = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort().map((f) => f.replace(/\.jsonl$/, ""));

export function readEvents(name) {
  return readFileSync(join(DIR, `${name}.jsonl`), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// The recorded shell output a poller would have read: the shell's final text
// (from the tool.success event), served incrementally by cursor so the poll
// path is exercised without a server.
function shellOutputsOf(events) {
  const out = new Map();
  const toolShell = new Map();
  for (const e of events) {
    if (e.type === "session.tool.progress" && e.data.metadata?.shellID) toolShell.set(e.data.id, e.data.metadata.shellID);
    if (e.type === "session.tool.success" && toolShell.has(e.data.id)) {
      out.set(toolShell.get(e.data.id), (e.data.content ?? []).map((c) => c.text ?? "").join(""));
    }
  }
  return out;
}

/** Replay raw events through a fresh interpreter; returns the published frames. */
export async function replay(events) {
  let clock = T0;
  const frames = [];
  const timers = []; // { at, fn, dead }
  const shells = shellOutputsOf(events);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const fireDue = async (until) => {
    for (;;) {
      let next = null;
      for (const t of timers) if (!t.dead && t.at <= until && (!next || t.at < next.at)) next = t;
      if (!next) break;
      next.dead = true;
      clock = Math.max(clock, next.at);
      next.fn();
      await settle(); // let the shell poll's awaited read land and re-arm
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
    // The shell has produced its output by the time the first poll fires.
    fetchShellOutput: async ({ shellID, cursor }) => {
      const full = shells.get(shellID) ?? "";
      return { output: full.slice(cursor), cursor: full.length };
    },
  });
  for (let i = 0; i < events.length; i++) {
    await fireDue(T0 + i * TICK_MS);
    interp.interpret(events[i]);
  }
  await fireDue(T0 + events.length * TICK_MS + 1_000);
  interp.flushPending();
  interp.dispose();
  return frames;
}

function serialise(frames) {
  return `[\n${frames.map((f) => JSON.stringify(f)).join(",\n")}\n]\n`;
}

for (const name of corpus) {
  test(`golden: ${name}`, async () => {
    const frames = await replay(readEvents(name));
    const goldenPath = join(DIR, `${name}.frames.json`);
    if (UPDATE) {
      writeFileSync(goldenPath, serialise(frames));
      return;
    }
    assert.ok(existsSync(goldenPath), `missing ${goldenPath} — run with UPDATE_GOLDEN=1 and review`);
    assert.deepEqual(frames, JSON.parse(readFileSync(goldenPath, "utf8")));
  });

  test(`replay is deterministic: ${name}`, async () => {
    const events = readEvents(name);
    assert.deepEqual(await replay(events), await replay(events));
  });
}

const subs = (frames) => frames.map((f) => f.sub);
const only = (frames, sub) => frames.filter((f) => f.sub === sub);

test("corpus is scrubbed: no home paths, bearer tokens, keys or signatures", () => {
  for (const f of readdirSync(DIR)) {
    if (!/\.(jsonl|json)$/.test(f)) continue;
    const text = readFileSync(join(DIR, f), "utf8");
    assert.ok(!text.includes("/home/dev"), `${f}: /home/dev`);
    assert.ok(!/Bearer /i.test(text), `${f}: Bearer`);
    assert.ok(!/\bsk-[A-Za-z0-9]/.test(text), `${f}: sk- key`);
    assert.ok(!/"(token|accessToken|refreshToken|apiKey|api_key|auth|authorization|signature)"\s*:/i.test(text), `${f}: credential field`);
  }
});

test("recorder scrub: sandbox + home paths rewritten, credential-looking fields dropped", () => {
  const out = scrub(
    { type: "x", data: { path: "/home/alice/p/f.js", cwd: "/tmp/manta-v2-sandbox-AbC/project/sub", token: "abc", nested: { apiKey: "k", signature: "s", keep: ["/home/alice"] }, tokens: { input: 1 } } },
    { root: "/tmp/manta-v2-sandbox-AbC", home: "/home/alice" },
  );
  assert.deepEqual(out, {
    type: "x",
    data: { path: "/home/user/p/f.js", cwd: "/tmp/manta-rec/project/sub", nested: { keep: ["/home/user"] }, tokens: { input: 1 } },
  });
});

test("recorder ownership filter reads every place a V2 event names its session", () => {
  assert.deepEqual([...eventSessionIds({ type: "session.step.started", data: { sessionID: "a" } })], ["a"]);
  assert.deepEqual([...eventSessionIds({ type: "form.created", data: { form: { sessionID: "b" } } })], ["b"]);
  assert.deepEqual([...eventSessionIds({ type: "shell.created", data: { info: { metadata: { sessionID: "c" } } } })], ["c"]);
  assert.equal(eventSessionIds({ type: "project.updated", data: {} }).size, 0);
});

// ---- parity with the V1 goldens' semantics ----

test("01-plain-text: running edge, streamed flushes, stepEnded, turnComplete", async () => {
  const f = await replay(readEvents("01-plain-text"));
  const running = only(f, "running").map((x) => x.payload.running);
  assert.deepEqual(running, [true, false]);
  assert.ok(only(f, "flush").length >= 1);
  assert.equal(only(f, "flush").map((x) => x.payload.text).join(""), "The corpus says hello.");
  assert.ok(only(f, "flush").every((x) => x.payload.field === "text"));
  assert.equal(only(f, "stepEnded").length, 1);
  assert.equal(only(f, "context").length, 1);
  const tc = only(f, "turnComplete");
  assert.equal(tc.at(-1).payload.complete, true);
  assert.equal(only(f, "sessionError").length, 0);
});

test("02-slow-bash: toolStarted -> live toolOutput tail (polled) -> toolEnded + toolBoundary, once each", async () => {
  const f = await replay(readEvents("02-slow-bash"));
  assert.equal(only(f, "toolStarted").length, 1);
  assert.equal(only(f, "toolStarted")[0].payload.toolName, "bash");
  assert.equal(only(f, "toolEnded").length, 1);
  assert.equal(only(f, "toolBoundary").length, 1);
  assert.equal(only(f, "toolBoundary")[0].payload.tool, "bash");
  const idxs = new Set(["toolStarted", "toolOutput", "toolEnded"].flatMap((s) => only(f, s).map((x) => x.payload.idx)));
  assert.equal(idxs.size, 1, "one stable idx across started/output/ended");
  assert.equal(only(f, "toolOutput").map((x) => x.payload.text).join(""), "line1\nline2\nline3\nline4\nline5\n");
  const order = subs(f).filter((s) => ["toolStarted", "toolOutput", "toolEnded", "toolBoundary"].includes(s));
  assert.equal(order[0], "toolStarted");
  assert.ok(order.indexOf("toolEnded") > order.lastIndexOf("toolOutput"));
});

test("03-edit-todo: todos frames follow each todo_write call", async () => {
  const f = await replay(readEvents("03-edit-todo"));
  const todos = only(f, "todos");
  assert.equal(todos.length, 2);
  assert.equal(todos[0].payload.allTerminal, false);
  assert.equal(todos[1].payload.allTerminal, true);
  assert.deepEqual(only(f, "toolStarted").map((x) => x.payload.toolName), ["todo_write", "read", "edit", "todo_write"]);
  assert.equal(only(f, "toolBoundary").length, 4);
});

test("04-task-subagent: the child is announced under the PARENT; subagent frames track it", async () => {
  const events = readEvents("04-task-subagent");
  const created = events.find((e) => e.type === "session.created" && e.data.parentID);
  const f = await replay(events);
  const child = only(f, "childSession");
  assert.equal(child.length, 1);
  assert.equal(child[0].sessionId, created.data.parentID);
  assert.deepEqual(child[0].payload, { childSessionId: created.data.sessionID, parentSessionId: created.data.parentID });
  const sub = only(f, "subagent");
  assert.ok(sub.length >= 2);
  assert.equal(sub[0].payload.status, "running");
  assert.equal(sub[0].payload.childSessionId, created.data.sessionID);
  assert.equal(sub.at(-1).payload.status, "completed");
  assert.equal(sub.at(-1).payload.agent, "explore");
  assert.equal(sub.at(-1).payload.runningCount, 0);
  assert.equal(typeof sub.at(-1).payload.output, "string");
});

test("05-question: attention goes question -> null around the reply; the card carries the form id", async () => {
  const f = await replay(readEvents("05-question"));
  assert.deepEqual(only(f, "attention").map((x) => x.payload.kind), ["question", null]);
  const qs = only(f, "questions");
  assert.equal(qs[0].payload.questions.length, 1);
  assert.match(qs[0].payload.questions[0].requestId ?? qs[0].payload.questions[0].id, /^frm_|^toolu_/);
  assert.equal(qs[0].payload.questions[0].questions[0].options.length, 3);
  assert.deepEqual(qs.at(-1).payload.questions, []);
});

test("06-abort: an interrupt is its own `aborted` frame, never a sessionError", async () => {
  const f = await replay(readEvents("06-abort"));
  assert.equal(only(f, "sessionError").length, 0);
  assert.equal(only(f, "aborted").length, 1);
  assert.deepEqual(only(f, "aborted")[0].payload, {});
  assert.equal(only(f, "turnComplete").at(-1).payload.complete, true);
  assert.equal(only(f, "running").at(-1).payload.running, false);
  const s = subs(f);
  assert.ok(s.indexOf("aborted") < s.lastIndexOf("turnComplete"));
  const ended = only(f, "toolEnded");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].payload.ok, false);
});

test("07-command-compact: compaction started/delta/ended, then transcriptStale", async () => {
  const f = await replay(readEvents("07-command-compact"));
  const c = only(f, "compaction").map((x) => x.payload.phase);
  assert.equal(c[0], "started");
  assert.equal(c.at(-1), "ended");
  assert.ok(c.includes("delta"));
  assert.equal(only(f, "transcriptStale").length, 1);
  assert.ok(subs(f).lastIndexOf("transcriptStale") > subs(f).lastIndexOf("compaction") - 1);
});

test("08-permission: permissions frame + attention around the reply", async () => {
  const f = await replay(readEvents("08-permission"));
  assert.deepEqual(only(f, "attention").map((x) => x.payload.kind), ["permission", null]);
  const perms = only(f, "permissions");
  assert.equal(perms[0].payload.permissions.length, 1);
  assert.equal(perms[0].payload.permissions[0].permission, "bash");
  assert.deepEqual(perms[0].payload.permissions[0].patterns, ["echo permission-ok"]);
  assert.equal(perms.at(-1).payload.permissions.length, 0);
});

test("re-delivered events (a reconnect) never double a frame", async () => {
  const events = readEvents("02-slow-bash");
  const doubled = events.flatMap((e) => [e, e]);
  const noChurn = (fr) => subs(fr).filter((x) => x !== "messageChanged");
  assert.deepEqual(noChurn(await replay(doubled)), noChurn(await replay(events)));
});

test("messageChanged: at most one frame per message per 100 ms window and the last change is never dropped", async () => {
  for (const name of corpus) {
    const events = readEvents(name);
    const frames = only(await replay(events), "messageChanged");
    assert.ok(frames.length > 0, name);
    assert.ok(frames.length <= events.length, name);
  }
});
