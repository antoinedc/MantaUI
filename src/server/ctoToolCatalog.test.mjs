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
  matchSecretIdentity,
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
// Secret key → tool identity: the mapping the access grant rides on. This is
// an AUTHORIZATION decision, so the tests below pin what must NOT be granted
// at least as hard as what must.
// ---------------------------------------------------------------------------

test("a key naming exactly one known tool grants that tool", () => {
  // The required table.
  assert.equal(matchSecretIdentity("CAPO_MULTICA_TOKEN"), "multica");
  assert.equal(matchSecretIdentity("GITHUB_PAT"), "github");
  assert.equal(matchSecretIdentity("GITHUB_TOKEN"), "github");
  assert.equal(matchSecretIdentity("MODAL_TOKEN_ID"), "modal");
  assert.equal(matchSecretIdentity("NORDVPN_TOKEN"), "nordvpn");
  // A catalog alias resolves to the canonical identity, not the alias.
  assert.equal(matchSecretIdentity("GH_TOKEN"), "github");
  // Credential noise never wins.
  assert.equal(matchSecretIdentity("AWS_ACCESS_KEY_ID"), "aws");
  assert.equal(matchSecretIdentity("OPENAI_API_KEY"), "openai");
  // A segment that IS an identity beats the CLI alias table's value.
  assert.equal(matchSecretIdentity("SENTRY_DSN"), "sentry");
  // camelCase and hyphens split the same way.
  assert.equal(matchSecretIdentity("stripeApiKey"), "stripe");
  assert.equal(matchSecretIdentity("linear-api-key"), "linear");
});

test("an org/codename prefix is NOT a tool — it can never be granted on its own", () => {
  // The regression: CAPO_MULTICA_TOKEN once granted `capo` as well.
  assert.equal(matchSecretIdentity("CAPO_MULTICA_TOKEN"), "multica");
  assert.equal(matchSecretIdentity("CAPO_TOKEN"), null, "an unknown prefix alone names nothing");
  assert.equal(matchSecretIdentity("ACME_INTERNAL_TOKEN"), null);
});

test("a key naming TWO known services is ambiguous and grants NEITHER", () => {
  // The regression: GITHUB_STRIPE_TOKEN once granted both.
  assert.equal(matchSecretIdentity("GITHUB_STRIPE_TOKEN"), null);
  assert.equal(matchSecretIdentity("AWS_GITHUB_DEPLOY_KEY"), null);
  // A service repeated is still one service.
  assert.equal(matchSecretIdentity("GITHUB_GITHUB_TOKEN"), "github");
});

test("an unknown or noise-only key names NOTHING (no wildcard, no minting)", () => {
  for (const key of ["API_KEY", "TOKEN", "SECRET", "MY_TOKEN", "FOO_BAR_TOKEN", "", "   ", "___", "12_34"]) {
    assert.equal(matchSecretIdentity(key), null, key);
  }
});

test("the hint is not an input: the matcher takes the KEY and nothing else", () => {
  // The regression: a hint mentioning github.com once granted GitHub.
  assert.equal(matchSecretIdentity.length, 1, "one parameter — there is no hint to consult");
  assert.equal(matchSecretIdentity("NORDVPN_TOKEN", "like the github.com one"), "nordvpn");
  assert.equal(matchSecretIdentity("DEPLOY_HOOK", "posts to https://api.vercel.com/v1"), null);
});
