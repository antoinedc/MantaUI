import { test } from "node:test";
import assert from "node:assert/strict";
import { createLauncherFlagWriter, flagValue, launchersView, resolveLauncherForSpawn } from "./launchersConfig.mjs";

const claudeRow = { id: "claude", label: "Claude Code", flags: [{ key: "skipPermissions", label: "Skip", type: "boolean", default: true }] };

test("launchersView: value = saved choice, else the registry default", () => {
  assert.equal(launchersView([claudeRow], {})[0].flags[0].value, true);
  assert.equal(launchersView([claudeRow], { launcherFlags: { claude: { skipPermissions: false } } })[0].flags[0].value, false);
  assert.equal(flagValue({ x: "nope" }, { key: "x", default: false }), false);
});

function store(initial = {}) {
  let config = { launcherFlags: initial };
  return {
    configGet: async () => config,
    configUpdate: async (patch) => ((config = { ...config, ...patch }), config),
    read: () => config.launcherFlags,
  };
}

test("set-flag writes one option and returns the updated row", async () => {
  const s = store({ codex: { other: true } });
  const set = createLauncherFlagWriter(s);
  const row = await set({ id: "claude", key: "skipPermissions", value: false });
  assert.deepEqual(row.flags.map((f) => [f.key, f.value]), [["skipPermissions", false]]);
  assert.deepEqual(s.read(), { codex: { other: true }, claude: { skipPermissions: false } });
});

test("set-flag errors are class-1 sentences", async () => {
  const set = createLauncherFlagWriter(store());
  await assert.rejects(set({ id: "nope", key: "x", value: true }), /^Error: Unknown launcher\.$/);
  await assert.rejects(set({ id: "claude", key: "nope", value: true }), /^Error: Unknown option for this launcher\.$/);
  await assert.rejects(set({ id: "claude", key: "skipPermissions", value: "yes" }), /Unknown option/);
});

test("two toggles at once never lose a write", async () => {
  const s = store();
  const set = createLauncherFlagWriter({ ...s, configGet: async () => { await new Promise((r) => setTimeout(r, 5)); return { launcherFlags: s.read() }; } });
  await Promise.all([set({ id: "claude", key: "skipPermissions", value: false }), set({ id: "claude", key: "skipPermissions", value: true })]);
  assert.equal(s.read().claude.skipPermissions, true);
});

test("spawn resolution: no flags → saved/default flags from the box; explicit flags are honoured", async () => {
  const configGet = async () => ({ launcherFlags: { claude: { skipPermissions: false } } });
  assert.deepEqual((await resolveLauncherForSpawn({ id: "claude" }, { configGet })).flags, { skipPermissions: false });
  assert.deepEqual((await resolveLauncherForSpawn({ id: "claude" }, { configGet: async () => ({}) })).flags, { skipPermissions: true });
  assert.deepEqual((await resolveLauncherForSpawn({ id: "claude", flags: { skipPermissions: true } }, { configGet })).flags, { skipPermissions: true });
  assert.deepEqual(await resolveLauncherForSpawn({ id: "ghost" }, { configGet }), { id: "ghost" });
  assert.equal(await resolveLauncherForSpawn(undefined, { configGet }), undefined);
  assert.deepEqual((await resolveLauncherForSpawn({ id: "claude" }, { configGet: async () => { throw new Error("x"); } })).flags, { skipPermissions: true });
});
