// What the Architect's research-skill wording change does on boxes that already run the previous release (review round 1, finding 6): the
// real shipped template and its `.versions/` history, a box laid out as the previous release left it, then `init()` (which runs
// `upgradeBuiltIns` once per boot).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine } from "./agents.mjs";

const TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const SKILL = "skills/research/SKILL.md";
const NEW_SKILL = await readFile(join(TEMPLATES, "architect", SKILL), "utf-8");
const history = JSON.parse(await readFile(join(TEMPLATES, "architect", ".history.json"), "utf-8"));
const OLD_SKILL = await readFile(join(TEMPLATES, "architect", ".versions", history[SKILL].at(-2)), "utf-8");

async function box(live) {
  const base = await mkdtemp(join(tmpdir(), "agents-rollout-"));
  const root = join(base, "agents");
  // a box as the previous release left it: the Architect installed with the previous research skill, `.base/` the same
  const skip = (src) => !/\/\.(history\.json|versions)$/.test(src);
  await cp(join(TEMPLATES, "architect"), join(root, "architect"), { recursive: true, filter: skip });
  await mkdir(join(root, "architect", "home"), { recursive: true });
  await cp(join(TEMPLATES, "architect"), join(root, "architect", ".base"), { recursive: true, filter: skip });
  await writeFile(join(root, "architect", ".base", SKILL), OLD_SKILL);
  await writeFile(join(root, "architect", SKILL), live);
  const engine = createAgentsEngine({
    root,
    templatesDir: TEMPLATES,
    home: "/h",
    retryDelayMs: 0,
    isGitRepo: async () => true,
    log: { warn: () => {} },
    editConfig: async () => ({ ok: true, changed: false }),
    reload: async () => ({ ok: true }),
    oc: { readSession: async () => ({ state: "missing" }), listMessages: async () => [] },
    delegate: { loadRecordsStrict: async () => [] },
    tmux: { listProjects: async () => [] },
  });
  const records = async () => (await engine.history("architect")).filter((r) => r.origin?.kind === "template-update");
  return { root, engine, records, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("the wording changed in the shipped skill, and only there", () => {
  assert.notEqual(NEW_SKILL, OLD_SKILL);
  assert.match(OLD_SKILL, /listed in your brief/);
  assert.doesNotMatch(NEW_SKILL, /your brief/);
  assert.match(NEW_SKILL, /Your research sources/);
  assert.match(NEW_SKILL, /Settings → Research sources/);
});

test("a box that never edited the skill: ONE quiet record, applied at once (Undo on it), no card waiting for a click; the next boot adds nothing", async () => {
  const b = await box(OLD_SKILL);
  try {
    await b.engine.init();
    const [rec, ...none] = await b.records();
    assert.equal(none.length, 0);
    assert.equal(rec.state, "applied");
    assert.equal(rec.needsClick, false);
    assert.equal(rec.decidedBy, "auto");
    assert.equal(await readFile(join(b.root, "architect", SKILL), "utf-8"), NEW_SKILL);
    await b.engine.init();
    assert.equal((await b.records()).length, 1);
  } finally {
    await b.cleanup();
  }
});

test("a box whose user edited another part of the skill: the new wording merges in, the user's edit stays, still one applied record", async () => {
  const mine = `${OLD_SKILL.trimEnd()}\n\n## My own rule\n\nAlways cite the year.\n`;
  const b = await box(mine);
  try {
    await b.engine.init();
    const [rec, ...none] = await b.records();
    assert.equal(none.length, 0);
    assert.equal(rec.state, "applied");
    const after = await readFile(join(b.root, "architect", SKILL), "utf-8");
    assert.match(after, /Always cite the year\./);
    assert.match(after, /Your research sources/);
    assert.doesNotMatch(after, /listed in your brief/);
  } finally {
    await b.cleanup();
  }
});

test("a box whose user rewrote the very lines that changed: the skill stays as they wrote it and ONE card waits for a click (Needs you) — never a second one on later boots", async () => {
  const mine = OLD_SKILL.replace("any extra\n  source listed in your brief by its id.", "any extra\n  source the user told me about, by its id.");
  assert.notEqual(mine, OLD_SKILL);
  const b = await box(mine);
  try {
    await b.engine.init();
    const [rec, ...none] = await b.records();
    assert.equal(none.length, 0);
    assert.equal(rec.state, "pending");
    assert.equal(rec.needsClick, true);
    assert.equal(await readFile(join(b.root, "architect", SKILL), "utf-8"), mine, "nothing of theirs was overwritten");
    await b.engine.init();
    assert.equal((await b.records()).length, 1);
  } finally {
    await b.cleanup();
  }
});
