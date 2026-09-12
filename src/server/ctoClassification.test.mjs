import "./ctoTestGuard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createToolRegistry } from "./ctoToolRegistry.mjs";
import { toolRegistryStore, toolClassificationStore } from "./ctoStores.mjs";

const DAY = 86400000;
const mem = (value = {}) => ({
  load: async () => structuredClone(value),
  save: async (next) => { value = structuredClone(next); },
});
const raw = (tool, firstSeenTs = 1) => ({ tool, raw: true, status: "observed", uses: 3, firstSeenTs,
  evidence: [{ channel: "secret", detail: "credential-present", ts: firstSeenTs }] });

test("never-attempted tools progress beside failing retries, with alternating lanes and exponential backoff", async () => {
  const registryStore = mem({ tools: [raw("old"), raw("new-b", 2), raw("new-c", 3)] });
  const classificationStore = mem();
  let time = 10 * DAY;
  const calls = [];
  const make = () => createToolRegistry({ registryStore, classificationStore, usageStore: mem(), now: () => time,
    ledger: { append: async () => {} },
    runEphemeral: async ({ context }) => {
      const id = /Identity token: ([^\n]+)/.exec(context[0].text)[1];
      calls.push([id, time]);
      return id === "old" ? { ok: false, code: "timeout" } : { text: id };
    },
  });
  for (let i = 0; i < 8; i++) { await make().dailyScan(); time += DAY; }
  assert.deepEqual(calls.slice(0, 3).map(([id]) => id), ["old", "old", "new-b"]);
  assert.ok(calls.some(([id]) => id === "new-c"));
  const retries = calls.filter(([id]) => id === "old").map(([, at]) => at);
  assert.ok(retries[2] - retries[1] >= 2 * DAY);
  assert.ok(retries[3] - retries[2] >= 4 * DAY);
});

test("retry scheduling chooses the least recently attempted eligible tool", async () => {
  const registryStore = mem({ tools: [raw("a"), raw("b")] });
  const classificationStore = mem({ records: {
    a: { status: "retry", at: 3, attempts: 1, retryAfter: 0 },
    b: { status: "retry", at: 2, attempts: 1, retryAfter: 0 },
  } });
  let selected;
  await createToolRegistry({ registryStore, classificationStore, usageStore: mem(), now: () => 10 * DAY,
    ledger: { append: async () => {} },
    runEphemeral: async ({ context }) => { selected = context[0].text; return { gated: true }; },
  }).dailyScan();
  assert.match(selected, /Identity token: b\n/);
});

for (const failure of ["card", "registry"]) {
  test(`durable classification survives ${failure} failure and restart without repeating the call`, async () => {
    const registryStore = mem({ tools: [raw("candidate")] });
    const classificationStore = mem();
    const save = registryStore.save;
    let fail = true;
    let called = false;
    let calls = 0;
    registryStore.save = async (value) => {
      if (failure === "registry" && fail && called) throw new Error("registry-write-failed");
      await save(value);
    };
    const make = () => createToolRegistry({ registryStore, classificationStore, usageStore: mem(), now: () => 10 * DAY,
      ledger: { append: async () => {} },
      cards: { listOpen: async () => [], upsertConnect: async () => {
        if (failure === "card" && fail) throw new Error("card-failed");
      } },
      runEphemeral: async () => { calls++; called = true; return { text: "github" }; },
    });
    await assert.rejects(make().dailyScan(), /failed/);
    assert.equal(calls, 1);
    const saved = await classificationStore.load();
    assert.equal(saved.records.candidate.status, "resolved");
    assert.equal(saved.records.candidate.canonical, "github");
    fail = false;
    await make().dailyScan();
    assert.equal(calls, 1);
    assert.equal((await registryStore.load()).tools[0].tool, "github");
  });
}

test("failed result persistence leaves a durable reservation; same-day restart cannot spend again", async () => {
  const registryStore = mem({ tools: [raw("candidate")] });
  const classificationStore = mem();
  const save = classificationStore.save;
  let writes = 0;
  let calls = 0;
  classificationStore.save = async (value) => {
    if (++writes === 2) throw new Error("result-write-failed");
    await save(value);
  };
  const make = () => createToolRegistry({ registryStore, classificationStore, usageStore: mem(), now: () => 10 * DAY,
    ledger: { append: async () => {} }, runEphemeral: async () => { calls++; return { text: "github" }; },
  });
  await assert.rejects(make().dailyScan(), /result-write-failed/);
  assert.equal((await classificationStore.load()).records.candidate.status, "reserved");
  await make().dailyScan();
  assert.equal(calls, 1);
});

test("failed reservation prevents any model call", async () => {
  const registry = createToolRegistry({ registryStore: mem({ tools: [raw("candidate")] }), usageStore: mem(),
    classificationStore: { load: async () => ({}), save: async () => { throw new Error("disk-full"); } },
    ledger: { append: async () => {} }, runEphemeral: async () => assert.fail("must reserve before calling"),
  });
  await assert.rejects(registry.dailyScan(), /disk-full/);
});

test("a new process replays a durable result after a card failure without calling the model", async () => {
  await toolRegistryStore.save({ tools: [raw("restart-candidate")] });
  await toolClassificationStore.save({});
  const registry = createToolRegistry({ now: () => 20 * DAY,
    ledger: { append: async () => {} },
    cards: { listOpen: async () => [], upsertConnect: async () => { throw new Error("card-failed"); } },
    runEphemeral: async () => ({ text: "github" }),
  });
  await assert.rejects(registry.dailyScan(), /card-failed/);
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createToolRegistry } from ${JSON.stringify(new URL("./ctoToolRegistry.mjs", import.meta.url).href)};
    import { toolRegistryStore } from ${JSON.stringify(new URL("./ctoStores.mjs", import.meta.url).href)};
    let calls = 0;
    await createToolRegistry({ now: () => ${20 * DAY},
      ledger: { append: async () => {} },
      runEphemeral: async () => { calls++; return { text: "wrong" }; },
    }).dailyScan();
    console.log(JSON.stringify({ calls, tool: (await toolRegistryStore.load()).tools[0].tool }));
  `], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(result), { calls: 0, tool: "github" });
});
