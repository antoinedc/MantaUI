// Vitest for the session link primitive (§3.4⑥, BET-847) in
// src/shared/sessionLink.mjs — the pure accessors + mutators.
import { describe, expect, it } from "vitest";
import {
  sessionLink,
  linkIssue,
  linkPullRequest,
  clearLink,
} from "./sessionLink.mjs";

const ISSUE = { repoKey: "github.com/acme/app", number: 12 };
const ISSUE2 = { repoKey: "github.com/acme/app", number: 34 };
const PR = { repoKey: "github.com/acme/app", number: 412 };

// A ProjectMeta-like record, as persisted in config.json projects[].
function session(overrides = {}) {
  return { tmuxSession: "manta", defaultCwd: "/home/u/app", ...overrides };
}

describe("sessionLink", () => {
  it("resolves absent/null for a session with no link (default empty)", () => {
    expect(sessionLink(session())).toBeNull();
    expect(sessionLink(session({ link: null }))).toBeNull();
    expect(sessionLink(null)).toBeNull();
    expect(sessionLink(undefined)).toBeNull();
    expect(sessionLink({})).toBeNull();
  });

  it("returns only the slots that are set", () => {
    expect(sessionLink(session({ link: { pr: PR } }))).toEqual({ pr: PR });
    expect(sessionLink(session({ link: { issue: ISSUE } }))).toEqual({
      issue: ISSUE,
    });
    expect(sessionLink(session({ link: { issue: ISSUE, pr: PR } }))).toEqual({
      issue: ISSUE,
      pr: PR,
    });
  });

  it("vets a malformed stored link down to the usable slots rather than leaking it", () => {
    expect(sessionLink(session({ link: { pr: { repoKey: 7, number: "x" } } }))).toBeNull();
    expect(sessionLink(session({ link: { issue: ISSUE, pr: { number: 1 } } }))).toEqual({
      issue: ISSUE,
    });
  });
});

describe("linkIssue", () => {
  it("saves a new issue link, replacing the prior issue (single slot)", () => {
    const once = linkIssue(session(), ISSUE);
    expect(sessionLink(once)).toEqual({ issue: ISSUE });
    const twice = linkIssue(once, ISSUE2);
    // replaced, not appended
    expect(sessionLink(twice)).toEqual({ issue: ISSUE2 });
  });

  it("does not touch an existing PR link", () => {
    const withPr = linkPullRequest(session(), PR);
    const withBoth = linkIssue(withPr, ISSUE);
    expect(sessionLink(withBoth)).toEqual({ issue: ISSUE, pr: PR });
  });

  it("preserves the record's other fields", () => {
    const next = linkIssue(session(), ISSUE);
    expect(next.tmuxSession).toBe("manta");
    expect(next.defaultCwd).toBe("/home/u/app");
  });

  it("treats a null session as a fresh record", () => {
    expect(sessionLink(linkIssue(null, ISSUE))).toEqual({ issue: ISSUE });
  });

  it("throws on an invalid ref", () => {
    expect(() => linkIssue(session(), { repoKey: "", number: 1 })).toThrow(TypeError);
    expect(() => linkIssue(session(), { repoKey: "r", number: 0 })).toThrow(TypeError);
  });
});

describe("linkPullRequest", () => {
  it("saves a new PR link, replacing the prior PR (single slot)", () => {
    const once = linkPullRequest(session(), PR);
    const twice = linkPullRequest(once, { repoKey: PR.repoKey, number: 500 });
    expect(sessionLink(twice)).toEqual({
      pr: { repoKey: PR.repoKey, number: 500 },
    });
  });

  it("does not touch an existing issue link", () => {
    const withIssue = linkIssue(session(), ISSUE);
    const withBoth = linkPullRequest(withIssue, PR);
    expect(sessionLink(withBoth)).toEqual({ issue: ISSUE, pr: PR });
  });
});

describe("clearLink", () => {
  it("removes both slots", () => {
    const linked = linkPullRequest(linkIssue(session(), ISSUE), PR);
    expect(sessionLink(linked)).toEqual({ issue: ISSUE, pr: PR });
    const cleared = clearLink(linked);
    expect(sessionLink(cleared)).toBeNull();
    expect(cleared).not.toHaveProperty("link");
  });

  it("preserves the record's other fields", () => {
    const cleared = clearLink(session({ link: { pr: PR } }));
    expect(cleared.tmuxSession).toBe("manta");
    expect(cleared.defaultCwd).toBe("/home/u/app");
  });

  it("is a no-op (returns a cleared record) when already unlinked", () => {
    const cleared = clearLink(session());
    expect(sessionLink(cleared)).toBeNull();
  });
});
