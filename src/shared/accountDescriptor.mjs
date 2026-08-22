// accountDescriptor.mjs — the account-reader descriptor (BET-1239).
//
// A descriptor is a pure, declarative description of how to read a
// credit-based account: "call this URL with the bearer key we already hold,
// read these dot-paths, interpret the balance this way." It is data, not a
// program, so growing the set of supported account readers is authoring a JSON
// file — not writing an adapter (which stays reserved for provider shapes too
// irregular to describe).
//
// Mirrors the two declarative-authoring patterns already in the repo — YAML
// plugin manifests (src/shared/pluginManifest.mjs) and forge rules — for the
// same reasons: a shared pure validator that fails by NAME (typo protection
// matters more than flexibility in a file that decides routing), and a reader
// that maps a fetched payload onto the UsageSnapshot shape.
//
// This module is pure (no fs, no network, no opencode imports) so it is shared
// verbatim between the server loader (src/server/accountReaders.mjs) and the
// renderer. Types are mirrored in accountDescriptor.d.mts.

const TOP_LEVEL_KEYS = [
  "id",
  "providerIDs",
  "url",
  "auth",
  "kind",
  "balance",
  "windows",
  "planLabel",
  "overagePrice",
];
const BALANCE_KEYS = ["path", "minusPath", "units", "sign"];
const ACCOUNT_KINDS = ["subscription", "credit"];
const BALANCE_SIGNS = ["positive-is-credit", "positive-is-debt"];
const WINDOW_KEYS = [
  "kind",
  "label",
  "pct",
  "used",
  "limit",
  "remaining",
  "resetsAt",
  "startedAt",
];

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Coerce a possibly-string, possibly-nullish number to a finite number, or
 * `undefined` when it can't. `Number("")` is 0 (not NaN) so empty strings are
 * rejected explicitly.
 */
function toFiniteNumber(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clampPct(n) {
  return Math.round(Math.max(0, Math.min(100, n)));
}

/** Epoch seconds, epoch ms, or an ISO string → epoch ms. */
function readEpochMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string" && v) {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Resolve a dot-path ("a.b.0.c") against a payload. Returns undefined on any
 *  missing segment or a non-object traversal step. */
function getByPath(payload, path) {
  if (path == null) return undefined;
  let cur = payload;
  for (const seg of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Validate a raw (parsed-JSON) descriptor. Never throws — a malformed input
 * returns `{ valid: false, errors: string[] }` with each error naming the key
 * it concerns (typo protection over flexibility). Unknown top-level keys fail
 * by name; a missing required key fails by name.
 * @param {unknown} raw
 * @returns {{ valid: true, descriptor: object } | { valid: false, errors: string[] }}
 */
export function validateDescriptor(raw) {
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ["descriptor must be an object"] };
  }
  const errors = [];

  for (const k of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  }

  if (!isNonEmptyString(raw.id)) errors.push('missing required key "id"');

  if (!Array.isArray(raw.providerIDs)) {
    errors.push('missing required key "providerIDs"');
  } else {
    if (raw.providerIDs.length === 0) errors.push('"providerIDs" must not be empty');
    for (const p of raw.providerIDs) {
      if (!isNonEmptyString(p)) errors.push('"providerIDs" must contain only non-empty strings');
    }
  }

  if (!isNonEmptyString(raw.url)) errors.push('missing required key "url"');

  if (raw.auth !== "bearer") {
    errors.push(raw.auth === undefined ? 'missing required key "auth"' : `unknown auth "${raw.auth}"`);
  }

  if (raw.kind !== undefined && !ACCOUNT_KINDS.includes(raw.kind)) {
    errors.push(`"kind" must be "subscription" or "credit"`);
  }

  const bal = raw.balance;
  if (!isPlainObject(bal)) {
    errors.push('missing required key "balance"');
  } else {
    for (const k of Object.keys(bal)) {
      if (!BALANCE_KEYS.includes(k)) errors.push(`unknown key "balance.${k}"`);
    }
    if (!isNonEmptyString(bal.path)) errors.push('missing required key "balance.path"');
    if (bal.minusPath !== undefined && !isNonEmptyString(bal.minusPath)) {
      errors.push('"balance.minusPath" must be a non-empty dot-path string');
    }
    if (bal.units !== undefined && !isNonEmptyString(bal.units)) errors.push('"balance.units" must be a non-empty string');
    if (!BALANCE_SIGNS.includes(bal.sign)) {
      errors.push('"balance.sign" must be "positive-is-credit" or "positive-is-debt"');
    }
  }

  if (raw.windows !== undefined) {
    if (!Array.isArray(raw.windows)) {
      errors.push('"windows" must be an array');
    } else {
      raw.windows.forEach((w, i) => {
        const idx = `windows[${i}]`;
        if (!isPlainObject(w)) {
          errors.push(`${idx} must be an object`);
          return;
        }
        for (const k of Object.keys(w)) {
          if (!WINDOW_KEYS.includes(k)) errors.push(`unknown key "${idx}.${k}"`);
        }
        for (const lit of ["kind", "label"]) {
          if (!isNonEmptyString(w[lit])) errors.push(`missing required key "${idx}.${lit}"`);
        }
        for (const f of ["pct", "used", "limit", "remaining", "resetsAt", "startedAt"]) {
          if (w[f] !== undefined && !isNonEmptyString(w[f])) errors.push(`"${idx}.${f}" must be a dot-path string`);
        }
      });
    }
  }

  if (raw.planLabel !== undefined && !isNonEmptyString(raw.planLabel)) {
    errors.push('"planLabel" must be a dot-path string');
  }
  if (raw.overagePrice !== undefined && !isNonEmptyString(raw.overagePrice)) {
    errors.push('"overagePrice" must be a dot-path string');
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, descriptor: raw };
}

/**
 * Turn one descriptor window's dot-path spec into a UsageWindow by resolving
 * each path against the payload. Normalizes the same way the code adapters'
 * normalizeWindow does (pct from used/limit when absent, always clamped, epoch
 * ms timestamps); returns null when there is nothing usable to show.
 * @param {object} w
 * @param {(path: string) => unknown} get
 * @returns {object | null}
 */
function descriptorWindow(w, get) {
  const limit = toFiniteNumber(get(w.limit));
  let used = toFiniteNumber(get(w.used));
  if (used === undefined && limit !== undefined) {
    const remaining = toFiniteNumber(get(w.remaining));
    if (remaining !== undefined) used = limit - remaining;
  }

  let pct = toFiniteNumber(get(w.pct));
  if (pct !== undefined) {
    pct = clampPct(pct);
  } else if (limit !== undefined && limit !== 0 && used !== undefined) {
    pct = clampPct((used / limit) * 100);
  } else {
    pct = undefined;
  }
  if (pct === undefined || !Number.isFinite(pct)) return null;

  const out = { kind: w.kind, label: w.label, pct };
  if (used !== undefined) out.used = used;
  if (limit !== undefined && limit !== 0) out.limit = limit;

  const resetsAt = readEpochMs(get(w.resetsAt));
  if (resetsAt !== undefined) out.resetsAt = resetsAt;
  const startedAt = readEpochMs(get(w.startedAt));
  if (startedAt !== undefined) out.startedAt = startedAt;

  return out;
}

/**
 * Map a fetched payload onto the UsageSnapshot shape for this descriptor.
 * Pure. A missing balance resolves to `undefined`, NEVER 0 (absent balance and
 * a zero balance are meaningfully different: absent means *unknown*). Sign
 * conventions are the point: a negative balance under `positive-is-credit` is
 * overdrawn → `exhausted: true`, and `positive-is-debt` inverts the raw value.
 * @param {object} descriptor  a validated descriptor
 * @param {unknown} payload    the parsed response body
 * @returns {object} an Omit<UsageSnapshot, "fetchedAt">-compatible object
 */
export function readDescriptor(descriptor, payload) {
  const get = (path) => getByPath(payload, path);

  const windows = Array.isArray(descriptor.windows)
    ? descriptor.windows.map((w) => descriptorWindow(w, get)).filter(Boolean)
    : [];

  const balanceNum = toFiniteNumber(get(descriptor.balance?.path));
  let resolvedBalance = balanceNum;
  // A two-field balance: `value(path) − value(minusPath)`. This is the whole
  // permitted arithmetic — no expression language (BET-1269 5d). Add nothing
  // more.
  if (resolvedBalance !== undefined && descriptor.balance?.minusPath) {
    const subtract = toFiniteNumber(get(descriptor.balance.minusPath));
    if (subtract !== undefined) resolvedBalance = resolvedBalance - subtract;
  }
  const balance =
    resolvedBalance !== undefined
      ? descriptor.balance?.sign === "positive-is-debt"
        ? -resolvedBalance
        : resolvedBalance
      : undefined;

  const planLabelRaw = get(descriptor.planLabel);
  const planLabel = typeof planLabelRaw === "string" && planLabelRaw ? planLabelRaw : undefined;

  const overagePriceNum = toFiniteNumber(get(descriptor.overagePrice));
  const overagePrice = overagePriceNum !== undefined ? overagePriceNum : undefined;

  const overdrawn = balance !== undefined && balance < 0;
  const atWindowLimit = windows.some((w) => w.pct >= 100);
  const exhausted = overdrawn || atWindowLimit;

  const snap = { provider: descriptor.id, providerIDs: descriptor.providerIDs, windows };
  if (typeof descriptor.kind === "string" && descriptor.kind) snap.kind = descriptor.kind;
  if (balance !== undefined) snap.balance = balance;
  if (overagePrice !== undefined) snap.overagePrice = overagePrice;
  if (planLabel) snap.planLabel = planLabel;
  if (exhausted) snap.exhausted = true;
  return snap;
}
