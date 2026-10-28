// upgradeView.mjs — the box-owned wording of the upgrade gate (WS11 D3 / audit X5).
// Pure, no I/O: `buildUpgradeView(status)` runs on the in-memory K3 status inside
// `GET /api/upgrade` and the `{kind:"upgrade"}` frame, so it works on the
// upgrade-exempt path. Both clients render `view` as given; the retry / rollback
// rules and the "Copy details" text live here, not in either client.

import { formatBytes } from "../shared/formatBytes.mjs";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// Failures where rolling back is meaningless: pre-flight stops before anything is
// touched, and a verification failure is fixed in place ("Check again").
const NO_ROLLBACK_STEPS = new Set(["preflight", "verify"]);
const CHECK_AGAIN_STEPS = new Set(["preflight", "verify"]);

export function currentStep(status) {
  return (
    status.steps.find((s) => s.status === "running") ??
    status.steps.find((s) => s.status === "failed") ??
    null
  );
}

/** numerator/denominator → 0..1, or null (indeterminate) when not measurable. */
export function stepFraction(step) {
  const p = step?.progress;
  if (!p || !finite(p.numerator) || !finite(p.denominator) || p.denominator <= 0) return null;
  return Math.min(1, Math.max(0, p.numerator / p.denominator));
}

/** "needs 31 GB free, has 3 GB" — null unless the failure carries disk numbers. */
export function describeDiskShortfall(error) {
  if (!error || !finite(error.needBytes) || error.needBytes <= 0) return null;
  const need = `needs ${formatBytes(error.needBytes)} free`;
  if (!finite(error.haveBytes) || error.haveBytes < 0) return need;
  return `${need}, has ${error.haveBytes === 0 ? "0 B" : formatBytes(error.haveBytes)}`;
}

/** "needs 31 GB free, has 3 GB" → "Needs 31 GB free, has 3 GB." */
export function diskSentence(disk) {
  return disk === "" ? "" : `${disk[0].toUpperCase()}${disk.slice(1)}.`;
}

/** "about 4 min left"; null when the box gave no estimate. */
export function formatEtaSeconds(seconds) {
  if (seconds === null || seconds === undefined || !finite(seconds) || seconds < 0) return null;
  if (seconds < 45) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h left` : `about ${h} h ${m} min left`;
}

/** Plain-text snapshot for "Copy details": every step with status/progress, then the failure. */
export function describeUpgradeDetails(status, kind, failure) {
  const lines = [`Manta box upgrade — ${kind.replace("_", " ")}`];
  for (const s of status.steps) {
    const p = s.progress;
    const measured = p && finite(p.numerator) && finite(p.denominator) ? ` (${p.numerator}/${p.denominator})` : "";
    const caption = p?.label ? ` — ${p.label}` : "";
    const err = s.error ? ` — ${s.error}` : "";
    lines.push(`${s.id}: ${s.status}${measured}${caption}${err}`);
  }
  if (failure) {
    lines.push(`error (${failure.failedStep}): ${failure.message}`);
    if (failure.disk) lines.push(`disk: ${failure.disk}`);
  }
  return lines.join("\n");
}

/**
 * The view for a K3 status. `idle` / `completed` carry nothing to render.
 * @returns {{kind: string, [k: string]: unknown}}
 */
export function buildUpgradeView(status) {
  if (!status || !Array.isArray(status.steps)) return { kind: "idle" };
  if (status.state === "running") {
    const current = currentStep(status);
    return {
      kind: "running",
      currentStepId: current?.id ?? null,
      currentFraction: stepFraction(current),
      etaText: formatEtaSeconds(status.etaSeconds ?? null),
      details: describeUpgradeDetails(status, "running", null),
    };
  }
  if (status.state === "failed") {
    const failedStep = status.error?.step ?? currentStep(status)?.id ?? "preflight";
    const retryable = status.error?.retryable !== false;
    const message =
      status.error?.message ?? status.steps.find((x) => x.status === "failed")?.error ?? "The upgrade failed.";
    const disk = describeDiskShortfall(status.error);
    return {
      kind: "failed",
      currentStepId: currentStep(status)?.id ?? null,
      failedStep,
      message,
      disk,
      diskSentence: disk ? diskSentence(disk) : null,
      retryLabel: CHECK_AGAIN_STEPS.has(failedStep) ? "Check again" : "Retry",
      canRetry: retryable,
      retryDisabledReason: retryable ? null : "This failure can't be retried — roll back instead.",
      canRollback: !NO_ROLLBACK_STEPS.has(failedStep),
      details: describeUpgradeDetails(status, "failed", { failedStep, message, disk }),
    };
  }
  if (status.state === "rolled_back") {
    return { kind: "rolled_back", details: describeUpgradeDetails(status, "rolled_back", null) };
  }
  if (status.state === "completed") return { kind: "completed" };
  return { kind: "idle" };
}
