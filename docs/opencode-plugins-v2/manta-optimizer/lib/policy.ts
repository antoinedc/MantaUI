// Policy + constraint lookups against manta-server. NEVER on the hot path: a
// fresh cached value (same session, < 60 s) is used as-is; otherwise the stale
// value (or the observe-only default / []) is used AND a background refresh is
// fired that is never awaited. A failed refresh leaves the previous value; a
// cold cache means "observe-only" / no constraints — fail open.

import { DEFAULT_POLICY, type Policy } from "./mask.ts";
import { authHeaders, CALL_TIMEOUT_MS } from "./server.ts";

export const POLICY_CACHE_MS = 60_000;
export const CONSTRAINT_CACHE_MS = 60_000;
const MAX_CONSTRAINTS = 20;
const MAX_CONSTRAINT_CHARS = 300;

export interface ServerDeps {
  fetch: typeof fetch;
  base: () => string;
  now?: () => number;
}

export function createPolicyClient(deps: ServerDeps) {
  const now = deps.now ?? (() => Date.now());
  let policyCache: { policy: Policy; at: number; sessionID: string } | null = null;
  let constraintCache: { constraints: string[]; at: number; sessionID: string } | null = null;

  function getJson(path: string): Promise<any> {
    return deps
      .fetch(`${deps.base()}${path}`, { headers: authHeaders(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  function refreshPolicy(sessionID: string): void {
    void getJson(`/api/optimizer/policy?sessionID=${encodeURIComponent(sessionID)}`).then((p) => {
      if (p && typeof p === "object") policyCache = { policy: { ...DEFAULT_POLICY, ...p }, at: now(), sessionID };
    });
  }

  function refreshConstraints(sessionID: string): void {
    void getJson(`/api/optimizer/constraints?sessionID=${encodeURIComponent(sessionID)}`).then((p) => {
      if (p && Array.isArray(p.constraints)) constraintCache = { constraints: p.constraints, at: now(), sessionID };
    });
  }

  return {
    /** The effective policy (never null — observe-only when unknown). */
    resolvePolicy(sessionID: string): Policy {
      const cached = policyCache;
      if (cached && cached.sessionID === sessionID && now() - cached.at < POLICY_CACHE_MS) return cached.policy;
      refreshPolicy(sessionID);
      return cached && cached.sessionID === sessionID ? cached.policy : DEFAULT_POLICY;
    },

    resolveConstraints(sessionID: string): string[] {
      const cached = constraintCache;
      if (cached && cached.sessionID === sessionID && now() - cached.at < CONSTRAINT_CACHE_MS) return cached.constraints;
      refreshConstraints(sessionID);
      return cached && cached.sessionID === sessionID ? cached.constraints : [];
    },

    /** Fire-and-forget; the payload is exactly V1's. */
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
