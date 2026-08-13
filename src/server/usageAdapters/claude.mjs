// claude.mjs — usage adapter for Claude Max/Pro (BET-737).
//
// Reuses the EXISTING credential parser (../claudeAuth.mjs) rather than
// writing a second one. Reads api.anthropic.com/api/oauth/usage for the
// rolling 5-hour session window plus the 7-day weekly window.
//
// This endpoint is undocumented/internal, so every field read is defensive
// (optional chaining, no destructuring that throws on a missing parent) — a
// shape change here must only take down this ONE adapter, never the poller.

import { readFile } from "node:fs/promises";
import { CREDENTIALS_PATH, parseCredentials } from "../claudeAuth.mjs";
import { normalizeWindow } from "./normalizeWindow.mjs";

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

// Anthropic sometimes sends `used_percentage` (0-100) directly and always
// sends `utilization` too — prefer `used_percentage` when both are present.
// `utilization` has been observed BOTH as a 0-1 fraction (the documented
// shape) and, live against api.anthropic.com/api/oauth/usage as of 2026-08,
// already as a 0-100 percentage (e.g. `"utilization":58.0`) — a fraction can
// never exceed 1.0, so treat anything > 1 as already a percentage rather than
// re-scaling it into the 5800% range.
function pctOf(pool) {
  if (typeof pool?.used_percentage === "number") return pool.used_percentage;
  if (typeof pool?.utilization === "number") {
    return pool.utilization > 1 ? pool.utilization : pool.utilization * 100;
  }
  return undefined;
}

// Per-model 7d pools ride under either `seven_day_opus`/`seven_day_sonnet` or
// a `7d_opus`/`7d_sonnet` shaped key — never assume either is present.
function extraFor(pool, label) {
  const pct = pctOf(pool);
  if (pct === undefined || !Number.isFinite(pct)) return null;
  return { label, value: `${Math.round(Math.max(0, Math.min(100, pct)))}%` };
}

export const claudeAdapter = {
  id: "claude",
  providerIDs: ["anthropic"],

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
    if (!res.ok) {
      const err = new Error(`claude usage: HTTP ${res.status}`);
      err.status = res.status;
      if (res.status === 429) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      }
      throw err;
    }
    const data = await res.json();
    // The issue spec (and some docs) describe the pools nested under
    // `rate_limits`; the LIVE endpoint (verified 2026-08) returns them at the
    // response's top level instead (`{five_hour, seven_day, ...}`, no
    // wrapper). Prefer `rate_limits` when present so a future build that adds
    // the wrapper back keeps working with no adapter change.
    const limits = data?.rate_limits ?? data ?? {};

    const windows = [];
    const fiveHour = limits?.five_hour;
    const session = fiveHour
      ? normalizeWindow({
          kind: "session",
          label: "Session (5h)",
          pct: pctOf(fiveHour),
          resetsAt: fiveHour?.resets_at,
        })
      : null;
    if (session) windows.push(session);

    const sevenDay = limits?.seven_day;
    const weekly = sevenDay
      ? normalizeWindow({
          kind: "weekly",
          label: "Weekly",
          pct: pctOf(sevenDay),
          resetsAt: sevenDay?.resets_at,
        })
      : null;
    if (weekly) windows.push(weekly);

    const extras = [];
    const opusExtra = extraFor(limits?.seven_day_opus ?? limits?.["7d_opus"], "Opus (7d)");
    if (opusExtra) extras.push(opusExtra);
    const sonnetExtra = extraFor(limits?.seven_day_sonnet ?? limits?.["7d_sonnet"], "Sonnet (7d)");
    if (sonnetExtra) extras.push(sonnetExtra);

    return {
      provider: "claude",
      windows,
      ...(extras.length > 0 ? { extras } : {}),
    };
  },
};
