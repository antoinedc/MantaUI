// toolReliability.mjs — per-endpoint tool-call correctness measurement (pure).
//
// BET-1234 (Stage 2 of the Automatic Manta Routing epic). Every turn in this
// app is agentic, and providers serving the SAME model vary meaningfully in
// tool-calling correctness, not just speed — an endpoint that emits a malformed
// tool call is not "cheap", it is broken work billed at a discount, and it is
// invisible in any price comparison. Speed and price are measured elsewhere
// (modelLedger); this module measures the one thing those cannot see.
//
// It is PURE: no I/O, no Date.now(), no node imports — so the server and
// renderer can never disagree and the arithmetic is testable with fixtures.
// Wiring it into the router is a separate issue; this ships the measurement
// only.

// Minimum number of requests that ended in tool calls before an endpoint's
// observed error rate is treated as statistical evidence. Below this the
// endpoint is UNMEASURED (rank 1, treated as average) — three bad requests out
// of three is anecdote, not evidence.
export const MIN_SAMPLE_REQUESTS = 20;

// The margin, in "standard deviations" (of the baseline proportion's standard
// error), by which an endpoint's rate must exceed the same MODEL's baseline
// rate before it counts as materially worse. A deliberate standard-deviation-
// style margin rather than an absolute delta, because a genuinely hard tool
// schema produces errors on every endpoint — that is the model's cost, not one
// endpoint's fault. 1σ is lenient enough to ignore sampling noise on a healthy
// baseline yet tight enough to flag a real outlier.
export const DERANK_MARGIN_SIGMA = 1;

// ---- classification -------------------------------------------------------

// The runtime kind of a JSON value, the way a schema's `type` talks about it.
function valueType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// Does `value` satisfy one of the declared schema types? "integer" matches a
// finite whole number, "number" any finite number, the rest match the runtime
// kind.
function typeMatches(value, declaredTypes) {
  const type = valueType(value);
  const types = Array.isArray(declaredTypes) ? declaredTypes : [declaredTypes];
  let matched = false;
  for (const dt of types) {
    if (dt === "integer") {
      if (type === "number" && Number.isInteger(value)) matched = true;
    } else if (dt === "number") {
      if (type === "number") matched = true;
    } else if (dt === type) {
      matched = true;
    }
  }
  return matched;
}

// Is the value within the (optional) enum restriction?
function enumOk(value, enumVals) {
  if (!Array.isArray(enumVals)) return true;
  return enumVals.includes(value);
}

// A small, dependency-free structural check against the declared parameter
// schema: required keys present, declared types match, enum values in range.
// Deliberately NOT a full JSON-schema evaluator — deep/anyOf/oneOf validation
// would drag in a dependency and is out of scope for this measurement.
function violatesSchema(args, schema) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return true;

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in args)) return true;
  }

  const props = schema && typeof schema === "object" ? schema.properties : undefined;
  if (props && typeof props === "object") {
    for (const key of Object.keys(props)) {
      if (!(key in args)) continue;
      const spec = props[key];
      if (!spec || typeof spec !== "object") continue;
      if (!enumOk(args[key], spec.enum)) return true;
      if (spec.type !== undefined && !typeMatches(args[key], spec.type)) return true;
    }
  }
  return false;
}

// Pull the compilable parameter schema out of a tool definition. Handles the
// common REST/OpenAPI + function-calling shapes. Returns null when absent or
// uncompilable — such a tool is ALWAYS valid, because a malformed caller-side
// schema is our bug, not the provider's (conservative on purpose).
function toolSchema(def) {
  if (!def || typeof def !== "object" || Array.isArray(def)) return null;
  const fn = def.function;
  const s =
    def.input_schema ??
    def.parameters ??
    def.schema ??
    (fn && typeof fn === "object" ? fn.parameters ?? fn.input_schema : undefined);
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  return s;
}

// Normalise a call's arguments to a plain object. Accepts either an already-
// object argument value (opencode stores tool input as an object) or a JSON
// string. Returns null when the arguments are missing or fail to parse — that
// is an invalid-json.
function resolveArguments(args) {
  if (typeof args === "string") {
    try {
      const v = JSON.parse(args);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  return null;
}

function hasAny(toolsById) {
  if (toolsById == null) return false;
  if (toolsById instanceof Map) return toolsById.size > 0;
  return Object.keys(toolsById).length > 0;
}

function getDef(toolsById, name) {
  if (toolsById instanceof Map) return toolsById.get(name);
  return Object.prototype.hasOwnProperty.call(toolsById, name) ? toolsById[name] : undefined;
}

/**
 * Classify a single tool call.
 *
 * @param {object} call `{ name?, arguments? }` — `arguments` may be an object
 *   (opencode's stored shape) or a JSON string.
 * @param {object|Map|null} toolsById the request's tool list keyed by tool
 *   name (a plain object or Map). null/empty ⇒ no tool list to check against.
 * @returns {"valid"|"invalid-json"|"unknown-name"|"schema-mismatch"}
 */
export function classifyToolCall(call, toolsById) {
  const c = call && typeof call === "object" ? call : {};
  const name = c.name;

  const args = resolveArguments(c.arguments);
  if (args === null) return "invalid-json";

  const byId = toolsById && typeof toolsById === "object" ? toolsById : null;
  if (byId !== null && hasAny(byId)) {
    if (typeof name !== "string") return "unknown-name";
    const def = getDef(byId, name);
    if (def === undefined) return "unknown-name";
    const schema = toolSchema(def);
    if (schema && violatesSchema(args, schema)) return "schema-mismatch";
  }

  return "valid";
}

// Build a name→def lookup from an array of tool definitions.
function toolsByIdFromList(tools) {
  const out = Object.create(null);
  for (const t of Array.isArray(tools) ? tools : []) {
    if (t && typeof t === "object" && typeof t.name === "string") out[t.name] = t;
  }
  return out;
}

// ---- aggregation ----------------------------------------------------------

/**
 * Aggregate at REQUEST level: one bad call makes one bad request, not a
 * fraction. `requests` is the count of requests that ended in tool calls.
 *
 * @param {Array<{toolCalls?: Array, tools?: Array}>} requests
 * @returns {{requests:number, errored:number, rate:number}}
 */
export function aggregateReliability(requests) {
  const list = Array.isArray(requests) ? requests : [];
  let requestCount = 0;
  let errored = 0;
  for (const r of list) {
    const calls = Array.isArray(r && r.toolCalls) ? r.toolCalls : [];
    if (calls.length === 0) continue;
    requestCount += 1;
    const tools =
      Array.isArray(r && r.tools) && r.tools.length > 0 ? toolsByIdFromList(r.tools) : null;
    if (calls.some((c) => classifyToolCall(c, tools) !== "valid")) errored += 1;
  }
  const rate = requestCount === 0 ? 0 : errored / requestCount;
  return { requests: requestCount, errored, rate };
}

// ---- derank rule ----------------------------------------------------------

function num0(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}
function fmtPct(x) {
  return `${(num0(x) * 100).toFixed(1)}%`;
}

/**
 * The reliability rank of an endpoint — three-valued, NOT the old binary
 * "penalise?". The design is explicit: *an endpoint with no measurement yet is
 * treated as average, never as good.* A binary flag cannot express that — below
 * the sample floor the old rule returned "no penalty", identical to a measured
 * reliable endpoint. The rank orders the within-model contest:
 *   0 = measured-reliable (enough evidence, not materially worse than baseline)
 *   1 = unmeasured (no usable measurement yet → treated as AVERAGE, never good)
 *   2 = deranked (measured and materially worse than the model baseline)
 *
 * Rules that keep it honest:
 *  - below {@link MIN_SAMPLE_REQUESTS} → unmeasured (anecdote, not evidence),
 *    even at a 100% error rate;
 *  - no baseline to compare against (no baseline rate, or `n <= 1` i.e. a
 *    model served by a single endpoint) → unmeasured — there is nothing to be
 *    worse than;
 *  - otherwise derank only when this endpoint's rate exceeds the same MODEL's
 *    baseline rate by more than {@link DERANK_MARGIN_SIGMA} standard errors of
 *    that baseline; everything else is measured-reliable.
 *
 * @param {{requests:number, errored:number, rate:number}} sample  this endpoint
 * @param {{rate:number, n:number}|null|undefined} baseline  same model's rate
 *   across all its endpoints; null/undefined ⇒ no baseline
 * @returns {{rank:0|1|2, reason:string}}
 */
export function shouldDerank(sample, baseline) {
  const requests = num0(sample && sample.requests);
  if (requests < MIN_SAMPLE_REQUESTS) {
    return { rank: 1, reason: `below sample floor (${requests} < ${MIN_SAMPLE_REQUESTS} requests)` };
  }

  const b = baseline && typeof baseline === "object" ? baseline : null;
  if (!b || typeof b.rate !== "number" || typeof b.n !== "number" || !(b.n > 1)) {
    return { rank: 1, reason: "no baseline to compare against" };
  }

  const p = b.rate;
  const se = Math.sqrt((p * (1 - p)) / b.n);
  const threshold = p + DERANK_MARGIN_SIGMA * se;
  if (sample.rate > threshold) {
    return { rank: 2, reason: `rate ${fmtPct(sample.rate)} exceeds baseline ${fmtPct(p)} by >${DERANK_MARGIN_SIGMA}\u03c3` };
  }
  return { rank: 0, reason: `within baseline margin (${fmtPct(sample.rate)} \u2264 ${fmtPct(p)} + ${DERANK_MARGIN_SIGMA}\u03c3)` };
}
