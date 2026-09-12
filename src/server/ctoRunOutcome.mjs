// Only closed codes cross the model/persistence boundary; never exception text.
const CODES = new Set([
  "create-http", "create-invalid", "prompt-http", "read-http", "timeout",
  "transport-error", "model-error", "empty-output", "schema-invalid",
  "summary-error", "gated", "provenance-error", "cleanup-error",
]);

export function safeSummaryCode(code) {
  return CODES.has(code) ? code : "schema-invalid";
}
