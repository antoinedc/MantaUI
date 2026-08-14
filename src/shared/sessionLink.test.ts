// Vitest for the session link primitive (§3.4⑥, BET-847) in
// src/shared/sessionLink.mjs — the pure accessor.
import { describe, expect, it } from "vitest";
import { sessionLink } from "./sessionLink.mjs";

const ISSUE = { repoKey: "github.com/acme/app", number: 12 };
const PR = { repoKey: "github.com/acme/app", number: 412 };

// A link-carrying record, as read off the session record.
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
