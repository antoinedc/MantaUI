// Only closed codes cross the model/persistence boundary; never exception text.
import { classifyFinish } from "../shared/streamInterpretation.mjs";
const CODES = new Set([
  "create-http", "create-invalid", "prompt-http", "read-http", "timeout",
  "transport-error", "model-error", "empty-output", "schema-invalid",
  "summary-error", "gated", "provenance-error", "cleanup-error",
  "model-output-cap", "model-context-cap", "unknown-error",
  // W3 (endpoint-health spec D6/§4.5): the HTTP status is no longer discarded
  // at the model boundary — bare "model-error" survives only for errors with
  // no classifiable status.
  "model-error-402", "model-error-401", "model-error-403", "model-error-404",
  "model-error-429", "model-error-5xx",
  // BET-1535 (S3): the router's typed verdict when it knows every candidate is
  // health-excluded — the run fails with this reason instead of dispatching on
  // a dead default. Never a quality failure (no tier escalation).
  "no-healthy-endpoint",
  // BET-1537 (S5, W6): the failover stop — re-resolution with the operation's
  // own exclusion set provably cannot yield a DIFFERENT endpoint (identical,
  // or an unpinned default). The run stops here instead of repeating itself.
  "no-alternate-endpoint",
]);

// §4.5 status buckets → the W3 code. Unclassifiable statuses (none/400 etc.)
// stay bare "model-error".
export function classifyModelErrorCode(error) {
  const status = error?.data?.statusCode;
  if (status === 402 || status === 401 || status === 403 || status === 404 || status === 429) {
    return `model-error-${status}`;
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) return "model-error-5xx";
  return "model-error";
}

export function safeSummaryCode(code) {
  return CODES.has(code) ? code : "unknown-error";
}

export function assistantCompletion(info) {
  if (info?.error) return "model-error";
  if (!Number.isFinite(info?.time?.completed)) return null;
  const finish = typeof info.finish === "string" ? info.finish.toLowerCase().replaceAll("-", "_") : "";
  const cap = classifyFinish(finish);
  if (cap) return cap === "context-wall" ? "model-context-cap" : "model-output-cap";
  if (["content_filter", "error", "refusal"].includes(finish)) return "model-error";
  // Both the normalized API and provider-native terminal values. Absent or
  // unknown finish is NOT proof of completion; neither is a completed tool step.
  return ["stop", "end_turn", "stop_sequence"].includes(finish) ? "ok" : null;
}

export function isQualityFailure(code) {
  return ["empty-output", "model-output-cap", "schema-invalid"].includes(code);
}

// ---------------------------------------------------------------------------
// BET-1537 (S5, W6): the failure CLASS for the shared two-call budget. The
// endpoint failover and the nano→mid quality cascade share ONE budget —
// the class decides which retry (if any) the second call spends:
//
//   "quality"  → the existing tier escalation (same behavior, S1).
//   "provider" → re-resolve with an exclusion set and failover — retry ONLY
//                if the resolution yields a DIFFERENT endpointKey. A provider
//                failure is evidence against the endpoint, not the box.
//   "local"    → a local lifecycle failure (create-http, provenance-error,
//                read-http, timeout, transport-error, a prompt-http that is
//                NOT a §4.1a provider refusal, resolution verdicts) — retry
//                the same endpoint if at all; it is NOT evidence against the
//                provider, so no failover, no escalation.
//
// §4.1a prompt-boundary refusals: a prompt-http 402/429 on a PINNED model IS
// provider evidence (the refusal names the provider); the same statuses on an
// UNPINNED default are ambiguous (the box cannot name what was refused), so
// they stay local.
export function runFailureClass(out) {
  if (!out || out.ok !== false) return null;
  if (isQualityFailure(out.code)) return "quality";
  if (out.code === "model-error" || /^model-error-/.test(out.code ?? "")) return "provider";
  if (out.code === "prompt-http" && out.pinned === true && (out.httpStatus === 402 || out.httpStatus === 429)) {
    return "provider";
  }
  return "local";
}

// §4.5's authoritative statuses — the runner never retries them (a retry is
// guaranteed waste): out-of-credit (402), forbidden (403), not-found (404)
// exclude on FIRST occurrence. 401 is arming, not authoritative (§4.5a) —
// the provider's own isRetryable flag governs it (false in practice).
const AUTHORITATIVE_STATUSES = new Set([402, 403, 404]);

/** Whether a provider-class failure may spend the failover attempt. */
export function canFailover(out) {
  if (!out || out.ok !== false) return false;
  if (out.retryable === false) return false;
  if (AUTHORITATIVE_STATUSES.has(out.httpStatus)) return false;
  return true;
}
