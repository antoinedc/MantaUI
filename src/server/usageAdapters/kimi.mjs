// kimi.mjs — usage adapter for Kimi For Coding (BET-737).
//
// Credential: the SAME key the user already pasted into the Kimi connect
// card. That flow (`opencode:provider-auth` "key" action, src/server/
// rpc.mjs) writes it into opencode's OWN auth store via `PUT /auth/{id}`
// (src/server/opencode.mjs `setProviderApiKey`) as
// `{"kimi-for-coding":{"type":"api","key":"…"}}`. This adapter is a READER
// of that connection, not a second place to enter it — no config field, no
// secrets-store entry, no new file (`readProviderApiKey`, also in
// opencode.mjs, resolves the store path and returns "" on any read/parse
// failure or a missing entry — never throws). If the user hasn't connected
// Kimi, `detect()` is simply false: a silent, correct inactive state, not an
// error.
//
// Absolutes ARE available here (unlike claude/codex) — `used`/`limit` are
// populated so the popover can show "139 / 200 requests"; normalizeWindow
// derives `pct` from them. Counts may arrive as strings, and some plans send
// only `remaining` — normalizeWindow already handles both, so the raw fields
// are passed straight through.
//
// providerIDs: `"kimi-for-coding"` is the EXACT opencode providerID this repo
// uses for Kimi everywhere else (src/server/subscriptionProviders.mjs,
// src/renderer/chatUtils.ts AUTH_PROVIDER_LABELS) — not "moonshot" / "kimi".

import { readProviderApiKey } from "../opencode.mjs";
import { normalizeWindow, usageWindowLabel } from "./normalizeWindow.mjs";
import { httpError } from "./httpError.mjs";

const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const PROVIDER_ID = "kimi-for-coding";

// Default I/O — overridable per-call so tests never touch opencode's real
// auth store or the network.
async function defaultReadKey() {
  return readProviderApiKey(PROVIDER_ID);
}

// `limits[]` entries carry a `window.duration` + `window.timeUnit` pair —
// normalize to minutes so a provider-side unit change (e.g. "hour" instead of
// "minute") degrades to "no session window found" instead of throwing.
function minutesOf(window) {
  const duration = Number(window?.duration);
  if (!Number.isFinite(duration)) return null;
  const unit = String(window?.timeUnit ?? "").toLowerCase();
  if (unit.startsWith("min")) return duration;
  if (unit.startsWith("hour") || unit.startsWith("hr")) return duration * 60;
  if (unit.startsWith("day")) return duration * 60 * 24;
  return null;
}

function windowFromDetail(detail, kind, label) {
  if (!detail || typeof detail !== "object") return null;
  return normalizeWindow({
    kind,
    label,
    used: detail.used,
    limit: detail.limit,
    remaining: detail.remaining,
    resetsAt: detail.resetTime,
  });
}

export const kimiAdapter = {
  id: "kimi",
  providerIDs: [PROVIDER_ID],

  async detect({ readKey = defaultReadKey } = {}) {
    const key = await readKey();
    return typeof key === "string" && key.length > 0;
  },

  async fetch({ readKey = defaultReadKey, fetchImpl = fetch } = {}) {
    const key = await readKey();
    if (!key) throw new Error("no Kimi Code API key available");

    const res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw httpError(res, "kimi usage");
    const data = await res.json();

    // Windows are emitted SHORTEST-FIRST (session before weekly) — the
    // ordering contract on UsageSnapshot.windows: the composer dial reports
    // windows[0] and must never show a weekly number as "right now".
    const windows = [];

    // `limits[]` entries carry `window` + `detail`; the 300-minute (5h) entry
    // is the session window.
    const limitsArr = Array.isArray(data?.limits) ? data.limits : [];
    const sessionEntry = limitsArr.find((l) => minutesOf(l?.window) === 300);
    const session = windowFromDetail(sessionEntry?.detail, "session", usageWindowLabel(300 * 60));
    if (session) windows.push(session);

    // `usage` is the WEEKLY window.
    const weekly = windowFromDetail(data?.usage, "weekly", usageWindowLabel(7 * 86400));
    if (weekly) windows.push(weekly);

    // No planLabel on this endpoint — it needs a cookie-auth web API, out of
    // scope per the issue spec.
    return { provider: "kimi", windows };
  },
};
