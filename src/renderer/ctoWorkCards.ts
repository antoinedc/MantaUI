// ===== §11 work-lifecycle cards — data =====
//
// The work-stage OPERATIONS merged (PRs #1518/#1519/#1520) but the CTO
// surfaces had no UI for the work lifecycle: stages were driven as cto tools
// and appeared only as transcript text. This module gives the cards their
// data: it reads the EXISTING cto work tools (work_list + work_inspect) via
// the existing `POST /api/cto` dispatch route — no new server surface — and
// shapes them into card view models:
//
//   - review state      — reviewer model, pinned head SHA, approved vs blocked
//   - merge gate        — matching-head precondition + required-check refusals
//   - release/verify    — the §11 claim ladder, kept HONEST (U05): a pipeline
//                         claim is labelled a claim; only a target_runs +
//                         acceptance observation reads as verified
//   - parked work       — the waiting state with its visible reason
//   - target liveness   — an ambiguous target fails visibly (U07)
//
// All derivation mirrors the server's own read semantics (liveClaimOf in
// ctoWorkTools.mjs: kind + not superseded + current spec hash) so the UI can
// never show a claim the server itself has retired.

import { useCallback, useEffect, useRef, useState } from "react";

// --- Server read shapes (subset actually consumed; fixtures in the tests
// mirror the full ctoWorkTools projections) ---

export type CtoWorkClaim = {
  id: string;
  kind: string;
  specHash?: string | null;
  observedAt?: number | null;
  superseded?: boolean | null;
  note?: string | null;
  headSha?: string | null;
  reviewerModel?: string | null;
  attemptId?: string | null;
  jobId?: string | null;
  mergeCommitSha?: string | null;
  prNumber?: number | null;
  repoKey?: string | null;
  runId?: string | null;
  pipeline?: string | null;
  recoveryRef?: string | null;
  artifact?: { identity?: string | null; digest?: string | null; version?: string | null } | null;
  target?: string | null;
  expectedSha?: string | null;
  observedSha?: string | null;
  expectedVersion?: string | null;
  observedVersion?: string | null;
  checks?: Array<{ name?: string; passed?: boolean } | null> | null;
};

export type CtoWorkOperation = {
  id: string;
  key: string;
  op: string;
  status: string;
  specHash?: string | null;
  superseded?: boolean | null;
  externalRef?: string | null;
  resultCode?: string | null;
  resultAt?: string | null;
};

export type CtoWorkAttempt = {
  id: string;
  stage?: string | null;
  attemptNumber?: number | null;
  specHash?: string | null;
  headSha?: string | null;
  reviewerModel?: string | null;
  status?: string | null;
  superseded?: boolean | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  note?: string | null;
  live?: { jobStatus?: string; activity?: string | null; error?: string | null } | null;
};

export type CtoWorkListRow = {
  id: string;
  revision?: number;
  objective?: string;
  state: string;
  waitingReason?: string;
  stage?: string;
  priority?: string;
  priorityReason?: string;
  schedulingClass?: string;
  project?: { workspaceId?: string; tmuxSession?: string } | null;
  deliveryTarget?: {
    kind?: string;
    baseBranch?: string;
    releaseTarget?: string;
    channel?: string;
    instance?: string;
  } | null;
  spec?: { hash?: string | null } | null;
  dependencies?: string[];
  origin?: { kind?: string; runId?: string | null } | null;
  attempts?: number;
  claims?: number;
  decisions?: number;
  updatedAt?: string;
  createdAt?: string;
};

export type CtoWorkInspectData = Omit<CtoWorkListRow, "attempts" | "claims" | "decisions"> & {
  attempts?: CtoWorkAttempt[];
  claims?: CtoWorkClaim[];
  evidence?: Array<{ kind?: string; id?: string; observedAt?: number | string }>;
  handoffs?: unknown[];
  decisions?: unknown[];
  resources?: unknown[];
  operations?: CtoWorkOperation[];
  unresolvedReceipts?: Array<{
    id: string;
    key: string;
    op: string;
    status: string;
    leaseExpiresAt?: string | null;
  }>;
  stillRunning?: Array<{ jobId: string; status?: string; attemptLinked: boolean }>;
  targetLive?: boolean | "ambiguous" | null;
  observedAt?: string;
};

// --- Card view model ---

export type CtoWorkCard = {
  workId: string;
  title: string;
  state: string;
  stateLabel: string;
  waitingReason: string | null;
  waitingReasonDetail: string;
  deliveryTargetLabel: string;
  targetLive: boolean | "ambiguous" | null;
  targetLiveDetail: string | null;
  review: {
    status: "not-started" | "reviewing" | "approved" | "blocked";
    reviewerModel: string | null;
    headSha: string | null;
    detail: string | null;
  };
  merge: {
    status: "pending" | "running" | "merged" | "blocked" | "not-needed";
    headSha: string | null;
    mergeCommitSha: string | null;
    prNumber: number | null;
    detail: string | null;
  };
  release: {
    status: "not-needed" | "pending" | "running" | "published" | "failed";
    pipeline: string | null;
    runId: string | null;
    artifact: string | null;
    detail: string | null;
  };
  verify: {
    status: "not-needed" | "pending" | "running" | "verified" | "failed";
    target: string | null;
    detail: string | null;
  };
};

// --- Closed vocabularies mirrored from the server store (ctoWork.mjs) ---

const CARD_VISIBLE_STATES = new Set([
  "ready",
  "running",
  "waiting",
  "paused",
  "needs_decision",
  "failed",
]);

const STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  ready: "Ready",
  running: "Running",
  waiting: "Parked",
  paused: "Paused",
  needs_decision: "Needs a decision",
  failed: "Failed",
  completed: "Completed",
  cancelled: "Cancelled",
  archived: "Archived",
};

const WAITING_REASON_DETAIL: Record<string, string> = {
  dependency: "parked behind a dependency",
  capacity: "parked — no free worker slot right now",
  provider: "parked — waiting on a provider",
  external: "parked — waiting on something outside this project (CI, review service, a human)",
  reconcile: "parked — waiting to be reconciled",
};

const REVIEW_CLAIM = "independent_review_approved";
const MERGE_CLAIM = "merged_commit_exists";
const RELEASE_CLAIM = "artifact_published";
const TARGET_RUNS_CLAIM = "target_runs_artifact";
const ACCEPTANCE_CLAIM = "acceptance_checks_passed";

const OP_REVIEW = "work.review";
const OP_MERGE = "work.merge";
const OP_RELEASE = "work.release";
const OP_VERIFY = "work.verify";

// --- Helpers ---

// Mirrors liveClaimOf (src/server/ctoWorkTools.mjs): the LIVE claim of a kind
// is the newest non-superseded claim recorded against the CURRENT spec hash.
function liveClaim(claims: CtoWorkClaim[] | null | undefined, kind: string, specHash: string | null) {
  return (
    (claims ?? [])
      .filter(
        (c) =>
          c?.kind === kind &&
          c.superseded !== true &&
          (specHash == null || c.specHash === specHash),
      )
      .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0] ?? null
  );
}

// The current receipt for an op: the last non-superseded entry in insertion
// order (a newer key run supersedes its predecessor in the store).
function latestReceipt(operations: CtoWorkOperation[] | null | undefined, op: string) {
  const rows = (operations ?? []).filter((r) => r?.op === op && r.superseded !== true);
  return rows[rows.length - 1] ?? null;
}

function unresolvedOp(receipts: CtoWorkInspectData["unresolvedReceipts"], op: string) {
  return (receipts ?? []).some((r) => r?.op === op);
}

function latestAttempt(attempts: CtoWorkAttempt[] | null | undefined, stage: string) {
  const rows = (attempts ?? []).filter((a) => a?.stage === stage && a.superseded !== true);
  return rows[rows.length - 1] ?? null;
}

function targetLabel(t: CtoWorkListRow["deliveryTarget"]): string {
  switch (t?.kind) {
    case "spec":
      return "a settled spec document";
    case "pr":
      return "a pull request";
    case "merged":
      return t.baseBranch ? `merged into ${t.baseBranch}` : "merged";
    case "published":
      return t.releaseTarget ? `published to ${t.releaseTarget}` : "published";
    case "deployed":
      return t.instance ? `deployed to ${t.instance}` : "deployed";
    default:
      return "unspecified target";
  }
}

// A claim label that keeps U05's distinction visible in the copy itself.
function claimTag(): string {
  return "pipeline claim";
}

// --- Derivation ---

export function cardCandidateRows(rows: CtoWorkListRow[]): CtoWorkListRow[] {
  return (rows ?? []).filter((r) => CARD_VISIBLE_STATES.has(r?.state));
}

export function deriveWorkCard(row: CtoWorkListRow, inspect: CtoWorkInspectData | null): CtoWorkCard {
  const specHash = (row.spec?.hash ?? inspect?.spec?.hash ?? null) as string | null;
  const claims = inspect?.claims ?? [];
  const operations = inspect?.operations ?? [];
  const targetKind = row.deliveryTarget?.kind;

  // ---- target liveness (U07) ----
  const targetLive = inspect ? inspect.targetLive ?? null : null;
  let targetLiveDetail: string | null = null;
  if (targetLive === "ambiguous") {
    targetLiveDetail =
      "ambiguous: more than one session matches the work's target — identify it before acting on this work";
  } else if (targetLive === false) {
    targetLiveDetail = "the work's target session is not live right now";
  } else if (targetLive == null) {
    targetLiveDetail = "target liveness is unknown (its source could not be read)";
  }

  // ---- review ----
  const approval = liveClaim(claims, REVIEW_CLAIM, specHash);
  let reviewStatus: CtoWorkCard["review"]["status"] = "not-started";
  let reviewDetail: string | null = null;
  let reviewerModel = approval?.reviewerModel ?? null;
  let reviewHead = approval?.headSha ?? null;
  if (approval) {
    reviewStatus = "approved";
    reviewDetail = approval.note ?? null;
  } else if (unresolvedOp(inspect?.unresolvedReceipts, OP_REVIEW)) {
    reviewStatus = "reviewing";
    reviewDetail = "an independent review is running";
  } else {
    const attempt = latestAttempt(inspect?.attempts, "review");
    if (attempt) {
      reviewHead = reviewHead ?? attempt.headSha ?? null;
      reviewerModel = reviewerModel ?? attempt.reviewerModel ?? null;
      if (attempt.status === "failed" || attempt.status === "stopped" || attempt.status === "missing") {
        reviewStatus = "blocked";
        reviewDetail = attempt.note ?? "the review attempt did not complete";
      } else if (attempt.status === "changes_requested") {
        reviewStatus = "blocked";
        reviewDetail = attempt.note ?? "the reviewer requested changes";
      } else if (attempt.status === "approved") {
        // An approved attempt whose approval claim is not current (invalidated
        // by a moved head or a spec revision) — §11 forbids preserving it.
        reviewStatus = "reviewing";
        reviewDetail = "an earlier approval was invalidated — re-review is pending";
      } else if (attempt.status === "dispatching" || attempt.status === "running") {
        reviewStatus = "reviewing";
        reviewDetail = "an independent review is running";
      }
    }
  }

  // ---- merge gate ----
  const merged = liveClaim(claims, MERGE_CLAIM, specHash);
  const mergeReceipt = latestReceipt(operations, OP_MERGE);
  let mergeStatus: CtoWorkCard["merge"]["status"] = "pending";
  let mergeDetail: string | null = null;
  if (merged) {
    mergeStatus = "merged";
  } else if (unresolvedOp(inspect?.unresolvedReceipts, OP_MERGE)) {
    mergeStatus = "running";
    mergeDetail = "the merge gate is running";
  } else if (mergeReceipt) {
    if (mergeReceipt.status === "failed") {
      mergeStatus = "blocked";
      mergeDetail =
        mergeReceipt.resultCode === "target_changed"
          ? "the head moved between the gate read and the merge (matching-head precondition) — re-review is required"
          : mergeReceipt.resultCode === "policy_blocked"
            ? "the merge gate refused this work (required checks or policy not satisfied)"
            : `the merge failed (${mergeReceipt.resultCode ?? "unknown reason"})`;
    } else {
      mergeStatus = "running";
      mergeDetail = "the merge gate passed — the merge commit is not recorded yet";
    }
  } else if (targetKind === "spec" || targetKind === "pr") {
    mergeStatus = "not-needed";
  }
  if (mergeStatus === "pending" && (targetKind === "merged" || targetKind === "published" || targetKind === "deployed")) {
    mergeDetail = mergeDetail ?? "waiting for the merge gate";
  }

  // ---- release ----
  const needsRelease = targetKind === "published" || targetKind === "deployed";
  const releaseClaim = liveClaim(claims, RELEASE_CLAIM, specHash);
  const releaseReceipt = latestReceipt(operations, OP_RELEASE);
  let releaseStatus: CtoWorkCard["release"]["status"] = "pending";
  let releaseDetail: string | null = null;
  let releaseArtifact: string | null = null;
  if (!needsRelease && !releaseClaim && !releaseReceipt) {
    releaseStatus = "not-needed";
  } else if (releaseClaim) {
    releaseStatus = "published";
    const a = releaseClaim.artifact;
    const identity = [a?.identity, a?.version].filter(Boolean).join("@");
    releaseArtifact = identity || null;
    releaseDetail = `the pipeline reported the artifact published (${claimTag()})`;
  } else if (unresolvedOp(inspect?.unresolvedReceipts, OP_RELEASE)) {
    releaseStatus = "running";
    releaseDetail = "the release pipeline is running";
  } else if (releaseReceipt && releaseReceipt.status === "failed") {
    releaseStatus = "failed";
    releaseDetail = `the release failed (${releaseReceipt.resultCode ?? "unknown reason"})`;
  } else if (releaseReceipt) {
    releaseStatus = "running";
    releaseDetail = "the release pipeline passed — the published artifact is not recorded yet";
  }

  // ---- verify (U05: only observations read as verified) ----
  const needsVerify = needsRelease;
  const runsClaim = liveClaim(claims, TARGET_RUNS_CLAIM, specHash);
  const acceptanceClaim = liveClaim(claims, ACCEPTANCE_CLAIM, specHash);
  const verifyReceipt = latestReceipt(operations, OP_VERIFY);
  let verifyStatus: CtoWorkCard["verify"]["status"] = "pending";
  let verifyDetail: string | null = null;
  if (!needsVerify && !runsClaim && !acceptanceClaim && !verifyReceipt) {
    verifyStatus = "not-needed";
  } else if (runsClaim) {
    const shaMatched =
      runsClaim.observedSha != null && runsClaim.expectedSha != null
        ? runsClaim.observedSha === runsClaim.expectedSha
        : true;
    const versionMatched =
      runsClaim.expectedVersion != null && runsClaim.observedVersion != null
        ? runsClaim.observedVersion === runsClaim.expectedVersion
        : true;
    if (!shaMatched || !versionMatched) {
      verifyStatus = "failed";
      verifyDetail = "the artifact the target runs does not match the published one";
    } else if (acceptanceClaim) {
      const checks = acceptanceClaim.checks ?? [];
      const allPassed = checks.length > 0 ? checks.every((c) => c?.passed !== false) : true;
      verifyStatus = allPassed ? "verified" : "failed";
      if (!allPassed) {
        verifyDetail = "acceptance checks on the target did not all pass";
      }
    } else {
      verifyStatus = "pending";
      verifyDetail = "the target is running the artifact — acceptance checks not recorded yet";
    }
  } else if (unresolvedOp(inspect?.unresolvedReceipts, OP_VERIFY)) {
    verifyStatus = "running";
    verifyDetail = "verification on the target is running";
  } else if (verifyReceipt && verifyReceipt.status === "failed") {
    verifyStatus = "failed";
    verifyDetail = `verification failed (${verifyReceipt.resultCode ?? "unknown reason"})`;
  } else if (releaseClaim) {
    verifyStatus = "pending";
    verifyDetail = "published — not yet verified on the target";
  } else if (verifyReceipt) {
    verifyStatus = "running";
    verifyDetail = "verification passed — the observation is not recorded yet";
  }

  return {
    workId: row.id,
    title: row.objective?.trim() || row.id,
    state: row.state,
    stateLabel: STATE_LABELS[row.state] ?? row.state,
    waitingReason: row.state === "waiting" ? row.waitingReason ?? null : null,
    waitingReasonDetail:
      row.state === "waiting"
        ? WAITING_REASON_DETAIL[row.waitingReason ?? ""] ?? "parked (reason recorded on the work)"
        : "",
    deliveryTargetLabel: targetLabel(row.deliveryTarget),
    targetLive,
    targetLiveDetail,
    review: {
      status: reviewStatus,
      reviewerModel,
      headSha: reviewHead,
      detail: reviewDetail,
    },
    merge: {
      status: mergeStatus,
      headSha: merged?.headSha ?? mergeReceipt?.specHash != null ? merged?.headSha ?? null : merged?.headSha ?? null,
      mergeCommitSha: merged?.mergeCommitSha ?? null,
      prNumber: merged?.prNumber ?? null,
      detail: mergeDetail,
    },
    release: {
      status: releaseStatus,
      pipeline: releaseClaim?.pipeline ?? null,
      runId: releaseClaim?.runId ?? null,
      artifact: releaseArtifact,
      detail: releaseDetail,
    },
    verify: {
      status: verifyStatus,
      target: runsClaim?.target ?? acceptanceClaim?.target ?? null,
      detail: verifyDetail,
    },
  };
}

// --- Fetch glue + hook (refetch-driven: poll + focus + visibility) ---

type WorkToolResult = { ok?: boolean; error?: string; data?: unknown };

async function runWorkTool(tool: string, args: Record<string, unknown>): Promise<WorkToolResult> {
  const run = typeof window !== "undefined" ? window.api?.ctoWorkRun : undefined;
  if (typeof run !== "function") throw new Error("work tools are unavailable on this connection");
  return run(tool, args);
}

export const WORK_CARD_INSPECT_LIMIT = 6;

export function useCtoWorkCards({ pollMs = 10_000, enabled = true }: { pollMs?: number; enabled?: boolean } = {}): {
  cards: CtoWorkCard[];
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [cards, setCards] = useState<CtoWorkCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  const refresh = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    (async () => {
      try {
        const list = await runWorkTool("work_list", {});
        if (!list?.ok) throw new Error(list?.error ?? "work_list failed");
        const works = Array.isArray((list.data as { works?: CtoWorkListRow[] } | undefined)?.works)
          ? ((list.data as { works: CtoWorkListRow[] }).works)
          : [];
        const candidates = cardCandidateRows(works).slice(0, WORK_CARD_INSPECT_LIMIT);
        const inspected = await Promise.all(
          candidates.map(async (row) => {
            try {
              const r = await runWorkTool("work_inspect", { work: row.id });
              if (!r?.ok) return deriveWorkCard(row, null);
              return deriveWorkCard(row, r.data as CtoWorkInspectData);
            } catch {
              // One failed inspect must not blank the card: the list row alone
              // still derives state + parking + review-summary signals.
              return deriveWorkCard(row, null);
            }
          }),
        );
        setCards(inspected);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const t = setInterval(refresh, pollMs);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, pollMs, refresh]);

  return { cards, error, loading, refresh };
}
