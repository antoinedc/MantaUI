// accounts.mjs — the multi-account / multi-seat store for subscription providers
// (multi-account spec §2, phase 1: storage + discovery/migration + credential
// source resolution). Providers: "claude" and "codex" (the usage-adapter ids).
//
//   provider → account (one org / one plan) → seat (one signed-in login)
//
// WHAT LIVES WHERE
//   • ~/.manta/accounts.json (0600, atomic) — METADATA ONLY: labels, org/plan,
//     seat emails, the account uuid each seat is, mode + active seat. The only
//     secret-adjacent thing in it is a directory PATH. Credentials never go in
//     it and never leave the server.
//   • ~/.manta-secrets/accounts/claude/<seatId>/.credentials.json — a Claude
//     seat's own login (the `claude` CLI writes it there when run with
//     CLAUDE_CONFIG_DIR=<dir>).
//   • ~/.manta-secrets/accounts/codex/<seatId>/auth.json — a Codex seat's copy
//     of opencode's `openai` oauth entry.
//   • ~/.claude/.credentials.json — the LIVE Claude login (opencode's Claude
//     plugin and the `claude` CLI read and refresh THIS file).
//
// CREDENTIAL SOURCE IS RESOLVED AT READ TIME, NOT AT MIGRATION. The live file is
// whichever login is currently active, and it is the fresh copy (it is the one
// that gets refreshed); a seat directory holding the SAME login may carry a
// refresh token that has since been rotated out. So for each read: if the live
// login is this seat's account → read the live file, otherwise read the seat
// directory. See `resolveSeatSource` (pure).
//
// Discovery is idempotent and cheap to re-run: a seat already known and
// identified costs no network call. Only new / unidentified seats hit the
// profile endpoint, and the live login's identity is cached.
//
// Phase boundaries: no RPC channels and no sign-in here. Which seat a CONVERSATION
// uses lives in seatAssignment.mjs; this module only reports seat state to it.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { secretsRoot, statePath } from "../shared/paths.mjs";
import { writeJsonAtomic, createMutex } from "./jsonStore.mjs";
import { CREDENTIALS_PATH, parseCredentials } from "./claudeAuth.mjs";
import { opencodeAuthPath } from "./opencode.mjs";

export const ACCOUNT_PROVIDERS = ["claude", "codex"];

// Does each CONVERSATION get its own seat (spec §4, the request-path plugin)?
// Only while the `manta-accounts` plugin is demonstrably in the request path:
// without it every Claude/Codex request goes through the LIVE login, whatever
// the store says. The plugin proves it is there by calling resolve; each call
// stamps `lastPluginSeenAt`, and routing counts as active for a while after the
// last one. A plugin that is removed (or opencode restarted without it) fades
// out on its own — the aggregate goes back to following the serving seat.
export const PLUGIN_SEEN_WINDOW_MS = 10 * 60_000;
let lastPluginSeenAt = 0;

/** The plugin just called resolve (in-memory only: a server restart forgets it,
 *  and the next resolve — seconds away if the plugin is installed — restores it). */
export function notePluginSeen(at = Date.now()) {
  lastPluginSeenAt = at;
}

/** Is each conversation currently being routed to its own seat? */
export function perConversationRoutingActive(now = Date.now()) {
  return lastPluginSeenAt > 0 && now - lastPluginSeenAt <= PLUGIN_SEEN_WINDOW_MS;
}

/** Test seam: forget that the plugin was ever seen. */
export function resetPluginSeen() {
  lastPluginSeenAt = 0;
}
const STORE_VERSION = 1;
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// How long an identified live login is trusted without re-asking Anthropic. The
// cache is KEYED by the live file's token, so a swap (a different login in the
// file) is noticed immediately; the TTL only bounds how long an unchanged login
// goes unverified.
const LIVE_IDENTITY_TTL_MS = 60 * 60_000;
// A failed identity lookup is retried soon, not cached for an hour.
const LIVE_IDENTITY_FAIL_TTL_MS = 30_000;
// Discovery re-runs from the poller no more often than this.
const REDISCOVER_MS = 60_000;

// ---------------------------------------------------------------------------
// Pure: shape
// ---------------------------------------------------------------------------

/** @typedef {{id:string,label:string,email:string|null,accountUuid:string|null,credentialDir:string|null,status:"ok"|"unknown"|string}} Seat */
/** @typedef {{id:string,label:string,orgId:string|null,orgName:string|null,plan:string|null,seats:Seat[]}} Account */
/** @typedef {{mode:"auto"|"manual",activeSeatId:string|null,accounts:Account[]}} ProviderState */
/** @typedef {{version:number,providers:Record<string,ProviderState>}} AccountsStore */

export function emptyProviderState() {
  return { mode: "manual", activeSeatId: null, accounts: [] };
}

/** @returns {AccountsStore} */
export function emptyStore() {
  return { version: STORE_VERSION, providers: { claude: emptyProviderState(), codex: emptyProviderState() } };
}

const str = (v) => (typeof v === "string" && v ? v : null);

/** Defensive: whatever is on disk becomes a well-formed store (never throws). */
export function normalizeStore(raw) {
  const out = emptyStore();
  for (const provider of ACCOUNT_PROVIDERS) {
    const p = raw?.providers?.[provider];
    if (!p || typeof p !== "object") continue;
    const accounts = [];
    for (const a of Array.isArray(p.accounts) ? p.accounts : []) {
      const id = str(a?.id);
      if (!id) continue;
      const seats = [];
      for (const s of Array.isArray(a.seats) ? a.seats : []) {
        const sid = str(s?.id);
        if (!sid) continue;
        seats.push({
          id: sid,
          label: str(s.label) ?? sid,
          email: str(s.email),
          accountUuid: str(s.accountUuid),
          credentialDir: str(s.credentialDir),
          status: str(s.status) ?? "unknown",
        });
      }
      accounts.push({
        id,
        label: str(a.label) ?? id,
        orgId: str(a.orgId),
        orgName: str(a.orgName),
        plan: str(a.plan),
        seats,
      });
    }
    out.providers[provider] = {
      mode: p.mode === "auto" ? "auto" : "manual",
      activeSeatId: str(p.activeSeatId),
      accounts,
    };
  }
  return out;
}

/** @param {ProviderState} prov @returns {Seat[]} */
export function allSeats(prov) {
  return (prov?.accounts ?? []).flatMap((a) => a.seats);
}

/** The trailing number of an id like "seat-3" / "acct-2", else null. */
function idNumber(id) {
  const m = /-(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : null;
}

/** "seat-2" sorts before "seat-10"; non-numeric ids sort after, alphabetically. */
export function compareIds(a, b) {
  const na = idNumber(a);
  const nb = idNumber(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  return String(a).localeCompare(String(b));
}

/** The next free `<prefix>-N` not in `taken`. */
export function nextId(prefix, taken) {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/** Default label for a seat: "Seat N" from its id, else from its position. */
export function defaultSeatLabel(id, ordinal) {
  return `Seat ${idNumber(id) ?? ordinal}`;
}

const ORG_TYPE_LABEL = {
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  claude_max: "Max",
  claude_pro: "Pro",
  claude_free: "Free",
};

/**
 * Plan string from an Anthropic profile payload's organization block, e.g.
 * "Team · Max 5x". Null when nothing usable. Pure.
 */
export function planFromOrganization(org) {
  const type = ORG_TYPE_LABEL[org?.organization_type] ?? null;
  const tier = /max_(\d+x)/i.exec(String(org?.rate_limit_tier ?? ""))?.[1] ?? null;
  const tierLabel = tier ? `Max ${tier}` : null;
  if (type === "Max") return tierLabel ?? type;
  if (type && tierLabel) return `${type} · ${tierLabel}`;
  return type ?? tierLabel ?? null;
}

/**
 * Identity out of an Anthropic /api/oauth/profile payload. Null when the payload
 * has no account uuid (an identity without one cannot dedupe or resolve).
 * @returns {{accountUuid:string,email:string|null,orgId:string|null,orgName:string|null,plan:string|null}|null}
 */
export function identityFromProfile(profile) {
  const accountUuid = str(profile?.account?.uuid);
  if (!accountUuid) return null;
  return {
    accountUuid,
    email: str(profile?.account?.email),
    orgId: str(profile?.organization?.uuid),
    orgName: str(profile?.organization?.name),
    plan: planFromOrganization(profile?.organization),
  };
}

// ---------------------------------------------------------------------------
// Pure: credential source resolution
// ---------------------------------------------------------------------------

/**
 * Which file to read for a seat's credentials — decided per read, because the
 * live login can change under us (a manual swap, a re-sign-in).
 *
 *   1. the live login IS this seat's account → the LIVE file (the fresh copy);
 *   2. the seat has its own directory → that directory;
 *   3. a lone seat whose identity AND the live identity are both unknown → live
 *      (nothing says otherwise, and live is where fresh credentials are);
 *   4. a seat with no directory is, by construction, "whatever is live" — but
 *      only while the live login is not known to be somebody else.
 *   otherwise → none (the seat is signed out).
 *
 * @param {{seat: Seat, liveUuid: string|null, liveAvailable: boolean, seatCount: number}} args
 * @returns {{kind:"live"}|{kind:"dir",dir:string}|{kind:"none"}}
 */
export function resolveSeatSource({ seat, liveUuid, liveAvailable, seatCount }) {
  if (liveAvailable && seat.accountUuid && liveUuid && seat.accountUuid === liveUuid) return { kind: "live" };
  if (seat.credentialDir) {
    if (liveAvailable && !seat.accountUuid && !liveUuid && seatCount === 1) return { kind: "live" };
    return { kind: "dir", dir: seat.credentialDir };
  }
  if (liveAvailable && (!seat.accountUuid || !liveUuid)) return { kind: "live" };
  return { kind: "none" };
}

/**
 * Should the live credentials be copied into this seat's directory? Only when
 * the live file really IS this seat's login — a positive identity match, not the
 * "lone unknown seat" fallback of `resolveSeatSource`. Refresh tokens rotate, so
 * while a login is live its directory copy goes stale unless it is kept in step
 * (otherwise a swap away would read a rotated-out refresh token and sign the seat
 * out). One direction only: live → directory, never the reverse.
 * @param {{seat: Seat, source: {kind:string}, liveUuid: string|null}} args
 */
export function shouldMirror({ seat, source, liveUuid }) {
  return (
    source.kind === "live" &&
    Boolean(seat.credentialDir) &&
    Boolean(liveUuid) &&
    Boolean(seat.accountUuid) &&
    seat.accountUuid === liveUuid
  );
}

/**
 * How the provider AGGREGATE is built from per-seat readings — the ONE place
 * that decision lives (the usage poller and the at-limit recheck both call it).
 *
 * While requests are not routed per conversation (`perConversationRouting`
 * false — the plugin has not been seen, see `perConversationRoutingActive`) every request is served by the LIVE seat, so the aggregate must be that
 * seat's reading (manual mode, active = the serving seat) — reporting the
 * least-loaded seat instead would tell the stopper/resume/routing/pacing there
 * is room while requests hit the wall. With no serving seat known, or once
 * routing is per conversation, the store's own mode / active seat apply.
 *
 * @param {{plan: {mode: "auto"|"manual", activeSeatId: string|null, servingSeatId?: string|null}, perConversationRouting?: boolean}} args
 * @returns {{mode: "auto"|"manual", activeSeatId: string|null}}
 */
export function aggregationPolicy({ plan, perConversationRouting = false }) {
  if (!perConversationRouting && plan?.servingSeatId) {
    return { mode: "manual", activeSeatId: plan.servingSeatId };
  }
  return { mode: plan?.mode ?? "auto", activeSeatId: plan?.activeSeatId ?? null };
}

// ---------------------------------------------------------------------------
// Pure: merging discovery findings into a provider's state
// ---------------------------------------------------------------------------

export function findSeat(prov, pred) {
  for (const a of prov.accounts) for (const s of a.seats) if (pred(s, a)) return { seat: s, account: a };
  return null;
}

function removeSeat(prov, seatId) {
  for (const a of prov.accounts) a.seats = a.seats.filter((s) => s.id !== seatId);
  prov.accounts = prov.accounts.filter((a) => a.seats.length > 0);
}

/** Put `seat` into the account for `identity.orgId` (creating it), moving it out
 *  of wherever it was; empty accounts are dropped. */
function placeSeat(prov, seat, identity, defaultAccountLabel) {
  const orgId = identity?.orgId ?? null;
  const current = findSeat(prov, (s) => s.id === seat.id);
  let target = prov.accounts.find((a) => a.orgId === orgId && (orgId !== null || a.orgName === null));
  if (current && current.account === target) {
    if (identity) {
      target.orgName = identity.orgName ?? target.orgName;
      target.plan = identity.plan ?? target.plan;
    }
    return;
  }
  if (current) removeSeat(prov, seat.id);
  target = prov.accounts.find((a) => a.orgId === orgId && (orgId !== null || a.orgName === null));
  if (!target) {
    target = {
      id: nextId("acct", prov.accounts.map((a) => a.id)),
      label: identity?.orgName ?? defaultAccountLabel,
      orgId,
      orgName: identity?.orgName ?? null,
      plan: identity?.plan ?? null,
      seats: [],
    };
    prov.accounts.push(target);
  } else if (identity) {
    target.orgName = identity.orgName ?? target.orgName;
    target.plan = identity.plan ?? target.plan;
  }
  target.seats.push(seat);
  target.seats.sort((a, b) => compareIds(a.id, b.id));
}

function applyIdentity(seat, identity) {
  seat.accountUuid = identity.accountUuid;
  seat.email = identity.email ?? seat.email;
  // An "expired" seat (its refresh token is dead) keeps that status through
  // re-identification: its access token may still be good for hours, and
  // identifying it is not evidence the login works. A refresh success, or a new
  // sign-in, is what clears it.
  if (seat.status !== "expired") seat.status = "ok";
}

/**
 * Fold what discovery found into one provider's state. Pure and idempotent:
 * running it twice with the same findings changes nothing the second time.
 * Seats are deduped by account uuid — the same login found twice (a seat
 * directory AND the live file) is ONE seat.
 *
 * @param {ProviderState} state  not mutated
 * @param {{
 *   dirs: Array<{id:string, dir:string, identity: ReturnType<typeof identityFromProfile>}>,
 *   live: {present:boolean, identity: ReturnType<typeof identityFromProfile>} | null,
 * }} findings  `identity: null` = the lookup failed or was not possible
 * @param {{defaultAccountLabel: string}} opts
 * @returns {ProviderState}
 */
export function mergeFindings(state, findings, { defaultAccountLabel }) {
  const prov = structuredClone(state);

  for (const f of [...(findings.dirs ?? [])].sort((a, b) => compareIds(a.id, b.id))) {
    const existing = findSeat(prov, (s) => s.id === f.id)?.seat ?? null;
    if (!f.identity) {
      if (!existing) {
        const seat = {
          id: f.id,
          label: defaultSeatLabel(f.id, allSeats(prov).length + 1),
          email: null,
          accountUuid: null,
          credentialDir: f.dir,
          status: "unknown",
        };
        placeSeat(prov, seat, null, defaultAccountLabel);
      } else if (!existing.credentialDir) {
        existing.credentialDir = f.dir;
      }
      continue;
    }
    // Same login already known under another seat → that seat adopts the
    // directory if it has none; this id is not a second seat.
    const twin = findSeat(prov, (s) => s.accountUuid === f.identity.accountUuid && s.id !== f.id)?.seat ?? null;
    if (twin) {
      if (!twin.credentialDir) twin.credentialDir = f.dir;
      if (existing && !existing.accountUuid) removeSeat(prov, existing.id);
      continue;
    }
    const seat = existing ?? {
      id: f.id,
      label: defaultSeatLabel(f.id, allSeats(prov).length + 1),
      email: null,
      accountUuid: null,
      credentialDir: f.dir,
      status: "unknown",
    };
    if (!seat.credentialDir) seat.credentialDir = f.dir;
    applyIdentity(seat, f.identity);
    placeSeat(prov, seat, f.identity, defaultAccountLabel);
  }

  const live = findings.live;
  if (live?.present) {
    const placeholder = findSeat(prov, (s) => !s.credentialDir && !s.accountUuid)?.seat ?? null;
    if (live.identity) {
      const twin = findSeat(prov, (s) => s.accountUuid === live.identity.accountUuid)?.seat ?? null;
      if (twin) {
        if (placeholder && placeholder.id !== twin.id) removeSeat(prov, placeholder.id);
      } else if (placeholder) {
        applyIdentity(placeholder, live.identity);
        placeSeat(prov, placeholder, live.identity, defaultAccountLabel);
      } else {
        const id = nextId("seat", allSeats(prov).map((s) => s.id).concat((findings.dirs ?? []).map((d) => d.id)));
        const seat = {
          id,
          label: defaultSeatLabel(id, allSeats(prov).length + 1),
          email: null,
          accountUuid: null,
          credentialDir: null,
          status: "unknown",
        };
        applyIdentity(seat, live.identity);
        placeSeat(prov, seat, live.identity, defaultAccountLabel);
      }
    } else if (!placeholder && allSeats(prov).length === 0) {
      // Live login present but unidentifiable and nothing else known: record it
      // as an unknown seat so it is retried next run. (With other seats already
      // known it would only duplicate one of them, so wait.)
      const id = nextId("seat", []);
      placeSeat(
        prov,
        { id, label: defaultSeatLabel(id, 1), email: null, accountUuid: null, credentialDir: null, status: "unknown" },
        null,
        defaultAccountLabel,
      );
    }
  }
  return prov;
}

// The refresh outcome that means "this login's refresh token is dead — the user
// must sign in again", per provider. Claude: the CLI run found the refresh token
// expired. Codex: the OAuth endpoint refused it (400/401, e.g. invalid_grant).
// Every other failure (network, 5xx, CLI missing) is transient and changes nothing.
const DEAD_REFRESH_REASON = { claude: "refresh-token-expired", codex: "refresh-token-rejected" };

/**
 * The store after a seat refresh outcome (see `noteRefreshOutcome`). Pure.
 * Returns the SAME object when nothing changes.
 * @param {AccountsStore} store
 * @param {string} provider
 * @param {string} seatId
 * @param {{ok?: boolean, reason?: string}|null|undefined} outcome
 */
export function applyRefreshOutcome(store, provider, seatId, outcome) {
  const seat = findSeat(store?.providers?.[provider] ?? emptyProviderState(), (s) => s.id === seatId)?.seat;
  if (!seat) return store;
  let status = null;
  if (outcome?.ok === true) {
    if (seat.status === "expired") status = "ok";
  } else if (outcome?.reason === DEAD_REFRESH_REASON[provider]) {
    if (seat.status !== "expired" && seat.status !== "signed-out") status = "expired";
  }
  if (!status) return store;
  const next = structuredClone(store);
  findSeat(next.providers[provider], (s) => s.id === seatId).seat.status = status;
  return next;
}

/**
 * Post-discovery bookkeeping on a provider: default mode (auto once a SECOND
 * seat appears — never flipped again afterwards, so a user's manual choice
 * sticks) and a valid active seat (the live login's seat when known).
 * @param {ProviderState} before
 * @param {ProviderState} after
 * @param {string|null} liveSeatId
 */
export function settleProvider(before, after, liveSeatId) {
  const out = structuredClone(after);
  const seats = allSeats(out);
  if (allSeats(before).length < 2 && seats.length >= 2) out.mode = "auto";
  if (!seats.some((s) => s.id === out.activeSeatId)) {
    out.activeSeatId = (liveSeatId && seats.some((s) => s.id === liveSeatId) ? liveSeatId : seats[0]?.id) ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure: store mutations behind the accounts:* channels (phase 3)
// ---------------------------------------------------------------------------

const MAX_LABEL_LEN = 40;

/** A label the user typed: trimmed, 1–40 chars, no control characters. Returns
 *  the cleaned label, or null when it is not acceptable. */
export function cleanLabel(raw) {
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  if (label.length < 1 || label.length > MAX_LABEL_LEN) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(label)) return null;
  return label;
}

/** Rename an account or a seat. Pure; null when the id does not exist. */
export function renameInState(state, { kind, id, label }) {
  const next = structuredClone(state);
  if (kind === "account") {
    const a = next.accounts.find((x) => x.id === id);
    if (!a) return null;
    a.label = label;
    return next;
  }
  if (kind === "seat") {
    const hit = findSeat(next, (s) => s.id === id);
    if (!hit) return null;
    hit.seat.label = label;
    return next;
  }
  return null;
}

/** The state without one seat (an emptied account goes with it) and the seat
 *  that was removed. `activeSeatId` is re-pointed when it was the removed seat.
 *  Pure; `seat: null` when the id does not exist. */
export function removeSeatInState(state, seatId, liveSeatId = null) {
  const hit = findSeat(state, (s) => s.id === seatId);
  if (!hit) return { state, seat: null };
  const next = structuredClone(state);
  removeSeat(next, seatId);
  if (next.activeSeatId === seatId) {
    const seats = allSeats(next);
    next.activeSeatId = (liveSeatId && seats.some((s) => s.id === liveSeatId) ? liveSeatId : seats[0]?.id) ?? null;
  }
  return { state: next, seat: hit.seat };
}

/**
 * Where a freshly signed-in seat goes. Pure.
 *   • the same login as a seat we already have → duplicate (never a second seat);
 *   • a target account was chosen and the login belongs to ANOTHER org (Claude,
 *     both orgs known) → different-org (the caller parks it until confirmed);
 *   • otherwise place.
 * @returns {{kind:"duplicate", seat: Seat}|{kind:"different-org", orgName: string|null}|{kind:"place"}}
 */
export function planSeatPlacement({ state, provider, identity, accountId = null }) {
  const twin = identity?.accountUuid ? findSeat(state, (s) => s.accountUuid === identity.accountUuid)?.seat ?? null : null;
  if (twin) return { kind: "duplicate", seat: twin };
  if (accountId && provider === "claude") {
    const target = state.accounts.find((a) => a.id === accountId);
    if (target?.orgId && identity?.orgId && target.orgId !== identity.orgId) {
      return { kind: "different-org", orgName: identity.orgName ?? null };
    }
  }
  return { kind: "place" };
}

/**
 * Put a new seat into the provider state.
 *   • `accountId` → that account (it must exist);
 *   • Claude, no account → grouped by org id (an existing account with the same
 *     org, else a new one) — spec §2;
 *   • Codex, no account → always a NEW account: ChatGPT logins carry no org to
 *     group by, and two logins are two plans.
 * Then the usual bookkeeping (`settleProvider`: auto mode once a SECOND seat
 * exists). Pure.
 */
export function addSeatToState(state, { provider, seat, identity, accountId = null, defaultAccountLabel }) {
  const next = structuredClone(state);
  const target = accountId ? next.accounts.find((a) => a.id === accountId) : null;
  if (accountId && !target) return null;
  if (target) {
    if (identity) {
      target.orgName = identity.orgName ?? target.orgName;
      target.plan = identity.plan ?? target.plan;
    }
    target.seats.push(seat);
    target.seats.sort((a, b) => compareIds(a.id, b.id));
  } else if (provider === "codex") {
    next.accounts.push({
      id: nextId("acct", next.accounts.map((a) => a.id)),
      label: next.accounts.length === 0 ? defaultAccountLabel : `${defaultAccountLabel} ${next.accounts.length + 1}`,
      orgId: null,
      orgName: null,
      plan: null,
      seats: [seat],
    });
  } else {
    placeSeat(next, seat, identity, defaultAccountLabel);
  }
  return settleProvider(state, next, null);
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Claude credentials out of a `.credentials.json` path, or null. */
export async function readClaudeCredentialsFile(path) {
  try {
    return parseCredentials(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

/** The openai oauth entry out of an auth.json-shaped file (`{openai:{…}}`, or a
 *  bare entry), or null. */
export async function readCodexEntryFile(path) {
  const j = await readJsonFile(path);
  const entry = j?.openai ?? (j?.access ? j : null);
  return entry?.type === "oauth" && typeof entry.access === "string" && entry.access ? entry : null;
}

/** What the router needs to know about a seat's credential file — that it holds
 *  a usable access token, and when it expires. The token itself is deliberately
 *  NOT returned: nothing outside the credential reader (and the plugin, from the
 *  file) ever holds one. */
async function readSeatCredential(provider, file) {
  if (provider === "claude") {
    const c = await readClaudeCredentialsFile(file);
    return c?.accessToken ? { expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : null } : null;
  }
  const e = await readCodexEntryFile(file);
  return e?.access ? { expiresAt: typeof e.expires === "number" ? e.expires : null } : null;
}

const shortHash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

/** GET the Anthropic profile for an access token. Never throws, never logs the
 *  token; `null` on any failure. */
export async function fetchClaudeProfile(accessToken, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res?.ok) return null;
    return identityFromProfile(await res.json());
  } catch {
    return null;
  }
}

async function listSeatDirs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(compareIds);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]  every path / IO is injectable; tests never touch the
 *   real home directory or the network.
 */
export function createAccountsService({
  storePath = statePath("accounts.json"),
  seatsRoot = join(secretsRoot(), "accounts"),
  claudeLivePath = CREDENTIALS_PATH,
  codexAuthPath = null,
  fetchImpl = fetch,
  now = () => Date.now(),
  liveIdentityTtlMs = LIVE_IDENTITY_TTL_MS,
  rediscoverMs = REDISCOVER_MS,
  log = console,
} = {}) {
  const codexLivePath = () => codexAuthPath ?? opencodeAuthPath();

  /** @type {AccountsStore|null} */
  let store = null;
  // Writers of the store serialize here. Discovery computes from a snapshot over
  // seconds (network calls), so a mutation landing meanwhile makes that run's
  // result stale: `storeVersion` lets discovery notice and drop it instead of
  // overwriting the user's change (it is idempotent — the next run redoes it).
  const writeLock = createMutex();
  let storeVersion = 0;
  const listeners = new Set();
  // Seat ids a sign-in flow is holding (provider → Set). Discovery must not
  // adopt their directories: the flow decides whether the new login is a
  // duplicate / a different org BEFORE it becomes a seat.
  const reserved = { claude: new Set(), codex: new Set() };
  let discovering = null;
  let lastDiscoveryAt = 0;
  let liveCache = { key: null, at: 0, identity: null };

  async function loadStore() {
    store = normalizeStore(await readJsonFile(storePath));
    return store;
  }

  async function saveStore(next) {
    const before = store;
    await writeJsonAtomic(storePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    store = next;
    // Tell listeners WHICH providers changed (the accounts.updated bus event).
    for (const provider of ACCOUNT_PROVIDERS) {
      if (JSON.stringify(before?.providers?.[provider]) === JSON.stringify(next.providers[provider])) continue;
      for (const fn of [...listeners]) {
        try {
          fn({ provider });
        } catch {
          // a listener must never break a save
        }
      }
    }
  }

  /** The live Claude login's identity, cached per live token (see top of file). */
  async function claudeLiveIdentity() {
    const creds = await readClaudeCredentialsFile(claudeLivePath);
    if (!creds?.accessToken) {
      liveCache = { key: null, at: 0, identity: null };
      return { present: false, identity: null };
    }
    const key = shortHash(creds.refreshToken ?? creds.accessToken);
    const age = now() - liveCache.at;
    if (liveCache.key === key && age < (liveCache.identity ? liveIdentityTtlMs : LIVE_IDENTITY_FAIL_TTL_MS)) {
      return { present: true, identity: liveCache.identity };
    }
    const identity = await fetchClaudeProfile(creds.accessToken, fetchImpl);
    liveCache = { key, at: now(), identity };
    return { present: true, identity };
  }

  /** The live Codex login's account id (no network: it is in the entry). */
  async function codexLiveIdentity() {
    const entry = await readCodexEntryFile(codexLivePath());
    if (!entry) return { present: false, identity: null };
    return {
      present: true,
      identity: typeof entry.accountId === "string" && entry.accountId
        ? { accountUuid: entry.accountId, email: null, orgId: null, orgName: null, plan: null }
        : null,
    };
  }

  const liveIdentityFor = (provider) => (provider === "claude" ? claudeLiveIdentity() : codexLiveIdentity());

  async function discoverClaude(prov) {
    const root = join(seatsRoot, "claude");
    const dirs = [];
    for (const id of await listSeatDirs(root)) {
      const dir = join(root, id);
      const creds = await readClaudeCredentialsFile(join(dir, ".credentials.json"));
      if (!creds?.accessToken) continue; // an empty/odd directory is not a seat
      if (reserved.claude.has(id)) continue; // a sign-in is still deciding what this is
      // Matched by id OR by directory: a seat that adopted this directory
      // under a different id (the same login was first found via the live file)
      // is just as identified.
      const known = findSeat(prov, (s) => s.id === id || s.credentialDir === dir)?.seat;
      if ((known?.status === "ok" || known?.status === "expired") && known.accountUuid && known.credentialDir) continue; // identified: no call
      dirs.push({ id, dir, identity: await fetchClaudeProfile(creds.accessToken, fetchImpl) });
    }
    const live = await claudeLiveIdentity();
    return mergeFindings(prov, { dirs, live }, { defaultAccountLabel: "Claude" });
  }

  async function discoverCodex(prov) {
    if (allSeats(prov).length > 0) return prov;
    const entry = await readCodexEntryFile(codexLivePath());
    if (!entry) return prov;
    const dir = join(seatsRoot, "codex", "seat-1");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const file = join(dir, "auth.json");
    await writeFile(file, JSON.stringify({ openai: entry }), { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
    const next = structuredClone(prov);
    next.accounts.push({
      id: "acct-1",
      label: "ChatGPT",
      orgId: null,
      orgName: null,
      plan: null,
      seats: [
        {
          id: "seat-1",
          label: "Seat 1",
          email: null,
          accountUuid: str(entry.accountId),
          credentialDir: dir,
          status: "ok",
        },
      ],
    });
    return next;
  }

  async function discoverNow() {
    const before = store ?? (await loadStore());
    const versionAtStart = storeVersion;
    const next = structuredClone(before);
    for (const provider of ACCOUNT_PROVIDERS) {
      const prov = next.providers[provider];
      let found;
      try {
        found = provider === "claude" ? await discoverClaude(prov) : await discoverCodex(prov);
      } catch (e) {
        // One provider failing must not stop the other, and never stops startup.
        log.warn?.(`[accounts] discovery for ${provider} failed:`, e?.message ?? e);
        continue;
      }
      const live = await liveIdentityFor(provider).catch(() => ({ present: false, identity: null }));
      const liveSeat = live.identity
        ? findSeat(found, (s) => s.accountUuid === live.identity.accountUuid)?.seat?.id ?? null
        : null;
      next.providers[provider] = settleProvider(before.providers[provider], found, liveSeat);
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      const kept = await writeLock.runExclusive(async () => {
        if (storeVersion !== versionAtStart) return false; // a mutation landed meanwhile
        await saveStore(next);
        return true;
      });
      if (!kept) {
        lastDiscoveryAt = 0; // redo soon, from the new store
        return store ?? next;
      }
    }
    // Keep each live login's seat directory in step with it (see mirrorLive).
    for (const provider of ACCOUNT_PROVIDERS) {
      await resolveSeats(provider, next.providers[provider]).catch(() => {});
    }
    lastDiscoveryAt = now();
    return next;
  }

  /** Single-flight, rate-limited discovery. Never rejects. */
  async function discover({ force = false } = {}) {
    if (discovering) return discovering;
    if (!force && store && now() - lastDiscoveryAt < rediscoverMs) return store;
    discovering = discoverNow()
      .catch((e) => {
        log.warn?.("[accounts] discovery failed:", e?.message ?? e);
        return store ?? emptyStore();
      })
      .finally(() => {
        discovering = null;
      });
    return discovering;
  }

  /**
   * Keep a seat's directory copy equal to the live login it IS. Writes only when
   * the content differs; atomic, 0600 (directory 0700); never reads from the
   * directory into the live file. The content mirrored must be the content that
   * was identified (Claude: same refresh-token hash as the identity cache;
   * Codex: same accountId), so a swap landing mid-call cannot copy the wrong
   * login into this seat. Best-effort: a failure is logged (no secrets) and the
   * caller carries on.
   * @returns {Promise<boolean>} whether a write happened
   */
  async function mirrorLive(provider, seat) {
    try {
      if (!(await stat(seat.credentialDir)).isDirectory()) return false;
      let want;
      if (provider === "claude") {
        const raw = await readFile(claudeLivePath, "utf-8");
        const creds = parseCredentials(raw);
        if (!creds?.accessToken) return false;
        if (shortHash(creds.refreshToken ?? creds.accessToken) !== liveCache.key) return false;
        want = raw;
      } else {
        const entry = await readCodexEntryFile(codexLivePath());
        if (!entry || entry.accountId !== seat.accountUuid) return false;
        want = JSON.stringify({ openai: entry });
      }
      const dest = join(seat.credentialDir, provider === "claude" ? ".credentials.json" : "auth.json");
      const have = await readFile(dest, "utf-8").catch(() => null);
      if (have === want) return false;
      await writeJsonAtomic(dest, want, { mode: 0o600 });
      await chmod(seat.credentialDir, 0o700).catch(() => {});
      return true;
    } catch (e) {
      log.warn?.(`[accounts] mirroring the live ${provider} login into ${seat.id} failed:`, e?.message ?? e);
      return false;
    }
  }

  /**
   * Resolve every seat's credential source for ONE read, mirroring the live
   * login into its seat's directory on the way. `servingSeatId` is the seat the
   * live login belongs to (an identity match wins over a fallback), null if none.
   */
  async function resolveSeats(provider, prov) {
    const live = await liveIdentityFor(provider).catch(() => ({ present: false, identity: null }));
    const liveUuid = live.identity?.accountUuid ?? null;
    const seatCount = allSeats(prov).length;
    const out = [];
    let matchedId = null;
    let fallbackId = null;
    for (const account of prov.accounts) {
      for (const seat of account.seats) {
        const source = resolveSeatSource({ seat, liveUuid, liveAvailable: live.present, seatCount });
        if (shouldMirror({ seat, source, liveUuid })) await mirrorLive(provider, seat);
        if (source.kind === "live") {
          if (liveUuid && seat.accountUuid === liveUuid) matchedId ??= seat.id;
          else fallbackId ??= seat.id;
        }
        out.push({ account, seat, source });
      }
    }
    return { seats: out, servingSeatId: matchedId ?? fallbackId };
  }

  function pathForSource(provider, source) {
    if (source.kind === "live") return provider === "claude" ? claudeLivePath : codexLivePath();
    if (source.kind === "dir") return join(source.dir, provider === "claude" ? ".credentials.json" : "auth.json");
    return null;
  }

  return {
    discover,

    /** Be told when a provider's stored state changes: `fn({provider})`.
     *  Returns the unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Where seats of a provider keep their credentials. */
    seatDir(provider, seatId) {
      return join(seatsRoot, provider, seatId);
    },

    /** Every id a NEW seat must not take: stored seats, held ids, and seat
     *  directories already on disk (a leftover directory must never be reused). */
    async takenSeatIds(provider) {
      const prov = (store ?? (await loadStore())).providers[provider];
      return [
        ...allSeats(prov).map((s) => s.id),
        ...(reserved[provider] ?? []),
        ...(await listSeatDirs(join(seatsRoot, provider))),
      ];
    },

    /** Hold / release a seat id while its sign-in runs (see `reserved`). */
    reserveSeat(provider, seatId) {
      reserved[provider]?.add(seatId);
    },
    releaseSeat(provider, seatId) {
      reserved[provider]?.delete(seatId);
    },

    /**
     * Change ONE provider's state atomically: `fn(state)` returns the next state
     * (or null to refuse — nothing is written). The whole read-modify-write is
     * serialized against other mutations and against discovery's save. Returns
     * `{ok:true, state}` or `{ok:false}`.
     * @param {string} provider
     * @param {(state: ProviderState) => ProviderState|null|Promise<ProviderState|null>} fn
     */
    async mutate(provider, fn) {
      if (!ACCOUNT_PROVIDERS.includes(provider)) return { ok: false };
      return writeLock.runExclusive(async () => {
        const current = store ?? (await loadStore());
        const next = await fn(structuredClone(current.providers[provider]));
        if (!next) return { ok: false };
        const nextStore = structuredClone(current);
        nextStore.providers[provider] = next;
        storeVersion++;
        await saveStore(nextStore);
        return { ok: true, state: structuredClone(next) };
      });
    },

    /** Delete a seat's directory — only ever one that lies INSIDE the seats
     *  root (a corrupt store must not turn a remove into `rm -rf` elsewhere). */
    async deleteSeatDir(dir) {
      if (typeof dir !== "string" || !dir) return false;
      const root = resolvePath(seatsRoot) + sep;
      const target = resolvePath(dir);
      // Exactly one seat directory — <root>/<provider>/<seat> — never a provider
      // directory (which would take every seat of that provider with it).
      if (!target.startsWith(root)) return false;
      const parts = target.slice(root.length).split(sep);
      if (parts.length !== 2 || !ACCOUNT_PROVIDERS.includes(parts[0]) || !parts[1] || parts[1].startsWith(".")) return false;
      await rm(target, { recursive: true, force: true });
      return true;
    },

    /** A copy of the current store (after loading it if needed). */
    async getStore() {
      return structuredClone(store ?? (await loadStore()));
    },

    /**
     * What the usage poller needs for one provider: its mode, active seat, and
     * per seat a `deps` object to spread into the usage adapter's detect/fetch
     * (`readCredentials` for claude, `readToken` for codex). Signed-out seats
     * are omitted. `null` = this provider has no seats → the poller falls back
     * to its single-credential path (today's behaviour).
     */
    async seatsFor(provider) {
      if (!ACCOUNT_PROVIDERS.includes(provider)) return null;
      await discover();
      const prov = (store ?? emptyStore()).providers[provider];
      const { seats: resolved, servingSeatId } = await resolveSeats(provider, prov);
      const seats = [];
      for (const { account, seat, source } of resolved) {
        const file = pathForSource(provider, source);
        if (!file) continue;
        const deps =
          provider === "claude"
            ? { readCredentials: () => readClaudeCredentialsFile(file) }
            : { readToken: async () => (await readCodexEntryFile(file))?.access ?? "" };
        seats.push({
          accountId: account.id,
          accountLabel: account.label,
          seatId: seat.id,
          seatLabel: seat.label,
          deps,
        });
      }
      if (seats.length === 0) return null;
      return {
        mode: prov.mode,
        activeSeatId: prov.activeSeatId,
        // The seat the live login serves — every request goes through it until
        // requests are routed per conversation (see perConversationRoutingActive).
        servingSeatId: seats.some((x) => x.seatId === servingSeatId) ? servingSeatId : null,
        seats,
      };
    },

    /**
     * Everything the per-conversation router needs about one provider's seats
     * (seatAssignment.mjs): mode, active seat, and per seat whether the request
     * path can use it, plus — for a seat NOT read from the live file — where its
     * credential file is and when its token expires (never the token). `live`
     * seats carry no credential (the plugin lets them through untouched).
     * INTERNAL: not for a renderer. `null` = unknown provider.
     * @returns {Promise<null|{mode:string, activeSeatId:string|null, seats:Array<{
     *   seatId:string, accountId:string, live:boolean, usable:boolean,
     *   dir:string|null, file:string|null,
     *   credential:null|{expiresAt:number|null}}>}>}
     */
    async seatStates(provider) {
      if (!ACCOUNT_PROVIDERS.includes(provider)) return null;
      await discover();
      const prov = (store ?? emptyStore()).providers[provider];
      const { seats: resolved } = await resolveSeats(provider, prov);
      const seats = [];
      for (const { account, seat, source } of resolved) {
        const live = source.kind === "live";
        const file = source.kind === "dir" ? pathForSource(provider, source) : null;
        const credential = file ? await readSeatCredential(provider, file) : null;
        seats.push({
          seatId: seat.id,
          accountId: account.id,
          live,
          // A live seat is usable by construction (the source resolver only
          // says "live" when the live login exists); a directory seat needs a
          // readable token; a signed-out seat ("none") is never usable.
          // …and a LIVE seat is usable whatever its stored status: the live login
          // is opencode's own, refreshed by opencode, so an "expired" mark left
          // from when this seat was a directory seat is stale the moment the user
          // signs it in again.
          usable: live || (seat.status !== "signed-out" && seat.status !== "expired" && Boolean(credential)),
          dir: source.kind === "dir" ? source.dir : null,
          file,
          credential,
        });
      }
      return { mode: prov.mode, activeSeatId: prov.activeSeatId, seats };
    },

    /**
     * Fold a seat refresh's outcome into the seat's status: a seat whose
     * REFRESH TOKEN is known-dead (Claude: expired; Codex: rejected) becomes "expired" (the router never picks
     * it — the user must sign it in again); any later success makes it "ok"
     * again. Anything else (a network blip, the CLI failing) changes nothing.
     * Only a seat that is "ok"/"unknown"/"expired" is touched, so a status set
     * by something else is never overwritten. Best-effort; never throws.
     * @returns {Promise<boolean>} whether the store changed
     */
    async noteRefreshOutcome(provider, seatId, outcome) {
      try {
        if (!ACCOUNT_PROVIDERS.includes(provider)) return false;
        return await writeLock.runExclusive(async () => {
          const current = store ?? (await loadStore());
          const next = applyRefreshOutcome(current, provider, seatId, outcome);
          if (next === current) return false;
          storeVersion++;
          await saveStore(next);
          return true;
        });
      } catch (e) {
        log.warn?.("[accounts] recording a refresh outcome failed:", e?.message ?? e);
        return false;
      }
    },

    /**
     * Codex seats the refresh sweep must refresh itself — the ones NOT read from
     * opencode's live auth.json (opencode owns that entry and its rotation).
     * @returns {Promise<Array<{seatId:string, file:string}>>}
     */
    async codexRefreshTargets() {
      await discover();
      const prov = (store ?? emptyStore()).providers.codex;
      const { seats } = await resolveSeats("codex", prov);
      return seats
        .filter((x) => x.source.kind === "dir")
        .map((x) => ({ seatId: x.seat.id, file: pathForSource("codex", x.source) }));
    },

    /**
     * Claude seats the proactive refresh sweep must refresh itself: the ones NOT
     * read from the live file (the live file keeps today's refresh path).
     * @returns {Promise<Array<{seatId:string, dir:string}>>}
     */
    async claudeRefreshTargets() {
      await discover();
      const prov = (store ?? emptyStore()).providers.claude;
      const { seats } = await resolveSeats("claude", prov);
      // A seat read from the LIVE file is never a target: the live refresh owns
      // it, and refreshing its directory copy would rotate the refresh token the
      // live login is using.
      return seats.filter((x) => x.source.kind === "dir").map((x) => ({ seatId: x.seat.id, dir: x.source.dir }));
    },
  };
}
