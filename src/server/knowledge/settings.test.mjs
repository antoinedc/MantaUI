import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, applyPatch, createSettings, effectiveFor, normalizeSettings } from "./settings.mjs";

const A = "alpha-0123456789";
const B = "beta-9876543210";

function rig({ stored, access = { canPush: true, isFork: false, defaultBranch: "main" }, login = true, projects } = {}) {
  let cfg = { knowledge: stored };
  const updates = [];
  const reg = projects ?? [
    { slug: A, displayName: "alpha", canonicalId: "github.com/o/alpha" },
    { slug: B, displayName: "beta", canonicalId: "git.example.com/o/beta" },
  ];
  const accessCalls = [];
  const settings = createSettings({
    config: { get: async () => cfg, update: async (p) => (updates.push(p), (cfg = { ...cfg, ...p })) },
    registry: { list: async () => reg.map((p) => ({ ...p })), get: async (s) => reg.find((p) => p.slug === s) ?? null },
    getRepoAccess: async (a) => (accessCalls.push(a), access),
    hasForgeLogin: async () => login,
  });
  return { settings, updates, accessCalls };
}

test("defaults: enabled, box-only, share-and-read, no overrides; the daily cap is not a knowledge setting any more", () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS, projects: {} });
  assert.ok(!("dailyCapUsd" in DEFAULT_SETTINGS));
  const n = normalizeSettings({ dailyCapUsd: 3, repoRules: "nope", sharing: 7 });
  assert.ok(!("dailyCapUsd" in n), "a stored legacy cap is ignored");
  assert.equal(n.repoRules, "box-only");
});

test("effective: project override beats the default", () => {
  const s = { repoRules: "box-only", sharing: "share-and-read", projects: { [A]: { sharing: "private" } } };
  assert.equal(effectiveFor(s, A).sharing, "private");
  assert.equal(effectiveFor(s, B).sharing, "share-and-read");
  assert.equal(effectiveFor(s, null).sharing, "share-and-read");
});

test("set validates: unknown keys/values → invalid-setting (400)", async () => {
  const { settings } = rig();
  for (const bad of [{ nope: 1 }, { enabled: "yes" }, { dailyCapUsd: -1 }, { dailyCapUsd: 1e6 }, { repoRules: "force" }, { sharing: "all" }, { projects: { "not-a-slug": { sharing: "private" } } }, { projects: { [A]: { color: "red" } } }, 5]) {
    await assert.rejects(settings.set(bad), (e) => e.code === "invalid-setting" && e.status === 400, JSON.stringify(bad));
  }
  await assert.rejects(settings.set({ projects: { "ghost-0000000000": { sharing: "private" } } }), (e) => /Unknown project/.test(e.message));
});

test("set persists through config.update under `knowledge` and returns the complete settings", async () => {
  const { settings, updates } = rig();
  const next = await settings.set({ sharing: "read-only", projects: { [A]: { sharing: "private" } } });
  assert.equal(next.sharing, "read-only");
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0]), ["knowledge"]); // no cap in the patch → the shared setting is not written
  assert.equal(updates[0].knowledge.projects[A].sharing, "private");
  assert.ok(!("observeOnly" in updates[0].knowledge)); // hidden unless true
  const again = await settings.set({ projects: { [A]: { sharing: null } } });
  assert.deepEqual(again.projects, {});
});

test("observeOnly is accepted but only stored/returned when true", async () => {
  const { settings, updates } = rig();
  await settings.set({ observeOnly: true });
  assert.equal(updates[0].knowledge.observeOnly, true);
  const view = await settings.view();
  assert.equal(view.observeOnly, true);
  await settings.set({ observeOnly: false });
  assert.ok(!("observeOnly" in (await settings.view())));
});

test("outward modes: refused per project without a forge login, without push access, on a fork, or without a GitHub/GitLab remote", async () => {
  const noLogin = rig({ login: false });
  await assert.rejects(noLogin.settings.set({ projects: { [A]: { repoRules: "pull-request" } } }), (e) => /No GitHub login/.test(e.message));
  const noPush = rig({ access: { canPush: false, isFork: false } });
  await assert.rejects(noPush.settings.set({ projects: { [A]: { repoRules: "direct" } } }), (e) => /can't push/.test(e.message));
  const fork = rig({ access: { canPush: true, isFork: true } });
  await assert.rejects(fork.settings.set({ projects: { [A]: { repoRules: "direct" } } }), (e) => /fork/.test(e.message));
  const other = rig();
  await assert.rejects(other.settings.set({ projects: { [B]: { repoRules: "pull-request" } } }), (e) => /GitHub or GitLab/.test(e.message));
  const ok = rig();
  const next = await ok.settings.set({ projects: { [A]: { repoRules: "pull-request" } } });
  assert.equal(next.projects[A].repoRules, "pull-request");
  assert.deepEqual(ok.accessCalls[0], { kind: "github", host: "github.com", owner: "o", repo: "alpha" });
});

test("an outward setting that loses its conditions behaves as box-only, with the reason", async () => {
  const r = rig({ stored: { projects: { [A]: { repoRules: "direct" } } }, access: { canPush: false, isFork: false } });
  assert.deepEqual(await r.settings.effectiveRepoRules(A), { repoRules: "box-only", reason: "You can't push to this repository." });
  const view = await r.settings.view();
  const row = view.projects.find((p) => p.slug === A);
  assert.equal(row.repoRules, "direct");
  assert.equal(row.repoRulesEffective, "box-only");
  assert.equal(row.outwardAllowed, false);
  assert.match(row.outwardReason, /can't push/);
});

test("view: one row per detected project with effective settings and outward availability", async () => {
  const r = rig({ stored: { sharing: "read-only", projects: { [B]: { sharing: "private" } } } });
  const view = await r.settings.view();
  assert.equal(view.sharing, "read-only");
  assert.deepEqual(view.projects.map((p) => [p.slug, p.sharing, p.outwardAllowed]), [[A, "read-only", true], [B, "private", false]]);
  assert.equal(view.projects[1].sharingOverride, true);
  assert.equal(view.projects[0].sharingOverride, false);
});

test("access lookups are cached per repo", async () => {
  const r = rig();
  await r.settings.outward(A);
  await r.settings.outward(A);
  assert.equal(r.accessCalls.length, 1);
});

test("applyPatch is pure over its inputs", async () => {
  const cur = normalizeSettings({});
  const next = await applyPatch(cur, { enabled: false });
  assert.equal(cur.enabled, true);
  assert.equal(next.enabled, false);
});

test("concurrent set() calls are serialized: neither patch is lost", async () => {
  let cfg = { knowledge: undefined };
  const settings = createSettings({
    // a slow config write widens the read-modify-write window
    config: { get: async () => cfg, update: async (p) => { await new Promise((r) => setTimeout(r, 15)); cfg = { ...cfg, ...p }; } },
    registry: { list: async () => [], get: async () => null },
    hasForgeLogin: async () => false,
  });
  await Promise.all([settings.set({ dailyCapUsd: 2 }), settings.set({ sharing: "read-only" }), settings.set({ enabled: false })]);
  const s = await settings.get();
  assert.equal((await settings.view()).dailyCapUsd, 2);
  assert.equal(s.sharing, "read-only");
  assert.equal(s.enabled, false);
});

test("the legacy dailyCapUsd key writes the shared backgroundWork setting (merged, validated) and the view mirrors it", async () => {
  let cfg = { backgroundWork: { level: "light", dailyCapUsd: 5 }, knowledge: { sharing: "read-only" } };
  const updates = [];
  const settings = createSettings({
    config: { get: async () => cfg, update: async (p) => (updates.push(p), (cfg = { ...cfg, ...p })) },
    registry: { list: async () => [], get: async () => null },
    hasForgeLogin: async () => false,
  });
  assert.equal((await settings.view()).dailyCapUsd, 5);
  const next = await settings.set({ dailyCapUsd: 7.456 });
  assert.ok(!("dailyCapUsd" in next));
  assert.equal(updates.length, 1, "one write for both");
  assert.deepEqual(updates[0].backgroundWork, { level: "light", dailyCapUsd: 7.46, runWhenBusy: false }); // merged: the stored level survives
  assert.ok(!("dailyCapUsd" in updates[0].knowledge));
  assert.equal(updates[0].knowledge.sharing, "read-only");
  assert.equal((await settings.view()).dailyCapUsd, 7.46);
  // 0 is a real value (no background work on API keys); an invalid one writes nothing at all, even beside a valid key
  await settings.set({ dailyCapUsd: 0 });
  assert.equal((await settings.view()).dailyCapUsd, 0);
  const before = updates.length;
  for (const bad of [{ dailyCapUsd: -1 }, { dailyCapUsd: 101 }, { dailyCapUsd: "5" }, { dailyCapUsd: NaN }, { sharing: "private", dailyCapUsd: 1e6 }]) {
    await assert.rejects(settings.set(bad), (e) => e.code === "invalid-setting" && e.status === 400, JSON.stringify(bad));
  }
  assert.equal(updates.length, before);
  assert.equal(cfg.knowledge.sharing, "read-only");
});

test("the settings view mirrors the default cap when nothing is stored", async () => {
  const settings = createSettings({ config: { get: async () => ({}), update: async () => {} }, registry: { list: async () => [], get: async () => null }, hasForgeLogin: async () => false });
  assert.equal((await settings.view()).dailyCapUsd, 5);
});
