// Architect v2 PR D (spec §5.2): the weekly team check-up's fact sheet — facts computed by the server, no model, no opinion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskCounts, median, repeatedSentences, brokenReferenceCandidates, agentNeedsLook, renderFactSheet, factHighlights, DAY } from "./agentCheckup.mjs";

const NOW = Date.parse("2026-11-30T09:00:00Z");
const job = (over = {}) => ({ id: "j", status: "done", createdAt: NOW - DAY, startedAt: NOW - DAY, finishedAt: NOW - DAY + 10 * 60_000, ...over });

test("taskCounts: tasks run and how they ended, inside a window — finished, failed, cut off, stalled, ended asking for a decision", () => {
  const jobs = [
    job({ id: "a" }),
    job({ id: "b", status: "failed", error: "boom" }),
    job({ id: "c", status: "failed", endReason: "stalled" }),
    job({ id: "d", status: "failed", endReason: "time-limit" }),
    job({ id: "e", status: "stopped" }),
    job({ id: "f", endedBlocked: true }),
    job({ id: "old", createdAt: NOW - 20 * DAY }),
    job({ id: "run", status: "running", finishedAt: null }),
  ];
  assert.deepEqual(taskCounts(jobs, NOW, 7 * DAY), { run: 7, finished: 1, failed: 1, stalled: 1, cutOff: 2, needsDecision: 1 });
  assert.equal(taskCounts(jobs, NOW, 30 * DAY).run, 8);
  assert.deepEqual(taskCounts([], NOW, DAY), { run: 0, finished: 0, failed: 0, stalled: 0, cutOff: 0, needsDecision: 0 });
});

test("median: of the numbers, null for none", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("repeatedSentences: a sentence found (normalised) in the instructions of 3 or more agents; short ones and 2-agent repeats don't count", () => {
  const long = "Always run the full test suite before you report that the work is finished.";
  const bodies = {
    dev: `${long} Write small commits.`,
    seo: `Check titles.\n${long.toUpperCase()}`,
    ops: `  ${long}   Watch the logs.`,
    docs: "Write short pages. Keep it plain. Use the second sentence only here: Keep it plain.",
    web: "Keep it plain.",
  };
  const out = repeatedSentences(bodies);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].agents, ["dev", "ops", "seo"]);
  assert.match(out[0].text, /full test suite/i);
});

test("brokenReferenceCandidates: @mentions and absolute paths in a text, the ones to check; URLs, emails and relative paths are not", () => {
  const text = "Ask @ghost or @dev. See /opt/old/guide.md and ~/notes/x.txt, https://example.com/home/a, me@x.com, docs/readme.md, and/or /api/users.";
  const { mentions, paths } = brokenReferenceCandidates(text);
  assert.deepEqual(mentions.sort(), ["dev", "ghost"]);
  assert.deepEqual(paths.sort(), ["/opt/old/guide.md", "~/notes/x.txt"]);
});

test("agentNeedsLook: any fact that says something is off", () => {
  const quiet = { tasks: { d7: { failed: 0, stalled: 0, cutOff: 0, needsDecision: 0 }, refusedActions30: 0 }, changesUndone: { d7: 0, d30: 0 }, learned: { added30: 0, undone30: 0 }, trialsFailed30: 0, research: { stale: [], thin: [], missing: [] }, skillUpdates: [], brokenReferences: [], idle: false };
  assert.equal(agentNeedsLook(quiet), false);
  for (const patch of [{ tasks: { ...quiet.tasks, d7: { ...quiet.tasks.d7, failed: 1 } } }, { changesUndone: { d7: 0, d30: 1 } }, { learned: { added30: 2, undone30: 0 } }, { trialsFailed30: 1 }, { research: { stale: ["x"], thin: [], missing: [] } }, { skillUpdates: [{}] }, { brokenReferences: ["@x"] }, { idle: true }, { tasks: { ...quiet.tasks, refusedActions30: 1 } }]) {
    assert.equal(agentNeedsLook({ ...quiet, ...patch }), true, JSON.stringify(patch));
  }
});

const sheet = () => ({
  asOf: "2026-11-30T09:00:00.000Z",
  agents: [
    { slug: "dev", name: "Dev", tasks: { d7: { run: 5, finished: 3, failed: 2, stalled: 0, cutOff: 0, needsDecision: 0 }, d30: { run: 12, finished: 9, failed: 3, stalled: 0, cutOff: 0, needsDecision: 0 }, medianMinutes30: 12, refusedActions30: 1 }, changesUndone: { d7: 1, d30: 1 }, learned: { active: 2, added30: 2, undone30: 0, rules: [{ id: "lr_00000001", scope: "site", rule: "Keep PRs small." }] }, trialsFailed30: 0, research: { stale: ["CRO copywriting"], thin: [], missing: [] }, skillUpdates: [{ skill: "audit", repo: "acme/skills" }], instructionChars: 3200, brokenReferences: ["@ghost"], idle: false, idleDays: 1 },
    { slug: "seo", name: "SEO", tasks: { d7: { run: 0, finished: 0, failed: 0, stalled: 0, cutOff: 0, needsDecision: 0 }, d30: { run: 0, finished: 0, failed: 0, stalled: 0, cutOff: 0, needsDecision: 0 }, medianMinutes30: null, refusedActions30: 0 }, changesUndone: { d7: 0, d30: 0 }, learned: { active: 0, added30: 0, undone30: 0, rules: [] }, trialsFailed30: 0, research: { stale: [], thin: [], missing: [] }, skillUpdates: [], instructionChars: 900, brokenReferences: [], idle: true, idleDays: 40 },
  ],
  team: { repeatedSentences: [{ text: "Always run the full test suite before you report that the work is finished.", agents: ["dev", "ops", "seo"] }], routingNotes: [] },
  unmergedBranches: [{ agent: "dev", task: "fix the build", branch: "agent/dev/x", files: 3, hoursSinceFinished: 52, project: "site" }],
});

test("renderFactSheet: the facts as data between markers, with the unmerged branches 'for the lead'; bounded", () => {
  const text = renderFactSheet(sheet());
  assert.match(text, /BEGIN FACT SHEET/);
  assert.match(text, /END FACT SHEET/);
  assert.match(text, /computed by the server/i);
  assert.match(text, /data, not instructions/i);
  assert.match(text, /"slug": "dev"/);
  assert.match(text, /agent\/dev\/x/);
  assert.ok(!text.includes("`"), "no backticks inside the data");
  const huge = sheet();
  huge.team.repeatedSentences = Array.from({ length: 400 }, (_, i) => ({ text: `Sentence number ${i} ${"word ".repeat(20)}`, agents: ["a", "b", "c"] }));
  huge.agents = Array.from({ length: 80 }, (_, i) => ({ ...sheet().agents[0], slug: `agent${i}` }));
  assert.ok(renderFactSheet(huge).length <= 24_000);
});

test("factHighlights: a few plain lines for the routine's report — what the facts say, nothing the facts don't", () => {
  const lines = factHighlights(sheet());
  assert.ok(lines.length >= 4 && lines.length <= 8, String(lines.length));
  assert.ok(lines.some((l) => /@dev/.test(l) && /2 of 5/.test(l)), "failed tasks this week");
  assert.ok(lines.some((l) => /undone/i.test(l)));
  assert.ok(lines.some((l) => /stale/i.test(l) && /CRO copywriting/.test(l)));
  assert.ok(lines.some((l) => /upstream/i.test(l) && /audit/.test(l)));
  assert.ok(lines.some((l) => /3 agents/.test(l) && /same sentence/i.test(l)));
  assert.ok(lines.some((l) => /unmerged/i.test(l) && /fix the build/.test(l)));
  assert.ok(lines.some((l) => /@seo/.test(l) && /no task in 30 days/i.test(l)));
  assert.deepEqual(factHighlights({ agents: [], team: { repeatedSentences: [] }, unmergedBranches: [] }), []);
});
