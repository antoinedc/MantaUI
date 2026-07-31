import { describe, it, expect } from "vitest";
import { deriveProjectName } from "./NewSessionScreen";

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
