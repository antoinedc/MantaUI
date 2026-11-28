// The plain-language title of a piece of work (what Fleet, Needs you, Details and the task cards show): never a slug.
import test from "node:test";
import assert from "node:assert/strict";
import { TITLE_MAX, buildTitleInstruction, displayTitle, firstSentence, looksLikeSlug, sanitizeTitle } from "./jobTitle.mjs";

test("looksLikeSlug: hyphenated lowercase words are a slug; a sentence or a single word is not", () => {
  assert.equal(looksLikeSlug("you-are-implementing-pr"), true);
  assert.equal(looksLikeSlug("mantaui-repo-github-com-antoined"), true);
  assert.equal(looksLikeSlug("Build the Fleet / Needs you redesign"), false);
  assert.equal(looksLikeSlug("Refactor"), false);
  assert.equal(looksLikeSlug("fix the login"), false);
});

test("firstSentence: the first sentence, plain, at most 60 characters, cut at a word", () => {
  assert.equal(firstSentence("You are implementing PR 1768. Read the spec first."), "You are implementing PR 1768");
  assert.equal(firstSentence("  \n\n# Fix the login test\nthen more"), "Fix the login test");
  assert.equal(firstSentence("@dev fix the flaky login test"), "fix the flaky login test");
  const long = firstSentence("Please review every single one of the pull requests that touch the billing code before Friday afternoon");
  assert.ok(long.length <= TITLE_MAX, long);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.slice(0, -1).endsWith(" "));
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence(null), "");
});

test("sanitizeTitle: one plain line; quotes, a Title: prefix and the closing full stop go; a slug or nothing is refused", () => {
  assert.equal(sanitizeTitle('"Fix the login test."\nThis is why'), "Fix the login test");
  assert.equal(sanitizeTitle("Title: Add speaker names to exports"), "Add speaker names to exports");
  assert.equal(sanitizeTitle("fix-the-login-test"), "");
  assert.equal(sanitizeTitle("   "), "");
  assert.equal(sanitizeTitle(undefined), "");
  assert.ok(sanitizeTitle("word ".repeat(40)).length <= TITLE_MAX);
});

test("buildTitleInstruction: asks for a short plain title and carries the request as data", () => {
  const text = buildTitleInstruction("Fix the login test");
  assert.match(text, /title/i);
  assert.match(text, /Fix the login test/);
  assert.ok(buildTitleInstruction("x".repeat(10_000)).length < 3000);
});

test("displayTitle: the stored title wins", () => {
  assert.equal(displayTitle({ title: "Fix the login test", name: "fix-the-login-test", request: "something else" }), "Fix the login test");
});

test("displayTitle: a handoff's own title (stored as the request) beats the slug name", () => {
  assert.equal(displayTitle({ name: "build-the-fleet-needs-you-redesign", request: "Build the Fleet / Needs you redesign", requestedBy: "manta" }), "Build the Fleet / Needs you redesign");
});

test("displayTitle: a refresh or check-up routine's task is named like its routine", () => {
  assert.equal(displayTitle({ name: "Refresh : check the research it", request: "Refresh @seo: check the research it rests on and propose only changes your research supports.", deliverResult: false }), "Refresh @seo");
  assert.equal(displayTitle({ name: "Team check-up", request: "Check the team: propose only changes the facts and your research support (max 3).", deliverResult: false }), "Team check-up");
});

test("displayTitle: a task subagent or a background command keeps its own human name", () => {
  assert.equal(displayTitle({ origin: "subagent", name: "Find skill loading code", prompt: "You are a subagent…" }), "Find skill loading code");
  assert.equal(displayTitle({ origin: "command", name: "/review HEAD~1" }), "/review HEAD~1");
});

test("displayTitle: a record with no title shows the first sentence of its prompt, never the slug", () => {
  assert.equal(
    displayTitle({ name: "you-are-implementing-pr", prompt: "You are implementing PR 1768 of the MantaUI repo.\nRead the spec first." }),
    "You are implementing PR 1768 of the MantaUI repo",
  );
  assert.equal(displayTitle({ name: "mantaui-repo-github-com-antoined", prompt: "MantaUI repo (github.com/antoinedc/MantaUI). The Fleet redesign is merged to main." }), "MantaUI repo (github.com/antoinedc/MantaUI)");
});

test("displayTitle: an agent task's prompt is read up to the project brief the server appends", () => {
  const prompt = "Audit the head tags on the pricing page.\n\n---\nYour brief for this project:\nSEO rules…";
  assert.equal(displayTitle({ name: "audit-the-head-tags-on", prompt }), "Audit the head tags on the pricing page");
});

test("displayTitle: a human-looking name is kept; nothing at all is 'Untitled task'", () => {
  assert.equal(displayTitle({ name: "Quarterly cleanup" }), "Quarterly cleanup");
  assert.equal(displayTitle({ name: "some-slug-here" }), "Untitled task");
  assert.equal(displayTitle(null), "Untitled task");
});
