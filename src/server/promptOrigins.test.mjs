import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePath } from "../shared/paths.mjs";
import {
  PROMPT_ORIGINS,
  PROMPT_ORIGIN_RETENTION_MS,
  createPromptOrigins,
  defaultPromptOriginsPath,
  normalizeOrigin,
} from "./promptOrigins.mjs";

let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}
const hasSqlite = sqlite != null;

const DAY = 24 * 60 * 60 * 1000;

function withStore(fn, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "manta-origins-"));
  let t = 1_700_000_000_000;
  const store = createPromptOrigins({ path: join(dir, "knowledge", "state.sqlite"), now: () => t, warn: () => {}, ...opts });
  const clock = { advance: (ms) => (t += ms), now: () => t };
  return Promise.resolve(fn(store, clock, dir)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test("the default store file lives under the sandboxed Manta state home", () => {
  assert.equal(defaultPromptOriginsPath(), statePath("knowledge", "state.sqlite"));
});

test("origins are a closed set; anything else normalizes to unknown, never user", () => {
  assert.deepEqual([...PROMPT_ORIGINS], ["user", "schedule", "webhook", "peer", "job", "routine", "cto", "plugin", "unknown"]);
  for (const o of PROMPT_ORIGINS) assert.equal(normalizeOrigin(o), o);
  for (const bad of [undefined, null, "", "USER", "human", "user ", 7, {}]) assert.equal(normalizeOrigin(bad), "unknown");
});

test("record/get round-trips; only a recorded user origin is user-authored", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withStore((s) => {
    assert.equal(s.record({ messageID: "msg_u", sessionID: "ses_a", origin: "user" }), true);
    assert.equal(s.record({ messageID: "msg_s", sessionID: "ses_a", origin: "schedule" }), true);
    assert.equal(s.get("msg_u"), "user");
    assert.equal(s.get("msg_s"), "schedule");
    assert.equal(s.isUserAuthored("msg_u"), true);
    assert.equal(s.isUserAuthored("msg_s"), false);
  });
});

test("fail closed: no record, an omitted or invalid origin, and a store failure are all not user-authored", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withStore((s) => {
    assert.equal(s.get("msg_none"), null);
    assert.equal(s.isUserAuthored("msg_none"), false);
    s.record({ messageID: "msg_d", sessionID: "ses_a" });
    s.record({ messageID: "msg_bad", sessionID: "ses_a", origin: "human" });
    assert.equal(s.get("msg_d"), "unknown", "the default origin is unknown");
    assert.equal(s.get("msg_bad"), "unknown");
    assert.equal(s.isUserAuthored("msg_d"), false);
    assert.equal(s.isUserAuthored(undefined), false);
    assert.equal(s.record({ messageID: "", sessionID: "ses_a", origin: "user" }), false);
    assert.equal(s.record({ messageID: "msg_x", origin: "user" }), false, "a session id is required");
  });
  // node:sqlite unavailable → inert, never throws
  const inert = createPromptOrigins({ sqliteModule: null, warn: () => {} });
  assert.equal(inert.available, false);
  assert.equal(inert.record({ messageID: "m", sessionID: "s", origin: "user" }), false);
  assert.equal(inert.isUserAuthored("m"), false);
  assert.equal(inert.prune(), 0);
  // an unopenable file → inert too
  const warnings = [];
  const dir = mkdtempSync(join(tmpdir(), "manta-origins-bad-"));
  writeFileSync(join(dir, "a-file"), "x");
  const broken = createPromptOrigins({ path: join(dir, "a-file", "state.sqlite"), warn: (...a) => warnings.push(a.join(" ")) });
  assert.equal(broken.record({ messageID: "m", sessionID: "s", origin: "user" }), false);
  assert.equal(broken.isUserAuthored("m"), false);
  if (hasSqlite) assert.equal(warnings.length, 1, "one warning, not one per call");
  rmSync(dir, { recursive: true, force: true });
});

test("the first record wins: a re-posted message id can neither upgrade nor downgrade its origin", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withStore((s) => {
    assert.equal(s.record({ messageID: "msg_1", sessionID: "ses_a", origin: "plugin" }), true);
    assert.equal(s.record({ messageID: "msg_1", sessionID: "ses_a", origin: "user" }), false);
    assert.equal(s.get("msg_1"), "plugin");
    assert.equal(s.record({ messageID: "msg_2", sessionID: "ses_a", origin: "user" }), true);
    assert.equal(s.record({ messageID: "msg_2", sessionID: "ses_a", origin: "job" }), false);
    assert.equal(s.isUserAuthored("msg_2"), true);
  });
});

test("rows are kept 90 days; prune removes only older ones", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  assert.equal(PROMPT_ORIGIN_RETENTION_MS, 90 * DAY);
  await withStore((s, clock) => {
    s.record({ messageID: "old", sessionID: "ses_a", origin: "user" });
    clock.advance(60 * DAY);
    s.record({ messageID: "mid", sessionID: "ses_a", origin: "user" });
    clock.advance(29 * DAY); // old is 89 days: still kept
    assert.equal(s.prune(), 0);
    assert.equal(s.isUserAuthored("old"), true);
    clock.advance(2 * DAY); // old is 91 days, mid is 31
    assert.equal(s.prune(), 1);
    assert.equal(s.get("old"), null);
    assert.equal(s.isUserAuthored("old"), false, "an expired record reads as not user-authored");
    assert.equal(s.get("mid"), "user");
    assert.equal(s.prune(), 0);
  });
});

test("recording also prunes on its own once a day, so the table never needs a separate timer", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withStore((s, clock) => {
    s.record({ messageID: "old", sessionID: "ses_a", origin: "user" });
    clock.advance(91 * DAY);
    s.record({ messageID: "new", sessionID: "ses_a", origin: "user" });
    assert.equal(s.get("old"), null);
    assert.equal(s.get("new"), "user");
  });
});

test("a second connection to the same file sees the records (shared knowledge state.sqlite, WAL)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withStore((a, _clock, dir) => {
    a.record({ messageID: "msg_1", sessionID: "ses_a", origin: "user" });
    const b = createPromptOrigins({ path: join(dir, "knowledge", "state.sqlite"), warn: () => {} });
    try {
      assert.equal(b.isUserAuthored("msg_1"), true);
    } finally {
      b.close();
    }
  });
});
