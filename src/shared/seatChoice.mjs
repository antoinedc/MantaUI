// seatChoice.mjs — the pure "which seat" functions for multi-seat subscription
// providers (multi-account spec §5.1 / §5.4). Shared by the server (usage
// aggregate now; automatic seat assignment in a later phase) and the renderer
// (the "next seat" hint must use the SAME function the server uses, so a hint
// can never disagree with an actual move).
//
// Pure. No I/O, no clocks, no provider names. A "seat snapshot" is a normal
// UsageSnapshot that additionally carries `{accountId, seatId, seatLabel,
// accountLabel}`.
//
// MODEL-SCOPED WINDOWS. A window with a `scope` (kind `weekly_scoped:<name>`, e.g.
// "7d · Fable") limits ONLY requests for that model; unscoped windows (5h, account
// weekly) limit everything. Every load function takes an optional `{model}` (a
// model id): a scoped window counts only when it applies to that model, and with
// no model (unknown) scoped windows are ignored — otherwise a seat whose Fable cap
// is full would read "full" for Opus conversations too.

/** Fields that identify a seat on a snapshot. The provider AGGREGATE never
 *  carries them (it stands for the whole provider, not one seat). */
export const SEAT_FIELDS = ["accountId", "seatId", "seatLabel", "accountLabel"];

/**
 * A window the provider says is not in force (e.g. a model-scoped weekly cap on
 * a model this seat is not using). Such a window is shown greyed and must never
 * drive load, exhaustion or the dial.
 * @param {{active?: boolean}|null|undefined} w
 */
export function isWindowActive(w) {
  return w?.active !== false;
}

/** The model a scoped window names ("Fable"), or null for an unscoped window. */
function windowScope(w) {
  if (typeof w?.scope === "string" && w.scope) return w.scope;
  const kind = w?.kind;
  if (typeof kind === "string" && kind.startsWith("weekly_scoped:")) return kind.slice("weekly_scoped:".length) || null;
  return null;
}

const normalizeScope = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does this window limit requests for `model`? An unscoped window limits every
 * model. A scoped window applies only when its scope name (lowercased, non-
 * alphanumerics removed) equals a token of the model id, where tokens are the
 * hyphen/dot/slash/colon/underscore-separated parts of the lowercased id ("Fable" ↔
 * `claude-fable-5`, `anthropic/claude-fable-5-1`; never `claude-opus-5-5`).
 * Model unknown → a scoped window does not apply.
 *
 * @param {{scope?: string, kind?: string}|null|undefined} w
 * @param {string|null|undefined} model  a model id, or null/undefined when unknown
 */
export function windowAppliesToModel(w, model) {
  const scope = windowScope(w);
  if (scope === null) return true;
  if (typeof model !== "string" || model === "") return false;
  const want = normalizeScope(scope);
  if (want === "") return false;
  return model.toLowerCase().split(/[-./:_]+/).some((t) => normalizeScope(t) === want);
}

/** @template {{active?: boolean}} W @param {W[]|null|undefined} windows @returns {W[]} */
export function activeWindows(windows) {
  return Array.isArray(windows) ? windows.filter((w) => w && isWindowActive(w)) : [];
}

/**
 * A seat's load: the highest pct among its ACTIVE windows, ignoring STALE ones
 * (a stale reading describes the window that just ended). One number drives
 * every seat decision.
 *
 * - no windows reported at all → `null` (unknown — ranks after every known seat)
 * - windows reported but none is active, fresh AND applicable to `model` → `0`
 *   (everything that was in force has just reset, or nothing is in force)
 *
 * A model-scoped window counts only for a request on that model (see
 * `windowAppliesToModel`); with no `model` it is ignored.
 *
 * @param {{windows?: Array<{pct:number, stale?:boolean, active?:boolean, scope?:string}>}|null|undefined} snap
 * @param {{model?: string|null}} [opts]
 * @returns {number|null}
 */
export function seatLoad(snap, { model = null } = {}) {
  const windows = Array.isArray(snap?.windows) ? snap.windows.filter(Boolean) : [];
  if (windows.length === 0) return null;
  return Math.max(0, seatLoadWindow(snap, { model })?.pct ?? 0);
}

/**
 * The window that DEFINES a seat's load: the highest-pct window among the ACTIVE,
 * FRESH ones (the same set `seatLoad` maxes over; first one wins a tie). `null`
 * when there is none (no reading, or everything in force has just reset). This is
 * the "what triggered it" of a seat move — `{kind: "session", pct: 91}`.
 *
 * @param {{windows?: Array<{kind?:string, pct:number, stale?:boolean, active?:boolean, scope?:string}>}|null|undefined} snap
 * @param {{model?: string|null}} [opts]
 * @returns {{kind: string, pct: number}|null}
 */
export function seatLoadWindow(snap, { model = null } = {}) {
  const windows = Array.isArray(snap?.windows) ? snap.windows.filter(Boolean) : [];
  let best = null;
  for (const w of windows) {
    if (!isWindowActive(w) || w.stale === true || !windowAppliesToModel(w, model)) continue;
    if (typeof w.pct !== "number" || !Number.isFinite(w.pct)) continue;
    if (best === null || w.pct > best.pct) best = { kind: typeof w.kind === "string" ? w.kind : "unknown", pct: w.pct };
  }
  return best;
}

/** @param {{exhausted?: boolean}|null|undefined} snap */
export function isSeatExhausted(snap) {
  return snap?.exhausted === true;
}

// Sort key: seats with a known load first, then seats with no reading (they may
// well have room), then exhausted seats (they certainly have none).
function rank(snap, model) {
  if (isSeatExhausted(snap)) return 1_000 + (seatLoad(snap, { model }) ?? 0);
  const load = seatLoad(snap, { model });
  return load === null ? 500 : load;
}

/**
 * The least-loaded seat. Ties go to `activeSeatId`, then to input order.
 * @template {{seatId?: string}} S
 * @param {S[]} seatSnapshots
 * @param {{activeSeatId?: string|null, model?: string|null}} [opts]
 * @returns {S|null}
 */
export function leastLoadedSeat(seatSnapshots, { activeSeatId = null, model = null } = {}) {
  const seats = (Array.isArray(seatSnapshots) ? seatSnapshots : []).filter(Boolean);
  let best = null;
  let bestRank = Infinity;
  let bestIsActive = false;
  for (const s of seats) {
    const r = rank(s, model);
    const isActive = activeSeatId != null && s.seatId === activeSeatId;
    if (r < bestRank || (r === bestRank && isActive && !bestIsActive)) {
      best = s;
      bestRank = r;
      bestIsActive = isActive;
    }
  }
  return best;
}

/**
 * The provider-level snapshot downstream consumers (routing, pacing, forecast,
 * stopper, resume, the dial) keep reading (spec §5.4):
 *
 * - auto mode: the least-loaded seat; `exhausted` only when EVERY seat is.
 * - manual mode: the active seat (falls back to the least-loaded one when the
 *   active seat has no reading, rather than blanking the provider).
 *
 * Returns a shallow copy without the seat-identity fields, so with ONE seat the
 * result is the seat's snapshot unchanged. The windows array is shared by
 * reference with the chosen seat snapshot.
 *
 * @param {Array<object>} seatSnapshots
 * @param {{mode?: "auto"|"manual", activeSeatId?: string|null}} [opts]
 * @returns {object|null}
 */
export function aggregateSnapshot(seatSnapshots, { mode = "auto", activeSeatId = null } = {}) {
  const seats = (Array.isArray(seatSnapshots) ? seatSnapshots : []).filter(Boolean);
  if (seats.length === 0) return null;

  let base;
  if (mode === "manual") {
    base = seats.find((s) => s.seatId === activeSeatId) ?? leastLoadedSeat(seats, { activeSeatId });
  } else {
    base = leastLoadedSeat(seats, { activeSeatId });
  }
  if (!base) return null;

  const exhausted = mode === "manual" ? isSeatExhausted(base) : seats.every(isSeatExhausted);
  const out = { ...base };
  for (const f of SEAT_FIELDS) delete out[f];
  if (exhausted) out.exhausted = true;
  else delete out.exhausted;
  return out;
}
