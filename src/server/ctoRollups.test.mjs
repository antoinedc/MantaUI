import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRollupRunner,
  selectReduceInputs,
  collectRefs,
  validateRollup,
  parseRollupText,
  buildReduceContext,
  degradedRollup,
  windowFor,
  windowId,
  previousWindow,
  proposalsFromRollup,
  submitFactsFromRollup,
  reconstructHour,
  defaultLoadInputs,
  startOfHour,
  HOUR_MS,
  DAY_MS,
  WEEK_MS,
  ROLLUP_VERSION,
} from "./ctoRollups.mjs";

// In-memory rollups store shaped like rollupsStore {load, save}. A written
// rollup always carries a `bullets` array; the default write-once detector
// keys off that, mirroring the real store.
function makeRollupsStore() {
  const map = new Map();
  return {
    map,
    load: async (level, id) => map.get(`${level}/${id}`) ?? { v: 1 },
    save: async (level, id, data) => {
      map.set(`${level}/${id}`, data);
    },
  };
}

function fakeExists(store) {
  return async ({ level, id } = {}) => {
    const p = store.map.get(`${level}/${id}`);
    return !!(p && typeof p === "object" && "bullets" in p);
  };
}

// A runEphemeral + loadInputs harness that records reduce calls and returns
// controllable model output. `inputs` may be a function of ({level, window}).
function makeRunner({ inputs = [], modelText = null, preceding = null, presence = () => false } = {}) {
  const store = makeRollupsStore();
  const calls = [];
  const runner = createRollupRunner({
    runEphemeral: async (data) => {
      calls.push({ fn: "runEphemeral", data });
      return modelText ? { ok: true, text: modelText } : { ok: false, gated: true };
    },
    rollups: store,
    loadInputs: async ({ level, window }) =>
      typeof inputs === "function" ? inputs({ level, window }) : inputs,
    loadPreceding: async ({ level, window }) => preceding,
    exists: fakeExists(store),
    presenceCheck: presence,
  });
  return { runner, store, calls };
}

// A valid day/second-hour-window timestamp basis (start of a local day).
function baseDay() {
  return windowFor("day", Date.UTC(2026, 0, 15, 12, 0, 0))[0];
}

function seg(id, start, extra = {}) {
  return { id, window: [start, start + 1], summary: { one_liner: `work in ${id}`, ...extra } };
}

function hourRollup(id, start, bullets) {
  return { id, window: [start, start + HOUR_MS], bullets };
}

// ---------------------------------------------------------------------------
// Window math + input selection
// ---------------------------------------------------------------------------

test("windowFor partitions the day into contiguous hour windows", () => {
  const d = Date.UTC(2026, 0, 15, 12, 30, 0);
  const w = windowFor("hour", d);
  assert.equal(w[1] - w[0], HOUR_MS);
  assert.equal(new Date(w[0]).getUTCMinutes(), 0);
  const day = windowFor("day", d);
  assert.equal(day[1] - day[0], DAY_MS);
  assert.equal(new Date(day[0]).getUTCHours(), 0);
  const week = windowFor("week", d);
  assert.equal(week[1] - week[0], WEEK_MS);
  // Jan 15 2026 is a Thursday → Monday is Jan 12.
  assert.equal(new Date(week[0]).getUTCDay(), 1);
  assert.equal(windowId(w), String(w[0]));
});

test("previousWindow returns the same-level window immediately before", () => {
  const d = Date.UTC(2026, 0, 15, 12, 30, 0);
  const w = windowFor("hour", d);
  const prev = previousWindow(w, "hour");
  assert.equal(prev[1], w[0]);
  assert.equal(prev[1] - prev[0], HOUR_MS);
});

test("selectReduceInputs assigns items to the window containing their start (hour)", () => {
  const d = baseDay();
  const w0 = windowFor("hour", d);
  const w1 = windowFor("hour", d + HOUR_MS);
  const items = [seg("a", w0[0] + 10000), seg("b", w1[0] + 10000), seg("c", w0[0] + 20000)];
  const in0 = selectReduceInputs("hour", w0, items);
  assert.deepEqual(in0.map((i) => i.id).sort(), ["a", "c"]);
  const in1 = selectReduceInputs("hour", w1, items);
  assert.deepEqual(in1.map((i) => i.id), ["b"]);
});

test("selectReduceInputs reads only the level below per level (day/week too)", () => {
  const d = baseDay();
  const day = windowFor("day", d);
  const day1 = windowFor("day", d + DAY_MS);
  const hours = [hourRollup("h1", day[0], []), hourRollup("h2", day1[0], [])];
  assert.deepEqual(selectReduceInputs("day", day, hours).map((i) => i.id), ["h1"]);
  const week = windowFor("week", d);
  const week1 = windowFor("week", d + WEEK_MS);
  const days = [hourRollup("d1", week[0], []), hourRollup("d2", week1[0], [])];
  assert.deepEqual(selectReduceInputs("week", week, days).map((i) => i.id), ["d1"]);
});

test("selectReduceInputs sorts by window start", () => {
  const d = baseDay();
  const w0 = windowFor("hour", d);
  const items = [seg("late", w0[0] + 50000), seg("early", w0[0] + 100), seg("mid", w0[0] + 20000)];
  assert.deepEqual(selectReduceInputs("hour", w0, items).map((i) => i.id), ["early", "mid", "late"]);
});

// ---------------------------------------------------------------------------
// Ref propagation
// ---------------------------------------------------------------------------

test("hour refs are leaf segment ids; day/week refs union the level-below bullet refs", () => {
  const d = baseDay();
  const h = windowFor("hour", d);
  const segs = [seg("s1", h[0]), seg("s2", h[0] + 1000)];
  assert.deepEqual(collectRefs("hour", segs), ["s1", "s2"]);
  const dayInputs = [
    { id: "hx", bullets: [{ text: "a", refs: ["s1"] }, { text: "b", refs: ["s1", "s2"] }] },
    { id: "hy", bullets: [{ text: "c", refs: ["s3"] }] },
  ];
  assert.deepEqual(collectRefs("day", dayInputs), ["s1", "s2", "s3"]);
});

// ---------------------------------------------------------------------------
// Validation + parsing
// ---------------------------------------------------------------------------

test("validateRollup accepts a well-formed rollup and rejects malformed ones", () => {
  const d = baseDay();
  const w = windowFor("hour", d);
  const good = { v: ROLLUP_VERSION, level: "hour", window: w, bullets: [{ text: "did a thing", refs: ["s1"] }] };
  assert.equal(validateRollup(good), true);
  assert.equal(validateRollup({ ...good, v: 99 }), false);
  assert.equal(validateRollup({ ...good, level: "week" }), false); // wrong window span for week
  assert.equal(validateRollup({ ...good, window: [w[0], w[0] + 5000] }), false);
  assert.equal(validateRollup({ ...good, bullets: [{ text: "" }] }), false);
  assert.equal(validateRollup({ ...good, bullets: [{ text: "x", refs: ["ok", 5] }] }), false);
});

test("parseRollupText extracts JSON from wrapped prose", () => {
  const out = parseRollupText('Here you go:\n{"bullets":[{"text":"a","refs":["s1"]}]}\nthanks');
  assert.deepEqual(out, { bullets: [{ text: "a", refs: ["s1"] }] });
  assert.equal(parseRollupText("no json here"), null);
});

// ---------------------------------------------------------------------------
// Running-context threading
// ---------------------------------------------------------------------------

test("reduce threads preceding same-level rollup into the running context", async () => {
  const d = baseDay();
  const w = windowFor("hour", d);
  const prev = { v: ROLLUP_VERSION, level: "hour", window: previousWindow(w, "hour"), bullets: [{ text: "PREVIOUS HOUR WORK", refs: ["s0"] }] };
  const { runner, calls } = makeRunner({
    inputs: [seg("s1", w[0])],
    preceding: prev,
    modelText: JSON.stringify({ bullets: [{ text: "NEW HOUR WORK", refs: ["s1"] }] }),
  });
  const res = await runner.reduceWindow("hour", w);
  assert.equal(res.saved, true);
  const ctx = calls[0].data.context;
  const all = ctx.map((b) => b.text).join("\n");
  assert.match(all, /PREVIOUS HOUR WORK/); // running context present
  assert.match(all, /work in s1/); // level-below input present
  assert.match(all, /s1/); // ref pointer present
  assert.equal(ctx[0].priority, "high");
});

// ---------------------------------------------------------------------------
// Write-once
// ---------------------------------------------------------------------------

test("a reduce into an existing window throws (write-once)", async () => {
  const d = baseDay();
  const w = windowFor("hour", d);
  const { runner, store } = makeRunner({ inputs: [seg("s1", w[0])] });
  await runner.reduceWindow("hour", w);
  await assert.rejects(() => runner.reduceWindow("hour", w), /already exists/);
  assert.equal([...store.map.keys()].filter((k) => k.startsWith("hour/")).length, 1);
});

// ---------------------------------------------------------------------------
// Quiet-window no-op
// ---------------------------------------------------------------------------

test("a quiet window (zero inputs) writes NOTHING", async () => {
  const d = baseDay();
  const w = windowFor("hour", d);
  const { runner, store } = makeRunner({ inputs: [] });
  const res = await runner.reduceWindow("hour", w);
  assert.equal(res.skipped, true);
  assert.equal(store.map.size, 0);
  assert.equal([...store.map.keys()].length, 0);
});

// ---------------------------------------------------------------------------
// Degraded fallback
// ---------------------------------------------------------------------------

test("a gated/unavailable model persists a degraded rollup with correct refs", async () => {
  const d = baseDay();
  const w = windowFor("hour", d);
  const { runner, store } = makeRunner({ inputs: [seg("s1", w[0]), seg("s2", w[0] + 1000)] });
  const res = await runner.reduceWindow("hour", w);
  assert.equal(res.saved, true);
  const saved = store.map.get(`hour/${w[0]}`);
  assert.equal(validateRollup(saved), true);
  assert.deepEqual(saved.bullets.map((b) => b.refs), [["s1"], ["s2"]]);
});

test("day reduce from hour rollups: degraded keeps propagated leaf refs", async () => {
  const d = baseDay();
  const day = windowFor("day", d);
  const dayInputs = [
    { id: "h1", window: [day[0], day[0] + HOUR_MS], bullets: [{ text: "H1", refs: ["s1"] }, { text: "H2", refs: ["s2"] }] },
  ];
  const { runner, store } = makeRunner({ inputs: dayInputs });
  await runner.reduceWindow("day", day);
  const saved = store.map.get(`day/${day[0]}`);
  assert.deepEqual(saved.bullets.map((b) => b.refs), [["s1"], ["s2"]]);
  assert.deepEqual([...new Set(saved.bullets.flatMap((b) => b.refs))].sort(), ["s1", "s2"]);
});

test("reconstructHour folds a shed hour's segments into bullets with leaf refs", () => {
  const window = [startOfHour(Date.now()), startOfHour(Date.now()) + HOUR_MS];
  const recon = reconstructHour({
    window,
    segments: [
      { id: "s1", summary: { one_liner: "wired auth" } },
      { id: "s2", summary: { intent: "refactor" } },
      { id: "s3", summary: {} },
    ],
  });
  assert.equal(recon.id, String(window[0]));
  assert.deepEqual(recon.window, window);
  assert.deepEqual(recon.bullets, [
    { text: "wired auth", refs: ["s1"] },
    { text: "refactor", refs: ["s2"] },
    { text: "unspecified work", refs: ["s3"] },
  ]);
});

test("reconstructHour returns null when the hour has no segments", () => {
  assert.equal(reconstructHour({ window: [0, HOUR_MS], segments: [] }), null);
});

test("defaultLoadInputs day: reconstructs missing hours from segments (thrifty gap)", async () => {
  // A fake fs over a rollups/hour dir + a segments dir.
  const rollupFiles = ["hExisting.json"];
  const segFiles = ["s1.json", "s2.json", "s3.json"];
  const dayStart = new Date(2026, 7, 28, 0, 0, 0, 0).getTime();
  const h = (i) => dayStart + i * HOUR_MS; // hour i start
  const rollups = {
    dirFor: () => "rollups/hour",
    load: async (level, id) => {
      if (id === "hExisting")
        return { v: 1, level: "hour", window: [h(0), h(1)], bullets: [{ text: "H0", refs: ["s0"] }] };
      return { v: 1 };
    },
  };
  const segments = {
    dir: "segments",
    load: async (id) => {
      const map = {
        s1: { v: 1, window: [h(1), h(1) + HOUR_MS], ts: h(1), summary: { one_liner: "A" } },
        s2: { v: 1, window: [h(1), h(1) + HOUR_MS], ts: h(1) + 1, summary: { one_liner: "B" } },
        s3: { v: 1, window: [h(2), h(2) + HOUR_MS], ts: h(2), summary: { intent: "C" } },
      };
      return map[id] ?? { v: 1 };
    },
  };
  const fs = {
    readdir: async (dir) => (dir === "rollups/hour" ? rollupFiles : dir === "segments" ? segFiles : []),
  };
  const loadInputs = defaultLoadInputs({ fs, rollups, segments });
  const day = windowFor("day", dayStart);
  const items = await loadInputs({ level: "day", window: day });

  // h0: existing hour rollup; h1 + h2 reconstructed from segments; h3.. empty.
  const byStart = new Map(items.map((it) => [it.window[0], it]));
  assert.equal(byStart.get(h(0)).id, "hExisting");
  assert.equal(byStart.get(h(0)).bullets[0].text, "H0");
  // h1 reconstructed from two segments (leaf refs s1, s2)
  const h1 = byStart.get(h(1));
  assert.equal(h1.id, String(h(1)));
  assert.deepEqual(h1.bullets.map((b) => b.refs), [["s1"], ["s2"]]);
  assert.deepEqual(h1.bullets.map((b) => b.text), ["A", "B"]);
  // h2 reconstructed from one segment
  assert.deepEqual(byStart.get(h(2)).bullets.map((b) => b.text), ["C"]);
  // items sorted by start
  assert.deepEqual(items.map((it) => it.window[0]), [h(0), h(1), h(2)]);
});

// ---------------------------------------------------------------------------
// Preemption
// ---------------------------------------------------------------------------

test("preemption stops the batch BETWEEN reduce calls, not during a call", async () => {
  const d = baseDay();
  const w0 = windowFor("hour", d);
  const windows = [w0, windowFor("hour", d + HOUR_MS), windowFor("hour", d + 2 * HOUR_MS)];
  // presence flips to TRUE only after the first reduce has saved a rollup (i.e.
  // after the in-flight call completes) → the batch must stop between calls.
  const { runner, store } = makeRunner({
    inputs: ({ window }) => [seg(`s${window[0]}`, window[0])],
    presence: () => [...store.map.keys()].length > 0,
  });
  const outcomes = await runner.processDue(windows.map((w) => ({ level: "hour", window: w })));
  assert.equal(outcomes.length, 1); // only the first window was reduced
  assert.deepEqual(outcomes[0].window, w0);
  const savedHours = [...store.map.keys()].filter((k) => k.startsWith("hour/"));
  assert.equal(savedHours.length, 1); // no further rollups written after the stop
});

test("a present user from the start means the batch does not start", async () => {
  const d = baseDay();
  const w = windowFor("hour", d);
  const { runner, store } = makeRunner({
    inputs: [seg("s1", w[0])],
    presence: () => true,
  });
  const outcomes = await runner.processDue([{ level: "hour", window: w }]);
  assert.equal(outcomes.length, 0);
  assert.equal(store.map.size, 0);
});

// ---------------------------------------------------------------------------
// Fact sync (P2 — proposals, §6.2; no direct writes)
// ---------------------------------------------------------------------------

test("proposalsFromRollup groups bullets per project (skips unattributable)", async () => {
  const day = windowFor("day", baseDay());
  const segments = new Map([
    ["s1", { project: "alpha" }],
    ["s2", { project: "alpha" }],
    ["s3", { project: "beta" }],
  ]);
  const rollup = {
    v: ROLLUP_VERSION,
    level: "day",
    window: day,
    bullets: [
      { text: "did A", refs: ["s1"] },
      { text: "did B", refs: ["s2"] },
      { text: "did C (beta)", refs: ["s3"] },
      { text: "orphan", refs: ["missing"] }, // cannot attribute → dropped, never fabricated
    ],
  };
  const props = await proposalsFromRollup(rollup, {
    resolveSegment: async (id) => segments.get(id) ?? null,
  });
  assert.equal(props.length, 3);
  assert.equal(props.filter((p) => p.project === "alpha").length, 2);
  assert.equal(props.filter((p) => p.project === "beta").length, 1);
  assert.ok(props.every((p) => p.kind === "decision"));
});

test("proposalsFromRollup is empty for non-day / empty rollups", async () => {
  assert.deepEqual(await proposalsFromRollup({ level: "hour", bullets: [] }), []);
  assert.deepEqual(await proposalsFromRollup(null), []);
  assert.deepEqual(
    await proposalsFromRollup({ level: "day", bullets: [{ text: "no ev", refs: [] }] }),
    [],
  );
});

test("submitFactsFromRollup enqueues deterministic proposals (sender cto, idempotent ids)", async () => {
  const day = windowFor("day", baseDay());
  const segments = new Map([["s1", { project: "alpha" }]]);
  const seen = new Map();
  const rollup = {
    v: ROLLUP_VERSION,
    level: "day",
    window: day,
    bullets: [{ text: "shipped things", refs: ["s1"] }],
  };
  const submit = async (p) => {
    seen.set(p.proposalId, p);
    return { ok: true };
  };
  const t1 = await submitFactsFromRollup(rollup, { resolveSegment: async (id) => segments.get(id) ?? null, submitProposal: submit });
  assert.equal(t1.applied, 1);
  const [p] = [...seen.values()];
  assert.equal(p.sender, "cto");
  assert.equal(p.project, "alpha");
  assert.match(p.proposalId, /^rollup:/);
  // Re-submit the same day → the same deterministic proposal id (queue dedupes).
  const t2 = await submitFactsFromRollup(rollup, { resolveSegment: async (id) => segments.get(id) ?? null, submitProposal: submit });
  assert.equal(t2.applied, 1);
  assert.equal(seen.size, 1, "deterministic id — re-sync is idempotent");
});

// ---------------------------------------------------------------------------
// buildReduceContext sanity
// ---------------------------------------------------------------------------

test("buildReduceContext orders high instruction first and includes ref pointer", () => {
  const d = baseDay();
  const w = windowFor("hour", d);
  const blocks = buildReduceContext({
    level: "hour",
    window: w,
    inputs: [seg("s1", w[0])],
    refs: ["s1"],
    preceding: null,
  });
  assert.equal(blocks[0].priority, "high");
  assert.match(blocks[0].text, /hourly rollup/);
  assert.ok(blocks.some((b) => /Leaf segment ids/.test(b.text)));
});

// ---------------------------------------------------------------------------
// createRollupRunner exported seams present
// ---------------------------------------------------------------------------

test("createRollupRunner exposes reduceWindow and processDue", () => {
  const { runner } = makeRunner();
  assert.equal(typeof runner.reduceWindow, "function");
  assert.equal(typeof runner.processDue, "function");
});
