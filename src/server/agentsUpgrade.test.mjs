// Architect v2 Stage 0 + bundle snapshots (docs/superpowers/specs/2026-11-27-architect-v2.md §2, §4.1): built-in templates
// reach existing boxes through a three-way merge and one change record per upgraded agent; every update record also carries
// content-addressed snapshots of the whole agent folder (agent.md + skills + learned) that apply / undo / restore use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentsEngine, mergeAgentMd, parseAgentMd } from "./agents.mjs";
import { MODES } from "../shared/autonomyShared.mjs";
import { sha256, historyOf } from "../../scripts/agents/template-history.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const md = ({ description = "Writes code.", model = null, color = null, body = "Line one.\nLine two.\nLine three.\nLine four.\nLine five." } = {}) =>
  `---\nname: Dev\ndescription: ${description}\nisolation: worktree\n${model ? `model: ${model}\n` : ""}${color ? `color: "${color}"\n` : ""}---\n${body}\n`;
const SKILL = (extra = "") => `---\nname: style\ndescription: House style.\n---\nUse tabs.${extra}\n`;

/** A box over temp folders. `ship(files)` publishes a template version (and appends its hashes to the history file, as the script does). */
async function box({ level = "tell", policyThrows = false, extra = {}, slug = "dev" } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-upgrade-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  const tdir = join(templatesDir, slug);
  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const w = { level, policyThrows, clock: 1_700_000_000_000 };
  const engineOver = (over = {}) =>
    createAgentsEngine({
      root,
      templatesDir,
      home: "/h",
      isGitRepo: async () => true,
      editConfig: fakeConfigWriter(config),
      reload: async () => ({ ok: true, reloaded: true }),
      log: { warn: () => {} },
      oc: {},
      delegate: {},
      tmux: { listProjects: async () => [] },
      now: () => w.clock,
      autonomyPolicy: async () => {
        if (w.policyThrows) throw new Error("unreadable");
        return { ...MODES.balanced, agent_change: w.level };
      },
      loadSecretsStrict: async () => [],
      createScanner: () => ({ scan: async () => ({ clean: true, unavailable: false, hits: [] }) }),
      ...extra,
      ...over,
    });
  const versions = new Map(); // hash → text of every version published so far: the template ships the old texts in `.versions/`
  const ship = async (files) => {
    await rm(tdir, { recursive: true, force: true });
    const hashes = {};
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(tdir, rel, ".."), { recursive: true });
      await writeFile(join(tdir, rel), text);
      hashes[rel] = sha256(text);
      versions.set(hashes[rel], text);
    }
    await mkdir(join(tdir, ".versions"), { recursive: true });
    for (const [h, text] of versions) await writeFile(join(tdir, ".versions", h), text);
    let history = {};
    try {
      history = JSON.parse(await readFile(join(tdir, "..", `${slug}.history.json`), "utf-8"));
    } catch {
      /* the first release */
    }
    history = historyOf(history, hashes);
    await writeFile(join(templatesDir, `${slug}.history.json`), JSON.stringify(history));
    await writeFile(join(tdir, ".history.json"), JSON.stringify(history));
  };
  const read = (...p) => readFile(join(root, slug, ...p), "utf-8");
  const records = async () => JSON.parse(await readFile(join(root, ".changes.json"), "utf-8").catch(() => '{"changes":[]}')).changes;
  return { base, root, templatesDir, tdir, config, w, engine: engineOver(), make: engineOver, ship, read, records, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const V1 = { "agent.md": md(), "skills/style/SKILL.md": SKILL() };
const MINE = md({ description: "Mine.", body: "Mine entirely." });

/** The user edited the agent, then a version that conflicts with the edit ships: a pending card (the one upgrade a click decides). Returns the new engine. */
async function installThenConflict(b) {
  await b.ship(V1);
  await b.engine.init();
  await writeFile(join(b.root, "dev", "agent.md"), MINE);
  await b.ship({ ...V1, "agent.md": md({ description: "Theirs.", body: "Shipped body.\nSecond." }) });
  const engine = b.make();
  await engine.init();
  return engine;
}

/** Install V1, publish a second version (a new description) and boot again: the box that was just upgraded. Returns the new engine. */
async function installThenUpgrade(b) {
  await b.ship(V1);
  await b.engine.init();
  await b.ship({ ...V1, "agent.md": md({ description: "Second." }) });
  const engine = b.make();
  await engine.init();
  return engine;
}

test("install copies the shipped files to .base/ and leaves .history.json out of the agent's folder", async () => {
  const b = await box();
  try {
    await b.ship(V1);
    await b.engine.init();
    assert.equal(await b.read("agent.md"), V1["agent.md"]);
    assert.equal(await b.read(".base", "agent.md"), V1["agent.md"]);
    assert.equal(await b.read(".base", "skills", "style", "SKILL.md"), V1["skills/style/SKILL.md"]);
    await assert.rejects(stat(join(b.root, "dev", ".history.json")));
    await assert.rejects(stat(join(b.root, "dev", ".base", ".history.json")));
    assert.deepEqual(await b.records(), [], "a fresh install is not an upgrade");
  } finally {
    await b.cleanup();
  }
});

test("an unchanged template changes nothing, and the user's edits stay", async () => {
  const b = await box();
  try {
    await b.ship(V1);
    await b.engine.init();
    const mine = md({ color: "#112233" });
    await writeFile(join(b.root, "dev", "agent.md"), mine);
    await b.make().init();
    assert.equal(await b.read("agent.md"), mine);
    assert.deepEqual(await b.records(), []);
  } finally {
    await b.cleanup();
  }
});

test("an unedited agent is replaced outright: one record (template-update, templateHash), applied under Tell me, .base follows, Undo puts both back", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    const V2 = { "agent.md": md({ description: "Writes better code." }), "skills/style/SKILL.md": SKILL(" Never spaces."), "skills/extra/SKILL.md": "---\nname: extra\ndescription: New.\n---\nx\n" };
    await b.ship(V2);
    const engine = b.make();
    await engine.init();
    assert.equal(await b.read("agent.md"), V2["agent.md"]);
    assert.equal(await b.read("skills", "extra", "SKILL.md"), V2["skills/extra/SKILL.md"], "a file only the template has is added");
    assert.equal(await b.read(".base", "agent.md"), V2["agent.md"]);
    assert.equal(await b.read(".base", "skills", "extra", "SKILL.md"), V2["skills/extra/SKILL.md"]);
    assert.equal(b.config.cfg.agent["agent-dev"].description, "Writes better code.", "and it is live");
    const [rec, ...none] = await b.records();
    assert.equal(none.length, 0);
    assert.equal(rec.kind, "update");
    assert.equal(rec.slug, "dev");
    assert.equal(rec.state, "applied");
    assert.equal(rec.decidedBy, "auto");
    assert.equal(rec.origin.kind, "template-update");
    assert.match(rec.origin.templateHash, /^[0-9a-f]{64}$/);
    assert.equal(rec.before, V1["agent.md"]);
    assert.equal(rec.after, V2["agent.md"]);
    // the history shows it, with the bundle maps stripped from the wire
    const wire = (await engine.history("dev"))[0];
    assert.equal(wire.origin.kind, "template-update");
    for (const k of ["beforeBundle", "afterBundle", "baseBefore", "baseAfter"]) assert.equal(Object.hasOwn(wire, k), false, k);

    const undone = await engine.undo(rec.id);
    assert.equal(undone.state, "undone");
    assert.equal(await b.read("agent.md"), V1["agent.md"]);
    assert.equal(await b.read("skills", "style", "SKILL.md"), V1["skills/style/SKILL.md"]);
    await assert.rejects(stat(join(b.root, "dev", "skills", "extra", "SKILL.md")), "the added file is gone again");
    assert.equal(await b.read(".base", "agent.md"), V1["agent.md"], ".base is restored to what it was");
    await assert.rejects(stat(join(b.root, "dev", ".base", "skills", "extra", "SKILL.md")));
  } finally {
    await b.cleanup();
  }
});

test("a clean three-way merge: the user's edit and the template's change both land", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    await writeFile(join(b.root, "dev", "agent.md"), md({ body: "Line one, my words.\nLine two.\nLine three.\nLine four.\nLine five." }));
    await b.ship({ ...V1, "agent.md": md({ body: "Line one.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six." }) });
    await b.make().init();
    const text = await b.read("agent.md");
    assert.match(text, /Line one, my words\./);
    assert.match(text, /Line six\./);
    assert.equal(parseAgentMd(text).ok, true);
    const [rec] = await b.records();
    assert.equal(rec.state, "applied");
  } finally {
    await b.cleanup();
  }
});

test("frontmatter merges key by key: a key the user changed (model, color) is kept, a key only the template changed is taken", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    await writeFile(join(b.root, "dev", "agent.md"), md({ model: "anthropic/claude-sonnet-5-5", color: "#112233" }));
    await b.ship({ ...V1, "agent.md": md({ description: "Writes better code." }) });
    await b.make().init();
    const parsed = parseAgentMd(await b.read("agent.md"));
    assert.equal(parsed.meta.description, "Writes better code.");
    assert.equal(parsed.meta.model, "anthropic/claude-sonnet-5-5");
    assert.equal(parsed.meta.color, "#112233");
    assert.equal((await b.records())[0].state, "applied");
  } finally {
    await b.cleanup();
  }
});

test("both sides changed one key differently → a conflict card (Needs you) that keeps the user's body and keys; the shipped text rides on the record; Apply never drops the user's instructions", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    const mine = md({ description: "My description.", body: "Mine entirely." });
    await writeFile(join(b.root, "dev", "agent.md"), mine);
    const V2 = { ...V1, "agent.md": md({ description: "Their description.", body: "Shipped body.\nSecond line." }) };
    await b.ship(V2);
    const engine = b.make();
    await engine.init();
    assert.equal(await b.read("agent.md"), mine, "nothing was written");
    const [rec] = await b.records();
    assert.equal(rec.state, "pending");
    assert.equal(rec.needsClick, true);
    assert.equal(rec.origin.kind, "template-update");
    const parsed = parseAgentMd(rec.after);
    assert.equal(parsed.meta.description, "My description.", "the user's frontmatter key");
    assert.equal(parsed.body, "Mine entirely.", "the user's body");
    assert.equal(rec.origin.shipped, V2["agent.md"], "the shipped text is on the record for the card");
    assert.match(rec.summary, /Apply keeps your instructions and takes only the new settings; the shipped instructions are in the card to merge by hand/);
    assert.doesNotMatch(rec.summary, /uses the new instructions/);
    assert.equal((await engine.history("dev"))[0].origin.shipped, V2["agent.md"], "and on the wire");
    const applied = await engine.apply(rec.id);
    assert.equal(applied.state, "applied");
    assert.equal(await b.read("agent.md"), rec.after);
    assert.match(await b.read("agent.md"), /Mine entirely\./, "the user's instructions survive Apply");
    assert.equal(await b.read(".base", "agent.md"), V2["agent.md"], ".base follows a later click");
  } finally {
    await b.cleanup();
  }
});

test("a body edited on the same lines as the template's is a conflict", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    await writeFile(join(b.root, "dev", "agent.md"), md({ body: "Line one.\nMy line two.\nLine three.\nLine four.\nLine five." }));
    await b.ship({ ...V1, "agent.md": md({ body: "Line one.\nTheir line two.\nLine three.\nLine four.\nLine five." }) });
    await b.make().init();
    const [rec] = await b.records();
    assert.equal(rec.state, "pending");
    assert.match(rec.after, /My line two\./, "the user's line stays");
    assert.doesNotMatch(rec.after, /Their line two\./);
    assert.match(rec.origin.shipped, /Their line two\./, "the shipped line is on the card");
  } finally {
    await b.cleanup();
  }
});

test("an edited agent with no base copy (a box from before this feature): the base is inferred from the shipped history, so it merges cleanly when it can", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    const mine = md({ color: "#112233" });
    await writeFile(join(b.root, "dev", "agent.md"), mine);
    await rm(join(b.root, "dev", ".base"), { recursive: true });
    // the template has only ever had one version: nothing to merge, the base is known to be it
    await b.make().init();
    assert.deepEqual(await b.records(), []);
    assert.equal(await b.read(".base", "agent.md"), V1["agent.md"], "the base copy is made");
    assert.equal(await b.read("agent.md"), mine);
    // now a second version ships and the base is unknown again: the first version is tried as the base and merges cleanly
    await rm(join(b.root, "dev", ".base"), { recursive: true });
    await b.ship({ ...V1, "agent.md": md({ description: "Writes better code." }) });
    await b.make().init();
    const [rec] = await b.records();
    assert.equal(rec.state, "applied");
    const parsed = parseAgentMd(await b.read("agent.md"));
    assert.equal(parsed.meta.description, "Writes better code.");
    assert.equal(parsed.meta.color, "#112233");
  } finally {
    await b.cleanup();
  }
});

test("a box file that matches ANY shipped version in the history is unedited and is replaced, base copy or not", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    await b.ship({ ...V1, "agent.md": md({ description: "Second." }) });
    await rm(join(b.root, "dev", ".base"), { recursive: true });
    await b.ship({ ...V1, "agent.md": md({ description: "Third." }) });
    await b.make().init();
    assert.match(await b.read("agent.md"), /Third\./);
    assert.equal((await b.records())[0].state, "applied");
  } finally {
    await b.cleanup();
  }
});

test("files the template dropped are removed only when the box's copy is untouched", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship({ ...V1, "skills/old/SKILL.md": "---\nname: old\ndescription: Old.\n---\nold\n", "skills/mine/SKILL.md": "---\nname: mine\ndescription: Mine.\n---\nold\n" });
    await b.engine.init();
    await writeFile(join(b.root, "dev", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: Mine.\n---\nedited by the user\n");
    await b.ship({ "agent.md": md({ description: "Second." }), "skills/style/SKILL.md": V1["skills/style/SKILL.md"] });
    await b.make().init();
    await assert.rejects(stat(join(b.root, "dev", "skills", "old", "SKILL.md")), "untouched: removed");
    assert.match(await b.read("skills", "mine", "SKILL.md"), /edited by the user/, "edited: kept");
  } finally {
    await b.cleanup();
  }
});

test("dedupe: the same shipped bundle makes one record in any state; a new bundle makes a new one", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    const mine = md({ description: "Mine.", body: "Mine entirely." });
    await writeFile(join(b.root, "dev", "agent.md"), mine); // a conflict card: the one state a user can discard
    await b.ship({ ...V1, "agent.md": md({ description: "Second.", body: "Shipped.\nSecond." }) });
    const engine = b.make();
    await engine.init();
    await engine.upgradeBuiltIns();
    await b.make().init();
    let recs = await b.records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, "pending");
    await engine.discard(recs[0].id);
    await b.make().init();
    assert.equal((await b.records()).length, 1, "discarded: still one");
    await b.ship({ ...V1, "agent.md": md({ description: "Third.", body: "Shipped.\nThird." }) });
    await b.make().init();
    recs = await b.records();
    assert.equal(recs.length, 2);
    assert.notEqual(recs[0].origin.templateHash, recs[1].origin.templateHash);
  } finally {
    await b.cleanup();
  }
});

test("a clean upgrade applies at every \"Change an agent\" level (Ask and Never included, settings unreadable too); only a merge conflict waits for a click", async () => {
  for (const level of ["auto", "tell", "ask", "never"]) {
    const b = await box({ level });
    try {
      await b.ship(V1);
      await b.engine.init();
      await b.ship({ ...V1, "agent.md": md({ description: "Second." }) });
      await b.make().init();
      const [rec] = await b.records();
      assert.equal(rec.state, "applied", level);
      assert.equal(rec.decidedBy, "auto");
      assert.match(await b.read("agent.md"), /Second\./, level);
      // Undo works as for any change
      const engine = b.make();
      assert.equal((await engine.undo(rec.id)).state, "undone", level);
      assert.equal(await b.read("agent.md"), V1["agent.md"]);
    } finally {
      await b.cleanup();
    }
  }
  // the setting governs agents changing agents, not a shipped release: unreadable settings don't hold it back
  const u = await box({ policyThrows: true });
  try {
    await u.ship(V1);
    await u.engine.init();
    await u.ship({ ...V1, "agent.md": md({ description: "Second." }) });
    await u.make().init();
    assert.equal((await u.records())[0].state, "applied");
  } finally {
    await u.cleanup();
  }
  // a conflict waits, whatever the level (the Never level included: the user still has to choose)
  for (const level of ["auto", "never"]) {
    const c = await box({ level });
    try {
      await c.ship(V1);
      await c.engine.init();
      await writeFile(join(c.root, "dev", "agent.md"), md({ description: "Mine.", body: "Mine entirely." }));
      await c.ship({ ...V1, "agent.md": md({ description: "Theirs.", body: "Shipped body.\nSecond." }) });
      await c.make().init();
      const [rec] = await c.records();
      assert.equal(rec.state, "pending", level);
      assert.equal(rec.needsClick, true);
      assert.match(await c.read("agent.md"), /Mine entirely/);
      // the click applies it even at Never: the setting doesn't govern a shipped release
      assert.equal((await c.make().apply(rec.id)).state, "applied", level);
      assert.match(await c.read("agent.md"), /Mine entirely\./);
    } finally {
      await c.cleanup();
    }
  }
});

test("upgrades run only from init(): list(), sync() and a changed template folder never create a record", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    const engine = b.engine;
    await engine.init();
    await b.ship({ ...V1, "agent.md": md({ description: "Second." }) });
    await engine.sync();
    await engine.list();
    await engine.reconcile();
    assert.deepEqual(await b.records(), []);
    assert.equal(await b.read("agent.md"), V1["agent.md"]);
  } finally {
    await b.cleanup();
  }
});

test("a folder that only shares a built-in's name (another role) is never upgraded", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship({ "agent.md": "---\nname: Manta\ndescription: Leads.\nrole: lead\n---\nLead.\n" });
    await mkdir(join(b.root, "dev"), { recursive: true });
    await writeFile(join(b.root, "dev", "agent.md"), "---\nname: Mine\ndescription: My own agent.\nrole: lead\n---\nSomething else.\n");
    // the user's folder is not ours: no base copy, nothing in the history, a role that differs from the template's
    await b.ship({ "agent.md": "---\nname: Manta\ndescription: Leads, better.\nrole: architect\n---\nLead.\n" });
    await b.make().init();
    assert.deepEqual(await b.records(), []);
    assert.match(await b.read("agent.md"), /Something else/);
  } finally {
    await b.cleanup();
  }
});

test("bundle snapshots: an update record carries before/after file maps and their blobs; an edit anywhere in the folder since makes Apply a conflict", async () => {
  const b = await box({ level: "tell" });
  try {
    const engine = await installThenConflict(b);
    const [rec] = await b.records();
    assert.deepEqual(Object.keys(rec.beforeBundle).sort(), ["agent.md", "skills/style/SKILL.md"]);
    assert.equal(rec.beforeBundle["agent.md"], sha256(MINE));
    assert.equal(rec.afterBundle["agent.md"], sha256(rec.after));
    assert.equal(rec.afterBundle["skills/style/SKILL.md"], rec.beforeBundle["skills/style/SKILL.md"]);
    for (const hash of Object.values({ ...rec.beforeBundle, ...rec.afterBundle })) await stat(join(b.root, ".blobs", hash));
    // a file the string snapshot never saw: the bundle check does
    await writeFile(join(b.root, "dev", "skills", "style", "SKILL.md"), SKILL(" Edited."));
    const out = await engine.apply(rec.id);
    assert.equal(out.state, "conflict");
    assert.match(out.error, /changed since/);
    assert.equal(await b.read("agent.md"), MINE);
  } finally {
    await b.cleanup();
  }
});

test("Undo of a bundle record refuses when any file changed since, and changes nothing", async () => {
  const b = await box({ level: "tell" });
  try {
    const engine = await installThenUpgrade(b);
    const [rec] = await b.records();
    await writeFile(join(b.root, "dev", "skills", "style", "SKILL.md"), SKILL(" Edited."));
    const out = await engine.undo(rec.id);
    assert.equal(out.state, "conflict");
    assert.match(await b.read("agent.md"), /Second\./);
  } finally {
    await b.cleanup();
  }
});

test("a record written before bundles (agent.md strings only) still applies and undoes", async () => {
  const b = await box({ level: "tell" });
  try {
    const engine = await installThenConflict(b);
    const doc = JSON.parse(await readFile(join(b.root, ".changes.json"), "utf-8"));
    for (const r of doc.changes) for (const k of ["beforeBundle", "afterBundle", "baseBefore", "baseAfter"]) delete r[k];
    await writeFile(join(b.root, ".changes.json"), JSON.stringify(doc));
    const applied = await engine.apply(doc.changes[0].id);
    assert.equal(applied.state, "applied");
    assert.match(await b.read("agent.md"), /Mine entirely\./);
    const undone = await engine.undo(doc.changes[0].id);
    assert.equal(undone.state, "undone");
    assert.equal(await b.read("agent.md"), MINE);
  } finally {
    await b.cleanup();
  }
});

test("Restore puts the whole folder back from the bundle, skills included", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    await b.ship({ ...V1, "agent.md": md({ description: "Second." }), "skills/style/SKILL.md": SKILL(" Second.") });
    const engine = b.make();
    await engine.init();
    const [rec] = await b.records();
    // the user (or another change) moves on
    await writeFile(join(b.root, "dev", "skills", "style", "SKILL.md"), SKILL(" Third."));
    const restored = await engine.restore(rec.id);
    assert.equal(restored.state, "applied");
    assert.equal(await b.read("agent.md"), V1["agent.md"]);
    assert.equal(await b.read("skills", "style", "SKILL.md"), V1["skills/style/SKILL.md"]);
    const undone = await engine.undo(restored.id);
    assert.equal(undone.state, "undone");
    assert.equal(await b.read("skills", "style", "SKILL.md"), SKILL(" Third."));
  } finally {
    await b.cleanup();
  }
});

test("blobs nobody references are swept (after a grace period); referenced ones stay", async () => {
  const b = await box({ level: "tell" });
  try {
    const engine = await installThenUpgrade(b);
    const stray = sha256("stray");
    await mkdir(join(b.root, ".blobs"), { recursive: true });
    await writeFile(join(b.root, ".blobs", stray), "stray");
    b.w.clock += 5 * 60_000;
    await engine.reconcile();
    await stat(join(b.root, ".blobs", stray)); // too young
    b.w.clock += 60 * 60_000;
    // the file's own mtime is real time: age it by the clock the engine reads
    const { utimes } = await import("node:fs/promises");
    await utimes(join(b.root, ".blobs", stray), new Date(0), new Date(0));
    await engine.reconcile();
    await assert.rejects(stat(join(b.root, ".blobs", stray)));
    const [rec] = await b.records();
    for (const hash of Object.values(rec.afterBundle)) await stat(join(b.root, ".blobs", hash));
    assert.ok((await readdir(join(b.root, ".blobs"))).length >= 2);
  } finally {
    await b.cleanup();
  }
});

test("mergeAgentMd: frontmatter keys one by one, the body line by line; a result that isn't a valid agent file is a conflict", () => {
  const base = md();
  const next = md({ description: "New.", body: "Line one.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six." });
  const live = md({ color: "#112233", body: "Line one, mine.\nLine two.\nLine three.\nLine four.\nLine five." });
  const r = mergeAgentMd({ live, base, next });
  assert.equal(r.conflict, false);
  const parsed = parseAgentMd(r.text);
  assert.equal(parsed.meta.description, "New.");
  assert.equal(parsed.meta.color, "#112233");
  assert.match(parsed.body, /Line one, mine\./);
  assert.match(parsed.body, /Line six\./);
  const broken = mergeAgentMd({ live: "no frontmatter", base, next });
  assert.equal(broken.conflict, true);
  assert.equal(broken.text, "no frontmatter", "the user's file is never replaced by the shipped one");
  // a body conflict keeps the user's body (and the keys the merge settled); so does a missing base
  const clash = mergeAgentMd({ live: md({ body: "Mine.\nLine two.\nLine three.\nLine four.\nLine five." }), base, next: md({ description: "New.", body: "Theirs.\nLine two.\nLine three.\nLine four.\nLine five." }) });
  assert.equal(clash.conflict, true);
  assert.equal(parseAgentMd(clash.text).body, "Mine.\nLine two.\nLine three.\nLine four.\nLine five.");
  assert.equal(parseAgentMd(clash.text).meta.description, "New.", "a key only the template changed is still taken");
  const noBase = mergeAgentMd({ live: md({ color: "#112233", body: "Mine." }), next });
  assert.equal(noBase.conflict, true);
  assert.equal(parseAgentMd(noBase.text).body, "Mine.");
  assert.equal(parseAgentMd(noBase.text).meta.color, "#112233");
});

const ARCH = (extra = "", body = "You are the Architect.\nLine two.\nLine three.") => `---\nname: Architect\ndescription: Builds agents.\nrole: architect\nisolation: none\n${extra}---\n${body}\n`;
/** An Architect box where the user added a source, then a new template version (one more line) ships and the box boots. */
async function upgradeArchitectWithSources(b) {
  await b.ship({ "agent.md": ARCH() });
  await b.engine.init();
  await writeFile(join(b.root, "architect", "agent.md"), ARCH(SOURCES));
  await b.ship({ "agent.md": ARCH("", "You are the Architect.\nLine two.\nLine three.\nLine four.") });
  await b.make().init();
}
const SOURCES = 'sources:\n  - id: yc\n    name: YC\n    description: Search the YC directory.\n    url: "https://search.example.com/api?q={query}"\n';

test("the Architect's own sources (frontmatter the template doesn't have) are kept through an upgrade", async () => {
  const b = await box({ level: "tell", slug: "architect" });
  try {
    await upgradeArchitectWithSources(b);
    const parsed = parseAgentMd(await b.read("agent.md"));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.meta.sources.length, 1, "the user's source stays");
    assert.match(parsed.body, /Line four\./);
    assert.equal((await b.records())[0].state, "applied");
  } finally {
    await b.cleanup();
  }
});

test("a merged Architect file whose sources fail the Architect's checks (a credential in a source) waits for a click instead of being applied", async () => {
  const b = await box({ level: "tell", slug: "architect", extra: { createScanner: () => ({ scan: async () => ({ clean: false, unavailable: false, hits: [{ source: "store" }] }) }) } });
  try {
    await upgradeArchitectWithSources(b);
    const [rec] = await b.records();
    assert.equal(rec.state, "pending");
    assert.equal(rec.needsClick, true);
    assert.match(await b.read("agent.md"), /sources:/, "nothing written");
    assert.doesNotMatch(await b.read("agent.md"), /Line four\./);
  } finally {
    await b.cleanup();
  }
});

// ---- a box with no .base copy: the base is inferred from the shipped history (the live-box regression) ----

const DEV_V1 = md({ body: "Line one.\nLine two.\nLine three.\nLine four.\nLine five." });
const DEV_V2 = md({ description: "Writes better code.", body: "Line one.\nLine two, sharper.\nLine three.\nLine four.\nLine five." });
const TEST_FIRST = "Always write the failing test first.";
/** What the user made of DEV_V2: their own model and one more rule. */
const DEV_MINE = md({ description: "Writes better code.", model: "anthropic/claude-sonnet-5-5", body: `Line one.\nLine two, sharper.\nLine three.\nLine four.\nLine five.\n${TEST_FIRST}` });

/** A box that has run before the base copies existed: the template shipped two versions, the folder has the user's file and no `.base`. */
async function boxWithoutBase(b, live) {
  await b.ship({ "agent.md": DEV_V1 });
  await b.ship({ "agent.md": DEV_V2 });
  await mkdir(join(b.root, "dev"), { recursive: true });
  await writeFile(join(b.root, "dev", "agent.md"), live);
}

test("no .base, the user's edits on top of the newest shipped version, the template unchanged since: no upgrade, no record, .base is made (the dev regression)", async () => {
  const b = await box({ level: "tell" });
  try {
    await boxWithoutBase(b, DEV_MINE);
    await b.make().init();
    assert.deepEqual(await b.records(), [], "nothing to offer: the template has nothing the user lacks");
    assert.equal(await b.read("agent.md"), DEV_MINE, "the user's file is untouched, test-first rule included");
    assert.equal(await b.read(".base", "agent.md"), DEV_V2, "the base copy is made from the shipped version");
    await b.make().init();
    assert.deepEqual(await b.records(), [], "and a second boot is quiet too");
  } finally {
    await b.cleanup();
  }
});

test("no .base, edits on top of an OLD shipped version (the Architect with its own sources): older versions are tried as the base until one merges, then it applies", async () => {
  const b = await box({ level: "tell", slug: "architect" });
  try {
    await b.ship({ "agent.md": ARCH() });
    await b.ship({ "agent.md": ARCH("", "You are the Architect.\nLine two.\nLine three.\nLine four.") });
    await b.ship({ "agent.md": ARCH("", "You are the Architect.\nLine two.\nLine three.\nLine four.\nLine five.") });
    await mkdir(join(b.root, "architect"), { recursive: true });
    // the first version plus the user's sources: the newest older version (the second) can't merge, the first does
    await writeFile(join(b.root, "architect", "agent.md"), ARCH(SOURCES));
    await b.make().init();
    const parsed = parseAgentMd(await b.read("agent.md"));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.meta.sources.length, 1, "the user's source stays");
    assert.match(parsed.body, /Line five\./, "the new shipped lines land");
    const [rec, ...none] = await b.records();
    assert.equal(none.length, 0);
    assert.equal(rec.state, "applied");
    assert.equal(rec.origin.kind, "template-update");
    assert.equal(await b.read(".base", "agent.md"), ARCH("", "You are the Architect.\nLine two.\nLine three.\nLine four.\nLine five."));
  } finally {
    await b.cleanup();
  }
});

test("no .base and no shipped version merges: a conflict card that keeps the user's instructions; Apply takes only the new settings", async () => {
  const b = await box({ level: "tell" });
  try {
    const mine = md({ description: "Writes better code.", color: "#112233", body: `Do it my way.\n${TEST_FIRST}` });
    await boxWithoutBase(b, mine);
    const engine = b.make();
    await engine.init();
    const [rec] = await b.records();
    assert.equal(rec.state, "pending");
    assert.equal(rec.needsClick, true);
    assert.equal(await b.read("agent.md"), mine, "nothing written");
    assert.equal(rec.origin.shipped, DEV_V2, "the shipped text is in the record");
    const parsed = parseAgentMd(rec.after);
    assert.equal(parsed.body, `Do it my way.\n${TEST_FIRST}`, "the card's file keeps the user's instructions");
    assert.equal(parsed.meta.color, "#112233");
    assert.match(rec.summary, /Apply keeps your instructions and takes only the new settings; the shipped instructions are in the card to merge by hand/);
    await engine.apply(rec.id);
    assert.match(await b.read("agent.md"), new RegExp(TEST_FIRST));
    assert.equal(await b.read(".base", "agent.md"), DEV_V2);
  } finally {
    await b.cleanup();
  }
});

test("a conflict never overwrites a user's skill either: the user's file stays, the shipped one is not written", async () => {
  const b = await box({ level: "tell" });
  try {
    await b.ship(V1);
    await b.engine.init();
    const mine = SKILL(" Mine.");
    await writeFile(join(b.root, "dev", "skills", "style", "SKILL.md"), mine);
    await b.ship({ ...V1, "skills/style/SKILL.md": SKILL(" Theirs.") });
    await b.make().init();
    const [rec] = await b.records();
    assert.equal(rec.state, "pending");
    await b.make().apply(rec.id);
    assert.equal(await b.read("skills", "style", "SKILL.md"), mine);
  } finally {
    await b.cleanup();
  }
});

// ---- stale records ----

const THEIRS = md({ body: "Line one.\nTheir line two.\nLine three.\nLine four.\nLine five." });
/** A pending conflict card for `dev` (the user and the template both changed line two). */
async function pendingConflict(b) {
  await b.ship(V1);
  await b.engine.init();
  await writeFile(join(b.root, "dev", "agent.md"), md({ body: "Line one.\nMy line two.\nLine three.\nLine four.\nLine five." }));
  await b.ship({ ...V1, "agent.md": THEIRS });
  await b.make().init();
  const [rec] = await b.records();
  assert.equal(rec.state, "pending");
  return rec;
}

test("a pending template-update card whose re-plan is now a no-op is discarded as superseded", async () => {
  const b = await box({ level: "tell" });
  try {
    const stale = await pendingConflict(b);
    await writeFile(join(b.root, "dev", "agent.md"), THEIRS); // the user took the shipped text by hand
    const logs = [];
    await b.make({ log: { warn: (m) => logs.push(m), info: (m) => logs.push(m) } }).init();
    const recs = await b.records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].id, stale.id);
    assert.equal(recs[0].state, "discarded");
    assert.equal(recs[0].error, "superseded by a re-plan");
    assert.ok(logs.some((m) => /superseded/.test(m)), "logged");
    assert.equal(await b.read("agent.md"), THEIRS);
  } finally {
    await b.cleanup();
  }
});

test("a pending card whose re-plan is a clean merge is discarded as superseded, and the merge is applied (the same bundle is not blocked by the dedupe)", async () => {
  const b = await box({ level: "tell" });
  try {
    const stale = await pendingConflict(b);
    // the user resolves it by hand in a way that merges cleanly: only line four is theirs
    await writeFile(join(b.root, "dev", "agent.md"), md({ body: "Line one.\nLine two.\nLine three.\nMy line four.\nLine five." }));
    await b.make().init();
    const recs = await b.records();
    assert.equal(recs.length, 2);
    const old = recs.find((r) => r.id === stale.id);
    assert.equal(old.state, "discarded");
    assert.equal(old.error, "superseded by a re-plan");
    const fresh = recs.find((r) => r.id !== stale.id);
    assert.equal(fresh.state, "applied");
    assert.equal(fresh.origin.templateHash, stale.origin.templateHash);
    const text = await b.read("agent.md");
    assert.match(text, /Their line two\./);
    assert.match(text, /My line four\./);
    // a later boot makes nothing more
    await b.make().init();
    assert.equal((await b.records()).length, 2);
  } finally {
    await b.cleanup();
  }
});

test("a pending card made by the old planner (shipped body, no shipped text) is replaced by a card that keeps the user's body; a current card is left alone", async () => {
  const b = await box({ level: "tell" });
  try {
    const stale = await pendingConflict(b);
    const doc = JSON.parse(await readFile(join(b.root, ".changes.json"), "utf-8"));
    delete doc.changes[0].origin.shipped; // how an old card looked
    await writeFile(join(b.root, ".changes.json"), JSON.stringify(doc));
    await b.make().init();
    let recs = await b.records();
    assert.equal(recs.length, 2);
    assert.equal(recs.find((r) => r.id === stale.id).state, "discarded");
    const fresh = recs.find((r) => r.id !== stale.id);
    assert.equal(fresh.state, "pending");
    assert.match(fresh.origin.shipped, /Their line two\./);
    assert.match(fresh.after, /My line two\./);
    await b.make().init();
    recs = await b.records();
    assert.equal(recs.length, 2, "the current card is kept, not re-made on every boot");
    assert.equal(recs.find((r) => r.id === fresh.id).state, "pending");
  } finally {
    await b.cleanup();
  }
});

test("a card the user discarded stays discarded: only a superseded one is ignored by the dedupe", async () => {
  const b = await box({ level: "tell" });
  try {
    const stale = await pendingConflict(b);
    await b.make().discard(stale.id);
    await b.make().init();
    const recs = await b.records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, "discarded");
    assert.equal(recs[0].error ?? null, null);
  } finally {
    await b.cleanup();
  }
});
