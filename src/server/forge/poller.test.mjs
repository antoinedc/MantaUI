// src/server/forge/poller.test.mjs — the polling fallback (BET-798). Pure /
// injected only — no live tmux, opencode or network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createForgePoller, pollIssueLabels } from "./poller.mjs";

const repo = { owner: "anomalyco", repo: "manta" };

function issue(number, title, url = `https://github.com/anomalyco/manta/issues/${number}`) {
  return { number, title, url };
}

// ---------------------------------------------------------------------------
// pollIssueLabels — the ETag/304 de-dup (the "a 304 does not re-dispatch" rule)
// ---------------------------------------------------------------------------

test("pollIssueLabels emits issue.labeled events for matching labelled issues", async () => {
  const listIssues = async () => ({ data: [issue(1, "A"), issue(2, "B")] });
  const { events } = await pollIssueLabels({ repo, label: "manta", listIssues });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => ({ type: e.type, label: e.label, title: e.title, url: e.url })),
    [
      { type: "issue.labeled", label: "manta", title: "A", url: "https://github.com/anomalyco/manta/issues/1" },
      { type: "issue.labeled", label: "manta", title: "B", url: "https://github.com/anomalyco/manta/issues/2" },
    ],
  );
});

test("pollIssueLabels: unchanged list (a 304) does NOT re-dispatch", async () => {
  const listIssues = async () => ({ data: [issue(1, "A")] });
  const seen = new Set();
  const first = await pollIssueLabels({ repo, label: "manta", listIssues }, { seen });
  assert.equal(first.events.length, 1);
  // The next poll sees the SAME list (what a 304 returns) — no new events.
  const second = await pollIssueLabels({ repo, label: "manta", listIssues }, { seen });
  assert.equal(second.events.length, 0);
});

test("pollIssueLabels: a changed list (new ETag) dispatches only the new issue", async () => {
  const seen = new Set();
  const listIssues = async () => ({ data: [issue(1, "A")] });
  await pollIssueLabels({ repo, label: "manta", listIssues }, { seen });
  // Now a NEW issue appears (list changed) while #1 is unchanged.
  const changed = async () => ({ data: [issue(1, "A"), issue(2, "B")] });
  const res = await pollIssueLabels({ repo, label: "manta", listIssues: changed }, { seen });
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].title, "B");
});

// ---------------------------------------------------------------------------
// createForgePoller — the loop + webhook-vs-poll exclusivity
// ---------------------------------------------------------------------------

test("poller never polls a repo that has a working webhook", async () => {
  const polls = [];
  const done = await new Promise((resolve) => {
    createForgePoller({
      listRepos: async () => [
        { repoKey: "gh/ok/repo", webhookRegistered: true },
        { repoKey: "gh/no/repo", webhookRegistered: false },
      ],
      pollRepo: async (repo) => {
        polls.push(repo.repoKey);
        return { events: [] };
      },
      handleEvent: async () => {},
      intervalMs: 1_000_000,
    });
    setTimeout(() => resolve(), 200);
  });
  await done;
  // Only the repo WITHOUT a working webhook is polled; the registered one is
  // the webhook's job (never both for the same repo).
  assert.deepEqual(polls, ["gh/no/repo"]);
});

test("poller feeds pollRepo events to handleEvent", async () => {
  const ev = { type: "issue.labeled", label: "manta", url: "u" };
  const done = await new Promise((resolve) => {
    createForgePoller({
      listRepos: async () => [{ repoKey: "gh/ok/repo", webhookRegistered: false }],
      pollRepo: async () => ({ events: [ev] }),
      handleEvent: async (e) => {
        assert.equal(e.type, "issue.labeled");
        resolve(true);
      },
      intervalMs: 1_000_000,
    });
    setTimeout(() => resolve(false), 500);
  });
  assert.equal(done, true);
});
