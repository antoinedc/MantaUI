// Policy + constraint lookups against manta-server. NEVER on the hot path.
//
// The policy is PER SESSION (a single process-wide slot let parallel sessions
// evict each other and flip a session between trimmed and untrimmed): a fresh
// cached policy (< 60 s) is used as-is; a stale one is used AND refreshed in the
// background; a cold session gets a PROVISIONAL policy (the last one fetched for
// any session, else the observe-only default) with authoritative:false while a
// refresh is fired. Only an authoritative policy can grow or clear the trim set.
// A failed refresh leaves the previous value — fail open.

import { DEFAULT_POLICY, type Policy } from "./mask.ts";
import { authHeaders, CALL_TIMEOUT_MS } from "./server.ts";

export const POLICY_CACHE_MS = 60_000;
export const CONSTRAINT_CACHE_MS = 60_000;
export const MAX_POLICY_SESSIONS = 512;
const MAX_CONSTRAINTS = 20;
const MAX_CONSTRAINT_CHARS = 300;

export interface ServerDeps {
  fetch: typeof fetch;
  base: () => string;
  now?: () => number;
  /** The plugin instance's project directory (lets the server apply the per-repo tuner table). */
  directory?: () => string | undefined;
}

export function createPolicyClient(deps: ServerDeps) {
  const now = deps.now ?? (() => Date.now());
  const policies = new Map<string, { policy: Policy; at: number }>();
  const policyInflight = new Set<string>();
  let lastAny: Policy | null = null;
  let constraintCache: { constraints: string[]; at: number; sessionID: string } | null = null;

  function getJson(path: string): Promise<any> {
    return deps
      .fetch(`${deps.base()}${path}`, { headers: authHeaders(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  function refreshPolicy(sessionID: string): void {
    if (policyInflight.has(sessionID)) return;
    policyInflight.add(sessionID);
    const dir = deps.directory?.();
    const q = `sessionID=${encodeURIComponent(sessionID)}${dir ? `&directory=${encodeURIComponent(dir)}` : ""}`;
    void getJson(`/api/optimizer/policy?${q}`)
      .then((p) => {
        if (p && typeof p === "object") {
          const policy = { ...DEFAULT_POLICY, ...p } as Policy;
          policies.delete(sessionID);
          policies.set(sessionID, { policy, at: now() });
          while (policies.size > MAX_POLICY_SESSIONS) {
            const oldest = policies.keys().next().value;
            if (oldest === undefined) break;
            policies.delete(oldest);
          }
          lastAny = policy;
        }
      })
      .finally(() => policyInflight.delete(sessionID));
  }

  function refreshConstraints(sessionID: string): void {
    void getJson(`/api/optimizer/constraints?sessionID=${encodeURIComponent(sessionID)}`).then((p) => {
      if (p && Array.isArray(p.constraints)) constraintCache = { constraints: p.constraints, at: now(), sessionID };
    });
  }

  return {
    /** The effective policy (never null) and whether it is authoritative for THIS session. */
    resolvePolicy(sessionID: string): { policy: Policy; authoritative: boolean } {
      const cached = policies.get(sessionID);
      if (cached) {
        if (now() - cached.at >= POLICY_CACHE_MS) refreshPolicy(sessionID); // stale → use it, refresh
        return { policy: cached.policy, authoritative: true };
      }
      refreshPolicy(sessionID);
      return { policy: lastAny ?? DEFAULT_POLICY, authoritative: false };
    },

    resolveConstraints(sessionID: string): string[] {
      const cached = constraintCache;
      if (cached && cached.sessionID === sessionID && now() - cached.at < CONSTRAINT_CACHE_MS) return cached.constraints;
      refreshConstraints(sessionID);
      return cached && cached.sessionID === sessionID ? cached.constraints : [];
    },

    /** Fire-and-forget (contract C2: report v3). */
    reportCounterfactual(sessionID: string, body: Record<string, unknown>): void {
      void deps
        .fetch(`${deps.base()}/api/optimizer/counterfactual`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ sessionID, ts: now(), ...body }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        })
        .catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Constraint pinning (BET-1346) — DUPLICATED from src/shared/constraintPin.mjs.
// ---------------------------------------------------------------------------

export function parseConstraints(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    let s = line.trim();
    s = s.replace(/^[-\*\+•]\s*/, "");
    s = s.replace(/^(?:\d+[\.\):]|\(\d+\))\s*/, "");
    const cleaned = s.trim();
    if (cleaned === "") continue;
    if (out.length >= MAX_CONSTRAINTS) break;
    const capped = cleaned.length > MAX_CONSTRAINT_CHARS ? cleaned.slice(0, MAX_CONSTRAINT_CHARS) : cleaned;
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
  }
  return out;
}

export function renderConstraintBlock(constraints: string[]): string {
  const list = (constraints ?? []).filter((c) => typeof c === "string" && c.trim() !== "");
  if (list.length === 0) return "";
  return (
    "\n\nStanding instructions from the user, preserved verbatim across compaction:\n" +
    list.map((c) => "- " + c).join("\n")
  );
}
