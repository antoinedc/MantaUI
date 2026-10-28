// accountsRowState.mjs — what each Accounts row says and offers, computed on the
// box (WS11 D4 / audit K2). Moved verbatim from the desktop's `describeAccountState`
// + row assembly, so both clients render the same words from `accounts:row-states`.
//
// Precedence of the state text: on-fire health outranks a reading (a window pct is
// not the story while the provider refuses work); an externally-owned credential
// names its owner; a reading outranks a balance; then credential absence; then
// "No usage data" — a reading is real or absent, never a zero.

import { providerStateLabel } from "../shared/providerHealthLabel.mjs";
import { formatEndpointStateLine, worstEndpoint } from "./accountsCopy.mjs";

export const LOW_BALANCE_DOLLARS = 5;

const formatDollars = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

/**
 * "under pace" / "on pace" / "over pace" from how fast a window is consumed against
 * how far through it we are; null for a window with no timing (a pace invented from
 * a percentage alone is a false claim).
 */
export function usagePace(w, nowMs) {
  if (typeof w?.startedAt === "number" && typeof w.resetsAt === "number" && w.resetsAt > w.startedAt) {
    const elapsed = (nowMs - w.startedAt) / (w.resetsAt - w.startedAt);
    if (elapsed > 0) {
      const ratio = w.pct / 100 / elapsed;
      if (ratio < 0.9) return "under pace";
      if (ratio > 1.1) return "over pace";
      return "on pace";
    }
  }
  return null;
}

/** The first window of a usage snapshot as `{label, pct, pace}`, or null. */
export function subscriptionReading(snap, nowMs) {
  if (!snap || !Array.isArray(snap.windows) || snap.windows.length === 0) return null;
  const w = snap.windows[0];
  if (typeof w?.pct !== "number") return null;
  return { label: w.label ?? "", pct: w.pct, pace: usagePace(w, nowMs) };
}

/** The health states a row cares about; any other (or none) is "no health data", never "healthy". */
function normalizeHealth(entry) {
  const st = entry?.state === "out-of-credit" || entry?.state === "rate-limited" || entry?.state === "failing" ? entry.state : undefined;
  if (!st) return { health: "unknown" };
  return { health: st, retryInMinutes: st === "rate-limited" && typeof entry.retryInMs === "number" ? Math.max(1, Math.ceil(entry.retryInMs / 60000)) : undefined };
}

/** `{text, tone}` for one row model `{health, retryInMinutes, connected, managedExternally, managedBy, reading, balance}`. */
export function describeAccountState(r) {
  if (r.health === "out-of-credit") return { text: providerStateLabel("out-of-credit") ?? "Out of credit", tone: "danger" };
  if (r.health === "rate-limited") {
    const base = providerStateLabel("rate-limited") ?? "Rate limited";
    return { text: r.retryInMinutes ? `${base} · retry in ${r.retryInMinutes}m` : base, tone: "warn" };
  }
  if (r.health === "failing") return { text: providerStateLabel("failing") ?? "Not responding", tone: "warn" };
  if (r.connected && r.managedExternally && r.managedBy) {
    return { text: `connected · signed in with ${r.managedBy}`, tone: "ok" };
  }
  if (r.reading) {
    const pct = r.reading.pct;
    const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
    const text = r.reading.pace ? `${r.reading.label} ${pct}% · ${r.reading.pace}` : `${r.reading.label} ${pct}%`;
    return { text, tone };
  }
  if (typeof r.balance === "number" && Number.isFinite(r.balance)) {
    return { text: `$${formatDollars(r.balance)} remaining`, tone: r.balance < LOW_BALANCE_DOLLARS ? "danger" : "ok" };
  }
  if (!r.connected) return { text: "Not connected", tone: "quiet" };
  return { text: "No usage data", tone: "quiet" };
}

/**
 * The one control a row offers by precedence: out of credit → retry; a credential
 * owned elsewhere → none; connected → disconnect; else connect. (A custom
 * endpoint's refresh / remove are its own class's controls, not decided here.)
 */
export function accountRowControl(r) {
  if (r.health === "out-of-credit") return "retry";
  if (r.className === "Custom") return "none";
  if (r.connected && r.managedExternally) return "none";
  return r.connected ? "disconnect" : "connect";
}

/**
 * Build every row's `{text, tone, control, registerLine}` from the same reads the
 * desktop made: subscription statuses, usage snapshots, provider health, the
 * custom endpoints (`opencode:get-providers`) and the endpoint register.
 * @returns {{ rows: Record<string, {text, tone, control, registerLine}> }}
 */
export function buildAccountRowStates({ statuses = [], providers = [], snapshots = [], health = null, nowMs }) {
  const rows = {};
  const healthProviders = health?.providers ?? {};
  const endpoints = health?.endpoints ?? {};
  const subIds = new Set(statuses.map((s) => s.id));

  for (const s of statuses) {
    const snap = snapshots.find((u) => u.providerIDs?.includes(s.id));
    const { health: h, retryInMinutes } = normalizeHealth(healthProviders[s.id]);
    // A reader reporting "exhausted" refuses work — surfaced as out-of-credit even
    // before providerHealth sees a 402.
    const effective = snap?.exhausted === true ? "out-of-credit" : h;
    const model = {
      className: "Supported",
      connected: s.connected,
      managedExternally: s.managedExternally,
      managedBy: s.managedBy,
      reading: subscriptionReading(snap, nowMs),
      balance: typeof snap?.balance === "number" ? snap.balance : null,
      health: effective,
      retryInMinutes,
    };
    const state = describeAccountState(model);
    rows[s.id] = { text: state.text, tone: state.tone, control: accountRowControl(model), registerLine: null };
  }

  for (const ep of providers) {
    if (subIds.has(ep.id)) continue;
    const { health: h, retryInMinutes } = normalizeHealth(healthProviders[ep.id]);
    const model = { className: "Custom", connected: ep.hasApiKey, reading: null, balance: null, health: h, retryInMinutes };
    const state = describeAccountState(model);
    const enabled = Array.isArray(ep.enabledModels) ? ep.enabledModels.length : 0;
    const worst = worstEndpoint(endpoints, ep.id);
    let registerLine = null;
    if (worst) registerLine = formatEndpointStateLine(worst.entry, nowMs);
    else if (enabled > 0) registerLine = "Unproven";
    rows[ep.id] = { text: state.text, tone: state.tone, control: accountRowControl(model), registerLine };
  }
  return { rows };
}
