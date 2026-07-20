// store.test.mjs — unit tests for the gateway registration store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import {
  isValidBoxId,
  loadStore,
  saveStore,
  makeEntry,
  normalizeEntry,
  hostFor,
  MAX_STORE_BYTES,
} from "./store.mjs";

function freshTmpPath(label) {
  const dir = mkdtempSync(join(tmpdir(), `bui-gw-store-${label}-`));
  return { dir, path: join(dir, "boxes.json") };
}

const NOW = 1_700_000_000_000;

test("isValidBoxId: accepts exactly 32 lowercase hex chars", () => {
  assert.equal(isValidBoxId("0".repeat(32)), true);
  assert.equal(isValidBoxId("abcdef0123456789abcdef0123456789"), true);
  assert.equal(isValidBoxId("XYZ"), false);
  assert.equal(isValidBoxId("0xabc"), false);
  assert.equal(isValidBoxId("abcdef0123456789abcdef012345678"), false); // 31 chars
  assert.equal(isValidBoxId("ABCDEF0123456789ABCDEF0123456789"), false); // uppercase
  assert.equal(isValidBoxId("abcdef0123456789abcdef01234567890"), false); // 33 chars
  assert.equal(isValidBoxId(""), false);
  assert.equal(isValidBoxId(null), false);
});

test("hostFor: returns <box_id>.boxes.mantaui.com", () => {
  const bid = "abcdef0123456789abcdef0123456789";
  assert.equal(hostFor(bid), `${bid}.boxes.mantaui.com`);
  assert.throws(() => hostFor("nope"), /invalid box_id/);
});

test("makeEntry: creates an entry with both timestamps equal on first call", () => {
  const e = makeEntry({
    box_id: "0".repeat(32),
    gateway_token: "0".repeat(32),
    ip: "1.2.3.4",
    host: "0".repeat(32) + ".boxes.mantaui.com",
    ovhRecordId: 42,
    now: () => NOW,
  });
  assert.equal(e.gateway_token, "0".repeat(32));
  assert.equal(e.ip, "1.2.3.4");
  assert.equal(e.host, "0".repeat(32) + ".boxes.mantaui.com");
  assert.equal(e.ovhRecordId, 42);
  assert.equal(e.registeredAt, NOW);
  assert.equal(e.updatedAt, NOW);
});

test("normalizeEntry: drops malformed entries silently", () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({}), null);
  assert.equal(normalizeEntry({ gateway_token: "x", ip: "1.2.3.4", host: "h" }), null); // timestamps missing
  assert.equal(
    normalizeEntry({
      gateway_token: "x",
      ip: "1.2.3.4",
      host: "h",
      registeredAt: 1,
      updatedAt: 1,
    })?.gateway_token,
    "x",
  );
});

test("atomic write round-trip: save then load returns the same map", async () => {
  const { dir, path } = freshTmpPath("roundtrip");
  try {
    const entry = makeEntry({
      box_id: "0".repeat(32),
      gateway_token: "a".repeat(32),
      ip: "1.2.3.4",
      host: "0".repeat(32) + ".boxes.mantaui.com",
      ovhRecordId: 99,
      now: () => NOW,
    });
    await saveStore({ [entry.gateway_token ? "0".repeat(32) : "bad"]: entry }, path);
    // The key in the map MUST be the box_id (32-hex). Re-save with the right key.
    await saveStore({ ["0".repeat(32)]: entry }, path);
    const loaded = loadStore(path);
    assert.equal(loaded["0".repeat(32)].ip, "1.2.3.4");
    assert.equal(loaded["0".repeat(32)].ovhRecordId, 99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveStore → file mode is 0600 (owner-only)", async () => {
  const { dir, path } = freshTmpPath("mode");
  try {
    await saveStore(
      {
        ["0".repeat(32)]: makeEntry({
          box_id: "0".repeat(32),
          gateway_token: "a".repeat(32),
          ip: "1.2.3.4",
          host: "0".repeat(32) + ".boxes.mantaui.com",
          now: () => NOW,
        }),
      },
      path,
    );
    const s = statSync(path);
    // mode is the lower 12 bits of st_mode (0o777 + file-type bits).
    assert.equal(s.mode & 0o777, 0o600, `expected 0600, got 0${(s.mode & 0o777).toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadStore: missing file → empty map (no crash)", () => {
  const { dir, path } = freshTmpPath("missing");
  try {
    const loaded = loadStore(path);
    assert.deepEqual(loaded, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadStore: corrupt file → empty map (no crash)", async () => {
  const { dir, path } = freshTmpPath("corrupt");
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{not-json");
    const loaded = loadStore(path);
    assert.deepEqual(loaded, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadStore: ignores entries with non-32-hex keys (defense)", async () => {
  const { dir, path } = freshTmpPath("badkey");
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path,
      JSON.stringify({
        ["0".repeat(32)]: makeEntry({
          box_id: "0".repeat(32),
          gateway_token: "a".repeat(32),
          ip: "1.2.3.4",
          host: "0".repeat(32) + ".boxes.mantaui.com",
          now: () => NOW,
        }),
        "BADKEY": { gateway_token: "x", ip: "1", host: "h", registeredAt: 1, updatedAt: 1 },
      }),
    );
    const loaded = loadStore(path);
    assert.equal(Object.keys(loaded).length, 1);
    assert.ok("0".repeat(32) in loaded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveStore round-trip preserves multiple entries", async () => {
  const { dir, path } = freshTmpPath("multi");
  try {
    const map = {};
    const expectedIps = {};
    for (let i = 0; i < 3; i++) {
      const bid = i.toString(16).padStart(32, "0");
      const ip = `10.0.0.${i + 1}`;
      map[bid] = makeEntry({
        box_id: bid,
        gateway_token: i.toString(16).padStart(32, "0"),
        ip,
        host: `${bid}.boxes.mantaui.com`,
        now: () => NOW + i,
      });
      expectedIps[bid] = ip;
    }
    await saveStore(map, path);
    const loaded = loadStore(path);
    assert.equal(Object.keys(loaded).length, 3);
    for (const [k, v] of Object.entries(loaded)) {
      assert.equal(v.ip, expectedIps[k]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MAX_STORE_BYTES is bounded (128 MiB)", () => {
  assert.equal(MAX_STORE_BYTES, 128 * 1024 * 1024);
});
