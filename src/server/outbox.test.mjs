import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOutbox, createOutboxScanner } from "./outbox.mjs";

async function makeOutbox() {
  return mkdtemp(join(tmpdir(), "manta-outbox-test-"));
}

// ----------------------------------------------------------------------------
// listOutbox — pure-ish (fs) helper
// ----------------------------------------------------------------------------

test("listOutbox returns [] when the dir doesn't exist", async () => {
  const entries = await listOutbox(join(tmpdir(), "definitely-not-here-bui-xyz"));
  assert.deepEqual(entries, []);
});

test("listOutbox lists loose files at the root with size + null session", async () => {
  const root = await makeOutbox();
  try {
    await writeFile(join(root, "report.pdf"), "hello");
    const entries = await listOutbox(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "report.pdf");
    assert.equal(entries[0].size, 5);
    assert.equal(entries[0].session, null);
    assert.equal(entries[0].path, join(root, "report.pdf"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listOutbox lists files one level deep with their session label", async () => {
  const root = await makeOutbox();
  try {
    await mkdir(join(root, "myproj"));
    await writeFile(join(root, "myproj", "out.txt"), "abc");
    const entries = await listOutbox(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "out.txt");
    assert.equal(entries[0].session, "myproj");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listOutbox does NOT descend past one subdir level", async () => {
  const root = await makeOutbox();
  try {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "deep.txt"), "x");
    await writeFile(join(root, "a", "shallow.txt"), "y");
    const entries = await listOutbox(root);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["shallow.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// createOutboxScanner — deterministic tick(), no timers
// ----------------------------------------------------------------------------

function fakeBus() {
  const events = [];
  return {
    events,
    publish(evt) {
      events.push(evt);
    },
  };
}

const fileEvents = (bus) => bus.events.filter((e) => e.kind === "agentFile");

test("scanner publishes one agentFile event for a present file", async () => {
  const root = await makeOutbox();
  const bus = fakeBus();
  await writeFile(join(root, "a.txt"), "hi");
  const { tick } = createOutboxScanner(bus, root);
  try {
    await tick();
    const evs = fileEvents(bus);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].payload.name, "a.txt");
    assert.equal(evs[0].payload.autoPulled, false);
    assert.equal(evs[0].payload.sessionName, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner does not re-announce the same file across ticks", async () => {
  const root = await makeOutbox();
  const bus = fakeBus();
  await writeFile(join(root, "a.txt"), "hi");
  const { tick } = createOutboxScanner(bus, root);
  try {
    await tick();
    await tick();
    await tick();
    assert.equal(fileEvents(bus).length, 1, "file announced exactly once");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner re-announces a same-named file after the prior one is removed", async () => {
  const root = await makeOutbox();
  const bus = fakeBus();
  await writeFile(join(root, "a.txt"), "hi");
  const { tick } = createOutboxScanner(bus, root);
  try {
    await tick(); // announce #1
    await rm(join(root, "a.txt"));
    await tick(); // sees it gone → prunes seen-set
    await writeFile(join(root, "a.txt"), "again");
    await tick(); // announce #2
    assert.equal(fileEvents(bus).length, 2, "announced again after removal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
