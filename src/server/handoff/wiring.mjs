// handoff/wiring.mjs — assembles the production auto-handoff engine from the
// box's real clients. index.mjs only calls this once; everything it needs
// arrives as a parameter (and lazily where the dependency is built later in
// the boot, e.g. the delegate engine), so nothing here runs at import time.

import { createHandoffEngine } from "./engine.mjs";
import { extractEditedFiles, extractLastReply, extractTestRun, extractTodos, extractUserRequests, lastUserMessageAt } from "./text.mjs";
import { normalizeMode } from "./policy.mjs";
import { selectLatestTokenUsage } from "../../shared/streamInterpretation.mjs";
import { parseGitStatus } from "../peers.mjs";

/**
 * @param {object} p
 * @param {any} p.oc  src/server/opencode.mjs namespace
 * @param {any} p.tmux  src/server/tmux.mjs namespace
 * @param {() => Promise<any>} p.configGet
 * @param {(evt: any) => void} p.publish  the bus
 * @param {() => any} p.delegate  lazy: the delegate engine
 * @param {(sid: string) => Promise<boolean>} p.isCtoConversationSession
 * @param {(providerID: string, modelID: string) => number|null} p.contextLimitFor
 * @param {{ snapshot: () => Promise<any> }} p.constraints  the optimizer constraint store
 * @param {(sid: string, opts?: { messages?: any[] }) => Promise<void>} p.extractConstraints
 * @param {() => any} p.loadState  synchronous read of handoffs.json
 * @param {(snapshot: any) => Promise<void>} p.saveState
 *
 * Cold-cache handoff (spec B1/B5) — four OPTIONAL params, each with a safe default so an
 * un-updated caller (and every test) keeps today's behaviour (everything written by the session itself):
 *
 * @param {() => Promise<{ providerID: string, modelID: string, name?: string, limit: { context: number } } | null>} [p.summaryModel]
 *   The Summary model ONLY when its status is `ok`, else null. NEVER the session's own model
 *   (that fallback exists for titles / extraction only). `limit.context` is the model's real context
 *   window in tokens (it sizes the condensed transcript). Default: `async () => null`.
 * @param {() => Promise<number>} [p.cacheTtlMs]
 *   The effective prompt-cache TTL in ms (the optimizer summary's measured TTL, falling back to
 *   COMPACT_CACHE_TTL_FALLBACK_MS). Default: `async () => 300000`.
 * @param {(model: { providerID: string, modelID: string }, instruction: string, opts: { signal?: AbortSignal }) => Promise<string>} [p.generateCheap]
 *   A STRICT session-less one-shot (`generateTextStrict`): resolves the reply text, THROWS on any failure
 *   (timeout, refusal, empty provider answer) with `err.status` set when the provider gave one. It must
 *   never choose a model of its own. Default: throws.
 * @param {(model: { providerID: string, modelID: string }) => Promise<{
 *     listPrice: ReturnType<typeof import("../optimizer/prices.mjs").resolveListPrice>,
 *     oneHour: boolean,
 *     subscription: boolean,
 *   } | null>} [p.listPrice]
 *   Prices the SESSION'S model for the Rewrite estimate: `oneHour = isOneHourModel(...)` evaluated once,
 *   `listPrice = resolveListPrice({ ...model, config, catalog, model, oneHour })` (so it carries `cacheWrite1h`
 *   exactly when `oneHour`), `subscription` = the model's provider is a connected SUBSCRIPTION provider
 *   (the estimate is then a "list-price equivalent"). null / `listPrice: null` = unpriced → the estimate shows
 *   tokens only. The engine applies `priceForPrompt(listPrice, estTokens)` itself. Default: `async () => null`.
 */
export function createProductionHandoff(p) {
  const { oc, tmux } = p;
  const engine = createHandoffEngine({
    load: p.loadState,
    save: p.saveState,
    getMode: async () => normalizeMode((await p.configGet())?.handoffMode),
    publish: p.publish,
    contextLimitFor: p.contextLimitFor,
    oc: {
      readSession: (sid) => oc.readSession(sid),
      createSession: (input) => oc.createSession(input),
      deleteSession: (sid) => oc.deleteSessionRaw(sid),
      generate: (sid, prompt, opts) => oc.generateInSession(sid, prompt, opts),
      sendPrompt: (args) => oc.sendPrompt(args),
      postSynthetic: (sid, body) => oc.postSynthetic(sid, body),
      listInbox: (sid) => oc.listInbox(sid),
      getMessage: (sid, mid) => oc.getMessage(sid, mid),
      listActive: () => oc.listActiveSessionIds(),
      interrupt: (sid) => oc.abortSession(sid),
    },
    tmux: {
      findWindow: (sid) => tmux.findWindowBySessionId(sid),
      findWindowByName: (name) => tmux.findWindowByName(name),
      restamp: (sessionName, windowIndex, sid) => tmux.restampSessionId(sessionName, windowIndex, sid),
      createStampedWindow: (a) => tmux.createStampedChatWindow(a),
      rename: (a) => tmux.renameWindow(a),
    },
    ownership: {
      // §6.3: jobs the predecessor started follow it; a running job whose OWN session was replaced keeps running there.
      repoint: async (pred, succ) => {
        await p.delegate().repointSessions({ fromSessionId: pred, toSessionId: succ });
      },
    },
    // A handoff on a job's session that did not commit: the deferred settlement runs now.
    onPendingSendCleared: () => {
      void p.delegate().reconcileV2?.().catch((e) => console.warn("[handoff] re-settling deferred jobs failed:", e?.message ?? e));
    },
    onHeldFailure: ({ target, item, error }) => {
      console.warn(`[handoff] a held message (${item.id}) was refused by ${target}:`, error?.message ?? error);
      p.publish({ kind: "handoff", payload: { heldFailure: { sessionId: target, messageId: item.id, message: "A message sent during a handoff couldn't be delivered." } } });
    },
    cacheTtlMs: p.cacheTtlMs,
    summaryModel: p.summaryModel,
    generateCheap: p.generateCheap,
    listPrice: p.listPrice,
    isExcluded: (sid) => p.isCtoConversationSession(sid),
    runningJobOwner: (sid) => p.delegate().runningJobOwner(sid),
    jobStatusOf: (sid) => p.delegate().jobStatusOf(sid),
    isJobSession: (sid) => p.delegate().isRunningJobSession(sid),
    gather: {
      measureContext: async (sid) => {
        const found = selectLatestTokenUsage(await oc.listMessages(sid, { slim: true }));
        if (!found) return null;
        const t = found.tokens;
        return { tokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0), providerID: found.providerID, modelID: found.modelID };
      },
      // The transcript, read once per produced text by the engine and handed to the condenser and to `facts`.
      messages: (sid) => oc.listMessages(sid),
      facts: async (sid, { messages: given } = {}) => {
        const rs = await oc.readSession(sid);
        const session = rs.state === "found" ? rs.session : null;
        const messages = Array.isArray(given) ? given : await oc.listMessages(sid);
        const facts = {
          predecessor: { id: sid, title: session?.title || "" },
          editedFiles: extractEditedFiles(messages),
          todos: extractTodos(messages),
          testRun: extractTestRun(messages),
          lastReply: extractLastReply(messages),
          userRequests: extractUserRequests(messages),
          git: null,
          constraints: null,
        };
        const dir = session?.directory;
        if (dir) {
          try {
            const [{ stdout }, branch] = await Promise.all([tmux.run("git", ["-C", dir, "status", "--porcelain"]), oc.getVcsBranch(dir)]);
            facts.git = { branch: branch ?? null, changes: parseGitStatus(stdout).files };
          } catch {
            facts.git = null;
          }
        }
        try {
          // Standing instructions are INFERRED; re-extract first when they predate the last user message.
          let entry = (await p.constraints.snapshot())?.sessions?.[sid];
          if (!entry || (typeof entry.at === "number" && entry.at < lastUserMessageAt(messages))) {
            await p.extractConstraints(sid, { messages });
            entry = (await p.constraints.snapshot())?.sessions?.[sid];
          }
          if (entry?.constraints?.length) facts.constraints = { items: entry.constraints, at: entry.at ?? null };
        } catch {
          facts.constraints = null;
        }
        return facts;
      },
    },
  });
  return engine;
}
