import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractIssueKey, classifyClosure, buildComment, run as runPrClosed } from "./multica-pr-closed.mjs";
import { run as runUnblock } from "./multica-unblock.mjs";
import { api, ApiError } from "./lib/multicaApi.mjs";

describe("extractIssueKey", () => {
  test("reads the key from the PR title", () => {
    assert.equal(
      extractIssueKey({ title: "BET-429: wire lazy Claude CLI install", headRef: "feature" }),
      "BET-429",
    );
  });

  test("falls back to the branch name", () => {
    assert.equal(
      extractIssueKey({ title: "wire lazy install", headRef: "multica/BET-429-claude-cli" }),
      "BET-429",
    );
  });

  test("title wins over branch — a branch is reused across attempts", () => {
    assert.equal(
      extractIssueKey({ title: "BET-430: probe", headRef: "multica/BET-429-old" }),
      "BET-430",
    );
  });

  test("null when neither carries a key", () => {
    assert.equal(extractIssueKey({ title: "chore: bump deps", headRef: "chore/bump" }), null);
    assert.equal(extractIssueKey({}), null);
  });
});

describe("classifyClosure", () => {
  test("merged short-circuits everything else", () => {
    const out = classifyClosure({ merged: true, baseRef: "parent", defaultBranch: "main" });
    assert.equal(out.kind, "merged");
  });

  test("closed against the default branch is abandoned", () => {
    const out = classifyClosure({ merged: false, baseRef: "main", defaultBranch: "main" });
    assert.equal(out.kind, "abandoned");
  });

  test("REGRESSION (BET-429): parent merged → stacked, not abandoned", () => {
    // PR #374 targeted multica/BET-421-onboarding-processpanel. When #373
    // merged, GitHub deleted that branch and auto-closed #374. The old workflow
    // called this abandoned and told the PM to reopen.
    const out = classifyClosure({
      merged: false,
      baseRef: "multica/BET-421-onboarding-processpanel",
      defaultBranch: "main",
      baseBranchExists: false,
      baseMerged: true,
    });
    assert.equal(out.kind, "stacked");
    assert.match(out.reason, /was merged/);
  });

  test("base branch gone but no merged PR found is still stacked", () => {
    const out = classifyClosure({
      merged: false,
      baseRef: "parent",
      defaultBranch: "main",
      baseBranchExists: false,
      baseMerged: false,
    });
    assert.equal(out.kind, "stacked");
    assert.match(out.reason, /no longer exists/);
  });

  test("a failed probe is not evidence of abandonment", () => {
    const out = classifyClosure({
      merged: false,
      baseRef: "parent",
      defaultBranch: "main",
      baseBranchExists: null,
      baseMerged: null,
    });
    assert.equal(out.kind, "stacked");
    assert.match(out.reason, /could not be checked/);
  });

  test("live unmerged parent means a person closed it", () => {
    const out = classifyClosure({
      merged: false,
      baseRef: "parent",
      defaultBranch: "main",
      baseBranchExists: true,
      baseMerged: false,
    });
    assert.equal(out.kind, "abandoned");
  });

  test("missing base ref degrades to abandoned, never crashes", () => {
    assert.equal(classifyClosure({}).kind, "abandoned");
    assert.equal(classifyClosure({ merged: false, defaultBranch: "trunk" }).kind, "abandoned");
  });

  test("default branch need not be called main", () => {
    assert.equal(
      classifyClosure({ merged: false, baseRef: "trunk", defaultBranch: "trunk" }).kind,
      "abandoned",
    );
  });
});

describe("buildComment", () => {
  const stacked = buildComment({
    kind: "stacked",
    key: "BET-429",
    reason: "its base branch `parent` was merged",
    headRef: "multica/BET-429-child",
    defaultBranch: "main",
  });
  const abandoned = buildComment({
    kind: "abandoned",
    key: "BET-430",
    reason: "it targeted `main` directly",
    headRef: "multica/BET-430-x",
    defaultBranch: "main",
  });

  test("INVARIANT: no comment ever tells anyone to reopen", () => {
    // A comment on an agent-assigned Multica issue dispatches a run, so the
    // word "reopen" is a wrong instruction with an agent behind it.
    for (const c of [stacked, abandoned]) assert.doesNotMatch(c, /reopen/i);
  });

  test("INVARIANT: every comment states that nothing changed", () => {
    for (const c of [stacked, abandoned]) assert.match(c, /[Nn]o status was changed/);
  });

  test("the stacked comment demands a check against the default branch", () => {
    assert.match(stacked, /already on `main`/);
    assert.match(stacked, /superseded/);
  });

  test("the stacked comment names both outcomes, and the branch in each", () => {
    assert.match(stacked, /cancel \*\*BET-429\*\* as superseded and delete `multica\/BET-429-child`/);
    assert.match(stacked, /rebase `multica\/BET-429-child` onto `main`/);
  });

  test("the branch name degrades to prose when the head ref is unknown", () => {
    const c = buildComment({ kind: "stacked", key: "BET-1", reason: "r", defaultBranch: "main" });
    assert.match(c, /delete the branch/);
    assert.doesNotMatch(c, /``/);
  });

  test("the abandoned comment does not claim a stack", () => {
    assert.doesNotMatch(abandoned, /stacked/i);
    assert.match(abandoned, /BET-430/);
  });
});

// ---------------------------------------------------------------------------
// Fail-loud writes + the shared Multica API helper (BET-504).
//
// These drive the sweep `run` loops with an injected fetch (the same injection
// pattern the pure-function tests use) — no real HTTP. The three behaviours
// BET-504 demands are locked in here: a failed WRITE fails the job, a failed
// READ does not, and a batch with one failing write still processes the rest
// before exiting non-zero.
// ---------------------------------------------------------------------------

/** A fetch stub that answers from a route table and records every call. */
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ method, url });
    const hit = routes.find((r) => r.method === method && url.includes(r.match));
    const status = hit ? hit.status : 404;
    const body = hit?.body ?? "";
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => (body ? JSON.parse(body) : {}),
    };
  };
  fn.calls = calls;
  return fn;
}

const B = "https://api.multica.ai";

describe("multicaApi helper", () => {
  test("a non-OK response makes the helper throw with the status and body", async () => {
    const fetchImpl = stubFetch([
      { method: "PUT", match: "/api/issues/BET-1", status: 500, body: "boom" },
    ]);
    await assert.rejects(
      api(B, "t", "/issues/BET-1?workspace_id=ws", { method: "PUT" }, fetchImpl),
      (e) => e instanceof ApiError && e.status === 500 && e.body === "boom",
    );
  });

  test("a read returning non-OK also surfaces as an ApiError (the sweep decides), not a silent two-oh-oh", async () => {
    const fetchImpl = stubFetch([
      { method: "GET", match: "/api/issues/BET-9", status: 503, body: "down" },
    ]);
    await assert.rejects(
      api(B, "t", "/issues/BET-9?workspace_id=ws", {}, fetchImpl),
      (e) => e instanceof ApiError && e.status === 503,
    );
  });
});

describe("BET-504 — a failed Multica write fails the job", () => {
  test("REGRESSION (BET-438): pr-closed's done-write failure exits non-zero", async () => {
    // The incident: PR #397 merged, the status write warn'd and the script
    // exited 0, so the issue sat `blocked` for 30 minutes looking healthy.
    const fetchImpl = stubFetch([
      { method: "PUT", match: "/api/issues/BET-99", status: 500, body: "nope" },
    ]);
    const code = await runPrClosed({
      event: {
        pull_request: {
          merged: true,
          title: "BET-99: wire x",
          head: { ref: "multica/BET-99-x" },
          base: { ref: "main" },
          number: 99,
        },
        repository: { owner: { login: "o" }, name: "r", default_branch: "main" },
      },
      multicaToken: "t",
      workspace: "ws",
      fetchImpl,
    });
    assert.equal(code, 1);
  });

  test("unblock: a write that lands badly exits non-zero", async () => {
    const fetchImpl = stubFetch([
      { method: "GET", match: "/api/issues?workspace_id=ws&status=blocked", status: 200, body: JSON.stringify({ issues: [{ identifier: "BET-1", status: "blocked", metadata: { waiting_on: "BET-10" } }] }) },
      { method: "GET", match: "/api/issues/BET-10", status: 200, body: JSON.stringify({ status: "done" }) },
      { method: "PUT", match: "/api/issues/BET-1", status: 500, body: "conflict" },
    ]);
    const code = await runUnblock({ token: "t", workspace: "ws", base: B, fetchImpl });
    assert.equal(code, 1);
  });
});

describe("BET-504 — a failed READ still warns and continues", () => {
  test("unblock: an unresolvable blocker read stays blocked and exits 0", async () => {
    const fetchImpl = stubFetch([
      { method: "GET", match: "/api/issues?workspace_id=ws&status=blocked", status: 200, body: JSON.stringify({ issues: [{ identifier: "BET-1", status: "blocked", metadata: { waiting_on: "BET-10" } }] }) },
      { method: "GET", match: "/api/issues/BET-10", status: 503, body: "down" },
    ]);
    // The blocker read fails -> BET-1 is treated as still blocked, so no write
    // happens and the sweep must NOT fail. This is the "a single issue that
    // cannot be fetched must not abort a sweep" rule.
    const code = await runUnblock({ token: "t", workspace: "ws", base: B, fetchImpl });
    assert.equal(code, 0);
  });
});

describe("BET-504 — a batch finishes before failing", () => {
  test("unblock: one failing write still processes the rest, then exits non-zero", async () => {
    const fetchImpl = stubFetch([
      { method: "GET", match: "/api/issues?workspace_id=ws&status=blocked", status: 200, body: JSON.stringify({ issues: [
        { identifier: "BET-1", status: "blocked", metadata: { waiting_on: "BET-10" } },
        { identifier: "BET-2", status: "blocked", metadata: { waiting_on: "BET-20" } },
      ] }) },
      { method: "GET", match: "/api/issues/BET-10", status: 200, body: JSON.stringify({ status: "done" }) },
      { method: "GET", match: "/api/issues/BET-20", status: 200, body: JSON.stringify({ status: "done" }) },
      { method: "PUT", match: "/api/issues/BET-1", status: 200, body: "{}" },
      { method: "PUT", match: "/api/issues/BET-2", status: 500, body: "db locked" },
    ]);
    const code = await runUnblock({ token: "t", workspace: "ws", base: B, fetchImpl });
    assert.equal(code, 1);
    // Both writes were attempted: the failing BET-2 write did not stop BET-1,
    // and neither was silently skipped after the other failed.
    const puts = fetchImpl.calls.filter((c) => c.method === "PUT").map((c) => c.url);
    assert.ok(puts.some((u) => u.includes("/api/issues/BET-1")), "BET-1 write attempted");
    assert.ok(puts.some((u) => u.includes("/api/issues/BET-2")), "BET-2 write attempted");
  });
});
