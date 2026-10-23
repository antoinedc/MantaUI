import { describe, expect, it } from "vitest";
import type { Project, SecretMeta } from "../shared/types";
import {
  buildAddInput,
  canAddSecret,
  computeOverrides,
  countByScope,
  editorState,
  filterSecrets,
  findSlotConflict,
  groupSecrets,
  isStale,
  isValidSecretKey,
  listChatWindows,
  overriddenInCount,
  relativeAge,
  resolveSessionLabel,
  shortSessionId,
} from "./secretsView";

function meta(p: Partial<SecretMeta> & { id: string; key: string; scope: SecretMeta["scope"] }): SecretMeta {
  return { sessionID: null, project: null, hint: "", hasValue: true, createdAt: 1, updatedAt: 1, ...p };
}

const win = (index: number, name: string, opencodeSessionId: string | null) => ({
  index,
  name,
  active: false,
  paneCurrentPath: "/x",
  opencodeSessionId,
});

const projects: Project[] = [
  { tmuxSession: "manta", defaultCwd: "~", attached: false, windows: [win(0, "secrets-ui", "ses_a"), win(1, "tui", null)] },
  { tmuxSession: "ronda", defaultCwd: "~", attached: false, windows: [win(0, "api", "ses_b")] },
];

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

describe("relativeAge / isStale", () => {
  it("formats short and long", () => {
    expect(relativeAge(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeAge(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(relativeAge(NOW - 41 * DAY, NOW)).toBe("41d ago");
    expect(relativeAge(NOW - 41 * DAY, NOW, true)).toBe("41 days ago");
    expect(relativeAge(NOW - 61 * DAY, NOW)).toBe("2mo ago");
    expect(relativeAge(NOW - 400 * DAY, NOW)).toBe("1y ago");
    expect(relativeAge(NOW - DAY, NOW, true)).toBe("1 day ago");
  });
  it("handles missing timestamps and a clock behind the stamp", () => {
    expect(relativeAge(null, NOW)).toBe("");
    expect(relativeAge(undefined, NOW)).toBe("");
    expect(relativeAge(NOW + 5000, NOW)).toBe("just now");
  });
  it("flags secrets older than ~3 months", () => {
    expect(isStale(NOW - 120 * DAY, NOW)).toBe(true);
    expect(isStale(NOW - 10 * DAY, NOW)).toBe(false);
    expect(isStale(null, NOW)).toBe(false);
  });
});

describe("filterSecrets / countByScope", () => {
  const all = [
    meta({ id: "1", key: "GITHUB_PAT", scope: "shared", hint: "git push token" }),
    meta({ id: "2", key: "OPENAI_API_KEY", scope: "shared", hint: "batch eval" }),
    meta({ id: "3", key: "STRIPE_TEST_KEY", scope: "project", project: "manta", hint: "test-mode" }),
    meta({ id: "4", key: "TMP_DB_URL", scope: "session", sessionID: "ses_a", hint: "Git migration" }),
  ];
  it("matches key or hint case-insensitively", () => {
    expect(filterSecrets(all, "git", "all").map((s) => s.id)).toEqual(["1", "4"]);
    expect(filterSecrets(all, "  OPENAI ", "all").map((s) => s.id)).toEqual(["2"]);
    expect(filterSecrets(all, "", "all")).toHaveLength(4);
  });
  it("applies the scope filter after search", () => {
    expect(filterSecrets(all, "git", "shared").map((s) => s.id)).toEqual(["1"]);
    expect(filterSecrets(all, "", "project").map((s) => s.id)).toEqual(["3"]);
  });
  it("counts over the search-matched list", () => {
    expect(countByScope(all, "")).toEqual({ all: 4, shared: 2, project: 1, session: 1 });
    expect(countByScope(all, "git")).toEqual({ all: 2, shared: 1, project: 0, session: 1 });
  });
});

describe("session labels", () => {
  it("resolves workspace / window name from the tmux projects", () => {
    expect(resolveSessionLabel(projects, "ses_a")).toEqual({ label: "manta / secrets-ui", tmuxSession: "manta", windowIndex: 0 });
    expect(resolveSessionLabel(projects, "ses_b")?.label).toBe("ronda / api");
  });
  it("returns null for a closed chat", () => {
    expect(resolveSessionLabel(projects, "ses_gone")).toBeNull();
  });
  it("truncates long ids and leaves short ones alone", () => {
    expect(shortSessionId("ses_7f3a1b2c9d4e5f60")).toBe("ses_7f3a…5f60");
    expect(shortSessionId("ses_a")).toBe("ses_a");
  });
  it("lists only chat windows for the Add picker", () => {
    expect(listChatWindows(projects)).toEqual([
      { sessionID: "ses_a", label: "manta / secrets-ui" },
      { sessionID: "ses_b", label: "ronda / api" },
    ]);
  });
});

describe("groupSecrets", () => {
  const all = [
    meta({ id: "1", key: "A", scope: "shared" }),
    meta({ id: "2", key: "B", scope: "project", project: "ronda" }),
    meta({ id: "3", key: "C", scope: "project", project: "manta" }),
    meta({ id: "4", key: "D", scope: "project", project: "manta" }),
    meta({ id: "5", key: "E", scope: "session", sessionID: "ses_gone2" }),
    meta({ id: "6", key: "F", scope: "session", sessionID: "ses_b" }),
    meta({ id: "7", key: "G", scope: "session", sessionID: "ses_a" }),
    meta({ id: "8", key: "H", scope: "session", sessionID: "ses_a" }),
    meta({ id: "9", key: "I", scope: "session", sessionID: "ses_gone1" }),
  ];
  const g = groupSecrets(all, projects);
  it("splits into shared / projects / sessions", () => {
    expect(g.shared.map((s) => s.id)).toEqual(["1"]);
    expect(g.projects.map((p) => [p.project, p.items.length])).toEqual([["manta", 2], ["ronda", 1]]);
  });
  it("orders sessions: open chats by label, then closed by id, with labels", () => {
    expect(g.sessions.map((s) => s.sessionID)).toEqual(["ses_a", "ses_b", "ses_gone1", "ses_gone2"]);
    expect(g.sessions[0].label).toBe("manta / secrets-ui");
    expect(g.sessions[0].items.map((s) => s.id)).toEqual(["7", "8"]);
    expect(g.sessions[2].window).toBeNull();
    expect(g.sessions[2].label).toBe("ses_gone1");
  });
  it("is empty-safe", () => {
    expect(groupSecrets([], projects)).toEqual({ shared: [], projects: [], sessions: [] });
  });
});

describe("override cross-reference", () => {
  const all = [
    meta({ id: "sh1", key: "AWS", scope: "shared" }),
    meta({ id: "sh2", key: "ONLY_SHARED", scope: "shared" }),
    meta({ id: "pr1", key: "AWS", scope: "project", project: "manta" }),
    meta({ id: "pr2", key: "STRIPE", scope: "project", project: "manta" }),
    meta({ id: "se1", key: "AWS", scope: "session", sessionID: "ses_a" }), // manta → project wins
    meta({ id: "se2", key: "AWS", scope: "session", sessionID: "ses_b" }), // ronda → shared
    meta({ id: "se3", key: "AWS", scope: "session", sessionID: "ses_gone" }), // orphan → shared
    meta({ id: "se4", key: "FRESH", scope: "session", sessionID: "ses_a" }), // overrides nothing
    meta({ id: "se5", key: "STRIPE", scope: "session", sessionID: "ses_a" }), // project only
  ];
  it("names the highest tier each row shadows", () => {
    const o = computeOverrides(all, projects);
    expect(o.get("se1")).toBe("project");
    expect(o.get("se2")).toBe("shared");
    expect(o.get("se3")).toBe("shared");
    expect(o.has("se4")).toBe(false);
    expect(o.get("se5")).toBe("project");
    expect(o.get("pr1")).toBe("shared");
    expect(o.has("pr2")).toBe(false);
    expect(o.has("sh1")).toBe(false);
  });
  it("counts sessions that override a shared / project row", () => {
    const sh1 = all[0];
    expect(overriddenInCount(all, sh1, projects)).toBe(3);
    expect(overriddenInCount(all, all[1], projects)).toBe(0);
    expect(overriddenInCount(all, all[2], projects)).toBe(1); // only ses_a is in manta
    expect(overriddenInCount(all, all[4], projects)).toBe(0); // session rows are never overridden
  });
});

describe("editorState", () => {
  const orig = { key: "GITHUB_PAT", hint: "git" };
  const base = { key: "GITHUB_PAT", hint: "git", replacing: false, value: "" };
  it("is clean and unsaveable when nothing changed", () => {
    const s = editorState(orig, base);
    expect(s.dirty).toBe(false);
    expect(s.canSave).toBe(false);
    expect(s.patch).toEqual({});
  });
  it("treats whitespace-only hint edits as no change", () => {
    expect(editorState(orig, { ...base, hint: "  git " }).dirty).toBe(false);
  });
  it("sends only changed fields", () => {
    expect(editorState(orig, { ...base, hint: " new " }).patch).toEqual({ hint: "new" });
    expect(editorState(orig, { ...base, key: "GH_TOKEN" }).patch).toEqual({ key: "GH_TOKEN" });
    const both = editorState(orig, { ...base, key: "GH", hint: "", replacing: true, value: "v" });
    expect(both.patch).toEqual({ key: "GH", hint: "", value: "v" });
    expect(both.renamed).toBe(true);
  });
  it("only sends a value when the replace input is open and non-empty", () => {
    expect(editorState(orig, { ...base, replacing: true, value: "" }).canSave).toBe(false);
    expect(editorState(orig, { ...base, replacing: false, value: "leftover", hint: "x" }).patch).toEqual({ hint: "x" });
    expect(editorState(orig, { ...base, replacing: true, value: "v" }).canSave).toBe(true);
  });
  it("blocks save on an invalid new name, with an error", () => {
    const s = editorState(orig, { ...base, key: "2FA-CODE" });
    expect(s.valid).toBe(false);
    expect(s.keyError).toMatch(/Letters, digits/);
    expect(s.canSave).toBe(false);
    expect(editorState(orig, { ...base, key: "" }).canSave).toBe(false);
  });
  it("does not flag an unchanged legacy key as invalid", () => {
    expect(editorState({ key: "odd-key", hint: "" }, { key: "odd-key", hint: "h", replacing: false, value: "" }).canSave).toBe(true);
  });
});

describe("add dialog", () => {
  const d = { scope: "shared" as const, project: "", sessionID: "", key: "GITHUB_PAT", value: "v", hint: " push " };
  it("validates per scope", () => {
    expect(canAddSecret(d)).toBe(true);
    expect(canAddSecret({ ...d, value: "" })).toBe(false);
    expect(canAddSecret({ ...d, key: "bad-key" })).toBe(false);
    expect(canAddSecret({ ...d, scope: "project" })).toBe(false);
    expect(canAddSecret({ ...d, scope: "project", project: "manta" })).toBe(true);
    expect(canAddSecret({ ...d, scope: "session" })).toBe(false);
    expect(canAddSecret({ ...d, scope: "session", sessionID: "ses_a" })).toBe(true);
  });
  it("builds the secretsSet payload with explicit owners", () => {
    expect(buildAddInput(d)).toEqual({ key: "GITHUB_PAT", value: "v", scope: "shared", sessionID: null, project: null, hint: "push" });
    expect(buildAddInput({ ...d, scope: "project", project: "manta", sessionID: "ses_a", hint: "" })).toEqual({
      key: "GITHUB_PAT", value: "v", scope: "project", sessionID: null, project: "manta", hint: undefined,
    });
    expect(buildAddInput({ ...d, scope: "session", sessionID: "ses_a", project: "manta" })).toMatchObject({ scope: "session", sessionID: "ses_a", project: null });
  });
  it("shares the key rule with the server", () => {
    expect(isValidSecretKey("A_1")).toBe(true);
    expect(isValidSecretKey("1A")).toBe(false);
    expect(isValidSecretKey("A".repeat(65))).toBe(false);
  });
});

describe("findSlotConflict", () => {
  const all = [
    meta({ id: "1", key: "A", scope: "shared" }),
    meta({ id: "2", key: "A", scope: "project", project: "manta" }),
    meta({ id: "3", key: "A", scope: "session", sessionID: "ses_a" }),
  ];
  const d = { scope: "shared" as const, project: "", sessionID: "", key: "A", value: "v", hint: "" };
  it("finds the same-slot secret that saving would overwrite", () => {
    expect(findSlotConflict(all, d)?.id).toBe("1");
    expect(findSlotConflict(all, { ...d, scope: "project", project: "manta" })?.id).toBe("2");
    expect(findSlotConflict(all, { ...d, scope: "session", sessionID: "ses_a" })?.id).toBe("3");
  });
  it("ignores other owners and other names", () => {
    expect(findSlotConflict(all, { ...d, scope: "project", project: "ronda" })).toBeNull();
    expect(findSlotConflict(all, { ...d, scope: "session", sessionID: "ses_b" })).toBeNull();
    expect(findSlotConflict(all, { ...d, key: "B" })).toBeNull();
  });
});
