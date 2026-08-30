// ctoProbes.mjs — the §7.5 probe runner (BET-1396 / spec §7.5, §7.3, §7.6,
// §10.6-7) for the Adaptive CTO.
//
// Consented tools get DECLARATIVE metadata probes: `~/.manta/cto/probes/<tool>.yaml`
// holds a §7.5 spec (validated like forge rules — unknown keys fail BY NAME),
// and this runner executes the probes on their cadence against the tool's
// EVIDENCED hosts only.
//
// Hard enforcement (§7.5 "every runner enforcement rule"):
//   - GET-only. The validator rejects any other method by name; the runner
//     never issues one.
//   - Exact-host allowlist derived from the tool's evidence rows. A probe URL
//     on any other host is a spec validation error, and a redirect is NEVER
//     followed — a 3xx is a failure row, so nothing off-list is ever hit.
//   - Public DNS only, SSRF-safe by construction: the default transport
//     RESOLVES the hostname first, rejects every private/reserved address
//     (RFC1918, loopback, link-local, CGNAT, v4-mapped v6, ...), then issues
//     the TLS request with a pinned `lookup` so the socket can only reach the
//     validated addresses (no rebinding window). `Host` + SNI keep the
//     hostname. Rationale: a probe spec is AI-authored content; without this
//     an LLM could be steered into fetching `http://169.254.169.254/` or a
//     box-local service.
//   - 256 KB response cap + 10 s timeout, enforced on the response stream.
//   - Auth by reference only: `auth.secret` names a vault KEY; the runner
//     resolves it AT SPAWN through the existing secrets machinery to a
//     materialized file path and reads the value inside the request closure.
//     The value never enters logs, stores, ledger rows, or model contexts —
//     failure rows carry status codes and error codes only. Secret usage is
//     NOT recorded on probe spawns (a provide that inflated engagement would
//     make the registry's axis a feedback loop of its own runner).
//   - Responses are UNTRUSTED DATA: only tiny extracted fields (the spec's
//     json-path `extract` map) survive into the ledger/vitality/relevance
//     paths; the raw body is never persisted or fed to a model.
//
// Vitality (§7.3): successful metadata probes hand {last_event, inflow_rate}
// to `ctoToolRegistry.applyProbeResult` (EWMA in the §7.2 schema) and the
// probe's cadence adapts daily↔weekly on observed inflow (spec cadence stays
// unclamped until the first vitality sample).
//
// Relevance (§7.6, scoring half only — deep analyses are P3): weekly per
// consented tool × active project, one nano runEphemeral call scores the
// tool's data domain against the project's top facts + recent rollups into
// `relevance[project] ∈ [0,1]`.
//
// Spec authoring (BET-1438, §7.5): the engine scaffolds `{tool, probes: []}`
// at consent time; an ephemeral nano session (the SAME §3.3-gated seam the
// registry's classifier rides) proposes probe entries from the tool's evidence
// rows — evidenced hosts + credential presence only — and fills the template
// through writeSpec, the ONE validated engine-written path. A refused
// candidate surfaces on the tool's evidence trail (the trail the connect ask
// and drill-down read) — never silently.
//
// Failure escalation (§10.6-7): consecutive auth-shaped failures (401/403, or
// a secret that no longer materializes — the same "key may have been rotated"
// failure mode) ≥ 3 → ONE blocker card per probe (idempotent upsert; the body
// names the secrets surface). Any success resolves the card. Non-auth
// failures produce health rows only — they never page the user. The whole
// subsystem sits behind the master CTO toggle (§10.5) and does nothing for
// tools without consent (§7.5).
//
// Thrifty (§12.2): probe fan-outs are rung 2 of the shed ladder. While
// thrifty is on every due-probe execution is skipped EXCEPT probes that
// currently back an open probe-failure blocker card (their liveness IS the
// card's resolution path).
//
// Injection discipline: no live network, fs, secrets, registry, cards, or
// opencode in tests — everything arrives injected, so tests are pure over
// fakes (AGENTS.md server rule).

import { readFile } from "node:fs/promises";
import https from "node:https";
import dns from "node:dns/promises";
import { probesStore, probeStateStore } from "./ctoStores.mjs";
import { provideSecret } from "./secrets.mjs";
import { proposalsFromRollup } from "./ctoRollups.mjs";
import {
  PROBE_SOURCE_KIND,
  probeBlockerCopy,
  stableCardId,
} from "./ctoCards.mjs";

// ---------------------------------------------------------------------------
// Constants (§7.5 / §7.3 / §10.6-7)
// ---------------------------------------------------------------------------

export const RESPONSE_CAP_BYTES = 256 * 1024;
export const PROBE_TIMEOUT_MS = 10_000;
// §7.5: every probe declares its cadence; the floor is 5m (validation floor —
// the ADAPTIVE band below can only move a probe within daily↔weekly, and the
// effective cadence never dips under the floor).
export const CADENCE_FLOOR_MS = 5 * 60_000;
// §10.6-7: escalate an auth-shaped failure to a blocker card after 3 consecutive.
export const AUTH_FAIL_ESCALATE = 3;
// §7.3 cadence adaptation band (daily ↔ weekly on observed inflow).
export const CADENCE_DAILY_MS = 24 * 3_600_000;
export const CADENCE_WEEKLY_MS = 7 * 24 * 3_600_000;
// §7.6: one relevance call per (tool, project) per week, paced per day. The
// daily budget bounds ATTEMPTS, not successes — a failed or unparseable nano
// call consumes the day's pacing AND sets a short retry watermark, so a
// persistently failing/gated model makes at most RELEVANCE_PER_DAY attempts
// per day instead of spinning one attempt per due pair per minute-tick.
export const RELEVANCE_WEEK_MS = 7 * 24 * 3_600_000;
export const RELEVANCE_PER_DAY = 6;
export const RELEVANCE_FAILURE_RETRY_MS = 3_600_000;
export const RELEVANCE_TASK_CLASS = "ambient-summarize";
// §7.5 authoring (BET-1438): the ephemeral session that FILLS scaffolded
// templates. Pacing mirrors the relevance scan — attempts (not successes) are
// the paced resource; a filled (or not-derivable) template rests for the week.
export const AUTHORING_PER_DAY = 4;
export const AUTHORING_WEEK_MS = 7 * 24 * 3_600_000;
export const AUTHORING_FAILURE_RETRY_MS = 3_600_000;
export const AUTHORING_TASK_CLASS = "ambient-summarize";
export const AUTHOR_MAX_PROBES = 5;

// Consent rings (D13). Probes only ever declare metadata | deep_read — the
// write ring creates no standing specs (§7.4). Ordering matters: a probe's
// ring must be ≤ the tool's consented ring for that access level.
export const RING_LEVELS = Object.freeze({ metadata: 1, deep_read: 2 });
export const PROBE_RINGS = Object.freeze(Object.keys(RING_LEVELS));

// Cadence grammar: `<n><s|m|h|d>` — the pluginManifest timeout style.
export const CADENCE_RE = /^\d+(s|m|h|d)$/;
const CADENCE_UNIT_MS = Object.freeze({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

// Auth header template: exactly one {secret} placeholder, by reference only.
export const SECRET_PLACEHOLDER = "{secret}";
const SECRET_PLACEHOLDER_RE = /\{secret\}/g;

// Probe names / extract fields are identifiers (never paths); secret keys are
// vault KEY NAMEs (SCREAMING_SNAKE) — never a value.
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const HOSTLIKE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// ---------------------------------------------------------------------------
// Pure predicates — URL / host / address (SSRF catalogue, §7.5)
// ---------------------------------------------------------------------------

/** Parse a spec URL into `{url, host}` or null. Only https is a probe URL. */
export function parseProbeUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password) return null;
  return { url: u, host: u.hostname.toLowerCase() };
}

/** Exact-host allowlist match (case-insensitive, no subdomain forgiveness). */
export function hostAllowed(host, hosts) {
  if (typeof host !== "string" || !Array.isArray(hosts)) return false;
  const h = host.toLowerCase();
  return hosts.some((x) => typeof x === "string" && x.toLowerCase() === h);
}

function octetsOf(address) {
  return address.split(".").map((o) => {
    if (!/^\d{1,3}$/.test(o)) return null;
    const n = Number(o);
    return n <= 255 ? n : null;
  });
}

/**
 * True when `address` (a DNS result for the probe host) is private/reserved —
 * rejected before any socket is opened. Covers loopback, RFC1918, link-local,
 * 0.0.0.0/8, CGNAT, multicast/reserved, IPv6 loopback/ULA/link-local/multicast,
 * and IPv4-mapped IPv6 (::ffff:a.b.c.d). Pure + deterministic for tests.
 */
export function isPrivateAddress(address) {
  if (typeof address !== "string" || address.length === 0) return true;
  const a = address.toLowerCase();
  if (a.includes(":")) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    if (mapped) {
      const o = octetsOf(mapped[1]);
      if (o.length !== 4 || o.some((x) => x === null)) return true;
      return isPrivateV4(o);
    }
    if (a === "::1" || a === "::") return true; // loopback / unspecified
    if (/^f[c-f]/.test(a)) return true; // fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast
    const compat = /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    if (compat) {
      const o = octetsOf(compat[1]);
      if (o.length !== 4 || o.some((x) => x === null)) return true;
      return isPrivateV4(o);
    }
    return false;
  }
  const o = octetsOf(a);
  if (o.length !== 4 || o.some((x) => x === null)) return true;
  return isPrivateV4(o);
}

function isPrivateV4([a, b]) {
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 0) return true; // this-network
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** Pure filter: keep only the DNS results a probe may connect to. */
export function publicAddresses(results) {
  if (!Array.isArray(results)) return [];
  return results.filter((r) => typeof r?.address === "string" && !isPrivateAddress(r.address));
}

// ---------------------------------------------------------------------------
// Pure helpers — cadence, extraction, escalation
// ---------------------------------------------------------------------------

/** Parse a §7.5 cadence string to ms, or null when malformed. */
export function cadenceMs(value) {
  const m = CADENCE_RE.exec(String(value ?? ""));
  if (!m) return null;
  const num = Number(m[0].slice(0, -1));
  return num * CADENCE_UNIT_MS[m[0].slice(-1)];
}

/**
 * §7.3 adaptive cadence (daily ↔ weekly on observed inflow):
 *   - no vitality sample yet (`vitality?.ewma` null) → the spec cadence
 *     unclamped (the declared value is the truth until data exists);
 *   - inflow observed (ewma > 0) → accelerate toward daily: min(spec, 1 day);
 *   - observed silence (ewma === 0) → stretch toward weekly: max(spec, 1 week).
 * The result never dips below CADENCE_FLOOR_MS.
 */
export function effectiveCadenceMs(specMs, vitality) {
  const base = Math.max(specMs ?? CADENCE_FLOOR_MS, CADENCE_FLOOR_MS);
  const ewma = vitality?.ewma;
  if (typeof ewma !== "number" || !Number.isFinite(ewma)) return base;
  if (ewma > 0) return Math.max(Math.min(base, CADENCE_DAILY_MS), CADENCE_FLOOR_MS);
  return Math.max(base, CADENCE_WEEKLY_MS);
}

/**
 * Extract the spec's json-path map from a parsed JSON body. Paths are dot
 * notation with numeric array indexes; a `length` segment on an array yields
 * its length. Missing paths yield null (non-fatal — probes report what they
 * can see). Returns `{ok, fields}`; ok is false only when the body is not JSON.
 */
export function extractFields(bodyText, extractMap) {
  if (!extractMap || typeof extractMap !== "object" || Array.isArray(extractMap)) {
    return { ok: true, fields: {} };
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, fields: {} };
  }
  const fields = {};
  for (const [field, path] of Object.entries(extractMap)) {
    fields[field] = extractPath(data, String(path ?? ""));
  }
  return { ok: true, fields };
}

function extractPath(data, path) {
  let cur = data;
  for (const seg of path.split(".")) {
    if (cur == null) return null;
    if (seg === "length" && Array.isArray(cur)) return cur.length;
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(seg) ? Number(seg) : -1;
      cur = idx >= 0 && idx < cur.length ? cur[idx] : undefined;
    } else if (typeof cur === "object") {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur === undefined ? null : cur;
}

// Well-known vitality extract fields (§7.2: {last_event, inflow_rate}).
export const VITALITY_FIELDS = Object.freeze(["last_event", "inflow_rate"]);

/** Pull the vitality pair out of an extracted-field bag (missing → absent). */
export function vitalityOf(fields) {
  const lastEvent = fields?.last_event;
  const rate = fields?.inflow_rate;
  const out = {};
  if (lastEvent !== undefined && lastEvent !== null && lastEvent !== "") out.last_event = lastEvent;
  if (typeof rate === "number" && Number.isFinite(rate)) out.inflow_rate = rate;
  return out;
}

/**
 * Parse the authoring model's reply (BET-1438) into normalized §7.5 probe
 * entries, or null when nothing parseable came back. Tolerates a fenced block
 * and stray prose around the array; strips every key the validator does not
 * know; forces `method: "GET"` (the model is never trusted to say otherwise)
 * and defaults an omitted ring DOWN to "metadata" (the lowest ring — never
 * the reverse). Structurally broken entries are dropped; whatever survives
 * still faces the full validator inside writeSpec. An empty array is a valid
 * "nothing derivable" answer (distinct from null, the parse failure).
 */
export function parseProposedProbes(text) {
  if (text == null) return null;
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  let arr;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const item of arr.slice(0, AUTHOR_MAX_PROBES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const p = {};
    if (typeof item.name === "string" && item.name.trim()) p.name = item.name.trim();
    if (typeof item.url === "string" && item.url.trim()) p.url = item.url.trim();
    if (typeof item.cadence === "string" && item.cadence.trim()) p.cadence = item.cadence.trim();
    if (item.ring === "metadata" || item.ring === "deep_read") p.ring = item.ring;
    else p.ring = "metadata";
    if (item.extract && typeof item.extract === "object" && !Array.isArray(item.extract)) {
      p.extract = item.extract;
    }
    if (!p.name || !p.url || !p.cadence) continue;
    p.method = "GET";
    out.push(p);
  }
  return out;
}

/**
 * Escalation state machine (pure). `state` = the durable per-probe counters
 * `{fails, authFails, cardOpen}`. Returns the next state plus the ACTION to
 * take: `escalate` the first time the auth-failure streak reaches 3 (the
 * returned state already carries cardOpen:true), `resolve` when a success
 * lands while a card is open (cardOpen cleared). Both streaks are
 * consecutive-sensitive: any success zeroes them; a non-auth failure keeps
 * `fails` but resets `authFails` (a 500 between 401s means the wire works and
 * the credential verdict must restart — no half-counted escalation). The
 * machine is self-consistent: a fourth auth failure with cardOpen already
 * true does not re-escalate.
 */
export function stepFailureState(state, outcome) {
  const prev = state ?? { fails: 0, authFails: 0, cardOpen: false };
  if (outcome === "success") {
    return { state: { fails: 0, authFails: 0, cardOpen: false }, action: prev.cardOpen ? "resolve" : null };
  }
  const authShaped = outcome === "auth";
  const authFails = authShaped ? prev.authFails + 1 : 0;
  const escalate = authShaped && authFails >= AUTH_FAIL_ESCALATE && !prev.cardOpen;
  return {
    state: { fails: prev.fails + 1, authFails, cardOpen: prev.cardOpen || escalate },
    action: escalate ? "escalate" : null,
  };
}

// ---------------------------------------------------------------------------
// §7.5 spec validation — the forge-rules-style error catalogue
// ---------------------------------------------------------------------------

/**
 * Validate a parsed probe spec. Returns `{ok, errors}` where every error names
 * the offending key BY NAME (pluginManifest.mjs style). `ctx`:
 *   tool          — the canonical tool id this file belongs to
 *   allowedHosts  — the tool's evidenced hosts (exact)
 *   consentedRing — the highest ring consented for the tool ("metadata" |
 *                   "deep_read" | null — null means nothing may run)
 */
export function validateProbeSpec(spec, { tool, allowedHosts = [], consentedRing = null } = {}) {
  const errors = [];
  const push = (key, message) => errors.push({ key, message });

  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, errors: [{ key: "", message: "probe spec must be a YAML mapping" }] };
  }

  const allowedTop = ["tool", "auth", "probes"];
  for (const k of Object.keys(spec)) {
    if (!allowedTop.includes(k)) push(k, `unknown probe-spec key "${k}"`);
  }
  if (typeof spec.tool !== "string" || !IDENTIFIER_RE.test(spec.tool)) {
    push("tool", `probe spec "tool" must match ${IDENTIFIER_RE}`);
  } else if (tool && spec.tool !== tool) {
    push("tool", `probe spec "tool" is "${spec.tool}" but this file belongs to "${tool}"`);
  }

  if (spec.auth !== undefined) {
    if (!spec.auth || typeof spec.auth !== "object" || Array.isArray(spec.auth)) {
      push("auth", `"auth" must be a mapping`);
    } else {
      for (const k of Object.keys(spec.auth)) {
        if (k !== "secret" && k !== "header") push(`auth.${k}`, `unknown auth key "auth.${k}"`);
      }
      if (typeof spec.auth.secret !== "string" || !SECRET_KEY_RE.test(spec.auth.secret)) {
        push("auth.secret", `"auth.secret" must be a vault KEY NAME (${SECRET_KEY_RE}), never a value`);
      }
      if (typeof spec.auth.header !== "string") {
        push("auth.header", `"auth.header" must be a header template string`);
      } else {
        if (!spec.auth.header.includes(":")) {
          // A colon-less template would mangle the header NAME at run time
          // (everything before the first ":" becomes the name) and 401 into a
          // misleading rotated-key card — catch it at authoring time.
          push("auth.header", `"auth.header" must be a full header line "Name: value template" (missing ":")`);
        }
        const count = spec.auth.header.split(SECRET_PLACEHOLDER).length - 1;
        if (count !== 1) {
          push("auth.header", `"auth.header" must contain exactly one ${SECRET_PLACEHOLDER} placeholder (found ${count})`);
        }
      }
    }
  }

  if (!Array.isArray(spec.probes)) {
    push("probes", `"probes" must be an array (may be empty for a template)`);
  } else {
    for (let i = 0; i < spec.probes.length; i++) {
      const p = spec.probes[i];
      const at = `probes[${i}]`;
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        push(at, `${at} must be a mapping`);
        continue;
      }
      const allowedProbe = ["name", "method", "url", "extract", "cadence", "ring"];
      for (const k of Object.keys(p)) {
        if (!allowedProbe.includes(k)) push(`${at}.${k}`, `unknown probe key "${k}"`);
      }
      if (typeof p.name !== "string" || !IDENTIFIER_RE.test(p.name)) {
        push(`${at}.name`, `probe "name" must match ${IDENTIFIER_RE}`);
      }
      if (p.method !== "GET") {
        push(`${at}.method`, `probe method must be GET (got ${JSON.stringify(p.method ?? null)})`);
      }
      const parsed = parseProbeUrl(p.url);
      if (!parsed) {
        push(`${at}.url`, `probe "url" must be an https URL (≤ 2048 chars, no userinfo)`);
      } else if (!hostAllowed(parsed.host, allowedHosts)) {
        push(`${at}.url`, `probe host "${parsed.host}" is not on the tool's evidenced-host allowlist`);
      }
      if (p.extract !== undefined) {
        if (!p.extract || typeof p.extract !== "object" || Array.isArray(p.extract)) {
          push(`${at}.extract`, `"extract" must be a mapping of field → json-path`);
        } else {
          for (const [f, v] of Object.entries(p.extract)) {
            if (!IDENTIFIER_RE.test(f)) push(`${at}.extract.${f}`, `extract field "${f}" must match ${IDENTIFIER_RE}`);
            if (typeof v !== "string" || v.length === 0 || v.length > 256) {
              push(`${at}.extract.${f}`, `extract path for "${f}" must be a 1-256 char json-path string`);
            }
          }
        }
      }
      if (typeof p.cadence !== "string" || !CADENCE_RE.test(p.cadence)) {
        push(`${at}.cadence`, `probe "cadence" must look like "<n>s|m|h|d" (got ${JSON.stringify(p.cadence ?? null)})`);
      } else {
        const ms = cadenceMs(p.cadence);
        if (ms < CADENCE_FLOOR_MS) {
          push(`${at}.cadence`, `probe cadence ${p.cadence} is below the 5m floor (§7.5)`);
        }
      }
      if (!PROBE_RINGS.includes(p.ring)) {
        push(`${at}.ring`, `probe "ring" must be one of ${PROBE_RINGS.join(" | ")}`);
      } else {
        const consented = RING_LEVELS[consentedRing] ?? 0;
        if (RING_LEVELS[p.ring] > consented) {
          push(`${at}.ring`, `probe ring "${p.ring}" exceeds the tool's consented ring ("${consentedRing ?? "none"}")`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// The default transport — resolve-then-pinned-connect (SSRF-safe §7.5)
// ---------------------------------------------------------------------------

class ProbeHttpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Consume an https response with the §7.5 enforcement: 10 s wall timeout and
 * a 256 KB body cap. Exported (over a plain Readable) so tests exercise the
 * cap/timeout with PassThrough streams — no sockets.
 */
export function consumeResponse(res, { maxBytes = RESPONSE_CAP_BYTES, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      res.destroy();
      reject(new ProbeHttpError("timeout", `probe exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(timer);
        res.destroy();
        reject(new ProbeHttpError("too_large", `probe body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      clearTimeout(timer);
      resolve({ bodyText: Buffer.concat(chunks).toString("utf-8") });
    });
    res.on("error", (err) => {
      clearTimeout(timer);
      reject(new ProbeHttpError("socket", err?.message ?? "socket error"));
    });
  });
}

/**
 * The default §7.5 request: https GET only. DNS-resolves the host FIRST,
 * refuses every private/reserved result, then pins the connection to the
 * validated addresses via a custom `lookup` (no rebinding window) while
 * keeping SNI (`servername`) + the Host header on the hostname. Redirects are
 * never followed — a 3xx is returned as a status and the runner records a
 * failure row, so nothing off-list is ever hit.
 */
export function defaultHttpRequest({ url, headers = {}, dnsLookup = dns.lookup } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = parseProbeUrl(url);
    if (!parsed) {
      reject(new ProbeHttpError("bad_url", "probe URL must be https"));
      return;
    }
    dnsLookup(parsed.url.hostname, { all: true, verbatim: true }, (err, results) => {
      if (err) {
        reject(new ProbeHttpError("dns_failed", err?.message ?? "dns lookup failed"));
        return;
      }
      const addresses = publicAddresses(results);
      if (addresses.length === 0) {
        reject(new ProbeHttpError("dns_private", "probe host resolved only to private/reserved addresses"));
        return;
      }
      let settled = false;
      const settle = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const fail = (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      const req = https.request(
        {
          host: parsed.url.hostname,
          servername: parsed.url.hostname,
          path: `${parsed.url.pathname}${parsed.url.search}`,
          method: "GET",
          headers: { host: parsed.url.host, ...headers },
          // Pin the socket to the validated addresses only; SNI + Host keep
          // the hostname so CDNs and vhosts still route.
          lookup: (hostname, opts, cb) => {
            const family = opts?.family === 6 ? 6 : opts?.family === 4 ? 4 : 0;
            const pick = addresses.find((a) => family === 0 || a.family === family) ?? addresses[0];
            process.nextTick(() => cb(null, pick.address, pick.family ?? 4));
          },
          timeout: PROBE_TIMEOUT_MS,
        },
        (res) => {
          consumeResponse(res)
            .then((body) => settle({ status: res.statusCode ?? 0, ...body }))
            .catch(fail);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        fail(new ProbeHttpError("timeout", `probe exceeded ${PROBE_TIMEOUT_MS}ms`));
      });
      req.on("error", (err) => {
        fail(new ProbeHttpError("socket", err?.message ?? "request failed"));
      });
      req.end();
    });
  });
}

// Classify an on-wire status into the escalation vocabulary. Auth-shaped =
// 401/403; everything else is a plain failure (health row only).
export function classifyOutcome(status) {
  if (status === 401 || status === 403) return "auth";
  return "fail";
}

export function classifyError(err) {
  if (err?.code === "secret_missing") return { outcome: "auth", error: "secret_missing" };
  return { outcome: "fail", error: err?.code || String(err?.message ?? "unknown").slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Hosts from evidence rows (BET-1395 channel shapes)
// ---------------------------------------------------------------------------

/**
 * Extract the exact host from an evidence detail row. Known channel shapes:
 * `domain:<host>`, `git:<host>[/:…]`, `mcp:<name>:<host>`,
 * `forge:<host>/<owner>/<repo>`. Secret/cli/webhook/schedule rows carry no
 * host and never widen the allowlist.
 */
export function evidenceHost(detail) {
  if (typeof detail !== "string") return null;
  const ok = (h) => (h && HOSTLIKE_RE.test(h) ? h.toLowerCase() : null);
  if (detail.startsWith("domain:")) return ok(detail.slice("domain:".length));
  if (detail.startsWith("git:")) return ok(detail.slice("git:".length).split(/[/:]/)[0]);
  if (detail.startsWith("mcp:")) return ok(detail.split(":")[2]);
  if (detail.startsWith("forge:")) return ok(detail.slice("forge:".length).split("/")[0]);
  return null;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * `createProbes(deps)` — injected I/O everywhere; the engine owns the tick.
 *   registry      — the tool-registry engine (consentFor, toolRow,
 *                   applyProbeResult, applyRelevance, appendEvidence). Required.
 *   probes        — YAML spec store (default: the ctoStores one; needs list()).
 *   stateStore    — per-tool probe state dir store (default probeStateStore).
 *   cards, ledger — the needs-you cards engine + A1 ledger (both default).
 *   now           — clock.
 *   httpRequest   — the §7.5 transport (default: defaultHttpRequest).
 *   getSecretPath — async (keyName) => path | null (default: the shared
 *                   provideSecret machinery, usage-recording suppressed).
 *   readSecret    — async (path) => string (default fs.readFile utf-8).
 *   isThrifty     — () => boolean (live engine thrifty flag).
 *   listProjects  — async () => [projectName] (active projects for §7.6).
 *   getTopFacts   — async (project, k) => [{statement}].
 *   getRollups    — async () => raw recent day-rollup payloads (the box-wide
 *                   store contents, oldest-first, each {level, window, bullets:
 *                   [{text, refs}]}); the runner projects them per project
 *                   itself (BET-1439 — the relevance context is per-project).
 *   resolveSegment— async (segmentId) => {project} | null — rollup-bullet
 *                   attribution through the canonical segment resolver (the
 *                   same seam the day-level fact sync uses). Absent → no
 *                   bullet ever attributes → every project falls back to a
 *                   facts-only rollup context.
 *   runEphemeral  — the pre-gated ephemeral session call (nano classify /
 *                   relevance score / BET-1438 spec authoring).
 */
export function createProbes(deps = {}) {
  const {
    registry,
    probes = probesStore,
    stateStore = probeStateStore,
    cards,
    ledger,
    now = () => Date.now(),
    httpRequest = defaultHttpRequest,
    // Default: the shared provideSecret machinery, BY REFERENCE, with usage
    // recording suppressed — a probe provide must never inflate the tool's
    // own engagement axis (that would make the registry a feedback loop of
    // its runner). Only shared/global secrets resolve without a session.
    getSecretPath = async (key) => {
      const r = await provideSecret({ key }, { recordUsage: async () => {} });
      return r?.ok ? r.path : null;
    },
    readSecret = (path) => readFile(path, "utf-8"),
    isThrifty = () => false,
    listProjects = async () => [],
    getTopFacts = async () => [],
    getRollups = async () => [],
    resolveSegment = null,
    runEphemeral,
  } = deps;
  if (!registry || typeof registry.consentFor !== "function" || typeof registry.applyProbeResult !== "function") {
    throw new Error("createProbes requires a tool registry with consentFor() + applyProbeResult()");
  }

  const state = stateStore;

  function probeKey(tool, probeName) {
    return `${tool}/${probeName}`;
  }

  async function loadToolState(tool) {
    try {
      const payload = await state.load(tool);
      return payload && typeof payload === "object" ? payload : {};
    } catch {
      return {};
    }
  }

  async function saveToolState(tool, payload) {
    try {
      await state.save(tool, payload);
    } catch {
      /* state persistence is best-effort; the run continues */
    }
  }

  // Open probe-failure blocker ids (thrifty exemption: probes backing an open
  // card keep running so the card's liveness predicate can resolve).
  async function openProbeBlockers() {
    if (!cards || typeof cards.listOpen !== "function") return new Set();
    try {
      const open = await cards.listOpen();
      return new Set(
        (open ?? [])
          .filter((c) => c?.sourceKind === PROBE_SOURCE_KIND && typeof c?.sourceId === "string")
          .map((c) => c.sourceId),
      );
    } catch {
      return new Set();
    }
  }

  // Consent + host allowlist for one tool, straight from the registry.
  async function consentContext(tool) {
    const row = await registry.toolRow(tool);
    let consentedRing = null;
    if ((await registry.consentFor(tool, "metadata")) === "yes") consentedRing = "metadata";
    if (consentedRing && (await registry.consentFor(tool, "deep_read")) === "yes") consentedRing = "deep_read";
    const hosts = new Set();
    for (const e of row?.evidence ?? []) {
      const host = evidenceHost(e?.detail);
      if (host) hosts.add(host);
    }
    return { consentedRing, allowedHosts: [...hosts], row };
  }

  // §10.5 row-4 drill-down read (BET-1399): per-probe cadence + last result
  // for one tool. Reads the spec (declared cadence) + the per-probe state
  // (last result, effective next run, escalation counters). Probes only run
  // while metadata consent is "yes" — a consent-off tool reports
  // `consented: false` with an empty probe list so the drill-down can say why
  // nothing runs. Read-only: never writes state or raises asks.
  async function probeSummary(toolId) {
    const tool = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!tool) return { tool: "", consented: false, configured: false, probes: [] };
    let consented = false;
    try {
      consented = (await registry.consentFor(tool, "metadata")) === "yes";
    } catch {
      consented = false;
    }
    const specInfo = consented ? await validSpecFor(tool) : null;
    if (!specInfo) return { tool, consented, configured: false, probes: [] };
    let vit = null;
    try {
      vit = registry.toolRow ? await registry.toolRow(tool) : null;
    } catch {
      vit = null;
    }
    const st = await loadToolState(tool);
    const rows = (Array.isArray(specInfo.spec.probes) ? specInfo.spec.probes : [])
      .filter((p) => p && typeof p.name === "string" && p.name.length > 0)
      .map((p) => {
        const declared = cadenceMs(p.cadence);
        const pst = st?.probes?.[p.name] ?? null;
        return {
          name: p.name,
          cadenceMs: declared,
          effectiveMs: effectiveCadenceMs(declared, vit?.vitality),
          lastAt: pst?.lastAt ?? null,
          lastOk: pst?.lastOk ?? null,
          lastError: pst?.lastError ?? null,
          lastStatus: pst?.lastStatus ?? null,
          nextRunAt: pst?.nextRunAt ?? null,
          fails: pst?.fails ?? 0,
          authFails: pst?.authFails ?? 0,
        };
      });
    return { tool, consented, configured: rows.length > 0, probes: rows };
  }


  async function validSpecFor(tool) {
    let raw;
    try {
      raw = await probes.load(tool);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const ctx = await consentContext(tool);
    const check = validateProbeSpec(raw, { tool, allowedHosts: ctx.allowedHosts, consentedRing: ctx.consentedRing });
    if (check.ok) return { spec: raw, ctx };
    // A consent REVOCATION narrows the tool's ring after authoring: ring-
    // escalation errors drop just those probes (the tool's metadata probes
    // keep running — losing deep_read must not invalidate the whole spec).
    // Any other validation failure still does.
    const escalated = new Set(check.errors.filter((e) => typeof e?.key === "string" && e.key.endsWith(".ring")).map((e) => e.key));
    if (escalated.size === 0 || check.errors.length > escalated.size) return null;
    const kept = (Array.isArray(raw.probes) ? raw.probes : []).filter((_, i) => !escalated.has(`probes[${i}].ring`));
    if (kept.length === 0) return null;
    return { spec: { ...raw, probes: kept }, ctx };
  }

  // ---- spec authoring (engine-written; the AI's content goes through here) —

  /** Write the §7.5 template for a tool at consent time. Never overwrites. */
  async function scaffoldSpec(tool, { secret = null } = {}) {
    let existing = null;
    try {
      existing = await probes.load(tool);
    } catch {
      existing = null; // no spec yet (the common consent-time case)
    }
    if (existing && typeof existing === "object" && (existing.tool || Array.isArray(existing.probes))) {
      return { changed: false };
    }
    const spec = { tool, probes: [] };
    // A credential is already evidenced for this tool → pre-fill the auth
    // template (key NAME only; the header template is the common default the
    // AI may adjust — a wrong one fails 401 into the §10.6-7 card path).
    if (secret && SECRET_KEY_RE.test(secret)) {
      spec.auth = { secret, header: `Authorization: Bearer ${SECRET_PLACEHOLDER}` };
    }
    await probes.save(tool, spec);
    return { changed: true };
  }

  /**
   * The ONE write path for probe specs (AI-authored, engine-written): the
   * candidate content is validated against the tool's CURRENT consent ring +
   * evidence hosts before a byte lands on disk; invalid content is refused
   * with the error catalogue.
   */
  async function writeSpec(tool, candidate) {
    const ctx = await consentContext(tool);
    const check = validateProbeSpec(candidate, { tool, allowedHosts: ctx.allowedHosts, consentedRing: ctx.consentedRing });
    if (!check.ok) return { ok: false, errors: check.errors };
    await probes.save(tool, candidate);
    return { ok: true, errors: [] };
  }

  // ---- §7.5 spec authoring (BET-1438) ---------------------------------------

  // A refused authored candidate (or an unparseable model reply) must surface
  // on the tool's evidence trail — the trail the connect ask and the §10.5
  // drill-down read — plus a ledger row. Never silent. The row never widens
  // the host allowlist (`spec-refused:` is not an evidenceHost channel) and
  // dedupes naturally on the refusal key.
  async function surfaceRefusal(tool, reason, ts, errorCount = 1) {
    try {
      await registry.appendEvidence?.(tool, { channel: "probe", detail: `spec-refused:${reason}`.slice(0, 200), ts });
    } catch {
      /* best-effort */
    }
    if (ledger && typeof ledger.append === "function") {
      try {
        await ledger.append({ actor: "cto", kind: "cto.probe.author", tool, ok: false, refused: reason, errors: errorCount, ts });
      } catch {
        /* best-effort */
      }
    }
  }

  // One nano call (the SAME §3.3-gated seam the registry's classifier rides):
  // the tool's evidence rows → a JSON array of probe proposals. Untrusted
  // context, structured-only output — the validator inside writeSpec is the
  // only thing that makes any of it real. Returns null on a gate rejection /
  // transport / parse failure, [] when nothing is derivable.
  async function proposeProbes({ tool, row, allowedHosts, ring, auth }) {
    const evidenceLines = (row?.evidence ?? [])
      .map((e) => (typeof e?.detail === "string" ? `- ${e.channel}: ${e.detail.slice(0, 120)}` : ""))
      .filter(Boolean)
      .slice(0, 8);
    const prompt = [
      `Fill the probe-spec template for external tool "${tool}".`,
      `Evidenced hosts (a probe URL may use ONLY one of these, exactly): ${allowedHosts.join(", ") || "(none)"}`,
      auth?.secret
        ? `A credential is evidenced; the template's auth section already names its vault key (${auth.secret}) — do not propose auth content.`
        : "No credential is evidenced — propose only unauthenticated endpoints.",
      ring === "deep_read"
        ? 'Consented access ring is deep_read: probes may declare ring "metadata" or "deep_read".'
        : 'Consented access ring is metadata: every probe must declare ring "metadata".',
      "Observed evidence for this tool:",
      ...evidenceLines,
      "",
      `Propose up to ${AUTHOR_MAX_PROBES} declarative GET probes reading small, useful JSON (counts, latest timestamps, status fields) from the evidenced hosts.`,
      'Reply with ONLY a JSON array, each element {"name": "<kebab-case-id>", "url": "https://<evidenced-host>/...", "cadence": "<n>m|h|d (>=5m)", "ring": "metadata" or "deep_read", "extract": {"<field>": "<json.path"}}. No prose.',
    ].join("\n");
    let text = null;
    try {
      const out = await runEphemeral({ taskClass: AUTHORING_TASK_CLASS, context: [{ priority: 10, text: prompt }] });
      text = typeof out === "string" ? out : (out?.text ?? out?.output ?? null);
    } catch {
      return null;
    }
    return parseProposedProbes(text);
  }

  /**
   * The ephemeral authoring pass: per consented tool whose spec is still the
   * EMPTY scaffold (`probes: []`), propose probe entries from the evidence
   * rows and fill the template through writeSpec — the ONE validated,
   * engine-written path. Pacing mirrors the relevance scan: the daily budget
   * bounds ATTEMPTS (a failed or gate-rejected call consumes it too and sets
   * a retry watermark), a filled or not-derivable template rests for the
   * week, and the pass is one-shot — once a spec carries probes it is never
   * rewritten here. Refused candidates are never silent (surfaceRefusal).
   * Not thrifty-shed: a still-empty template is at most one paced nano call,
   * not a fan-out.
   */
  async function authorSpecs({ ts = now(), todayKey = dayKeyOf(ts) } = {}) {
    if (typeof runEphemeral !== "function") return { ran: 0, attempts: 0, skipped: "no-ephemeral" };
    let tools;
    try {
      tools = await probes.list();
    } catch {
      return { ran: 0, attempts: 0 };
    }
    let st;
    try {
      st = (await state.load("_authoring")) ?? {};
    } catch {
      st = {};
    }
    if (st.day !== todayKey) {
      st.day = todayKey;
      st.todayCount = 0;
    }
    let budget = AUTHORING_PER_DAY - (st.todayCount ?? 0);
    let ran = 0;
    let attempts = 0;
    for (const tool of tools) {
      if (budget <= 0) break;
      if ((await registry.consentFor(tool, "metadata")) !== "yes") continue;
      let raw;
      try {
        raw = await probes.load(tool);
      } catch {
        continue;
      }
      // Target ONLY the empty scaffold; a spec that already carries probes is
      // user/engine content this pass must never rewrite.
      if (!raw || typeof raw !== "object" || raw.tool !== tool || !Array.isArray(raw.probes) || raw.probes.length > 0) {
        continue;
      }
      const entry = st.relAt?.[tool] ?? {};
      const restMs = entry.ok ? AUTHORING_WEEK_MS : AUTHORING_FAILURE_RETRY_MS;
      if (typeof entry.at === "number" && ts - entry.at < restMs) continue;
      st.relAt = { ...(st.relAt ?? {}), [tool]: entry };
      const ctx = await consentContext(tool);
      budget -= 1; // the attempt itself is the paced resource
      attempts += 1;
      const proposals = await proposeProbes({
        tool,
        row: ctx.row,
        allowedHosts: ctx.allowedHosts,
        ring: ctx.consentedRing,
        auth: raw.auth ?? null,
      });
      entry.at = ts;
      if (proposals === null) {
        entry.ok = false;
        await surfaceRefusal(tool, "unparseable-reply", ts);
        continue;
      }
      if (proposals.length === 0) {
        entry.ok = true; // nothing derivable — rest for the week, no write
        if (ledger && typeof ledger.append === "function") {
          await ledger.append({ actor: "cto", kind: "cto.probe.author", tool, ok: true, probes: 0, ts }).catch(() => {});
        }
        continue;
      }
      const res = await writeSpec(tool, { tool, ...(raw.auth ? { auth: raw.auth } : {}), probes: proposals });
      entry.ok = res.ok === true;
      if (res.ok) {
        ran += 1;
        if (ledger && typeof ledger.append === "function") {
          await ledger.append({ actor: "cto", kind: "cto.probe.author", tool, ok: true, probes: proposals.length, ts }).catch(() => {});
        }
      } else {
        await surfaceRefusal(tool, res.errors?.[0]?.key ?? "invalid", ts, res.errors?.length ?? 1);
      }
    }
    if (attempts > 0) {
      st.todayCount = (st.todayCount ?? 0) + attempts;
      await saveToolState("_authoring", st);
    }
    return { ran, attempts };
  }

  // ---- one probe execution -------------------------------------------------

  // Resolve the secret AT SPAWN, by reference: vault KEY NAME → materialized
  // file path → read inside this closure only. Usage is deliberately NOT
  // recorded (provideSecret with a no-op recorder) so the runner can never
  // inflate the tool's own engagement axis.
  async function buildHeaders(specAuth) {
    if (!specAuth) return {};
    let path = null;
    if (typeof getSecretPath === "function") {
      path = await getSecretPath(specAuth.secret);
    }
    if (!path) {
      throw new ProbeHttpError("secret_missing", `secret "${specAuth.secret}" is not available`);
    }
    const value = (await readSecret(path)).trim();
    if (!value) throw new ProbeHttpError("secret_missing", `secret "${specAuth.secret}" materialized empty`);
    const idx = specAuth.header.indexOf(":");
    const name = specAuth.header.slice(0, idx).trim();
    const template = specAuth.header.slice(idx + 1).trim();
    // Function replacement: a secret containing `$&`-style sequences must
    // land verbatim.
    const value_ = template.replace(SECRET_PLACEHOLDER_RE, () => value);
    return { [name]: value_ };
  }

  async function runOne(tool, spec, probe, st, { ts = now() } = {}) {
    const startedAt = ts;
    let status = 0;
    let bodyText = null;
    let error = null;
    let outcome = "fail";
    try {
      const headers = await buildHeaders(spec.auth);
      const out = await httpRequest({ url: probe.url, headers });
      status = out.status;
      bodyText = out.bodyText;
      outcome = classifyOutcome(status);
      if (!(status >= 200 && status < 300)) error = `http_${status}`;
    } catch (err) {
      const c = classifyError(err);
      outcome = c.outcome;
      error = c.error;
    }

    const ok = outcome === "fail" && status >= 200 && status < 300 && error === null;
    let fields = {};
    if (ok && bodyText !== null) {
      const ex = extractFields(bodyText, probe.extract);
      if (ex.ok) fields = ex.fields;
    }
    bodyText = null; // untrusted raw body never persists

    const key = probe.name;
    const prev = st?.probes?.[key] ?? { fails: 0, authFails: 0, cardOpen: false };
    const { state: nextState, action } = stepFailureState(prev, ok ? "success" : outcome);

    const row = {
      kind: "cto.probe.result",
      tool,
      probe: probeKey(tool, key),
      ok,
      status,
      durMs: Math.max(0, now() - startedAt),
      ...(ok ? { fields: pruneFields(fields) } : { error: error ?? "unknown" }),
      ts,
    };
    if (ledger && typeof ledger.append === "function") {
      try {
        await ledger.append({ actor: "cto", ...row });
      } catch {
        /* best-effort */
      }
    }

    const vit = registry.toolRow ? await registry.toolRow(tool) : null;
    let cadence = effectiveCadenceMs(cadenceMs(probe.cadence), vit?.vitality);
    // §7.6 decay chain (BET-1404, Q2 cascade): a chain-tripped tool probes at
    // most weekly — the registry is the chain's source of truth, the runner
    // just asks. The cap only ever slows probing down (max, never min).
    if (registry.probeCadenceCapMs) {
      try {
        const cap = await registry.probeCadenceCapMs(tool);
        if (Number.isFinite(cap) && cap > 0) cadence = Math.max(cadence, cap);
      } catch {
        /* best-effort — the standard cadence stands */
      }
    }

    if (ok) {
      // Vitality + adaptive cadence + lifecycle (§7.3, §7.4).
      try {
        await registry.applyProbeResult(tool, { fields, probedAt: ts, cadenceMs: cadence, probeName: key });
      } catch {
        /* vitality is best-effort */
      }
    } else {
      // Failure evidence on the registry row (the connect-ask evidence trail).
      try {
        await registry.appendEvidence?.(tool, { channel: "probe", detail: `${key}:${error ?? status}`, ts });
      } catch {
        /* best-effort */
      }
    }

    // Escalation / resolution (§10.6-7) — nextState already carries cardOpen.
    const p = st.probes ?? {};
    p[key] = {
      ...nextState,
      lastAt: ts,
      lastOk: ok,
      lastError: ok ? null : (error ?? "unknown"),
      lastStatus: status,
      nextRunAt: ts + cadence,
    };
    st.probes = p;
    if (action === "escalate" && cards && typeof cards.upsertBlocker === "function") {
      const copy = probeBlockerCopy(tool, key, spec.auth?.secret ?? null);
      await cards
        .upsertBlocker({
          sourceKind: PROBE_SOURCE_KIND,
          sourceId: probeKey(tool, key),
          title: copy.title,
          body: copy.body,
          refs: [tool],
          ts,
        })
        .catch(() => {});
    } else if (action === "resolve" && cards && typeof cards.resolveById === "function") {
      await cards.resolveById(stableCardId(PROBE_SOURCE_KIND, probeKey(tool, key)), { reason: "probe recovered", ts }).catch(() => {});
    }
    await saveToolState(tool, st);
    return row;
  }

  // Keep only the tiny extracted fields in ledger rows — the extract map is
  // authored content, so cap every value defensively.
  function pruneFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === undefined || v === null) continue;
      const s = typeof v === "object" ? JSON.stringify(v) : v;
      out[k] = typeof s === "string" && s.length > 256 ? `${s.slice(0, 253)}...` : s;
    }
    return out;
  }

  // ---- §10.5 A12 probe-health read ------------------------------------------

  // One snapshot over the CONSENTED tools' valid specs: how many probes are
  // configured, how many reported healthy on their last run, how many are in
  // the auth-failure state (their §10.6-7 card is the escalation), and when
  // the most recent run happened. Pure read — the endpoint composes the row.
  async function healthSnapshot() {
    const out = { tools: 0, probes: 0, healthy: 0, authFailed: 0, lastRunAt: null };
    let tools;
    try {
      tools = await probes.list();
    } catch {
      return out;
    }
    for (const tool of tools) {
      const valid = await validSpecFor(tool);
      if (!valid) continue;
      out.tools += 1;
      const st = await loadToolState(tool);
      for (const probe of valid.spec.probes) {
        out.probes += 1;
        const pst = st.probes?.[probe.name];
        if (!pst) continue; // never ran yet — counts toward n, not healthy
        if (typeof pst.lastAt === "number" && (out.lastRunAt == null || pst.lastAt > out.lastRunAt)) {
          out.lastRunAt = pst.lastAt;
        }
        if (pst.lastOk) out.healthy += 1;
        else if (pst.lastError === "secret_missing" || pst.lastStatus === 401 || pst.lastStatus === 403) {
          out.authFailed += 1;
        }
      }
    }
    return out;
  }

  // ---- the tick ------------------------------------------------------------

  /**
   * Run every due probe across every consented tool. `opts.forceTool` runs
   * one tool's probes regardless of nextRunAt (diagnostics/tests). Thrifty
   * sheds non-blocker-relevant probes (§12.2 rung 2).
   */
  async function runDue({ forceTool = null, ts = now() } = {}) {
    const results = [];
    let tools;
    try {
      tools = await probes.list();
    } catch {
      return results;
    }
    const exempt = await openProbeBlockers();
    const thrifty = isThrifty() === true;
    for (const tool of tools) {
      if (forceTool && tool !== forceTool) continue;
      const valid = await validSpecFor(tool);
      if (!valid) continue;
      const { spec } = valid;
      const st = await loadToolState(tool);
      if (!st.probes || typeof st.probes !== "object") st.probes = {};
      let touched = false;
      for (const probe of spec.probes) {
        const pst = st.probes[probe.name] ?? {};
        const due =
          forceTool === tool ||
          pst.nextRunAt === undefined ||
          (typeof pst.nextRunAt === "number" && pst.nextRunAt <= ts);
        if (!due) continue;
        if (thrifty && !exempt.has(probeKey(tool, probe.name))) continue;
        // Deep-ring probes run only while the tool's deep_read consent is
        // CURRENTLY "yes" (BET-1404). The authoring gate validated the spec
        // against the ring at write time; this re-checks the live source of
        // truth so a revocation stops deep probes on the next tick without
        // invalidating the tool's metadata probes.
        if (probe.ring === "deep_read") {
          let deepOk = false;
          try {
            deepOk = (await registry.consentFor(tool, "deep_read")) === "yes";
          } catch {
            deepOk = false;
          }
          if (!deepOk) continue;
        }
        results.push(await runOne(tool, spec, probe, st, { ts }));
        touched = true;
      }
      if (touched) await saveToolState(tool, st);
    }
    return results;
  }

  // ---- §7.6 relevance (scoring half only) -----------------------------------

  function dayKeyOf(ts) {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }

  /**
   * Weekly per consented tool × active project: one nano call matching the
   * tool's data domain against the project's top facts + the project's OWN
   * recent rollups (BET-1439 — the context is per-project, never the box-wide
   * slice) →
   * `relevance[project] ∈ [0,1]`. Pacing bounds ATTEMPTS: every call —
   * success or failure — consumes the RELEVANCE_PER_DAY budget, and a failed
   * call also sets a RELEVANCE_FAILURE_RETRY_MS watermark so a persistently
   * failing or gate-rejecting model cannot retry one pair per minute-tick
   * indefinitely (review cycle 1, Question 1). Successful pairs then rest
   * for the week.
   */
  async function relevanceScan({ ts = now(), todayKey = dayKeyOf(ts) } = {}) {
    if (typeof runEphemeral !== "function") return { ran: 0, attempts: 0, skipped: "no-ephemeral" };
    let tools;
    try {
      tools = await probes.list();
    } catch {
      return { ran: 0, attempts: 0 };
    }
    let projects = [];
    try {
      projects = (await listProjects()) ?? [];
    } catch {
      projects = [];
    }
    if (tools.length === 0 || projects.length === 0) return { ran: 0, attempts: 0 };
    let st;
    try {
      st = (await state.load("_relevance")) ?? {};
    } catch {
      st = {};
    }
    if (st.day !== todayKey) {
      st.day = todayKey;
      st.todayCount = 0;
    }
    let budget = RELEVANCE_PER_DAY - (st.todayCount ?? 0);
    let ran = 0;
    let attempts = 0;
    // The raw box-wide day-rollup source is fetched at most once per scan and
    // only on first need (a resting pair never pays for the read); the
    // per-project projection happens per pair below.
    let rawRollups = null;
    const rollupSource = async () => {
      if (rawRollups === null) rawRollups = await getRollups().catch(() => []);
      return Array.isArray(rawRollups) ? rawRollups : [];
    };
    for (const tool of tools) {
      if (budget <= 0) break;
      if ((await registry.consentFor(tool, "metadata")) !== "yes") continue;
      const valid = await validSpecFor(tool);
      if (!valid) continue;
      const row = valid.ctx.row ?? (await registry.toolRow(tool));
      const relAt = st.relAt?.[tool] ?? {};
      const domain = toolDomain(row);
      let toolTouched = false;
      for (const project of projects) {
        if (budget <= 0) break;
        const entry = relAt[project];
        const restMs = entry?.ok ? RELEVANCE_WEEK_MS : RELEVANCE_FAILURE_RETRY_MS;
        if (entry && typeof entry.at === "number" && ts - entry.at < restMs) continue;
        const facts = await getTopFacts(project, 5).catch(() => []);
        const rollups = await projectRollupContext(await rollupSource(), project, resolveSegment);
        if (!factLines(facts) && !rollupLines(rollups)) {
          relAt[project] = { at: ts, ok: true }; // nothing to match against — do not retry all week
          toolTouched = true;
          continue;
        }
        budget -= 1; // the attempt itself is the paced resource
        attempts += 1;
        toolTouched = true;
        const score = await scoreRelevance({ tool, domain, project, facts, rollups });
        relAt[project] = { at: ts, ok: score !== null };
        if (score === null) continue; // retried after the failure watermark, still budget-bounded
        ran += 1;
        try {
          await registry.applyRelevance(tool, project, score);
        } catch {
          /* best-effort */
        }
        if (ledger && typeof ledger.append === "function") {
          await ledger
            .append({ actor: "cto", kind: "cto.tool.relevance", tool, project, relevance: score, ts })
            .catch(() => {});
        }
      }
      st.relAt = { ...(st.relAt ?? {}), [tool]: relAt };
      if (toolTouched) await saveToolState("_relevance", st);
    }
    if (attempts > 0) {
      st.todayCount = (st.todayCount ?? 0) + attempts;
      await saveToolState("_relevance", st);
    }
    return { ran, attempts };
  }

  /**
   * §7.6 relevance context selection (BET-1439): the project's OWN rollup
   * lines, projected from the box-wide day-rollup store through the canonical
   * segment-attribution mapper (`ctoRollups.proposalsFromRollup` — the same
   * mapper the day-level fact sync uses). Newest rollup first, early stop at
   * five lines. A bullet that resolves to no project — or to a different
   * project — never enters the context: a cross-project slice would actively
   * mislead the per-project scoring. Returns "" when nothing attributes, which
   * is the documented fallback: the nano call then runs on the project's top
   * facts alone rather than a misleading box-wide rollup.
   */
  async function projectRollupContext(dayRollups, project, resolveSegmentFn) {
    if (!Array.isArray(dayRollups) || dayRollups.length === 0) return "";
    const resolve = resolveSegmentFn ?? (async () => null);
    const out = [];
    for (let i = dayRollups.length - 1; i >= 0 && out.length < 5; i--) {
      const rollup = dayRollups[i];
      if (!rollup || rollup.level !== "day" || !Array.isArray(rollup.bullets)) continue;
      let proposals;
      try {
        proposals = await proposalsFromRollup(rollup, { resolveSegment: resolve });
      } catch {
        continue;
      }
      for (const p of proposals) {
        if (p?.project !== project || typeof p?.statement !== "string" || !p.statement) continue;
        out.push(p.statement);
        if (out.length >= 5) break;
      }
    }
    return out.join("\n");
  }

  function factLines(facts) {
    return (facts ?? [])
      .map((f) => (typeof f?.statement === "string" && f.statement ? f.statement : typeof f?.text === "string" ? f.text : ""))
      .filter(Boolean)
      .slice(0, 5)
      .map((s) => `- ${s}`)
      .join("\n");
  }

  function rollupLines(rollups) {
    return String(rollups ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5)
      .join("\n");
  }

  function toolDomain(row) {
    const parts = [];
    for (const e of row?.evidence ?? []) {
      if (typeof e?.detail === "string") parts.push(e.detail.split(":").slice(1).join(":"));
    }
    return parts.slice(0, 5).join(", ") || row?.tool || "external data";
  }

  // One nano call (§7.6): the tool's data domain vs the project's facts +
  // recent rollups → [0,1]. Untrusted context, structured-only output.
  async function scoreRelevance({ tool, domain, project, facts, rollups }) {
    const prompt = [
      `Tool "${tool}" provides external data (evidence: ${domain}).`,
      `Project "${project}" blackboard facts:`,
      factLines(facts) || "(none)",
      rollupLines(rollups) ? `Recent rollups for this project:\n${rollupLines(rollups)}` : "",
      "",
      "Score how relevant this tool's data domain is to the project's active work: 0.0 (unrelated) to 1.0 (core data source for this work).",
      "Reply with ONLY the number.",
    ]
      .filter(Boolean)
      .join("\n");
    let text = null;
    try {
      const out = await runEphemeral({ taskClass: RELEVANCE_TASK_CLASS, context: [{ priority: 10, text: prompt }] });
      text = typeof out === "string" ? out : (out?.text ?? out?.output ?? null);
    } catch {
      return null;
    }
    const m = /(\d*\.?\d+)/.exec(String(text ?? ""));
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    // The prompt asks for 0..1; an out-of-range reply means "very relevant" —
    // clamp, never fabricate a mid-scale number.
    return Math.max(0, Math.min(1, n));
  }

  return { scaffoldSpec, writeSpec, authorSpecs, runDue, relevanceScan, healthSnapshot, probeKey, consentContext, loadToolState, probeSummary };
}
