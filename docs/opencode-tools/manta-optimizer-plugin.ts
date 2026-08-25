/**
 * manta-optimizer plugin — Phase 2: MASK (observe → act), BET-1344.
 * Reads the resolved policy from `GET /api/optimizer/policy` and, when the
 * optimizer is enabled, replaces eligible tool outputs with a placeholder so
 * the re-billed prefix shrinks. With the switch OFF (the fail-open default) it
 * stays OBSERVE-ONLY: it computes + reports the counterfactual but never
 * mutates the history. Fail-open everywhere — any throw hands the history on
 * unmodified.
 *
 * INSTALL (maintainer, post-merge — NOT during an agent run):
 *   cp docs/opencode-tools/manta-optimizer-plugin.ts ~/.config/opencode/plugins/manta-optimizer.ts
 *   systemctl --user restart opencode-serve
 * COPY, never symlink (same @opencode-ai/plugin resolution gotcha as the tools).
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
  protectTailTokens: 40_000,
  placeholderFormat: "[manta: trimmed — re-run `{tool}` with {args} to see this again]",
  cacheTtlMs: 300_000,
  maxTransformParts: 4_000,
  transformBudgetMs: 25,
})

const SERVER = "http://127.0.0.1:8787"

// copied from the shared manta-auth helper (BET-1330) — the plugins dir cannot resolve the tools dir at runtime
import { readFileSync } from "node:fs"
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
// Masking decision — DUPLICATED from src/shared/maskPlan.mjs (the shared,
// unit-tested source of truth, BET-1344). PURE: no Date.now()/I/O; the clock
// arrives as `now`. The zero-allocation reverse-INDEX scan never copies arrays.
//

const PLACEHOLDER_ARGS_MAX = 200
const PLACEHOLDER_PREFIX = "[manta: trimmed"
const DEFAULT_PLACEHOLDER_FORMAT =
  "[manta: trimmed — re-run `{tool}` with {args} to see this again]"

const estTokens = (s: unknown): number =>
  typeof s === "string" ? Math.ceil(s.length / 4) : 0

function renderPlaceholder(tool: unknown, input: unknown, format?: unknown): string {
  const fmt =
    typeof format === "string" && format.length > 0 ? format : DEFAULT_PLACEHOLDER_FORMAT
  let args: string
  try {
    args = JSON.stringify(input ?? {})
  } catch {
    args = "{}" // circular input — never let a render throw
  }
  if (typeof args !== "string") args = "{}"
  if (args.length > PLACEHOLDER_ARGS_MAX) {
    args = args.slice(0, PLACEHOLDER_ARGS_MAX) + "…"
  }
  return fmt
    .replaceAll("{tool}", typeof tool === "string" && tool ? tool : "tool")
    .replaceAll("{args}", args)
}

function lastAssistantCompleted(messages: unknown[]): number {
  let max = 0
  for (const m of messages ?? []) {
    if (m?.info?.role !== "assistant") continue
    const c = m?.info?.time?.completed
    if (typeof c === "number" && Number.isFinite(c) && c > max) max = c
  }
  return max
}

function countParts(messages: unknown[]): number {
  let n = 0
  for (const m of messages ?? []) n += m?.parts?.length ?? 0
  return n
}

function scanEligible(
  messages: any[],
  policy: any,
  budget?: { now: () => number; t0: number; budgetMs: number; checkEvery: number },
): any {
  const protectTailTokens = policy.protectTailTokens
  const maskAfterUses = policy.maskAfterUses
  let tailTokens = 0
  let toolUses = 0
  let maskedTokens = 0
  let maskedParts = 0
  let partsSeen = 0
  const eligible: any[] = []
  const t0 = budget ? budget.t0 : 0
  const budgetMs = budget ? budget.budgetMs : 0
  const checkEvery = budget && budget.checkEvery > 0 ? budget.checkEvery : 0
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m]?.parts ?? []
    for (let i = parts.length - 1; i >= 0; i--) {
      partsSeen++
      if (checkEvery > 0 && partsSeen % checkEvery === 0 && budget!.now() - t0 > budgetMs) {
        return { bailed: "budget", maskedTokens, maskedParts, eligible }
      }
      const part = parts[i]
      const isTool = part?.type === "tool"
      const done = part?.state?.status === "completed"
      const out = typeof part?.state?.output === "string" ? part.state.output : ""
      tailTokens += estTokens(out) + estTokens(part?.text)
      if (isTool && done) toolUses++
      const protectedByTail = tailTokens <= protectTailTokens
      const protectedByRecency = toolUses <= maskAfterUses
      const isSkill = typeof part?.tool === "string" && part.tool.startsWith("skill")
      const alreadyPlaceholder = out.startsWith(PLACEHOLDER_PREFIX)
      if (isTool && done && !isSkill && !alreadyPlaceholder && !protectedByTail && !protectedByRecency) {
        maskedTokens += estTokens(out)
        maskedParts++
        eligible.push({
          m,
          i,
          tool: typeof part?.tool === "string" && part.tool ? part.tool : "tool",
          output: out,
          input: part?.state?.input,
        })
      }
    }
  }
  return { bailed: null, maskedTokens, maskedParts, eligible }
}

function decideApply(a: {
  reclaimable: number
  batchTokens: number
  lastAssistantCompletedMs: number
  cacheTtlMs: number
  now: number
}): { apply: boolean; cacheDead: boolean } {
  if (a.reclaimable >= a.batchTokens) return { apply: true, cacheDead: false }
  const cacheDead = a.lastAssistantCompletedMs > 0 && a.now - a.lastAssistantCompletedMs > a.cacheTtlMs
  return { apply: cacheDead, cacheDead }
}

function planMask(a: { messages: any[]; policy: any; now?: () => number }): any {
  const messages = a.messages
  const policy = a.policy
  const now = a.now ?? Date.now
  if (countParts(messages) > policy.maxTransformParts) {
    return {
      bailed: "parts", apply: false, maskedTokens: 0, maskedParts: 0,
      eligible: [], reclaimable: 0, cacheDead: false, lastAssistantCompletedMs: 0,
    }
  }
  const t0 = now()
  const scan = scanEligible(messages, policy, {
    now, t0, budgetMs: policy.transformBudgetMs, checkEvery: 200,
  })
  if (scan.bailed === "budget") {
    return {
      bailed: "budget", apply: false, maskedTokens: 0, maskedParts: 0,
      eligible: [], reclaimable: 0, cacheDead: false, lastAssistantCompletedMs: 0,
    }
  }
  const lastAssistantCompletedMs = lastAssistantCompleted(messages)
  const { apply, cacheDead } = decideApply({
    reclaimable: scan.maskedTokens,
    batchTokens: policy.batchTokens,
    lastAssistantCompletedMs,
    cacheTtlMs: policy.cacheTtlMs,
    now: now(),
  })
  return {
    bailed: null, apply, cacheDead, lastAssistantCompletedMs,
    maskedTokens: scan.maskedTokens, maskedParts: scan.maskedParts,
    eligible: scan.eligible, reclaimable: scan.maskedTokens,
  }
}

//
// Policy cache — NEVER on the hot path. A fresh cached policy (same session,
// < 60s old) is used as-is; otherwise the cached-but-stale value (or
// DEFAULT_POLICY, i.e. observe-only) is used AND a background refresh is fired
// that is never awaited. A failed refresh leaves the previous value; a cold
// cache means enabled:false → observe-only. The transform never awaits a
// network call.
//
let policyCache: { policy: any; at: number; sessionID: string } | null = null

function refreshPolicy(sessionID: string): void {
  void fetch(`${SERVER}/api/optimizer/policy?sessionID=${encodeURIComponent(sessionID)}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((p) => {
      if (p && typeof p === "object") {
        policyCache = { policy: p, at: Date.now(), sessionID }
      }
    })
    .catch(() => {})
}

// Resolve the effective policy for this transform. Returns the policy to use
// (never null — always a real object, observe-only when unknown) and refreshes
// the cache in the background as needed.
function resolveCachedPolicy(sessionID: string): any {
  const cached = policyCache
  const nowMs = Date.now()
  if (cached && cached.sessionID === sessionID && nowMs - cached.at < POLICY_CACHE_MS) {
    return cached.policy // fresh → use it, no refresh
  }
  if (cached && cached.sessionID === sessionID) {
    refreshPolicy(sessionID) // stale for this session → use stale, refresh
    return cached.policy
  }
  refreshPolicy(sessionID) // cold / wrong session → observe-only, refresh
  return DEFAULT_POLICY
}

function reportCounterfactual(sessionID: string, body: Record<string, unknown>): void {
  void fetch(`${SERVER}/api/optimizer/counterfactual`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ sessionID, ts: Date.now(), ...body }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {})
}

// Replace each eligible tool part's output with its placeholder. Mutates
// output.messages in place (the hook's contract); never deletes/reorders parts.
function applyMask(messages: any[], eligible: any[], format: string): void {
  for (const e of eligible ?? []) {
    const part = messages?.[e?.m]?.parts?.[e?.i]
    if (!part || part.type !== "tool" || !part.state) continue
    part.state.output = renderPlaceholder(e.tool, e.input, format)
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

export const MantaOptimizerMask: Plugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const messages: any[] = output?.messages ?? []
        const sessionID: string = messages[0]?.info?.sessionID ?? ""
        // Bail-out 1: no session.
        if (!sessionID) return

        // Bail-out 2 + policy resolution (never a network call on the hot path).
        const policy = resolveCachedPolicy(sessionID)

        const plan = planMask({ messages, policy, now: Date.now })
        // Bail-out 3 (parts) and the mid-scan budget abort: hand history on unmodified.
        if (plan.bailed) return

        const mode = policy.enabled === true ? "act" : "observe"
        // The switch gates actuation: observe mode computes + reports the same
        // counterfactual but never mutates.
        const shouldAct = policy.enabled === true && plan.apply
        let applied = false
        if (shouldAct) {
          applyMask(messages, plan.eligible, policy.placeholderFormat)
          applied = true
        }

        // Report actual AND counterfactual — not awaited. maskedTokens /
        // maskedParts are the full would-mask computed identically whether the
        // policy is on or off, so the observe line stays byte-identical to
        // phase 1 (which reported only above MIN_BATCH_TOKENS == batchTokens).
        if (plan.maskedTokens >= policy.batchTokens) {
          reportCounterfactual(sessionID, {
            maskedTokens: plan.maskedTokens,
            maskedParts: plan.maskedParts,
            applied,
            mode,
          })
        }
      } catch {
        /* fail open — a masking bug must degrade to "we did not trim",
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
