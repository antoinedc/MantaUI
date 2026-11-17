import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK_END, BLOCK_START, GLOBAL_HEADING, MIRROR_PATH, PREFERENCES_PATH, createGlobalBlock, findBlock, renderBlock, spliceBlock } from "./globalBlock.mjs";
import { curatorRig } from "./curatorRig.mjs";
import { tmpDir } from "./testHelpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

test("spliceBlock creates the section at the end, replaces only the inner text, and leaves everything else byte for byte", () => {
  const user = "# My notes\n\nKeep   this\ttext exactly.\n\n## Own section\n\nmine\n";
  const first = spliceBlock(user, "- one\n- two");
  assert.ok(first.startsWith(user));
  assert.match(first, new RegExp(`${GLOBAL_HEADING.replace(/[()]/g, "\\$&")}\\n\\n${BLOCK_START}\\n- one\\n- two\\n${BLOCK_END}\\n$`));
  const second = spliceBlock(`${first}\n## After\n\ntail\n`, "- changed");
  assert.ok(second.startsWith(user));
  assert.match(second, /- changed\n<!-- manta:knowledge:end -->\n\n## After\n\ntail\n$/);
  assert.doesNotMatch(second, /- one/);
  assert.equal(findBlock(second).inner, "- changed");
  assert.equal(spliceBlock("", "- a").startsWith(GLOBAL_HEADING), true);
});

test("a heading with no markers is wrapped (what the user wrote under it is adopted as the block)", () => {
  const src = `# Top\n\n${GLOBAL_HEADING}\n\n- hand written\n\n## Next\n\nx\n`;
  assert.equal(findBlock(src).inner, "- hand written");
  const out = spliceBlock(src, "- rendered");
  assert.match(out, /- rendered\n<!-- manta:knowledge:end -->\n\n## Next\n\nx\n/);
  assert.doesNotMatch(out, /hand written/);
});

test("the block is capped at 200 lines in all", () => {
  const many = Array.from({ length: 250 }, (_, i) => `pref ${i}`);
  const r = renderBlock(many);
  assert.equal(r.truncated, true);
  assert.equal(r.text.split("\n").length + 4, 200);
});

test("the block's own `## ` heading is not one Manta ships, so the guidance sync leaves it alone", async () => {
  assert.match(GLOBAL_HEADING, /^## /);
  assert.doesNotMatch(await readFile(join(REPO, "docs/opencode-tools/AGENTS.md"), "utf8"), /Learned preferences \(managed by Manta\)/);
  const dir = await tmpDir("guidance-");
  const dest = join(dir, "AGENTS.md");
  const body = `# Mine\n\nhello\n\n${spliceBlock("", "- Prefer tabs\n- Never force-push").trimEnd()}\n`;
  await writeFile(dest, body);
  const script = `set -euo pipefail
log() { :; }; ok() { :; }; warn() { printf 'warn: %s\\n' "$*" >&2; }; die() { exit 1; }
source '${join(REPO, "scripts/lib/release.sh")}'
export MANTA_STATE_HOME='${dir}'
mkdir -p "$MANTA_STATE_HOME/.manta"
sync_opencode_guidance '${join(REPO, "docs/opencode-tools/AGENTS.md")}' '${dest}'`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const after = await readFile(dest, "utf8");
  assert.ok(after.includes(body.trimEnd()), "the managed section survived the sync unchanged");
});

async function prefRig(over = {}) {
  const dir = await tmpDir("global-agents-");
  const globalPath = join(dir, "cfg", "AGENTS.md");
  const r = await curatorRig({ globalPath, ...over });
  return { r, globalPath };
}
const writePrefs = (r, bullets) => r.engine.store.commit({ path: PREFERENCES_PATH, content: `---\ntitle: Preferences\n---\n# Preferences\n\n${bullets.map((b) => `- ${b}`).join("\n")}\n`, message: "prefs" });

test("apply renders user/preferences.md into the global file (created if missing) and mirrors it as a store commit", async () => {
  const { r, globalPath } = await prefRig();
  await writePrefs(r, ["Prefer tabs", "Never force-push"]);
  const res = await r.engine.layer.globalBlock.apply({ reason: "test" });
  assert.deepEqual([res.ok, res.changed, res.count], [true, true, 2]);
  const txt = await readFile(globalPath, "utf8");
  assert.match(txt, /- Prefer tabs\n- Never force-push\n/);
  assert.match(await r.engine.store.read(MIRROR_PATH), /Prefer tabs/);
  assert.equal((await r.engine.layer.globalBlock.apply({})).changed, false);
  await r.engine.stop();
});

test("a hand edit inside the block is adopted into user/preferences.md as a user commit, and wins over the next render", async () => {
  const { r, globalPath } = await prefRig();
  await writePrefs(r, ["Prefer tabs"]);
  await r.engine.layer.globalBlock.apply({});
  const edited = (await readFile(globalPath, "utf8")).replace("- Prefer tabs", "- Prefer tabs\n- Written by hand");
  await writeFile(globalPath, `# Top of the file\n\n${edited}`);
  const res = await r.engine.layer.globalBlock.apply({ reason: "test" });
  assert.equal(res.adopted, true);
  assert.match(await r.engine.store.read(PREFERENCES_PATH), /- Written by hand/);
  const log = await r.engine.store.log({ path: PREFERENCES_PATH, limit: 3 });
  assert.match(log[0].subject, /Adopt your edit/);
  assert.notEqual(log[0].author, "Manta curator");
  const txt = await readFile(globalPath, "utf8");
  assert.ok(txt.startsWith("# Top of the file\n\n"));
  assert.match(txt, /- Written by hand/);
  await r.engine.stop();
});

test("global writes are batched: a pending change waits for 04:00 and runs once per day", async () => {
  const { r, globalPath } = await prefRig();
  const gb = r.engine.layer.globalBlock;
  await writePrefs(r, ["Prefer tabs"]);
  gb.markPending();
  r.clock.t = Date.parse("2026-11-17T03:30:00");
  assert.deepEqual(await gb.runDailyIfDue(), { ran: false, reason: "before-batch-time" });
  await assert.rejects(readFile(globalPath, "utf8"));
  r.clock.t = Date.parse("2026-11-17T04:05:00");
  const ran = await gb.runDailyIfDue();
  assert.equal(ran.ran, true);
  assert.match(await readFile(globalPath, "utf8"), /Prefer tabs/);
  await writePrefs(r, ["Prefer tabs", "Another"]);
  gb.markPending();
  assert.deepEqual(await gb.runDailyIfDue(), { ran: false, reason: "already-ran" });
  assert.doesNotMatch(await readFile(globalPath, "utf8"), /Another/);
  r.clock.t = Date.parse("2026-11-18T04:00:00");
  assert.equal((await gb.runDailyIfDue()).ran, true);
  assert.match(await readFile(globalPath, "utf8"), /Another/);
  await r.engine.stop();
});

test("without a global path the block is off and says so", async () => {
  const r = await curatorRig();
  assert.equal(r.engine.layer.globalBlock.enabled, false);
  assert.deepEqual(await r.engine.layer.globalBlock.apply({}), { ok: false, off: true });
  assert.deepEqual(await r.engine.layer.globalBlock.runDailyIfDue(), { ran: false, reason: "off" });
  await r.engine.stop();
});

function standalone(r, globalPath, over = {}) {
  const reports = [];
  const gb = createGlobalBlock({ path: globalPath, store: r.engine.store, state: r.engine.state, now: () => r.clock.t, log: () => {}, report: (e) => reports.push(e), ...over });
  return { gb, reports };
}

test("the global block is secret-scanned: a preference with a secret is left out of the file and reported; the rest is written", async () => {
  const { r, globalPath } = await prefRig({ over: { secretValues: () => ["hunter2-super-secret-value"] } });
  await writePrefs(r, ["Prefer tabs"]);
  // the store never serves a file holding a secret, so hand the block a store that does (defence in depth)
  const leaky = { ...r.engine.store, read: async (p) => (p === PREFERENCES_PATH ? "# Preferences\n\n- Prefer tabs\n- Token is hunter2-super-secret-value\n- Never force-push\n" : r.engine.store.read(p)) };
  const reports = [];
  const gb = createGlobalBlock({ path: globalPath, store: leaky, state: r.engine.state, now: () => r.clock.t, log: () => {}, scan: (t) => r.engine.scanner.scan(t), report: (e) => reports.push(e) });
  const res = await gb.apply({ reason: "test" });
  assert.equal(res.ok, true);
  const txt = await readFile(globalPath, "utf8");
  assert.match(txt, /Prefer tabs/);
  assert.match(txt, /Never force-push/);
  assert.doesNotMatch(txt, /hunter2/);
  assert.doesNotMatch(await r.engine.store.read(MIRROR_PATH), /hunter2/);
  assert.ok(reports.some((i) => i.kind === "dropped" && /Left a preference out of the global instructions/.test(i.summary)));
  await r.engine.stop();
});

test("a hand edit of the block that contains a secret is not adopted", async () => {
  const { r, globalPath } = await prefRig({ over: { secretValues: () => ["hunter2-super-secret-value"] } });
  await writePrefs(r, ["Prefer tabs"]);
  await r.engine.layer.globalBlock.apply({});
  const edited = (await readFile(globalPath, "utf8")).replace("- Prefer tabs", "- Prefer tabs\n- key hunter2-super-secret-value");
  await writeFile(globalPath, edited);
  await r.engine.layer.globalBlock.apply({});
  assert.doesNotMatch(await r.engine.store.read(PREFERENCES_PATH), /hunter2/);
  assert.doesNotMatch(await readFile(globalPath, "utf8"), /hunter2/);
  await r.engine.stop();
});

test("the daily batch day is recorded only after a successful write; a failure is reported once and retried (after the back-off)", async () => {
  const { r, globalPath } = await prefRig();
  await writePrefs(r, ["Prefer tabs"]);
  let fail = true;
  const { gb, reports } = standalone(r, globalPath, { writeFileFn: async (p, t) => (fail ? Promise.reject(new Error("disk full")) : writeFile(p, t)) });
  gb.markPending();
  r.clock.t = Date.parse("2026-11-17T04:05:00");
  const first = await gb.runDailyIfDue();
  assert.equal(first.ok, false);
  assert.equal(reports.length, 1);
  assert.match(reports[0].reason, /disk full/);
  assert.equal(gb.isPending(), true);
  assert.deepEqual(await gb.runDailyIfDue(), { ran: false, reason: "backoff" });
  r.clock.t += 16 * 60_000; // same day, past the back-off: tried again, reported not again
  assert.equal((await gb.runDailyIfDue()).ok, false);
  assert.equal(reports.length, 1);
  fail = false;
  r.clock.t += 16 * 60_000;
  const ok = await gb.runDailyIfDue();
  assert.equal(ok.ok, true);
  assert.match(await readFile(globalPath, "utf8"), /Prefer tabs/);
  assert.deepEqual(await gb.runDailyIfDue(), { ran: false, reason: "already-ran" });
  await r.engine.stop();
});

test("every write of the global file goes through one mutex (undo, the daily batch, the downgrade) and is atomic: temp file + rename in the same directory", async () => {
  const { r, globalPath } = await prefRig();
  await writePrefs(r, ["One"]);
  let active = 0;
  let maxActive = 0;
  const renames = [];
  const slow = async (p, t) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((res) => setTimeout(res, 20));
    await writeFile(p, t);
    active--;
  };
  const { gb } = standalone(r, globalPath, { writeFileFn: slow, renameFn: async (a, b) => (renames.push([a, b]), (await import("node:fs/promises")).rename(a, b)) });
  const first = gb.apply({ reason: "undo" });
  await writePrefs(r, ["One", "Two"]);
  const second = gb.apply({ reason: "batch" });
  const third = gb.apply({ reason: "downgrade" });
  await Promise.all([first, second, third]);
  assert.equal(maxActive, 1, "writes never overlap");
  assert.ok(renames.length >= 1);
  for (const [tmp, target] of renames) {
    assert.equal(dirname(tmp), dirname(target));
    assert.notEqual(tmp, target);
  }
  const txt = await readFile(globalPath, "utf8");
  assert.match(txt, /- One\n- Two\n/);
  assert.equal(txt.split(BLOCK_START).length, 2, "one block, not interleaved halves");
  const left = (await readdir(dirname(globalPath))).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(left, []);
  await r.engine.stop();
});

test("a symlinked AGENTS.md is written through its target and stays a symlink", async () => {
  const { r } = await prefRig();
  const dir = await tmpDir("global-link-");
  const real = join(dir, "dotfiles-AGENTS.md");
  const link = join(dir, "AGENTS.md");
  await writeFile(real, "# mine\n");
  await symlink(real, link);
  await writePrefs(r, ["Prefer tabs"]);
  const { gb } = standalone(r, link);
  assert.equal((await gb.apply({})).ok, true);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.match(await readFile(real, "utf8"), /Prefer tabs/);
  assert.ok((await readFile(real, "utf8")).startsWith("# mine\n"));
  await r.engine.stop();
});

test("an undo whose global write fails still undoes, and hands the caller a warning (engine.undo passes it on)", async () => {
  const { r, globalPath } = await prefRig();
  const rule = (await import("./decisions.mjs")).normalizeDecision;
  void rule;
  await writePrefs(r, ["Prefer tabs"]);
  const id = r.engine.changesLog.add({ kind: "applied", summary: "Noted a preference: Prefer tabs", undoable: true, commitSha: await r.engine.store.head(), data: { kind: "preference", path: PREFERENCES_PATH, text: "Prefer tabs", noTombstone: true } });
  await mkdir(globalPath, { recursive: true }); // the "file" is a directory: the write must fail
  const res = await r.engine.undo({ id });
  assert.equal(res.ok, true);
  assert.match(res.warning, /global file couldn't be updated/);
  assert.equal(r.engine.layer.globalBlock.isPending(), true, "left for the daily batch to retry");
  await r.engine.stop();
});
