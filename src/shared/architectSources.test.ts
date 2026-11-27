import { describe, expect, it } from "vitest";
import {
  validateSource,
  validateSourceList,
  parseSourceList,
  sourcesOfAgentMd,
  hasYamlAliases,
  credentialLiterals,
  secretNamesOf,
  describeSource,
  diffSources,
} from "./architectSources.mjs";

const cmd = (extra: Record<string, unknown> = {}) => ({
  id: "bookface",
  name: "YC Bookface",
  description: "Private YC founder forum.",
  command: ["yc", "search", "{query}", "--type", "posts"],
  ...extra,
});
const url = (extra: Record<string, unknown> = {}) => ({
  id: "internal",
  name: "Internal search",
  description: "Our search.",
  url: "https://search.example.com/api/v1/search?q={query}&limit=20",
  ...extra,
});
const err = (raw: unknown) => {
  const r = validateSource(raw);
  expect(r.ok).toBe(false);
  return (r as { error: string }).error;
};

describe("validateSource", () => {
  it("accepts a command and a url source; private defaults to true", () => {
    const a = validateSource(cmd());
    expect(a.ok && a.source.private).toBe(true);
    const b = validateSource(url({ private: false }));
    expect(b.ok && b.source.private).toBe(false);
  });

  it("needs exactly one of command / url", () => {
    expect(err({ ...cmd(), url: "https://x.example.com/?q={query}" })).toMatch(/exactly one/);
    expect(err({ id: "x1", name: "n", description: "d" })).toMatch(/exactly one/);
  });

  it("refuses base ids, bad ids and unknown keys", () => {
    expect(err(cmd({ id: "hn" }))).toMatch(/built-in/);
    expect(err(cmd({ id: "skills" }))).toMatch(/built-in/); // the Architect's own skills search
    expect(err(cmd({ id: "Bad Id" }))).toMatch(/id/);
    expect(err(cmd({ other: 1 }))).toMatch(/unknown key/);
  });

  it("command: {query} exactly once, as a whole word, never in the program", () => {
    expect(err(cmd({ command: ["yc", "search"] }))).toMatch(/exactly once/);
    expect(err(cmd({ command: ["yc", "{query}", "{query}"] }))).toMatch(/exactly once/);
    expect(err(cmd({ command: ["yc", "--q={query}"] }))).toMatch(/whole word/);
    expect(err(cmd({ command: ["{query}", "x"] }))).toMatch(/program/);
    expect(err(cmd({ command: ["./yc", "{query}"] }))).toMatch(/bare name or an absolute path/);
    expect(validateSource(cmd({ command: ["/usr/bin/yc", "{query}"] })).ok).toBe(true);
  });

  it("url: https, one {query} as the whole value of one query parameter, no userinfo, no credential params", () => {
    expect(err(url({ url: "http://a.example.com/?q={query}" }))).toMatch(/https/);
    expect(err(url({ url: "https://a.example.com/{query}?x=1" }))).toMatch(/query parameter/);
    expect(err(url({ url: "https://a.example.com/?q=pre{query}" }))).toMatch(/whole value/);
    expect(err(url({ url: "https://u:p@a.example.com/?q={query}" }))).toMatch(/username/);
    expect(err(url({ url: "https://a.example.com/?q={query}&api_key=abc" }))).toMatch(/Secrets/);
    expect(err(url({ url: "https://a.example.com/?q={query}#frag" }))).toMatch(/fragment/);
    expect(err(url({ url: "https://a.example.com/?q={query}&r={query}" }))).toMatch(/exactly once/);
  });

  it("headers may not set Host, Cookie, Forwarded or X-Forwarded-*", () => {
    for (const h of ["Host", "cookie", "Forwarded", "X-Forwarded-For"]) expect(err(url({ headers: { [h]: "x" } }))).toMatch(/can't be set/);
    expect(validateSource(url({ headers: { Accept: "application/problem+json" } })).ok).toBe(true);
  });

  it("credential fields must be only a reference, with an optional scheme word", () => {
    expect(validateSource(url({ headers: { Authorization: "Bearer {secret:EXAMPLE_TOKEN}" } })).ok).toBe(true);
    expect(validateSource(url({ headers: { "X-Api-Key": "{secret:A_VERY_LONG_SECRET_NAME_WITH_MANY_CHARS_0123456789}" } })).ok).toBe(true);
    expect(err(url({ headers: { Authorization: "Bearer abc123" } }))).toMatch(/Secrets/);
    expect(err(url({ headers: { Authorization: "Bearer {secret:T} extra" } }))).toMatch(/Secrets/);
    expect(err(url({ headers: { "X-Service-Token": "literal" } }))).toMatch(/Secrets/);
    expect(err(cmd({ env: { YC_TOKEN: "literal" } }))).toMatch(/Secrets/);
    expect(validateSource(cmd({ env: { YC_TOKEN: "{secret:YC_TOKEN}" } })).ok).toBe(true);
  });

  it("{secret:…} is refused in argv and in the url", () => {
    expect(err(cmd({ command: ["yc", "{query}", "{secret:X}"] }))).toMatch(/only allowed in env and header/);
    expect(err(url({ url: "https://a.example.com/{secret:X}?q={query}" }))).toMatch(/only allowed in env and header/);
  });

  it("credential-like options are refused, spelled either way", () => {
    for (const bad of [["--token", "x"], ["--token=x"], ["--api-key", "x"], ["--password=x"], ["-p", "x"]]) {
      expect(err(cmd({ command: ["yc", "{query}", ...bad] }))).toMatch(/Secrets/);
    }
  });

  it("env cannot set PATH / HOME / LD_*", () => {
    expect(err(cmd({ env: { PATH: "/x" } }))).toMatch(/can't be set/);
    expect(err(cmd({ env: { LD_PRELOAD: "/x" } }))).toMatch(/can't be set/);
  });

  it("headers belong to url sources and env to command sources", () => {
    expect(err(cmd({ headers: { Accept: "x" } }))).toMatch(/headers go with a url/);
    expect(err(url({ env: { A: "b" } }))).toMatch(/env goes with a command/);
  });
});

describe("source lists", () => {
  it("validateSourceList refuses duplicates and more than 10", () => {
    expect(validateSourceList([cmd(), cmd()])).toMatchObject({ ok: false });
    const many = Array.from({ length: 11 }, (_, i) => cmd({ id: `s${i}` }));
    expect(validateSourceList(many)).toMatchObject({ ok: false });
  });

  it("parseSourceList keeps the valid ones and names what it skipped", () => {
    const r = parseSourceList([cmd(), { id: "x" }, cmd()]);
    expect(r.sources.map((s) => s.id)).toEqual(["bookface"]);
    expect(r.notes).toHaveLength(2);
  });

  it("sourcesOfAgentMd reads the frontmatter and refuses aliases for the whole file", () => {
    const text = `---\nname: Architect\ndescription: d\nsources:\n  - id: bookface\n    name: B\n    description: d\n    command: [yc, "{query}"]\n---\nbody\n`;
    expect(sourcesOfAgentMd(text).sources.map((s) => s.id)).toEqual(["bookface"]);
    const aliased = `---\nname: A\ndescription: d\nx: &a\n  id: bookface\nsources: [*a]\n---\nbody\n`;
    expect(hasYamlAliases("a: &x 1\nb: *x")).toBe(true);
    const r = sourcesOfAgentMd(aliased);
    expect(r.refused).toBe(true);
    expect(r.sources).toEqual([]);
    expect(sourcesOfAgentMd("no front").sources).toEqual([]);
  });
});

describe("describing and diffing", () => {
  it("credentialLiterals lists free text without references and without credential fields", () => {
    const lits = credentialLiterals(url({ headers: { Authorization: "Bearer {secret:T}", Accept: "application/json" } }) as never);
    expect(lits).toContain("application/json");
    expect(lits.some((l) => l.includes("Bearer"))).toBe(false);
    expect(lits).toContain("https://search.example.com/api/v1/search");
    expect(credentialLiterals(cmd() as never)).toEqual(["search", "--type", "posts"]);
  });

  it("describeSource names the command, the host and the secrets", () => {
    const a = describeSource(cmd({ env: { YC_TOKEN: "{secret:YC_TOKEN}" } }) as never);
    expect(a.runs).toBe("yc search {query} --type posts");
    expect(a.secrets).toEqual(["YC_TOKEN"]);
    expect(a.line).toMatch(/Runs yc search \{query\}/);
    expect(describeSource(url() as never).host).toBe("search.example.com");
    expect(secretNamesOf(url({ headers: { A: "{secret:X} {secret:X}" } }) as never)).toEqual(["X"]);
  });

  it("diffSources flags added, changed, removed and private → public", () => {
    const a = validateSource(cmd()) as { ok: true; source: never };
    const b = validateSource(cmd({ private: false })) as { ok: true; source: never };
    const c = validateSource(url()) as { ok: true; source: never };
    expect(diffSources([a.source], [a.source])).toEqual([]);
    expect(diffSources([a.source], [b.source])[0]).toMatchObject({ change: "changed", privateToPublic: true });
    expect(diffSources([], [c.source])[0]).toMatchObject({ change: "added" });
    expect(diffSources([c.source], [])[0]).toMatchObject({ change: "removed" });
  });
});
