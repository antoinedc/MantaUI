import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteSupports, contentWords, wsnorm, commandExecuted, splitShellSegments, MIN_QUOTE_CHARS } from "./support.mjs";

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

test("commandExecuted: whole command or whole segment; `wholeOnly` (skill steps) accepts only a whole command; decisions/skills share this one", async () => {
  assert.equal(MIN_QUOTE_CHARS, 20);
  assert.deepEqual(splitShellSegments('cd app && npm run build; echo "a && b"'), ["cd app", "npm run build", 'echo "a && b"']);
  assert.equal(commandExecuted("npm run build", ["cd app && npm run build"]), true);
  assert.equal(commandExecuted("npm run build", ["cd app && npm run build"], { wholeOnly: true }), false);
  assert.equal(commandExecuted("cd  app && npm run build", ["cd app && npm run build"], { wholeOnly: true }), true);
  assert.equal(commandExecuted("git push", ['echo "git push"']), false);
  const decisions = await import("./decisions.mjs");
  const skills = await import("./skills.mjs");
  assert.equal(decisions.commandExecuted, commandExecuted);
  assert.equal(decisions.MIN_QUOTE_CHARS, MIN_QUOTE_CHARS);
  assert.equal(skills.MIN_QUOTE_CHARS, MIN_QUOTE_CHARS);
  assert.equal(skills.commandWasExecuted("npm run build", ["cd app && npm run build"]), false);
});
