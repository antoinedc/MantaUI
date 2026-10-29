// WS11 D11 review round — the run ledger's bounds and repairs, exercised directly (no interpreter): memory (output kept only
// for delegate calls, settled ledgers left out of snapshots and evicted), a canonical read that races a classification
// (nothing stalls), the seed of a ledger that began mid-turn, and generations that never go backwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunLedger, slimLedgerPart } from "./runLedger.mjs";
import { mapToolBlock } from "../shared/opencodeV2.mjs";

const tool = (id, msg, { name = "read", output = "", status = "completed" } = {}) =>
  mapToolBlock({ id, name, state: { status, input: { path: `/w/${id}.ts` }, content: output ? [{ type: "text", text: output }] : [] } }, { messageID: msg });
const asst = (id, ...parts) => ({ info: { id, role: "assistant" }, parts });
const user = (id, text = "go") => ({ info: { id, role: "user" }, parts: [{ id: `${id}:text:0`, type: "text", text }] });

function rig(opts = {}) {
  let clock = 1_000_000;
  const frames = [];
  const timers = [];
  const warnings = [];
  const ledger = createRunLedger({
    epoch: "E1",
    emit: (sid, payload) => frames.push({ sid, ...payload }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => (t.dead = true),
    warn: (m) => warnings.push(m),
    ...opts,
  });
  const flushMicrotasks = () => new Promise((r) => setImmediate(r));
  const advance = async (ms) => {
    const until = clock + ms;
    await flushMicrotasks();
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      clock = due.at;
      due.fn();
      await flushMicrotasks();
    }
    clock = until;
  };
  return { ledger, frames, warnings, advance, flushMicrotasks, setClock: (t) => (clock = t), get clock() { return clock; } };
}
const enqueueUser = (ledger, id) => {
  ledger.onEnqueued(id, { type: "user", id, payload: { text: "go" } });
  ledger.onDelivered("s1", id, id);
};

test("S1 — a non-delegate part keeps no output (or metadata); a delegate part keeps what its job-name rule reads", () => {
  const plain = tool("T", "a1", { output: "x".repeat(5000) });
  plain.state.metadata = { output: "x".repeat(5000), huge: "y".repeat(5000) };
  const slim = slimLedgerPart(plain);
  assert.equal(slim.state.output, undefined);
  assert.equal(slim.state.metadata, undefined);
  assert.deepEqual(slim.state.input, plain.state.input);
  const job = tool("D", "a1", { name: "delegate", output: 'started job "nightly-sync" (id ab12)' });
  assert.equal(slimLedgerPart(job).state.output, 'started job "nightly-sync" (id ab12)');
  const { ledger } = rig();
  enqueueUser(ledger, "u1");
  ledger.onTool("s1", plain);
  ledger.onTool("s1", job);
  const parts = ledger._state("s1").walker.runs.get("T").parts;
  assert.equal(parts[0].state.output, undefined);
  assert.match(parts[1].state.output, /nightly-sync/);
  assert.match(ledger.snapshotFrames()[0].payload.runs[0].label, /background job|tools?/i);
});

test("S1 — a finished turn is left out of the connect snapshot, then evicted after the grace; a running turn stays", async () => {
  const { ledger, setClock, clock } = rig({ graceMs: 600_000 });
  enqueueUser(ledger, "u1");
  ledger.onTool("s1", tool("A", "a1"));
  assert.equal(ledger.snapshotFrames().length, 1, "a turn in flight is in the snapshot");
  ledger.onTurnComplete("s1", true);
  assert.deepEqual(ledger.snapshotFrames(), [], "a finished turn is not");
  assert.ok(ledger._state("s1"), "…but still there for late splices");
  assert.equal(ledger.ledgerFor("s1").runView("A").id, "A");
  setClock(clock + 599_000);
  ledger.snapshotFrames();
  assert.ok(ledger._state("s1"), "inside the grace");
  setClock(clock + 601_000);
  ledger.snapshotFrames();
  assert.equal(ledger._state("s1"), undefined, "evicted after the grace");
  // a late event on a settled ledger un-settles it
  enqueueUser(ledger, "u2");
  ledger.onTool("s1", tool("B", "a2"));
  ledger.onTurnComplete("s1", true);
  ledger.onTool("s1", tool("C", "a3", { status: "running" }));
  assert.equal(ledger.snapshotFrames().length, 1, "a new event after the end makes the ledger live again");
});

test("S1 — beyond the cap settled ledgers go oldest-first; a ledger still running is never evicted", () => {
  const { ledger, setClock, clock } = rig({ maxSessions: 2, graceMs: 10 ** 9 });
  const run = (sid, at, done) => {
    setClock(at);
    ledger.onEnqueued(`u-${sid}`, { type: "user", id: `u-${sid}`, payload: { text: "go" } });
    ledger.onDelivered(sid, `u-${sid}`, `u-${sid}`);
    ledger.onTool(sid, tool(`T-${sid}`, `a-${sid}`));
    if (done) ledger.onTurnComplete(sid, true);
  };
  run("old", clock + 1, true);
  run("mid", clock + 2, true);
  run("busy", clock + 3, false);
  run("new", clock + 4, true); // creating the 4th session sweeps: 4 > 2 → the OLDEST settled go
  assert.equal(ledger._state("old"), undefined);
  assert.ok(ledger._state("busy"), "an unsettled ledger is never evicted");
  assert.ok(ledger._state("new"));
});

test("a rebuilt session's gen never goes back below what clients saw, even after the ledger was evicted", async () => {
  const canonical = [user("u1"), asst("a1", tool("A", "a1")), asst("a2", tool("B", "a2"))];
  let late;
  const { ledger, advance, setClock, clock } = rig({ classifyDelivered: () => new Promise((r) => (late = r)), rebuildFromCanonical: async () => canonical, graceMs: 1000 });
  enqueueUser(ledger, "u1");
  ledger.onTool("s1", tool("A", "a1"));
  ledger.onDelivered("s1", "u2", "u2"); // unknown class
  ledger.onTool("s1", tool("B", "a2"));
  await advance(3100); // provisional guess
  ledger.onTurnComplete("s1", true);
  await advance(10);
  assert.equal(ledger.ledgerFor("s1").gen, 2, "repaired: gen 2");
  setClock(clock + 5000);
  ledger.snapshotFrames();
  assert.equal(ledger._state("s1"), undefined, "evicted");
  assert.equal(ledger.ledgerFor("s1").gen, 2, "a bare stamp after eviction keeps gen 2 (a client's minGen is 2)");
  ledger.onTool("s1", tool("C", "a3", { status: "running" }));
  assert.equal(ledger._state("s1").gen, 2, "a new ledger starts at the floor");
  void late;
});

// ---- S2: a canonical read and a classification that overlap ----

test("S2 — a rebuild requested while a delivery is still being classified WAITS for it: the lookup result is applied, nothing is lost or stalled", async () => {
  const canonical = [user("u1"), asst("a1", tool("A", "a1")), asst("a2", tool("B", "a2"))];
  const lookups = [];
  const { ledger, frames, advance, warnings } = rig({
    classifyDelivered: ({ messageID }) => new Promise((r) => lookups.push({ messageID, r })),
    rebuildFromCanonical: async () => canonical,
  });
  enqueueUser(ledger, "u1");
  ledger.onTool("s1", tool("A", "a1"));
  ledger.onDelivered("s1", "d1", "d1"); // unknown → pending
  ledger.onTool("s1", tool("B", "a2"));
  await advance(3100); // d1 times out → provisional
  assert.ok(ledger._state("s1").provisional);
  ledger.onDelivered("s1", "d2", "d2"); // a second unknown delivery, still pending…
  ledger.onTool("s1", tool("C", "a3"));
  ledger.onTurnComplete("s1", true); // …when the execution ends and wants a rebuild
  assert.ok(ledger._state("s1").pending, "the classification is still pending");
  assert.equal(frames.some((f) => f.rebuilt), false, "no rebuild started under it");
  lookups.find((l) => l.messageID === "d2").r({ cls: "draws", user: false });
  await advance(10);
  const st = ledger._state("s1");
  assert.equal(st.pending, null);
  assert.equal(st.hold, null);
  assert.ok(frames.some((f) => f.rebuilt), "the rebuild ran once the classification settled");
  assert.equal(warnings.filter((w) => /buffer cap/.test(w)).length, 0);
  // the ledger is live: a later tool is applied and framed (it was not frozen behind a lost classification)
  const before = frames.length;
  ledger.onTool("s1", tool("D", "a4", { status: "running" }));
  await advance(150); // the coalescing window
  assert.ok(frames.length > before);
  assert.ok(ledger.ledgerFor("s1").runOfPart("D"), "tool D is placed");
});

test("S2 — a delivery that arrives DURING a rebuild read is buffered, then classified after it; its timeout settles normally", async () => {
  const canonical = [user("u1"), asst("a1", tool("A", "a1"))];
  let readDone;
  const { ledger, frames, advance } = rig({
    classifyDelivered: () => new Promise(() => {}),
    rebuildFromCanonical: () => new Promise((r) => (readDone = r)),
  });
  enqueueUser(ledger, "u1");
  ledger.onTool("s1", tool("A", "a1"));
  ledger.onDelivered("s1", "d1", "d1");
  await advance(3100);
  ledger.onTurnComplete("s1", true); // rebuild starts: the read is open
  assert.ok(ledger._state("s1").hold);
  ledger.onDelivered("s1", "d2", "d2"); // buffered behind the read
  ledger.onTool("s1", tool("B", "a2"));
  readDone(canonical);
  await advance(10);
  assert.equal(ledger._state("s1").hold, null);
  assert.ok(ledger._state("s1").pending, "d2 is now being classified");
  await advance(3100);
  assert.equal(ledger._state("s1").pending, null, "…and its timeout settled it");
  assert.ok(ledger.ledgerFor("s1").runOfPart("B"));
  assert.ok(frames.some((f) => f.rebuilt));
});

test("a canonical read that never answers is abandoned after a timeout: events replay, the ledger carries on", async () => {
  const { ledger, advance, warnings } = rig({ rebuildFromCanonical: () => new Promise(() => {}), rebuildTimeoutMs: 5000 });
  ledger.onTool("s1", tool("A", "a1", { status: "running" })); // first event of a ledger with no user turn → seed read
  assert.ok(ledger._state("s1").hold);
  ledger.onTool("s1", tool("B", "a2", { status: "running" }));
  await advance(5100);
  assert.equal(ledger._state("s1").hold, null);
  assert.ok(warnings.some((w) => /did not answer/.test(w)));
  assert.deepEqual([...ledger._state("s1").walker.runs.keys()], ["A"]);
  assert.equal(ledger._state("s1").walker.runs.get("A").parts.length, 2, "both buffered parts were applied");
});

test("a failed rebuild read keeps the provisional mark so a later trigger retries", async () => {
  let n = 0;
  const canonical = [user("u1"), asst("a1", tool("A", "a1"), tool("B", "a2"))];
  const { ledger, advance } = rig({
    classifyDelivered: () => new Promise(() => {}),
    rebuildFromCanonical: async () => {
      if (++n === 1) throw new Error("down");
      return canonical;
    },
  });
  enqueueUser(ledger, "u1");
  ledger.onTool("s1", tool("A", "a1"));
  ledger.onDelivered("s1", "d1", "d1");
  ledger.onTool("s1", tool("B", "a2"));
  await advance(3100);
  ledger.onTurnComplete("s1", true);
  await advance(10);
  assert.ok(ledger._state("s1").provisional, "still marked");
  ledger.onReconnect("s1");
  await advance(10);
  assert.equal(ledger._state("s1").provisional, null);
  assert.equal(n, 2);
});

// ---- NIT: a ledger that begins mid-turn is seeded from history ----

test("a ledger created by a run event (manta-server restarted mid-turn) is SEEDED from canonical history: the run keeps its TRUE id", async () => {
  const canonical = [user("u1"), asst("a1", tool("A", "a1")), asst("a2", tool("B", "a2", { status: "running" }))];
  let reads = 0;
  const { ledger, frames, advance } = rig({ rebuildFromCanonical: async () => (reads++, canonical) });
  // the first post-restart event is tool C of the SAME run that began at A
  ledger.onTool("s1", tool("C", "a3", { status: "running" }));
  assert.equal(frames.length, 0, "buffered behind the read");
  await advance(10);
  assert.equal(reads, 1);
  assert.deepEqual([...ledger._state("s1").walker.runs.keys()], ["A"], "ONE run, id A (the canonical id), not C");
  assert.equal(ledger._state("s1").walker.runs.get("A").parts.length, 3);
  assert.equal(ledger._state("s1").gen, 1, "a seed is not a repair: no gen bump");
  const last = frames[frames.length - 1];
  assert.equal(last.full, true);
  assert.equal(last.rebuilt, undefined);
  assert.deepEqual(last.runs.map((r) => r.id), ["A"]);
  // a turn that begins in this process is not seeded
  enqueueUserOn(ledger, "s2");
  ledger.onTool("s2", tool("X", "ax"));
  await advance(10);
  assert.equal(reads, 1, "no read for a turn that began with a drawing user message here");
});
const enqueueUserOn = (ledger, sid) => {
  ledger.onEnqueued(`u-${sid}`, { type: "user", id: `u-${sid}`, payload: { text: "go" } });
  ledger.onDelivered(sid, `u-${sid}`, `u-${sid}`);
};

// ---- final review S-A / S-B ----

test("S-A — after an eviction a continued run's revisions stay ABOVE what clients already hold (seq floor beside the gen floor)", async () => {
  const canonical = [user("u1"), asst("a1", tool("A", "a1"), tool("B", "a1")), asst("a2", tool("C", "a2", { status: "running" }))];
  const { ledger, frames, advance, setClock, clock } = rig({ rebuildFromCanonical: async () => canonical, graceMs: 1000 });
  enqueueUser(ledger, "u1");
  for (let i = 0; i < 8; i++) ledger.onTool("s1", tool("A", "a1", { status: i % 2 ? "completed" : "running" })); // the run's seq climbs
  ledger.onTool("s1", tool("B", "a1"));
  await advance(200);
  const held = frames[frames.length - 1].runs.find((r) => r.id === "A").rev.seq;
  assert.ok(held >= 8, `clients hold seq ${held}`);
  ledger.onTurnComplete("s1", true);
  setClock(clock + 5000);
  ledger.snapshotFrames();
  assert.equal(ledger._state("s1"), undefined, "evicted");
  // a background-job completion continues the same run in a fresh ledger (seeded from history)
  ledger.onTool("s1", tool("C", "a2", { status: "running" }));
  await advance(300);
  const run = ledger._state("s1").walker.runs.get("A");
  assert.ok(run, "the seed kept the run's true id");
  assert.ok(run.seq > held, `the continued run's seq ${run.seq} is above the held ${held}`);
  const last = frames.filter((f) => f.runs?.some((r) => r.id === "A")).pop();
  assert.ok(last.runs.find((r) => r.id === "A").rev.seq > held, "…and so is the emitted revision");
});

test("S-B — a turn that ends while a seed read is in flight still settles after the replay: evictable and out of the snapshot", async () => {
  let readDone;
  const { ledger, advance, setClock, clock } = rig({ rebuildFromCanonical: () => new Promise((r) => (readDone = r)), graceMs: 1000 });
  ledger.onTool("s1", tool("A", "a1", { status: "running" })); // a fresh ledger's first run event → seed hold
  assert.ok(ledger._state("s1").hold);
  ledger.onTurnComplete("s1", true); // the turn ended during the read
  readDone([user("u1"), asst("a1", tool("A", "a1"))]);
  await advance(10);
  assert.equal(ledger._state("s1").hold, null);
  assert.deepEqual(ledger.snapshotFrames(), [], "a finished turn is excluded from the connect snapshot");
  setClock(clock + 5000);
  ledger.snapshotFrames();
  assert.equal(ledger._state("s1"), undefined, "…and evicted after the grace");
});

test("S-B — a turn that ends while a classification is pending still settles once the buffered events replay", async () => {
  let late;
  const { ledger, advance, setClock, clock } = rig({ classifyDelivered: () => new Promise((r) => (late = r)), graceMs: 1000 });
  enqueueUser(ledger, "u1");
  ledger.onTool("s1", tool("A", "a1"));
  ledger.onDelivered("s1", "u2", "u2");
  ledger.onTool("s1", tool("B", "a2")); // buffered behind the classification
  ledger.onTurnComplete("s1", true);
  late("draws");
  await advance(10);
  assert.equal(ledger._state("s1").pending, null);
  assert.ok(ledger.ledgerFor("s1").runOfPart("B"), "the buffered event was applied");
  assert.deepEqual(ledger.snapshotFrames(), []);
  setClock(clock + 5000);
  ledger.snapshotFrames();
  assert.equal(ledger._state("s1"), undefined);
});
