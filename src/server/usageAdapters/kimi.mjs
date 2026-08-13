// kimi.mjs — usage adapter for Kimi For Coding (BET-737).
//
// Credential: the Kimi Code API key, read from the EXISTING secrets store
// (../secrets.mjs, shared scope, key "KIMI_CODE_API_KEY") — not a new config
// field or a new file. Endpoint is undocumented; every field read stays
// defensive.
//
// Absolutes ARE available here (unlike claude/codex) — `used`/`limit` are
// populated so the popover can show "139 / 200 requests"; normalizeWindow
// derives `pct` from them. Counts may arrive as strings, and some plans send
// only `remaining` — normalizeWindow already handles both, so the raw fields
// are passed straight through.
//
// providerIDs: this repo's own provider registry (src/server/
// subscriptionProviders.mjs, src/renderer/chatUtils.ts AUTH_PROVIDER_LABELS)
// uses opencode providerID "kimi-for-coding" for this provider — that's what
// BET-USAGE-B will actually see as the active model's providerID, so it's
// listed first. The alternate ids the original spec named ("moonshot",
// "moonshotai", "kimi") are kept too in case a future opencode release routes
// Kimi under one of them — harmless extras that just never match today.

import { loadSecrets, resolveSecret } from "../secrets.mjs";
import { normalizeWindow } from "./normalizeWindow.mjs";

const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const SECRET_KEY = "KIMI_CODE_API_KEY";

// Default I/O — overridable per-call so tests never touch the real secrets
// store or the network.
async function defaultReadKey() {
  try {
    const secrets = loadSecrets();
    const entry = resolveSecret(secrets, SECRET_KEY, null, null);
    return typeof entry?.value === "string" ? entry.value : null;
  } catch {
    return null;
  }
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
  providerIDs: ["kimi-for-coding", "moonshot", "moonshotai", "kimi"],

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
    if (!res.ok) {
      const err = new Error(`kimi usage: HTTP ${res.status}`);
      err.status = res.status;
      if (res.status === 429) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      }
      throw err;
    }
    const data = await res.json();

    const windows = [];
    // `usage` is the WEEKLY window.
    const weekly = windowFromDetail(data?.usage, "weekly", "Weekly");
    if (weekly) windows.push(weekly);

    // `limits[]` entries carry `window` + `detail`; the 300-minute (5h) entry
    // is the session window.
    const limitsArr = Array.isArray(data?.limits) ? data.limits : [];
    const sessionEntry = limitsArr.find((l) => minutesOf(l?.window) === 300);
    const session = windowFromDetail(sessionEntry?.detail, "session", "Session (5h)");
    if (session) windows.push(session);

    // No planLabel on this endpoint — it needs a cookie-auth web API, out of
    // scope per the issue spec.
    return { provider: "kimi", windows };
  },
};
