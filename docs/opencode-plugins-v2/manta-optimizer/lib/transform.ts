// One `context`-hook request, end to end: PLAN on the untouched input → COMMIT
// (synchronous write, before the request is sent) → APPLY the committed map →
// record the boundary + report. Mirrors transformMessages in the V1 plugin
// (docs/opencode-plugins/manta-optimizer.ts); only the message shape (lib/mask.ts
// adaptV2) and the source of the model / completion times differ.
// Spec: docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md §4.3.

import { adaptV2, applyReal, type Policy } from "./mask.ts";
import { appliedStats, boundaryOf, ONE_HOUR_CACHE_MS, planRequest, resolveRates } from "./plan.ts";
import { SESSION_ID_RE, saveStateSync, warnOnce, type createTrimStore } from "./trims.ts";
import type { createPricesClient } from "./prices.ts";

export interface TransformDeps {
  policies: { resolvePolicy(sessionID: string): { policy: Policy; authoritative: boolean } };
  prices: ReturnType<typeof createPricesClient>;
  trims: ReturnType<typeof createTrimStore>;
  report(sessionID: string, body: Record<string, unknown>): void;
  now?: () => number;
}

/** The model whose tokens are priced (BET-1370) — both ids or nothing. */
export function resolveModel(event: any): { providerID?: string; modelID?: string } {
  const m = event?.model;
  if (typeof m?.providerID === "string" && m.providerID && typeof m?.id === "string" && m.id) {
    return { providerID: m.providerID, modelID: m.id };
  }
  return {};
}

const nonEmpty = (m: Record<string, unknown> | null | undefined): boolean => !!m && Object.keys(m).length > 0;

export function transformContext(deps: TransformDeps, event: any): void {
  const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
  const sessionID: string = typeof event?.sessionID === "string" ? event.sessionID : "";
  // Bail-out: no session, or an id that is not a safe file name.
  if (!sessionID || !SESSION_ID_RE.test(sessionID)) return;
  const nowFn = deps.now ?? Date.now;
  const now = nowFn();
  deps.prices.refreshIfDue();
  const entry = deps.trims.get(sessionID);
  const { policy, authoritative } = deps.policies.resolvePolicy(sessionID); // never a network call on the hot path
  const adapted = adaptV2(messages);
  const model = resolveModel(event);
  const record = deps.prices.lookup(model);
  // 1-hour write pricing ONLY for a model Manta configures for the 1-hour cache:
  // the server sends `cacheWrite1h` on a record only for such models, and the
  // policy's cacheTtlMs is then > 5 min. If the TTL is 1h but the record has no 1h
  // price, the 5-minute rates are used (the plugin cannot know whether that model
  // is Anthropic-SDK; the server already withheld the 1h price).
  const oneHour =
    typeof policy.cacheTtlMs === "number" &&
    policy.cacheTtlMs > ONE_HOUR_CACHE_MS &&
    !!record &&
    typeof record.cacheWrite1h === "number" &&
    record.cacheWrite1h > 0;
  const fetchedAt = deps.prices.fetchedAt;
  const rates = record
    ? (promptTokens: number) => {
        const r = resolveRates(record, promptTokens, { oneHour });
        return r ? { ...r, source: record.source, fetchedAt } : null;
      }
    : null;

  const prev = entry.state;
  const counted = { ...prev, reqCount: prev.reqCount + 1 };

  // 1. PLAN on the untouched input.
  let plan: any = null;
  try {
    plan = planRequest({
      messages: adapted,
      policy,
      authoritative,
      rates,
      state: counted,
      boundary: entry.boundary,
      model,
      now: nowFn,
      lastCompletedMs: 0, // V2: never "known dead"
    });
  } catch (e: any) {
    warnOnce("plan", `planner failed — replaying the committed trims only: ${e?.message ?? e}`);
  }

  // 2. COMMIT (synchronous, before the request is sent). A failed write keeps the
  //    previous committed state and reports no change.
  let change = "none";
  let shadowChange = "none";
  let rewarmTokens = 0;
  let shadowRewarmTokens = 0;
  let committedOk = true;
  if (!plan) {
    entry.state = counted;
  } else if (plan.dirty) {
    if (saveStateSync(sessionID, plan.nextState)) {
      entry.state = plan.nextState;
      change = plan.decision;
      shadowChange = plan.shadow.decision;
      rewarmTokens = plan.rewarmTokens;
      shadowRewarmTokens = plan.shadowRewarmTokens;
    } else {
      committedOk = false;
      entry.state = { ...counted, lastModel: plan.nextState.lastModel };
    }
  } else {
    entry.state = plan.nextState; // counters only; the maps are unchanged
  }

  // 3. APPLY the committed `real` map. If this throws, send the request untouched.
  let applied = { tokens: 0, parts: 0 };
  try {
    applyReal(adapted, entry.state.real);
    applied = committedOk && plan ? plan.applied : appliedStats(adapted, entry.state.real);
  } catch (e: any) {
    warnOnce("apply", `applying trims failed — request sent untouched: ${e?.message ?? e}`);
  }
  const shadowStats = committedOk && plan ? plan.shadow : appliedStats(adapted, entry.state.shadow);

  // 4. RECORD the boundary (on the untouched input) and REPORT.
  entry.boundary = boundaryOf(adapted);
  deps.trims.touch(sessionID, entry, now);
  deps.trims.prune(now);

  if (nonEmpty(entry.state.real) || nonEmpty(entry.state.shadow) || change !== "none" || shadowChange !== "none") {
    deps.report(sessionID, {
      v: 3,
      ...(model.providerID && model.modelID ? { providerID: model.providerID, modelID: model.modelID } : {}),
      ...(plan?.rates
        ? {
            rates: {
              cacheRead: plan.rates.cacheRead,
              cacheWrite: plan.rates.cacheWrite,
              source: plan.rates.source,
              fetchedAt: plan.rates.fetchedAt,
            },
          }
        : {}),
      applied: { trimmedTokens: applied.tokens, trimmedParts: applied.parts },
      shadow: { trimmedTokens: shadowStats.tokens ?? 0, trimmedParts: shadowStats.parts ?? 0 },
      change,
      shadowChange,
      rewarmTokens,
      shadowRewarmTokens,
    });
  }
}
