import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommandBackgroundReader,
  parseFrontmatter,
  commandNameFromPath,
  listMarkdownRecursive,
  readProjectConfigFromDisk,
} from "./commandBackground.mjs";

const HOME = "/home/u";
const GLOBAL_CMDS = `${HOME}/.config/opencode/commands`;
const PROJ = "/work/proj";
const md = (fm, body = "do it") => `---\n${fm}\n---\n${body}\n`;

/** An in-memory world: files = {path: text}, plus the injectable config/agent seams. */
function reader({ files = {}, globalConfig = {}, projectConfigs = {}, agents = [], ttlMs = 0, now, failing = {} } = {}) {
  const warns = [];
  const calls = { listAgents: 0, readGlobalConfig: 0 };
  const r = createCommandBackgroundReader({
    readGlobalConfig: async () => {
      calls.readGlobalConfig++;
      if (failing.globalConfig) throw new Error("unparseable");
      return globalConfig;
    },
    readProjectConfig: async (dir) => {
      if (failing.projectConfig) throw new Error("unparseable");
      return projectConfigs[dir] ?? null;
    },
    listAgents: async () => {
      calls.listAgents++;
      if (failing.agents) throw new Error("opencode down");
      return agents;
    },
    readFile: async (p) => {
      if (failing.files?.includes(p)) throw new Error("EACCES");
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    listMarkdown: async (dir) => {
      if (failing.dirs?.includes(dir)) throw new Error("EACCES");
      return Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith(".md")).sort();
    },
    homeDir: HOME,
    ttlMs,
    ...(now ? { now } : {}),
    warn: (m) => warns.push(m),
  });
  return { ...r, warns, calls };
}
const names = async (r, dir) => [...(await r.backgroundCommandNames(dir))].sort();

test("native `commands` key: subagent:true, or an agent whose mode is subagent", async () => {
  const r = reader({
    globalConfig: {
      commands: {
        bg: { template: "x", subagent: true },
        fg: { template: "x" },
        viaSub: { template: "x", agent: "explore" },
        viaPrimary: { template: "x", agent: "plan" },
        unknownAgent: { template: "x", agent: "ghost" },
        explicitFalse: { template: "x", subagent: false, agent: "explore" },
        notAnObject: "oops",
      },
    },
    agents: [{ name: "explore", mode: "subagent" }, { name: "plan", mode: "primary" }, { name: "build" }],
  });
  assert.deepEqual(await names(r), ["bg", "viaSub"]);
});

test("the V1 `command` key is not a source (its subagent field is ignored by V2)", async () => {
  const r = reader({ globalConfig: { command: { v1: { template: "x", subagent: true } } } });
  assert.deepEqual(await names(r), []);
});

test("global .md frontmatter: subagent:true, agent→subagent, nested dir keeps `/`, plain/foreign ones are not marked", async () => {
  const r = reader({
    files: {
      [`${GLOBAL_CMDS}/mdbg.md`]: md("description: x\nsubagent: true"),
      [`${GLOBAL_CMDS}/sub/deep.md`]: md("subagent: true"),
      [`${GLOBAL_CMDS}/a/b/c.md`]: md("agent: explore"),
      [`${GLOBAL_CMDS}/mdfg.md`]: md("description: plain"),
      [`${GLOBAL_CMDS}/nofm.md`]: "just a template, no frontmatter\n",
      [`${GLOBAL_CMDS}/notes.txt`]: md("subagent: true"),
    },
    agents: [{ name: "explore", mode: "subagent" }],
  });
  assert.deepEqual(await names(r), ["a/b/c", "mdbg", "sub/deep"]);
});

test("project .md and project opencode.json(c) `commands` are read for that directory only", async () => {
  const r = reader({
    files: { [`${PROJ}/.opencode/commands/projbg.md`]: md("subagent: true") },
    projectConfigs: { [PROJ]: { commands: { cfgbg: { subagent: true }, cfgfg: {} } } },
  });
  assert.deepEqual(await names(r, PROJ), ["cfgbg", "projbg"]);
  assert.deepEqual(await names(r, "/other"), []);
  assert.deepEqual(await names(r), [], "no directory → global sources only");
});

test("a project definition overrides a global one of the same name (both ways)", async () => {
  const r = reader({
    files: {
      [`${GLOBAL_CMDS}/shared.md`]: md("subagent: true"),
      [`${GLOBAL_CMDS}/localfg.md`]: md("description: g"),
      [`${PROJ}/.opencode/commands/shared.md`]: md("description: project says foreground"),
    },
    globalConfig: { commands: { cfgshared: { subagent: true } } },
    projectConfigs: { [PROJ]: { commands: { localfg: { subagent: true } } } },
  });
  assert.deepEqual(await names(r, PROJ), ["cfgshared", "localfg"]);
  assert.deepEqual(await names(r), ["cfgshared", "shared"]);
});

test("within a scope the config `commands` key wins over a same-named .md", async () => {
  const r = reader({
    files: { [`${GLOBAL_CMDS}/x.md`]: md("subagent: true") },
    globalConfig: { commands: { x: { template: "now foreground" } } },
  });
  assert.deepEqual(await names(r), []);
});

test("garbled / unreadable sources contribute nothing, never throw, and log once", async () => {
  const r = reader({
    files: {
      [`${GLOBAL_CMDS}/good.md`]: md("subagent: true"),
      [`${GLOBAL_CMDS}/garbled.md`]: "---\nsubagent: [unclosed\n---\nbody\n",
      [`${GLOBAL_CMDS}/locked.md`]: md("subagent: true"),
      [`${GLOBAL_CMDS}/scalar.md`]: "---\njust a string\n---\nbody\n",
    },
    failing: { files: [`${GLOBAL_CMDS}/locked.md`], globalConfig: true, projectConfig: true, agents: true },
  });
  assert.deepEqual(await names(r, PROJ), ["good"]);
  await names(r, PROJ);
  const count = (re) => r.warns.filter((w) => re.test(w)).length;
  assert.equal(count(/garbled\.md/), 1, "logged once across two scans");
  assert.equal(count(/locked\.md/), 1);
  assert.equal(count(/global opencode config/), 1);
  assert.equal(count(/project opencode config/), 1);
  assert.equal(count(/agent list/), 1);
});

test("an unreadable commands dir or opencode being down only costs that source", async () => {
  const dir = reader({
    files: { [`${PROJ}/.opencode/commands/p.md`]: md("subagent: true") },
    globalConfig: { commands: { c: { subagent: true } } },
    failing: { dirs: [GLOBAL_CMDS] },
  });
  assert.deepEqual(await names(dir, PROJ), ["c", "p"]);
  const down = reader({ globalConfig: { commands: { c: { subagent: true }, v: { agent: "explore" } } }, failing: { agents: true } });
  assert.deepEqual(await names(down), ["c"], "subagent:true needs no agent list; the agent rule just can't fire");
});

test("a source that is not an object (null / array config) is ignored", async () => {
  const r = reader({ globalConfig: [1, 2], projectConfigs: { [PROJ]: { commands: [1] } } });
  assert.deepEqual(await names(r, PROJ), []);
  const r2 = reader({ globalConfig: null });
  assert.deepEqual(await names(r2), []);
});

test("cache: per directory for the TTL, expiry rescans, ttlMs 0 bypasses, the returned set is a copy", async () => {
  let t = 1000;
  const r = reader({ ttlMs: 10_000, now: () => t, globalConfig: { commands: { c: { subagent: true } } } });
  const first = await r.backgroundCommandNames(PROJ);
  first.add("mutated");
  await r.backgroundCommandNames(PROJ);
  assert.equal(r.calls.readGlobalConfig, 1, "second call within 10 s is served from cache");
  assert.deepEqual(await names(r, PROJ), ["c"], "a caller mutating its copy does not poison the cache");
  await r.backgroundCommandNames("/another");
  assert.equal(r.calls.readGlobalConfig, 2, "another directory is its own entry");
  t += 10_001;
  await r.backgroundCommandNames(PROJ);
  assert.equal(r.calls.readGlobalConfig, 3, "expired entry is recomputed");
  const bypass = reader({ ttlMs: 0, globalConfig: { commands: {} } });
  await bypass.backgroundCommandNames(PROJ);
  await bypass.backgroundCommandNames(PROJ);
  assert.equal(bypass.calls.readGlobalConfig, 2);
});

test("concurrent callers share one scan", async () => {
  const r = reader({ ttlMs: 10_000, globalConfig: { commands: { c: { subagent: true } } } });
  const [a, b] = await Promise.all([r.backgroundCommandNames(PROJ), r.backgroundCommandNames(PROJ)]);
  assert.deepEqual([...a], [...b]);
  assert.equal(r.calls.readGlobalConfig, 1);
});

test("XDG_CONFIG_HOME relocates the global commands dir", async () => {
  const r = createCommandBackgroundReader({
    readGlobalConfig: async () => null,
    readProjectConfig: async () => null,
    listAgents: async () => [],
    readFile: async () => md("subagent: true"),
    listMarkdown: async (dir) => (dir === "/xdg/opencode/commands" ? ["/xdg/opencode/commands/x/y.md"] : []),
    homeDir: HOME,
    configHome: "/xdg",
    ttlMs: 0,
  });
  assert.deepEqual([...(await r.backgroundCommandNames())], ["x/y"]);
});

test("parseFrontmatter / commandNameFromPath", () => {
  assert.deepEqual(parseFrontmatter("---\nsubagent: true\nagent: a\n---\nbody"), { subagent: true, agent: "a" });
  assert.deepEqual(parseFrontmatter("---\r\nsubagent: true\r\n---\r\nbody"), { subagent: true });
  assert.deepEqual(parseFrontmatter("\uFEFF---\nsubagent: true\n---\n"), { subagent: true });
  assert.equal(parseFrontmatter("no frontmatter"), null);
  assert.equal(parseFrontmatter(null), null);
  assert.equal(parseFrontmatter("---\n- a list\n---\n"), null);
  assert.throws(() => parseFrontmatter("---\nx: [bad\n---\n"));
  assert.equal(commandNameFromPath("/c", "/c/sub/deep.md"), "sub/deep");
  assert.equal(commandNameFromPath("/c", "/c/review.MD"), "review");
});

test("real I/O: listMarkdownRecursive + readProjectConfigFromDisk on a temp tree (comments, trailing commas, nested dirs, junk)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmdbg-"));
  try {
    const cmds = join(root, ".opencode", "commands");
    await mkdir(join(cmds, "team"), { recursive: true });
    await writeFile(join(cmds, "ship.md"), md("subagent: true"));
    await writeFile(join(cmds, "team", "audit.md"), md("subagent: true"));
    await writeFile(join(cmds, "team", "readme.txt"), "x");
    assert.deepEqual((await listMarkdownRecursive(cmds)).map((f) => commandNameFromPath(cmds, f)), ["ship", "team/audit"]);
    assert.deepEqual(await listMarkdownRecursive(join(root, "missing")), [], "a missing dir is not an error");

    assert.equal(await readProjectConfigFromDisk(root), null, "no config files → null");
    await writeFile(join(root, "opencode.jsonc"), '{\n  // comment\n  "commands": { "cfg": { "subagent": true, }, },\n}\n');
    const cfg = await readProjectConfigFromDisk(root);
    assert.deepEqual(cfg.commands, { cfg: { subagent: true } });
    await writeFile(join(root, "opencode.json"), '{"commands":{"cfg":{"subagent":false},"other":{"subagent":true}}}');
    assert.deepEqual((await readProjectConfigFromDisk(root)).commands, { cfg: { subagent: true }, other: { subagent: true } }, "opencode.jsonc overrides opencode.json");
    await writeFile(join(root, "opencode.jsonc"), "{ not json");
    await assert.rejects(readProjectConfigFromDisk(root), /not valid JSONC/);

    // the whole reader over the real disk helpers (global/agent seams stubbed: never touch the live box)
    const real = createCommandBackgroundReader({
      readGlobalConfig: async () => null,
      readProjectConfig: async () => null,
      listAgents: async () => [],
      readFile: (p) => readFile(p, "utf-8"),
      listMarkdown: listMarkdownRecursive,
      homeDir: join(root, "nohome"),
      ttlMs: 0,
      warn: () => {},
    });
    assert.deepEqual([...(await real.backgroundCommandNames(root))].sort(), ["ship", "team/audit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
