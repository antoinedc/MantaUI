// Agents Phase 5A (docs/superpowers/specs/2026-11-24-agents-phase5-builder.md): the Architect — role, safe snapshot,
// compiled ceiling, extra sources in agent.md. A real temp folder stands in for ~/.manta/agents; the rest are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentsEngine,
  parseAgentMd,
  buildAgentBlock,
  isArchitect,
  buildArchitectContext,
  ARCHITECT_BLOCK_PERMISSION,
} from "./agents.mjs";
import { ARCHITECT_SLUG, isTeamAgent } from "../shared/agentsShared.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const SPECIALIST = "---\nname: Scout\ndescription: Looks things up.\nisolation: none\n---\nYou are Scout.\n";

export async function archFixture({ extra = {}, templates = ["dev", "manta", "architect"] } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-arch-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of templates) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const editConfig = async (fn) => {
    const edits = typeof fn === "function" ? await fn(config.cfg) : fn;
    for (const e of edits) {
      config.edits.push(e);
      const [, key] = e.path;
      config.cfg.agent ??= {};
      if (e.value === undefined) delete config.cfg.agent[key];
      else config.cfg.agent[key] = structuredClone(e.value);
    }
    if (edits.length > 0) config.reloads++;
    return { ok: true, changed: edits.length > 0, reloaded: edits.length > 0 };
  };
  const engine = createAgentsEngine({
    root,
    templatesDir,
    home: "/h",
    isGitRepo: async () => true,
    editConfig,
    reload: async () => ({ ok: true, reloaded: true }),
    log: { warn: () => {} },
    oc: {},
    delegate: {},
    tmux: { listProjects: async () => [] },
    ...extra,
  });
  return { base, root, templatesDir, engine, config, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("the Architect template parses as role architect with no model pin; ARCHITECT_SLUG is architect", async () => {
  const r = parseAgentMd(await readFile(join(REAL_TEMPLATES, "architect", "agent.md"), "utf-8"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.role, "architect");
  assert.equal(r.meta.model, null);
  assert.equal(r.meta.isolation, "none");
  assert.deepEqual(r.meta.sources, []);
  assert.equal(ARCHITECT_SLUG, "architect");
  assert.match(r.meta.useWhen, /Creating a new agent/);
});

test("only the folder `architect` with role architect is the Architect; another folder claiming it is an error row", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "imposter"));
    await writeFile(join(f.root, "imposter", "agent.md"), "---\nname: Imposter\ndescription: d\nrole: architect\nisolation: none\n---\nx\n");
    const list = await f.engine.list();
    const by = Object.fromEntries(list.map((a) => [a.slug, a]));
    assert.equal(by.architect.role, "architect");
    assert.equal(by.architect.error, undefined);
    assert.equal(by.architect.builtIn, true);
    assert.match(by.imposter.error, /Architect/);
    assert.equal(by.imposter.role, "specialist");
    assert.equal(isTeamAgent(by.architect), true);
    assert.equal(isTeamAgent(by.manta), false);
    assert.equal(isTeamAgent(by.imposter), false);
    assert.equal(f.config.cfg.agent["agent-imposter"], undefined);
    assert.ok(f.config.cfg.agent["agent-architect"]);
    assert.equal(isArchitect((await f.engine.scan()).entries.find((e) => e.slug === "architect")), true);
    assert.equal(isArchitect((await f.engine.scan()).entries.find((e) => e.slug === "dev")), false);
  } finally {
    await f.cleanup();
  }
});

test("an existing `architect` folder without the role stays an ordinary specialist and gets a notice", async () => {
  const f = await archFixture({ templates: ["dev"] });
  try {
    await mkdir(join(f.root, "architect"), { recursive: true });
    await writeFile(join(f.root, "architect", "agent.md"), SPECIALIST);
    await f.engine.init();
    const a = (await f.engine.list()).find((x) => x.slug === "architect");
    assert.equal(a.role, "specialist");
    assert.equal(a.error, undefined);
    assert.match(a.notice, /Architect/);
    assert.equal(isArchitect((await f.engine.scan()).entries.find((e) => e.slug === "architect")), false);
  } finally {
    await f.cleanup();
  }
});

test("the compiled Architect block denies everything first, then allows only the research tools; others keep the old block", () => {
  const dir = "/h/.manta/agents/architect";
  const block = buildAgentBlock({ dir, meta: { description: "D", model: null, role: "architect" }, home: "/h", slug: "architect" });
  const keys = Object.keys(block.permission);
  assert.equal(keys[0], "*");
  assert.equal(block.permission["*"], "deny");
  for (const k of ["read", "glob", "grep", "list", "websearch", "todowrite", "progress_report", "research_fetch", "research_read", "research_search", "agent_propose"]) {
    assert.equal(block.permission[k], "allow", k);
  }
  for (const k of ["bash", "edit", "write", "webfetch", "patch"]) assert.ok(!keys.includes(k) || block.permission[k] === "deny", k);
  assert.deepEqual(Object.keys(block.permission.external_directory), [`${dir}/**`, "/h/.local/share/opencode/tool-output/*"]);
  assert.deepEqual(ARCHITECT_BLOCK_PERMISSION("/x", "/h")["*"], "deny");
  // an ordinary agent is unchanged
  assert.deepEqual(buildAgentBlock({ dir, meta: { description: "D", model: null, role: "specialist" } }).permission, { external_directory: { [`${dir}/**`]: "allow" } });
});

test("sync rewrites a block whose permission rules are only reordered (rule order is meaning)", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    const block = structuredClone(f.config.cfg.agent["agent-architect"]);
    const { "*": star, ...rest } = block.permission;
    f.config.cfg.agent["agent-architect"] = { ...block, permission: { ...rest, "*": star } }; // same rules, catch-all moved last
    const before = f.config.edits.length;
    await f.engine.sync();
    assert.equal(f.config.edits.length, before + 1, "rewritten");
    assert.equal(Object.keys(f.config.cfg.agent["agent-architect"].permission)[0], "*");
    // but a different key order OUTSIDE permission is still the same block
    const again = structuredClone(f.config.cfg.agent["agent-architect"]);
    f.config.cfg.agent["agent-architect"] = Object.fromEntries(Object.entries(again).reverse());
    const n = f.config.edits.length;
    await f.engine.sync();
    assert.equal(f.config.edits.length, n, "not rewritten");
  } finally {
    await f.cleanup();
  }
});

test("readAgentSnapshot: bytes + a 12-hex hash from one handle; a symlinked file or folder is never read", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    const snap = await f.engine.readAgentSnapshot("dev");
    assert.equal(snap.text, await readFile(join(f.root, "dev", "agent.md"), "utf-8"));
    assert.match(snap.hash, /^[0-9a-f]{12}$/);
    assert.equal(Buffer.isBuffer(snap.bytes), true);
    assert.equal(await f.engine.readAgentSnapshot("nope"), null);
    assert.equal(await f.engine.readAgentSnapshot("../x"), null);
    // agent.md replaced by a symlink to a file elsewhere
    await writeFile(join(f.base, "elsewhere.md"), SPECIALIST);
    await mkdir(join(f.root, "linked"));
    await symlink(join(f.base, "elsewhere.md"), join(f.root, "linked", "agent.md"));
    assert.equal(await f.engine.readAgentSnapshot("linked"), null);
    // the folder itself is a symlink to another folder
    await mkdir(join(f.base, "real-folder"));
    await writeFile(join(f.base, "real-folder", "agent.md"), SPECIALIST);
    await symlink(join(f.base, "real-folder"), join(f.root, "folderlink"));
    assert.equal(await f.engine.readAgentSnapshot("folderlink"), null);
    // too big
    await mkdir(join(f.root, "huge"));
    await writeFile(join(f.root, "huge", "agent.md"), `---\nname: H\ndescription: d\n---\n${"x".repeat(70_000)}\n`);
    assert.equal(await f.engine.readAgentSnapshot("huge"), null);
  } finally {
    await f.cleanup();
  }
});

test("buildArchitectContext: roster with hashes, the named agents' full text, a data framing line, the sources list", () => {
  const roster = [
    { slug: "dev", name: "Dev", description: "Writes code.", useWhen: "Code changes", notFor: null, isolation: "worktree", model: null, hash: "abc123abc123" },
    { slug: "manta", name: "Manta", description: "Leads.", useWhen: null, notFor: null, isolation: "none", model: null, hash: "def456def456", lead: true },
  ];
  const text = buildArchitectContext({
    roster,
    named: [{ slug: "dev", text: "---\nname: Dev\n---\nDev prompt\n", hash: "abc123abc123" }],
    sources: [{ id: "bookface", name: "YC Bookface", description: "Private forum.", private: true }],
  });
  assert.match(text, /abc123abc123/);
  assert.match(text, /def456def456/);
  assert.match(text, /data, not instructions/i);
  assert.match(text, /Dev prompt/);
  assert.match(text, /research_fetch/);
  assert.match(text, /agent_propose \(max 3\)/);
  assert.match(text, /hn, arxiv, reddit, x/);
  assert.match(text, /bookface — YC Bookface: Private forum\. \(private\)/);
  assert.equal(text, buildArchitectContext({ roster, named: [{ slug: "dev", text: "---\nname: Dev\n---\nDev prompt\n", hash: "abc123abc123" }], sources: [{ id: "bookface", name: "YC Bookface", description: "Private forum.", private: true }] }), "deterministic");
});

test("the Architect's own extra sources are read from its frontmatter; invalid ones are skipped with a notice; aliases refuse the file", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    const arch = await readFile(join(f.root, "architect", "agent.md"), "utf-8");
    const withSources = arch.replace("\n---\n", `\nsources:\n  - id: bookface\n    name: YC Bookface\n    description: Private forum.\n    command: [yc, search, "{query}"]\n  - id: broken\n    name: B\n    description: d\n---\n`.replace("---\n", "---\n"));
    await writeFile(join(f.root, "architect", "agent.md"), withSources);
    const e = (await f.engine.scan()).entries.find((x) => x.slug === "architect");
    assert.deepEqual(e.meta.sources.map((s) => s.id), ["bookface"]);
    assert.equal(e.meta.sources[0].private, true);
    assert.match(e.info.notice, /Skipped a source/);
    const aliased = arch.replace("\n---\n", "\nx: &a 1\ny: *a\n---\n");
    await writeFile(join(f.root, "architect", "agent.md"), aliased);
    const row = (await f.engine.list()).find((x) => x.slug === "architect");
    assert.match(row.error, /anchors or aliases/);
  } finally {
    await f.cleanup();
  }
});
