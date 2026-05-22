import { describe, it, expect } from "vitest";
import { repairCorruptDirectory } from "./opencode";

// Regression: opencode persists `/home/<user>/~/...` when a session is created
// with a tilde directory — it joins its cwd ($HOME) with the literal `~/...`.
// The resulting path does not exist on disk, so every prompt scoped to it
// hangs. repairCorruptDirectory collapses the `/~/` segment back to a real
// absolute path.
describe("repairCorruptDirectory", () => {
  it("repairs the known /home/<user>/~/ corruption", () => {
    expect(repairCorruptDirectory("/home/dev/~/projects/better-ui")).toBe(
      "/home/dev/projects/better-ui",
    );
  });

  it("repairs corruption regardless of username", () => {
    expect(repairCorruptDirectory("/Users/antoine/~/code/x")).toBe(
      "/Users/antoine/code/x",
    );
  });

  it("leaves a clean absolute path untouched", () => {
    expect(repairCorruptDirectory("/home/dev/projects/better-ui")).toBe(
      "/home/dev/projects/better-ui",
    );
  });

  it("leaves a path with a trailing slash untouched", () => {
    expect(repairCorruptDirectory("/home/dev/projects/")).toBe(
      "/home/dev/projects/",
    );
  });

  it("does not touch a tilde that is not a standalone /~/ segment", () => {
    // A component merely containing ~ is not the corruption shape.
    expect(repairCorruptDirectory("/home/dev/proj~ect/x")).toBe(
      "/home/dev/proj~ect/x",
    );
  });

  it("repairs only the first /~/ segment (corruption produces exactly one)", () => {
    expect(repairCorruptDirectory("/home/dev/~/a/~/b")).toBe(
      "/home/dev/a/~/b",
    );
  });

  it("handles an empty string", () => {
    expect(repairCorruptDirectory("")).toBe("");
  });
});
