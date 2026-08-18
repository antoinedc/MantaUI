// normalizeWindow.mjs — the ONE place a raw provider window shape becomes a
// UsageWindow (BET-737). Every adapter (claude / codex / kimi, and any future
// one) routes its raw fields through this function; no provider-specific
// branch lives here — it only ever looks at generic field names
// (pct/used/limit/remaining/resetsAt/kind/label/binding).
//
// Pure. Never throws — a malformed/partial input resolves to `null`, which
// callers treat as "drop this window" (never emit NaN/Infinity to the wire).

// Coerce a possibly-string, possibly-nullish count to a finite number, or
// `undefined` when it can't be. Several providers (Kimi) send counts as
// strings; `Number("")` is 0 (not NaN) so we explicitly reject empty/blank
// strings too.
function toFiniteNumber(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clampPct(n) {
  return Math.round(Math.max(0, Math.min(100, n)));
}

/** A window's human label, derived from its length in SECONDS: "45m", "5h",
 *  "7d", "30d". Returns "" for a missing/unusable duration — callers pass the
 *  result straight to normalizeWindow, whose `label` already defaults to "".
 *  Never throws: `Number()` on a weird input yields NaN → "".
 */
export function usageWindowLabel(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * @param {object} raw
 * @param {"session"|"weekly"|string} [raw.kind]
 * @param {string} [raw.label]
 * @param {number|string} [raw.pct]        0-100 (already a percentage)
 * @param {number|string} [raw.used]
 * @param {number|string} [raw.limit]
 * @param {number|string} [raw.remaining]  used when `used` is absent
 * @param {number|string} [raw.resetsAt]   epoch seconds, epoch ms, or an ISO string
 * @param {boolean} [raw.binding]
 * @returns {import("../usage.mjs").UsageWindow | null}
 */
export function normalizeWindow(raw) {
  if (!raw || typeof raw !== "object") return null;

  const limit = toFiniteNumber(raw.limit);
  let used = toFiniteNumber(raw.used);
  if (used === undefined && limit !== undefined) {
    const remaining = toFiniteNumber(raw.remaining);
    if (remaining !== undefined) used = limit - remaining;
  }

  let pct = toFiniteNumber(raw.pct);
  if (pct !== undefined) {
    pct = clampPct(pct);
  } else if (limit !== undefined && limit !== 0 && used !== undefined) {
    pct = clampPct((used / limit) * 100);
  } else {
    pct = undefined;
  }

  // limit === 0, or neither pct nor a usable used/limit pair — nothing to
  // show. Never emit NaN/Infinity onto the wire.
  if (pct === undefined || !Number.isFinite(pct)) return null;

  const window = {
    kind: typeof raw.kind === "string" && raw.kind ? raw.kind : "session",
    label: typeof raw.label === "string" ? raw.label : "",
    pct,
  };
  if (used !== undefined) window.used = used;
  // A `limit: 0` can still reach here when `pct` was supplied explicitly
  // (rule 1 wins regardless of limit) — never attach it, or a popover doing
  // `used / limit` renders "5 / 0" (reviewer Nit 1).
  if (limit !== undefined && limit !== 0) window.limit = limit;

  const rawResets = raw.resetsAt;
  if (typeof rawResets === "number" && Number.isFinite(rawResets)) {
    // < 1e12 → epoch seconds (a millisecond timestamp for "now" is always
    // >= 1e12 until the year 2286), otherwise already epoch ms.
    window.resetsAt = rawResets < 1e12 ? rawResets * 1000 : rawResets;
  } else if (typeof rawResets === "string" && rawResets) {
    const parsed = Date.parse(rawResets);
    if (Number.isFinite(parsed)) window.resetsAt = parsed;
  }

  if (raw.binding === true) window.binding = true;

  return window;
}
