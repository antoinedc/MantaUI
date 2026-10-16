/**
 * manta-claude-max — OpenCode V2 port of the Claude Max subscription auth path.
 *
 * Reproduces the V1 opencode-claude-auth mechanisms (see FINDINGS M1–M7) using
 * V2 plugin hooks:
 *   M1 provider usable w/o API key   -> ctx.provider.transform (clear apiKey env requirement)
 *   M5 system identity               -> ctx.session.hook("context") edit event.system
 *   M3 headers (Bearer + CC impersonation) + M4 betas + M6 body rewrites
 *                                    -> ctx.session.hook("http.request") rewrite request
 *   multi-account seat selection     -> same http.request hook, per event.sessionID
 *
 * Credentials are read from a file (access token only in this spike); refresh is
 * designed but not executed. ANTHROPIC_CLI_VERSION is honoured.
 */
import { Plugin } from "@opencode/plugin"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import crypto from "node:crypto"

// ---- M4 beta flags (from V1 model-config.js) ----
const CC_VERSION_FALLBACK = "2.1.280"
const BASE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
  "advisor-tool-2026-03-01",
  "thinking-token-count-2026-05-13",
  "extended-cache-ttl-2025-04-11",
]
const MODEL_OVERRIDES: Array<{ pat: string; add?: string[]; exclude?: string[] }> = [
  { pat: "haiku", exclude: ["effort-2025-11-24"] },
  { pat: "opus-4-5", add: ["effort-2025-11-24"] },
  { pat: "4-6", add: ["effort-2025-11-24"] },
  { pat: "4-7", add: ["effort-2025-11-24"] },
]
function cliVersion() {
  return process.env.ANTHROPIC_CLI_VERSION ?? CC_VERSION_FALLBACK
}
function userAgent() {
  return process.env.ANTHROPIC_USER_AGENT ?? `claude-cli/${cliVersion()} (external, sdk-cli)`
}
function modelBetas(modelId: string): string[] {
  let betas = [...BASE_BETAS]
  const lower = (modelId || "").toLowerCase()
  for (const o of MODEL_OVERRIDES) {
    if (lower.includes(o.pat)) {
      if (o.exclude) betas = betas.filter((b) => !o.exclude!.includes(b))
      if (o.add) for (const a of o.add) if (!betas.includes(a)) betas.push(a)
      break // first-match-wins
    }
  }
  return betas
}

// ---- M6 body rewrites: tool-name PascalCase prefix + billing header + identity split ----
const TOOL_PREFIX = "mcp_"
const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const BILLING_SALT = "59cf53e54c78"
function prefixName(name: string) {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}
function firstUserText(messages: any[]): string {
  const u = messages?.find?.((m) => m.role === "user")
  if (!u) return ""
  const c = u.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    const t = c.find((b: any) => b.type === "text")
    if (t?.text) return t.text
  }
  return ""
}
function computeCch(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 5)
}
function computeVersionSuffix(text: string, version: string) {
  const sampled = [4, 7, 20].map((i) => (i < text.length ? text[i] : "0")).join("")
  return crypto.createHash("sha256").update(`${BILLING_SALT}${sampled}${version}`).digest("hex").slice(0, 3)
}
function buildBillingHeader(messages: any[], version: string, entrypoint: string) {
  const text = firstUserText(messages)
  return `x-anthropic-billing-header: cc_version=${version}.${computeVersionSuffix(text, version)}; cc_entrypoint=${entrypoint}; cch=${computeCch(text)};`
}
function unprefixName(name: string) {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}
// Reverse prefixName in a raw SSE/JSON chunk: "name":"mcp_Shell" -> "name":"shell".
function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, (_m, n) => `"name":"${unprefixName(n)}"`)
}
function transformBody(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    const version = process.env.ANTHROPIC_CLI_VERSION ?? CC_VERSION_FALLBACK
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli"
    // billing header as system[0]
    if (!Array.isArray(parsed.system)) {
      parsed.system = typeof parsed.system === "string" && parsed.system
        ? [{ type: "text", text: parsed.system }]
        : []
    }
    parsed.system = parsed.system.filter(
      (e: any) => !(e?.type === "text" && typeof e.text === "string" && e.text.startsWith("x-anthropic-billing-header")),
    )
    parsed.system.unshift({ type: "text", text: buildBillingHeader(parsed.messages ?? [], version, entrypoint) })
    // tool name PascalCase prefix (M6)
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((t: any) => ({ ...t, name: t.name ? prefixName(t.name) : t.name }))
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((m: any) => {
        if (!Array.isArray(m.content)) return m
        return {
          ...m,
          content: m.content.map((b: any) =>
            b?.type === "tool_use" && typeof b.name === "string" ? { ...b, name: prefixName(b.name) } : b,
          ),
        }
      })
    }
    return JSON.stringify(parsed)
  } catch {
    return raw
  }
}

// ---- M2 credentials: read access token from a file (no refresh in spike) ----
type Creds = { accessToken: string; expiresAt: number }
function readCredsFile(path: string): Creds | null {
  try {
    if (!existsSync(path)) return null
    const j = JSON.parse(readFileSync(path, "utf-8"))
    const o = j.claudeAiOauth ?? j
    if (!o?.accessToken) return null
    return { accessToken: o.accessToken, expiresAt: Number(o.expiresAt ?? 0) }
  } catch {
    return null
  }
}

// ---- Seat resolution for multi-account (prototype) ----
// Resolves a seat credential FILE for a session id. In Manta this calls
// manta-server GET /api/accounts/resolve (which names the seat's credential
// file under ~/.manta-secrets/accounts/). Here it reads a live JSON map file
// RE-READ PER REQUEST so a seat can be re-placed mid-run, like the manta-server
// round-trip. Map shape: { "<sessionID>": "<abs path to .credentials.json>" }.
function seatFileForSession(sessionID: string | undefined): string {
  const defaultFile = process.env.MANTA_CLAUDE_CREDS ?? join(homedir(), ".claude", ".credentials.json")
  if (!sessionID) return defaultFile
  const mapFile = process.env.MANTA_SEAT_MAP_FILE
  if (mapFile) {
    try {
      const map = JSON.parse(readFileSync(mapFile, "utf-8"))
      if (map[sessionID]) return map[sessionID]
    } catch {}
  }
  return defaultFile
}

// Stable per-process session id, like Claude Code's X-Claude-Code-Session-Id
const PROC_SESSION_ID = crypto.randomUUID()

function log(tag: string, obj: Record<string, unknown>) {
  // Never log token values.
  console.log(`[manta-claude-max] ${tag} ${JSON.stringify(obj)}`)
}

export default Plugin.define({
  id: "manta.claude-max",
  async setup(ctx) {
    log("setup", { cliVersion: cliVersion() })

    // M5 — inject Claude Code identity into the system prompt for anthropic.
    await ctx.session.hook("context", (event: any) => {
      try {
        const sys = event.system
        if (Array.isArray(sys)) {
          const has = sys.some((e: any) => typeof e?.text === "string" && e.text.includes(SYSTEM_IDENTITY))
          if (!has) sys.unshift({ type: "text", text: SYSTEM_IDENTITY })
        }
      } catch (e) {
        log("context_error", { msg: String(e) })
      }
    })

    // M3/M4/M6 + seat selection — rewrite the native provider HTTP request.
    await ctx.session.hook(
      "http.request",
      async (event: any) => {
        try {
          const req: Request = event.request
          const url = new URL(req.url)
          if (url.hostname !== "api.anthropic.com") return // only Anthropic
          const sessionID: string | undefined = event.sessionID

          // seat selection (multi-account)
          const credFile = seatFileForSession(sessionID)
          const creds = readCredsFile(credFile)
          if (!creds) {
            log("no_creds", { credFile })
            return
          }

          // derive modelId from the URL/body for betas
          let modelId = "unknown"
          let bodyText: string | null = null
          if (req.body || req.method === "POST") {
            try {
              bodyText = await req.clone().text()
              const b = JSON.parse(bodyText)
              if (b?.model) modelId = String(b.model)
            } catch {}
          }

          // M4 betas (merge with incoming)
          const incoming = (req.headers.get("anthropic-beta") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
          const merged = [...new Set([...modelBetas(modelId), ...incoming])]

          // M3 headers
          req.headers.set("authorization", `Bearer ${creds.accessToken}`)
          req.headers.set("anthropic-version", "2023-06-01")
          req.headers.set("anthropic-beta", merged.join(","))
          req.headers.set("anthropic-dangerous-direct-browser-access", "true")
          req.headers.set("x-app", "cli")
          req.headers.set("user-agent", userAgent())
          req.headers.set("x-client-request-id", crypto.randomUUID())
          req.headers.set("X-Claude-Code-Session-Id", PROC_SESSION_ID)
          req.headers.delete("x-api-key")

          // ?beta=true on /v1/messages
          if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
            url.searchParams.set("beta", "true")
          }

          // M6 body rewrite
          let newBody: string | undefined
          if (bodyText != null) newBody = transformBody(bodyText)

          // replace the request (url + body are immutable on a Request)
          event.request = new Request(url.toString(), {
            method: req.method,
            headers: req.headers,
            body: newBody ?? req.body,
            // @ts-ignore node fetch duplex for streaming bodies
            duplex: "half",
          })

          log("signed", {
            kind: event.kind,
            sessionID: sessionID ?? null,
            seatFile: credFile.replace(homedir(), "~"),
            tokenSha12: crypto.createHash("sha256").update(creds.accessToken).digest("hex").slice(0, 12),
            modelId,
            betas: merged.length,
            bodyRewritten: newBody != null,
          })
        } catch (e) {
          log("http_request_error", { msg: String(e) })
        }
      },
      { providerID: "anthropic" },
    )

    // M6b — un-prefix tool names on the response so opencode's tool router sees
    // the ORIGINAL name (shell, not mcp_Shell). V1 did this in
    // transformResponseStream; in V2 it is the http.response hook. The stream is
    // SSE text; we rewrite "name":"mcp_X" back to "name":"x" on each chunk.
    await ctx.session.hook(
      "http.response",
      (event: any) => {
        try {
          const res: Response = event.response
          if (!res.body) return
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          const enc = new TextEncoder()
          const stream = new ReadableStream({
            async pull(controller) {
              const { done, value } = await reader.read()
              if (done) {
                controller.close()
                return
              }
              const text = dec.decode(value, { stream: true })
              controller.enqueue(enc.encode(stripToolPrefix(text)))
            },
          })
          event.response = new Response(stream, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        } catch (e) {
          log("http_response_error", { msg: String(e) })
        }
      },
      { providerID: "anthropic" },
    )
  },
})
