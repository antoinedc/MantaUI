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
