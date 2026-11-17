import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteSupports, contentWords, wsnorm } from "./support.mjs";

test("contentWords: lowercased, ≥4 chars, stop words removed", () => {
  assert.deepEqual([...contentWords("Please RUN the Deploy-script, with Docker")].sort(), ["deploy", "docker", "script"]);
});

test("quoteSupports needs ≥20 chars and ≥2 shared content words", () => {
  const claim = "Run the e2e suite locally. npm run build; npm run e2e";
  assert.equal(quoteSupports(claim, "please run the e2e suite locally and build first"), true);
  assert.equal(quoteSupports(claim, "ok do it, thanks a lot for everything"), false); // long, nothing shared
  assert.equal(quoteSupports(claim, "run suite"), false); // too short
  assert.equal(quoteSupports(claim, "please run the suite for me today"), false); // only one shared word
  assert.equal(quoteSupports(claim, "  please   run the e2e\n suite   locally now "), true); // whitespace-normalised length
  assert.equal(wsnorm(" a \n b "), "a b");
});
