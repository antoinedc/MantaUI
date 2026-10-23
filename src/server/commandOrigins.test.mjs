import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_WINDOW_CLOSE_MS,
  ORIGIN_MAX_AGE_MS,
  ORIGIN_MAX_ENTRIES,
  PROMPT_ID_RETIRE_MS,
  createCommandCorrelator,
  createOriginStore,
  mintPromptId,
  stampCommandOrigins,
} from "./commandOrigins.mjs";

// ---- harness: a manual clock + a timer queue driven by it ----------------------

function harness(over = {}) {
  let t = 1_000_000;
  const timers = [];
  const tags = [];
  const logs = [];
  const origins = createOriginStore({ now: () => t });
  const c = createCommandCorrelator({
    origins,
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    log: (...a) => logs.push(a.join(" ")),
    onTag: (x) => tags.push(x),
    ...over,
  });
  const advance = (ms) => {
    t += ms;
    for (const h of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(h), 1);
      h.fn();
    }
  };
  return { c, origins, tags, logs, advance, now: () => t };
}
const SID = "ses_a";
const open = (c, name = "review", args = "HEAD~1") => c.openWindow(SID, { name, arguments: args });

// ---- the durable origin store ---------------------------------------------------

test("mintPromptId makes a V2-valid message id", () => {
  assert.match(mintPromptId(), /^msg_./);
  assert.notEqual(mintPromptId(), mintPromptId());
});

const tick = () => new Promise((r) => setImmediate(r));

test("origin store: record/get, persists (coalesced), loads what was persisted", async () => {
  let saved = null;
  const a = createOriginStore({ save: (o) => (saved = o), now: () => 10 });
  a.record("msg_1", { name: "review", arguments: "x", sessionId: SID });
  assert.deepEqual(a.get("msg_1"), { name: "review", arguments: "x" });
  assert.equal(a.get("msg_none"), null);
  await tick();
  assert.deepEqual(saved, { msg_1: { name: "review", arguments: "x", sessionId: SID, at: 10 } });
  const b = createOriginStore({ load: () => saved });
  assert.deepEqual(b.get("msg_1"), { name: "review", arguments: "x" });
});

test("origin store: ignores a corrupt file and survives a failing save", async () => {
  const logs = [];
  const a = createOriginStore({ load: () => ({ bad: 7, ok: { name: "n", arguments: "", sessionId: "s", at: 1 } }), save: () => { throw new Error("disk"); }, log: (...x) => logs.push(x.join(" ")) });
  assert.equal(a.size(), 1);
  a.record("msg_2", { name: "n", arguments: "", sessionId: "s" });
  await tick();
  assert.match(logs.join("\n"), /save failed: disk/);
  assert.equal(createOriginStore({ load: () => { throw new Error("x"); } }).size(), 0);
});

test("origin store: capped at 5,000 entries (oldest out) and 90 days", () => {
  let t = 1_000;
  const s = createOriginStore({ now: () => t });
  for (let i = 0; i < ORIGIN_MAX_ENTRIES + 5; i++) {
    t += 1;
    s.record(`msg_${i}`, { name: "n", arguments: "", sessionId: "s" });
  }
  assert.equal(s.size(), ORIGIN_MAX_ENTRIES);
  assert.equal(s.get("msg_0"), null, "the oldest were evicted");
  assert.ok(s.get(`msg_${ORIGIN_MAX_ENTRIES + 4}`));
  t += ORIGIN_MAX_AGE_MS + 1;
  s.record("msg_new", { name: "n", arguments: "", sessionId: "s" });
  assert.equal(s.size(), 1, "everything older than 90 days is gone");
});

test("stampCommandOrigins stamps only recorded USER messages, without mutating", () => {
  const msgs = [
    { info: { id: "msg_u", role: "user" }, parts: [] },
    { info: { id: "msg_a", role: "assistant" }, parts: [] },
    { info: { id: "msg_v", role: "user" }, parts: [] },
  ];
  const originOf = (id) => (id === "msg_u" || id === "msg_a" ? { name: "init", arguments: "z" } : null);
  const out = stampCommandOrigins(msgs, originOf);
  assert.deepEqual(out[0].info.command, { name: "init", arguments: "z" });
  assert.equal(out[1].info.command, undefined, "an assistant message is never a command origin");
  assert.equal(out[2], msgs[2]);
  assert.equal(msgs[0].info.command, undefined, "the input is untouched");
  assert.equal(stampCommandOrigins(msgs, () => null), msgs, "nothing recorded → the same array");
});

// ---- the correlator -------------------------------------------------------------

test("a lone command with exactly one unexplained user enqueue is tagged (after the window closes)", () => {
  const h = harness();
  const w = open(h.c);
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  w.finish({ ok: true });
  assert.equal(h.tags.length, 0, "not before the window closes");
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.deepEqual(h.tags, [{ sessionId: SID, messageID: "msg_cmd", name: "review", arguments: "HEAD~1" }]);
  assert.deepEqual(h.origins.get("msg_cmd"), { name: "review", arguments: "HEAD~1" });
});

test("an enqueue arriving after the POST returned but inside the 3 s still tags", () => {
  const h = harness();
  const w = open(h.c);
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS - 1);
  h.c.observeEnqueued(SID, "msg_late", "user");
  h.advance(1);
  assert.equal(h.tags[0]?.messageID, "msg_late");
});

test("an enqueue after the window closed is NOT tagged, and the session pauses until idle", () => {
  const h = harness();
  const w = open(h.c);
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0, "zero unexplained at close → nothing recorded");
  h.c.observeEnqueued(SID, "msg_too_late", "user");
  assert.equal(h.origins.get("msg_too_late"), null);
  assert.equal(h.c._session(SID).ineligible, true);
  h.c.noteIdle(SID);
  assert.equal(h.c._session(SID).ineligible, false);
});

test("only user items count: synthetic / compaction enqueues are ignored", () => {
  const h = harness();
  const w = open(h.c);
  h.c.observeEnqueued(SID, "msg_syn", "synthetic");
  h.c.observeEnqueued(SID, "msg_cmp", "compaction");
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags[0]?.messageID, "msg_cmd");
});

test("concurrent prompt + command: our own prompt enqueue in the window is excluded, only the command is tagged", () => {
  const h = harness();
  const w = open(h.c);
  h.c.registerPromptId(SID, "msg_prompt"); // a plain prompt sent during the window
  h.c.observeEnqueued(SID, "msg_prompt", "user");
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.deepEqual(h.tags.map((t) => t.messageID), ["msg_cmd"]);
  assert.equal(h.origins.get("msg_prompt"), null);
  assert.equal(h.c.isOurPromptId(SID, "msg_prompt"), false, "retired once its enqueue was observed");
});

test("a foreign enqueue in the window makes it ambiguous: nothing is tagged", () => {
  const h = harness();
  const w = open(h.c);
  h.c.observeEnqueued(SID, "msg_foreign", "user");
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0);
  assert.match(h.logs.join("\n"), /2 unexplained/);
});

test("overlapping command windows on one session: both stay untagged", () => {
  const h = harness();
  const a = open(h.c, "review");
  const b = open(h.c, "init", "");
  h.c.observeEnqueued(SID, "msg_1", "user");
  a.finish({ ok: true });
  b.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0);
  assert.equal(h.c._session(SID).ineligible, true);
});

test("windows on different sessions never interfere", () => {
  const h = harness();
  const a = h.c.openWindow("ses_a", { name: "a", arguments: "" });
  const b = h.c.openWindow("ses_b", { name: "b", arguments: "" });
  h.c.observeEnqueued("ses_a", "msg_a", "user");
  h.c.observeEnqueued("ses_b", "msg_b", "user");
  a.finish({ ok: true });
  b.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.deepEqual(h.tags.map((t) => `${t.sessionId}:${t.messageID}`).sort(), ["ses_a:msg_a", "ses_b:msg_b"]);
});

test("a failed POST records nothing; a 4xx leaves the session eligible, anything else pauses it", () => {
  const h = harness();
  let w = open(h.c);
  h.c.observeEnqueued(SID, "msg_x", "user");
  w.finish({ ok: false, status: 404 });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0);
  assert.equal(h.c._session(SID).ineligible, false, "a definitive refusal enqueued nothing");

  w = open(h.c);
  w.finish({ ok: false }); // transport failure: the server may have accepted it
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.c._session(SID).ineligible, true);
});

test("a stream disconnect during the window leaves it untagged and pauses the session", () => {
  const h = harness();
  const w = open(h.c);
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  h.c.noteDisconnect();
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0);
  assert.equal(h.c._session(SID).ineligible, true);
  assert.match(h.logs.join("\n"), /disconnected/);
});

test("a delayed enqueue from command A landing in command B's window leaves B untagged", () => {
  const h = harness();
  const a = open(h.c, "a");
  a.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS); // A closed with zero unexplained
  const b = open(h.c, "b");
  h.c.observeEnqueued(SID, "msg_A_late", "user");
  h.c.observeEnqueued(SID, "msg_B", "user");
  b.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0, "B is not eligible while A is unresolved");
  assert.match(h.logs.join("\n"), /earlier submission is unresolved/);
});

test("after the session goes idle an earlier zero-result command no longer blocks the next one", () => {
  const h = harness();
  const a = open(h.c, "a");
  a.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  h.c.noteIdle(SID);
  const b = open(h.c, "b", "args");
  h.c.observeEnqueued(SID, "msg_B", "user");
  b.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.deepEqual(h.tags.map((t) => t.messageID), ["msg_B"]);
});

test("a prompt whose enqueue is still unobserved when a command starts leaves the command untagged", () => {
  const h = harness();
  h.c.registerPromptId(SID, "msg_P");
  const w = open(h.c);
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  h.c.observeEnqueued(SID, "msg_P", "user");
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0);
});

test("a prompt id retired at 10 minutes pauses the session until idle", () => {
  const h = harness();
  h.c.registerPromptId(SID, "msg_stuck");
  h.advance(PROMPT_ID_RETIRE_MS + 1);
  let w = open(h.c); // opening a window expires stale ids
  assert.equal(h.c.isOurPromptId(SID, "msg_stuck"), false);
  assert.match(h.logs.join("\n"), /never enqueued/);
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 0, "ineligible until the session next goes idle");

  h.c.noteIdle(SID);
  w = open(h.c, "again");
  h.c.observeEnqueued(SID, "msg_cmd2", "user");
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.deepEqual(h.tags.map((t) => t.messageID), ["msg_cmd2"]);
});

test("a prompt id is retired by its enqueue (and a refused POST removes it); no time expiry before 10 minutes", () => {
  const h = harness();
  h.c.registerPromptId(SID, "msg_1");
  h.c.registerPromptId(SID, "msg_2");
  h.c.unregisterPromptId(SID, "msg_2");
  h.advance(PROMPT_ID_RETIRE_MS - 1000);
  assert.equal(h.c.isOurPromptId(SID, "msg_1"), true);
  assert.equal(h.c.isOurPromptId(SID, "msg_2"), false);
  h.c.observeEnqueued(SID, "msg_1", "user");
  assert.equal(h.c.isOurPromptId(SID, "msg_1"), false);
});

test("onTag throwing does not lose the record", () => {
  const h = harness({ onTag: () => { throw new Error("bus down"); } });
  const w = open(h.c);
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  w.finish({ ok: true });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.deepEqual(h.origins.get("msg_cmd"), { name: "review", arguments: "HEAD~1" });
});

test("finish() is idempotent and forgetSession drops pending windows", () => {
  const h = harness();
  const w = open(h.c);
  h.c.observeEnqueued(SID, "msg_cmd", "user");
  w.finish({ ok: true });
  w.finish({ ok: false });
  h.advance(COMMAND_WINDOW_CLOSE_MS);
  assert.equal(h.tags.length, 1);
  const w2 = open(h.c);
  w2.finish({ ok: true });
  h.c.forgetSession(SID);
  assert.equal(h.c._session(SID), undefined);
});

// ---- the closed set of /prompt writers -------------------------------------------

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "fixtures" || name === "node_modules") continue;
      yield* walk(p);
    } else if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) yield p;
  }
}

test("every manta-server `/prompt` POST goes through the recording helper (postPrompt)", () => {
  // upgradeV2.mjs's verify turn talks to a separate V2 instance before cutover
  // (upgrade mode) — it never reaches this box's pump, so it is exempt.
  const EXEMPT = new Set(["upgradeV2.mjs"]);
  const hits = [];
  for (const file of walk(SERVER_DIR)) {
    const rel = relative(SERVER_DIR, file);
    if (EXEMPT.has(rel)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (/\/prompt(?![A-Za-z./_-])/.test(code) && /session|apiUrl|v2Fetch|fetch/.test(code)) hits.push(`${rel}:${i + 1}: ${code}`);
    });
  }
  assert.equal(hits.length, 1, `unexpected /prompt call sites:\n${hits.join("\n")}`);
  assert.match(hits[0], /^opencode\.mjs:\d+:/);
  const src = readFileSync(join(SERVER_DIR, "opencode.mjs"), "utf8");
  const helperStart = src.indexOf("async function postPrompt(");
  const helperEnd = src.indexOf("\n}\n", helperStart);
  const at = src.indexOf(hits[0].split(": ")[1]);
  assert.ok(helperStart > 0 && at > helperStart && at < helperEnd, "the one /prompt POST lives inside postPrompt");
  assert.match(src.slice(helperStart, helperEnd), /registerPromptId\(/);
});

// ---------------------------------------------------------------------------
// Stage B: the window hooks background-command adoption needs
// ---------------------------------------------------------------------------

test("openWindows lists the windows open for a session (name + arguments), and closes with the window", () => {
  const timers = [];
  const closed = [];
  const c = createCommandCorrelator({
    origins: createOriginStore(),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    onWindowClosed: (w) => closed.push(w),
  });
  assert.deepEqual(c.openWindows("s1"), []);
  const a = c.openWindow("s1", { name: "review", arguments: "HEAD~1" });
  const b = c.openWindow("s1", { name: "init", arguments: "" });
  assert.deepEqual(c.openWindows("s1"), [{ name: "review", arguments: "HEAD~1" }, { name: "init", arguments: "" }]);
  assert.deepEqual(c.openWindows("s2"), [], "scoped per session");
  a.finish({ ok: true });
  assert.equal(c.openWindows("s1").length, 2, "still open until the close timer fires");
  timers[0]();
  assert.deepEqual(c.openWindows("s1"), [{ name: "init", arguments: "" }]);
  assert.deepEqual(closed, [{ sessionId: "s1", name: "review", arguments: "HEAD~1" }]);
  b.finish({ ok: false, status: 500 });
  timers[1]();
  assert.deepEqual(c.openWindows("s1"), []);
  assert.equal(closed.length, 2, "a failed POST's window announces its close too");
});

test("onWindowClosed fires once per window, and a throwing hook never breaks the close", () => {
  const timers = [];
  let calls = 0;
  const c = createCommandCorrelator({
    origins: createOriginStore(),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    onWindowClosed: () => { calls += 1; throw new Error("hook bug"); },
    log: () => {},
  });
  const w = c.openWindow("s1", { name: "x" });
  w.finish({ ok: true });
  timers[0]();
  timers[0]();
  assert.equal(calls, 1);
  assert.deepEqual(c.openWindows("s1"), []);
});

test("a forgotten session announces nothing and has no open windows", () => {
  const timers = [];
  let closed = 0;
  const c = createCommandCorrelator({ origins: createOriginStore(), setTimer: (fn) => { timers.push(fn); return 1; }, clearTimer: () => {}, onWindowClosed: () => { closed += 1; } });
  c.openWindow("s1", { name: "x" }).finish({ ok: true });
  c.forgetSession("s1");
  timers[0]?.();
  assert.equal(closed, 0);
  assert.deepEqual(c.openWindows("s1"), []);
});
