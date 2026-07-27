import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { restampFeed, sha512Base64 } from "./restamp-update-feed.mjs";

// A feed shaped exactly like the one electron-builder emits for the mac
// desktop build (captured from the real 0.0.14 release).
function feedFixture() {
  return {
    version: "0.0.14",
    files: [
      {
        url: "Manta UI-0.0.14-arm64.dmg",
        sha512: "PRE_STAPLE_DIGEST==",
        size: 97241753,
      },
    ],
    path: "Manta UI-0.0.14-arm64.dmg",
    sha512: "PRE_STAPLE_DIGEST==",
    releaseDate: "2026-07-27T15:27:24.601Z",
  };
}

describe("sha512Base64", () => {
  test("is base64 of the raw digest, NOT hex", () => {
    const expected = createHash("sha512").update("hello").digest("base64");
    assert.equal(sha512Base64(Buffer.from("hello")), expected);
    // Guard the encoding explicitly: electron-updater rejects a hex digest,
    // and the failure mode (every update fails verification) is exactly the
    // bug this script fixes, so a silent swap must not pass.
    const hex = createHash("sha512").update("hello").digest("hex");
    assert.notEqual(sha512Base64(Buffer.from("hello")), hex);
  });
});

describe("restampFeed", () => {
  test("REGRESSION: rewrites the digest + size the staple step invalidated", () => {
    // The shipped bug: stapling grows the DMG ~11KB and changes its hash, but
    // the feed keeps electron-builder's pre-staple values, so electron-updater
    // downloads a valid DMG and rejects it on checksum.
    const { feed, changed } = restampFeed(feedFixture(), {
      "Manta UI-0.0.14-arm64.dmg": { sha512: "POST_STAPLE_DIGEST==", size: 97253264 },
    });
    assert.equal(feed.files[0].sha512, "POST_STAPLE_DIGEST==");
    assert.equal(feed.files[0].size, 97253264);
    assert.deepEqual(changed, ["Manta UI-0.0.14-arm64.dmg"]);
  });

  test("mirrors the restamped digest into the legacy top-level sha512", () => {
    // Older electron-updater clients read the top-level `path`/`sha512` pair.
    // Leaving it stale would keep auto-update broken for exactly those clients.
    const { feed } = restampFeed(feedFixture(), {
      "Manta UI-0.0.14-arm64.dmg": { sha512: "POST_STAPLE_DIGEST==", size: 97253264 },
    });
    assert.equal(feed.sha512, "POST_STAPLE_DIGEST==");
  });

  test("reports no change when the artifacts already match (idempotent)", () => {
    const already = feedFixture();
    const { feed, changed } = restampFeed(already, {
      "Manta UI-0.0.14-arm64.dmg": { sha512: "PRE_STAPLE_DIGEST==", size: 97241753 },
    });
    assert.deepEqual(changed, []);
    assert.equal(feed.files[0].sha512, "PRE_STAPLE_DIGEST==");
  });

  test("running it twice is a no-op the second time", () => {
    const stats = {
      "Manta UI-0.0.14-arm64.dmg": { sha512: "POST_STAPLE_DIGEST==", size: 97253264 },
    };
    const once = restampFeed(feedFixture(), stats);
    const twice = restampFeed(once.feed, stats);
    assert.deepEqual(twice.changed, []);
    assert.deepEqual(twice.feed, once.feed);
  });

  test("preserves unrelated feed keys (version, releaseDate)", () => {
    const { feed } = restampFeed(feedFixture(), {
      "Manta UI-0.0.14-arm64.dmg": { sha512: "POST_STAPLE_DIGEST==", size: 97253264 },
    });
    assert.equal(feed.version, "0.0.14");
    assert.equal(feed.releaseDate, "2026-07-27T15:27:24.601Z");
  });

  test("restamps every entry when the feed lists multiple artifacts", () => {
    // Re-adding the x64 arch to electron-builder.yml must not silently leave
    // the second artifact on a stale digest.
    const multi = {
      version: "0.0.15",
      files: [
        { url: "a-arm64.dmg", sha512: "OLD_A==", size: 1 },
        { url: "b-x64.dmg", sha512: "OLD_B==", size: 2 },
      ],
      path: "a-arm64.dmg",
      sha512: "OLD_A==",
    };
    const { feed, changed } = restampFeed(multi, {
      "a-arm64.dmg": { sha512: "NEW_A==", size: 10 },
      "b-x64.dmg": { sha512: "NEW_B==", size: 20 },
    });
    assert.equal(feed.files[0].sha512, "NEW_A==");
    assert.equal(feed.files[1].sha512, "NEW_B==");
    assert.equal(feed.sha512, "NEW_A==");
    assert.deepEqual(changed, ["a-arm64.dmg", "b-x64.dmg"]);
  });

  test("does not mutate the input feed", () => {
    const input = feedFixture();
    restampFeed(input, {
      "Manta UI-0.0.14-arm64.dmg": { sha512: "POST_STAPLE_DIGEST==", size: 97253264 },
    });
    assert.equal(input.files[0].sha512, "PRE_STAPLE_DIGEST==");
    assert.equal(input.files[0].size, 97241753);
  });
});
