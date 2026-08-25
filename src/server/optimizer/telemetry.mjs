// optimizer/telemetry.mjs — count-only context telemetry for the optimizer
// (Optimizer P2.5, BET-1347).
//
// The `manta` Axiom dataset already carries `source` / `device` / `level` /
// `msg` from the server's log shipper. This module adds a `channel: "ctx"`
// discriminator for optimizer CONTEXT events (mask applications, routing
// decisions, compactions, tunes) that are useful to a maintainer watching the
// guardrails — without ever leaking content.
//
// DAMAGE BOUNDARY: counts and measurements only. Never conversation content,
// never file paths, never session titles (sessionID is allowed because it is
// an opaque id, not a title). The test suite enforces this with a grep gate
// over the emission call sites: no field named `text` / `content` / `prompt` /
// `message` may ever be shipped.
//
// This is the ONLY module that knows how the box ships context events. Callers
// import `shipCtxEvent`; `setTelemetrySink(shipper)` is called once at boot
// (src/server/index.mjs hands it the SAME log-shipper instance that
// captureConsole already uses — a reference, never a second shipper). Without
// a sink the module is a silent no-op, so telemetry is never load-bearing.

// The Axiom log shipper (createLogShipper), or null when it isn't configured.
let sink = null;

/**
 * Point the context-telemetry sink at the box's log shipper. Called ONCE at
 * server boot with the already-constructed shipper (a reference, no second
 * instance). Pass null to disable.
 */
export function setTelemetrySink(shipper) {
  sink = shipper ?? null;
}

/**
 * Ship one optimizer context event. Fields are merged onto
 * `{ channel: "ctx", ...fields }` so Axiom can filter on `channel == "ctx"`.
 * A silent no-op when no sink is configured (or when the sink is broken) —
 * telemetry must never throw and never block the caller.
 *
 * @param {Record<string, string|number|boolean|null|undefined>} fields
 */
export function shipCtxEvent(fields = {}) {
  if (!sink || typeof sink.log !== "function") return;
  try {
    sink.log("info", "ctx", { channel: "ctx", ...fields });
  } catch {
    // Swallow — telemetry never breaks the box.
  }
}
