// claude.mjs — usage adapter for Claude Max/Pro (BET-737).
//
// Reuses the EXISTING credential parser (../claudeAuth.mjs) rather than
// writing a second one. Reads api.anthropic.com/api/oauth/usage for the
// rolling 5-hour session window plus the 7-day weekly window (Pro/Max:
// `seven_day`; Team: the `limits[]` list, incl. model-scoped weeklies).
//
// This endpoint is undocumented/internal, so every field read is defensive
// (optional chaining, no destructuring that throws on a missing parent) — a
// shape change here must only take down this ONE adapter, never the poller.

import { readFile } from "node:fs/promises";
import { CREDENTIALS_PATH, parseCredentials } from "../claudeAuth.mjs";
import { normalizeWindow, usageWindowLabel } from "./normalizeWindow.mjs";
import { httpError } from "./httpError.mjs";
import { isUsageAtLimit } from "../usageStopper.mjs";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// Default I/O — overridable per-call so tests never touch the real
// credentials file or the network.
async function defaultReadCredentials() {
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf-8");
    return parseCredentials(raw);
  } catch {
    return null;
  }
}

// The provider reports a 0-100 percentage (used_percentage or utilization)
// and it is used verbatim, never rescaled.
function pctOf(pool) {
  const v = pool?.used_percentage ?? pool?.utilization;
  return typeof v === "number" ? v : undefined;
}

// Per-model 7d pools ride under either `seven_day_opus`/`seven_day_sonnet` or
// a `7d_opus`/`7d_sonnet` shaped key — never assume either is present.
function extraFor(pool, label) {
  const pct = pctOf(pool);
  if (pct === undefined || !Number.isFinite(pct)) return null;
  return { label, value: `${Math.round(Math.max(0, Math.min(100, pct)))}%` };
}

const WEEKLY_LABEL = usageWindowLabel(7 * 86400);

// Team/Enterprise plans return `seven_day: null` and describe every cap in a
// `limits[]` list instead:
//   {kind, group: "session"|"weekly", percent, resets_at, scope, is_active}
// `scope.model.display_name` names the model a scoped cap applies to; a limit
// with no scope is account-wide. Defensive like everything else here — the
// endpoint is internal and unversioned.
function limitEntries(data) {
  const list = data?.limits;
  return Array.isArray(list) ? list.filter((l) => l && typeof l === "object") : [];
}

function scopeName(limit) {
  const n = limit?.scope?.model?.display_name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

function limitPct(limit) {
  return typeof limit?.percent === "number" ? limit.percent : undefined;
}

// A model-scoped weekly window: kind "weekly_scoped:<name lowercased>" so two
// scoped caps never collide on the poller's per-kind history/pacing keys.
function scopedWeekly(limit) {
  const name = scopeName(limit);
  if (!name) return null;
  return normalizeWindow({
    kind: `weekly_scoped:${name.toLowerCase()}`,
    label: `${WEEKLY_LABEL} · ${name}`,
    pct: limitPct(limit),
    resetsAt: limit.resets_at,
    scope: name,
    active: limit.is_active === false ? false : undefined,
  });
}

export const claudeAdapter = {
  id: "claude",
  providerIDs: ["anthropic"],
  // BET-1400 (§11.2): has plan windows (5h session + 7d weekly) — the reserve
  // math applies and spendable is measured in fraction-of-window units.
  windowed: true,

  async detect({ readCredentials = defaultReadCredentials } = {}) {
    const creds = await readCredentials();
    return typeof creds?.accessToken === "string" && creds.accessToken.length > 0;
  },

  async fetch({ readCredentials = defaultReadCredentials, fetchImpl = fetch } = {}) {
    const creds = await readCredentials();
    const accessToken = creds?.accessToken;
    if (!accessToken) throw new Error("no Claude access token available");

    const res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok) throw httpError(res, "claude usage");
    const data = await res.json();
    // The issue spec (and some docs) describe the pools nested under
    // `rate_limits`; the LIVE endpoint (verified 2026-08) returns them at the
    // response's top level instead (`{five_hour, seven_day, ...}`, no
    // wrapper). Prefer `rate_limits` when present so a future build that adds
    // the wrapper back keeps working with no adapter change.
    const limits = data?.rate_limits ?? data ?? {};

    const entries = limitEntries(data);
    const windows = [];

    // 5h session — `five_hour` on every plan; Team plans also list it in limits[].
    const fiveHour = limits?.five_hour;
    const sessionLimit = entries.find((l) => l.group === "session" || l.kind === "session");
    const session = fiveHour
      ? normalizeWindow({
          kind: "session",
          label: usageWindowLabel(5 * 3600),
          pct: pctOf(fiveHour),
          resetsAt: fiveHour?.resets_at,
        })
      : sessionLimit
        ? normalizeWindow({
            kind: "session",
            label: usageWindowLabel(5 * 3600),
            pct: limitPct(sessionLimit),
            resetsAt: sessionLimit.resets_at,
            active: sessionLimit.is_active === false ? false : undefined,
          })
        : null;
    if (session) windows.push(session);

    // Account-wide weekly — `seven_day` (Pro/Max) or, on Team plans where that
    // is null, an UNSCOPED limits[] entry in group "weekly".
    const sevenDay = limits?.seven_day;
    const weeklyLimit = entries.find((l) => l.group === "weekly" && !scopeName(l));
    const weekly = sevenDay
      ? normalizeWindow({
          kind: "weekly",
          label: WEEKLY_LABEL,
          pct: pctOf(sevenDay),
          resetsAt: sevenDay?.resets_at,
        })
      : weeklyLimit
        ? normalizeWindow({
            kind: "weekly",
            label: WEEKLY_LABEL,
            pct: limitPct(weeklyLimit),
            resetsAt: weeklyLimit.resets_at,
            active: weeklyLimit.is_active === false ? false : undefined,
          })
        : null;
    if (weekly) windows.push(weekly);

    // Model-scoped weeklies, after the account-wide windows so the dial's
    // primary window (windows[0]) is never one of them. Each model once.
    const seenScopes = new Set();
    for (const l of entries) {
      if (l.group !== "weekly" || !scopeName(l)) continue;
      const w = scopedWeekly(l);
      if (!w || seenScopes.has(w.kind)) continue;
      seenScopes.add(w.kind);
      windows.push(w);
    }

    const extras = [];
    const opusExtra = extraFor(limits?.seven_day_opus ?? limits?.["7d_opus"], "Opus (7d)");
    if (opusExtra) extras.push(opusExtra);
    const sonnetExtra = extraFor(limits?.seven_day_sonnet ?? limits?.["7d_sonnet"], "Sonnet (7d)");
    if (sonnetExtra) extras.push(sonnetExtra);

    const exhausted = isUsageAtLimit(windows);

    return {
      provider: "claude",
      kind: "subscription",
      windows,
      ...(exhausted ? { exhausted: true } : {}),
      ...(extras.length > 0 ? { extras } : {}),
    };
  },
};
