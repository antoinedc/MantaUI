import { describe, it, expect } from "vitest";
import {
  detectForge,
  repoKey,
  repoKeyParts,
  normalizePrState,
  rollupChecks,
  UnsupportedByForgeError,
  unsupportedByForge,
} from "./forge.mjs";

const OWNER_REPO = { kind: "github", host: "github.com", owner: "owner", repo: "repo" };

describe("detectForge", () => {
  it("https with .git suffix", () => {
    expect(detectForge("https://github.com/owner/repo.git")).toEqual(OWNER_REPO);
  });
  it("https without .git", () => {
    expect(detectForge("https://github.com/owner/repo")).toEqual(OWNER_REPO);
  });
  it("scp-like form (git@host:owner/repo.git)", () => {
    expect(detectForge("git@github.com:owner/repo.git")).toEqual(OWNER_REPO);
  });
  it("ssh:// scheme", () => {
    expect(detectForge("ssh://git@github.com/owner/repo.git")).toEqual(OWNER_REPO);
  });
  it("GitLab subgroup -> owner is the full group/subgroup path", () => {
    expect(detectForge("https://gitlab.com/group/subgroup/project.git")).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "project",
    });
  });
  it("trailing slash is normalised", () => {
    expect(detectForge("https://github.com/owner/repo/")).toEqual(OWNER_REPO);
  });
  it("GitLab with trailing slash + subgroup", () => {
    expect(detectForge("https://gitlab.com/group/sub/proj/")).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      owner: "group/sub",
      repo: "proj",
    });
  });
  it("normalises case in host and path", () => {
    expect(detectForge("https://GITHUB.com/OWNER/Repo.git")).toEqual(OWNER_REPO);
    expect(detectForge("GIT@Github.COM:Owner/Repo.GIT")).toEqual(OWNER_REPO);
  });
  it("strips credentials from the URL — no credential substring survives", () => {
    const got = detectForge("https://x-access-token:SECRET@github.com/o/r.git");
    expect(got).toEqual({ kind: "github", host: "github.com", owner: "o", repo: "r" });
    const serialized = JSON.stringify(got);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("x-access-token");
    expect(serialized).not.toContain("@");
  });

  describe("returns null for non-remotes", () => {
    it("a local path", () => {
      expect(detectForge("/home/user/repo")).toBeNull();
      expect(detectForge("./relative/repo")).toBeNull();
    });
    it("an empty string", () => {
      expect(detectForge("")).toBeNull();
      expect(detectForge("   ")).toBeNull();
    });
    it("undefined and non-string input", () => {
      expect(detectForge(undefined)).toBeNull();
      expect(detectForge(null)).toBeNull();
      expect(detectForge(42 as never)).toBeNull();
      expect(detectForge({} as never)).toBeNull();
      expect(detectForge([] as never)).toBeNull();
    });
    it("a non-URL string", () => {
      expect(detectForge("not a url")).toBeNull();
    });
    it("an unsupported host (github/gitlab only — self-hosted is out of scope)", () => {
      expect(detectForge("https://bitbucket.org/owner/repo.git")).toBeNull();
      expect(detectForge("git@bitbucket.org:owner/repo.git")).toBeNull();
      expect(detectForge("https://github.example.com/owner/repo.git")).toBeNull();
      expect(detectForge("ssh://git@gitlab.example.org/a/b.git")).toBeNull();
    });
    it("a non-git URL scheme", () => {
      expect(detectForge("ftp://github.com/owner/repo.git")).toBeNull();
      expect(detectForge("file:///tmp/repo")).toBeNull();
    });
    it("a URL with no owner/repo path", () => {
      expect(detectForge("https://github.com/")).toBeNull();
      expect(detectForge("ssh://git@github.com/")).toBeNull();
      expect(detectForge("git@github.com:")).toBeNull();
    });
  });
});

describe("repoKey", () => {
  it("HTTPS and SSH forms of the same repo produce an identical key", () => {
    const https = repoKey(detectForge("https://github.com/anomalyco/manta.git")!);
    const ssh = repoKey(detectForge("git@github.com:anomalyco/manta.git")!);
    const sshUrl = repoKey(detectForge("ssh://git@github.com/anomalyco/manta.git")!);
    expect(https).toBe("github.com/anomalyco/manta");
    expect(ssh).toBe(https);
    expect(sshUrl).toBe(https);
  });
  it("normalises .git suffix, trailing slash and mixed case", () => {
    expect(repoKey(detectForge("https://github.com/A/Manta.git")!)).toBe(
      "github.com/a/manta",
    );
    expect(repoKey(detectForge("https://github.com/a/manta/")!)).toBe(
      "github.com/a/manta",
    );
  });
  it("keeps GitLab subgroups in the key", () => {
    expect(repoKey(detectForge("https://gitlab.com/Group/Sub/Proj.git")!)).toBe(
      "gitlab.com/group/sub/proj",
    );
  });
  it("is robust to direct input (normalises regardless of source)", () => {
    expect(repoKey({ host: "Github.Com", owner: "Owner", repo: "Repo.git" })).toBe(
      "github.com/owner/repo",
    );
  });
});

describe("repoKeyParts", () => {
  it("round-trips a flat github key back into forge identity", () => {
    expect(repoKeyParts("github.com/acme/widget")).toEqual({
      kind: "github",
      host: "github.com",
      owner: "acme",
      repo: "widget",
    });
  });
  it("round-trips a gitlab subgroup key, preserving the owners path", () => {
    expect(repoKeyParts("gitlab.com/group/sub/proj")).toEqual({
      kind: "gitlab",
      host: "gitlab.com",
      owner: "group/sub",
      repo: "proj",
    });
  });
  it("normalises case and strips a trailing .git", () => {
    expect(repoKeyParts("GITHUB.com/Acme/Widget.git")).toEqual({
      kind: "github",
      host: "github.com",
      owner: "acme",
      repo: "widget",
    });
  });
  it("is the inverse of repoKey(detectForge(...))", () => {
    const identity = detectForge("https://gitlab.com/Group/Sub/Proj.git")!;
    expect(repoKeyParts(repoKey(identity))).toEqual(identity);
  });
  it("returns null for a non-string, a short key, or an unknown host", () => {
    expect(repoKeyParts(undefined)).toBeNull();
    expect(repoKeyParts("github.com/acme")).toBeNull();
    expect(repoKeyParts("example.com/acme/widget")).toBeNull();
  });
});

describe("normalizePrState", () => {
  describe("GitHub", () => {
    it("open", () => {
      expect(normalizePrState({ state: "open" }, "github")).toBe("open");
    });
    it("closed, not merged", () => {
      expect(normalizePrState({ state: "closed", merged: false }, "github")).toBe("closed");
    });
    it("merged-as-closed -> merged (closed alone is ambiguous)", () => {
      expect(normalizePrState({ state: "closed", merged: true }, "github")).toBe("merged");
      expect(normalizePrState({ state: "closed", merged: true, draft: true }, "github")).toBe(
        "merged",
      );
    });
    it("draft open PR -> draft", () => {
      expect(normalizePrState({ state: "open", draft: true }, "github")).toBe("draft");
    });
    it("rejects an unknown raw state loudly", () => {
      expect(() => normalizePrState({ state: "opened" }, "github")).toThrow(/unknown github state/);
      expect(() => normalizePrState({ state: "merged" }, "github")).toThrow(/unknown github state/);
    });
  });

  describe("GitLab", () => {
    it("opened -> open (GitLab says 'opened', not 'open')", () => {
      expect(normalizePrState({ state: "opened" }, "gitlab")).toBe("open");
    });
    it("closed", () => {
      expect(normalizePrState({ state: "closed" }, "gitlab")).toBe("closed");
    });
    it("merged", () => {
      expect(normalizePrState({ state: "merged" }, "gitlab")).toBe("merged");
    });
    it("locked -> open (a locked MR is still open, its discussion is locked)", () => {
      expect(normalizePrState({ state: "locked" }, "gitlab")).toBe("open");
    });
    it("draft opened MR -> draft", () => {
      expect(normalizePrState({ state: "opened", draft: true }, "gitlab")).toBe("draft");
    });
    it("rejects an unknown raw state loudly", () => {
      expect(() => normalizePrState({ state: "open" }, "gitlab")).toThrow(/unknown gitlab state/);
    });
  });

  it("rejects an unknown kind", () => {
    expect(() => normalizePrState({ state: "open" }, "bitbucket" as never)).toThrow(
      /unknown bitbucket state/,
    );
  });
});

describe("rollupChecks", () => {
  const green = { name: "a", status: "completed", conclusion: "success" };
  const red = { name: "b", status: "completed", conclusion: "failure" };
  const pending = { name: "c", status: "in_progress" };

  it("none for empty input", () => {
    expect(rollupChecks([])).toBe("none");
  });
  it("any red wins, regardless of order", () => {
    expect(rollupChecks([green, red])).toBe("red");
    expect(rollupChecks([red, green])).toBe("red");
    expect(rollupChecks([red, pending])).toBe("red");
  });
  it("yellow when pending/running and no red (takes precedence over green)", () => {
    expect(rollupChecks([pending])).toBe("yellow");
    expect(rollupChecks([green, pending])).toBe("yellow");
    expect(rollupChecks([pending, green])).toBe("yellow");
  });
  it("green when all completed and succeeding", () => {
    expect(rollupChecks([green])).toBe("green");
    expect(rollupChecks([green, green])).toBe("green");
  });
  it("none when no check is red/pending/green (e.g. neutral/skipped)", () => {
    expect(rollupChecks([{ name: "n", status: "completed", conclusion: "neutral" }])).toBe(
      "none",
    );
    expect(rollupChecks([{ name: "s", status: "completed", conclusion: "skipped" }])).toBe(
      "none",
    );
    expect(rollupChecks([green, { name: "x", conclusion: "neutral" }])).toBe("green");
  });

  describe("recognised red conclusions and pending statuses", () => {
    it("red on failure/timeout/action_required conclusions", () => {
      for (const c of ["failure", "failed", "timed_out", "timeout", "action_required"]) {
        expect(rollupChecks([{ name: "c", conclusion: c }])).toBe("red");
      }
    });
    it("yellow on queued/pending/running/started statuses", () => {
      for (const s of ["queued", "pending", "in_progress", "running", "waiting", "started"]) {
        expect(rollupChecks([{ name: "c", status: s }])).toBe("yellow");
      }
    });
  });

  it("does not mutate, filter or discard the input array", () => {
    const checks = [green, red, pending];
    const copy = checks.map((c) => ({ ...c }));
    const result = rollupChecks(checks);
    expect(result).toBe("red");
    expect(checks).toEqual(copy);
    expect(checks).toHaveLength(copy.length);
    // The rollup is a string; the caller keeps the raw list — the array must
    // come back unchanged including the red entry it short-circuited on.
    expect(checks[1]).toEqual(red);
  });

  it("recognises the success conclusion as green", () => {
    expect(
      rollupChecks([{ name: "c", status: "completed", conclusion: "success" }]),
    ).toBe("green");
  });
});

describe("UnsupportedByForgeError", () => {
  it("is an instanceof Error", () => {
    expect(new UnsupportedByForgeError("gitlab", "pending_review")).toBeInstanceOf(Error);
  });
  it("carries both fields", () => {
    const err = unsupportedByForge("gitlab", "pending_review");
    expect(err.kind).toBe("gitlab");
    expect(err.capability).toBe("pending_review");
    expect(err.name).toBe("UnsupportedByForgeError");
  });
  it("builds a readable message and carries kind through unsupportedByForge", () => {
    const err = unsupportedByForge("github", "resolve_thread");
    expect(err.message).toContain("resolve_thread");
    expect(err.message).toContain("github");
    expect(err).toBeInstanceOf(UnsupportedByForgeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("github");
  });
  it("is throwable and catchable as Error", () => {
    try {
      throw unsupportedByForge("gitlab", "pending_review");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(UnsupportedByForgeError);
      expect((e as UnsupportedByForgeError).capability).toBe("pending_review");
    }
  });
});
