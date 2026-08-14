// forgeRules.test.mjs — saveRules' token resolution wiring (BET-810).
//
// saveRules is pure of the network path: io, publicBase, the token resolver
// and the hook registrar are all injected. These tests pin that the §3.3
// ladder result actually drives webhook registration — a gh-authenticated or
// secret-stored box must reach `ensureHook` with its token, a box with no
// token must fail registration loudly (not silently no-op), and the `forge.token`
// override must beat the resolver.

import { test } from "node:test";
import assert from "node:assert/strict";
import { saveRules, formatIssueRef, parseIssueRef } from "./forgeRules.mjs";

const VALID_YAML = "on:\n  issue.labeled:\n    do: notify\n";
const PUBLIC_BASE = "https://00000000000000000000000000000000.boxes.mantaui.com";

// Minimal in-memory io — saveRules only writes the rules file, then delegates
// registration to the injected ensureHook.
const io = { write: async () => {} };

function hookOk() {
  return async (args) => ({
    ok: true,
    secret: "whsec_x",
    hookId: 1,
    events: args.events,
    url: `${PUBLIC_BASE}/hook/deliverytoken`,
  });
}

test("saveRules registers the webhook with the resolved §3.3 token", async () => {
  let hookArgs = null;
  const res = await saveRules(
    { repo: "github.com/acme/widgets", yaml: VALID_YAML },
    {
      io,
      publicBase: () => PUBLIC_BASE,
      resolveToken: async () => ({ token: "ghp_box", source: "cli" }),
      ensureHook: (args) => (hookArgs = args, hookOk()(args)),
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.webhook.registered, true);
  assert.equal(hookArgs.token, "ghp_box");
  assert.equal(hookArgs.host, "github.com");
  assert.equal(hookArgs.owner, "acme");
  assert.equal(hookArgs.kind, "github", "a github.com repo registers as github");
});

test("saveRules fails registration loudly when no token resolves (rules still saved)", async () => {
  let ensureCalled = false;
  const res = await saveRules(
    { repo: "github.com/acme/widgets", yaml: VALID_YAML },
    {
      io,
      publicBase: () => PUBLIC_BASE,
      resolveToken: async () => null,
      ensureHook: () => (ensureCalled = true, hookOk()()),
    },
  );

  assert.equal(res.ok, true, "the rules file is still saved — the rules are the point");
  assert.equal(res.webhook.registered, false);
  assert.match(res.webhook.error, /no github\.com token configured/);
  assert.equal(ensureCalled, false, "a missing token must never reach the hook registrar");
});

test("saveRules passes the forge.token override, not the resolver", async () => {
  let hookArgs = null;
  const res = await saveRules(
    { repo: "github.com/acme/widgets", yaml: VALID_YAML },
    {
      forge: { token: "ghp_override" },
      io,
      publicBase: () => PUBLIC_BASE,
      // The resolver would win if the override didn't; it must not even be used.
      resolveToken: async () => ({ token: "ghp_resolver", source: "cli" }),
      ensureHook: (args) => (hookArgs = args, hookOk()(args)),
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.webhook.registered, true);
  assert.equal(hookArgs.token, "ghp_override");
});

test("saveRules reports webhook errors without throwing", async () => {
  const res = await saveRules(
    { repo: "github.com/acme/widgets", yaml: VALID_YAML },
    {
      io,
      publicBase: () => PUBLIC_BASE,
      resolveToken: async () => ({ token: "ghp_box", source: "cli" }),
      ensureHook: async () => ({ ok: false, error: "github 401" }),
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.webhook.registered, false);
  assert.equal(res.webhook.error, "github 401");
});

test("saveRules requires a public hostname before registration", async () => {
  let ensureCalled = false;
  const res = await saveRules(
    { repo: "github.com/acme/widgets", yaml: VALID_YAML },
    {
      io,
      publicBase: () => null,
      resolveToken: async () => ({ token: "ghp_box", source: "cli" }),
      ensureHook: () => (ensureCalled = true, hookOk()()),
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.webhook.registered, false);
  assert.match(res.webhook.error, /no public hostname/);
  assert.equal(ensureCalled, false);
});

// ---- formatIssueRef / parseIssueRef (BET-871) -------------------------------

test("formatIssueRef / parseIssueRef round-trip a canonical ref", () => {
  const ref = formatIssueRef({ repoKey: "github.com/acme/widget", number: 412 });
  assert.equal(ref, "github.com/acme/widget#412");
  assert.deepEqual(parseIssueRef(ref), { repoKey: "github.com/acme/widget", number: 412 });
});

test("formatIssueRef/parseIssueRef round-trip a GitLab subgroup owner", () => {
  const ref = formatIssueRef({ repoKey: "gitlab.com/group/subgroup/widget", number: 7 });
  assert.equal(ref, "gitlab.com/group/subgroup/widget#7");
  assert.deepEqual(parseIssueRef(ref), {
    repoKey: "gitlab.com/group/subgroup/widget",
    number: 7,
  });
});

test("formatIssueRef returns null for a repoKey parseRepoKey rejects", () => {
  assert.equal(formatIssueRef({ repoKey: "acme/widget", number: 1 }), null); // 2 parts
  assert.equal(formatIssueRef({ repoKey: "not a key", number: 1 }), null);
  assert.equal(formatIssueRef({ repoKey: "", number: 1 }), null);
  assert.equal(formatIssueRef({ repoKey: null, number: 1 }), null);
});

test("formatIssueRef returns null for a non-integer or non-positive number", () => {
  assert.equal(formatIssueRef({ repoKey: "github.com/acme/widget", number: 0 }), null);
  assert.equal(formatIssueRef({ repoKey: "github.com/acme/widget", number: -3 }), null);
  assert.equal(formatIssueRef({ repoKey: "github.com/acme/widget", number: 1.5 }), null);
  assert.equal(formatIssueRef({ repoKey: "github.com/acme/widget", number: "12" }), null);
  assert.equal(formatIssueRef({ repoKey: "github.com/acme/widget", number: NaN }), null);
});

test("parseIssueRef returns null for a malformed string", () => {
  assert.equal(parseIssueRef(null), null);
  assert.equal(parseIssueRef(undefined), null);
  assert.equal(parseIssueRef(42), null);
  assert.equal(parseIssueRef(""), null);
  assert.equal(parseIssueRef("github.com/acme/widget"), null); // no #
  assert.equal(parseIssueRef("#12"), null); // empty repoKey
  assert.equal(parseIssueRef("github.com/acme/widget#"), null); // empty number
});

test("parseIssueRef rejects a non-integer or non-positive number", () => {
  assert.equal(parseIssueRef("github.com/acme/widget#0"), null);
  assert.equal(parseIssueRef("github.com/acme/widget#-1"), null);
  assert.equal(parseIssueRef("github.com/acme/widget#1.5"), null);
  assert.equal(parseIssueRef("github.com/acme/widget#abc"), null);
  assert.equal(parseIssueRef("github.com/acme/widget#1_2"), null);
});

test("parseIssueRef rejects a repoKey parseRepoKey does not accept", () => {
  assert.equal(parseIssueRef("acme/widget#12"), null); // 2 parts
  assert.equal(parseIssueRef("github.com/acme#12"), null); // 2 parts
  assert.equal(parseIssueRef("/acme/widget#12"), null); // empty leading segment
});
