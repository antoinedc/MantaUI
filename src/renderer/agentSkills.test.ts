import { describe, expect, it } from "vitest";
import type { SkillProvenance } from "../shared/types";
import { applyGate, scriptKeys, candidateVerdictLabel, httpsUrl, provenanceLine, registryLine, skillOpLabel, skillSearchLine, skillSizeLine, skillsFoldPart } from "./agentSkills";

const prov = (over: Partial<SkillProvenance> = {}): SkillProvenance => ({ url: "https://github.com/acme/cro/blob/abc/SKILL.md", sourceId: "src_1", repo: "acme/cro", ref: "abc123", licence: "MIT", taken: "whole", ...over });

describe("agent skills helpers (Architect v2 §4)", () => {
  it("names what a proposed change does to a skill", () => {
    expect(skillOpLabel("add")).toBe("New skill");
    expect(skillOpLabel("replace")).toBe("Replaces skill");
    expect(skillOpLabel("remove")).toBe("Removes skill");
  });

  it("registryLine: installs and stars when known, nothing when not", () => {
    expect(registryLine({ installs: 12500, stars: 41100 })).toBe("12,500 installs · 41,100 stars");
    expect(registryLine({ installs: 1, stars: null })).toBe("1 install");
    expect(registryLine({ installs: null, stars: 1 })).toBe("1 star");
    expect(registryLine({ installs: null, stars: null })).toBeNull();
    expect(registryLine(undefined)).toBeNull();
  });

  it("provenanceLine: where a copied skill came from, its licence and how many used it; a written one says so", () => {
    expect(provenanceLine(prov({ registry: { installs: 12500, stars: null } }))).toBe("Copied from acme/cro · MIT · 12,500 installs");
    expect(provenanceLine(prov({ taken: "part" }))).toBe("Part copied from acme/cro · MIT");
    expect(provenanceLine(null)).toBe("Written for this agent");
  });

  it("httpsUrl only passes an https address (anything else is never made a link)", () => {
    expect(httpsUrl("https://github.com/a/b")).toBe("https://github.com/a/b");
    for (const bad of ["http://github.com/a/b", "javascript:alert(1)", "file:///etc/passwd", "", null, undefined, 4, "not a url"]) expect(httpsUrl(bad)).toBeNull();
  });

  it("skillsFoldPart counts the skills a change touches for the fold's label", () => {
    expect(skillsFoldPart(undefined)).toBeNull();
    expect(skillsFoldPart([])).toBeNull();
    expect(skillsFoldPart([{ name: "a", op: "add", paths: [], provenance: null, scripts: [] }])).toBe("1 skill");
    expect(skillsFoldPart([{ name: "a", op: "add", paths: [], provenance: null, scripts: [] }, { name: "b", op: "remove", paths: [], provenance: null, scripts: [] }])).toBe("2 skills");
  });

  it("skillSizeLine: files and size", () => {
    expect(skillSizeLine({ files: 1, bytes: 300 })).toBe("1 file · 300 bytes");
    expect(skillSizeLine({ files: 4, bytes: 1536 })).toBe("4 files · 1.5 KB");
    expect(skillSizeLine({ files: 2, bytes: 3 * 1024 * 1024 })).toBe("2 files · 3.0 MB");
  });

  it("the search the proposal ran: counts and verdict words", () => {
    expect(skillSearchLine({ queries: [{ source: "skills", query: "a" }], candidates: [] })).toBe("Searched for existing skills · 1 search · none found worth listing");
    expect(skillSearchLine({ queries: [{ source: "skills", query: "a" }, { source: "github", query: "b" }], candidates: [{ ref: "x", installs: null, stars: null, licence: null, verdict: "rejected", why: "w" }] })).toBe("Searched for existing skills · 2 searches · 1 skill looked at");
    expect(candidateVerdictLabel("used-whole")).toBe("Used whole");
    expect(candidateVerdictLabel("used-part")).toBe("Used in part");
    expect(candidateVerdictLabel("rejected")).toBe("Rejected");
  });

  it("scriptKeys lists every script of a change as name/path; applyGate says what is left to open", () => {
    const change = { state: "pending" as const, skillsDiff: [{ name: "a", op: "add" as const, paths: ["x.sh", "y.md"], provenance: null, scripts: ["x.sh"] }, { name: "b", op: "replace" as const, paths: ["z.py"], provenance: null, scripts: ["z.py"] }] };
    expect(scriptKeys(change)).toEqual(["a/x.sh", "b/z.py"]);
    expect(applyGate(change, new Set())).toEqual({ blocked: true, left: ["a/x.sh", "b/z.py"], title: "Open each script before applying: a/x.sh, b/z.py", line: "2 scripts left to open before this can be applied" });
    expect(applyGate(change, new Set(["a/x.sh"]))).toEqual({ blocked: true, left: ["b/z.py"], title: "Open each script before applying: b/z.py", line: "1 script left to open before this can be applied" });
    expect(applyGate(change, new Set(["a/x.sh", "b/z.py", "other"]))).toEqual({ blocked: false, left: [], title: null, line: null });
    expect(applyGate({ state: "pending", skillsDiff: undefined }, new Set())).toEqual({ blocked: false, left: [], title: null, line: null });
  });
});
