// An agent's one conversation, server side (docs/superpowers/specs/2026-11-28-agent-profile-redesign.md §2.2–2.4): Clear conversation
// starts a NEW session (with the agent's own key, in its home) and points the stored chat record at it; `chats` says which session is
// whose (the sidebar's Team rows); the profile carries the instructions and the refresh day. Fakes for opencode and tmux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine, refreshDay, ARCHITECT_CHAT_REFUSAL } from "./agents.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const AGENT = (name, extra = "") => `---\nname: ${name}\ndescription: Does ${name} things.\nisolation: worktree\n${extra}---\nYou are ${name}.\n\n## How you work\n\nCarefully.\n`;

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "agents-chat-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(join(templatesDir, "dev"), { recursive: true });
  await writeFile(join(templatesDir, "dev", "agent.md"), AGENT("Dev"));
  for (const t of ["manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const calls = { createSession: [], restamp: [], refresh: 0, newWindow: [], newSession: [] };
  const world = { projects: [], sessions: new Set(), routines: new Map() };
  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const engine = createAgentsEngine({
    root,
    templatesDir,
    isGitRepo: async () => true,
    editConfig: fakeConfigWriter(config),
    reload: async () => ({ ok: true, reloaded: true }),
    log: { warn: () => {} },
    oc: {
      listMessages: async () => [],
      createSession: async (i) => (calls.createSession.push(i), { id: `ses_new${calls.createSession.length}` }),
      sessionExists: async (id) => world.sessions.has(id),
    },
    delegate: { startJob: async () => ({ ok: true, job: { id: "j" } }), loadRecords: async () => [], loadRecordsStrict: async () => [] },
    tmux: {
      listProjects: async () => world.projects,
      newWindow: async (i) => (calls.newWindow.push(i), { windowIndex: 3 }),
      newSession: async (i) => (calls.newSession.push(i), { windowIndex: 0 }),
      restampSessionId: async (...a) => void calls.restamp.push(a),
    },
    registry: { identify: async () => null, list: async () => [] },
    syncState: { refreshNow: async () => calls.refresh++ },
    routines: {
      createInternal: async (i) => {
        const id = `rt${world.routines.size + 1}`;
        world.routines.set(id, { id, enabled: true, ...i });
        return world.routines.get(id);
      },
      update: async () => ({}),
      remove: async () => ({ deleted: true }),
      get: async (id) => ({ routine: world.routines.get(id) }),
    },
  });
  return { base, root, engine, calls, world, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const chatFile = (f, slug) => join(f.root, slug, ".chat.json");

test("clearChat: a new session with the agent's own key in its home, the chat record points at it, the open window is restamped, the old session is kept", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await writeFile(chatFile(f, "dev"), JSON.stringify({ sessionId: "ses_old" }));
    f.world.projects = [{ tmuxSession: "manta-agents", windows: [{ index: 4, opencodeSessionId: "ses_old" }, { index: 5, opencodeSessionId: "ses_other" }] }];
    const out = await f.engine.clearChat({ slug: "dev" });
    assert.deepEqual(out, { sessionId: "ses_new1", windowIndex: 4 });
    assert.deepEqual(f.calls.createSession, [{ directory: join(f.root, "dev", "home"), agent: "agent-dev", title: "Dev" }]);
    assert.deepEqual(JSON.parse(await readFile(chatFile(f, "dev"), "utf-8")), { sessionId: "ses_new1" });
    assert.deepEqual(f.calls.restamp, [["manta-agents", 4, "ses_new1"]], "only the agent's own window");
    assert.equal(f.calls.refresh, 1);
    // a following openChat reuses the new conversation (a window that carries it), it doesn't start another
    f.world.projects = [{ tmuxSession: "manta-agents", windows: [{ index: 4, opencodeSessionId: "ses_new1" }] }];
    assert.deepEqual(await f.engine.openChat({ slug: "dev" }), { tmuxSession: "manta-agents", windowIndex: 4 });
    assert.equal(f.calls.createSession.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("clearChat: with no window open only the chat record changes; the lead's conversation has no agent key; the Architect has none to clear", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const out = await f.engine.clearChat({ slug: "dev" });
    assert.deepEqual(out, { sessionId: "ses_new1", windowIndex: null });
    assert.deepEqual(f.calls.restamp, []);
    assert.deepEqual(JSON.parse(await readFile(chatFile(f, "dev"), "utf-8")), { sessionId: "ses_new1" });
    await assert.rejects(f.engine.clearChat({ slug: "architect" }), new RegExp(ARCHITECT_CHAT_REFUSAL));
    await assert.rejects(f.engine.clearChat({ slug: "ghost" }), /No agent named @ghost/);
    await f.engine.clearChat({ slug: "manta" });
    assert.equal("agent" in f.calls.createSession.at(-1), false, "the lead's chat runs on the default agent");
  } finally {
    await f.cleanup();
  }
});

test("clearChat leaves what the agent learned and the project notes alone", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, ".learned", "dev"), { recursive: true });
    await writeFile(join(f.root, ".learned", "dev", "_all.md"), "## lr_aaaaaaaa\n\"keep me\"\n");
    await mkdir(join(f.root, "dev", "seats"), { recursive: true });
    await writeFile(join(f.root, "dev", "seats", "site.md"), "A seat brief.\n");
    await f.engine.clearChat({ slug: "dev" });
    assert.equal(await readFile(join(f.root, ".learned", "dev", "_all.md"), "utf-8"), "## lr_aaaaaaaa\n\"keep me\"\n");
    assert.equal(await readFile(join(f.root, "dev", "seats", "site.md"), "utf-8"), "A seat brief.\n");
  } finally {
    await f.cleanup();
  }
});

test("chats: each non-Architect agent's stored conversation, by slug; an agent that never chatted is left out", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    assert.deepEqual(await f.engine.chats(), {});
    await writeFile(chatFile(f, "dev"), JSON.stringify({ sessionId: "ses_dev" }));
    await writeFile(chatFile(f, "architect"), JSON.stringify({ sessionId: "ses_arch" })); // never read: the Architect has no conversation
    await writeFile(chatFile(f, "manta"), "not json");
    assert.deepEqual(await f.engine.chats(), { dev: "ses_dev" });
  } finally {
    await f.cleanup();
  }
});

test("profile: the instructions (the agent file's body) and the refresh day (read-only) are sent", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const p = await f.engine.profile("dev");
    assert.match(p.instructions, /^You are Dev\./);
    assert.match(p.instructions, /## How you work/);
    assert.doesNotMatch(p.instructions, /^---/);
    assert.equal(p.refresh.day, refreshDay("dev"));
    const m = await f.engine.profile("manta");
    assert.equal(typeof m.instructions, "string");
    assert.equal(m.refresh.day ?? null, null, "the lead has no refresh");
  } finally {
    await f.cleanup();
  }
});
