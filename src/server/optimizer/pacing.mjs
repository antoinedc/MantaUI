// optimizer/pacing.mjs — the pacing controller's stateful core (Optimizer
// P2.3, BET-1345).
//
// The SHARED, deterministic math (deficit queue, shadow price, eco, protection)
// lives in src/shared/quotaPressure.mjs. THIS module is the stateful
// observation + persistence half: it observes the usage poller's publish point,
// accumulates a deficit queue per quota window, and serves the per-provider
// "pressure" the router's cost stage folds in.
//
// Pure logic + injected I/O, mirroring createCounterfactualStore: `load` /
// `save` persist `{ windows: { "<provider>:<kind>": {...} } }` via the shared
// jsonStore atomic writer (wired in index.mjs), `now` is the injected clock,
// and `ledgerTokens` is the injected MEASURED token total per providerID
// (src/server/modelLedger.mjs providerTokenTotals). Tokens are never assumed:
// a null token read means NO pacing pressure (fail-open).
//
// NB — the persisted window entry carries a few fields beyond the deficit
// queue itself (providerIDs, rates, tokensAtMark/pctAtMark, startedAt) because
// pressureFor must map a window to the opencode providerIDs it covers, must
// evaluate the newsvendor protection against its measured rate distribution,
// and must compute tokens-per-pct against a mark. They are observation state,
// not extra knobs.

import {
  seedDeficit,
  advanceDeficit,
  shadowPrice,
  ecoLevel,
  protectionActive,
  MIN_TOKENS_PER_PCT_SAMPLE,
} from "../../shared/quotaPressure.mjs";

const HOUR_MS = 3_600_000;
// A window reset boundary, matching forecast.mjs (RESET_DELTA).
const RESET_DELTA = -10;
const SAVE_DEBOUNCE_MS = 30_000;
// Bounded retained per-hour rate samples per window — enough for the ≥8
// confidence gate plus slack, without unbounded growth over a 28-day history.
const MAX_RATES = 1000;
const TOKEN_TTL_MS = 60_000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : 0);

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const windows = {};
  for (const [key, win] of Object.entries(s.windows ?? {})) {
    if (!win || typeof win !== "object") continue;
    windows[key] = {
      deficit: num(win.deficit),
      pct: num(win.pct),
      at: num(win.at),
      tokensAtMark: win.tokensAtMark, // keep possible null
      pctAtMark: num(win.pctAtMark),
      rates: Array.isArray(win.rates) ? win.rates.map(num) : [],
      providerIDs: Array.isArray(win.providerIDs) ? win.providerIDs.filter((p) => typeof p === "string") : [],
      ...(win.startedAt != null ? { startedAt: num(win.startedAt) } : {}),
      ...(win.resetsAt != null ? { resetsAt: num(win.resetsAt) } : {}),
    };
  }
  return { windows };
}

/**
 * PURE. The measured tokens-per-pct for one window: the tokens this window's
 * providers consumed since the mark, divided by the pct movement since the
 * mark. Returns `null` when the denominator is below
 * MIN_TOKENS_PER_PCT_SAMPLE (5 pct-points) or when the numerator isn't a
 * positive measured number — a `null` here means NO pacing pressure at all
 * (fail-open, never a guess).
 *
 * @param {string} key the "<provider>:<kind>" window key
 * @param {object} args
 * @param {number|null} args.ledgerTokensSince current cumulative token total for
 *   the window's providerIDs (from the injected ledger reader)
 * @param {object} args.state the persisted pacing state ({ windows })
 * @returns {number|null}
 */
export function tokensPerPct(key, { ledgerTokensSince, state } = {}) {
  const win = state?.windows?.[key];
  if (!win) return null;
  const deltaPct = num(win.pct) - num(win.pctAtMark);
  if (!(deltaPct >= MIN_TOKENS_PER_PCT_SAMPLE)) return null;
  if (!isNum(ledgerTokensSince) || !isNum(win.tokensAtMark)) return null;
  const tokensSinceMark = ledgerTokensSince - win.tokensAtMark;
  if (!(tokensSinceMark > 0)) return null;
  return tokensSinceMark / deltaPct;
}

/**
 * The pacing state. Injected I/O: `load()` returns the persisted
 * `{ windows }` (or {}), `save(state)` persists it atomically, `now` is the
 * clock (number or zero-arg fn). `ledgerTokens` is an async loader returning
 * `{ byProvider: { "<providerID>": total } }` or null, memoised behind a short
 * TTL so routing decisions don't hammer the DB.
 *
 * Returns { observe, pressureFor, tokensPerPct, snapshot }:
 *   observe(snapshots) — one window at a time: reset-detect, seed or advance,
 *     refresh the tokens mark, then persist debounced 30s on ONE unref'd timer.
 *   pressureFor(providerID) — the worst-deficit window for that provider →
 *     { lambda, tokensPerPct, deficit, ecoLevel, protection }, or null.
 */
export function createPacingState({ load, save, now, ledgerTokens, tokenTtlMs = TOKEN_TTL_MS } = {}) {
  let state = null;
  let saveTimer = null;
  let tokenCache = null; // { at, byProvider }

  const nowMs = () => (typeof now === "function" ? num(now()) : num(now ?? Date.now()));

  async function ensureLoaded() {
    if (!state && typeof load === "function") state = normalizeState(await load());
    return state ?? (state = { windows: {} });
  }

  async function tokenTotals() {
    if (typeof ledgerTokens !== "function") return null;
    const t = nowMs();
    if (tokenCache && t - tokenCache.at < tokenTtlMs) return tokenCache.byProvider;
    let map = null;
    try {
      const res = await ledgerTokens();
      map = res && typeof res === "object" && res.byProvider ? res.byProvider : null;
    } catch {
      map = null;
    }
    tokenCache = { at: t, byProvider: map ?? {} };
    return tokenCache.byProvider;
  }

  async function sumTokens(providerIDs) {
    const totals = await tokenTotals();
    if (!totals) return null;
    let sum = 0;
    for (const p of Array.isArray(providerIDs) ? providerIDs : []) sum += totals[p] ?? 0;
    return sum;
  }

  function scheduleSave() {
    if (saveTimer || typeof save !== "function") return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!state) return;
      save(state).catch((e) => console.warn("[pacing] save failed:", e?.message ?? e));
    }, SAVE_DEBOUNCE_MS);
    saveTimer?.unref?.();
  }

  async function observeWindow(s, key, { pct, startedAt, resetsAt, at, providerIDs }) {
    const pctNum = isNum(pct) ? pct : 0;
    const prev = s.windows[key];
    const hasPrev = prev && isNum(prev.pct);
    const tokens = await sumTokens(providerIDs);

    // Window RESET: pct dropped back to ~0 (the same -10 boundary rule
    // forecast.mjs uses). Discard the accumulator and re-seed from the closed
    // form so a box that restarts / a window that turns over does not carry a
    // stale queue.
    if (hasPrev && pctNum < prev.pct + RESET_DELTA) {
      s.windows[key] = {
        deficit: seedDeficit({ pct: pctNum, startedAt, resetsAt, now: at }),
        pct: pctNum,
        at,
        tokensAtMark: tokens,
        pctAtMark: pctNum,
        rates: [],
        providerIDs,
        ...(startedAt != null ? { startedAt } : {}),
        ...(resetsAt != null ? { resetsAt } : {}),
      };
      return;
    }

    // First sight of this window: seed from the closed form (never assume
    // Q = 0 on a cold start).
    if (!hasPrev) {
      s.windows[key] = {
        deficit: seedDeficit({ pct: pctNum, startedAt, resetsAt, now: at }),
        pct: pctNum,
        at,
        tokensAtMark: tokens,
        pctAtMark: pctNum,
        rates: [],
        providerIDs,
        ...(startedAt != null ? { startedAt } : {}),
        ...(resetsAt != null ? { resetsAt } : {}),
      };
      return;
    }

    // Advance the accumulator: Q += (pct growth) - drain over the interval.
    // The measured per-hour burn rate (positive delta, not a reset pair) feeds
    // the newsvendor protection distribution.
    const deficit = advanceDeficit({
      prev: prev.deficit,
      pct: pctNum,
      prevPct: prev.pct,
      resetsAt,
      now: at,
      prevNow: prev.at,
    });
    const rates = Array.isArray(prev.rates) ? prev.rates.slice() : [];
    const dpct = pctNum - prev.pct;
    const hours = (at - prev.at) / HOUR_MS;
    if (dpct > 0 && hours > 0) {
      rates.push(dpct / hours);
      if (rates.length > MAX_RATES) rates.splice(0, rates.length - MAX_RATES);
    }
    s.windows[key] = {
      deficit,
      pct: pctNum,
      at,
      tokensAtMark: tokens,
      pctAtMark: pctNum,
      rates,
      providerIDs,
      ...(startedAt != null ? { startedAt } : {}),
      ...(resetsAt != null ? { resetsAt } : {}),
    };
  }

  async function observe(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return;
    const s = await ensureLoaded();
    const t = nowMs();
    for (const snap of snapshots) {
      const providerIDs = Array.isArray(snap.providerIDs) ? snap.providerIDs.slice() : [];
      for (const w of snap.windows ?? []) {
        if (!w || typeof w !== "object") continue;
        await observeWindow(s, `${snap.provider}:${w.kind}`, {
          pct: w.pct,
          startedAt: w.startedAt,
          resetsAt: w.resetsAt,
          at: isNum(snap.fetchedAt) ? snap.fetchedAt : t,
          providerIDs,
        });
      }
    }
    scheduleSave();
  }

  async function pressureFor(providerID) {
    if (typeof providerID !== "string" || providerID === "") return null;
    const s = await ensureLoaded();
    let best = null; // { key, deficit, win }
    for (const [key, win] of Object.entries(s.windows ?? {})) {
      if (!win || !(Array.isArray(win.providerIDs) && win.providerIDs.includes(providerID))) continue;
      if (!best || num(win.deficit) > best.deficit) best = { key, deficit: num(win.deficit), win };
    }
    if (!best) return null;
    const deficit = best.deficit;
    const lambda = shadowPrice(deficit);
    const ledgerTokensSince = await sumTokens(best.win.providerIDs);
    const tpp = tokensPerPct(best.key, { ledgerTokensSince, state: s });
    const hoursUntilReset = isNum(best.win.resetsAt) ? Math.max(0, (best.win.resetsAt - nowMs()) / HOUR_MS) : null;
    const protection = protectionActive({
      rates: best.win.rates,
      hoursUntilReset,
      remainingPct: 100 - num(best.win.pct),
    });
    return { lambda, tokensPerPct: tpp, deficit, ecoLevel: ecoLevel(deficit), protection };
  }

  async function snapshot() {
    return ensureLoaded();
  }

  return { observe, pressureFor, tokensPerPct, snapshot };
}
