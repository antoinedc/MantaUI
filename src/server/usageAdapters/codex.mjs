// codex.mjs — usage adapter for Codex / ChatGPT Plus-Pro (BET-737).
//
// Credential: ~/.codex/auth.json, `tokens.access_token` (falls back to a
// top-level `access_token`). Path resolved via homedir() — never hardcode
// `/home/...` (matches claudeAuth.mjs's own CREDENTIALS_PATH convention).
//
// Endpoint schema is public in the codex repo — the most stable of the three
// adapters — but every field read stays defensive anyway, for consistency
// with its siblings and in case the box is running an older/newer codex CLI.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeWindow } from "./normalizeWindow.mjs";
import { httpError } from "./httpError.mjs";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function authPath() {
  return join(homedir(), ".codex", "auth.json");
}

// Default I/O — overridable per-call so tests never touch the real
// credentials file or the network.
async function defaultReadToken() {
  try {
    const raw = await readFile(authPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const token = parsed?.tokens?.access_token ?? parsed?.access_token;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
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
          label: "Session (5h)",
          pct: primary?.used_percent,
          resetsAt: resolveResetsAt(primary, nowMs),
        })
      : null;
    if (session) windows.push(session);

    const secondary = rl?.secondary_window;
    const weekly = secondary
      ? normalizeWindow({
          kind: "weekly",
          label: "Weekly",
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

    const planLabel = titleCase(data?.plan_type);

    return {
      provider: "codex",
      ...(planLabel ? { planLabel } : {}),
      windows,
      ...(extras.length > 0 ? { extras } : {}),
    };
  },
};
