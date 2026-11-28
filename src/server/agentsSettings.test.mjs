// The profile's Settings tab, server side (docs/superpowers/specs/2026-11-28-agent-profile-redesign.md §2.1): `settingsSet` saves one
// field of an agent through the EXISTING change flow — a change record (origin "settings") that is applied as the user's own click and
// can be undone — except an isolation raise, which waits like any other raise. A real temp folder stands in for ~/.manta/agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES } from "../shared/autonomyShared.mjs";
import { createAgentsEngine, parseAgentMd, AgentError, AGENT_CHANGE_OFF } from "./agents.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const T0 = Date.parse("2026-11-25T12:00:00Z");
const MODELS = ["anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"];

async function fixture({ level = "auto" } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-settings-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of ["dev", "manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const w = { clock: T0, level, pubs: [] };
  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const engine = createAgentsEngine({
    root,
    templatesDir,
    home: "/h",
    now: () => w.clock,
    isGitRepo: async () => true,
    editConfig: fakeConfigWriter(config),
    reload: async () => ({ ok: true, reloaded: true }),
    log: { warn: () => {} },
    retryDelayMs: 0,
    autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: w.level }),
    publish: (p) => w.pubs.push(p),
    listApprovedModels: async () => MODELS,
    oc: { listMessages: async () => [], readSession: async () => ({ state: "found", session: { id: "ses", directory: "/repo" } }) },
    delegate: { startJob: async () => ({ ok: true, job: { id: "job" } }), loadRecords: async () => [], loadRecordsStrict: async () => [] },
    tmux: { listProjects: async () => [], newSession: async () => ({ windowIndex: 0 }), newWindow: async () => ({ windowIndex: 1 }) },
    registry: { identify: async () => null, list: async () => [] },
    loadSecretsStrict: async () => [],
    createScanner: () => ({ scan: async () => ({ clean: true, unavailable: false, hits: [] }) }),
  });
  return {
    root,
    w,
    config,
    engine,
    store: async () => JSON.parse(await readFile(join(root, ".changes.json"), "utf-8").catch(() => '{"changes":[]}')),
    file: (slug) => readFile(join(root, slug, "agent.md"), "utf-8"),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

const records = async (f) => (await f.store()).changes ?? [];

test("a saved field is an applied change record by the user's own click, origin settings, with the new text in the file", async () => {
  const f = await fixture({ level: "ask" });
  try {
    await f.engine.init();
    const out = await f.engine.settingsSet({ slug: "dev", field: "description", value: "Writes and fixes code, carefully." });
    assert.equal(out.outcome, "saved");
    assert.equal(out.change.state, "applied");
    assert.equal(out.change.decidedBy, "click", "a user's save is the approval, whatever the level (Ask only makes an AGENT's change wait)");
    assert.deepEqual(out.change.origin, { kind: "settings", field: "description" });
    assert.equal(out.change.kind, "update");
    assert.equal(out.change.slug, "dev");
    assert.match(out.change.summary, /Description/);
    assert.match(await f.file("dev"), /description: Writes and fixes code, carefully\./);
    assert.match(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8"), /Dev prompt|You are Dev|Dev/, "OpenCode is re-synced");
    assert.ok(f.w.pubs.some((p) => p.id === out.change.id && p.origin.kind === "settings"), "the change hint is published");
    // the record is in History (newest first)
    const history = await f.engine.history("dev");
    assert.equal(history[0].id, out.change.id);
    assert.equal((await records(f)).filter((r) => r.origin?.kind === "settings").length, 1);
  } finally {
    await f.cleanup();
  }
});

test("name, use it when, not for and model save; an empty routing line or Auto clears the key", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    assert.equal((await f.engine.settingsSet({ slug: "dev", field: "name", value: "Developer" })).outcome, "saved");
    assert.equal((await f.engine.settingsSet({ slug: "dev", field: "useWhen", value: "Code changes in this project." })).outcome, "saved");
    assert.equal((await f.engine.settingsSet({ slug: "dev", field: "notFor", value: "Reviews that change nothing." })).outcome, "saved");
    assert.equal((await f.engine.settingsSet({ slug: "dev", field: "model", value: "openai/gpt-6-sol" })).outcome, "saved");
    let meta = parseAgentMd(await f.file("dev")).meta;
    assert.deepEqual([meta.name, meta.useWhen, meta.notFor, meta.model], ["Developer", "Code changes in this project.", "Reviews that change nothing.", "openai/gpt-6-sol"]);
    assert.equal((await f.engine.settingsSet({ slug: "dev", field: "notFor", value: "" })).outcome, "saved");
    assert.equal((await f.engine.settingsSet({ slug: "dev", field: "model", value: null })).outcome, "saved", "Auto");
    const text = await f.file("dev");
    meta = parseAgentMd(text).meta;
    assert.equal(meta.notFor ?? null, null);
    assert.equal(meta.model ?? null, null);
    assert.doesNotMatch(text, /not_for:/);
    assert.doesNotMatch(text, /^model:/m);
    assert.equal((await f.engine.list()).find((a) => a.slug === "dev").name, "Developer", "the list reads the new name");
  } finally {
    await f.cleanup();
  }
});

test("an unchanged value makes no record", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await f.engine.settingsSet({ slug: "dev", field: "useWhen", value: "Code changes." });
    await f.engine.settingsSet({ slug: "dev", field: "notFor", value: "" }); // clears the template's line, if it has one
    const before = (await records(f)).length;
    const out = await f.engine.settingsSet({ slug: "dev", field: "useWhen", value: "Code changes." });
    assert.deepEqual(out, { outcome: "unchanged", change: null });
    assert.equal((await f.engine.settingsSet({ slug: "dev", field: "notFor", value: "" })).outcome, "unchanged", "clearing what isn't there");
    assert.equal((await records(f)).length, before);
  } finally {
    await f.cleanup();
  }
});

test("Undo of a settings record puts the previous file back (the existing undo path)", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const was = await f.file("dev");
    const { change } = await f.engine.settingsSet({ slug: "dev", field: "name", value: "Developer" });
    const undone = await f.engine.undo(change.id);
    assert.equal(undone.state, "undone");
    assert.equal(await f.file("dev"), was);
  } finally {
    await f.cleanup();
  }
});

test("works: read-only applies directly; raising it back to its own branch follows the change flow — a pending record that waits for a click", async () => {
  const f = await fixture({ level: "auto" });
  try {
    await f.engine.init();
    const lowered = await f.engine.settingsSet({ slug: "dev", field: "isolation", value: "none" });
    assert.equal(lowered.outcome, "saved");
    assert.match(await f.file("dev"), /^isolation: none$/m);
    const afterLower = await f.file("dev");

    const raised = await f.engine.settingsSet({ slug: "dev", field: "isolation", value: "worktree" });
    assert.equal(raised.outcome, "waiting");
    assert.equal(raised.change.state, "pending");
    assert.equal(raised.change.needsClick, true);
    assert.equal(raised.change.reason, "isolation");
    assert.deepEqual(raised.change.origin, { kind: "settings", field: "isolation" });
    assert.equal(await f.file("dev"), afterLower, "nothing was written");
    assert.ok((await f.engine.history("dev")).some((r) => r.id === raised.change.id && r.state === "pending"), "history has it, as pending (the client shows applied ones only)");

    // the user's click (Needs you → Apply) applies it through the ordinary path
    const applied = await f.engine.apply(raised.change.id);
    assert.equal(applied.state, "applied");
    assert.match(await f.file("dev"), /^isolation: worktree$/m);
  } finally {
    await f.cleanup();
  }
});

test("refusals are sentences and create no record: unknown field, the handle, a bad draft, an unapproved model, Never, a missing agent", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const was = await f.file("dev");
    const n = (await records(f)).length;
    const set = (over) => f.engine.settingsSet({ slug: "dev", field: "description", value: "x", ...over });
    await assert.rejects(set({ field: "handle", value: "dev2" }), /handle can't be renamed yet/i);
    await assert.rejects(set({ field: "slug", value: "x" }), /can't be changed here/i);
    await assert.rejects(set({ field: "instructions", value: "x" }), /can't be changed here/i);
    await assert.rejects(set({ field: "sources", value: "x" }), /can't be changed here/i);
    await assert.rejects(set({ field: "name", value: "Two\nLines" }), /must be on one line/);
    await assert.rejects(set({ field: "name", value: "" }), /can't be empty/);
    await assert.rejects(set({ value: "y".repeat(201) }), /at most 200/);
    await assert.rejects(set({ field: "model", value: "nobody/nothing" }), /isn't an approved model/);
    await assert.rejects(set({ value: 5 }), /must be text/);
    await assert.rejects(set({ slug: "ghost" }), /No agent named @ghost/);
    f.w.level = "never";
    await assert.rejects(set(), new RegExp(AGENT_CHANGE_OFF));
    await assert.rejects(set(), AgentError);
    assert.equal((await records(f)).length, n, "no refusal wrote a record");
    assert.equal(await f.file("dev"), was);
  } finally {
    await f.cleanup();
  }
});

test("the Architect and Manta keep their wording and works via Manta; the Architect's model is the user's to set, Manta's is not", async () => {
  const f = await fixture({ level: "ask" });
  try {
    await f.engine.init();
    for (const slug of ["architect", "manta"]) {
      for (const field of ["name", "description", "useWhen", "notFor", "isolation"]) {
        await assert.rejects(f.engine.settingsSet({ slug, field, value: "Something" }), /built into Manta/, `${slug} ${field}`);
      }
    }
    const out = await f.engine.settingsSet({ slug: "architect", field: "model", value: "anthropic/claude-sonnet-5-5" });
    assert.equal(out.outcome, "saved");
    assert.equal(out.change.decidedBy, "click");
    assert.match(await f.file("architect"), /^model: anthropic\/claude-sonnet-5-5$/m);
    await assert.rejects(f.engine.settingsSet({ slug: "manta", field: "model", value: "anthropic/claude-sonnet-5-5" }), /model can't be changed here/);
  } finally {
    await f.cleanup();
  }
});
