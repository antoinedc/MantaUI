import { test } from "node:test";
import assert from "node:assert/strict";
import { hasBlankDeviceId, devicesView, forgeCredentialSecondary, updateTargetsView, updateVersionText } from "./settingsViews.mjs";
import { describeUpdateTarget } from "../shared/updateTargets.mjs";

const dev = (id, over = {}) => ({ device_id: id, name: id, last_seen: null, created_at: 1, primary: false, current: false, ...over });

test("devicesView: this device first, then most recently active, ties in store order", () => {
  const out = devicesView([
    dev("a", { last_seen: 10 }),
    dev("b", { current: true, last_seen: 1 }),
    dev("c", { last_seen: 50 }),
    dev("d", { last_seen: 50 }),
    dev("e"),
  ]);
  assert.deepEqual(out.map((d) => d.device_id), ["b", "c", "d", "a", "e"]);
});

test("devicesView: revocable only for a non-current, non-primary row with a real id", () => {
  const out = Object.fromEntries(
    devicesView([dev("me", { current: true }), dev("desk", { primary: true }), dev("phone"), dev("  ")]).map((d) => [d.device_id, d.revocable]),
  );
  assert.deepEqual(out, { me: false, desk: false, phone: true, "  ": false });
});

test("devicesView tolerates old rows and non-arrays", () => {
  assert.deepEqual(devicesView(undefined), []);
  assert.equal(devicesView([{ device_id: "x" }])[0].revocable, true);
});

test("forgeCredentialSecondary: every branch", () => {
  assert.match(forgeCredentialSecondary({ login: "a", source: "cli", valid: false }), /gh auth login/);
  assert.match(forgeCredentialSecondary({ login: "a", source: "env", valid: false }), /MANTA_GITHUB_TOKEN environment variable/);
  assert.equal(forgeCredentialSecondary({ login: "a", source: "stored", valid: false }), "GitHub rejected this sign-in. Disconnect, then connect again.");
  assert.equal(forgeCredentialSecondary({ login: "a", source: "cli", valid: true }), "@a · from the gh CLI on your server");
  assert.equal(forgeCredentialSecondary({ login: "a", source: "env", valid: null }), "@a · from the MANTA_GITHUB_TOKEN env var");
  assert.equal(forgeCredentialSecondary({ login: "a", source: "stored", valid: true }), "@a · signed in on this server");
  assert.equal(forgeCredentialSecondary({ login: null, source: null, valid: null }), "connected");
  assert.equal(forgeCredentialSecondary({ login: null, source: "stored", valid: true }), "signed in on this server");
});

test("describeUpdateTarget: rule order — an unanswerable check is never ok", () => {
  assert.deepEqual(describeUpdateTarget({ ok: false, manual: true, available: true }), { tone: "error", text: "Couldn't check" });
  assert.deepEqual(describeUpdateTarget({ ok: true, manual: true, available: true }), { tone: "muted", text: "Update manually" });
  assert.deepEqual(describeUpdateTarget({ ok: true, manual: false, available: true }), { tone: "action", text: "Update available" });
  assert.deepEqual(describeUpdateTarget({ ok: true, manual: false, available: false }), { tone: "ok", text: "Up to date" });
});

test("updateTargetsView: box row first, opencode, then CLIs alphabetically; no desktop row", () => {
  const view = updateTargetsView({
    serverVersion: "0.0.39",
    check: {
      ok: true, available: true, version: "0.0.40",
      targets: [
        { id: "kimi", label: "Kimi", current: "1", latest: "1", available: false, ok: true, manual: false },
        { id: "opencode", label: "opencode", current: "2.0.30", latest: "2.0.31", available: true, ok: true, manual: false },
        { id: "claude", label: "Claude Code", current: null, latest: null, available: false, ok: false, manual: false },
      ],
    },
  });
  assert.deepEqual(view.targets.map((t) => t.id), ["server", "opencode", "claude", "kimi"]);
  const server = view.targets[0];
  assert.deepEqual([server.tone, server.text, server.hasUpdate, server.versionText], ["action", "Update available", true, "0.0.39 → 0.0.40"]);
  assert.deepEqual([view.targets[2].tone, view.targets[2].hasUpdate, view.targets[2].versionText], ["error", false, null]);
});

test("updateTargetsView: a missing check is a server row that couldn't check", () => {
  const view = updateTargetsView({ check: { ok: false }, serverVersion: "1" });
  assert.deepEqual([view.targets[0].tone, view.targets[0].hasUpdate], ["error", false]);
});

test("updateVersionText omits what is unknown", () => {
  assert.equal(updateVersionText({ current: "1", latest: "1" }), "1");
  assert.equal(updateVersionText({ current: null, latest: "2" }), "2");
  assert.equal(updateVersionText({ current: null, latest: null }), null);
});

test("revoke: a present-but-blank device_id is refused; an absent one keeps its meaning (WS11 D3 / X6)", () => {
  assert.equal(hasBlankDeviceId({ device_id: "" }), true);
  assert.equal(hasBlankDeviceId({ device_id: "  " }), true);
  assert.equal(hasBlankDeviceId({ deviceId: " " }), true);
  assert.equal(hasBlankDeviceId({ device_id: "abc" }), false);
  assert.equal(hasBlankDeviceId({}), false);
});
