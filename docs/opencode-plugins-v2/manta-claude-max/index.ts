// `manta-claude-max` — the OpenCode V2 plugin that makes OpenCode talk to
// Anthropic as Claude Code on the user's Claude Max subscription (no API key),
// and routes each conversation to its Manta account seat. One plugin for both
// jobs, because both are decisions about the same outgoing request.
//
//   M1/R4  provider usable with no API key ........ ctx.provider.transform
//   M5     Claude Code identity in the system prompt  ctx.session.hook("context" | "compaction" | "generate" | "title")
//   M2-M4, M6, seats, refresh, M7 ................... ctx.session.hook("http.request" / "http.response")
//   R1     response un-prefix at SSE event boundaries lib/sse.ts
//   R2     body cloned once, Request rebuilt ......... lib/exchange.ts
//
// Nothing installs this yet — Phase 4 copies the directory into
// $XDG_CONFIG_HOME/opencode/plugins/manta-claude-max/. Refresh is NEVER done
// here: manta-server refreshes seats (`POST /api/accounts/refresh`) and the
// `claude` CLI owns the live login; this plugin only re-reads the files.

import { Plugin } from "@opencode/plugin";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_IDENTITY } from "./lib/body.ts";
import { cliVersion } from "./lib/config.ts";
import { createCredentialReader, liveClaudeCredentialsFile, seatsRootDir } from "./lib/creds.ts";
import { createExchange, createParentLookup } from "./lib/exchange.ts";
import { createSeatResolver, serverBase } from "./lib/seats.ts";

const IDENTITY_HOOK_KINDS = ["context", "compaction", "generate", "title"] as const;

/** Is there any Claude credential on this box (the live login or a seat)? */
function haveClaudeCredentials(): boolean {
  if (existsSync(liveClaudeCredentialsFile())) return true;
  try {
    return readdirSync(join(seatsRootDir(), "claude")).length > 0;
  } catch {
    return false;
  }
}

export default Plugin.define({
  id: "manta.claude-max",
  async setup(ctx: any) {
    const debug = process.env.MANTA_CLAUDE_MAX_DEBUG === "1";
    // Never logs a token — the exchange only ever passes sha12 fingerprints.
    const log = (tag: string, fields: Record<string, unknown>) => {
      if (debug || tag.endsWith("_error")) console.log(`[manta-claude-max] ${tag} ${JSON.stringify(fields)}`);
    };
    log("setup", { cliVersion: cliVersion() });

    // M1/R4 — the Anthropic provider is `activation: "auto"` (active only with an
    // API key / connection). Forcing it enabled makes its models selectable with
    // no key at all (no `apiKey:""` sentinel in config); the http hooks below supply
    // the subscription Bearer. The callback is synchronous and REPLAYED on every
    // registry rebuild, so the (cheap, sync) credentials check re-runs each time:
    // a login that appears after startup is picked up without a restart.
    await ctx.provider.transform((editor: any) => {
      if (!editor.get("anthropic") || !haveClaudeCredentials()) return;
      editor.update("anthropic", (provider: any) => {
        provider.activation = "enabled";
      });
    });

    // M5 — Claude Code identity as system[0] on EVERY kind of Anthropic request
    // (a hook registered for one kind does not run for the others).
    for (const kind of IDENTITY_HOOK_KINDS) {
      await ctx.session.hook(
        kind,
        (event: any) => {
          try {
            const system = event.system;
            if (!Array.isArray(system)) return;
            if (system.some((e: any) => typeof e?.text === "string" && e.text.includes(SYSTEM_IDENTITY))) return;
            system.unshift({ type: "text", text: SYSTEM_IDENTITY });
          } catch (e) {
            log("context_error", { msg: String((e as any)?.message ?? e) });
          }
        },
        { providerID: "anthropic" },
      );
    }

    const exchange = createExchange({
      resolver: createSeatResolver({ fetch: (...args) => fetch(...args), base: () => serverBase() }),
      credentials: createCredentialReader(),
      parentOf: createParentLookup((sessionID) => ctx.session.get({ sessionID })),
      send: (request) => fetch(request),
      log,
    });

    for (const providerID of ["anthropic", "openai"]) {
      await ctx.session.hook("http.request", (event: any) => exchange.onRequest(event), { providerID });
      await ctx.session.hook("http.response", (event: any) => exchange.onResponse(event), { providerID });
    }
  },
});
