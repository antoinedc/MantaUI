// Only closed codes cross the model/persistence boundary; never exception text.
import { classifyFinish } from "../shared/streamInterpretation.mjs";
const CODES = new Set([
  "create-http", "create-invalid", "prompt-http", "read-http", "timeout",
  "transport-error", "model-error", "empty-output", "schema-invalid",
  "summary-error", "gated", "provenance-error", "cleanup-error",
  "model-output-cap", "model-context-cap", "unknown-error",
]);

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
