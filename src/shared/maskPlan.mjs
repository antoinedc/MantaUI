// maskPlan.mjs — PURE "sticky trims, priced per model" planner for the opencode
// optimizer plugins (spec docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md,
// §3.1 / §4 / C5). This is the shared, testable copy of the logic that the two
// plugins INLINE (they live under ~/.config/opencode/ and cannot resolve this
// repo):
//   • docs/opencode-plugins/manta-optimizer.ts            (V1 — between the
//     `<<maskPlan:begin>>` / `<<maskPlan:end>>` markers)
//   • docs/opencode-plugins-v2/manta-optimizer/lib/plan.ts (V2 — verbatim, minus
//     adaptV1, which V2 replaces with its own adapter in lib/mask.ts)
// Keep all three in sync: a parity test runs the same fixtures through each.
//
// PURE: no node:* imports, no Date.now() unless defaulted from `now`, no I/O —
// the clock arrives as an injected `now`, prices and policy as arguments.
//
// SHAPE OF THE PROBLEM (why this replaced the per-request masker): rewriting a
// tool output deep in the history invalidates the provider's prompt cache from
// that point on. The old masker recomputed its mask set on every request, so each
// new tool call moved the eligibility line and the history changed at an early
// position every time — never a cache hit. Here a trim is STICKY: once a tool
// call id is trimmed its exact replacement text is stored and replayed
// byte-for-byte, and the set only GROWS when the gate says the re-cache pays for
// the model in use.
//
// The planner reads normalized UNITS produced by a per-shape adapter:
//   { id, kind: "tool"|"text", tool?, input?, text, msgIndex, ref? }
//   kind "tool" = a COMPLETED tool call's output (text = the output; id = the
//   tool-call id shared by the call and its result, null when the shape has none
//   → never trimmed). kind "text" = everything else that adds tokens to the
//   prompt. `ref` is an opaque handle the plugin uses to apply replacements.

export const PLACEHOLDER_ARGS_MAX = 200;

// A trimmed part's replacement always starts with this by default — the
// idempotency marker. (The authoritative "already trimmed" check is the stored
// map; the prefix is the backstop for a history that already carries one.)
export const PLACEHOLDER_PREFIX = "[manta: trimmed";

export const DEFAULT_PLACEHOLDER_FORMAT =
  "[manta: trimmed — re-run `{tool}` with {args} to see this again]";

export const DEFAULT_MARGIN = 1.5;
// §4.4: expected remaining requests ≈ min(N, 200) — a labelled heuristic.
export const MAX_EXPECTED_REQUESTS = 200;
// §4.5: entries per map; at cap we stop growing (a live replacement is never evicted).
export const MAX_MAP_ENTRIES = 5000;
export const ONE_HOUR_CACHE_MS = 300_000; // above this TTL a model is "1h-configured"

// Estimated token count from string length only (O(1), no copy).
export function estTokens(s) {
  return typeof s === "string" ? Math.ceil(s.length / 4) : 0;
}

const finiteOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const posOr = (v, d) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// Tokens of a tool call's INPUT (JSON length / 4). Cached on the unit.
export function estInputTokens(input) {
  if (input === undefined || input === null) return 0;
  try {
    const s = JSON.stringify(input);
    return typeof s === "string" ? Math.ceil(s.length / 4) : 0;
  } catch {
    return 0; // circular — never let an estimate throw
  }
}
function inTok(u) {
  if (u.inTok === undefined) u.inTok = estInputTokens(u.input);
  return u.inTok;
}

// Render the placeholder that replaces a trimmed tool's output. Names the tool
// and a truncated digest of its arguments SO THE MODEL CAN RE-RUN IT.
export function renderPlaceholder(tool, input, format) {
  const fmt =
    typeof format === "string" && format.length > 0 ? format : DEFAULT_PLACEHOLDER_FORMAT;
  let args;
  try {
    args = JSON.stringify(input ?? {});
  } catch {
    args = "{}"; // circular input — never let a render throw
  }
  if (typeof args !== "string") args = "{}";
  if (args.length > PLACEHOLDER_ARGS_MAX) {
    args = args.slice(0, PLACEHOLDER_ARGS_MAX) + "…";
  }
  return fmt
    .replaceAll("{tool}", typeof tool === "string" && tool ? tool : "tool")
    .replaceAll("{args}", args);
}

// The maximum `time.completed` over assistant messages (V1 shape); 0 when none.
export function lastAssistantCompleted(messages) {
  let max = 0;
  for (const m of messages ?? []) {
    if (m?.info?.role !== "assistant") continue;
    const c = m?.info?.time?.completed;
    if (typeof c === "number" && Number.isFinite(c) && c > max) max = c;
  }
  return max;
}

// Total part count across all messages (V1 shape).
export function countParts(messages) {
  let n = 0;
  for (const m of messages ?? []) n += m?.parts?.length ?? 0;
  return n;
}

// ---------------------------------------------------------------------------
// Prices (§3.1) — resolveRates
// ---------------------------------------------------------------------------

const pickPos = (...vals) => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return undefined;
};
const fld = (rec, camel, snake) => pickPos(rec?.[camel], rec?.[snake]);

// Tiers, ascending-agnostic: [{min, rec}]. `tiers[]` (when non-empty) is
// authoritative and `context_over_200k` is then ignored; only without tiers is
// context_over_200k used, as a single tier with size 200000. Accepts both the
// normalized C1 shape ({minPromptTokens, …}) and the raw models.dev shape
// ({tier:{type:"context",size}, …}).
function tiersOf(record) {
  const out = [];
  if (Array.isArray(record.tiers) && record.tiers.length > 0) {
    for (const t of record.tiers) {
      const min =
        typeof t?.minPromptTokens === "number"
          ? t.minPromptTokens
          : typeof t?.tier?.size === "number"
            ? t.tier.size
            : NaN;
      if (Number.isFinite(min)) out.push({ min, rec: t });
    }
  } else if (record.context_over_200k && typeof record.context_over_200k === "object") {
    out.push({ min: 200_000, rec: record.context_over_200k });
  }
  return out;
}

/**
 * PURE. Resolve the $/Mtok cache rates for one request.
 *   record       — a price record ({input, cacheRead, cacheWrite?, cacheWrite1h?,
 *                  tiers?}); the C1 payload is already normalized, raw models.dev
 *                  field names are tolerated.
 *   promptTokens — the estimated prompt size; a tier applies when it is STRICTLY
 *                  greater than the tier's size; the highest applying tier wins;
 *                  a field missing from a tier inherits the base record's.
 *   opts.oneHour — price the write at the 1-hour tariff. ONLY then, and only when
 *                  the record carries a 1-hour write price; otherwise the model
 *                  is UNPRICED (null). Never inferred from "2 × input".
 * A record is usable iff input > 0 and cacheRead > 0; a missing/zero cacheWrite
 * means "no write premium" (cacheWrite := input).
 * Returns {cacheRead, cacheWrite} or null (unpriced).
 */
export function resolveRates(record, promptTokens, opts) {
  if (!record || typeof record !== "object") return null;
  const oneHour = !!(opts && opts.oneHour);
  let input = fld(record, "input", "input");
  let cacheRead = fld(record, "cacheRead", "cache_read");
  let cacheWrite = fld(record, "cacheWrite", "cache_write");
  let cacheWrite1h = fld(record, "cacheWrite1h", "cache_write_1h");
  if (!input || !cacheRead) return null; // the base record must itself be usable
  const pt = finiteOr(promptTokens, 0);
  let best = null;
  for (const t of tiersOf(record)) {
    if (pt > t.min && (best === null || t.min > best.min)) best = t;
  }
  if (best) {
    input = fld(best.rec, "input", "input") ?? input;
    cacheRead = fld(best.rec, "cacheRead", "cache_read") ?? cacheRead;
    cacheWrite = fld(best.rec, "cacheWrite", "cache_write") ?? cacheWrite;
    cacheWrite1h = fld(best.rec, "cacheWrite1h", "cache_write_1h") ?? cacheWrite1h;
  }
  if (oneHour) {
    if (!cacheWrite1h) return null; // 1h-configured but no 1h price → unpriced
    return { cacheRead, cacheWrite: cacheWrite1h };
  }
  return { cacheRead, cacheWrite: cacheWrite ?? input };
}

// ---------------------------------------------------------------------------
// V1 adapter
// ---------------------------------------------------------------------------

/**
 * Normalize an opencode V1 transform history ([{info, parts}]) into units.
 *   id        — `part.callID` of a COMPLETED tool part (no id → null → never trimmed)
 *   messageKeyAt(i) — `info.id` of message i (the boundary key)
 *   assistantCount — completed assistant messages (one per model call) that are
 *                    not compaction summaries (the "N" of the gate)
 *   lastCompletedMs — newest assistant `time.completed` (cache-freshness signal)
 * `ref` is the original part, for the plugin's replay.
 */
export function adaptV1(messages) {
  const units = [];
  let partCount = 0;
  let assistantCount = 0;
  let lastCompletedMs = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (let m = 0; m < list.length; m++) {
    const info = list[m]?.info;
    if (info?.role === "assistant") {
      const c = info?.time?.completed;
      if (typeof c === "number" && Number.isFinite(c)) {
        if (c > lastCompletedMs) lastCompletedMs = c;
        if (!info.summary) assistantCount++;
      }
    }
    const parts = list[m]?.parts ?? [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      partCount++;
      const isTool = part?.type === "tool";
      if (isTool && part?.state?.status === "completed") {
        const out = typeof part.state.output === "string" ? part.state.output : "";
        const callID =
          typeof part.callID === "string" && part.callID !== "" && part.callID !== "__proto__"
            ? part.callID
            : null;
        units.push({
          id: callID,
          kind: "tool",
          tool: typeof part.tool === "string" && part.tool ? part.tool : "tool",
          input: part.state.input,
          text: out,
          msgIndex: m,
          ref: part,
        });
      } else {
        units.push({
          id: null,
          kind: "text",
          input: isTool ? part?.state?.input : undefined,
          text: typeof part?.text === "string" ? part.text : "",
          msgIndex: m,
        });
      }
    }
  }
  return {
    units,
    messageCount: list.length,
    messageKeyAt: (i) => {
      const k = list[i]?.info?.id;
      return typeof k === "string" && k !== "" ? k : null;
    },
    partCount,
    assistantCount,
    lastCompletedMs,
  };
}

/** The boundary to record AFTER a request: the history just sent (untouched input). */
export function boundaryOf(adapted) {
  const n = adapted?.messageCount ?? 0;
  if (n <= 0) return null;
  const key = adapted.messageKeyAt(n - 1);
  return key == null ? null : { messageCount: n, lastMessageKey: key };
}

/** Net tokens removed from the request by `map` (original − replacement), over units present. */
export function appliedStats(adapted, map) {
  let tokens = 0;
  let parts = 0;
  if (!map) return { tokens, parts };
  for (const u of adapted.units) {
    if (u.kind === "tool" && u.id !== null && hasOwn(map, u.id)) {
      tokens += estTokens(u.text) - estTokens(map[u.id]);
      parts++;
    }
  }
  return { tokens, parts };
}

// ---------------------------------------------------------------------------
// planRequest (§4.3 / §4.4)
// ---------------------------------------------------------------------------

/**
 * PURE. Plan one request on the UNTOUCHED input.
 *   messages      — the adapter's result (adaptV1(...) or the V2 adapter)
 *   policy        — {enabled, maskAfterUses, protectTailTokens, batchTokens,
 *                    margin?, placeholderFormat, cacheTtlMs, maxTransformParts,
 *                    transformBudgetMs}
 *   authoritative — the policy came from the server for THIS session (false =
 *                    provisional: replay only, never grows or clears)
 *   rates         — {cacheRead, cacheWrite, …} | null (unpriced) | (promptTokens)
 *                    => the same; a function lets the tier follow the prompt size
 *   state         — the committed C4 object, with `reqCount` ALREADY incremented
 *                    for this request by the plugin
 *   boundary      — {messageCount, lastMessageKey} recorded after the previous request
 *   model         — {providerID, modelID}
 *   now           — injected clock; lastCompletedMs — V1 only (V2 passes 0: never "known dead")
 * Returns { decision, add, R, T, N, breakEven, reason, applied, shadow, rates,
 *           rewarmTokens, shadowRewarmTokens, cacheDead, boundaryValid, compacted,
 *           dirty, nextState }.
 * `nextState` is what to persist when `dirty` (the maps changed); its counters
 * (reqCount, cooldowns, lastModel) are valid in memory either way.
 */
export function planRequest(a) {
  const adapted = a.messages;
  const units = adapted.units;
  const policy = a.policy || {};
  const state = a.state || {};
  const now = typeof a.now === "function" ? a.now : Date.now;
  const authoritative = a.authoritative === true;
  const mode = !authoritative ? "prov" : policy.enabled === true ? "enabled" : "disabled";
  const reqCount = finiteOr(state.reqCount, 0);
  const real = state.real && typeof state.real === "object" ? state.real : {};
  const shadow = state.shadow && typeof state.shadow === "object" ? state.shadow : {};
  const model = a.model || {};
  const modelKey = model.providerID && model.modelID ? model.providerID + "/" + model.modelID : null;
  // A different model than the previous request has no cache yet: the boundary is
  // useless for pricing and the cache is KNOWN dead — the cheapest moment to trim.
  const switched =
    modelKey !== null && typeof state.lastModel === "string" && state.lastModel !== modelKey;

  const b = a.boundary;
  const bCount = b && Number.isInteger(b.messageCount) ? b.messageCount : 0;
  const compacted = bCount > 0 && adapted.messageCount < bCount;
  const boundaryValid =
    bCount > 0 &&
    !compacted &&
    !switched &&
    b.lastMessageKey != null &&
    adapted.messageKeyAt(bCount - 1) === b.lastMessageKey;

  // A detected compaction resets both cooldowns to "now".
  const cool = compacted ? reqCount : finiteOr(state.nextGrowthAllowedAt, 0);
  const shadowCool = compacted ? reqCount : finiteOr(state.shadowNextGrowthAllowedAt, 0);

  const lastCompleted = finiteOr(a.lastCompletedMs, 0);
  const ttl = posOr(policy.cacheTtlMs, 300_000);
  const cacheDead = switched || (lastCompleted > 0 && now() - lastCompleted > ttl);

  const batch = posOr(policy.batchTokens, 20_000);
  const margin = posOr(policy.margin, DEFAULT_MARGIN);
  const maxParts = posOr(policy.maxTransformParts, 4_000);
  const budgetMs = posOr(policy.transformBudgetMs, 25);
  const protectTail = finiteOr(policy.protectTailTokens, 40_000);
  const maskAfter = finiteOr(policy.maskAfterUses, 12);
  const N = adapted.assistantCount;

  // Estimated prompt size (text + tool inputs) of what is actually sent — memoized;
  // only needed to pick a price tier.
  let promptMemo = -1;
  const promptTokens = () => {
    if (promptMemo < 0) {
      let t = 0;
      const withInputs = adapted.partCount <= maxParts; // huge histories: text only (cheap)
      for (let k = 0; k < units.length; k++) {
        const u = units[k];
        t += estTokens(u.kind === "tool" && u.id !== null && hasOwn(real, u.id) ? real[u.id] : u.text);
        if (withInputs) t += inTok(u);
      }
      promptMemo = t;
    }
    return promptMemo;
  };
  let ratesMemo;
  let ratesDone = false;
  const getRates = () => {
    if (!ratesDone) {
      ratesDone = true;
      const r = a.rates;
      try {
        ratesMemo = typeof r === "function" ? r(promptTokens()) : r;
      } catch {
        ratesMemo = null;
      }
      if (
        !ratesMemo ||
        !posOr(ratesMemo.cacheRead, 0) ||
        !(typeof ratesMemo.cacheWrite === "number" && ratesMemo.cacheWrite >= 0)
      ) {
        ratesMemo = null;
      }
    }
    return ratesMemo;
  };

  // Tokens of the VIRTUAL history (untouched input with `map`'s replacements
  // applied), from unit index `from` up to (excluding) the first unit whose
  // message is at or past `limitMsg`.
  const virtualTokens = (map, from, limitMsg) => {
    let t = 0;
    for (let k = from; k < units.length; k++) {
      const u = units[k];
      if (u.msgIndex >= limitMsg) break;
      t += estTokens(u.kind === "tool" && u.id !== null && hasOwn(map, u.id) ? map[u.id] : u.text) + inTok(u);
    }
    return t;
  };

  // Plan a possible GROWTH of `map` (real or shadow). Discovery is subject to the
  // part-count and time-budget bail-outs: a bail-out means "no grow", never "no replay".
  const discover = (map, coolAt) => {
    const out = { decision: "none", add: {}, R: 0, T: 0, breakEven: 0, reason: "", rewarm: 0, nextAllowed: coolAt };
    if (adapted.partCount > maxParts) {
      out.reason = "parts";
      return out;
    }
    if (a.rates === null || a.rates === undefined) {
      out.reason = "unpriced";
      return out;
    }
    // Reverse scan over the virtual history: placeholders count as their
    // replacement length in the tail and are never candidates again.
    const t0 = now();
    const cands = [];
    let tail = 0;
    let uses = 0;
    let seen = 0;
    for (let k = units.length - 1; k >= 0; k--) {
      seen++;
      if (seen % 200 === 0 && now() - t0 > budgetMs) {
        out.reason = "budget";
        return out;
      }
      const u = units[k];
      const trimmed = u.kind === "tool" && u.id !== null && hasOwn(map, u.id);
      const text = trimmed ? map[u.id] : u.text;
      tail += estTokens(text);
      if (u.kind === "tool") uses++;
      if (
        u.kind === "tool" &&
        u.id !== null &&
        !trimmed &&
        !u.tool.startsWith("skill") &&
        !text.startsWith(PLACEHOLDER_PREFIX) &&
        tail > protectTail &&
        uses > maskAfter
      ) {
        const repl = renderPlaceholder(u.tool, u.input, policy.placeholderFormat);
        const net = estTokens(text) - estTokens(repl);
        if (net > 0) cands.push({ k, id: u.id, repl, net });
      }
    }
    if (cands.length === 0) {
      out.reason = "no-candidates";
      return out;
    }
    cands.sort((x, y) => x.k - y.k); // oldest first
    const room = MAX_MAP_ENTRIES - Object.keys(map).length;
    if (room <= 0) {
      out.reason = "cap";
      return out;
    }
    if (cands.length > room) cands.length = room;
    let R = 0;
    for (const c of cands) R += c.net;
    out.R = R;
    if (R < batch) {
      out.reason = "below-batch";
      return out;
    }
    if (reqCount < coolAt) {
      out.reason = "cooldown";
      return out;
    }
    const r = getRates();
    if (!r) {
      out.reason = "unpriced";
      return out;
    }
    if (cacheDead) {
      // The re-write happens anyway: no extra cost to charge, no T needed.
      out.rewarm = 0;
      out.nextAllowed = reqCount + 1;
      out.reason = "dead";
    } else {
      if (!boundaryValid) {
        out.reason = "no-boundary"; // live-cache growth needs a known boundary
        return out;
      }
      // T = what was cached and will now be re-written: from the earliest
      // candidate up to the previous-prompt boundary (content after it is written anyway).
      let T = 0;
      let n = 0;
      for (let k = cands[0].k; k < units.length; k++) {
        const u = units[k];
        if (u.msgIndex >= bCount) break;
        if (++n % 200 === 0 && now() - t0 > budgetMs) {
          out.reason = "budget";
          return out;
        }
        T += estTokens(u.kind === "tool" && u.id !== null && hasOwn(map, u.id) ? map[u.id] : u.text) + inTok(u);
      }
      out.T = T;
      const breakEven = (T * Math.max(0, r.cacheWrite - r.cacheRead)) / (R * r.cacheRead);
      out.breakEven = breakEven;
      if (Math.min(N, MAX_EXPECTED_REQUESTS) < margin * breakEven) {
        out.reason = "payback";
        return out;
      }
      out.rewarm = T;
      out.nextAllowed = reqCount + Math.max(1, Math.ceil(breakEven));
      out.reason = "live";
    }
    out.decision = "grow";
    for (const c of cands) out.add[c.id] = c.repl;
    return out;
  };

  const realKeys = Object.keys(real);
  const shadowKeys = Object.keys(shadow);

  let decision = "none";
  let main = { add: {}, R: 0, T: 0, breakEven: 0, reason: "", rewarm: 0, nextAllowed: cool };
  let nextReal = real;
  let nextCool = cool;
  if (mode === "enabled") {
    const d = discover(real, cool);
    main = d;
    decision = d.decision;
    if (decision === "grow") {
      nextReal = { ...real, ...d.add };
      nextCool = d.nextAllowed;
    }
  } else if (mode === "disabled" && realKeys.length > 0) {
    // The switch is off but trims are live: clear → this request goes out
    // untrimmed. Needs no prices and no discovery.
    decision = "clear";
    nextReal = {};
    nextCool = reqCount;
    let earliest = -1;
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.kind === "tool" && u.id !== null && hasOwn(real, u.id)) {
        earliest = k;
        break;
      }
    }
    let tClear = 0;
    if (earliest >= 0) {
      // ORIGINAL tokens (the untouched input), to the boundary — or to the end
      // of the history, an upper bound, when no boundary is valid.
      const limit = boundaryValid ? bCount : Infinity;
      for (let k = earliest; k < units.length; k++) {
        const u = units[k];
        if (u.msgIndex >= limit) break;
        tClear += estTokens(u.text) + inTok(u);
      }
    }
    main = { add: {}, R: 0, T: tClear, breakEven: 0, reason: "clear", rewarm: cacheDead ? 0 : tClear, nextAllowed: reqCount };
  } else {
    main.reason = mode === "prov" ? "provisional" : "disabled";
  }

  // Shadow: simulated, never applied. Cleared while the switch is on.
  let shadowDecision = "none";
  let sh = { add: {}, R: 0, T: 0, breakEven: 0, reason: "", rewarm: 0, nextAllowed: shadowCool };
  let nextShadow = shadow;
  let nextShadowCool = shadowCool;
  let shadowCleared = false;
  if (mode === "enabled") {
    if (shadowKeys.length > 0) {
      nextShadow = {};
      shadowCleared = true;
    }
  } else if (mode === "disabled" && decision !== "clear") {
    const d = discover(shadow, shadowCool);
    sh = d;
    shadowDecision = d.decision;
    if (shadowDecision === "grow") {
      nextShadow = { ...shadow, ...d.add };
      nextShadowCool = d.nextAllowed;
    }
  }

  const dirty = decision !== "none" || shadowDecision !== "none" || shadowCleared;
  if (dirty) {
    // Ids absent from the history (compaction / revert) are dropped at the next commit.
    const present = new Set();
    for (const u of units) if (u.kind === "tool" && u.id !== null) present.add(u.id);
    const prune = (m) => {
      const o = {};
      for (const id of Object.keys(m)) if (present.has(id)) o[id] = m[id];
      return o;
    };
    nextReal = prune(nextReal);
    nextShadow = prune(nextShadow);
  }

  const nextState = {
    version: 1,
    renderVersion: 1,
    real: nextReal,
    shadow: nextShadow,
    reqCount,
    nextGrowthAllowedAt: nextCool,
    shadowNextGrowthAllowedAt: nextShadowCool,
    lastModel: modelKey ?? (typeof state.lastModel === "string" ? state.lastModel : null),
    updatedAt: now(),
  };

  // Rates for the report: only when there is something to price.
  const rates =
    Object.keys(nextReal).length > 0 || Object.keys(nextShadow).length > 0 || decision !== "none" || shadowDecision !== "none"
      ? getRates()
      : null;

  const applied = appliedStats(adapted, nextReal);
  const shadowStats = appliedStats(adapted, nextShadow);
  return {
    decision,
    add: main.add,
    R: main.R,
    T: main.T,
    N,
    breakEven: main.breakEven,
    reason: main.reason,
    applied,
    shadow: {
      decision: shadowDecision,
      add: sh.add,
      R: sh.R,
      T: sh.T,
      tokens: shadowStats.tokens,
      parts: shadowStats.parts,
      reason: sh.reason,
    },
    rates,
    rewarmTokens: main.rewarm,
    shadowRewarmTokens: sh.rewarm,
    cacheDead,
    boundaryValid,
    compacted,
    dirty,
    nextState,
  };
}
