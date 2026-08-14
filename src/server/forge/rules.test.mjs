// src/server/forge/rules.test.mjs — the rules engine (BET-798). Pure + injected
// only: no live tmux, opencode or network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRulesEngine,
  normalizeEvent,
  substitutePrompt,
  eventLinkRef,
  DEFAULT_DELEGATE_PROMPT,
  AUTONOMOUS_JOB_CONTRACT,
} from "./rules.mjs";
import { parseRules } from "../../shared/forgeRules.mjs";

const REPO = "github.com/anomalyco/manta";

// A minimal hook record, matching what webhooks.mjs passes to forgeIngest.
function hook(repoKey = REPO) {
  return { repoKey, provider: "github" };
}

// Build an engine with recording spies so we can assert dispatch args.
function harness(overrides = {}) {
  const calls = {
    startDelegate: [],
    notify: [],
    invalidateInbox: [],
    refusals: [],
  };
  const engine = createRulesEngine({
    enabled: () => true,
    loadRules: async () => ({ ok: true, yaml: overrides.yaml ?? defaultYaml() }),
    startDelegate: async (input) => {
      calls.startDelegate.push(input);
      return overrides.startResult ?? { ok: true };
    },
    notify: async (input) => void calls.notify.push(input),
    invalidateInbox: async (input) => void calls.invalidateInbox.push(input),
    recordRefusal: async (input) => void calls.refusals.push(input),
    ...overrides.deps,
  });
  return { engine, calls };
}

function defaultYaml() {
  return [
    "on:",
    "  issue.labeled:",
    "    label: manta",
    "    do: delegate",
    '    prompt: "Complete {{url}}. Open a draft PR."',
    "  checks.failed:",
    "    do: notify",
    "  review.requested:",
    "    do: inbox",
  ].join("\n");
}

function labeledEvent(overrides = {}) {
  return {
    event: "issues",
    payload: {
      action: "labeled",
      label: { name: "manta" },
      issue: { title: "Do the thing", html_url: "https://github.com/anomalyco/manta/issues/12" },
      sender: { login: "someone" },
      repository: { full_name: "anomalyco/manta", html_url: "https://github.com/anomalyco/manta" },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeEvent — the raw delivery → forge event mapping
// ---------------------------------------------------------------------------

test("normalizeEvent: issue.labeled maps action+label+title+url", () => {
  const ev = normalizeEvent(labeledEvent());
  assert.deepEqual(
    { type: ev.type, label: ev.label, title: ev.title, url: ev.url, fork: ev.fork },
    {
      type: "issue.labeled",
      label: "manta",
      title: "Do the thing",
      url: "https://github.com/anomalyco/manta/issues/12",
      fork: false,
    },
  );
});

test("normalizeEvent: non-labeled action is not a rule event", () => {
  assert.equal(normalizeEvent({ event: "issues", payload: { action: "opened" } }), null);
});

test("normalizeEvent: check_run failure maps to checks.failed with a branch", () => {
  const ev = normalizeEvent({
    event: "check_run",
    payload: {
      action: "completed",
      check_run: {
        status: "completed",
        conclusion: "failure",
        name: "typecheck",
        check_suite: { head_branch: "main" },
      },
      sender: { login: "bot" },
      repository: { full_name: "anomalyco/manta" },
    },
  });
  assert.equal(ev.type, "checks.failed");
  assert.equal(ev.branch, "main");
  assert.equal(ev.fork, false);
});

test("normalizeEvent: successful check is not a rule event", () => {
  assert.equal(
    normalizeEvent({
      event: "check_run",
      payload: { check_run: { status: "completed", conclusion: "success" } },
    }),
    null,
  );
});

test("normalizeEvent: review_requested on a fork head is refused as fork", () => {
  const ev = normalizeEvent({
    event: "pull_request",
    payload: {
      action: "review_requested",
      sender: { login: "someone" },
      pull_request: {
        title: "PR",
        html_url: "https://github.com/anomalyco/manta/pull/3",
        head: { ref: "feat", repo: { full_name: "somefork/manta", fork: true } },
      },
      repository: { full_name: "anomalyco/manta" },
    },
  });
  assert.equal(ev.type, "review.requested");
  assert.equal(ev.fork, true);
});

test("normalizeEvent: ping / unknown event is null", () => {
  assert.equal(normalizeEvent({ event: "ping", payload: {} }), null);
  assert.equal(normalizeEvent({ event: "nonsense", payload: {} }), null);
});

// ---------------------------------------------------------------------------
// substitutePrompt — placeholder substitution
// ---------------------------------------------------------------------------

test("substitutePrompt fills both placeholders", () => {
  assert.equal(
    substitutePrompt("Complete {{url}} about {{title}}.", { url: "U", title: "T" }),
    "Complete U about T.",
  );
});

test("substitutePrompt tolerates an absent placeholder", () => {
  assert.equal(
    substitutePrompt("Complete {{url}}.", { title: "T" }),
    "Complete .",
  );
});

// eventLinkRef — session-link from a normalised event (BET-844)
test("eventLinkRef: issue.labeled url links the ISSUE", () => {
  assert.deepEqual(eventLinkRef("github.com/owner/repo", { url: "https://github.com/owner/repo/issues/42" }), {
    issue: { repoKey: "github.com/owner/repo", number: 42 },
  });
});

test("eventLinkRef: review.requested url links the PR", () => {
  assert.deepEqual(eventLinkRef("github.com/owner/repo", { url: "https://github.com/owner/repo/pull/7" }), {
    pr: { repoKey: "github.com/owner/repo", number: 7 },
  });
});

test("eventLinkRef: GitLab merge_request url links the PR", () => {
  assert.deepEqual(eventLinkRef("gitlab.com/owner/repo", { url: "https://gitlab.com/owner/repo/-/merge_requests/88" }), {
    pr: { repoKey: "gitlab.com/owner/repo", number: 88 },
  });
});

test("eventLinkRef: checks.failed has no issue/PR number → null", () => {
  assert.equal(eventLinkRef("github.com/owner/repo", { url: "https://github.com/owner/repo" }), null);
});

test("eventLinkRef: missing url or repoKey → null", () => {
  assert.equal(eventLinkRef("github.com/owner/repo", {}), null);
  assert.equal(eventLinkRef(null, { url: "https://github.com/o/r/issues/1" }), null);
});

// ---------------------------------------------------------------------------
// Dispatch — each verb goes to its injected engine with the right arguments
// ---------------------------------------------------------------------------

test("delegate verb dispatches with substituted prompt and the job contract", async () => {
  const { engine, calls } = harness();
  const res = await engine.handleEvent({ hook: hook(), ...labeledEvent() });
  assert.equal(res.handled, true);
  assert.equal(res.verb, "delegate");
  assert.equal(calls.startDelegate.length, 1);
  const req = calls.startDelegate[0];
  assert.equal(req.repoKey, REPO);
  assert.equal(req.event.type, "issue.labeled");
  assert.match(req.prompt, /Complete https:\/\/github\.com\/anomalyco\/manta\/issues\/12/);
  assert.match(req.prompt, /Open a draft PR/);
  assert.match(req.prompt, /NEVER merge/);
});

test("delegate uses DEFAULT_DELEGATE_PROMPT when the rule has no prompt", async () => {
  const yaml = ["on:", "  issue.labeled:", "    label: manta", "    do: delegate"].join("\n");
  const { engine, calls } = harness({ yaml });
  await engine.handleEvent({ hook: hook(), ...labeledEvent() });
  assert.equal(calls.startDelegate.length, 1);
  assert.match(calls.startDelegate[0].prompt, new RegExp(DEFAULT_DELEGATE_PROMPT.replace("{{url}}", "https://github\\.com/anomalyco/manta/issues/12")));
  assert.match(calls.startDelegate[0].prompt, /NEVER merge/);
});

test("notify verb dispatches to the notification router", async () => {
  const yaml = ["on:", "  checks.failed:", "    do: notify"].join("\n");
  const { engine, calls } = harness({ yaml });
  const res = await engine.handleEvent({
    hook: hook(),
    event: "check_run",
    payload: {
      check_run: { status: "completed", conclusion: "failure", name: "typecheck", check_suite: { head_branch: "main" } },
      sender: { login: "someone" },
      repository: { full_name: "anomalyco/manta" },
    },
  });
  assert.equal(res.handled, true);
  assert.equal(res.verb, "notify");
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].event.type, "checks.failed");
});

test("inbox verb invalidates the inbox cache and does nothing else", async () => {
  const yaml = ["on:", "  review.requested:", "    do: inbox"].join("\n");
  const { engine, calls } = harness({ yaml });
  const res = await engine.handleEvent({
    hook: hook(),
    event: "pull_request",
    payload: {
      action: "review_requested",
      sender: { login: "someone" },
      pull_request: { title: "PR", html_url: "u", head: { ref: "feat", repo: { full_name: "anomalyco/manta" } } },
      repository: { full_name: "anomalyco/manta" },
    },
  });
  assert.equal(res.handled, true);
  assert.equal(res.verb, "inbox");
  assert.equal(calls.invalidateInbox.length, 1);
  assert.equal(calls.startDelegate.length, 0);
  assert.equal(calls.notify.length, 0);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("toggle off → nothing dispatches", async () => {
  const engine = createRulesEngine({
    enabled: () => false,
    startDelegate: async () => {
      throw new Error("must not dispatch when disabled");
    },
  });
  const res = await engine.handleEvent({ hook: hook(), ...labeledEvent() });
  assert.deepEqual(res, { handled: false, reason: "disabled" });
});

test("self-caused event (box's own actor) is ignored", async () => {
  const engine = createRulesEngine({
    enabled: () => true,
    loadRules: async () => ({ ok: true, yaml: defaultYaml() }),
    self: "manta-bot",
    startDelegate: async () => {
      throw new Error("must not dispatch a self-caused event");
    },
  });
  const res = await engine.handleEvent({ hook: hook(), ...labeledEvent({ sender: { login: "manta-bot" } }) });
  assert.equal(res.handled, false);
  assert.equal(res.reason, "self-caused");
});

test("invalid rules file → nothing dispatches", async () => {
  const engine = createRulesEngine({
    enabled: () => true,
    loadRules: async () => ({ ok: true, yaml: "on:\n  issue.labeled:\n    wejiof: 1" }),
    startDelegate: async () => {
      throw new Error("must not dispatch on invalid rules");
    },
  });
  const res = await engine.handleEvent({ hook: hook(), ...labeledEvent() });
  assert.equal(res.handled, false);
  assert.equal(res.reason, "invalid rules");
});

test("fork-originated payload is refused and no job starts", async () => {
  const { engine, calls } = harness();
  const res = await engine.handleEvent({
    hook: hook(),
    event: "pull_request",
    payload: {
      action: "review_requested",
      sender: { login: "someone" },
      pull_request: { title: "PR", html_url: "u", head: { ref: "feat", repo: { full_name: "somefork/manta", fork: true } } },
      repository: { full_name: "anomalyco/manta" },
    },
  });
  assert.equal(res.handled, false);
  assert.equal(res.reason, "fork");
  assert.equal(calls.startDelegate.length, 0);
  assert.equal(calls.refusals.length, 1);
  assert.match(calls.refusals[0].reason, /fork-originated/);
});

test("cap reached → the refusal is recorded and no job starts", async () => {
  const { engine, calls } = harness({
    startResult: { ok: false, error: "too many background jobs running (5)." },
  });
  const res = await engine.handleEvent({ hook: hook(), ...labeledEvent() });
  assert.equal(res.handled, false);
  assert.equal(res.reason, "refused");
  assert.equal(calls.startDelegate.length, 1); // the one attempt is made
  assert.equal(calls.refusals.length, 1);
  assert.match(calls.refusals[0].reason, /too many background jobs/);
});

// ---------------------------------------------------------------------------
// parseRules is the shared validator (sanity: this issue does not re-model)
// ---------------------------------------------------------------------------

test("the shared validator parses the engine's example rules", () => {
  const parsed = parseRules(defaultYaml());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rules.on["issue.labeled"].do, "delegate");
});
