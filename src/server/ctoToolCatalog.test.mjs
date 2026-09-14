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

test("identity detection is CANONICAL: casing cannot smuggle a second service past the ambiguity rule", () => {
  // The regression: `OpenAI` split into `Open` + `AI`, neither of which the
  // catalog knows — so the second service vanished and the key granted the
  // first one outright.
  assert.equal(matchSecretIdentity("GITHUB_OpenAI_TOKEN"), null);
  assert.equal(matchSecretIdentity("GITHUB_OPENAI_TOKEN"), null);
  assert.equal(matchSecretIdentity("OPENAI_GitHub_TOKEN"), null);
  // Every spelling of the same key agrees.
  for (const k of ["OPENAI_TOKEN", "openai_token", "OpenAI_Token", "openAiToken", "OpenAI-token"]) {
    assert.equal(matchSecretIdentity(k), "openai", k);
  }
  for (const k of ["GITHUB_TOKEN", "github_token", "GitHub_Token", "gitHubToken", "GITHUB.TOKEN"]) {
    assert.equal(matchSecretIdentity(k), "github", k);
  }
  // …and so does every spelling of an ambiguous one.
  for (const k of ["GITHUB_STRIPE_TOKEN", "githubStripeToken", "GitHub_Stripe", "STRIPE_GitHub_KEY", "github__stripe___token"]) {
    assert.equal(matchSecretIdentity(k), null, k);
  }
  // A camelCase run is read both ways (whole and per-word), so a name a human
  // reads as one word resolves as one word…
  assert.equal(matchSecretIdentity("myGitHubToken"), "github");
  assert.equal(matchSecretIdentity("awsS3Key"), "aws");
  // …but an EXPLICIT separator is a real boundary and is never joined across.
  assert.equal(matchSecretIdentity("GIT_HUB_TOKEN"), null);
});

test("format variance is normalized: separators, ordinals, and anything outside the key alphabet", () => {
  // Repeated / mixed separators are just separators.
  assert.equal(matchSecretIdentity("GITHUB___TOKEN"), "github");
  assert.equal(matchSecretIdentity("__GITHUB__"), "github");
  assert.equal(matchSecretIdentity("github.token"), "github");
  // A trailing ordinal is a second account, not a second tool.
  assert.equal(matchSecretIdentity("GITHUB2_TOKEN"), "github");
  assert.equal(matchSecretIdentity("AWS1_ACCESS_KEY"), "aws");
  assert.equal(matchSecretIdentity("GITHUB2_STRIPE1_TOKEN"), null, "ordinals do not hide ambiguity either");
  // Digits alone name nothing.
  assert.equal(matchSecretIdentity("2_TOKEN"), null);
  // A character outside the key alphabet is refused rather than treated as a
  // separator — a homoglyph must not be able to hide half of an ambiguous
  // key. (`isValidKey` already rejects these at the store; this is the
  // matcher holding its own contract.)
  assert.equal(matchSecretIdentity("GITHUB_\u041ePENAI_TOKEN"), null, "Cyrillic О");
  assert.equal(matchSecretIdentity("GITHUB TOKEN"), null);
  assert.equal(matchSecretIdentity("GITHUB\u200b_TOKEN"), null, "zero-width space");
});

test("analysis is TOTAL: a partially-read key can never produce a grant", () => {
  // The regression: words after the eighth were silently discarded, so this
  // key looked like it named ONE service and granted github — the dropped
  // tail was exactly the evidence that would have refused it.
  assert.equal(matchSecretIdentity("githubOneTwoThreeFourFiveSixSevenStripeToken"), null);
  // The old cap boundary, from both sides: ambiguity is seen wherever the
  // second service sits.
  assert.equal(matchSecretIdentity("githubOneTwoThreeFourFiveSixStripeToken"), null, "8th word");
  assert.equal(matchSecretIdentity("githubOneTwoThreeFourFiveSixSevenEightStripeToken"), null, "10th word");
  assert.equal(matchSecretIdentity("githubOneTwoThreeFourFiveSixSevenEightNineTenStripe"), null, "12th word");
  // A long key that is genuinely unambiguous still resolves.
  assert.equal(matchSecretIdentity("githubOneTwoThreeFourFiveSixSevenToken"), "github");
  // Beyond what a stored key can be (isValidKey caps at 64), it fails CLOSED
  // rather than analysing a prefix.
  assert.equal(matchSecretIdentity(`github_${"x".repeat(60)}`), null);
  assert.equal(matchSecretIdentity("a".repeat(65)), null);
  assert.equal(matchSecretIdentity(`GITHUB_${"O".repeat(58)}`), null, "64 chars is the last analysable length");
});

test("inherited object properties are not identities (the matcher owns its map)", () => {
  // The regression: `CLIS["constructor"]` returned Object's constructor, so
  // CONSTRUCTOR_TOKEN "matched" a tool that does not exist.
  for (const key of ["CONSTRUCTOR_TOKEN", "toString_TOKEN", "HASOWNPROPERTY_KEY", "__proto___TOKEN", "VALUEOF_TOKEN"]) {
    assert.equal(matchSecretIdentity(key), null, key);
  }
});

test("the hint is not an input: the matcher takes the KEY and nothing else", () => {
  // The regression: a hint mentioning github.com once granted GitHub.
  assert.equal(matchSecretIdentity.length, 1, "one parameter — there is no hint to consult");
  assert.equal(matchSecretIdentity("NORDVPN_TOKEN", "like the github.com one"), "nordvpn");
  assert.equal(matchSecretIdentity("DEPLOY_HOOK", "posts to https://api.vercel.com/v1"), null);
});
