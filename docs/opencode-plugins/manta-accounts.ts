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
 * NO TOKEN TRAVELS OVER HTTP. manta-server's answer names the seat's credential
 * FILE (under ~/.manta-secrets/accounts/); this plugin reads the token from it
 * itself, as the same OS user. The path is validated (absolute, real path inside
 * that directory) before it is read; anything else is treated as "live".
 *
 *   - Intercepts ONLY `POST api.anthropic.com/v1/messages*` and
 *     `POST chatgpt.com/backend-api/codex/*`. Everything else — token refreshes,
 *     profile and usage calls — is the original fetch, untouched.
 *   - The request's MODEL (the top-level `model` string of a JSON string body) is
 *     sent to resolve and limit, because a model-scoped usage window ("7d · Fable")
 *     limits only that model. Read-only: the body is never altered, any parse
 *     failure just means "model unknown", and it is parsed only when a call to
 *     manta-server actually needs it.
 *   - A live seat passes through unchanged (the zero-risk default).
 *   - FAIL-SAFE: any problem talking to manta-server (1.5 s timeout) uses the
 *     last result seen for that conversation, else passes the request through
 *     untouched. This plugin never throws into opencode and never logs a token.
 *   - A seat token within 60 s of expiry is refreshed first
 *     (`POST /api/accounts/refresh`, then the file is re-read); a 401 from a
 *     non-live seat is refreshed once and retried once.
 *   - A 429 (seat hit its usage limit; opencode would otherwise sleep on the
 *     retry-after for hours) is reported (`POST /api/accounts/limit`, 10 s). If the
 *     conversation is re-placed on a DIFFERENT seat, the same request is re-sent
 *     ONCE on it — opencode never sees the 429. Any failure, the same seat, or a
 *     non-replayable body returns the original 429 untouched.
 *
 * INSTALLED AUTOMATICALLY: install.sh and self-update.sh copy this file (a real
 * copy, never a symlink) to ~/.config/opencode/plugins/manta-accounts.ts and
 * restart opencode when it changes — see sync_opencode_plugins in
 * scripts/lib/release.sh. Nothing to do by hand. On a box with one seat per
 * provider it is a pure pass-through.
 *
 * TEST SEAMS (env, ignored when unset; both only ever accept a loopback URL so a
 * token can never be sent off the box):
 *   MANTA_STATE_HOME               state home (as manta-server honours it); the
 *                                  seat credential directory is <it>/.manta-secrets
 *   MANTA_ACCOUNTS_SERVER          override manta-server's base URL
 *   MANTA_ACCOUNTS_TEST_UPSTREAM   send intercepted model requests to a local stub
 *                                  instead of the real provider host
 */
import type { Plugin } from "@opencode-ai/plugin"

import { readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, sep } from "node:path"

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
// A limit report only re-places a conversation (the usage refresh runs in the
// background server-side), so it answers quickly; opencode is waiting on it.
const LIMIT_TIMEOUT_MS = 10_000
const EXPIRY_MARGIN_MS = 60_000
const MAX_CACHE_ENTRIES = 500

type Provider = "claude" | "codex"

/** The conversation a request belongs to, plus its model when known. */
type RequestIds = { sessionID: string; parentSessionID: string | null; model?: string | null }

/** manta-server's answer: which seat, and where its credential file is. */
interface Resolved {
  seatId: string | null
  live: boolean
  credentialFile?: string
}

/** What the seat's credential file holds that a request needs. */
interface SeatCredentials {
  accessToken: string
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

/**
 * The model id of a request body: the top-level `model` string of a JSON string
 * body, else null (any other body type, unparseable JSON, no/non-string model).
 * Read-only — never touches the body it is given.
 */
function modelFromBody(body: unknown): string | null {
  if (typeof body !== "string" || body === "") return null
  try {
    const m = JSON.parse(body)?.model
    return typeof m === "string" && m ? m : null
  } catch {
    return null
  }
}

/** `ids` carrying a `model` that is only worked out (once) when first read. It is
 *  deliberately NOT enumerable: the ids stay `{sessionID, parentSessionID}` to
 *  anything that copies or compares them. */
function withLazyModel(
  ids: { sessionID: string; parentSessionID: string | null },
  body: unknown,
): { sessionID: string; parentSessionID: string | null; model?: string | null } {
  let done = false
  let value: string | null = null
  return Object.defineProperty({ ...ids }, "model", {
    enumerable: false,
    get() {
      if (!done) {
        done = true
        value = modelFromBody(body)
      }
      return value
    },
  })
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
  if (json.live === false && typeof json.credentialFile === "string" && json.credentialFile) {
    return { seatId, live: false, credentialFile: json.credentialFile }
  }
  return { seatId, live: true }
}

/** The one directory seat credentials may be read from. */
function seatsRootDir(): string {
  const override = process.env.MANTA_STATE_HOME
  const home = typeof override === "string" && override.trim() !== "" ? override : homedir()
  return join(home, ".manta-secrets", "accounts")
}

/**
 * The real path of a credential file, or null unless it is absolute and — after
 * resolving every symlink — inside `root`. A path the server named is still
 * treated as untrusted input.
 */
function allowedCredentialPath(file: unknown, root: string): string | null {
  if (typeof file !== "string" || !file || !isAbsolute(file)) return null
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(file)
    if (!real.startsWith(realRoot + sep)) return null
    if (!statSync(real).isFile()) return null
    return real
  } catch {
    return null
  }
}

/** A seat credential file's contents for a provider, or null. Pure parse. */
function parseSeatCredentials(provider: Provider, raw: string): SeatCredentials | null {
  let j: any
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (provider === "claude") {
    const o = j?.claudeAiOauth
    if (typeof o?.accessToken !== "string" || !o.accessToken) return null
    const out: SeatCredentials = { accessToken: o.accessToken }
    if (typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt)) out.expiresAt = o.expiresAt
    return out
  }
  const e = j?.openai ?? (j?.access ? j : null)
  if (e?.type !== "oauth" || typeof e.access !== "string" || !e.access) return null
  const out: SeatCredentials = { accessToken: e.access }
  if (typeof e.accountId === "string" && e.accountId) out.accountId = e.accountId
  if (typeof e.expires === "number" && Number.isFinite(e.expires)) out.expiresAt = e.expires
  return out
}

interface CredentialReader {
  read(provider: Provider, file: string | undefined): SeatCredentials | null
  /** Forget a file's cached contents (after a refresh rewrote it). */
  invalidate(file: string | undefined): void
}

/** Reads seat credential files, cached per file and keyed by mtime + size. */
function createCredentialReader(rootDir: () => string = seatsRootDir): CredentialReader {
  const cache = new Map<string, { sig: string; creds: SeatCredentials | null }>()
  return {
    read(provider, file) {
      const real = allowedCredentialPath(file, rootDir())
      if (!real) return null
      try {
        const st = statSync(real)
        const sig = `${provider}|${st.mtimeMs}|${st.size}`
        const hit = cache.get(real)
        if (hit && hit.sig === sig) return hit.creds
        const creds = parseSeatCredentials(provider, readFileSync(real, "utf-8"))
        cache.delete(real)
        cache.set(real, { sig, creds })
        if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string)
        return creds
      } catch {
        return null
      }
    },
    invalidate(file) {
      if (typeof file !== "string") return
      cache.delete(file)
      try {
        cache.delete(realpathSync(file))
      } catch {
        /* file gone — nothing cached under a real path either */
      }
    },
  }
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
  /** Reads the seat's token from its credential file (never from HTTP). */
  credentials: CredentialReader
  /** manta-server round trips; `null` = unreachable / refused. */
  resolve: (provider: Provider, ids: RequestIds) => Promise<Resolved | null>
  refresh: (provider: Provider, seatId: string) => Promise<Resolved | null>
  /** A 429 happened: re-place the conversation, answer with its seat now. Optional —
   *  absent means no seat-switch retry (behaviour as before). */
  limit?: (provider: Provider, ids: RequestIds) => Promise<Resolved | null>
  now?: () => number
  testUpstream?: string | null
}

function createAccountsFetch(deps: WrapperDeps): typeof fetch {
  const { origFetch, resolve, refresh, credentials, limit } = deps
  const now = deps.now ?? (() => Date.now())
  const testUpstream = deps.testUpstream ?? null

  const byConversation = new Map<string, { result: Resolved; at: number }>()
  const resolving = new Map<string, Promise<Resolved | null>>()
  const refreshing = new Map<string, Promise<Resolved | null>>()

  const remember = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key)
    map.set(key, value)
    if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value as string)
  }

  async function seatFor(provider: Provider, ids: RequestIds): Promise<Resolved | null> {
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
    return run
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

  /**
   * A 429 means the seat the request went out on hit its usage limit. Ask
   * manta-server to re-place the conversation and, when it names a DIFFERENT
   * seat, re-send the same request once on it — so opencode never sees the 429
   * (and never sleeps on its `retry-after`). Anything short of a clean retry
   * returns the original 429, body untouched. Never throws.
   */
  async function switchSeatOnLimit(
    res: Response,
    c: {
      provider: Provider
      ids: RequestIds
      base: Headers
      input: unknown
      init: any
      body: BodyInit | null | undefined
      replayable: boolean
      usedSeatId: string | null
    },
  ): Promise<Response> {
    try {
      if (!limit || !c.replayable) return res
      const key = rootKey(c.provider, c.ids)
      let answer: Resolved | null = null
      try {
        answer = await limit(c.provider, c.ids)
      } catch {
        answer = null
      }
      // Whatever the answer, the cached placement for this conversation is stale.
      byConversation.delete(key)
      if (!answer || answer.seatId === c.usedSeatId) return res

      let headers: Headers = c.base // a live answer: the ORIGINAL identity
      if (!answer.live) {
        let file: string | undefined = answer.credentialFile
        let creds = credentials.read(c.provider, file)
        if (!creds) return res
        if (expiresSoon(creds.expiresAt, now()) && answer.seatId) {
          const fresh = await refreshSeat(c.provider, answer.seatId)
          if (fresh?.live) {
            creds = null // the seat became the live login: original headers
          } else if (fresh) {
            credentials.invalidate(file)
            file = fresh.credentialFile ?? file
            creds = credentials.read(c.provider, file) ?? creds
          }
        }
        if (creds) headers = rewriteHeaders(c.base, c.provider, creds)
      }
      remember(byConversation, key, { result: answer, at: now() })
      // The retry goes out BEFORE the 429 is discarded: if it cannot be sent, the
      // caller still gets the original response with its body intact.
      const retried = await send(c.input, c.init, { headers, body: c.body })
      try {
        await res.body?.cancel()
      } catch {
        /* the first response is discarded either way */
      }
      return retried
    } catch {
      return res
    }
  }

  const wrapped = async function mantaAccountsFetch(input: any, init?: any): Promise<Response> {
    // ---- decide (no network to the provider, nothing consumed) ----
    let provider: Provider | null = null
    let ids: RequestIds | null = null
    let base: Headers | null = null
    let seat: Resolved | null = null
    try {
      provider = matchTarget(input, methodOf(input, init))
      if (!provider) return origFetch(input, init)
      base = collectHeaders(input, init)
      const own = sessionIds(base)
      if (!own) return send(input, init, {})
      ids = withLazyModel(own, init?.body)
      seat = await seatFor(provider, ids)
    } catch {
      return origFetch(input, init)
    }
    if (!provider || !ids || !base) return origFetch(input, init)
    if (!seat || seat.live || !seat.seatId) {
      // Live login (or no answer). Without a `limit` dep this is today's
      // pass-through, untouched. With it, a Request body is captured from a CLONE
      // first so a 429 can be replayed; the request itself still goes out as the
      // caller built it.
      let liveBody: BodyInit | null | undefined
      let liveReplayable = true
      if (limit) {
        try {
          liveBody = await bodyFor(input, init)
        } catch {
          liveReplayable = false
        }
      }
      const liveRes = await send(input, init, {})
      if (liveRes.status !== 429 || !limit) return liveRes
      return switchSeatOnLimit(liveRes, {
        provider,
        ids,
        base,
        input,
        init,
        body: liveBody,
        replayable: liveReplayable && isReplayableBody(liveBody !== undefined ? liveBody : init?.body),
        usedSeatId: seat?.seatId ?? null,
      })
    }

    // ---- non-live seat: read its token FROM THE FILE, make sure it is good,
    // then swap identity ----
    let file: string | undefined = seat.credentialFile
    let creds: SeatCredentials | null
    let headers: Headers
    let body: BodyInit | null | undefined
    try {
      creds = credentials.read(provider, file)
      if (!creds) return send(input, init, {}) // unreadable / outside the seats dir → live login
      if (expiresSoon(creds.expiresAt, now())) {
        const fresh = await refreshSeat(provider, seat.seatId)
        if (fresh?.live) return send(input, init, {}) // the seat became the live login
        if (fresh && !fresh.live) {
          credentials.invalidate(file)
          file = fresh.credentialFile ?? file
          creds = credentials.read(provider, file) ?? creds
        }
      }
      headers = rewriteHeaders(base, provider, creds)
      body = await bodyFor(input, init)
    } catch {
      return origFetch(input, init)
    }

    const res = await send(input, init, { headers, body })
    if (res.status === 429 && limit) {
      return switchSeatOnLimit(res, {
        provider,
        ids,
        base,
        input,
        init,
        body,
        replayable: isReplayableBody(body !== undefined ? body : init?.body),
        usedSeatId: seat.seatId,
      })
    }
    if (res.status !== 401) return res

    // ---- 401 from a non-live seat: refresh that seat once, retry once ----
    const replayable = isReplayableBody(body !== undefined ? body : init?.body)
    if (!replayable) return res
    let retryHeaders: Headers | null = null
    try {
      const fresh = await refreshSeat(provider, seat.seatId)
      if (fresh && !fresh.live) {
        credentials.invalidate(file)
        file = fresh.credentialFile ?? file
        const next = credentials.read(provider, file)
        if (next && next.accessToken !== creds.accessToken) retryHeaders = rewriteHeaders(base, provider, next)
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
    credentials: createCredentialReader(),
    resolve: (provider, ids) => {
      const q = new URLSearchParams({ provider, sessionID: ids.sessionID })
      if (ids.parentSessionID) q.set("parentSessionID", ids.parentSessionID)
      if (ids.model) q.set("model", ids.model)
      return callServer(origFetch, server, `/api/accounts/resolve?${q}`, { method: "GET", timeoutMs: RESOLVE_TIMEOUT_MS })
    },
    refresh: (provider, seatId) =>
      callServer(origFetch, server, "/api/accounts/refresh", { method: "POST", body: { provider, seatId }, timeoutMs: REFRESH_TIMEOUT_MS }),
    limit: (provider, ids) => {
      const body: Record<string, string> = { provider, sessionID: ids.sessionID }
      if (ids.parentSessionID) body.parentSessionID = ids.parentSessionID
      if (ids.model) body.model = ids.model
      return callServer(origFetch, server, "/api/accounts/limit", { method: "POST", body, timeoutMs: LIMIT_TIMEOUT_MS })
    },
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
  modelFromBody,
  withLazyModel,
  rootKey,
  jwtClaims,
  residencyFromToken,
  rewriteHeaders,
  parseResolved,
  parseSeatCredentials,
  allowedCredentialPath,
  createCredentialReader,
  seatsRootDir,
  expiresSoon,
  isReplayableBody,
  loopbackBase,
  forwardUrl,
  createAccountsFetch,
}
