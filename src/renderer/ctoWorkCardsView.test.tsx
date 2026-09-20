// @vitest-environment jsdom
//
// ===== §11 work-lifecycle card VIEW tests =====
//
// The cards render the derived §11 state with the same honesty the data
// layer guarantees: a blocked review, an ambiguous target and a parked work
// are all VISIBLE (never silently omitted), and a claim never reads as a
// verification on screen. Fixtures reuse the server-realistic shapes from
// ctoWorkCards.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { WorkStageCards } from "./ctoWorkCardsView";
import { deriveWorkCard, type CtoWorkListRow, type CtoWorkInspectData } from "./ctoWorkCards";

const unmounts: Harness[] = [];
afterEach(() => {
  for (const h of unmounts) h.unmount();
  unmounts.length = 0;
});

function render_(node: React.ReactElement) {
  const h = mount(node);
  unmounts.push(h);
  return h;
}

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

describe("WorkStageCards", () => {
  it("renders nothing when there is nothing to show (no fabricated empty card)", () => {
    const { container } = render_(<WorkStageCards cards={[]} />);
    expect(container.textContent).toBe("");
  });

  it("renders a failed load as a visible line, not silence", () => {
    const { container } = render_(<WorkStageCards cards={[]} error="work tools are unavailable" />);
    expect(container.textContent).toContain("unavailable");
  });

  it("a blocked review is visible with its reason and pinned head", () => {
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
            status: "failed",
            note: "reviewer did not start: model unavailable",
            live: null,
          },
        ],
      }),
    );
    const { container } = render_(<WorkStageCards cards={[card]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Review");
    expect(text).toContain("blocked");
    expect(text).toContain("did not start");
    expect(text).toContain("abc1234def5678");
  });

  it("an approved review shows the reviewer model, not just the verdict", () => {
    const card = deriveWorkCard(
      listRow(),
      inspectData({
        claims: [
          {
            id: "att_2:independent_review_approved",
            kind: "independent_review_approved",
            specHash: SPEC,
            headSha: "abc1234def5678",
            reviewerModel: "google/gemini-2.5-pro",
            observedAt: 1758273600000,
            superseded: false,
          },
        ],
      }),
    );
    const { container } = render_(<WorkStageCards cards={[card]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("approved");
    expect(text).toContain("gemini-2.5-pro");
  });

  it("an ambiguous target fails visibly (U07)", () => {
    const card = deriveWorkCard(listRow(), inspectData({ targetLive: "ambiguous" }));
    const { container } = render_(<WorkStageCards cards={[card]} />);
    expect(container.textContent ?? "").toContain("ambiguous");
  });

  it("a parked work shows its external reason (U05 sibling: state + reason)", () => {
    const card = deriveWorkCard(
      listRow({ state: "waiting", waitingReason: "external" }),
      inspectData({ state: "waiting", waitingReason: "external" }),
    );
    const { container } = render_(<WorkStageCards cards={[card]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("parked");
    expect(text).toContain("outside this project");
  });

  it("a published artifact is labelled a claim and verification says not yet verified (U05)", () => {
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
            artifact: { identity: "@capo/reports", version: "1.2.0" },
            pipeline: "github",
            observedAt: 1758273600000,
            superseded: false,
          },
        ],
      }),
    );
    const { container } = render_(<WorkStageCards cards={[card]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("pipeline claim");
    expect(text.toLowerCase()).toContain("not yet verified");
    expect(text).toContain("1.2.0");
  });

  it("verified work reads as verified (the observation tier, not a claim)", () => {
    const card = deriveWorkCard(
      listRow({ deliveryTarget: { kind: "deployed", instance: "prod" } }),
      inspectData({
        deliveryTarget: { kind: "deployed", instance: "prod" },
        claims: [
          {
            id: "w-1:target_runs_artifact",
            kind: "target_runs_artifact",
            specHash: SPEC,
            target: "prod",
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
            target: "prod",
            checks: [{ name: "smoke", passed: true }],
            observedAt: 1758273600000,
            superseded: false,
          },
        ],
      }),
    );
    const { container } = render_(<WorkStageCards cards={[card]} />);
    expect(container.textContent ?? "").toContain("verified");
  });
});
