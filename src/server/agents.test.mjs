// Agents, Phase 1 (src/server/agents.mjs): file format, slugs, compile, config sync, create, dispatch, open-chat.
// A real temp folder stands in for ~/.manta/agents; opencode config, opencode, tmux and delegate are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgentMd,
  slugForName,
  compileAgentPrompt,
  buildAgentBlock,
  buildAgentMd,
  buildConversationExcerpt,
  buildDispatchPrompt,
  requestTitle,
  createAgentsEngine,
  AgentError,
  EXCERPT_MAX_CHARS,
} from "./agents.mjs";

const valid = (extra = "") => `---\nname: Scout\ndescription: Looks things up.\n${extra}---\nYou are Scout.\n`;

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("parseAgentMd: a valid file, defaults and every optional key", () => {
  const r = parseAgentMd(valid());
  assert.equal(r.ok, true);
  assert.deepEqual(r.meta, { name: "Scout", description: "Looks things up.", isolation: "none", model: null, color: null });
  assert.equal(r.body, "You are Scout.");
  const full = parseAgentMd(valid('isolation: worktree\nmodel: anthropic/claude-sonnet-5-5\ncolor: "#5A88FF"\n'));
  assert.deepEqual(full.meta, { name: "Scout", description: "Looks things up.", isolation: "worktree", model: "anthropic/claude-sonnet-5-5", color: "#5A88FF" });
});

test("parseAgentMd: every way to be invalid is a sentence, never a throw", () => {
  const bad = (text, re) => {
    const r = parseAgentMd(text);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  };
  bad("no frontmatter here", /frontmatter/);
  bad("---\nname: [oops\n---\nx", /YAML/);
  bad("---\ndescription: d\n---\nx", /name/);
  bad("---\nname: n\n---\nx", /description/);
  bad(`---\nname: ${"x".repeat(41)}\ndescription: d\n---\nx`, /40/);
  bad(`---\nname: n\ndescription: ${"x".repeat(201)}\n---\nx`, /200/);
  bad("---\nname: n\ndescription: d\nisolation: sandbox\n---\nx", /isolation/);
  bad("---\nname: n\ndescription: d\nmodel: nonsense\n---\nx", /provider\/model/);
  bad("---\n- a\n- b\n---\nx", /key: value/);
});

test("slugForName: lowercases, dashes, truncates, and numbers collisions", () => {
  assert.equal(slugForName("Code Reviewer!"), "code-reviewer");
  assert.equal(slugForName("  ---  "), "agent");
  assert.equal(slugForName("42 helper"), "a-42-helper");
  assert.equal(slugForName("x".repeat(60)).length, 31);
  assert.equal(slugForName("Scout", new Set(["scout"])), "scout-2");
  assert.equal(slugForName("Scout", new Set(["scout", "scout-2"])), "scout-3");
  const long = "y".repeat(40);
  const taken = new Set([slugForName(long)]);
  const next = slugForName(long, taken);
  assert.ok(next.length <= 31 && next.endsWith("-2"), next);
});

test("slugForName: a reserved name is refused", () => {
  for (const name of ["Build", "plan", "General", "CTO", "manta-plan"]) assert.throws(() => slugForName(name), /reserved/);
});

test("compileAgentPrompt: the role prompt, plus a skills index only when there are skills", () => {
  assert.equal(compileAgentPrompt({ body: "Role." }), "Role.\n");
  const out = compileAgentPrompt({
    body: "Role.",
    skills: [{ name: "pdf", description: "Reads PDFs", path: "/a/skills/pdf/SKILL.md" }, { name: "bare", description: "", path: "/a/skills/bare/SKILL.md" }],
  });
  assert.match(out, /## Your skills/);
  assert.match(out, /Read a skill's file before doing work it covers\./);
  assert.match(out, /- \*\*pdf\*\* — Reads PDFs\n {2}File: \/a\/skills\/pdf\/SKILL\.md/);
  assert.match(out, /- \*\*bare\*\*\n {2}File: \/a\/skills\/bare\/SKILL\.md/);
});

test("buildAgentBlock: the pinned OpenCode block, model only when set", () => {
  const dir = "/h/.manta/agents/dev";
  assert.deepEqual(buildAgentBlock({ dir, meta: { description: "D", model: null } }), {
    mode: "all",
    description: "D",
    prompt: "{file:/h/.manta/agents/dev/.compiled.md}",
    permission: { external_directory: { "/h/.manta/agents/dev/**": "allow" } },
  });
  assert.equal(buildAgentBlock({ dir, meta: { description: "D", model: "a/b" } }).model, "a/b");
});

test("buildAgentMd round-trips through the parser, even with a colon in the description", () => {
  const text = buildAgentMd({ name: "Docs: Writer", description: "Writes docs: clear ones.", isolation: "worktree" });
  const r = parseAgentMd(text);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.name, "Docs: Writer");
  assert.equal(r.meta.description, "Writes docs: clear ones.");
  assert.equal(r.meta.isolation, "worktree");
  assert.match(r.body, /commit as you go/);
  assert.match(buildAgentMd({ name: "A", description: "d", isolation: "none" }), /cannot change files/);
});

const msg = (role, text, extra = {}) => ({ info: { role }, parts: [{ type: "text", text, ...extra }] });

test("buildConversationExcerpt: last 10 text messages, oldest first, tool-only and synthetic parts skipped", () => {
  const messages = [];
  for (let i = 1; i <= 14; i++) messages.push(msg(i % 2 ? "user" : "assistant", `m${i}`));
  messages.push({ info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash" }] });
  messages.push(msg("assistant", "hidden", { synthetic: true }));
  const out = buildConversationExcerpt(messages);
  const lines = out.split("\n\n");
  assert.equal(lines.length, 10);
  assert.equal(lines[0], "User: m5");
  assert.equal(lines[9], "Assistant: m14");
  assert.ok(!out.includes("hidden"));
  assert.equal(buildConversationExcerpt([]), "");
});

test("buildConversationExcerpt: capped at 6000 chars, dropping the OLDEST first; one huge message is tail-truncated", () => {
  const big = "x".repeat(2500);
  const out = buildConversationExcerpt([msg("user", `old${big}`), msg("assistant", `mid${big}`), msg("user", `new${big}`)]);
  assert.ok(out.length <= EXCERPT_MAX_CHARS, String(out.length));
  assert.ok(out.includes("new") && out.includes("mid") && !out.includes("old"));
  const huge = buildConversationExcerpt([msg("user", "y".repeat(20_000))]);
  assert.equal(huge.length, EXCERPT_MAX_CHARS);
});

test("buildDispatchPrompt: request, then the brief, then the conversation", () => {
  assert.equal(buildDispatchPrompt({ text: "do it" }), "do it");
  const full = buildDispatchPrompt({ text: "do it", seat: "BRIEF", excerpt: "User: hi" });
  assert.ok(full.indexOf("do it") < full.indexOf("BRIEF") && full.indexOf("BRIEF") < full.indexOf("User: hi"));
});

test("requestTitle: the first six words, without the agent's own @mention", () => {
  assert.equal(requestTitle("@dev fix the flaky login test on the staging box please", "dev"), "fix the flaky login test on");
  assert.equal(requestTitle("@dev", "dev"), "@dev");
});

// ---------------------------------------------------------------------------
// the engine, over a temp folder
// ---------------------------------------------------------------------------

async function fixture(extra = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-test-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(join(templatesDir, "dev"), { recursive: true });
  await writeFile(join(templatesDir, "dev", "agent.md"), "---\nname: Dev\ndescription: Writes code.\nisolation: worktree\n---\nDev prompt.\n");

  // a one-file stand-in for opencode.jsonc: applies the writer's edits to a plain object
  const config = { cfg: { agent: { "agent-mine": { mode: "all", description: "someone else's" } } }, edits: [], reloads: 0, failEdit: null, failReload: null };
  const editConfig = async (fn) => {
    if (config.failEdit) return { ok: false, changed: false, error: config.failEdit };
    const edits = typeof fn === "function" ? await fn(config.cfg) : fn;
    for (const e of edits) {
      config.edits.push(e);
      const [, key] = e.path;
      config.cfg.agent ??= {};
      if (e.value === undefined) delete config.cfg.agent[key];
      else config.cfg.agent[key] = structuredClone(e.value);
    }
    if (edits.length > 0) config.reloads++; // the writer reloads after a real change
    return { ok: true, changed: edits.length > 0, reloaded: edits.length > 0 };
  };
  const reload = async () => {
    config.reloads++;
    return config.failReload ? { ok: false, error: config.failReload } : { ok: true, reloaded: true };
  };

  const calls = { startJob: [], assertWritable: [], createSession: [], newWindow: [], newSession: [], refresh: 0, listMessages: [] };
  const world = {
    projects: [],
    messages: [],
    messagesFail: false,
    cto: false,
    writableError: null,
    startResult: { ok: true, job: { id: "job1" } },
    sessions: new Set(),
    identify: async () => ({ slug: "proj-0123456789" }),
  };
  const engine = createAgentsEngine({
    root,
    templatesDir,
    editConfig,
    reload,
    log: { warn: () => {} },
    oc: {
      listMessages: async (sid, opts) => {
        calls.listMessages.push({ sid, opts });
        if (world.messagesFail) throw new Error("opencode down");
        return world.messages;
      },
      createSession: async (i) => {
        calls.createSession.push(i);
        return { id: `ses_chat${calls.createSession.length}` };
      },
      sessionExists: async (id) => world.sessions.has(id),
    },
    delegate: {
      startJob: async (i) => {
        calls.startJob.push(i);
        return world.startResult;
      },
    },
    tmux: {
      listProjects: async () => world.projects,
      newWindow: async (i) => {
        calls.newWindow.push(i);
        return { windowIndex: 3 };
      },
      newSession: async (i) => {
        calls.newSession.push(i);
        if (world.autoRegister) world.projects = [{ tmuxSession: i.name, windows: [{ index: 0, opencodeSessionId: i.existingSessionId }] }];
        return { windowIndex: 0 };
      },
    },
    registry: { identify: (d) => world.identify(d) },
    delegateView: {
      assertWritable: async (sid) => {
        calls.assertWritable.push(sid);
        if (world.writableError) throw world.writableError;
      },
    },
    isCtoSession: async () => world.cto,
    syncState: { refreshNow: async () => calls.refresh++ },
    ...extra,
  });
  return { base, root, engine, config, calls, world, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("init: installs the built-in once, never overwrites an edited folder, and compiles it into the config", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.engine.init()).installed, ["dev"]);
    assert.match(await readFile(join(f.root, "dev", "agent.md"), "utf-8"), /Dev/);
    assert.ok((await stat(join(f.root, "dev", "home"))).isDirectory());
    assert.equal(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8"), "Dev prompt.\n");
    const block = f.config.cfg.agent["agent-dev"];
    assert.equal(block.mode, "all");
    assert.equal(block.prompt, `{file:${join(f.root, "dev", ".compiled.md")}}`);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, ".installed.json"), "utf-8")), ["agent-dev"]);

    await writeFile(join(f.root, "dev", "agent.md"), "---\nname: Dev\ndescription: My edit.\nisolation: worktree\n---\nMine.\n");
    assert.deepEqual((await f.engine.init()).installed, [], "an existing folder is never overwritten");
    assert.equal(f.config.cfg.agent["agent-dev"].description, "My edit.");
  } finally {
    await f.cleanup();
  }
});

test("list: reserved folders are skipped, an invalid agent is listed with its error, built-in is flagged", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "build"));
    await writeFile(join(f.root, "build", "agent.md"), valid());
    await mkdir(join(f.root, "Bad_Name"));
    await mkdir(join(f.root, "broken"));
    await writeFile(join(f.root, "broken", "agent.md"), "no frontmatter");
    await mkdir(join(f.root, "empty"));
    await mkdir(join(f.root, "scout"));
    await writeFile(join(f.root, "scout", "agent.md"), valid('color: "#112233"\n'));
    const list = await f.engine.list();
    assert.deepEqual(list.map((a) => a.slug), ["broken", "dev", "empty", "scout"]);
    const bySlug = Object.fromEntries(list.map((a) => [a.slug, a]));
    assert.match(bySlug.broken.error, /frontmatter/);
    assert.equal(bySlug.empty.error, "agent.md is missing");
    assert.equal(bySlug.dev.builtIn, true);
    assert.equal(bySlug.dev.error, undefined);
    assert.deepEqual(bySlug.scout, { slug: "scout", name: "Scout", description: "Looks things up.", isolation: "none", model: null, color: "#112233", builtIn: false });
    assert.ok(f.config.cfg.agent["agent-scout"], "the new valid agent was synced by the list call");
    assert.equal(f.config.cfg.agent["agent-broken"], undefined, "an invalid agent is never compiled");
    assert.equal(f.config.cfg.agent["agent-build"], undefined);
  } finally {
    await f.cleanup();
  }
});

test("sync: a second run with nothing changed writes nothing and does not reload", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const edits = f.config.edits.length;
    const reloads = f.config.reloads;
    await f.engine.sync();
    assert.equal(f.config.edits.length, edits);
    assert.equal(f.config.reloads, reloads);
  } finally {
    await f.cleanup();
  }
});

test("sync: an edited prompt with an unchanged config block reloads OpenCode exactly once", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const reloads = f.config.reloads;
    await writeFile(join(f.root, "dev", "agent.md"), "---\nname: Dev\ndescription: Writes code.\nisolation: worktree\n---\nA NEW prompt.\n");
    await f.engine.sync();
    assert.equal(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8"), "A NEW prompt.\n");
    assert.equal(f.config.reloads, reloads + 1);
    await f.engine.sync();
    assert.equal(f.config.reloads, reloads + 1, "and not again");
  } finally {
    await f.cleanup();
  }
});

test("sync: skills are indexed into the compiled prompt and a changed skill triggers a resync", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "dev", "skills", "deploy"), { recursive: true });
    await writeFile(join(f.root, "dev", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: How we ship\n---\nSteps…\n");
    await f.engine.list(); // the stat scan sees the new skill
    const compiled = await readFile(join(f.root, "dev", ".compiled.md"), "utf-8");
    assert.match(compiled, /\*\*deploy\*\* — How we ship/);
    assert.match(compiled, new RegExp(`File: ${join(f.root, "dev", "skills", "deploy", "SKILL.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await f.cleanup();
  }
});

test("sync: removes only blocks Manta installed whose package is gone; someone else's agent-* block survives", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "scout"));
    await writeFile(join(f.root, "scout", "agent.md"), valid());
    await f.engine.sync();
    assert.ok(f.config.cfg.agent["agent-scout"]);
    await rm(join(f.root, "scout"), { recursive: true });
    await f.engine.sync();
    assert.equal(f.config.cfg.agent["agent-scout"], undefined);
    assert.ok(f.config.cfg.agent["agent-dev"]);
    assert.deepEqual(f.config.cfg.agent["agent-mine"], { mode: "all", description: "someone else's" });
    assert.deepEqual(JSON.parse(await readFile(join(f.root, ".installed.json"), "utf-8")), ["agent-dev"]);
  } finally {
    await f.cleanup();
  }
});

test("sync: a config write failure throws a sentence; list still answers and retries next time", async () => {
  const f = await fixture();
  try {
    await f.engine.installBuiltIns();
    f.config.failEdit = "opencode.jsonc is not valid";
    await assert.rejects(f.engine.sync(), /Couldn't update the agents in OpenCode: opencode\.jsonc is not valid/);
    const list = await f.engine.list();
    assert.deepEqual(list.map((a) => a.slug), ["dev"]);
    f.config.failEdit = null;
    await f.engine.list();
    assert.ok(f.config.cfg.agent["agent-dev"], "the retry on the next list succeeded");
  } finally {
    await f.cleanup();
  }
});

test("create: slug, files, compiled block; a collision numbers the slug; bad input and reserved names are refused", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const info = await f.engine.create({ name: "Code Reviewer", description: "Reviews diffs.", isolation: "none" });
    assert.deepEqual(info, { slug: "code-reviewer", name: "Code Reviewer", description: "Reviews diffs.", isolation: "none", model: null, color: null, builtIn: false });
    assert.ok((await stat(join(f.root, "code-reviewer", "home"))).isDirectory());
    const parsed = parseAgentMd(await readFile(join(f.root, "code-reviewer", "agent.md"), "utf-8"));
    assert.equal(parsed.ok, true);
    assert.ok(f.config.cfg.agent["agent-code-reviewer"]);
    assert.equal((await f.engine.create({ name: "Code Reviewer", description: "Again.", isolation: "worktree" })).slug, "code-reviewer-2");
    assert.equal((await f.engine.create({ name: "Dev", description: "Another dev.", isolation: "none" })).slug, "dev-2");

    await assert.rejects(f.engine.create({ name: "", description: "d", isolation: "none" }), AgentError);
    await assert.rejects(f.engine.create({ name: "n", description: "", isolation: "none" }), /description/);
    await assert.rejects(f.engine.create({ name: "x".repeat(41), description: "d", isolation: "none" }), /40/);
    await assert.rejects(f.engine.create({ name: "Build", description: "d", isolation: "none" }), /reserved/);
    await assert.rejects(f.engine.create({ name: "n", description: "d", isolation: "root" }), /isolation/);
    assert.deepEqual((await readdir(f.root)).filter((n) => n === "build"), [], "a refused create leaves no folder");
  } finally {
    await f.cleanup();
  }
});

test("dispatch: builds the job input — request, seat brief, conversation — and returns the job id", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "dev", "seats"), { recursive: true });
    await writeFile(join(f.root, "dev", "seats", "proj-0123456789.md"), "  Use pnpm, never npm.\n");
    f.world.messages = [msg("user", "we should fix the login"), msg("assistant", "agreed, it is flaky")];
    const res = await f.engine.dispatch({ sessionId: "ses_parent", directory: "/repo", slug: "dev", text: "@dev fix the flaky login test" });
    assert.deepEqual(res, { jobId: "job1" });
    assert.deepEqual(f.calls.assertWritable, ["ses_parent"]);
    const job = f.calls.startJob[0];
    assert.equal(job.parentSessionID, "ses_parent");
    assert.equal(job.parentDirectory, "/repo");
    assert.equal(job.agent, "agent-dev");
    assert.equal(job.isolation, "worktree");
    assert.equal(job.agentDir, join(f.root, "dev"));
    assert.equal(job.agentName, "Dev");
    assert.equal(job.request, "@dev fix the flaky login test");
    assert.equal(job.name, "fix the flaky login test");
    assert.equal(job.model, undefined, "no model unless the agent names one");
    assert.ok(job.prompt.startsWith("@dev fix the flaky login test"));
    assert.match(job.prompt, /Use pnpm, never npm\./);
    assert.match(job.prompt, /User: we should fix the login\n\nAssistant: agreed, it is flaky/);
    assert.ok(job.prompt.indexOf("Use pnpm") < job.prompt.indexOf("we should fix the login"));
    assert.equal(f.calls.listMessages[0].sid, "ses_parent");
  } finally {
    await f.cleanup();
  }
});

test("dispatch: no seat file, an unreadable conversation and an unidentifiable project simply omit those sections; the agent's model is passed", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "scout"));
    await writeFile(join(f.root, "scout", "agent.md"), valid("model: anthropic/claude-sonnet-5-5\n"));
    f.world.messagesFail = true;
    f.world.identify = async () => {
      throw new Error("no git");
    };
    await f.engine.dispatch({ sessionId: "ses_p", directory: "/repo", slug: "scout", text: "look this up" });
    const job = f.calls.startJob[0];
    assert.equal(job.prompt, "look this up");
    assert.equal(job.model, "anthropic/claude-sonnet-5-5");
    assert.equal(job.isolation, "none");
  } finally {
    await f.cleanup();
  }
});

test("dispatch: refusals are sentences — unknown / invalid agent, CTO conversation, read-only job, empty text, a refused start", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "broken"));
    await writeFile(join(f.root, "broken", "agent.md"), "nope");
    const d = (over = {}) => f.engine.dispatch({ sessionId: "ses_p", directory: "/repo", slug: "dev", text: "do it", ...over });
    await assert.rejects(d({ slug: "nobody" }), /No agent named @nobody/);
    await assert.rejects(d({ slug: "broken" }), /No agent named @broken/);
    await assert.rejects(d({ text: "   " }), /what you want @dev to do/);
    await assert.rejects(d({ directory: "" }), /folder/);
    f.world.cto = true;
    await assert.rejects(d(), /@agent mentions aren't available here/);
    f.world.cto = false;
    f.world.writableError = Object.assign(new Error("This is a background job — it can't take messages"), { rpcStatus: 409 });
    await assert.rejects(d(), /can't take messages/);
    f.world.writableError = null;
    f.world.startResult = { ok: false, error: "A background job can't start another job." };
    await assert.rejects(d(), /can't start another job/);
    assert.equal(f.calls.startJob.length, 1, "only the last attempt reached the engine");
  } finally {
    await f.cleanup();
  }
});

test("openChat: creates the session and tmux session first time, stores the id, reuses the open window afterwards", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const first = await f.engine.openChat({ slug: "dev" });
    assert.deepEqual(first, { tmuxSession: "manta-agents", windowIndex: 0 });
    assert.deepEqual(f.calls.createSession, [{ directory: join(f.root, "dev", "home"), agent: "agent-dev", title: "Dev" }]);
    assert.equal(f.calls.newSession.length, 1);
    assert.equal(f.calls.newWindow.length, 0, "newWindow cannot create the tmux session");
    assert.equal(f.calls.newSession[0].name, "manta-agents");
    assert.equal(f.calls.newSession[0].existingSessionId, "ses_chat1");
    assert.equal(f.calls.newSession[0].chatMode, true);
    assert.equal(f.calls.newSession[0].cwd, join(f.root, "dev", "home"));
    assert.equal(f.calls.refresh, 1);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "dev", ".chat.json"), "utf-8")), { sessionId: "ses_chat1" });

    f.world.projects = [{ tmuxSession: "manta-agents", windows: [{ index: 4, opencodeSessionId: "ses_chat1" }] }];
    assert.deepEqual(await f.engine.openChat({ slug: "dev" }), { tmuxSession: "manta-agents", windowIndex: 4 });
    assert.equal(f.calls.createSession.length, 1, "reused, nothing new made");
    assert.equal(f.calls.newWindow.length + f.calls.newSession.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("openChat: with the tmux session present a new window is added; a closed window reopens the surviving conversation", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await writeFile(join(f.root, "dev", ".chat.json"), JSON.stringify({ sessionId: "ses_old" }));
    f.world.projects = [{ tmuxSession: "manta-agents", windows: [{ index: 0, opencodeSessionId: "ses_other" }] }];
    f.world.sessions.add("ses_old");
    assert.deepEqual(await f.engine.openChat({ slug: "dev" }), { tmuxSession: "manta-agents", windowIndex: 3 });
    assert.equal(f.calls.createSession.length, 0, "the old conversation still exists");
    assert.equal(f.calls.newWindow[0].existingSessionId, "ses_old");
    assert.equal(f.calls.newWindow[0].sessionName, "manta-agents");

    f.world.sessions.delete("ses_old");
    await f.engine.openChat({ slug: "dev" });
    assert.equal(f.calls.createSession.length, 1, "a deleted conversation is replaced");
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "dev", ".chat.json"), "utf-8")), { sessionId: "ses_chat1" });
    await assert.rejects(f.engine.openChat({ slug: "ghost" }), /No agent named @ghost/);
  } finally {
    await f.cleanup();
  }
});

test("openChat: two concurrent calls open one window", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    f.world.autoRegister = true; // tmux lists the window the first call made
    const [a, b] = await Promise.all([f.engine.openChat({ slug: "dev" }), f.engine.openChat({ slug: "dev" })]);
    assert.deepEqual(a, b);
    assert.equal(f.calls.newSession.length + f.calls.newWindow.length, 1);
    assert.equal(f.calls.createSession.length, 1);
  } finally {
    await f.cleanup();
  }
});
