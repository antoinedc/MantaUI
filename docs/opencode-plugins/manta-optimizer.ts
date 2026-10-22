/**
 * manta-optimizer plugin — "sticky trims, priced per model".
 *
 * Replaces old tool outputs with a short placeholder so the re-billed prefix
 * shrinks — but ONLY when the re-cache that trimming forces pays for the model
 * actually in use, and keeping a trimmed history byte-identical across requests
 * until the next deliberate, priced trim. Spec:
 * docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md.
 *
 *   • PER-SESSION policy (never one slot per process) with a provisional
 *     fallback; only an AUTHORITATIVE policy can grow or clear the trim set.
 *   • STICKY trims: per tool-call id the exact replacement text is stored (a
 *     C4 file per session) and replayed byte-for-byte, so the prompt cache keeps
 *     hitting. The set grows only when the gate passes (see planRequest).
 *   • PRICED: list prices come from GET /api/optimizer/prices (never awaited,
 *     refreshed in the background); a model with no price is never trimmed.
 *   • Per request: PLAN on the untouched input → COMMIT (synchronous write,
 *     before the request is sent) → APPLY the committed map → record the
 *     boundary + report. With the switch OFF it stays observe-only: it grows a
 *     simulated "shadow" map for the dashboard but never mutates the history.
 * Fail-open everywhere — any throw hands the history on unmodified.
 *
 * INSTALLED AUTOMATICALLY: install.sh and self-update.sh copy this file (a real
 * copy, never a symlink) to ~/.config/opencode/plugins/manta-optimizer.ts and
 * restart opencode when it changes — see sync_opencode_plugins in
 * scripts/lib/release.sh. Nothing to do by hand.
 *
 * NOTE: only `MantaOptimizerMask` is exported on purpose — opencode's legacy
 * plugin loader invokes EVERY export of a plugin module as a plugin function.
 */
import type { Plugin } from "@opencode-ai/plugin"

//
// Policy constants — DUPLICATED from src/shared/optimizerPolicy.mjs (the single
// source of truth, BET-1343). A plugin at ~/.config/opencode/plugins/ cannot
// resolve the repo, just like the boxToken() helper below.
//
const POLICY_CACHE_MS = 60_000
const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  maskAfterUses: 12,
  batchTokens: 20_000,
  margin: 1.5,
  protectTailTokens: 40_000,
  placeholderFormat: "[manta: trimmed — re-run `{tool}` with {args} to see this again]",
  cacheTtlMs: 300_000,
  maxTransformParts: 4_000,
  transformBudgetMs: 25,
})

const SERVER = "http://127.0.0.1:8787"

// copied from the shared manta-auth helper (BET-1330) — the plugins dir cannot resolve the tools dir at runtime
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function boxToken(): string | null {
  const fromEnv = process.env.MANTA_BOX_TOKEN
  if (fromEnv) return fromEnv
  try {
    const raw = readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8")
    const tok = JSON.parse(raw)?.box_token
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null
  } catch {
    return null // no store yet (auth disabled / first run) → send no header
  }
}

function authHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  if (body) headers["content-type"] = "application/json"
  const tok = boxToken()
  if (tok) headers["authorization"] = `Bearer ${tok}`
  return headers
}

//
// The planner — DUPLICATED VERBATIM from src/shared/maskPlan.mjs (the shared,
// unit-tested source of truth; `export` keywords stripped). PURE: no I/O, the
// clock arrives as `now`. A parity test (manta-optimizer.test.ts) extracts the
// block between the markers below and runs it against maskPlan.mjs on shared
// fixtures — keep the block byte-identical to the shared module.
//
// <<maskPlan:begin>>
const PLACEHOLDER_ARGS_MAX = 200;

// A trimmed part's replacement always starts with this by default — the
// idempotency marker. (The authoritative "already trimmed" check is the stored
// map; the prefix is the backstop for a history that already carries one.)
const PLACEHOLDER_PREFIX = "[manta: trimmed";

const DEFAULT_PLACEHOLDER_FORMAT =
  "[manta: trimmed — re-run `{tool}` with {args} to see this again]";

const DEFAULT_MARGIN = 1.5;
// §4.4: expected remaining requests ≈ min(N, 200) — a labelled heuristic.
const MAX_EXPECTED_REQUESTS = 200;
// §4.5: entries per map; at cap we stop growing (a live replacement is never evicted).
const MAX_MAP_ENTRIES = 5000;
const ONE_HOUR_CACHE_MS = 300_000; // above this TTL a model is "1h-configured"

// Estimated token count from string length only (O(1), no copy).
function estTokens(s) {
  return typeof s === "string" ? Math.ceil(s.length / 4) : 0;
}

const finiteOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const posOr = (v, d) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// Tokens of a tool call's INPUT (JSON length / 4). Cached on the unit.
function estInputTokens(input) {
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
function renderPlaceholder(tool, input, format) {
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
function lastAssistantCompleted(messages) {
  let max = 0;
  for (const m of messages ?? []) {
    if (m?.info?.role !== "assistant") continue;
    const c = m?.info?.time?.completed;
    if (typeof c === "number" && Number.isFinite(c) && c > max) max = c;
  }
  return max;
}

// Total part count across all messages (V1 shape).
function countParts(messages) {
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
function resolveRates(record, promptTokens, opts) {
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
function adaptV1(messages) {
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
function boundaryOf(adapted) {
  const n = adapted?.messageCount ?? 0;
  if (n <= 0) return null;
  const key = adapted.messageKeyAt(n - 1);
  return key == null ? null : { messageCount: n, lastMessageKey: key };
}

/** Net tokens removed from the request by `map` (original − replacement), over units present. */
function appliedStats(adapted, map) {
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
function planRequest(a) {
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
// <<maskPlan:end>>

//
// Trim persistence (contract C4) — one JSON file per session under
// <stateHome>/.manta/optimizer-trims/<sessionID>.json (dir 0700, files 0600).
// stateHome honours MANTA_STATE_HOME (the test seam; production resolves to $HOME).
// Writes are SYNCHRONOUS (temp + rename) and happen only on grow / clear /
// shadow-change — rare by design — and BEFORE the request is sent, so a crash
// can never lose a trim that already went upstream. One opencode process per box
// is assumed; a session's writes are serialized by construction (single-threaded,
// synchronous).
//
const TRIMS_VERSION = 1
const RENDER_VERSION = 1
const MAX_STATE_BYTES = 4 * 1024 * 1024
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const HOUR_MS = 3_600_000
const PRUNE_AGE_MS = 14 * 24 * HOUR_MS
const MAX_SESSIONS_IN_MEMORY = 512

function stateHome(): string {
  const o = process.env.MANTA_STATE_HOME
  return typeof o === "string" && o.trim() !== "" ? o : homedir()
}
const trimsDir = (): string => join(stateHome(), ".manta", "optimizer-trims")
const trimFile = (sessionID: string): string => join(trimsDir(), `${sessionID}.json`)

const warned = new Set<string>()
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  try {
    console.warn(`[manta-optimizer] ${msg}`)
  } catch {
    /* logging must never throw */
  }
}

function freshState(): any {
  return {
    version: TRIMS_VERSION,
    renderVersion: RENDER_VERSION,
    real: {},
    shadow: {},
    reqCount: 0,
    nextGrowthAllowedAt: 0,
    shadowNextGrowthAllowedAt: 0,
    lastModel: null,
    updatedAt: 0,
  }
}

function cleanMap(raw: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  let n = 0
  for (const id of Object.keys(raw)) {
    if (id === "__proto__" || typeof raw[id] !== "string") continue
    if (++n > MAX_MAP_ENTRIES) break
    out[id] = raw[id]
  }
  return out
}

function sanitizeState(raw: any): any {
  const s = freshState()
  if (!raw || typeof raw !== "object" || raw.version !== TRIMS_VERSION) return s
  s.real = cleanMap(raw.real)
  s.shadow = cleanMap(raw.shadow)
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)
  s.reqCount = num(raw.reqCount)
  s.nextGrowthAllowedAt = num(raw.nextGrowthAllowedAt)
  s.shadowNextGrowthAllowedAt = num(raw.shadowNextGrowthAllowedAt)
  s.lastModel = typeof raw.lastModel === "string" ? raw.lastModel : null
  s.updatedAt = num(raw.updatedAt)
  return s
}

// Cold load: synchronous. Files > 4 MB are refused (treated as empty); corrupt → empty. Log once.
function loadState(sessionID: string): any {
  const file = trimFile(sessionID)
  try {
    if (statSync(file).size > MAX_STATE_BYTES) {
      warnOnce(`big:${sessionID}`, `trim file for ${sessionID} exceeds 4 MB — ignoring it`)
      return freshState()
    }
    return sanitizeState(JSON.parse(readFileSync(file, "utf-8")))
  } catch (e: any) {
    if (e?.code !== "ENOENT") warnOnce(`load:${sessionID}`, `could not read trim file for ${sessionID}: ${e?.code ?? e?.message ?? e}`)
    return freshState()
  }
}

// Synchronous temp + rename; the temp is removed on failure. Returns false on any failure.
function saveStateSync(sessionID: string, state: any): boolean {
  const file = trimFile(sessionID)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(trimsDir(), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (e: any) {
    try {
      unlinkSync(tmp)
    } catch {
      /* no temp to remove */
    }
    warnOnce(`save:${sessionID}`, `could not write trim file for ${sessionID}: ${e?.code ?? e?.message ?? e}`)
    return false
  }
}

let lastPruneAt = 0
// Delete trim files untouched for > 14 days — at most once per hour.
function pruneOldFiles(now: number): void {
  if (now - lastPruneAt < HOUR_MS) return
  lastPruneAt = now
  try {
    const dir = trimsDir()
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      const p = join(dir, f)
      try {
        if (now - statSync(p).mtimeMs > PRUNE_AGE_MS) unlinkSync(p)
      } catch {
        /* raced with another delete — fine */
      }
    }
  } catch {
    /* no dir yet */
  }
}

//
// Per-session in-memory entries (LRU 512; the file remains when one is evicted).
// `boundary` is the previous request's {messageCount, lastMessageKey}: it lives
// in memory only, so a restart has NO boundary → no live-cache growth until one
// request has been seen.
//
type Entry = { state: any; boundary: any; touchedAt: number }
const entries = new Map<string, Entry>()

function getEntry(sessionID: string): Entry {
  let e = entries.get(sessionID)
  if (e) {
    entries.delete(sessionID)
    entries.set(sessionID, e)
    return e
  }
  e = { state: loadState(sessionID), boundary: null, touchedAt: 0 }
  entries.set(sessionID, e)
  while (entries.size > MAX_SESSIONS_IN_MEMORY) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  return e
}

// While a session is in use, touch its file at most once an hour so it is not pruned.
function touchFile(sessionID: string, entry: Entry, now: number): void {
  if (now - entry.touchedAt < HOUR_MS) return
  entry.touchedAt = now
  try {
    const t = new Date(now)
    utimesSync(trimFile(sessionID), t, t)
  } catch {
    /* no file (nothing trimmed yet) */
  }
}

//
// Policy client — PER SESSION. A fresh cached policy (< 60 s) is used as-is; a
// stale one is used AND refreshed in the background; a cold session gets a
// PROVISIONAL policy (the last one fetched for any session, else the observe-only
// default) with authoritative:false while a refresh is fired. NEVER awaited on
// the hot path. Only an authoritative policy can grow or clear the trim set, so
// parallel sessions can no longer evict each other's policy and flip a session
// between trimmed and untrimmed.
//
function createPolicyClient(directory: string) {
  const sessions = new Map<string, { policy: any; at: number; authoritative: true }>()
  const inflight = new Set<string>()
  let lastAny: any = null

  function refresh(sessionID: string): void {
    if (inflight.has(sessionID)) return
    inflight.add(sessionID)
    // `directory` is the plugin instance's project directory (opencode instantiates
    // plugins per project instance); it lets the server apply the per-repo tuner table.
    const dir = directory ? `&directory=${encodeURIComponent(directory)}` : ""
    void fetch(`${SERVER}/api/optimizer/policy?sessionID=${encodeURIComponent(sessionID)}${dir}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(1500),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (p && typeof p === "object") {
          const policy = { ...DEFAULT_POLICY, ...p }
          sessions.delete(sessionID)
          sessions.set(sessionID, { policy, at: Date.now(), authoritative: true })
          while (sessions.size > MAX_SESSIONS_IN_MEMORY) {
            const oldest = sessions.keys().next().value
            if (oldest === undefined) break
            sessions.delete(oldest)
          }
          lastAny = policy
        }
      })
      .catch(() => {})
      .finally(() => inflight.delete(sessionID))
  }

  return {
    resolve(sessionID: string): { policy: any; authoritative: boolean } {
      const cached = sessions.get(sessionID)
      if (cached) {
        if (Date.now() - cached.at >= POLICY_CACHE_MS) refresh(sessionID) // stale → use it, refresh
        return { policy: cached.policy, authoritative: true }
      }
      refresh(sessionID)
      return { policy: lastAny ?? DEFAULT_POLICY, authoritative: false }
    },
  }
}

//
// Prices (contract C1) — process-wide, shared by every session. GET
// /api/optimizer/prices, refreshed in the background every 10 minutes, NEVER
// awaited. A model that is not in the map is unpriced → no growth (replay
// continues). The catalog copy is also aged out locally (7 days, from
// `fetchedAt`) for when refreshes keep failing; user-declared "config" prices do
// not age.
//
const PRICES_REFRESH_MS = 600_000
const PRICES_STALE_MS = 7 * 24 * HOUR_MS
let prices: { fetchedAt: number; models: Record<string, any> } = { fetchedAt: 0, models: {} }
let pricesAttemptAt = 0
let pricesInflight = false

function maybeRefreshPrices(now: number): void {
  if (pricesInflight || now - pricesAttemptAt < PRICES_REFRESH_MS) return
  pricesAttemptAt = now
  pricesInflight = true
  void fetch(`${SERVER}/api/optimizer/prices`, { headers: authHeaders(), signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => {
      if (p && typeof p === "object" && p.models && typeof p.models === "object") {
        prices = { fetchedAt: typeof p.fetchedAt === "number" && Number.isFinite(p.fetchedAt) ? p.fetchedAt : 0, models: p.models }
      }
    })
    .catch(() => {}) // a failed refresh leaves the previous map
    .finally(() => {
      pricesInflight = false
    })
}

function priceRecord(model: { providerID?: string; modelID?: string }, now: number): any {
  if (!model.providerID || !model.modelID) return null
  const key = `${model.providerID}/${model.modelID}`
  if (!Object.prototype.hasOwnProperty.call(prices.models, key)) return null
  const rec = prices.models[key]
  if (!rec || typeof rec !== "object") return null
  if (rec.source !== "config" && now - prices.fetchedAt > PRICES_STALE_MS) return null
  return rec
}

function reportCounterfactual(sessionID: string, body: Record<string, unknown>): void {
  void fetch(`${SERVER}/api/optimizer/counterfactual`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ sessionID, ts: Date.now(), ...body }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {})
}

// The model whose tokens we are pricing: the NEWEST message that records one —
// a user message carries `info.model` (the model chosen for this turn: the first
// step after a model switch sees the NEW model), an assistant message carries
// `info.providerID`/`modelID`. The transform's own input is `{}` in V1.
function resolveModel(messages: any[]): { providerID?: string; modelID?: string } {
  for (let m = messages.length - 1; m >= 0; m--) {
    const info = messages[m]?.info
    const pid = info?.providerID ?? info?.model?.providerID
    const mid = info?.modelID ?? info?.model?.modelID
    if (typeof pid === "string" && pid !== "" && typeof mid === "string" && mid !== "") {
      return { providerID: pid, modelID: mid }
    }
  }
  return {}
}

// Replace every completed tool part whose call id is in the committed `real`
// map with its STORED text. Two-phase (collect, then assign) so a throw while
// collecting can never leave the request half-trimmed. Mutates output.messages
// in place (the hook's contract); never deletes or reorders parts.
function applyReal(adapted: any, real: Record<string, string>): number {
  const todo: Array<[any, string]> = []
  for (const u of adapted.units) {
    if (u.kind === "tool" && u.id !== null && Object.prototype.hasOwnProperty.call(real, u.id) && u.ref?.state) {
      todo.push([u.ref, real[u.id]])
    }
  }
  for (const [part, text] of todo) part.state.output = text
  return todo.length
}

const nonEmpty = (m: Record<string, unknown> | null | undefined): boolean => !!m && Object.keys(m).length > 0

function transformMessages(policies: ReturnType<typeof createPolicyClient>, messages: any[]): void {
  const sessionID: string = messages[0]?.info?.sessionID ?? ""
  // Bail-out: no session, or an id that is not a safe file name.
  if (!sessionID || !SESSION_ID_RE.test(sessionID)) return
  const now = Date.now()
  maybeRefreshPrices(now)
  const entry = getEntry(sessionID)
  const { policy, authoritative } = policies.resolve(sessionID)
  const adapted = adaptV1(messages)
  const model = resolveModel(messages)
  const record = priceRecord(model, now)
  // 1-hour write pricing ONLY for a model Manta configures for the 1-hour cache:
  // the server sends `cacheWrite1h` on a record only for such models, and the
  // policy's cacheTtlMs is then > 5 min. If the TTL is 1h but the record has no
  // 1h price, the 5-minute rates are used (the plugin cannot know whether that
  // model is Anthropic-SDK; the server already withheld the 1h price).
  const oneHour =
    typeof policy.cacheTtlMs === "number" &&
    policy.cacheTtlMs > ONE_HOUR_CACHE_MS &&
    !!record &&
    typeof record.cacheWrite1h === "number" &&
    record.cacheWrite1h > 0
  const rates = record
    ? (promptTokens: number) => {
        const r = resolveRates(record, promptTokens, { oneHour })
        return r ? { ...r, source: record.source, fetchedAt: prices.fetchedAt } : null
      }
    : null

  const prev = entry.state
  const counted = { ...prev, reqCount: prev.reqCount + 1 }

  // 1. PLAN on the untouched input.
  let plan: any = null
  try {
    plan = planRequest({
      messages: adapted,
      policy,
      authoritative,
      rates,
      state: counted,
      boundary: entry.boundary,
      model,
      now: Date.now,
      lastCompletedMs: adapted.lastCompletedMs,
    })
  } catch (e: any) {
    warnOnce("plan", `planner failed — replaying the committed trims only: ${e?.message ?? e}`)
  }

  // 2. COMMIT (synchronous, before the request is sent). A failed write keeps the
  //    previous committed state and reports no change.
  let change = "none"
  let shadowChange = "none"
  let rewarmTokens = 0
  let shadowRewarmTokens = 0
  let committedOk = true
  if (!plan) {
    entry.state = counted
  } else if (plan.dirty) {
    if (saveStateSync(sessionID, plan.nextState)) {
      entry.state = plan.nextState
      change = plan.decision
      shadowChange = plan.shadow.decision
      rewarmTokens = plan.rewarmTokens
      shadowRewarmTokens = plan.shadowRewarmTokens
    } else {
      committedOk = false
      entry.state = { ...counted, lastModel: plan.nextState.lastModel }
    }
  } else {
    entry.state = plan.nextState // counters only; the maps are unchanged
  }

  // 3. APPLY the committed `real` map. If this throws, send the request untouched.
  let applied = { tokens: 0, parts: 0 }
  try {
    applyReal(adapted, entry.state.real)
    applied = committedOk && plan ? plan.applied : appliedStats(adapted, entry.state.real)
  } catch (e: any) {
    warnOnce("apply", `applying trims failed — request sent untouched: ${e?.message ?? e}`)
  }
  const shadowStats = committedOk && plan ? plan.shadow : appliedStats(adapted, entry.state.shadow)

  // 4. RECORD the boundary (on the untouched input) and REPORT.
  entry.boundary = boundaryOf(adapted)
  touchFile(sessionID, entry, now)
  pruneOldFiles(now)

  if (nonEmpty(entry.state.real) || nonEmpty(entry.state.shadow) || change !== "none" || shadowChange !== "none") {
    reportCounterfactual(sessionID, {
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
    })
  }
}

//
// Constraint pinning (BET-1346) — DUPLICATED from src/shared/constraintPin.mjs
// (the single source of truth). A plugin at ~/.config/opencode/plugins/ cannot
// resolve the repo, same accepted duplication as the policy constants above.
// The user's standing instructions must survive a background compaction;
// opencode's own compaction prompt has no idea they exist, so on the
// `experimental.session.compacting` hook we fetch the instructions that were
// extracted from the session BEFORE compaction (GET /api/optimizer/constraints)
// and APPEND them to the compaction prompt (append ONLY — replacing opencode's
// prompt is how a summariser silently loses everything it was not told to keep).
//

const CONSTRAINT_CACHE_MS = 60_000
const MAX_CONSTRAINTS = 20
const MAX_CONSTRAINT_CHARS = 300

function parseConstraints(raw: unknown): string[] {
  if (typeof raw !== "string") return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split("\n")) {
    let s = line.trim()
    s = s.replace(/^[-\*\+•]\s*/, "")
    s = s.replace(/^(?:\d+[\.\):]|\(\d+\))\s*/, "")
    const cleaned = s.trim()
    if (cleaned === "") continue
    if (out.length >= MAX_CONSTRAINTS) break
    const capped = cleaned.length > MAX_CONSTRAINT_CHARS ? cleaned.slice(0, MAX_CONSTRAINT_CHARS) : cleaned
    const key = capped.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(capped)
  }
  return out
}

function renderConstraintBlock(constraints: string[]): string {
  const list = (constraints ?? []).filter((c) => typeof c === "string" && c.trim() !== "")
  if (list.length === 0) return ""
  return (
    "\n\nStanding instructions from the user, preserved verbatim across compaction:\n" +
    list.map((c) => "- " + c).join("\n")
  )
}

function buildCompactionPrompt(basePrompt: string, constraints: string[]): string {
  return (typeof basePrompt === "string" ? basePrompt : "") + renderConstraintBlock(constraints)
}

// Non-blocking 60s-cache, identical discipline to the policy lookup above: a
// fresh same-session result (<60s) is used as-is; otherwise the cached-stale
// value (or []) is used AND a background refresh fires that is NEVER awaited.
// A failed refresh leaves the previous value; a cold cache means [] — fail-open.
let constraintCache: { constraints: string[]; at: number; sessionID: string } | null = null

function refreshConstraints(sessionID: string): void {
  void fetch(`${SERVER}/api/optimizer/constraints?sessionID=${encodeURIComponent(sessionID)}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => {
      if (p && Array.isArray(p.constraints)) {
        constraintCache = { constraints: p.constraints, at: Date.now(), sessionID }
      }
    })
    .catch(() => {})
}

function resolveCachedConstraints(sessionID: string): string[] {
  const cached = constraintCache
  const nowMs = Date.now()
  if (cached && cached.sessionID === sessionID && nowMs - cached.at < CONSTRAINT_CACHE_MS) {
    return cached.constraints
  }
  if (cached && cached.sessionID === sessionID) {
    refreshConstraints(sessionID) // stale for this session → use stale, refresh
    return cached.constraints
  }
  refreshConstraints(sessionID) // cold → [], refresh
  return []
}

export const MantaOptimizerMask: Plugin = async (pluginInput: any) => {
  // opencode instantiates plugins per project instance, so `directory` is this
  // instance's project directory (verified against @opencode-ai/plugin PluginInput).
  const directory: string = typeof pluginInput?.directory === "string" ? pluginInput.directory : ""
  const policies = createPolicyClient(directory)
  maybeRefreshPrices(Date.now()) // warm the price map before the first request
  return {
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        transformMessages(policies, output?.messages ?? [])
      } catch {
        /* fail open — a trimming bug must degrade to "we did not trim",
           never to a broken turn */
      }
    },
    "experimental.session.compacting": async (input: any, output: any) => {
      // GUARDRAIL (BET-1346): the constraint-injection below is shipped BEHIND
      // scripts/optimizer/retention-eval.mjs — the seeded-retention eval that
      // must pass 30/30 before this prompt change is considered enabled. It is
      // run BY HAND (it costs real model calls) and is NOT part of `npm test`.
      // Until 30/30 is verified, treat this hook as inert: any failure or an
      // eval below 30/30 hands the prompt through untouched.
      try {
        const sessionID = String(input?.sessionID ?? input?.session?.id ?? "")
        if (!sessionID) return output
        // NEVER awaited on the hook path — the same non-blocking discipline as
        // the policy lookup.
        const constraints = resolveCachedConstraints(sessionID)
        if (constraints.length === 0) return output
        const base =
          typeof output === "string" ? output : typeof output?.prompt === "string" ? output.prompt : ""
        if (base === "") return output
        const appended = buildCompactionPrompt(base, constraints)
        if (typeof output === "string") return appended
        if (output && typeof output === "object") {
          return { ...output, prompt: appended }
        }
        return output
      } catch {
        return output // fail open — hand the prompt through untouched
      }
    },
  }
}
