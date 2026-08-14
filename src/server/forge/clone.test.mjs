// clone.test.mjs — the clone job registry (BET-796 §3). No live git, no real
// clone: `gitCloneFn` is injected. Pins progress streaming, error surfacing,
// and cancellation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloneStore } from "./clone.mjs";

const tick = () => new Promise((r) => setTimeout(r, 10));

test("clone job streams progress and lands ok=true", async () => {
  const store = createCloneStore({
    now: () => 1000,
    gitCloneFn: async ({ onProgress }) => {
      onProgress({ percent: 10, bytes: 100 });
      onProgress({ percent: 61, bytes: 34 * 1024 * 1024 });
    },
  });
  const id = store.start({ url: "https://github.com/acme/widget.git", dest: "/p/widget", name: "widget" });
  await tick();
  const st = store.status(id);
  assert.equal(st.done, true);
  assert.equal(st.ok, true);
  // The status shows the LATEST parsed progress — the determinate bar's source.
  assert.equal(st.percent, 61);
  assert.equal(st.bytes, 34 * 1024 * 1024);
  assert.equal(st.url, "https://github.com/acme/widget.git");
  assert.equal(st.dest, "/p/widget");
});

test("clone job surfaces the error and marks ok=false (no token leak)", async () => {
  const store = createCloneStore({
    now: () => 1000,
    gitCloneFn: async () => {
      throw new Error("git clone exited 128: remote: Permission denied to acme/widget. fatal: unable to access 'https://x-access-token:ghp_unrealXXX@github.com/acme/widget.git/': The requested URL returned error: 403");
    },
  });
  const id = store.start({ url: "u", dest: "/p/x", name: "x", token: "ghp_SHOULDNOTLEAK" });
  await tick();
  const st = store.status(id);
  assert.equal(st.ok, false);
  assert.match(st.error, /Permission denied/);
  assert.ok(!st.error.includes("ghp_SHOULDNOTLEAK"), "token must not surface in the error");
});

test("clone job cancel aborts an in-flight clone", async () => {
  let aborted = false;
  const store = createCloneStore({
    now: () => 1000,
    gitCloneFn: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          const e = new Error("cancelled");
          e.cancelled = true;
          reject(e);
        });
      }),
  });
  const id = store.start({ url: "u", dest: "/p/x", name: "x" });
  assert.equal(store.cancel(id).cancelled, true);
  await tick();
  const st = store.status(id);
  assert.equal(st.cancelled, true);
  assert.equal(st.done, true);
  assert.equal(st.ok, false);
  assert.equal(aborted, true);
});

test("unknown / expired job id → null status; cancel on a done job is a no-op", async () => {
  const store = createCloneStore({
    now: () => 1000,
    gitCloneFn: async () => {},
  });
  assert.equal(store.status("does-not-exist"), null);
  const id = store.start({ url: "u", dest: "/p/x", name: "x" });
  await tick();
  assert.equal(store.cancel(id).cancelled, false, "a finished clone cannot be cancelled");
});
