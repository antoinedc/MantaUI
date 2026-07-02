import { describe, it, expect } from "vitest";
import {
  PROJECT_DIR_PREFIX,
  slugifyProjectName,
  defaultCwdForName,
  nextCwdOnNameChange,
  isManualDirEdit,
  canCreateProject,
} from "./firstProjectLogic";

describe("slugifyProjectName", () => {
  it("lowercases and hyphenates spaces/punctuation", () => {
    expect(slugifyProjectName("My Cool App")).toBe("my-cool-app");
    expect(slugifyProjectName("Foo/Bar Baz")).toBe("foo-bar-baz");
  });

  it("keeps allowed path chars (dot, underscore, hyphen)", () => {
    expect(slugifyProjectName("my_app.v2-final")).toBe("my_app.v2-final");
  });

  it("collapses runs of separators and trims leading/trailing hyphens", () => {
    expect(slugifyProjectName("  --Hello   World!!  ")).toBe("hello-world");
    expect(slugifyProjectName("@@@edge@@@")).toBe("edge");
  });

  it("returns empty string for blank/whitespace-only names", () => {
    expect(slugifyProjectName("")).toBe("");
    expect(slugifyProjectName("   ")).toBe("");
    expect(slugifyProjectName("###")).toBe("");
  });
});

describe("defaultCwdForName", () => {
  it("nests the slug under ~/projects/", () => {
    expect(defaultCwdForName("My App")).toBe("~/projects/my-app");
    expect(defaultCwdForName("api")).toBe("~/projects/api");
  });

  it("yields the bare prefix for an empty name (never a dangling half-path)", () => {
    expect(defaultCwdForName("")).toBe(PROJECT_DIR_PREFIX);
    expect(defaultCwdForName("   ")).toBe(PROJECT_DIR_PREFIX);
  });
});

describe("nextCwdOnNameChange", () => {
  it("follows the name while the dir is untouched", () => {
    expect(nextCwdOnNameChange("api", "~/projects/old", false)).toBe("~/projects/api");
    expect(nextCwdOnNameChange("New Name", "anything", false)).toBe("~/projects/new-name");
  });

  it("leaves the user's dir alone once it's been manually edited", () => {
    expect(nextCwdOnNameChange("api", "/srv/custom", true)).toBe("/srv/custom");
    expect(nextCwdOnNameChange("", "/srv/custom", true)).toBe("/srv/custom");
  });
});

describe("isManualDirEdit", () => {
  it("is false when the typed dir matches what the name would auto-fill", () => {
    // Simulates the auto-fill writing the same value — not a deviation.
    expect(isManualDirEdit("my-app", "~/projects/my-app")).toBe(false);
  });

  it("is true the instant the dir deviates from the name-derived default", () => {
    expect(isManualDirEdit("my-app", "~/projects/my-app-2")).toBe(true);
    expect(isManualDirEdit("my-app", "/srv/x")).toBe(true);
    expect(isManualDirEdit("my-app", "")).toBe(true);
  });
});

describe("canCreateProject", () => {
  it("requires a non-blank name and a non-blank directory", () => {
    expect(canCreateProject("api", "~/projects/api")).toBe(true);
  });

  it("blocks when the name is blank", () => {
    expect(canCreateProject("", "~/projects/api")).toBe(false);
    expect(canCreateProject("   ", "~/projects/api")).toBe(false);
  });

  it("blocks when the directory was cleared (no silent $HOME fallback)", () => {
    expect(canCreateProject("api", "")).toBe(false);
    expect(canCreateProject("api", "   ")).toBe(false);
  });
});
