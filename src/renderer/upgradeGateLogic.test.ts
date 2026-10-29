// upgradeGateLogic.test.ts — the pure half of the blocking box-upgrade screen
// (OpenCode V2 cutover, slice C4). Everything the gate DECIDES is tested here
// with no DOM: the K3 parser, the reducer's ordering rules, the view selector
// and the formatting.

import { describe, it, expect } from "vitest";
import { buildUpgradeView } from "../server/upgradeView.mjs";
import type { UpgradeStatus, UpgradeStep } from "../shared/api";
import {
  boxNeedsMajorUpgrade,
  gateReducer,
  initialGateState,
  normalizeUpgradeStatus,
  selectGateView,
  type GateInputs,
  type GateState,
} from "./upgradeGateLogic";

const step = (id: UpgradeStep["id"], status: UpgradeStep["status"], extra: Partial<UpgradeStep> = {}): UpgradeStep => ({
  id,
  label: id,
  status,
  progress: null,
  ...extra,
});

// The box words the gate (WS11 D3 / X5): attach the REAL box view to every status,
// exactly as GET /api/upgrade does, so these tests exercise the wire the app gets.
const status = (over: Partial<UpgradeStatus> = {}): UpgradeStatus => {
  const base: UpgradeStatus = {
    state: "running",
    steps: [step("preflight", "done"), step("stop", "done"), step("copy", "running")],
    overall: 0.4,
    etaSeconds: 240,
    error: null,
    ...over,
  };
  return { ...base, view: buildUpgradeView(base) as UpgradeStatus["view"] };
};
const oldBoxStatus = (over: Partial<UpgradeStatus> = {}): UpgradeStatus => {
  const { view: _v, ...rest } = status(over);
  return rest;
};

const inputs = (over: Partial<GateInputs> = {}): GateInputs => ({
  boxNeedsUpgrade: false,
  boxUpdating: false,
  boxUpdateError: null,
  boxUpdateProgress: null,
  connected: true,
  ...over,
});

const withStatus = (s: UpgradeStatus | null, over: Partial<GateState> = {}): GateState => ({
  ...initialGateState,
  status: s,
  ...over,
});

describe("normalizeUpgradeStatus (K3 parser)", () => {
  it("accepts a well-formed object verbatim", () => {
    const raw = {
      state: "failed",
      steps: [
        { id: "preflight", label: "Check disk", status: "failed", progress: null, error: "no space" },
      ],
      overall: 0.1,
      etaSeconds: null,
      error: { step: "preflight", message: "no space", retryable: true, needBytes: 31e9, haveBytes: 3e9 },
    };
    expect(normalizeUpgradeStatus(raw)).toEqual(raw);
  });

  it.each([null, undefined, 3, "x", [], {}, { state: "weird" }, { state: 4 }])(
    "rejects a non-status payload (%j) so a stray frame can never flip the gate",
    (raw) => {
      expect(normalizeUpgradeStatus(raw)).toBeNull();
    },
  );

  it("repairs malformed fields inside a valid status instead of dropping it", () => {
    const s = normalizeUpgradeStatus({
      state: "running",
      steps: [
        { id: "copy", status: "exploding", progress: { numerator: "x", denominator: 10, label: "" } },
        "garbage",
        { label: "no id" },
      ],
      overall: 7,
      etaSeconds: -5,
      error: { message: "", retryable: "yes" },
    })!;
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ id: "copy", status: "pending", progress: { denominator: 10 } });
    expect(s.steps[0].progress).not.toHaveProperty("numerator");
    expect(s.steps[0].label).toBe("Copy history"); // default label
    expect(s.overall).toBe(1); // clamped
    expect(s.etaSeconds).toBeNull();
    expect(s.error).toEqual({ step: "preflight", message: "The upgrade failed.", retryable: true });
  });

  it("only an explicit retryable:false withholds Retry", () => {
    const e = (retryable: unknown) =>
      normalizeUpgradeStatus({ state: "failed", error: { step: "migrate", message: "m", retryable } })!.error!.retryable;
    expect(e(false)).toBe(false);
    expect(e(true)).toBe(true);
    expect(e(undefined)).toBe(true);
  });
});

describe("boxNeedsMajorUpgrade (K4)", () => {
  const matrix = { supportedMajor: 1 };
  it("is true for a current desktop against a box on an older major", () => {
    expect(boxNeedsMajorUpgrade({ clientVersion: "1.2.0", boxVersion: "0.9.4", matrix })).toBe(true);
  });
  it("is false for same-major patch skew — that stays with the existing banner", () => {
    expect(boxNeedsMajorUpgrade({ clientVersion: "1.2.0", boxVersion: "1.0.0", matrix })).toBe(false);
  });
  it("is false when the DESKTOP is the wrong major (upgrading the box cannot fix it)", () => {
    expect(boxNeedsMajorUpgrade({ clientVersion: "0.9.0", boxVersion: "0.9.0", matrix })).toBe(false);
    expect(boxNeedsMajorUpgrade({ clientVersion: "2.0.0", boxVersion: "0.9.0", matrix })).toBe(false);
  });
  it("is false for a box already on the supported major, or ahead", () => {
    expect(boxNeedsMajorUpgrade({ clientVersion: "1.0.0", boxVersion: "1.0.0", matrix })).toBe(false);
    expect(boxNeedsMajorUpgrade({ clientVersion: "1.0.0", boxVersion: "2.0.0", matrix })).toBe(false);
  });
  it("never blocks on missing versions (mid-bootstrap)", () => {
    expect(boxNeedsMajorUpgrade({ clientVersion: null, boxVersion: "0.9.0", matrix })).toBe(false);
    expect(boxNeedsMajorUpgrade({ clientVersion: "1.0.0", boxVersion: undefined, matrix })).toBe(false);
  });
});

describe("gateReducer", () => {
  it("stores the latest status", () => {
    const s = gateReducer(initialGateState, { type: "status", status: status() });
    expect(s.status?.state).toBe("running");
  });

  it("a 503 raises upgradeModeSeen; an idle/completed/old-box answer clears it", () => {
    let s = gateReducer(initialGateState, { type: "upgradeModeSeen" });
    expect(s.upgradeModeSeen).toBe(true);
    // running keeps it (the status itself drives the view)
    s = gateReducer(s, { type: "status", status: status() });
    expect(s.upgradeModeSeen).toBe(true);
    for (const cleared of [status({ state: "idle" }), status({ state: "completed" }), null]) {
      const next = gateReducer(s, { type: "status", status: cleared });
      expect(next.upgradeModeSeen).toBe(false);
    }
  });

  it("a button outcome is reset when the box moves to a different state", () => {
    let s = withStatus(status({ state: "failed" }));
    s = gateReducer(s, { type: "actionStarted", action: "retry" });
    expect(s.retry).toEqual({ phase: "pending" });
    s = gateReducer(s, { type: "actionFinished", action: "retry", result: { ok: true } });
    expect(s.retry).toEqual({ phase: "ok" });
    // same state re-announced → outcome kept
    s = gateReducer(s, { type: "status", status: status({ state: "failed" }) });
    expect(s.retry).toEqual({ phase: "ok" });
    // box moved on → stale
    s = gateReducer(s, { type: "status", status: status({ state: "running" }) });
    expect(s.retry).toEqual({ phase: "idle" });
  });

  it("records a refusal's text, and a blank one still says something", () => {
    let s = gateReducer(withStatus(status({ state: "failed" })), {
      type: "actionFinished",
      action: "rollback",
      result: { ok: false, error: "no previous release" },
    });
    expect(s.rollback).toEqual({ phase: "error", message: "no previous release" });
    s = gateReducer(s, { type: "actionFinished", action: "rollback", result: { ok: false, error: "" } });
    expect(s.rollback).toMatchObject({ phase: "error" });
    expect((s.rollback as { message: string }).message).not.toBe("");
  });
});

describe("selectGateView", () => {
  it("is hidden for a box with no upgrade activity", () => {
    expect(selectGateView(initialGateState, inputs()).kind).toBe("hidden");
    expect(selectGateView(withStatus(status({ state: "idle" })), inputs()).kind).toBe("hidden");
  });

  it("completed opens the app — even while the K4 version read is still stale", () => {
    const view = selectGateView(withStatus(status({ state: "completed" })), inputs({ boxNeedsUpgrade: true }));
    expect(view.kind).toBe("hidden");
  });

  it("K4 → upgrade-box, idle until the user acts", () => {
    const v = selectGateView(initialGateState, inputs({ boxNeedsUpgrade: true }));
    expect(v).toMatchObject({ kind: "upgrade-box", updating: false, restarting: false, error: null });
  });

  it("K4 while the existing update flow runs → updating, restarting when the stream drops", () => {
    const prog = { step: 2, total: 6, label: "Downloading" };
    const live = selectGateView(initialGateState, inputs({ boxNeedsUpgrade: true, boxUpdating: true, boxUpdateProgress: prog }));
    expect(live).toMatchObject({ kind: "upgrade-box", updating: true, restarting: false, progress: prog });
    const down = selectGateView(initialGateState, inputs({ boxNeedsUpgrade: true, boxUpdating: true, connected: false }));
    expect(down).toMatchObject({ updating: true, restarting: true });
  });

  it("K4 shows the update flow's failure only when it is not running", () => {
    const failed = selectGateView(initialGateState, inputs({ boxNeedsUpgrade: true, boxUpdateError: "manifest fetch failed" }));
    expect(failed).toMatchObject({ kind: "upgrade-box", error: "manifest fetch failed" });
    const retrying = selectGateView(
      initialGateState,
      inputs({ boxNeedsUpgrade: true, boxUpdating: true, boxUpdateError: "manifest fetch failed" }),
    );
    expect(retrying).toMatchObject({ error: null });
  });

  it("K3 outranks K4: once the box reports an upgrade, follow it", () => {
    const v = selectGateView(withStatus(status()), inputs({ boxNeedsUpgrade: true, boxUpdating: true }));
    expect(v.kind).toBe("running");
  });

  it("a 503 with no status yet → waiting", () => {
    expect(selectGateView({ ...initialGateState, upgradeModeSeen: true }, inputs()).kind).toBe("waiting");
  });

  it("running → steps, overall, ETA and the current step's fraction", () => {
    const s = status({
      steps: [
        step("preflight", "done"),
        step("copy", "running", { progress: { label: "1.2 GB of 4 GB", numerator: 30, denominator: 120 } }),
        step("migrate", "pending"),
      ],
    });
    const v = selectGateView(withStatus(s), inputs());
    expect(v).toMatchObject({ kind: "running", overall: 0.4, etaText: "about 4 min left", currentFraction: 0.25 });
    expect((v as { current: UpgradeStep }).current.id).toBe("copy");
  });

  it("running with no measurable progress → indeterminate (null fraction)", () => {
    const v = selectGateView(withStatus(status({ steps: [step("stop", "running")] })), inputs());
    expect(v).toMatchObject({ kind: "running", currentFraction: null });
  });

  describe("failed", () => {
    const failed = (error: UpgradeStatus["error"], steps: UpgradeStep[] = [step("migrate", "failed")]) =>
      selectGateView(withStatus(status({ state: "failed", steps, error })), inputs());

    it("disk failure: numbers, 'Check again', no Roll back (nothing was stopped)", () => {
      const v = failed({ step: "preflight", message: "Not enough disk space", retryable: true, needBytes: 31 * 2 ** 30, haveBytes: 3 * 2 ** 30 }, [
        step("preflight", "failed"),
      ]);
      expect(v).toMatchObject({
        kind: "failed",
        diskSentence: "Needs 31 GB free, has 3 GB.",
        retryLabel: "Check again",
        canRetry: true,
        canRollback: false,
      });
    });

    it("migration failure: Retry and Roll back both offered", () => {
      const v = failed({ step: "migrate", message: "boom", retryable: true });
      expect(v).toMatchObject({ retryLabel: "Retry", canRetry: true, canRollback: true, diskSentence: null });
    });

    it("verification failure: 'Check again', no Roll back (the fix is in place)", () => {
      const v = failed({ step: "verify", message: "Sign in to Claude again", retryable: true });
      expect(v).toMatchObject({ retryLabel: "Check again", canRollback: false });
    });

    it("non-retryable: Retry is disabled WITH a reason, Roll back stays", () => {
      const v = failed({ step: "migrate", message: "corrupt", retryable: false });
      expect(v).toMatchObject({ canRetry: false, canRollback: true });
      expect((v as { retryDisabledReason: string }).retryDisabledReason).toMatch(/roll back/i);
    });

    it("carries the pressed button's outcome through", () => {
      const state = withStatus(status({ state: "failed", error: { step: "migrate", message: "m", retryable: true } }), {
        retry: { phase: "error", message: "box said no" },
      });
      expect(selectGateView(state, inputs())).toMatchObject({ retry: { phase: "error", message: "box said no" } });
    });

    it("falls back to the failed step's own error when the object carries none", () => {
      const v = failed(null, [step("copy", "failed", { error: "disk went away" })]);
      expect(v).toMatchObject({ message: "disk went away", failedStep: "copy" });
    });
  });

  it("an older box (no view): steps and the raw message; Retry is still offered (never a dead end), Roll back is not", () => {
    const v = selectGateView(
      withStatus(oldBoxStatus({ state: "failed", steps: [step("migrate", "failed")], error: { step: "migrate", message: "raw box message", retryable: true } })),
      inputs(),
    );
    expect(v).toMatchObject({ kind: "failed", message: "raw box message", canRetry: true, canRollback: false, hasView: false, details: "" });
    const run = selectGateView(withStatus(oldBoxStatus()), inputs());
    expect(run).toMatchObject({ kind: "running", etaText: null, currentFraction: null, current: null });
  });

  it("carries the box's Copy-details text", () => {
    const v = selectGateView(withStatus(status({ state: "failed", steps: [step("preflight", "failed", { error: "no space" })], error: { step: "preflight", message: "Not enough disk space", retryable: true, needBytes: 2 ** 31, haveBytes: 2 ** 30 } })), inputs());
    expect((v as { details: string }).details).toContain("error (preflight): Not enough disk space");
    expect((v as { details: string }).details).toContain("disk: needs 2 GB free, has 1 GB");
  });

  it("rolled_back → its own view", () => {
    expect(selectGateView(withStatus(status({ state: "rolled_back" })), inputs()).kind).toBe("rolled_back");
  });
});
