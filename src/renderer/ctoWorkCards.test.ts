// @vitest-environment jsdom
//
// ===== §11 work-lifecycle card derivation tests =====
//
// Fixtures are server-realistic: they mirror the exact read shapes the
// cto work tools emit (workRow + workInspect from src/server/ctoWorkTools.mjs
// — claim fields, receipt projections, attempt projections, targetLive).
// A fixture that violates the store's invariants describes a state the
// server cannot produce, so green assertions over it mean nothing.
//
// Every guarantee is paired with a COUNTERFACTUAL POSITIVE CONTROL: the
// same fixture with the supporting evidence removed/invalidated must NOT
// read as the guarantee (a claim is never presented as a verification).
import { describe, it, expect } from "vitest";
import {
  deriveWorkCard,
  cardCandidateRows,
  type CtoWorkListRow,
  type CtoWorkInspectData,
  type CtoWorkClaim,
} from "./ctoWorkCards";

const SPEC = "spec_h1";

function listRow(extra: Partial<CtoWorkListRow> = {}): CtoWorkListRow {
  return {
    id: "w-1",
    revision: 3,
    objective: "Ship the reports export",
    state: "running",
    stage: "review",
    priority: "normal",
    priorityReason: "",
    schedulingClass: "background",
    project: { workspaceId: "proj_1", tmuxSession: "reports" },
    deliveryTarget: { kind: "merged", baseBranch: "main" },
    spec: { hash: SPEC },
    dependencies: [],
    origin: { kind: "cto", runId: "run_w1" },
    attempts: 2,
    claims: 1,
    decisions: 0,
    updatedAt: new Date("2026-09-19T12:00:00Z").toISOString(),
    createdAt: new Date("2026-09-19T10:00:00Z").toISOString(),
    ...extra,
  };
}

function inspectData(extra: Partial<CtoWorkInspectData> = {}): CtoWorkInspectData {
  return {
    ...listRow(),
    attempts: [],
    claims: [],
    evidence: [],
    handoffs: [],
    decisions: [],
    resources: [],
    operations: [],
    unresolvedReceipts: [],
    stillRunning: [],
    targetLive: true,
    observedAt: new Date("2026-09-19T12:00:00Z").toISOString(),
    ...extra,
  };
}

// A §11 independent_review_approved claim, live (not superseded, current spec).
function approvalClaim(extra: Partial<CtoWorkClaim> = {}): CtoWorkClaim {
  return {
    id: "att_2:independent_review_approved",
    kind: "independent_review_approved",
    attemptId: "att_2",
    jobId: "job_2",
    specHash: SPEC,
    headSha: "abc1234def5678",
    reviewerModel: "google/gemini-2.5-pro",
    observedAt: 1758273600000,
    superseded: false,
    ...extra,
  };
}

// A failed §7 operation receipt projection, exactly what workInspect's
// `operations` array carries (recordReceiptFailure stores the control code).
function failedReceipt(op: string, resultCode: string) {
  return {
    id: `op_${op}`,
    key: `${op}:opkey`,
    op,
    status: "failed" as const,
    specHash: SPEC,
    workRevision: 3,
    stage: "merge",
    superseded: false,
    externalRef: null,
    resultCode,
    resultAt: new Date("2026-09-19T12:10:00Z").toISOString(),
  };
}

describe("deriveWorkCard — review state", () => {
  it("an approved review claim reads as approved with reviewer model + pinned head", () => {
    const card = deriveWorkCard(listRow(), inspectData({ claims: [approvalClaim()] }));
    expect(card.review.status).toBe("approved");
    expect(card.review.reviewerModel).toBe("google/gemini-2.5-pro");
    expect(card.review.headSha).toBe("abc1234def5678");
  });

  it("COUNTERFACTUAL: a superseded approval (spec revised / head moved) must not read approved", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({
        claims: [approvalClaim({ superseded: true })],
        unresolvedReceipts: [{ id: "op_r", key: "k", op: "work.review", status: "in_flight", leaseExpiresAt: null }],
      }),
    );
    expect(card.review.status).not.toBe("approved");
    expect(card.review.status).toBe("reviewing");
  });

  it("COUNTERFACTUAL: an approval claimed against an older spec is not the current approval", () => {
    const card = deriveWorkCard(
      listRow({ spec: { hash: "spec_h2" } }),
      inspectData({ spec: { hash: "spec_h2" }, claims: [approvalClaim({ specHash: "spec_h1" })] }),
    );
    expect(card.review.status).not.toBe("approved");
  });

  it("a failed review attempt reads blocked with its reason visible", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({
        attempts: [
          {
            id: "att_3",
            stage: "review",
            attemptNumber: 2,
            specHash: SPEC,
            headSha: "abc1234def5678",
            reviewerModel: null,
            status: "failed",
            startedAt: 1758273500000,
            updatedAt: 1758273600000,
            note: "reviewer did not start: model unavailable",
            live: null,
          },
        ],
      }),
    );
    expect(card.review.status).toBe("blocked");
    expect(card.review.detail).toContain("did not start");
  });

  it("COUNTERFACTUAL: no failed attempt and no approval → reviewing, never blocked", () => {
    const card = deriveWorkCard(listRow(), inspectData());
    expect(card.review.status).toBe("not-started");
    expect(card.review.status).not.toBe("blocked");
  });
});

describe("deriveWorkCard — merge gate", () => {
  it("a live merged claim reads merged with the PR and merge commit", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({
        claims: [
          {
            id: "w-1:merged_commit_exists",
            kind: "merged_commit_exists",
            specHash: SPEC,
            headSha: "abc1234def5678",
            mergeCommitSha: "def5678abc1234",
            prNumber: 1518,
            repoKey: "github.com/antoinedc/MantaUI",
            observedAt: 1758273600000,
            superseded: false,
          },
        ],
      }),
    );
    expect(card.merge.status).toBe("merged");
    expect(card.merge.prNumber).toBe(1518);
    expect(card.merge.mergeCommitSha).toBe("def5678abc1234");
  });

  it("a target_changed merge failure surfaces the matching-head precondition visibly", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({ operations: [failedReceipt("work.merge", "target_changed")] }),
    );
    expect(card.merge.status).toBe("blocked");
    expect((card.merge.detail ?? "").toLowerCase()).toContain("head");
  });

  it("a policy_blocked merge failure (required checks not green) is visible, never a silent retry", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({ operations: [failedReceipt("work.merge", "policy_blocked")] }),
    );
    expect(card.merge.status).toBe("blocked");
    expect(card.merge.detail).toBeTruthy();
  });

  it("COUNTERFACTUAL: no merged claim and no receipts → the gate is pending, never merged", () => {
    const card = deriveWorkCard(listRow(), inspectData());
    expect(card.merge.status).toBe("pending");
    expect(card.merge.status).not.toBe("merged");
    expect(card.merge.prNumber).toBeNull();
  });
});

describe("deriveWorkCard — release/verify progress (U05 claim vs verification)", () => {
  it("a published claim reads as a pipeline claim with run + artifact identity, distinct from verification", () => {
    const card = deriveWorkCard(
      listRow({ deliveryTarget: { kind: "published", releaseTarget: "npm", channel: "stable" } }),
      inspectData({
        deliveryTarget: { kind: "published", releaseTarget: "npm", channel: "stable" },
        claims: [
          {
            id: "run_w1:artifact_published",
            kind: "artifact_published",
            specHash: SPEC,
            runId: "run_w1",
            artifact: { identity: "@capo/reports", digest: "sha256:abc", version: "1.2.0" },
            pipeline: "github",
            observedAt: 1758273600000,
            superseded: false,
          },
        ],
      }),
    );
    expect(card.release.status).toBe("published");
    expect(card.release.runId).toBe("run_w1");
    expect(card.release.artifact).toContain("@capo/reports");
    // U05: the artifact is a CLAIM — the card must not read it as verified.
    expect(card.verify.status).not.toBe("verified");
    expect(card.release.detail?.toLowerCase()).toContain("claim");
  });

  it("COUNTERFACTUAL: the published claim absent → release pending, nothing invented", () => {
    const card = deriveWorkCard(
      listRow({ deliveryTarget: { kind: "published", releaseTarget: "npm", channel: "stable" } }),
      inspectData({ deliveryTarget: { kind: "published", releaseTarget: "npm", channel: "stable" } }),
    );
    expect(card.release.status).toBe("pending");
    expect(card.release.runId).toBeNull();
  });

  it("target_runs + acceptance claims read as VERIFIED (the verification tier)", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({
        claims: [
          {
            id: "w-1:target_runs_artifact",
            kind: "target_runs_artifact",
            specHash: SPEC,
            target: "reports",
            expectedSha: "abc1234def5678",
            observedSha: "abc1234def5678",
            expectedVersion: "1.2.0",
            observedVersion: "1.2.0",
            observedAt: 1758273600000,
            superseded: false,
          },
          {
            id: "w-1:acceptance_checks_passed",
            kind: "acceptance_checks_passed",
            specHash: SPEC,
            target: "reports",
            checks: [{ name: "smoke", passed: true }],
            observedAt: 1758273600000,
            superseded: false,
          },
        ],
      }),
    );
    expect(card.verify.status).toBe("verified");
  });

  it("a verify claim whose observed artifact mismatches the expectation fails visibly", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({
        claims: [
          {
            id: "w-1:target_runs_artifact",
            kind: "target_runs_artifact",
            specHash: SPEC,
            target: "reports",
            expectedSha: "abc1234def5678",
            observedSha: "zzz9999",
            expectedVersion: "1.2.0",
            observedVersion: "1.2.0",
            observedAt: 1758273600000,
            superseded: false,
          },
        ],
      }),
    );
    expect(card.verify.status).toBe("failed");
    expect(card.verify.detail).toBeTruthy();
  });

  it("COUNTERFACTUAL: no verify claims at all → verify pending, never verified", () => {
    const card = deriveWorkCard(
      listRow({ deliveryTarget: { kind: "deployed", releaseTarget: "npm", channel: "stable", instance: "prod" } }),
      inspectData({ deliveryTarget: { kind: "deployed", releaseTarget: "npm", channel: "stable", instance: "prod" } }),
    );
    expect(card.verify.status).toBe("pending");
  });

  it("a spec-kind target needs no release/verify tiers", () => {
    const card = deriveWorkCard(
      listRow({ deliveryTarget: { kind: "spec" } }),
      inspectData({ deliveryTarget: { kind: "spec" } }),
    );
    expect(card.release.status).toBe("not-needed");
    expect(card.verify.status).toBe("not-needed");
  });
});

describe("deriveWorkCard — target liveness (U07 ambiguous fails visibly)", () => {
  it("an ambiguous target is surfaced, never read as live", () => {
    const card = deriveWorkCard(listRow(), inspectData({ targetLive: "ambiguous" }));
    expect(card.targetLive).toBe("ambiguous");
    expect(card.targetLiveDetail?.toLowerCase()).toContain("ambiguous");
  });

  it("COUNTERFACTUAL: a live target carries no ambiguity copy", () => {
    const card = deriveWorkCard(listRow(), inspectData({ targetLive: true }));
    expect(card.targetLive).toBe(true);
    expect(card.targetLiveDetail).toBeNull();
  });

  it("a source-unavailable read (null) says unknown, never a guess", () => {
    const card = deriveWorkCard(listRow(), inspectData({ targetLive: null }));
    expect(card.targetLiveDetail?.toLowerCase()).toContain("unknown");
  });
});

describe("deriveWorkCard — waiting / external parking", () => {
  it("a parked work shows its waiting reason verbatim-backed, including external", () => {
    const card = deriveWorkCard(
      listRow({ state: "waiting", waitingReason: "external" }),
      inspectData({ state: "waiting", waitingReason: "external" }),
    );
    expect(card.state).toBe("waiting");
    expect(card.waitingReason).toBe("external");
    expect(card.waitingReasonDetail.toLowerCase()).toContain("outside");
  });

  it("COUNTERFACTUAL: a running work carries no parked reason", () => {
    const card = deriveWorkCard(listRow(), inspectData());
    expect(card.waitingReason).toBeNull();
  });
});

describe("cardCandidateRows — which works become cards", () => {
  it("active states are candidates", () => {
    for (const state of ["ready", "running", "waiting", "paused", "needs_decision", "failed"]) {
      expect(cardCandidateRows([listRow({ id: state, state })]).map((r) => r.id)).toEqual([state]);
    }
  });

  it("COUNTERFACTUAL: settled states produce no cards (no fabricated empty card)", () => {
    expect(
      cardCandidateRows([
        listRow({ id: "a", state: "completed" }),
        listRow({ id: "b", state: "cancelled" }),
        listRow({ id: "c", state: "archived" }),
        listRow({ id: "d", state: "draft" }),
      ]),
    ).toEqual([]);
  });
});
