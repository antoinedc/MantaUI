// webhook.test.mjs — provider-aware forge hook registration + GitLab re-enable
// (BET-797 + BET-799). Pins: GitHub registers via the github endpoint + Bearer;
// GitLab registers via /projects/:path/hooks + PRIVATE-TOKEN with event
// booleans; and the health check RE-ENABLES a GitLab hook GitLab disabled.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateHookRequest,
  ensureRepoHook,
  healthCheckRepoHook,
  forgeHookUrl,
} from "./webhook.mjs";

const PUBLIC = "https://12998f00.boxes.mantaui.com";

test("gitlab buildCreateHookRequest addresses /projects/<encoded path>/hooks with PRIVATE-TOKEN", () => {
  const req = buildCreateHookRequest({
    kind: "gitlab",
    host: "gitlab.com",
    owner: "group/sub",
    repo: "widget",
    token: "glpat_x",
    deliveryToken: "ab".repeat(16),
    secret: "whsec_secret",
    events: ["issues", "pull_request"],
    publicBase: PUBLIC,
  });
  assert.equal(req.url, "https://gitlab.com/api/v4/projects/group%2Fsub%2Fwidget/hooks");
  assert.equal(req.headers["PRIVATE-TOKEN"], "glpat_x");
  assert.ok(!req.headers.authorization, "gitlab uses PRIVATE-TOKEN, not Bearer");
  assert.equal(req.body.url, forgeHookUrl(PUBLIC, "ab".repeat(16)));
  assert.equal(req.body.token, "whsec_secret", "the HMAC secret is delivered as GitLab's token");
  assert.equal(req.body.merge_requests_events, true, "review events map to MR events");
  assert.equal(req.body.issues_events, true);
});

test("github buildCreateHookRequest keeps the hosted endpoint + Bearer auth", () => {
  const req = buildCreateHookRequest({
    kind: "github",
    host: "github.com",
    owner: "acme",
    repo: "widget",
    token: "ghp_x",
    deliveryToken: "ab".repeat(16),
    secret: "whsec_secret",
    events: ["issues"],
    publicBase: PUBLIC,
  });
  assert.equal(req.url, "https://api.github.com/repos/acme/widget/hooks");
  assert.equal(req.headers.authorization, "Bearer ghp_x");
  assert.equal(req.body.config.secret, "whsec_secret");
});

test("ensureRepoHook with a gitlab kind POSTs to the project hooks endpoint", async () => {
  const calls = [];
  const api = async (method, url, _headers, body) => {
    calls.push({ method, url, body });
    if (method === "GET") return []; // no existing hook
    return { id: 9, active: true };
  };
  const res = await ensureRepoHook(
    {
      kind: "gitlab",
      host: "gitlab.com",
      owner: "group/sub",
      repo: "widget",
      token: "glpat_x",
      deliveryToken: "ab".repeat(16),
      publicBase: PUBLIC,
      events: ["issues"],
    },
    { api, now: () => "t" },
  );
  assert.equal(res.ok, true);
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post, "creates via POST");
  assert.match(post.url, /\/projects\/group%2Fsub%2Fwidget\/hooks$/);
  assert.equal(res.hookId, 9);
});

test("healthCheckRepoHook RE-ENABLES a GitLab hook GitLab disabled", async () => {
  const calls = [];
  const api = async (method, url, _h, body) => {
    calls.push({ method, url, body });
    if (method === "GET") return { id: 5, active: false, url: "https://hook/cb" };
    if (method === "PUT") return { id: 5, active: true };
    return [];
  };
  const res = await healthCheckRepoHook(
    { kind: "gitlab", host: "gitlab.com", owner: "acme", repo: "widget", token: "glpat_x", hookId: 5 },
    { api },
  );
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(res.reenabled, "a disabled gitlab hook is re-armed by the health check");
  assert.ok(put, "re-enable is a PUT");
  assert.match(put.url, /\/projects\/acme%2Fwidget\/hooks\/5$/);
  assert.equal(res.active, true);
});

test("healthCheckRepoHook leaves an active gitlab hook alone (no re-enable)", async () => {
  const calls = [];
  const api = async (method, url) => {
    calls.push({ method });
    if (method === "GET") return { id: 6, active: true };
    return [];
  };
  const res = await healthCheckRepoHook(
    { kind: "gitlab", host: "gitlab.com", owner: "acme", repo: "widget", token: "t", hookId: 6 },
    { api },
  );
  assert.equal(res.reenabled, false);
  assert.equal(calls.some((c) => c.method === "PUT"), false, "an active hook is never re-PUT");
});
