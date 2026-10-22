// `manta-optimizer` — the OpenCode V2 twin of docs/opencode-plugins/manta-optimizer.ts.
// "Sticky trims, priced per model": spec docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md.
//
//   experimental.chat.messages.transform → ctx.session.hook("context")     (trim)
//   experimental.session.compacting      → ctx.session.hook("compaction")  (constraint pinning)
//
// A trim is STICKY (the exact replacement text per tool-call id is stored in a
// per-session C4 file and replayed byte-for-byte) and the trim set only GROWS when
// re-caching pays for the model in use (lib/plan.ts). With the switch OFF it is
// observe-only: it grows a simulated shadow map for the dashboard but never
// mutates the request. Fail-open everywhere — any throw hands the request on
// unmodified. Nothing installs it yet (Phase 4).

import { Plugin } from "@opencode/plugin";
import { createPolicyClient, renderConstraintBlock } from "./lib/policy.ts";
import { createPricesClient } from "./lib/prices.ts";
import { serverBase } from "./lib/server.ts";
import { transformContext } from "./lib/transform.ts";
import { createTrimStore } from "./lib/trims.ts";

export { resolveModel } from "./lib/transform.ts";

export default Plugin.define({
  id: "manta.optimizer",
  async setup(ctx: any) {
    // Plugins are instantiated PER LOCATION, so `ctx.location.directory` is this
    // instance's project directory (verified on 2.0.30). Fallback for a
    // location-less context: the session record's `location.directory`, cached per
    // session. It lets the server apply the per-repo tuner table to the policy.
    const sessionDirs = new Map<string, string>();
    let currentSession = "";
    const directory = (): string | undefined => {
      const d = ctx?.location?.directory;
      if (typeof d === "string" && d !== "") return d;
      return currentSession ? sessionDirs.get(currentSession) : undefined;
    };
    const learnDirectory = (sessionID: string) => {
      if (typeof ctx?.location?.directory === "string" && ctx.location.directory !== "") return;
      if (sessionDirs.has(sessionID)) return;
      sessionDirs.set(sessionID, ""); // one lookup per session
      void Promise.resolve()
        .then(() => ctx.session.get({ sessionID }))
        .then((r: any) => {
          const d = (r?.data ?? r)?.location?.directory;
          if (typeof d === "string" && d !== "") sessionDirs.set(sessionID, d);
        })
        .catch(() => {});
    };

    const base = () => serverBase();
    const server = createPolicyClient({ fetch: (...args) => fetch(...args), base, directory });
    const prices = createPricesClient({ fetch: (...args) => fetch(...args), base });
    const trims = createTrimStore();
    prices.refreshIfDue(); // warm the price map before the first request

    await ctx.session.hook("context", (event: any) => {
      try {
        const sessionID: string = typeof event?.sessionID === "string" ? event.sessionID : "";
        if (sessionID) {
          currentSession = sessionID;
          learnDirectory(sessionID);
        }
        transformContext(
          { policies: server, prices, trims, report: (sid, body) => server.reportCounterfactual(sid, body) },
          event,
        );
      } catch {
        /* fail open — a trimming bug must degrade to "we did not trim", never a broken turn */
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
