import { describe, it, expect } from "vitest";
import {
  parseRules,
  validateRules,
  matchRule,
  validateForgeRepoPath,
  type ForgeRule,
  type ForgeValidationError,
} from "./forgeRules.mjs";

// Narrow the discriminated parseRules result the way pluginManifest.test.ts
// does — `expect(r.ok).toBe(true)` does not narrow for TypeScript.
function okRules(r: ReturnType<typeof parseRules>): { on: Record<string, ForgeRule> } {
  if (!r.ok) throw new Error("expected ok result, got errors");
  return r.rules!;
}
function errs(r: ReturnType<typeof parseRules>): ForgeValidationError[] {
  return r.errors ?? [];
}

const VALID = `
on:
  issue.labeled:
    label: manta
    do: delegate
    prompt: "Complete {{url}}. Open a draft PR."
  checks.failed:
    branch: mine
    do: notify
  review.requested:
    do: inbox
`;

describe("parseRules", () => {
  it("parses a valid rules file", () => {
    const r = parseRules(VALID);
    expect(r.ok).toBe(true);
    expect(r.errors).toBeUndefined();
    const rules = okRules(r).on;
    expect(rules["issue.labeled"]).toEqual({
      do: "delegate",
      label: "manta",
      prompt: "Complete {{url}}. Open a draft PR.",
    });
    expect(rules["checks.failed"]).toEqual({ do: "notify", branch: "mine" });
    expect(rules["review.requested"]).toEqual({ do: "inbox" });
  });

  it("rejects an unknown event key by name", () => {
    const r = parseRules("on:\n  issuelabeled:\n    do: notify\n");
    expect(r.ok).toBe(false);
    expect(errs(r)).toContainEqual({
      path: "on.issuelabeled",
      message: 'unknown key "issuelabeled"',
    });
  });

  it("rejects an unknown key inside a rule by name", () => {
    const r = parseRules("on:\n  checks.failed:\n    brnach: mine\n    do: notify\n");
    expect(r.ok).toBe(false);
    expect(errs(r)).toContainEqual({
      path: "on.checks.failed.brnach",
      message: 'unknown key "brnach"',
    });
  });

  it("rejects an unknown verb", () => {
    const r = parseRules("on:\n  review.requested:\n    do: explode\n");
    expect(r.ok).toBe(false);
    expect(errs(r)[0].message).toContain("do: must be one of delegate, notify, inbox");
  });

  it("rejects a missing do", () => {
    const r = parseRules("on:\n  review.requested:\n    label: x\n");
    expect(r.ok).toBe(false);
    expect(errs(r).some((e) => e.path === "on.review.requested.do")).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    const r = parseRules("on: {}\noff: true\n");
    expect(r.ok).toBe(false);
    expect(errs(r)).toContainEqual({ path: "off", message: 'unknown key "off"' });
  });

  it("rejects prompt on a non-delegate rule", () => {
    const r = parseRules("on:\n  checks.failed:\n    do: notify\n    prompt: hi\n");
    expect(r.ok).toBe(false);
    expect(errs(r).some((e) => e.path === "on.checks.failed.prompt")).toBe(true);
  });

  it("rejects a prompt with an unsupported placeholder", () => {
    const r = parseRules(
      'on:\n  issue.labeled:\n    do: delegate\n    prompt: "shell {{cmd}}"\n',
    );
    expect(r.ok).toBe(false);
    expect(errs(r).some((e) => /unsupported placeholder/.test(e.message))).toBe(true);
  });

  it("accepts an empty on block as a valid editable shell", () => {
    const r = parseRules("on: {}\n");
    expect(r.ok).toBe(true);
    expect(okRules(r).on).toEqual({});
  });

  it("rejects a non-mapping on", () => {
    const r = parseRules("on: just-a-string\n");
    expect(r.ok).toBe(false);
    expect(errs(r)[0].path).toBe("on");
  });

  it("rejects non-string input", () => {
    expect(parseRules(undefined as unknown as string).ok).toBe(false);
    expect(parseRules(42 as unknown as string).ok).toBe(false);
  });

  it("rejects a non-mapping document", () => {
    const r = parseRules("[1,2,3]");
    expect(r.ok).toBe(false);
  });

  it("returns a yaml syntax error verbatim", () => {
    const r = parseRules("on: {\n  \n");
    expect(r.ok).toBe(false);
    expect(errs(r)[0].message).toMatch(/yaml parse/);
  });
});

describe("validateRules", () => {
  it("round-trips a valid parsed object", () => {
    const r = validateRules({
      on: { "issue.labeled": { do: "delegate", label: "manta", prompt: "Complete {{url}}." } },
    });
    expect(r.errors).toEqual([]);
  });

  it("reports errors for an invalid parsed object", () => {
    const r = validateRules({ on: { "review.requested": { do: "bogus" } } });
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects a non-object", () => {
    expect(validateRules(null).errors.length).toBeGreaterThan(0);
    expect(validateRules("x").errors.length).toBeGreaterThan(0);
  });
});

describe("matchRule", () => {
  const rules = okRules(parseRules(VALID));

  it("matches issue.labeled on label, returning the delegate config", () => {
    const m = matchRule({ type: "issue.labeled", label: "manta", url: "https://x", title: "T" }, rules);
    expect(m).toEqual({
      do: "delegate",
      label: "manta",
      prompt: "Complete {{url}}. Open a draft PR.",
    });
  });

  it("does not match issue.labeled with a different label", () => {
    expect(matchRule({ type: "issue.labeled", label: "other" }, rules)).toBeNull();
  });

  it("matches checks.failed on branch mine", () => {
    const m = matchRule({ type: "checks.failed", branch: "mine" }, rules);
    expect(m).toEqual({ do: "notify", branch: "mine" });
  });

  it("does not match checks.failed with a different branch", () => {
    expect(matchRule({ type: "checks.failed", branch: "other" }, rules)).toBeNull();
  });

  it("matches review.requested with no condition", () => {
    expect(matchRule({ type: "review.requested" }, rules)).toEqual({ do: "inbox" });
  });

  it("returns null for a non-match (unknown event type)", () => {
    expect(matchRule({ type: "pull_request.opened" }, rules)).toBeNull();
  });

  it("returns null for bad input", () => {
    expect(matchRule(null, rules)).toBeNull();
    expect(matchRule(undefined, rules)).toBeNull();
    expect(matchRule({ type: "issue.labeled", label: "manta", title: "T", url: "u" }, undefined)).toBeNull();
    expect(matchRule("issue.labeled" as never, rules)).toBeNull();
  });
});

describe("validateForgeRepoPath", () => {
  it("accepts a normal github repo", () => {
    expect(validateForgeRepoPath({ host: "github.com", owner: "anomalyco", repo: "manta" })).toEqual({
      ok: true,
    });
  });

  it("accepts a gitlab subgroup owner", () => {
    expect(
      validateForgeRepoPath({ host: "gitlab.com", owner: "group/subgroup", repo: "project" }),
    ).toEqual({ ok: true });
  });

  it("rejects a traversal repo name", () => {
    const r = validateForgeRepoPath({ host: "github.com", owner: "o", repo: ".." });
    expect(r.ok).toBe(false);
  });

  it("rejects a repo with a slash (escape)", () => {
    const r = validateForgeRepoPath({ host: "github.com", owner: "o", repo: "a/../../etc" });
    expect(r.ok).toBe(false);
  });

  it("rejects a dot-dot owner segment", () => {
    const r = validateForgeRepoPath({ host: "github.com", owner: "..", repo: "manta" });
    expect(r.ok).toBe(false);
  });

  it("rejects a leading-dot hidden component", () => {
    const r = validateForgeRepoPath({ host: ".hidden", owner: "o", repo: "manta" });
    expect(r.ok).toBe(false);
  });

  it("rejects empty / missing components", () => {
    expect(validateForgeRepoPath({ host: "", owner: "o", repo: "r" }).ok).toBe(false);
    expect(validateForgeRepoPath({ host: "github.com", owner: "", repo: "r" }).ok).toBe(false);
    expect(validateForgeRepoPath({ host: "github.com", owner: "o", repo: "" }).ok).toBe(false);
    expect(validateForgeRepoPath({} as never).ok).toBe(false);
  });

  it("rejects whitespace / unsafe chars", () => {
    expect(
      validateForgeRepoPath({ host: "github.com", owner: "o", repo: "my repo" }).ok,
    ).toBe(false);
  });
});
