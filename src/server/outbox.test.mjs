import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOutbox, createOutboxScanner, pushArtifact, expireArtifacts } from "./outbox.mjs";

async function makeOutbox() {
  return mkdtemp(join(tmpdir(), "manta-outbox-test-"));
}

// ----------------------------------------------------------------------------
// listOutbox — pure-ish (fs) helper
// ----------------------------------------------------------------------------

test("listOutbox returns [] when the dir doesn't exist", async () => {
  const entries = await listOutbox(join(tmpdir(), "definitely-not-here-manta-xyz"));
  assert.deepEqual(entries, []);
});

test("listOutbox lists loose files at the root with size + null sessionID", async () => {
  const root = await makeOutbox();
  try {
    await writeFile(join(root, "report.pdf"), "hello");
    const entries = await listOutbox(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "report.pdf");
    assert.equal(entries[0].size, 5);
    assert.equal(entries[0].sessionID, null);
    assert.equal(entries[0].path, join(root, "report.pdf"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listOutbox scopes to a sessionID and omits loose root files", async () => {
  const root = await makeOutbox();
  try {
    await writeFile(join(root, "loose.txt"), "x");
    await mkdir(join(root, "ses_a"));
    await writeFile(join(root, "ses_a", "mine.txt"), "ab");
    await mkdir(join(root, "ses_b"));
    await writeFile(join(root, "ses_b", "theirs.txt"), "cd");
    const mine = await listOutbox(root, { sessionID: "ses_a" });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, "mine.txt");
    assert.equal(mine[0].sessionID, "ses_a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listOutbox reports mtime + a 7-day expiresAt per file", async () => {
  const root = await makeOutbox();
  try {
    await mkdir(join(root, "ses_a"));
    await writeFile(join(root, "ses_a", "sub.txt"), "def");
    const entries = await listOutbox(root);
    assert.equal(entries.length, 1);
    assert.equal(typeof entries[0].mtime, "number");
    assert.ok(entries[0].mtime > 0);
    assert.equal(entries[0].expiresAt, entries[0].mtime + 7 * 24 * 3600 * 1000);
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

// pushArtifact — copies a source file into the workspace-linked mailbox
test("pushArtifact copies the file under <sessionID>/ and returns its row", async () => {
  const root = await makeOutbox();
  const src = join(root, "..", "src-report.csv");
  await writeFile(src, "a;b\n1;2\n");
  try {
    const res = await pushArtifact(src, "ses_abc", { root });
    assert.equal(res.ok, true);
    assert.equal(res.row.name, "src-report.csv");
    assert.equal(res.row.sessionID, "ses_abc");
    assert.ok(res.row.path.includes(join("ses_abc", "src-report.csv")));
    assert.equal(typeof res.row.size, "number");
    assert.equal(typeof res.row.expiresAt, "number");
    // the source is kept, and a copy landed in the mailbox
    const listed = await listOutbox(root, { sessionID: "ses_abc" });
    assert.equal(listed.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(src, { force: true });
  }
});

test("pushArtifact rejects a missing file and a blank sessionID", async () => {
  const root = await makeOutbox();
  try {
    const missing = await pushArtifact(join(root, "nope.txt"), "ses_a", { root });
    assert.equal(missing.ok, false);
    const noblank = await pushArtifact(join(root, "nope.txt"), "  ", { root });
    assert.equal(noblank.ok, false);
    assert.equal(noblank.error, "sessionID is required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// expireArtifacts — TTL sweep removes expired files + prunes empty dirs
test("expireArtifacts removes files past TTL and prunes empty session dirs", async () => {
  const root = await makeOutbox();
  const ttl = 1000;
  try {
    await mkdir(join(root, "ses_a"));
    await mkdir(join(root, "ses_b"));
    await writeFile(join(root, "ses_a", "old.txt"), "x");
    await writeFile(join(root, "ses_a", "fresh.txt"), "y");
    await writeFile(join(root, "ses_b", "oldtoo.txt"), "z");
    const now = Date.now();
    // age `old.txt` beyond TTL by backdating its mtime
    await touchMtime(join(root, "ses_a", "old.txt"), now - ttl - 1000);
    await touchMtime(join(root, "ses_b", "oldtoo.txt"), now - ttl - 1000);
    const removed = await expireArtifacts(root, { ttlMs: ttl, now });
    assert.equal(removed, 2);
    const remaining = await listOutbox(root);
    const names = remaining.map((e) => e.name);
    assert.deepEqual(names, ["fresh.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function touchMtime(p, ms) {
  await utimes(p, new Date(ms), new Date(ms));
}
