import { describe, it, expect } from "vitest";
import { deriveProjectName, promptWindowName } from "./NewSessionScreen";

describe("deriveProjectName", () => {
  it("extracts the basename from a path", () => {
    expect(deriveProjectName("~/code/leasebot")).toBe("leasebot");
    expect(deriveProjectName("/home/dev/code/my-project")).toBe("my-project");
  });

  it("handles trailing slash", () => {
    expect(deriveProjectName("~/code/foo/")).toBe("foo");
    expect(deriveProjectName("/a/b/c/")).toBe("c");
  });

  it("falls back to 'project' for empty or tilde", () => {
    expect(deriveProjectName("")).toBe("project");
    expect(deriveProjectName("~")).toBe("project");
    expect(deriveProjectName("~/")).toBe("project");
  });

  it("handles root", () => {
    expect(deriveProjectName("/")).toBe("project");
  });

  it("handles single-segment relative", () => {
    expect(deriveProjectName("foo")).toBe("foo");
  });
});

describe("promptWindowName", () => {
  it("derives a readable name from the first word of the prompt", () => {
    expect(promptWindowName("Deploy the billing service")).toBe("deploy");
    expect(promptWindowName("fix-login bug")).toBe("fix-login");
  });

  it("lowercases + strips non [a-z0-9_-] characters", () => {
    expect(promptWindowName("   ExplODE  ")).toBe("explode");
    expect(promptWindowName("'quote'")).toBe("quote");
  });

  it("falls back to 'session' for an empty / non-alphanumeric first word", () => {
    expect(promptWindowName("")).toBe("session");
    expect(promptWindowName("   ")).toBe("session");
    expect(promptWindowName("!!!!")).toBe("session");
  });
});
