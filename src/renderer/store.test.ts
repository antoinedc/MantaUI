import { describe, it, expect } from "vitest";
import { resolveSessionOwner } from "./store";
import type { Project } from "../shared/types";

function proj(over: Partial<Project> & { tmuxSession: string }): Project {
  return {
    tmuxSession: over.tmuxSession,
    defaultCwd: over.defaultCwd ?? "~",
    attached: over.attached ?? false,
    windows: over.windows ?? [],
  };
}

describe("resolveSessionOwner", () => {
  it("returns null when no window owns the session id", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        windows: [
          { index: 0, name: "main", active: true, paneCurrentPath: "/x", opencodeSessionId: null },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_missing")).toBeNull();
  });

  it("finds the owning window and prefers paneCurrentPath over defaultCwd", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        defaultCwd: "~/bui",
        windows: [
          { index: 2, name: "feat", active: false, paneCurrentPath: "/abs/feat", opencodeSessionId: "ses_a" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_a")).toEqual({
      tmuxSession: "bui",
      windowIndex: 2,
      cwd: "/abs/feat",
    });
  });

  it("falls back to project defaultCwd when paneCurrentPath is empty", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        defaultCwd: "~/bui",
        windows: [
          { index: 1, name: "w", active: false, paneCurrentPath: "", opencodeSessionId: "ses_b" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_b")).toEqual({
      tmuxSession: "bui",
      windowIndex: 1,
      cwd: "~/bui",
    });
  });

  it("returns the first matching window across multiple projects", () => {
    const projects = [
      proj({ tmuxSession: "a", windows: [] }),
      proj({
        tmuxSession: "b",
        defaultCwd: "~/b",
        windows: [
          { index: 0, name: "w", active: true, paneCurrentPath: "/b", opencodeSessionId: "ses_c" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_c")).toEqual({
      tmuxSession: "b",
      windowIndex: 0,
      cwd: "/b",
    });
  });
});
