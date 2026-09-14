// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIS,
  DOMAINS,
  LOCAL_CLIS,
  matchCliIdentity,
  matchDomainIdentity,
  matchIssueKeys,
  matchSecretIdentities,
  displayName,
} from "./ctoToolCatalog.mjs";

test("catalog CLI match labels known external tools", () => {
  assert.equal(matchCliIdentity("gh"), "github");
  assert.equal(matchCliIdentity("GH"), "github"); // case-insensitive
  assert.equal(matchCliIdentity("aws"), "aws");
  assert.equal(matchCliIdentity("flyctl"), "flyio");
  assert.equal(matchCliIdentity("supabase"), "supabase");
});

test("catalog CLI match marks local toolchain as never-evidence", () => {
  for (const t of ["git", "npm", "node", "ls", "grep", "curl", "cargo"]) {
    assert.equal(matchCliIdentity(t), "local", t);
  }
  assert.equal(LOCAL_CLIS.has("git"), true);
});

test("catalog CLI match returns null for unknown tokens (raw evidence)", () => {
  assert.equal(matchCliIdentity("totally-unknown-cli"), null);
  assert.equal(matchCliIdentity(""), null);
});

test("catalog domain match is suffix-aware", () => {
  assert.equal(matchDomainIdentity("github.com"), "github");
  assert.equal(matchDomainIdentity("api.github.com"), "github");
  assert.equal(matchDomainIdentity("hooks.slack.com"), "slack");
  assert.equal(matchDomainIdentity("api.stripe.com"), "stripe");
  assert.equal(matchDomainIdentity("unknown-crm.example.com"), null);
});

test("catalog domain match refuses private / own-box hosts", () => {
  assert.equal(matchDomainIdentity("localhost"), undefined);
  assert.equal(matchDomainIdentity("127.0.0.1"), undefined);
  assert.equal(matchDomainIdentity("192.168.1.4"), undefined);
  assert.equal(matchDomainIdentity("10.0.0.7"), undefined);
  assert.equal(matchDomainIdentity("mybox.local"), undefined);
  assert.equal(matchDomainIdentity("gateway.mantaui.com"), undefined);
  assert.equal(matchDomainIdentity("mantaui.com"), undefined);
  assert.equal(matchDomainIdentity("host.internal"), undefined);
});

test("catalog issue-key shape collects TEAM-123 tokens, deduped", () => {
  const text = "git checkout -b multica/BET-1395-tool-discovery && git commit -m 'BET-1395: scan' (fixes BET-42)";
  assert.deepEqual(matchIssueKeys(text), ["BET-1395", "BET-42"]);
  assert.deepEqual(matchIssueKeys("no keys here"), []);
  assert.deepEqual(matchIssueKeys(""), []);
});

test("catalog shapes are non-empty (a shipped list)", () => {
  assert.ok(Object.keys(CLIS).length >= 20);
  assert.ok(Object.keys(DOMAINS).length >= 40);
});

test("displayName humanizes identities", () => {
  assert.equal(displayName("github"), "GitHub");
  assert.equal(displayName("gcp"), "Google Cloud");
  assert.equal(displayName("some_unknown"), "Some_unknown");
  assert.equal(displayName(""), "");
});

// ---------------------------------------------------------------------------
// Secret key → tool identity: the mapping the access grant rides on. The
// VALUE is never an input — only the key name and the human-written hint.
// ---------------------------------------------------------------------------

test("secret keys map to the tool they name (catalog hit, else the service segment)", () => {
  // The required table.
  assert.equal(matchSecretIdentities("CAPO_MULTICA_TOKEN")[0], "multica");
  assert.equal(matchSecretIdentities("GITHUB_PAT")[0], "github");
  assert.equal(matchSecretIdentities("GITHUB_TOKEN")[0], "github");
  assert.equal(matchSecretIdentities("MODAL_TOKEN_ID")[0], "modal");
  assert.equal(matchSecretIdentities("NORDVPN_TOKEN")[0], "nordvpn");
  // A catalog alias resolves to the canonical identity, not the alias.
  assert.equal(matchSecretIdentities("GH_TOKEN")[0], "github");
  // Credential noise never wins: AWS_ACCESS_KEY_ID is about aws.
  assert.equal(matchSecretIdentities("AWS_ACCESS_KEY_ID")[0], "aws");
  assert.equal(matchSecretIdentities("OPENAI_API_KEY")[0], "openai");
  // camelCase and hyphens split the same way.
  assert.equal(matchSecretIdentities("stripeApiKey")[0], "stripe");
  assert.equal(matchSecretIdentities("linear-api-key")[0], "linear");
});

test("a key made only of credential vocabulary names NOTHING (no wildcard)", () => {
  for (const key of ["API_KEY", "TOKEN", "SECRET", "MY_TOKEN", "", "   ", "___"]) {
    assert.deepEqual(matchSecretIdentities(key), [], key);
  }
});

test("the other meaningful segments and the whole key stay reachable, nothing else", () => {
  const ids = matchSecretIdentities("CAPO_MULTICA_TOKEN");
  assert.deepEqual(ids, ["multica", "capo", "capo_multica_token"]);
  // The org prefix grants only a tool literally called "capo" — never a
  // neighbouring identity.
  assert.equal(ids.includes("github"), false);
});

test("a host in the hint is catalog evidence; an unknown or private host adds nothing", () => {
  assert.ok(matchSecretIdentities("DEPLOY_HOOK", "posts to https://api.vercel.com/v1").includes("vercel"));
  const none = matchSecretIdentities("DEPLOY_HOOK", "posts to https://127.0.0.1:8787 and mybox.local");
  assert.equal(none.includes("localhost"), false);
  assert.deepEqual(matchSecretIdentities("DEPLOY_HOOK", ""), ["hook", "deploy", "deploy_hook"]);
});
