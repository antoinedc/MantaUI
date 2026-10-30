// optimizer/constraints.mjs — the stored result of extracting a conversation's
// standing instructions before it is compacted (Optimizer P2.4, BET-1346,
// Part B, extraction + storage half).
//
// The optimizer plugin's `experimental.session.compacting` hook reads these
// (via GET /api/optimizer/constraints?sessionID=) and appends them to the
// compaction prompt so the user's standing instructions survive a background
// compaction. The instructions must be extracted from the FULL history BEFORE
// the compaction rewrites it, so extraction runs at scheduler time (wired in
// index.mjs, just before oc.compactSession) and the result is stored here,
// keyed by the session being compacted.
//
// This module is the STORE + the pure text-joining helpers. Injected I/O
// (`load`/`save` for statePath("optimizer-constraints.json"), an injected
// clock) keep it testable; the model call is `createConstraintExtractor` below
// (Summary model, else the session's own, over a condensed transcript).
//
// State shape: { sessions: { "<sessionID>": { constraints: string[], at } } }

import { parseConstraints, CONSTRAINT_EXTRACT_PROMPT } from "../../shared/constraintPin.mjs";
import { condenseTranscript, condenseBudget } from "../handoff/condense.mjs";
import { estimateTokens } from "../handoff/text.mjs";

export { CONSTRAINT_EXTRACT_PROMPT };

/**
 * PURE. Serialize a session's message list into a flat transcript text the
 * cheap extraction model can read. Handles the opencode message/part shape,
 * skipping empty/structural parts. Garbage in → "". Never throws.
 *
 * @param {unknown} messages
 * @returns {string}
 */
export function transcriptText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of list) {
    const role = (m?.info?.role) === "user" ? "user" : (m?.info?.role === "assistant" ? "assistant" : null);
    if (role === null) continue;
    const textParts = [];
    for (const p of m?.parts ?? []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim() !== "") {
        textParts.push(p.text.trim());
      }
    }
    if (textParts.length === 0) continue;
    out.push(`${role}: ${textParts.join("\n")}`);
  }
  return out.join("\n\n");
}

/**
 * PURE. Build the instruction handed to the cheap extraction agent: the
 * verbatim extraction prompt plus the conversation it must read.
 *
 * @param {string} transcript
 * @returns {string}
 */
export function extractionInstruction(transcript) {
  const t = typeof transcript === "string" ? transcript : "";
  return t.trim() === "" ? CONSTRAINT_EXTRACT_PROMPT : `${CONSTRAINT_EXTRACT_PROMPT}\n\nConversation:\n${t}`;
}

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const sessions = {};
  for (const [sid, e] of Object.entries(s.sessions ?? {})) {
    if (!e || typeof e !== "object") continue;
    sessions[sid] = {
      constraints: Array.isArray(e.constraints) ? e.constraints.filter((c) => typeof c === "string") : [],
      ...(typeof e.at === "number" && Number.isFinite(e.at) ? { at: e.at } : {}),
    };
  }
  return { sessions };
}

/**
 * The constraint store. Injected I/O: `load` returns the persisted
 * `{ sessions }` (via readJsonSync on statePath), `save` persists it (via the
 * shared writeJsonAtomic), `now` is the clock. `parse` is the pure
 * parseConstraints (defaulted, injectable for clarity).
 *
 * Returns { get, set, snapshot }:
 *   get(sessionID) -> string[]  ([] when absent)
 *   set(sessionID, constraints, at?) -> { constraints, at }, persisted
 */
export function createConstraintStore({ load, save, now = Date.now, parse = parseConstraints } = {}) {
  let cache = null;

  const nowMs = () => (typeof now === "function" ? (now() ?? 0) : (now ?? Date.now()));

  function ensure() {
    if (!cache) cache = normalizeState(typeof load === "function" ? load() : {});
    return cache;
  }

  async function get(sessionID) {
    if (typeof sessionID !== "string" || sessionID === "") return [];
    const s = ensure();
    return s.sessions?.[sessionID]?.constraints ?? [];
  }

  async function set(sessionID, constraints, at) {
    if (typeof sessionID !== "string" || sessionID === "") return { constraints: [], at };
    const s = ensure();
    const entry = {
      constraints: (Array.isArray(constraints) ? constraints : []).filter((c) => typeof c === "string"),
      at: typeof at === "number" && Number.isFinite(at) ? at : nowMs(),
    };
    s.sessions[sessionID] = entry;
    if (typeof save === "function") {
      try {
        await save(s);
      } catch (e) {
        console.warn("[optimizer] constraints save failed:", e?.message ?? e);
      }
    }
    return entry;
  }

  async function snapshot() {
    return ensure();
  }

  return { get, set, snapshot };
}

/** The most condensed-transcript tokens an extraction reads (cold-cache handoff spec A5). */
export const EXTRACT_MAX_TOKENS = 24_000;

/**
 * Extract a session's standing instructions and store them.
 *
 * The writer is whatever `resolveWriter(sessionId)` returns (the Summary model,
 * else the session's own last-used model); with none, nothing is asked. The
 * input is the CONDENSED transcript — tool output gone, at most
 * min(24k, the writer's budget) tokens — and the call is STRICT: when anything
 * fails the PREVIOUS constraints stay (an empty list is only ever stored for a
 * reply that actually came back). Best-effort: never throws.
 *
 * @param {object} d
 * @param {(sessionId: string) => Promise<{ providerID: string, modelID: string }|null>} d.resolveWriter
 * @param {(sessionId: string) => Promise<any[]>} d.listMessages  used when the caller passes no messages
 * @param {(providerID: string, modelID: string) => number|null} d.contextLimitFor
 * @param {(a: { instruction: string, model: { providerID: string, modelID: string } }) => Promise<string>} d.generate  strict: throws on failure
 * @param {{ set: (sessionId: string, constraints: string[]) => Promise<any> }} d.store
 * @param {(msg: string, err?: any) => void} [d.warn]
 * @returns {(sessionId: string, opts?: { messages?: any[] }) => Promise<void>}
 */
export function createConstraintExtractor({ resolveWriter, listMessages, contextLimitFor, generate, store, warn = (m, e) => console.warn(m, e ?? "") }) {
  return async function extractAndStoreConstraints(sessionID, { messages } = {}) {
    if (typeof sessionID !== "string" || sessionID === "") return;
    try {
      const writer = await resolveWriter(sessionID);
      if (!writer) {
        warn(`[optimizer] constraint extraction skipped session=${sessionID}: no model to write it`);
        return;
      }
      const msgs = Array.isArray(messages) ? messages : await listMessages(sessionID);
      const limit = contextLimitFor(writer.providerID, writer.modelID);
      const fits = typeof limit === "number" && limit > 0 ? condenseBudget({ contextLimit: limit, promptOverhead: estimateTokens(CONSTRAINT_EXTRACT_PROMPT) }) : EXTRACT_MAX_TOKENS;
      const { text } = condenseTranscript(msgs, { maxTokens: Math.min(EXTRACT_MAX_TOKENS, fits) });
      const raw = await generate({ instruction: extractionInstruction(text), model: { providerID: writer.providerID, modelID: writer.modelID } });
      await store.set(sessionID, parseConstraints(raw));
    } catch (e) {
      warn(`[optimizer] constraint extraction failed session=${sessionID} (previous constraints kept):`, e?.message ?? e);
    }
  };
}
