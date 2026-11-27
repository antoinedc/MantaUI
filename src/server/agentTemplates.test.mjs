// Stage 0 (docs/superpowers/specs/2026-11-27-architect-v2.md §2): every built-in template ships a `.history.json` of the
// hashes of every version of each of its files that was ever shipped. A box whose file still matches one of them is
// unedited and is replaced outright by an upgrade; everything else is merged. A template file changed without
// `node scripts/agents/template-history.mjs` fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, templateFiles, historyOf, HISTORY_FILE, VERSIONS_DIR } from "../../scripts/agents/template-history.mjs";

const TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));

const slugs = async () => (await readdir(TEMPLATES, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();

test("every built-in template has a .history.json holding the hash of each of its current files", async () => {
  const found = await slugs();
  assert.deepEqual(found, ["architect", "dev", "manta"]);
  for (const slug of found) {
    const history = JSON.parse(await readFile(join(TEMPLATES, slug, HISTORY_FILE), "utf-8"));
    const files = await templateFiles(join(TEMPLATES, slug));
    assert.ok(files.length > 0, slug);
    for (const rel of files) {
      const hash = sha256(await readFile(join(TEMPLATES, slug, rel)));
      assert.ok(Array.isArray(history[rel]), `${slug}/${rel} is missing from ${HISTORY_FILE}; run: node scripts/agents/template-history.mjs`);
      assert.ok(history[rel].includes(hash), `${slug}/${rel} changed without a ${HISTORY_FILE} entry; run: node scripts/agents/template-history.mjs`);
      assert.equal(history[rel].at(-1), hash, `${slug}/${rel}: the newest history hash must be the shipped file`);
    }
  }
});

test("the history lists each version once, and a template file's older versions from git are in it", async () => {
  for (const slug of await slugs()) {
    const history = JSON.parse(await readFile(join(TEMPLATES, slug, HISTORY_FILE), "utf-8"));
    for (const [rel, hashes] of Object.entries(history)) {
      assert.equal(new Set(hashes).size, hashes.length, `${slug}/${rel} repeats a hash`);
      for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
    }
  }
  // the Architect's agent.md has been rewritten several times: boxes that never edited it carry one of those versions
  const arch = JSON.parse(await readFile(join(TEMPLATES, "architect", HISTORY_FILE), "utf-8"));
  assert.ok(arch["agent.md"].length >= 2, "older shipped versions were back-filled from git");
});

test("every hash in a template's history has its text in .versions/ (a box with no .base copy merges against it)", async () => {
  for (const slug of await slugs()) {
    const history = JSON.parse(await readFile(join(TEMPLATES, slug, HISTORY_FILE), "utf-8"));
    for (const [rel, hashes] of Object.entries(history)) {
      for (const h of hashes) {
        const text = await readFile(join(TEMPLATES, slug, VERSIONS_DIR, h)).catch(() => null);
        assert.ok(text, `${slug}/${rel}: no text for ${h.slice(0, 12)} in ${VERSIONS_DIR}/; run: node scripts/agents/template-history.mjs --backfill`);
        assert.equal(sha256(text), h, `${slug}/${VERSIONS_DIR}/${h.slice(0, 12)} is not the text its name says`);
      }
    }
    // the bookkeeping folder is not part of the template
    assert.ok(!(await templateFiles(join(TEMPLATES, slug))).some((f) => f.startsWith(VERSIONS_DIR)));
  }
});

test("historyOf: appends a new hash, keeps the order, never duplicates", () => {
  const files = { "agent.md": sha256("v2") };
  assert.deepEqual(historyOf({ "agent.md": [sha256("v1")] }, files), { "agent.md": [sha256("v1"), sha256("v2")] });
  assert.deepEqual(historyOf({ "agent.md": [sha256("v2"), sha256("v1")] }, files), { "agent.md": [sha256("v1"), sha256("v2")] }, "the shipped hash moves last");
  assert.deepEqual(historyOf({}, files), { "agent.md": [sha256("v2")] });
});
