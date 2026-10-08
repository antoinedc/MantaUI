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
// Phase boundaries: no RPC channels, no sign-in, no assignment, no plugins here.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { secretsRoot, statePath } from "../shared/paths.mjs";
import { writeJsonAtomic } from "./jsonStore.mjs";
import { CREDENTIALS_PATH, parseCredentials } from "./claudeAuth.mjs";
import { opencodeAuthPath } from "./opencode.mjs";

export const ACCOUNT_PROVIDERS = ["claude", "codex"];

// Does each CONVERSATION get its own seat (spec §4, the request-path plugins)?
// Not yet: until phase 2 lands the plugins, every Claude/Codex request goes
// through the LIVE login, whatever the store says. Phase 2 flips this to true.
export const PER_CONVERSATION_ROUTING = false;
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
 * While requests are not routed per conversation (`PER_CONVERSATION_ROUTING`
 * false) every request is served by the LIVE seat, so the aggregate must be that
 * seat's reading (manual mode, active = the serving seat) — reporting the
 * least-loaded seat instead would tell the stopper/resume/routing/pacing there
 * is room while requests hit the wall. With no serving seat known, or once
 * routing is per conversation, the store's own mode / active seat apply.
 *
 * @param {{plan: {mode: "auto"|"manual", activeSeatId: string|null, servingSeatId?: string|null}, perConversationRouting?: boolean}} args
 * @returns {{mode: "auto"|"manual", activeSeatId: string|null}}
 */
export function aggregationPolicy({ plan, perConversationRouting = PER_CONVERSATION_ROUTING }) {
  if (!perConversationRouting && plan?.servingSeatId) {
    return { mode: "manual", activeSeatId: plan.servingSeatId };
  }
  return { mode: plan?.mode ?? "auto", activeSeatId: plan?.activeSeatId ?? null };
}

// ---------------------------------------------------------------------------
// Pure: merging discovery findings into a provider's state
// ---------------------------------------------------------------------------

function findSeat(prov, pred) {
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
  seat.status = "ok";
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
  let discovering = null;
  let lastDiscoveryAt = 0;
  let liveCache = { key: null, at: 0, identity: null };

  async function loadStore() {
    store = normalizeStore(await readJsonFile(storePath));
    return store;
  }

  async function saveStore(next) {
    await writeJsonAtomic(storePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    store = next;
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
      // Matched by id OR by directory: a seat that adopted this directory
      // under a different id (the same login was first found via the live file)
      // is just as identified.
      const known = findSeat(prov, (s) => s.id === id || s.credentialDir === dir)?.seat;
      if (known?.status === "ok" && known.accountUuid && known.credentialDir) continue; // identified: no call
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
    if (JSON.stringify(next) !== JSON.stringify(before)) await saveStore(next);
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
        // requests are routed per conversation (see PER_CONVERSATION_ROUTING).
        servingSeatId: seats.some((x) => x.seatId === servingSeatId) ? servingSeatId : null,
        seats,
      };
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
