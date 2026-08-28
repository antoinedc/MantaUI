// codex.mjs — usage adapter for Codex / ChatGPT Plus-Pro (BET-737).
//
// Credential: opencode's OWN OpenAI sign-in — `~/.local/share/opencode/
// auth.json`, the `openai` entry, oauth `access` token. This adapter is a
// READER of opencode's connection, not a second place to enter it — no config
// field, no secrets-store entry, no new credentials file (`readProviderOAuthToken`
// in opencode.mjs resolves the store path and returns "" on any read/parse
// failure or a missing/wrong-type entry — never throws). opencode is the only
// thing on the box that runs models, so an OpenAI session opencode does not
// hold is not usage worth reporting; opencode also owns the token's refresh
// lifecycle (an expired token simply 401s and the poller's carry-forward
// handles it). If the user isn't signed into OpenAI through opencode,
// `detect()` is simply false: a silent, correct inactive state, not an error.
//
// Endpoint schema is public in the codex repo — the most stable of the three
// adapters — but every field read stays defensive anyway, for consistency
// with its siblings and in case the box is running an older/newer codex CLI.

import { readProviderOAuthToken } from "../opencode.mjs";
import { normalizeWindow, usageWindowLabel } from "./normalizeWindow.mjs";
import { httpError } from "./httpError.mjs";
import { isUsageAtLimit } from "../usageStopper.mjs";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PROVIDER_ID = "openai";

// Default I/O — overridable per-call so tests never touch opencode's real
// auth store or the network.
function defaultReadToken() {
  return readProviderOAuthToken(PROVIDER_ID);
}

function titleCase(s) {
  if (typeof s !== "string" || !s) return undefined;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Prefer `reset_at`; if only `reset_after_seconds` is present, compute
// `now + seconds*1000`.
function resolveResetsAt(win, nowMs) {
  if (win?.reset_at != null) return win.reset_at;
  const secs = Number(win?.reset_after_seconds);
  if (Number.isFinite(secs)) return nowMs + secs * 1000;
  return undefined;
}

export const codexAdapter = {
  id: "codex",
  providerIDs: ["openai"],
  // BET-1400 (§11.2): has plan windows (session + weekly) — reserve applies.
  windowed: true,

  async detect({ readToken = defaultReadToken } = {}) {
    const token = await readToken();
    return typeof token === "string" && token.length > 0;
  },

  async fetch({ readToken = defaultReadToken, fetchImpl = fetch, now = () => Date.now() } = {}) {
    const token = await readToken();
    if (!token) throw new Error("no Codex access token available");

    const res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw httpError(res, "codex usage");
    const data = await res.json();
    const rl = data?.rate_limit ?? {};
    const nowMs = now();

    const windows = [];
    const primary = rl?.primary_window;
    const session = primary
      ? normalizeWindow({
          kind: "session",
          label: usageWindowLabel(primary?.limit_window_seconds),
          pct: primary?.used_percent,
          resetsAt: resolveResetsAt(primary, nowMs),
        })
      : null;
    if (session) windows.push(session);

    const secondary = rl?.secondary_window;
    const weekly = secondary
      ? normalizeWindow({
          kind: "weekly",
          label: usageWindowLabel(secondary?.limit_window_seconds),
          pct: secondary?.used_percent,
          resetsAt: resolveResetsAt(secondary, nowMs),
        })
      : null;
    if (weekly) windows.push(weekly);

    const extras = [];
    const balance = data?.credits?.balance;
    if (balance !== undefined && balance !== null) {
      extras.push({ label: "Credits balance", value: String(balance) });
    }
    const balanceNum = typeof balance === "number" && Number.isFinite(balance) ? balance : undefined;

    const planLabel = titleCase(data?.plan_type);

    // The provider will refuse work now: any window is at/over its limit, or
    // credits are spent/overdrawn (balance ≤ 0).
    const exhausted = isUsageAtLimit(windows) || (balanceNum !== undefined && balanceNum <= 0);

    return {
      provider: "codex",
      kind: "subscription",
      ...(planLabel ? { planLabel } : {}),
      windows,
      ...(balanceNum !== undefined ? { balance: balanceNum } : {}),
      ...(exhausted ? { exhausted: true } : {}),
      ...(extras.length > 0 ? { extras } : {}),
    };
  },
};
