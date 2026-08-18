import { describe, it, expect } from "vitest";
import {
  deriveProjectName,
  generateProjectName,
  projectDirFor,
  promptWindowName,
  slugifyProjectName,
  uniqueSessionName,
} from "./projectName.mjs";
import { ADJECTIVES, NOUNS } from "./friendlyWords.mjs";

describe("generateProjectName", () => {
  // Sequence of [0,1) values, cycling when exhausted.
  function seqRand(...vals: number[]) {
    let i = 0;
    return () => vals[i++ % vals.length];
  }

  it("returns the expected words for an injected sequence", () => {
    const a = 0;
    const b = 1;
    const c = 2;
    const rand = seqRand(
      (a + 0.5) / ADJECTIVES.length,
      (b + 0.5) / NOUNS.length,
      (c + 0.5) / NOUNS.length,
    );
    expect(generateProjectName(rand)).toBe(
      `${ADJECTIVES[a]}-${NOUNS[b]}-${NOUNS[c]}`,
    );
  });

  it("always matches ^[a-z]+-[a-z]+-[a-z]+$", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateProjectName()).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    }
  });
});

describe("slugifyProjectName", () => {
  it("lowercases and collapses non-alphanumeric runs to a single dash", () => {
    expect(slugifyProjectName("Snake Game")).toBe("snake-game");
    expect(slugifyProjectName("  My  App!! ")).toBe("my-app");
  });

  it("returns '' for empty or all-punctuation input", () => {
    expect(slugifyProjectName("")).toBe("");
    expect(slugifyProjectName("!!!")).toBe("");
  });

  it("truncates to 32 characters", () => {
    expect(slugifyProjectName("a".repeat(40))).toBe("a".repeat(32));
  });

  it("strips a trailing hyphen left by 32-char truncation", () => {
    // Normalizes to `a`×31 + "-b" (33 chars); truncation at 32 leaves a
    // trailing "-", which must be stripped.
    expect(slugifyProjectName("a".repeat(31) + "-b")).toBe("a".repeat(31));
  });

  it("transliterates Latin diacritics via Unicode NFKD decomposition", () => {
    expect(slugifyProjectName("Café Résumé")).toBe("cafe-resume");
    expect(slugifyProjectName("Ångström IDE")).toBe("angstrom-ide");
    expect(slugifyProjectName("naïve—dash")).toBe("naive-dash"); // em-dash U+2014
  });

  it("returns '' for a script with no ASCII decomposition", () => {
    // A CJK name has no ASCII decomposition, so it yields no slug; callers
    // already handle '' as "no usable name".
    expect(slugifyProjectName("日本語")).toBe("");
  });
});

describe("projectDirFor", () => {
  it("joins a root and name without a trailing slash on the root", () => {
    expect(projectDirFor("/home/dev/code", "my-project")).toBe(
      "/home/dev/code/my-project",
    );
  });

  it("joins a root and name with trailing slash(es) on the root", () => {
    expect(projectDirFor("/home/dev/code/", "my-project")).toBe(
      "/home/dev/code/my-project",
    );
    expect(projectDirFor("/home/dev/code//", "my-project")).toBe(
      "/home/dev/code/my-project",
    );
  });
});

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

describe("uniqueSessionName", () => {
  it("returns the base name when it is free", () => {
    expect(uniqueSessionName("repo", new Set(["server", "other"]))).toBe("repo");
  });

  it("appends -2, -3, … until a free name is found", () => {
    expect(uniqueSessionName("repo", new Set(["repo"]))).toBe("repo-2");
    expect(uniqueSessionName("repo", new Set(["repo", "repo-2", "repo-3"]))).toBe("repo-4");
  });
});

describe("vendored friendly-words list", () => {
  it("every adjective matches ^[a-z]{2,10}$", () => {
    expect(ADJECTIVES.length).toBe(1391);
    for (const w of ADJECTIVES) {
      expect(w).toMatch(/^[a-z]{2,10}$/);
    }
  });

  it("every noun matches ^[a-z]{2,10}$", () => {
    expect(NOUNS.length).toBe(2907);
    for (const w of NOUNS) {
      expect(w).toMatch(/^[a-z]{2,10}$/);
    }
  });

  it("the longest possible generated name is <= 32 characters", () => {
    const longestAdj = Math.max(...ADJECTIVES.map((w) => w.length));
    const longestNoun = Math.max(...NOUNS.map((w) => w.length));
    // adjective + "-" + noun + "-" + noun
    expect(longestAdj + longestNoun + longestNoun + 2).toBeLessThanOrEqual(32);
  });
});
