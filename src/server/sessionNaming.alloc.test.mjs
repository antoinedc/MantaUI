import { test } from "node:test";
import assert from "node:assert/strict";
import { createNameAllocator, createSessionUnderAllocator, NO_FREE_NAME } from "./sessionNaming.mjs";

class Dup extends Error {
  constructor(name, { sessionId, createdHere }) {
    super(`duplicate session: ${name}`);
    this.name = "DuplicateSessionNameError";
    this.sessionId = sessionId;
    this.createdHere = createdHere;
  }
}

/** A fake box: live names, an opencode-session counter, and hooks to inject outside collisions. */
function fakeBox({ live = [], collideOnce = [], collideAlways = false, ownsSession = true } = {}) {
  const names = new Set(live);
  const deleted = [];
  const creates = [];
  let sessions = 0;
  let inside = 0;
  let maxInside = 0;
  const collide = new Set(collideOnce);
  return {
    names, deleted, creates, get maxInside() { return maxInside; },
    listNames: async () => [...names],
    deleteSession: async (id) => { deleted.push(id); },
    create: async ({ name, existingSessionId }) => {
      inside++; maxInside = Math.max(maxInside, inside);
      try {
        await Promise.resolve();
        const created = existingSessionId ? false : ownsSession;
        const sid = existingSessionId ?? (created ? `ses_${++sessions}` : null);
        creates.push({ name, existingSessionId });
        if (collideAlways || collide.has(name)) {
          collide.delete(name);
          names.add(name); // the outside creator took it
          throw new Dup(name, { sessionId: sid, createdHere: created });
        }
        if (names.has(name)) throw new Dup(name, { sessionId: sid, createdHere: created });
        names.add(name);
        return { sessionId: sid };
      } finally { inside--; }
    },
  };
}

test("serialization: a second create waits for the first (next_js, next_js-2), sections never overlap", async () => {
  const box = fakeBox();
  const allocator = createNameAllocator();
  let release;
  const latch = new Promise((r) => { release = r; });
  let entered = 0;
  const blockingList = async () => {
    entered++;
    if (entered === 1) await latch;
    return box.listNames();
  };
  const run = () => createSessionUnderAllocator({ hint: "/h/next.js", listNames: blockingList, create: box.create, deleteSession: box.deleteSession, allocator });
  const first = run();
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, 1);
  const second = run();
  await new Promise((r) => setImmediate(r));
  assert.equal(entered, 1, "the second call has not entered the critical section");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.name, b.name], ["next_js", "next_js-2"]);
  assert.equal(box.maxInside, 1);
});

test("external collision between read and create → retried under the next suffix, same opencode session", async () => {
  const box = fakeBox({ collideOnce: ["next_js"] });
  const out = await createSessionUnderAllocator({ hint: "/h/next.js", listNames: box.listNames, create: box.create, deleteSession: box.deleteSession, allocator: createNameAllocator() });
  assert.equal(out.name, "next_js-2");
  assert.deepEqual(box.creates.map((c) => c.name), ["next_js", "next_js-2"]);
  assert.equal(box.creates[1].existingSessionId, "ses_1", "no second opencode session is made");
  assert.deepEqual(box.deleted, []);
});

test("three collisions with a session created HERE → the sentence, and that session is deleted", async () => {
  const box = fakeBox({ collideAlways: true });
  await assert.rejects(
    createSessionUnderAllocator({ hint: "/h/x", listNames: box.listNames, create: box.create, deleteSession: box.deleteSession, allocator: createNameAllocator() }),
    { message: NO_FREE_NAME },
  );
  assert.equal(box.creates.length, 3);
  assert.deepEqual(box.deleted, ["ses_1"], "ownership is sticky across the retries");
});

test("explicit name: no retry under another name; a session created here is deleted", async () => {
  const box = fakeBox({ live: ["taken"] });
  await assert.rejects(
    createSessionUnderAllocator({ explicitName: "taken", listNames: box.listNames, create: box.create, deleteSession: box.deleteSession, allocator: createNameAllocator() }),
    { message: "A project named “taken” already exists." },
  );
  assert.equal(box.creates.length, 1);
  assert.deepEqual(box.deleted, ["ses_1"]);
});

test("explicit name collision WITH a caller-supplied session → that session is never deleted", async () => {
  const box = fakeBox({ live: ["taken"] });
  await assert.rejects(
    createSessionUnderAllocator({ explicitName: "taken", existingSessionId: "ses_mine", listNames: box.listNames, create: box.create, deleteSession: box.deleteSession, allocator: createNameAllocator() }),
    /already exists/,
  );
  assert.deepEqual(box.deleted, []);
});

test("retry exhaustion WITH a caller-supplied session → not deleted either", async () => {
  const box = fakeBox({ collideAlways: true });
  await assert.rejects(
    createSessionUnderAllocator({ hint: "/h/x", existingSessionId: "ses_mine", listNames: box.listNames, create: box.create, deleteSession: box.deleteSession, allocator: createNameAllocator() }),
    { message: NO_FREE_NAME },
  );
  assert.deepEqual(box.deleted, []);
});

test("an explicit name is made tmux-safe; a delete that fails is logged, not thrown", async () => {
  const logs = [];
  const box = fakeBox({ collideAlways: true });
  await assert.rejects(
    createSessionUnderAllocator({
      explicitName: "next.js", listNames: box.listNames, create: box.create,
      deleteSession: async () => { throw new Error("gone"); }, allocator: createNameAllocator(), log: (m) => logs.push(m),
    }),
    { message: "A project named “next_js” already exists." },
  );
  assert.equal(logs.length, 1);
});

test("an unrelated create failure after a retry chain cleans up the session made here, and rethrows", async () => {
  const box = fakeBox({ collideOnce: ["z"] });
  let n = 0;
  await assert.rejects(
    createSessionUnderAllocator({
      hint: "/h/z", listNames: box.listNames, deleteSession: box.deleteSession, allocator: createNameAllocator(),
      create: async (a) => { if (++n === 2) throw new Error("disk full"); return box.create(a); },
    }),
    { message: "disk full" },
  );
  assert.deepEqual(box.deleted, ["ses_1"]);
});
