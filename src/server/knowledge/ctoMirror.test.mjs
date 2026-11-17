import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyResolver } from "./blackboardImport.mjs";
import { createCtoMirror } from "./ctoMirror.mjs";
import { createQueue } from "./queue.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const scanner = { redact: async (t) => ({ text: t.replace(/SECRETVALUE/g, "[REDACTED]"), redacted: 0, unavailable: false }) };
async function rig({ enabled = true } = {}) {
  const state = await memState();
  const queue = createQueue({ state, scanner, root: await tmpDir("knowledge-mirror-"), now: () => 1 });
  const resolver = createKeyResolver({
    listTmuxProjects: async () => [{ tmuxSession: "MantaUI", windows: [{ paneCurrentPath: "/r/manta" }] }, { tmuxSession: "mixed", windows: [{ paneCurrentPath: "/r/manta" }, { paneCurrentPath: "/r/other" }] }],
    registry: { identify: async (d) => ({ slug: d === "/r/manta" ? "manta-0000000001" : "other-0000000002" }) },
  });
  const mirror = createCtoMirror({ resolver, queue, settings: { get: async () => ({ enabled }) }, log: () => {} });
  return { mirror, queue };
}

test("a proposal for a key that resolves to one project becomes a note (origin cto, derived), with decision/status kinds", async () => {
  const { mirror, queue } = await rig();
  const a = await mirror.mirrorCtoFact({ project: "MantaUI", kind: "decision", statement: "Ship on tag push", refs: ["commit:abcdef1", "free text"], sessionID: "ses_x" });
  assert.deepEqual([a.enqueued, a.slug], [true, "manta-0000000001"]);
  const b = await mirror.mirrorCtoFact({ project: "mantaui", kind: "anomaly", statement: "Tunnel flapped SECRETVALUE" });
  assert.equal(b.enqueued, true);
  const notes = await queue.list("manta-0000000001");
  assert.deepEqual(notes.map((n) => [n.kind, n.origin, n.derived, n.sessionID]), [["decision", "cto", true, "ses_x"], ["status", "cto", true, null]]);
  assert.deepEqual(notes[0].refs, ["commit:abcdef1"]);
  assert.match(notes[1].text, /\[REDACTED\]/);
});

test("unresolvable or ambiguous keys are skipped; duplicates are not re-queued; disabled and empty statements do nothing; never throws", async () => {
  const { mirror, queue } = await rig();
  assert.equal((await mirror.mirrorCtoFact({ project: "021310b1-9ee1-430d-b5f9-36b86f8eaa63", kind: "status", statement: "x" })).enqueued, false);
  const amb = await mirror.mirrorCtoFact({ project: "mixed", kind: "status", statement: "x" });
  assert.equal(amb.enqueued, false);
  assert.match(amb.reason, /span 2 projects/);
  assert.equal((await queue.slugs()).length, 0);
  await mirror.mirrorCtoFact({ project: "MantaUI", kind: "status", statement: "same" });
  assert.equal((await mirror.mirrorCtoFact({ project: "MantaUI", kind: "status", statement: "same" })).enqueued, false);
  assert.equal((await mirror.mirrorCtoFact({ project: "MantaUI", kind: "status", statement: "  " })).reason, "empty statement");
  assert.equal((await (await rig({ enabled: false })).mirror.mirrorCtoFact({ project: "MantaUI", kind: "status", statement: "x" })).reason, "disabled");
  assert.equal((await mirror.mirrorCtoFact(undefined)).enqueued, false);
});
