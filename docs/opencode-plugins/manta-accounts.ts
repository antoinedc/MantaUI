/**
 * manta-accounts plugin — per-conversation subscription seat routing
 * (multi-account spec §4, phase 2).
 *
 * Wraps the process-global `fetch` ONCE. Both the Claude auth plugin and
 * opencode's built-in Codex loader send their FINAL model request through it,
 * after every header and the body are built, so the wrapper only has to swap the
 * identity: it asks manta-server which seat the conversation uses
 * (`GET /api/accounts/resolve`) and, when that seat is not the live login,
 * replaces `authorization` (plus, for Codex, `ChatGPT-Account-Id` and the
 * residency header) with the seat's token. The URL, body and every other header
 * are untouched, so opencode's own behaviour keeps running.
 *
 *   - Intercepts ONLY `POST api.anthropic.com/v1/messages*` and
 *     `POST chatgpt.com/backend-api/codex/*`. Everything else — token refreshes,
 *     profile and usage calls — is the original fetch, untouched.
 *   - A live seat passes through unchanged (the zero-risk default).
 *   - FAIL-SAFE: any problem talking to manta-server (1.5 s timeout) uses the
 *     last result seen for that conversation, else passes the request through
 *     untouched. This plugin never throws into opencode and never logs a token.
 *   - A seat token within 60 s of expiry is refreshed first
 *     (`POST /api/accounts/refresh`); a 401 from a non-live seat is refreshed
 *     once and retried once.
 *
 * INSTALLED AUTOMATICALLY: install.sh and self-update.sh copy this file (a real
 * copy, never a symlink) to ~/.config/opencode/plugins/manta-accounts.ts and
 * restart opencode when it changes — see sync_opencode_plugins in
 * scripts/lib/release.sh. Nothing to do by hand. On a box with one seat per
 * provider it is a pure pass-through.
 *
 * TEST SEAMS (env, ignored when unset; both only ever accept a loopback URL so a
 * token can never be sent off the box):
 *   MANTA_ACCOUNTS_SERVER          override manta-server's base URL
 *   MANTA_ACCOUNTS_TEST_UPSTREAM   send intercepted model requests to a local stub
 *                                  instead of the real provider host
 */
import type { Plugin } from "@opencode-ai/plugin"

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVER = "http://127.0.0.1:8787"
const WRAPPED = Symbol.for("manta.accounts.fetch-wrapped")
const SESSION_HEADER = "x-opencode-session-id"
const PARENT_HEADER = "x-opencode-parent-session-id"
const RESIDENCY_HEADER = "x-openai-internal-codex-residency"
const AUTH_CLAIM = "https://api.openai.com/auth"

const RESOLVE_CACHE_MS = 30_000
const RESOLVE_TIMEOUT_MS = 1_500
// A refresh of a Claude seat runs the `claude` CLI server-side and can take
// many seconds; it only ever happens when a request would otherwise go out with
// a token about to expire.
const REFRESH_TIMEOUT_MS = 30_000
const EXPIRY_MARGIN_MS = 60_000
const MAX_CACHE_ENTRIES = 500

type Provider = "claude" | "codex"

interface Resolved {
  seatId: string | null
  live: boolean
  accessToken?: string
  accountId?: string
  expiresAt?: number
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested through `MantaAccounts.__test`)
// ---------------------------------------------------------------------------

/** Which provider's MODEL endpoint is this request for, if any. */
function matchTarget(input: unknown, method: string): Provider | null {
  if (String(method).toUpperCase() !== "POST") return null
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as any)?.url
  if (typeof raw !== "string") return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== "https:") return null
  if (u.hostname === "api.anthropic.com" && u.pathname.startsWith("/v1/messages")) return "claude"
  if (u.hostname === "chatgpt.com" && u.pathname.startsWith("/backend-api/codex/")) return "codex"
  return null
}

/** The method fetch would use: init wins over a Request, default GET. */
function methodOf(input: unknown, init: any): string {
  return String(init?.method ?? (input as any)?.method ?? "GET")
}

/**
 * The headers fetch would send. `init.headers` REPLACES a Request's own headers
 * (fetch semantics); Headers / array / plain-object forms all normalise.
 */
function collectHeaders(input: unknown, init: any): Headers {
  if (init?.headers !== undefined && init?.headers !== null) return new Headers(init.headers)
  const fromRequest = (input as any)?.headers
  return new Headers(fromRequest ?? undefined)
}

/** Session ids off the request. A sub-agent carries both; only the parent
 *  header present is treated as the session itself. No id → null. */
function sessionIds(headers: Headers): { sessionID: string; parentSessionID: string | null } | null {
  const own = headers.get(SESSION_HEADER)?.trim() || null
  const parent = headers.get(PARENT_HEADER)?.trim() || null
  const sessionID = own ?? parent
  if (!sessionID) return null
  return { sessionID, parentSessionID: own && parent && parent !== own ? parent : null }
}

/** The conversation key used for caching: a sub-agent shares its parent's. */
function rootKey(provider: Provider, ids: { sessionID: string; parentSessionID: string | null }): string {
  return `${provider}|${ids.parentSessionID ?? ids.sessionID}`
}

/** Claims of a JWT (no signature check — we only read our own seat's token). */
function jwtClaims(token: string): any {
  try {
    const part = String(token).split(".")[1]
    if (!part) return null
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"))
  } catch {
    return null
  }
}

/** The Codex residency value for a token, or null (header removed). */
function residencyFromToken(token: string): string | null {
  const claims = jwtClaims(token)
  const v = claims?.[AUTH_CLAIM]?.chatgpt_compute_residency ?? claims?.chatgpt_compute_residency
  return typeof v === "string" && v && v !== "no_constraint" ? v : null
}

/** A copy of `headers` carrying the seat's identity. Nothing else changes. */
function rewriteHeaders(
  headers: Headers,
  provider: Provider,
  seat: { accessToken: string; accountId?: string },
): Headers {
  const out = new Headers(headers)
  out.set("authorization", `Bearer ${seat.accessToken}`)
  if (provider === "codex") {
    if (seat.accountId) out.set("ChatGPT-Account-Id", seat.accountId)
    else out.delete("ChatGPT-Account-Id")
    const residency = residencyFromToken(seat.accessToken)
    if (residency) out.set(RESIDENCY_HEADER, residency)
    else out.delete(RESIDENCY_HEADER)
  }
  return out
}

/** Validate a resolve/refresh answer. Anything unusable degrades to "live". */
function parseResolved(json: any): Resolved | null {
  if (!json || typeof json !== "object") return null
  const seatId = typeof json.seatId === "string" ? json.seatId : null
  if (json.live === false && typeof json.accessToken === "string" && json.accessToken) {
    const out: Resolved = { seatId, live: false, accessToken: json.accessToken }
    if (typeof json.accountId === "string" && json.accountId) out.accountId = json.accountId
    if (typeof json.expiresAt === "number" && Number.isFinite(json.expiresAt)) out.expiresAt = json.expiresAt
    return out
  }
  return { seatId, live: true }
}

/** Is a token with this expiry too close to it to send? Unknown expiry → no. */
function expiresSoon(expiresAt: number | undefined, nowMs: number, marginMs = EXPIRY_MARGIN_MS): boolean {
  return typeof expiresAt === "number" && expiresAt - nowMs <= marginMs
}

/** Can this body be sent twice (for the 401 retry)? Streams cannot. */
function isReplayableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true
  if (typeof body === "string") return true
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true
  if (typeof Blob !== "undefined" && body instanceof Blob) return true
  if (typeof FormData !== "undefined" && body instanceof FormData) return true
  return false
}

/** Only a loopback http(s) URL is ever accepted from the environment. */
function loopbackBase(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

/** The URL to actually call: the original, or the same path on the test stub. */
function forwardUrl(original: string, testUpstream: string | null): string {
  if (!testUpstream) return original
  const u = new URL(original)
  return `${testUpstream}${u.pathname}${u.search}`
}

// ---------------------------------------------------------------------------
// manta-server access (copied from the shared manta-auth helper — a plugin
// under ~/.config/opencode/plugins/ cannot resolve the tools dir at runtime)
// ---------------------------------------------------------------------------

function boxToken(): string | null {
  const fromEnv = process.env.MANTA_BOX_TOKEN
  if (fromEnv) return fromEnv
  try {
    const raw = readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8")
    const tok = JSON.parse(raw)?.box_token
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null
  } catch {
    return null
  }
}

async function callServer(
  origFetch: typeof fetch,
  base: string,
  pathAndQuery: string,
  opts: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
): Promise<Resolved | null> {
  const headers: Record<string, string> = {}
  const tok = boxToken()
  if (tok) headers["authorization"] = `Bearer ${tok}`
  if (opts.body !== undefined) headers["content-type"] = "application/json"
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs)
  try {
    const res = await origFetch(`${base}${pathAndQuery}`, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctl.signal,
    })
    if (!res.ok) return null
    return parseResolved(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

interface WrapperDeps {
  origFetch: typeof fetch
  /** manta-server round trips; `null` = unreachable / refused. */
  resolve: (provider: Provider, ids: { sessionID: string; parentSessionID: string | null }) => Promise<Resolved | null>
  refresh: (provider: Provider, seatId: string) => Promise<Resolved | null>
  now?: () => number
  testUpstream?: string | null
}

function createAccountsFetch(deps: WrapperDeps): typeof fetch {
  const { origFetch, resolve, refresh } = deps
  const now = deps.now ?? (() => Date.now())
  const testUpstream = deps.testUpstream ?? null

  const byConversation = new Map<string, { result: Resolved; at: number }>()
  const bySeat = new Map<string, Resolved & { at: number }>()
  const resolving = new Map<string, Promise<Resolved | null>>()
  const refreshing = new Map<string, Promise<Resolved | null>>()

  const remember = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key)
    map.set(key, value)
    if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value as string)
  }

  // A resolve answer never replaces a token we hold that outlives it (a slower
  // answer from before a refresh must not bring the old token back); a refresh
  // answer always does — it is the server's latest word on the seat.
  const noteSeat = (provider: Provider, r: Resolved | null, authoritative = false) => {
    if (!r || r.live || !r.seatId) return
    const key = `${provider}|${r.seatId}`
    const have = bySeat.get(key)
    if (!authoritative && have?.accessToken && typeof have.expiresAt === "number" && typeof r.expiresAt === "number" && have.expiresAt > r.expiresAt) return
    remember(bySeat, key, { ...r, at: now() })
  }

  async function seatFor(provider: Provider, ids: { sessionID: string; parentSessionID: string | null }): Promise<Resolved | null> {
    const key = rootKey(provider, ids)
    const cached = byConversation.get(key)
    if (cached && now() - cached.at < RESOLVE_CACHE_MS) return cached.result
    let run = resolving.get(key)
    if (!run) {
      run = resolve(provider, ids)
        .catch(() => null)
        .finally(() => resolving.delete(key))
      resolving.set(key, run)
    }
    const fresh = await run
    if (fresh) {
      remember(byConversation, key, { result: fresh, at: now() })
      noteSeat(provider, fresh)
      return fresh
    }
    // FAIL-SAFE: the last answer for this conversation, however old; else none.
    return cached?.result ?? null
  }

  function refreshSeat(provider: Provider, seatId: string): Promise<Resolved | null> {
    const key = `${provider}|${seatId}`
    let run = refreshing.get(key)
    if (!run) {
      run = refresh(provider, seatId)
        .catch(() => null)
        .finally(() => refreshing.delete(key))
      refreshing.set(key, run)
    }
    return run.then((r) => {
      noteSeat(provider, r, true)
      return r
    })
  }

  /** Perform the call. `headers`/`body` override what the caller passed; the
   *  rest of init (signal, redirect, …) is kept. */
  function send(input: unknown, init: any, overrides: { headers?: Headers; body?: BodyInit | null }): Promise<Response> {
    const isRequest = typeof Request !== "undefined" && input instanceof Request
    const original = isRequest ? (input as Request).url : typeof input === "string" ? input : input instanceof URL ? input.href : String((input as any)?.url ?? input)
    const url = forwardUrl(original, testUpstream)
    const redirected = url !== original
    const headers = overrides.headers
    if (!redirected && !headers && overrides.body === undefined) return origFetch(input as any, init)
    const next: any = isRequest
      ? { method: (input as Request).method, redirect: (input as Request).redirect, signal: (input as Request).signal, ...init }
      : { ...init }
    if (headers) next.headers = headers
    if (overrides.body !== undefined) next.body = overrides.body
    const target = isRequest || redirected ? url : input
    return origFetch(target as any, next)
  }

  /** The body a Request carries, read once from a CLONE (the original stays
   *  intact for the fall-back path), so it can be passed — and re-sent — explicitly. */
  async function bodyFor(input: unknown, init: any): Promise<BodyInit | null | undefined> {
    if (init?.body !== undefined) return undefined // caller supplied one; keep it
    if (typeof Request !== "undefined" && input instanceof Request && input.body !== null) {
      return await (input as Request).clone().arrayBuffer()
    }
    return undefined
  }

  const wrapped = async function mantaAccountsFetch(input: any, init?: any): Promise<Response> {
    // ---- decide (no network to the provider, nothing consumed) ----
    let provider: Provider | null = null
    let ids: { sessionID: string; parentSessionID: string | null } | null = null
    let base: Headers | null = null
    let seat: Resolved | null = null
    try {
      provider = matchTarget(input, methodOf(input, init))
      if (!provider) return origFetch(input, init)
      base = collectHeaders(input, init)
      ids = sessionIds(base)
      if (!ids) return send(input, init, {})
      seat = await seatFor(provider, ids)
    } catch {
      return origFetch(input, init)
    }
    if (!provider || !ids || !base) return origFetch(input, init)
    if (!seat || seat.live || !seat.seatId) return send(input, init, {})

    // ---- non-live seat: make sure the token is good, then swap identity ----
    let creds: Resolved = bySeat.get(`${provider}|${seat.seatId}`) ?? seat
    let headers: Headers
    let body: BodyInit | null | undefined
    try {
      if (expiresSoon(creds.expiresAt, now())) {
        const fresh = await refreshSeat(provider, seat.seatId)
        if (fresh && !fresh.live && fresh.accessToken) creds = fresh
        else if (fresh?.live) return send(input, init, {}) // the seat became the live login
      }
      if (!creds.accessToken) return send(input, init, {})
      headers = rewriteHeaders(base, provider, { accessToken: creds.accessToken, accountId: creds.accountId })
      body = await bodyFor(input, init)
    } catch {
      return origFetch(input, init)
    }

    const res = await send(input, init, { headers, body })
    if (res.status !== 401) return res

    // ---- 401 from a non-live seat: refresh that seat once, retry once ----
    const replayable = isReplayableBody(body !== undefined ? body : init?.body)
    if (!replayable) return res
    let retryHeaders: Headers | null = null
    try {
      const fresh = await refreshSeat(provider, seat.seatId)
      if (fresh && !fresh.live && fresh.accessToken && fresh.accessToken !== creds.accessToken) {
        retryHeaders = rewriteHeaders(base, provider, { accessToken: fresh.accessToken, accountId: fresh.accountId })
      }
    } catch {
      /* fall through: return the 401 as-is */
    }
    if (!retryHeaders) return res
    try {
      await res.body?.cancel()
    } catch {
      /* the first response is discarded either way */
    }
    return send(input, init, { headers: retryHeaders, body })
  }

  return wrapped as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

function install(): void {
  const g = globalThis as any
  if (g[WRAPPED]) return // a double load must not double-wrap
  const origFetch: typeof fetch = g.fetch
  if (typeof origFetch !== "function") return
  const server = loopbackBase(process.env.MANTA_ACCOUNTS_SERVER) ?? DEFAULT_SERVER
  const wrapped = createAccountsFetch({
    origFetch,
    resolve: (provider, ids) => {
      const q = new URLSearchParams({ provider, sessionID: ids.sessionID })
      if (ids.parentSessionID) q.set("parentSessionID", ids.parentSessionID)
      return callServer(origFetch, server, `/api/accounts/resolve?${q}`, { method: "GET", timeoutMs: RESOLVE_TIMEOUT_MS })
    },
    refresh: (provider, seatId) =>
      callServer(origFetch, server, "/api/accounts/refresh", { method: "POST", body: { provider, seatId }, timeoutMs: REFRESH_TIMEOUT_MS }),
    testUpstream: loopbackBase(process.env.MANTA_ACCOUNTS_TEST_UPSTREAM),
  })
  try {
    Object.assign(wrapped, origFetch) // keep helpers such as fetch.preconnect
  } catch {
    /* cosmetic */
  }
  g.fetch = wrapped
  g[WRAPPED] = true
}

export const MantaAccounts: Plugin = async () => {
  try {
    install()
  } catch {
    /* fail open — without the wrapper every request simply uses the live login */
  }
  return {}
}

// opencode's loader treats EVERY function export of a plugin file as a plugin
// and calls it, so the one real export is the only export. The helpers above are
// reachable for the unit test through this property alone.
;(MantaAccounts as any).__test = {
  matchTarget,
  collectHeaders,
  sessionIds,
  rootKey,
  jwtClaims,
  residencyFromToken,
  rewriteHeaders,
  parseResolved,
  expiresSoon,
  isReplayableBody,
  loopbackBase,
  forwardUrl,
  createAccountsFetch,
}
