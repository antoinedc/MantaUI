// `manta-optimizer` — the OpenCode V2 twin of docs/opencode-plugins/manta-optimizer.ts.
//
//   experimental.chat.messages.transform → ctx.session.hook("context")     (mask)
//   experimental.session.compacting      → ctx.session.hook("compaction")  (constraint pinning)
//
// With the switch OFF (the fail-open default) it is OBSERVE-ONLY: it computes and
// reports the counterfactual but never mutates the history. Fail-open everywhere —
// any throw hands the request on unmodified. Nothing installs it yet (Phase 4).

import { Plugin } from "@opencode/plugin";
import { applyMask, planMask } from "./lib/mask.ts";
import { createPolicyClient, renderConstraintBlock } from "./lib/policy.ts";
import { serverBase } from "./lib/server.ts";

/** The model whose tokens are masked, for per-model savings pricing (BET-1370). */
export function resolveModel(event: any): { providerID?: string; modelID?: string } {
  const m = event?.model;
  if (typeof m?.providerID === "string" && m.providerID && typeof m?.id === "string" && m.id) {
    return { providerID: m.providerID, modelID: m.id };
  }
  return {};
}

export default Plugin.define({
  id: "manta.optimizer",
  async setup(ctx: any) {
    const server = createPolicyClient({ fetch: (...args) => fetch(...args), base: () => serverBase() });
    // The lowered messages carry no timestamps. The best "when did this session
    // last finish a step" the plugin can know is the previous time it saw one —
    // seeded (in the background, once per session) from the session's own clock.
    const lastSeen = new Map<string, number>();
    const seeded = new Set<string>();
    const seed = (sessionID: string) => {
      if (seeded.has(sessionID)) return;
      seeded.add(sessionID);
      void Promise.resolve()
        .then(() => ctx.session.get({ sessionID }))
        .then((r: any) => {
          const t = (r?.data ?? r)?.time?.updated;
          if (typeof t === "number" && !lastSeen.has(sessionID)) lastSeen.set(sessionID, t);
        })
        .catch(() => {});
    };

    await ctx.session.hook("context", (event: any) => {
      try {
        const messages: any[] = event?.messages ?? [];
        const sessionID: string = typeof event?.sessionID === "string" ? event.sessionID : "";
        if (!sessionID) return; // bail-out 1: no session
        seed(sessionID);

        const policy = server.resolvePolicy(sessionID); // never a network call on the hot path
        const plan = planMask({ messages, policy, now: Date.now, lastActivityMs: lastSeen.get(sessionID) });
        lastSeen.set(sessionID, Date.now());
        if (plan.bailed) return; // too many parts / over budget: history untouched

        const mode = policy.enabled === true ? "act" : "observe";
        let applied = false;
        if (policy.enabled === true && plan.apply) {
          applyMask(plan.eligible, policy.placeholderFormat);
          applied = true;
        }
        // Report only when BOTH identity fields resolve — a bare modelID is not a usable key.
        if (plan.maskedTokens > 0) {
          server.reportCounterfactual(sessionID, {
            maskedTokens: plan.maskedTokens,
            maskedParts: plan.maskedParts,
            rewarmTokens: plan.rewarmTokens,
            applied,
            mode,
            ...resolveModel(event),
          });
        }
      } catch {
        /* fail open — a masking bug must degrade to "we did not trim", never a broken turn */
      }
    });

    // GUARDRAIL (BET-1346): constraint injection ships behind
    // scripts/optimizer/retention-eval.mjs (30/30, run by hand, not part of npm test).
    // V1 appended the block to the compaction PROMPT; V2 appends its own summary
    // prompt AFTER hooks run, so the block rides as an extra system entry instead —
    // append ONLY, never replace what OpenCode would have said.
    await ctx.session.hook("compaction", (event: any) => {
      try {
        const sessionID: string = typeof event?.sessionID === "string" ? event.sessionID : "";
        if (!sessionID || !Array.isArray(event?.system)) return;
        const constraints = server.resolveConstraints(sessionID);
        const block = renderConstraintBlock(constraints).trim();
        if (block !== "") event.system.push({ type: "text", text: block });
      } catch {
        /* fail open — hand the request through untouched */
      }
    });
  },
});
