// Server-side persistence tests for the session link primitive (§3.4⑥,
// BET-847) — the config.json round-trip through local.mjs. The pure
// accessors/mutators are covered in src/shared/sessionLink.test.ts; these cover
// persisting the field through the ONE existing config path and reading it back.
//
// MANTA_STATE_HOME is sandboxed by scripts/testSandbox.mjs (node --import) so
// config.json lives in a throwaway dir, never production state.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configGet,
  projectMetaUpsert,
  sessionLinkGet,
  linkSessionIssue,
  linkSessionPullRequest,
  clearSessionLink,
} from "./local.mjs";

const ISSUE = { repoKey: "github.com/acme/app", number: 12 };
const ISSUE2 = { repoKey: "github.com/acme/app", number: 34 };
const PR = { repoKey: "github.com/acme/app", number: 412 };

async function seed(sessionName) {
  await projectMetaUpsert({ tmuxSession: sessionName, defaultCwd: `/tmp/${sessionName}` });
  return sessionName;
}

test("session link: no-link project resolves null (default empty)", async () => {
  const name = await seed("bet847-empty");
  assert.equal(await sessionLinkGet(name), null);
  // an untracked session also resolves null
  assert.equal(await sessionLinkGet("bet847-untracked"), null);
});

test("session link: setting an issue link persists; saving a new issue replaces it", async () => {
  const name = await seed("bet847-issue");
  await linkSessionIssue(name, ISSUE);
  assert.deepEqual(await sessionLinkGet(name), { issue: ISSUE });
  await linkSessionIssue(name, ISSUE2);
  assert.deepEqual(await sessionLinkGet(name), { issue: ISSUE2 });
});

test("session link: persist → load round-trip preserves the link", async () => {
  const name = await seed("bet847-roundtrip");
  await linkSessionIssue(name, ISSUE);
  await linkSessionPullRequest(name, PR);
  const cfg = await configGet();
  const meta = cfg.projects.find((p) => p.tmuxSession === name);
  assert.deepEqual(meta?.link, { issue: ISSUE, pr: PR });
  assert.deepEqual(await sessionLinkGet(name), { issue: ISSUE, pr: PR });
});

test("session link: issue + PR slots independent; clear removes both", async () => {
  const name = await seed("bet847-independent");
  await linkSessionIssue(name, ISSUE);
  await linkSessionPullRequest(name, PR);
  assert.deepEqual(await sessionLinkGet(name), { issue: ISSUE, pr: PR });
  await clearSessionLink(name);
  assert.equal(await sessionLinkGet(name), null);
  const cfg = await configGet();
  assert.equal(cfg.projects.find((p) => p.tmuxSession === name)?.link, undefined);
});

test("session link: unknown session is a safe no-op", async () => {
  assert.equal(await linkSessionPullRequest("bet847-ghost", PR), null);
  assert.equal(await clearSessionLink("bet847-ghost"), null);
});
