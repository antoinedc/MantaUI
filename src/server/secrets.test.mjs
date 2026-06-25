import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidKey,
  isValidScope,
  isValidProject,
  toMeta,
  visibleSecrets,
  resolveSecret,
  materializedPath,
  setSecret,
  deleteSecret,
  listSecrets,
  provideSecret,
} from "./secrets.mjs";

// ----------------------------------------------------------------------------
// isValidKey / isValidScope
// ----------------------------------------------------------------------------

test("isValidKey accepts env-var-style identifiers", () => {
  for (const ok of ["GITHUB_PAT", "x", "_priv", "a1", "API_KEY_2", "k".repeat(64)]) {
    assert.equal(isValidKey(ok), true, `${ok} should be valid`);
  }
});

test("isValidKey rejects unsafe / path-like keys", () => {
  for (const bad of [
    "",
    "1leading",
    "has-dash",
    "has.dot",
    "has/slash",
    "../escape",
    "has space",
    "k".repeat(65),
    null,
    42,
  ]) {
    assert.equal(isValidKey(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test("isValidScope allows shared|session|project", () => {
  assert.equal(isValidScope("shared"), true);
  assert.equal(isValidScope("session"), true);
  assert.equal(isValidScope("project"), true);
  assert.equal(isValidScope("global"), false);
  assert.equal(isValidScope(""), false);
});

test("isValidProject accepts workspace names, rejects path-unsafe", () => {
  for (const ok of ["Ronda", "BUI", "ethernal", "my-proj_1.2"]) {
    assert.equal(isValidProject(ok), true, `${ok} valid`);
  }
  for (const bad of ["", "a/b", "../x", "name space", "x".repeat(65), null]) {
    assert.equal(isValidProject(bad), false, `${JSON.stringify(bad)} invalid`);
  }
});

// ----------------------------------------------------------------------------
// toMeta — never leaks value
// ----------------------------------------------------------------------------

test("toMeta strips the value and reports hasValue", () => {
  const meta = toMeta({
    id: "abc",
    key: "K",
    value: "supersecret",
    scope: "shared",
    sessionID: null,
    hint: "use it",
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal("value" in meta, false);
  assert.equal(meta.hasValue, true);
  assert.equal(meta.key, "K");
  assert.equal(meta.hint, "use it");
});

test("toMeta hasValue=false for empty value", () => {
  assert.equal(toMeta({ key: "K", value: "" }).hasValue, false);
  assert.equal(toMeta({ key: "K" }).hasValue, false);
});

// ----------------------------------------------------------------------------
// visibleSecrets — shared + session, with shadowing
// ----------------------------------------------------------------------------

const SAMPLE = [
  { id: "1", key: "SHARED_A", value: "a", scope: "shared", sessionID: null },
  { id: "2", key: "SHARED_B", value: "b", scope: "shared", sessionID: null },
  { id: "3", key: "OWN", value: "x", scope: "session", sessionID: "ses_1" },
  { id: "4", key: "OTHER", value: "y", scope: "session", sessionID: "ses_2" },
  { id: "5", key: "SHARED_B", value: "override", scope: "session", sessionID: "ses_1" },
];

test("visibleSecrets returns shared + own session secrets", () => {
  const keys = visibleSecrets(SAMPLE, "ses_1").map((m) => m.key).sort();
  // SHARED_A, SHARED_B (own override shadows shared), OWN
  assert.deepEqual(keys, ["OWN", "SHARED_A", "SHARED_B"]);
  // OTHER (ses_2) must NOT be visible to ses_1
  assert.equal(keys.includes("OTHER"), false);
});

test("visibleSecrets session-scoped shadows shared of same name", () => {
  const metas = visibleSecrets(SAMPLE, "ses_1");
  const b = metas.filter((m) => m.key === "SHARED_B");
  assert.equal(b.length, 1, "only one SHARED_B visible");
  assert.equal(b[0].scope, "session", "the session-scoped one wins");
});

test("visibleSecrets with no sessionID returns only shared", () => {
  const keys = visibleSecrets(SAMPLE, undefined).map((m) => m.key).sort();
  assert.deepEqual(keys, ["SHARED_A", "SHARED_B"]);
});

test("visibleSecrets never leaks values", () => {
  for (const m of visibleSecrets(SAMPLE, "ses_1")) {
    assert.equal("value" in m, false);
  }
});

// ----------------------------------------------------------------------------
// resolveSecret — session wins over shared
// ----------------------------------------------------------------------------

test("resolveSecret prefers session-scoped over shared", () => {
  const r = resolveSecret(SAMPLE, "SHARED_B", "ses_1");
  assert.equal(r.value, "override");
});

test("resolveSecret falls back to shared", () => {
  assert.equal(resolveSecret(SAMPLE, "SHARED_A", "ses_1").value, "a");
});

test("resolveSecret does not return another session's secret", () => {
  assert.equal(resolveSecret(SAMPLE, "OTHER", "ses_1"), null);
});

test("resolveSecret returns null for unknown key", () => {
  assert.equal(resolveSecret(SAMPLE, "NOPE", "ses_1"), null);
});

// ----------------------------------------------------------------------------
// materializedPath
// ----------------------------------------------------------------------------

test("materializedPath: shared at root, session + project namespaced", () => {
  assert.equal(
    materializedPath({ key: "K", scope: "shared", sessionID: null }, "/d"),
    "/d/K",
  );
  assert.equal(
    materializedPath({ key: "K", scope: "session", sessionID: "ses_1" }, "/d"),
    "/d/sessions/ses_1/K",
  );
  assert.equal(
    materializedPath({ key: "K", scope: "project", project: "Ronda" }, "/d"),
    "/d/projects/Ronda/K",
  );
});

// ----------------------------------------------------------------------------
// project scope: visibility + precedence (session > project > shared)
// ----------------------------------------------------------------------------

const SAMPLE_P = [
  { id: "1", key: "SHARED_A", value: "a", scope: "shared", sessionID: null, project: null },
  { id: "2", key: "DUP", value: "shared", scope: "shared", sessionID: null, project: null },
  { id: "3", key: "RONDA_ONLY", value: "r", scope: "project", project: "Ronda" },
  { id: "4", key: "DUP", value: "ronda", scope: "project", project: "Ronda" },
  { id: "5", key: "BANN_ONLY", value: "b", scope: "project", project: "Bannerman" },
  { id: "6", key: "DUP", value: "sess", scope: "session", sessionID: "ses_1" },
];

test("visibleSecrets includes this project's secrets, not other projects'", () => {
  const keys = visibleSecrets(SAMPLE_P, undefined, "Ronda").map((m) => m.key).sort();
  assert.deepEqual(keys, ["DUP", "RONDA_ONLY", "SHARED_A"]);
  assert.equal(keys.includes("BANN_ONLY"), false);
});

test("visibleSecrets precedence: session > project > shared on same key", () => {
  // ses_1 + Ronda: DUP exists at all three tiers → session wins.
  const dup = visibleSecrets(SAMPLE_P, "ses_1", "Ronda").filter((m) => m.key === "DUP");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].scope, "session");
  // Ronda only (no session): project wins over shared.
  const dup2 = visibleSecrets(SAMPLE_P, undefined, "Ronda").filter((m) => m.key === "DUP");
  assert.equal(dup2[0].scope, "project");
});

test("resolveSecret precedence session > project > shared", () => {
  assert.equal(resolveSecret(SAMPLE_P, "DUP", "ses_1", "Ronda").value, "sess");
  assert.equal(resolveSecret(SAMPLE_P, "DUP", undefined, "Ronda").value, "ronda");
  assert.equal(resolveSecret(SAMPLE_P, "DUP", undefined, "Bannerman").value, "shared");
  assert.equal(resolveSecret(SAMPLE_P, "RONDA_ONLY", undefined, "Bannerman"), null);
});

test("setSecret project scope round-trips with its own slot", async () => {
  const store = [];
  const load = () => store.slice();
  const save = async (s) => {
    store.length = 0;
    store.push(...s);
  };
  const r = await setSecret(
    { key: "API", value: "v", scope: "project", project: "Ronda", hint: "ronda api" },
    { load, save },
  );
  assert.equal(r.ok, true);
  assert.equal(r.meta.scope, "project");
  assert.equal(r.meta.project, "Ronda");
  // A shared API and a Bannerman API coexist as separate slots.
  await setSecret({ key: "API", value: "s", scope: "shared" }, { load, save });
  await setSecret({ key: "API", value: "b", scope: "project", project: "Bannerman" }, { load, save });
  assert.equal(store.length, 3);
});

test("setSecret rejects project scope without a valid project", async () => {
  const load = () => [];
  const save = async () => {};
  assert.equal((await setSecret({ key: "K", value: "v", scope: "project" }, { load, save })).ok, false);
  assert.equal(
    (await setSecret({ key: "K", value: "v", scope: "project", project: "a/b" }, { load, save })).ok,
    false,
  );
});

test("provideSecret resolves a project-scoped secret", async () => {
  const { dir } = await tmpStore();
  const store = [{ id: "1", key: "API", value: "rv", scope: "project", project: "Ronda" }];
  const load = () => store;
  const r = await provideSecret({ key: "API", project: "Ronda", dir }, { load });
  assert.equal(r.ok, true);
  assert.equal(r.path, join(dir, "projects", "Ronda", "API"));
  assert.equal("value" in r, false);
  await rm(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// CRUD round-trip against a temp store (real fs)
// ----------------------------------------------------------------------------

async function tmpStore() {
  const dir = await mkdtemp(join(tmpdir(), "bui-secrets-test-"));
  return { dir, path: join(dir, "secrets.json") };
}

test("setSecret upsert + listSecrets meta, value never in meta", async () => {
  const { dir, path } = await tmpStore();
  const load = () => listFromFile(path);
  const save = async (s) => saveToFile(path, s);

  const published = [];
  const r1 = await setSecret(
    { key: "GITHUB_PAT", value: "ghp_aaa", scope: "shared", hint: "git push" },
    { load, save, publish: (e) => published.push(e) },
  );
  assert.equal(r1.ok, true);
  assert.equal("value" in r1.meta, false);
  assert.equal(published[0].kind, "secrets.updated");

  // Upsert same slot replaces value, keeps id.
  const r2 = await setSecret({ key: "GITHUB_PAT", value: "ghp_bbb", scope: "shared" }, { load, save });
  assert.equal(r2.meta.id, r1.meta.id);

  const metas = listSecrets({ includeAll: true }, { load });
  assert.equal(metas.length, 1);
  assert.equal(metas[0].key, "GITHUB_PAT");
  assert.equal("value" in metas[0], false);

  // Underlying file holds exactly one entry with the latest value.
  const raw = JSON.parse(await readFile(path, "utf-8"));
  assert.equal(raw.secrets.length, 1);
  assert.equal(raw.secrets[0].value, "ghp_bbb");

  await rm(dir, { recursive: true, force: true });
});

test("setSecret rejects bad input", async () => {
  const load = () => [];
  const save = async () => {};
  assert.equal((await setSecret({ key: "bad-key", value: "x" }, { load, save })).ok, false);
  assert.equal((await setSecret({ key: "K", value: "" }, { load, save })).ok, false);
  assert.equal(
    (await setSecret({ key: "K", value: "x", scope: "session" }, { load, save })).ok,
    false,
    "session scope needs sessionID",
  );
});

test("setSecret session + shared with same key coexist as separate slots", async () => {
  const store = [];
  const load = () => store.slice();
  const save = async (s) => {
    store.length = 0;
    store.push(...s);
  };
  await setSecret({ key: "TOK", value: "shared", scope: "shared" }, { load, save });
  await setSecret({ key: "TOK", value: "scoped", scope: "session", sessionID: "ses_1" }, { load, save });
  assert.equal(store.length, 2);
});

test("deleteSecret removes by id", async () => {
  const store = [
    { id: "keep", key: "A", value: "1", scope: "shared", sessionID: null },
    { id: "drop", key: "B", value: "2", scope: "shared", sessionID: null },
  ];
  const load = () => store.slice();
  const save = async (s) => {
    store.length = 0;
    store.push(...s);
  };
  const r = await deleteSecret("drop", { load, save });
  assert.equal(r.deleted, true);
  assert.equal(store.length, 1);
  assert.equal(store[0].id, "keep");

  const r2 = await deleteSecret("nope", { load, save });
  assert.equal(r2.deleted, false);
});

// ----------------------------------------------------------------------------
// provideSecret — writes a 0600 file, returns path only (never the value)
// ----------------------------------------------------------------------------

test("provideSecret materializes a 0600 file and returns only the path", async () => {
  const { dir } = await tmpStore();
  const store = [
    { id: "1", key: "GITHUB_PAT", value: "ghp_secret", scope: "shared", sessionID: null, hint: "git" },
  ];
  const load = () => store;

  const r = await provideSecret({ key: "GITHUB_PAT", sessionID: "ses_1", dir }, { load });
  assert.equal(r.ok, true);
  assert.equal("value" in r, false, "provide result must NOT contain the value");
  assert.equal(r.path, join(dir, "GITHUB_PAT"));
  assert.equal(r.hint, "git");

  // File on disk holds the value with 0600 perms.
  assert.equal(await readFile(r.path, "utf-8"), "ghp_secret");
  const mode = (await stat(r.path)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

  await rm(dir, { recursive: true, force: true });
});

test("provideSecret session-scoped writes under sessions/<id>/", async () => {
  const { dir } = await tmpStore();
  const store = [
    { id: "1", key: "DEPLOY", value: "v", scope: "session", sessionID: "ses_9" },
  ];
  const load = () => store;
  const r = await provideSecret({ key: "DEPLOY", sessionID: "ses_9", dir }, { load });
  assert.equal(r.ok, true);
  assert.equal(r.path, join(dir, "sessions", "ses_9", "DEPLOY"));
  await rm(dir, { recursive: true, force: true });
});

test("provideSecret fails for a key not visible to the session", async () => {
  const { dir } = await tmpStore();
  const store = [
    { id: "1", key: "OTHER", value: "v", scope: "session", sessionID: "ses_2" },
  ];
  const load = () => store;
  const r = await provideSecret({ key: "OTHER", sessionID: "ses_1", dir }, { load });
  assert.equal(r.ok, false);
  await rm(dir, { recursive: true, force: true });
});

// --- tiny file-backed helpers for the round-trip tests above ---
import { readFileSync, existsSync } from "node:fs";
import { writeFile as writeFileP } from "node:fs/promises";
function listFromFile(path) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")).secrets ?? [];
  } catch {
    /* empty */
  }
  return [];
}
async function saveToFile(path, secrets) {
  await writeFileP(path, JSON.stringify({ secrets }, null, 2));
}
