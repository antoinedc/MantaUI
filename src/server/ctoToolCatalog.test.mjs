// BET-1469: fail fast, before ANY test body runs, when this file is executed
// outside the state sandbox. A CTO store module imported unsandboxed resolves
// its paths against the LIVE box state (~/.manta) and a test would write
// production data. `npm test` / `npm run test:server` set MANTA_STATE_HOME via
// scripts/testSandbox.mjs before any module is evaluated; a bare
// `node --test <file>` does not.
if (!process.env.MANTA_STATE_HOME) {
  throw new Error(
    "MANTA_STATE_HOME is not set — refusing to run CTO tests against the live box state. " +
      "Run via `npm test` or `npm run test:server` (both --import ./scripts/testSandbox.mjs), " +
      "or set MANTA_STATE_HOME to a throwaway directory first.",
  );
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIS,
  DOMAINS,
  LOCAL_CLIS,
  matchCliIdentity,
  matchDomainIdentity,
  matchIssueKeys,
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
