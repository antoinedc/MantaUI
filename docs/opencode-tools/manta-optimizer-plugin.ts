/**
 * manta-optimizer plugin — Phase 1: OBSERVE ONLY.
 * Computes the masking counterfactual (what the optimizer WOULD trim) and
 * reports it to manta-server. It never mutates the message history.
 *
 * INSTALL (maintainer, post-merge — NOT during an agent run):
 *   cp docs/opencode-tools/manta-optimizer-plugin.ts ~/.config/opencode/plugins/manta-optimizer.ts
 *   systemctl --user restart opencode-serve
 * COPY, never symlink (same @opencode-ai/plugin resolution gotcha as the tools).
 */
import type { Plugin } from "@opencode-ai/plugin"

const PROTECT_TAIL_TOKENS = 40_000
const PROTECT_LAST_TOOL_USES = 12
const MIN_BATCH_TOKENS = 20_000
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

const estTokens = (s: unknown): number =>
  typeof s === "string" ? Math.ceil(s.length / 4) : 0

export const MantaOptimizerObserve: Plugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const messages: any[] = output?.messages ?? []
        const sessionID: string = messages[0]?.info?.sessionID ?? ""
        if (!sessionID) return
        // Walk parts newest-first, accumulating estimated tokens and tool-use count.
        let tailTokens = 0
        let toolUses = 0
        let maskedTokens = 0
        let maskedParts = 0
        for (let m = messages.length - 1; m >= 0; m--) {
          for (const part of [...(messages[m]?.parts ?? [])].reverse()) {
            const isTool = part?.type === "tool"
            const done = part?.state?.status === "completed"
            const out = part?.state?.output ?? ""
            const t = estTokens(out) + estTokens(part?.text)
            tailTokens += t
            if (isTool && done) toolUses++
            const protectedByTail = tailTokens <= PROTECT_TAIL_TOKENS
            const protectedByRecency = toolUses <= PROTECT_LAST_TOOL_USES
            const isSkill = typeof part?.tool === "string" && part.tool.startsWith("skill")
            if (isTool && done && !isSkill && !protectedByTail && !protectedByRecency) {
              maskedTokens += estTokens(out)
              maskedParts++
            }
          }
        }
        if (maskedTokens < MIN_BATCH_TOKENS) return
        await fetch(`${SERVER}/api/optimizer/counterfactual`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ sessionID, maskedTokens, maskedParts, ts: Date.now() }),
          signal: AbortSignal.timeout(1500),
        }).catch(() => {})
      } catch {
        /* fail open — observation must never affect a turn */
      }
    },
  }
}
