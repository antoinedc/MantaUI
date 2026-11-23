import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentAutonomyStrict, configUpdate, configGet } from "./local.mjs";

// The strict read for enforcement decisions (Agents Phase 3 §2): never the in-memory cache, never a guess.
test("readAgentAutonomyStrict: missing file / missing key → undefined; the value as stored; an unreadable or unparsable file throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autonomy-config-"));
  try {
    const path = join(dir, "config.json");
    assert.equal(await readAgentAutonomyStrict(path), undefined, "no file: Balanced");
    await writeFile(path, JSON.stringify({ projects: [] }));
    assert.equal(await readAgentAutonomyStrict(path), undefined, "no key: Balanced");
    await writeFile(path, JSON.stringify({ agentAutonomy: { mode: "autonomous", overrides: { deploy: "ask" } } }));
    assert.deepEqual(await readAgentAutonomyStrict(path), { mode: "autonomous", overrides: { deploy: "ask" } });
    await writeFile(path, "{ not json");
    await assert.rejects(readAgentAutonomyStrict(path), SyntaxError);
    await writeFile(path, "[]");
    await assert.rejects(readAgentAutonomyStrict(path), /not an object/);
    await rm(path);
    await rm(dir, { recursive: true });
    await writeFile(join(tmpdir(), `autonomy-notafile-${process.pid}`), "x");
    await assert.rejects(readAgentAutonomyStrict(join(tmpdir(), `autonomy-notafile-${process.pid}`, "config.json")), (e) => e?.code === "ENOTDIR");
    await rm(join(tmpdir(), `autonomy-notafile-${process.pid}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the default path reads the (sandboxed) config file the writer wrote, not the cache", async () => {
  await configUpdate({ agentAutonomy: { mode: "cautious", overrides: { merge: "never" } } });
  assert.deepEqual(await readAgentAutonomyStrict(), { mode: "cautious", overrides: { merge: "never" } });
  assert.deepEqual((await configGet()).agentAutonomy, { mode: "cautious", overrides: { merge: "never" } });
});
