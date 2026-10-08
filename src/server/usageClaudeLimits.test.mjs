// Claude usage adapter — the Team-plan `limits[]` shape (multi-account spec §1.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAdapter } from "./usageAdapters/claude.mjs";
import { isUsageAtLimit } from "./usageStopper.mjs";
import { normalizeWindow } from "./usageAdapters/normalizeWindow.mjs";

const res = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});

async function fetchSnap(body) {
  return claudeAdapter.fetch({
    fetchImpl: async () => res(body),
    readCredentials: async () => ({ accessToken: "fake-token" }),
  });
}

// Shape captured live from a Team seat (2026-10-08): `seven_day` is null, the
// session cap is in five_hour AND limits[], and the only weekly is a
// model-scoped, inactive one.
const TEAM_PAYLOAD = {
  five_hour: { utilization: 15, resets_at: "2026-10-08T16:59:59.727014+00:00" },
  seven_day: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 15,
      severity: "normal",
      resets_at: "2026-10-08T16:59:59.727014+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      severity: "normal",
      resets_at: "2026-10-14T05:00:00+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
};

test("claude adapter (Team): session first, then the model-scoped weekly, greyed when inactive", async () => {
  const snap = await fetchSnap(TEAM_PAYLOAD);
  assert.deepEqual(
    snap.windows.map((w) => w.kind),
    ["session", "weekly_scoped:fable"],
  );
  const [session, scoped] = snap.windows;
  assert.equal(session.pct, 15);
  assert.equal(session.label, "5h");
  assert.equal("active" in session, false);
  assert.equal(scoped.label, "7d · Fable");
  assert.equal(scoped.scope, "Fable");
  assert.equal(scoped.active, false);
  assert.equal(scoped.resetsAt, Date.parse("2026-10-14T05:00:00+00:00"));
});

test("claude adapter (Team): an inactive window never makes the snapshot exhausted", async () => {
  const body = structuredClone(TEAM_PAYLOAD);
  body.limits[1].percent = 100;
  const snap = await fetchSnap(body);
  assert.equal(snap.windows[1].pct, 100);
  assert.equal("exhausted" in snap, false);
});

test("claude adapter (Team): an ACTIVE scoped window at 100% does exhaust", async () => {
  const body = structuredClone(TEAM_PAYLOAD);
  body.limits[1].percent = 100;
  body.limits[1].is_active = true;
  const snap = await fetchSnap(body);
  assert.equal("active" in snap.windows[1], false);
  assert.equal(snap.exhausted, true);
});

test("claude adapter (Team): an unscoped weekly in limits[] is the account-wide weekly, ordered before scoped ones", async () => {
  const body = {
    five_hour: null,
    seven_day: null,
    limits: [
      { kind: "weekly_scoped", group: "weekly", percent: 40, resets_at: "2026-10-14T05:00:00+00:00", scope: { model: { display_name: "Fable" } }, is_active: true },
      { kind: "weekly", group: "weekly", percent: 62, resets_at: "2026-10-14T05:00:00+00:00", scope: null, is_active: true },
      { kind: "session", group: "session", percent: 7, resets_at: "2026-10-08T16:59:59+00:00", scope: null, is_active: true },
    ],
  };
  const snap = await fetchSnap(body);
  assert.deepEqual(
    snap.windows.map((w) => [w.kind, w.pct]),
    [["session", 7], ["weekly", 62], ["weekly_scoped:fable", 40]],
  );
});

test("claude adapter (Team): two scoped models each get their own window; a repeated model is emitted once", async () => {
  const scoped = (name, percent) => ({
    kind: "weekly_scoped", group: "weekly", percent, resets_at: "2026-10-14T05:00:00+00:00",
    scope: { model: { display_name: name } }, is_active: true,
  });
  const snap = await fetchSnap({
    five_hour: { utilization: 1 },
    limits: [scoped("Fable", 10), scoped("Opus", 20), scoped("Fable", 99)],
  });
  assert.deepEqual(
    snap.windows.map((w) => [w.kind, w.pct]),
    [["session", 1], ["weekly_scoped:fable", 10], ["weekly_scoped:opus", 20]],
  );
});

test("claude adapter: seven_day still wins over limits[] for non-Team plans (no regression)", async () => {
  const snap = await fetchSnap({
    five_hour: { utilization: 58 },
    seven_day: { utilization: 64, resets_at: "2026-08-13T22:00:00.464272+00:00" },
    limits: [{ kind: "weekly", group: "weekly", percent: 1, scope: null, is_active: true }],
  });
  assert.deepEqual(snap.windows.map((w) => [w.kind, w.pct]), [["session", 58], ["weekly", 64]]);
});

test("claude adapter: a payload with no limits[] is byte-identical to before (no scope/active keys)", async () => {
  const snap = await fetchSnap({ five_hour: { utilization: 58 }, seven_day: { utilization: 64 } });
  for (const w of snap.windows) {
    assert.equal("scope" in w, false);
    assert.equal("active" in w, false);
  }
});

test("claude adapter: junk limits[] entries are ignored, never thrown on", async () => {
  const snap = await fetchSnap({
    five_hour: { utilization: 5 },
    limits: [null, 7, "x", { group: "weekly", percent: "n/a", scope: { model: { display_name: "Fable" } } }, { group: "weekly" }],
  });
  assert.deepEqual(snap.windows.map((w) => w.kind), ["session"]);
});

test("isUsageAtLimit: skips inactive windows only", () => {
  assert.equal(isUsageAtLimit([{ pct: 100, active: false }]), false);
  assert.equal(isUsageAtLimit([{ pct: 100, active: false }, { pct: 100 }]), true);
  assert.equal(isUsageAtLimit([{ pct: 99 }]), false);
});

test("normalizeWindow: carries scope and active:false, never writes active:true", () => {
  assert.deepEqual(normalizeWindow({ kind: "k", pct: 5, scope: "Fable", active: false }), {
    kind: "k", label: "", pct: 5, scope: "Fable", active: false,
  });
  const w = normalizeWindow({ kind: "k", pct: 5, active: true });
  assert.equal("active" in w, false);
  assert.equal("scope" in w, false);
});
