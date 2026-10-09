// accountsManager.mjs — the `accounts:*` RPC surface (multi-account spec §8,
// "Contract v2", phase 3): list, mode, active seat, rename, remove, and the
// add-a-seat sign-in flows.
//
// It owns NO storage: the seat store is accounts.mjs, conversation assignments
// are seatAssignment.mjs, usage readings are the usage poller's. This module
// composes them behind one contract the desktop (`httpApi`) and iOS
// (`MantaAPIClient`) both call over `/rpc`. Everything that touches the world
// (the sign-in launchers, opencode's auth store, the filesystem, the clock) is
// injected, so the flows are tested end to end on plain objects.
//
// ERRORS. A refusal the user can act on is a RESULT — `{error: "<code>"}` with a
// code from the contract's closed list — never a throw. Anything unexpected is
// logged server-side and surfaces as ONE safe literal (BET-1460 class 1): these
// channels answer to a person's screen, so a raw fs path or errno never goes out.
//
// THE ADD-SEAT FLOWS
//   Claude: a new directory under the seats root, `claude auth login` run with
//     CLAUDE_CONFIG_DIR pointing at it (the live ~/.claude login is never
//     touched). Progress = that directory's credentials file appearing. The new
//     login is identified (profile call) and placed — or refused as a duplicate,
//     or parked when it belongs to a different org than the account the user
//     chose (they confirm or cancel).
//   Codex: opencode has ONE slot per provider, so the new login BORROWS the live
//     one: when opencode reports the login landed, the new entry is copied into
//     the seat's directory FIRST (it is never lost), then the previous live entry
//     is written back through opencode's own auth API and verified. If that
//     restore fails the new login simply stays live and the previous one is kept
//     as its own seat — a login is never dropped.
//
// A seat is never listed until it is identified and placed; until then it lives
// only in memory (`pending`), its id held back from discovery.

import { join } from "node:path";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { leastLoadedSeat } from "../shared/seatChoice.mjs";
import {
  ACCOUNT_PROVIDERS,
  addSeatToState,
  allSeats,
  cleanLabel,
  defaultSeatLabel,
  fetchClaudeProfile,
  findSeat,
  nextId,
  perConversationRoutingActive,
  planSeatPlacement,
  readClaudeCredentialsFile,
  readCodexEntryFile,
  removeSeatInState,
  renameInState,
} from "./accounts.mjs";
import { buildProviderView, buildSessionSeat, findSeatView } from "./accountsViews.mjs";

/** The closed list of refusals the contract names (§8). */
// `live-seat` is kept for compatibility but is no longer returned: the live
// seat can be removed (another login is promoted first). `last-seat` = the only
// login of that provider; `no-replacement` = other seats exist but none can
// take over as the live login right now.
export const ACCOUNTS_ERRORS = ["unknown-seat", "invalid-label", "live-seat", "unknown-provider", "login-failed", "last-seat", "no-replacement"];

/** What a person sees when something unexpected breaks (class-1 safe literal). */
export const ACCOUNTS_SAFE_ERROR_MESSAGE = "The box couldn't complete that accounts request.";

export class AccountsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const LOGIN_TIMEOUT_MS = 15 * 60_000; // a sign-in nobody finished
const PROFILE_GRACE_MS = 60_000; // credentials appeared but the profile call keeps failing
const FINISHED_TTL_MS = 10 * 60_000; // how long an ok/failed result stays answerable
const PARKED_TTL_MS = 30 * 60_000; // how long a different-org login waits for confirmation
const GUARD_TTL_MS = 30 * 60_000; // how long an abandoned Codex wait is still watched

const isProvider = (p) => ACCOUNT_PROVIDERS.includes(p);
const isObj = (v) => v !== null && typeof v === "object";
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

/**
 * @param {object} deps
 * @param {ReturnType<import("./accounts.mjs").createAccountsService>} deps.accounts
 * @param {ReturnType<import("./seatAssignment.mjs").createSeatAssigner>} deps.seatAssigner
 * @param {() => Array<object>} [deps.listSeatSnapshots]
 * @param {() => number} [deps.now]
 * @param {(nowMs: number) => boolean} [deps.routingActive]
 * @param {{
 *   start: (configDir: string, seatId: string) => Promise<object>,
 *   cancel: (sessionKey: string) => void,
 * }} deps.claudeLogin  the existing claude-login flow, pointed at a seat directory
 * @param {{
 *   startConnect: () => Promise<object>,
 *   oauthEpoch: () => number|undefined,
 *   livePath: () => string,
 *   restoreEntry: (entry: object) => Promise<{ok: boolean}>,
 * }} deps.codex  opencode's OpenAI OAuth flow + its auth store
 */
export function createAccountsManager({
  accounts,
  seatAssigner,
  listSeatSnapshots = () => [],
  now = () => Date.now(),
  routingActive = perConversationRoutingActive,
  claudeLogin,
  codex,
  fetchProfile = fetchClaudeProfile,
  readClaudeCreds = readClaudeCredentialsFile,
  readCodexEntry = readCodexEntryFile,
  fsOps = { mkdir, chmod, writeFile },
  timings = {},
  log = console,
}) {
  const t = {
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
    profileGraceMs: PROFILE_GRACE_MS,
    finishedTtlMs: FINISHED_TTL_MS,
    parkedTtlMs: PARKED_TTL_MS,
    guardTtlMs: GUARD_TTL_MS,
    ...timings,
  };

  /**
   * In-flight and recently finished add-seat flows, by seat id. Memory only: a
   * restart forgets them (a half-done login simply never becomes a seat).
   * @type {Map<string, {
   *   seatId: string, provider: "claude"|"codex", dir: string, accountId: string|null,
   *   label: string|null, startedAt: number, state: "pending"|"ok"|"failed",
   *   error?: string, orgName?: string|null, identity?: object|null, parked?: boolean,
   *   finishedAt?: number, sessionKey?: string, credsSeenAt?: number,
   *   epoch?: number, prev?: object|null, processing?: boolean
   * }>}
   */
  const pending = new Map();
  /** Abandoned Codex waits still watched, so a late approval cannot swap the live login. */
  const guards = [];
  /** seatId → in-flight status resolution (single-flight, so two polls cannot place twice). */
  const resolving = new Map();

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function requireProvider(provider) {
    if (!isProvider(provider)) throw new AccountsError("unknown-provider");
    return provider;
  }

  async function providerView(provider) {
    const states = await accounts.seatStates(provider);
    if (!states || states.seats.length === 0) return null;
    const store = await accounts.getStore();
    return buildProviderView({
      provider,
      state: store.providers[provider],
      states,
      seatSnapshots: listSeatSnapshots().filter((x) => x?.provider === provider),
      assignments: seatAssigner.assignments(provider),
      routingActive: routingActive(now()),
    });
  }

  /** A provider view that must exist (after a change that left it with seats). */
  async function requireView(provider) {
    const view = await providerView(provider);
    if (!view) throw new AccountsError("unknown-provider");
    return view;
  }

  async function makeSeatDir(dir) {
    await fsOps.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsOps.chmod(dir, 0o700);
  }

  async function dropDir(dir) {
    try {
      await accounts.deleteSeatDir(dir);
    } catch (e) {
      log.warn?.("[accounts] deleting a seat directory failed:", e?.message ?? e);
    }
  }

  function seatLabelFor(rec, state) {
    return rec.label ?? defaultSeatLabel(rec.seatId, allSeats(state).length + 1);
  }

  // -------------------------------------------------------------------------
  // flow bookkeeping
  // -------------------------------------------------------------------------

  /** End a flow as failed: abort its login, delete its directory (unless it is
   *  parked awaiting confirmation), let discovery see the id again. */
  async function failFlow(rec, error, { park = false, orgName = null } = {}) {
    rec.state = "failed";
    rec.error = error;
    rec.finishedAt = now();
    if (orgName !== null) rec.orgName = orgName;
    if (park) {
      rec.parked = true;
      return;
    }
    if (rec.provider === "claude" && rec.sessionKey) {
      try {
        claudeLogin.cancel(rec.sessionKey);
      } catch {
        // already gone
      }
    }
    accounts.releaseSeat(rec.provider, rec.seatId);
    await dropDir(rec.dir);
  }

  function finishOk(rec) {
    rec.state = "ok";
    rec.error = undefined;
    rec.parked = false;
    rec.finishedAt = now();
    accounts.releaseSeat(rec.provider, rec.seatId);
  }

  /**
   * Resolve a pending Claude sign-in ONCE, single-flight (two callers — the
   * client's poll and the background sweep — must never place the same seat
   * twice). Codex has nothing to poll: opencode's own login event drives it.
   */
  async function resolveFlow(rec) {
    if (rec.state !== "pending") return;
    let run = resolving.get(rec.seatId);
    if (!run) {
      run = (rec.provider === "claude" ? resolveClaude(rec) : Promise.resolve())
        .catch((e) => {
          log.warn?.("[accounts] checking a seat sign-in failed:", e?.message ?? e);
        })
        .finally(() => resolving.delete(rec.seatId));
      resolving.set(rec.seatId, run);
    }
    await run;
  }

  /**
   * The background pass over the flows (run on a short timer by index.mjs, and
   * at the start of every add / status call). A sign-in is resolved by looking
   * at its credentials file, NOT by a client asking: the login can finish after
   * the panel stopped polling, and "Login successful" on the box must end with
   * a seat, not a deleted directory.
   *
   * ORDER IS THE POINT. A pending Claude flow is always resolved FIRST; the
   * timeout only ever applies to a flow that still has no credentials (that
   * rule lives in resolveClaude), so a login that completed just before the
   * deadline — or while nobody was looking — is placed, never dropped.
   */
  async function sweep() {
    const at = now();
    for (const rec of [...pending.values()]) {
      if (rec.state === "pending") {
        if (rec.provider === "claude") {
          await resolveFlow(rec);
        } else if (at - rec.startedAt > t.loginTimeoutMs) {
          rememberCodexGuard(rec);
          await failFlow(rec, "login-failed");
        }
      }
      if (rec.state !== "pending" && rec.finishedAt !== undefined) {
        const ttl = rec.parked ? t.parkedTtlMs : t.finishedTtlMs;
        if (at - rec.finishedAt > ttl) {
          if (rec.parked) await failFlow(rec, "login-failed");
          pending.delete(rec.seatId);
        }
      }
    }
    for (let i = guards.length - 1; i >= 0; i--) if (guards[i].until <= at) guards.splice(i, 1);
  }

  /** Place an identified login. Resolves the flow to ok / failed(duplicate) /
   *  failed(different-org, parked). */
  async function placeFlow(rec, identity, { skipOrgCheck = false, accountId = rec.accountId } = {}) {
    let planned = null;
    const defaultAccountLabel = rec.provider === "claude" ? "Claude" : "ChatGPT";
    const res = await accounts.mutate(rec.provider, (state) => {
      const plan = planSeatPlacement({
        state,
        provider: rec.provider,
        identity,
        accountId: skipOrgCheck ? null : accountId,
      });
      if (plan.kind !== "place") {
        planned = plan;
        return null;
      }
      const seat = {
        id: rec.seatId,
        label: seatLabelFor(rec, state),
        email: identity?.email ?? null,
        accountUuid: identity?.accountUuid ?? null,
        credentialDir: rec.dir,
        status: "ok",
      };
      return addSeatToState(state, { provider: rec.provider, seat, identity, accountId, defaultAccountLabel });
    });
    if (res.ok) {
      finishOk(rec);
      return;
    }
    if (planned?.kind === "duplicate") {
      await failFlow(rec, "duplicate-login");
    } else if (planned?.kind === "different-org") {
      rec.identity = identity;
      await failFlow(rec, "different-org", { park: true, orgName: planned.orgName });
    } else {
      await failFlow(rec, "login-failed");
    }
  }

  // -------------------------------------------------------------------------
  // Claude status
  // -------------------------------------------------------------------------

  async function resolveClaude(rec) {
    const creds = await readClaudeCreds(join(rec.dir, ".credentials.json"));
    if (!creds?.accessToken) {
      if (now() - rec.startedAt > t.loginTimeoutMs) {
        await failFlow(rec, "login-failed");
      }
      return;
    }
    rec.credsSeenAt ??= now();
    const identity = await fetchProfile(creds.accessToken);
    if (!identity) {
      // The credentials are there but Anthropic did not answer (yet). Give it a
      // minute before calling the sign-in failed.
      if (now() - rec.credsSeenAt > t.profileGraceMs) await failFlow(rec, "login-failed");
      return;
    }
    await placeFlow(rec, identity);
  }

  // -------------------------------------------------------------------------
  // Codex: borrow the live slot, then give it back
  // -------------------------------------------------------------------------

  async function writeSeatAuth(dir, entry) {
    await makeSeatDir(dir);
    const file = join(dir, "auth.json");
    await fsOps.writeFile(file, JSON.stringify({ openai: entry }), { mode: 0o600 });
    await fsOps.chmod(file, 0o600);
  }

  /** The previous login to put back: the snapshot taken at the start, unless its
   *  seat's directory copy is newer (opencode may have refreshed it meanwhile —
   *  restoring a rotated-out refresh token would sign the live login out). */
  async function freshestPrevious(prev) {
    if (!prev) return null;
    try {
      const store = await accounts.getStore();
      const seat = prev.accountId ? findSeat(store.providers.codex, (s) => s.accountUuid === prev.accountId)?.seat : null;
      if (seat?.credentialDir) {
        const copy = await readCodexEntry(join(seat.credentialDir, "auth.json"));
        if (copy && copy.accountId === prev.accountId && (copy.expires ?? 0) > (prev.expires ?? 0)) return copy;
      }
    } catch {
      // the snapshot is still a good answer
    }
    return prev;
  }

  /** Write `entry` back as opencode's live login and VERIFY it took. */
  async function restoreLive(entry) {
    try {
      const r = await codex.restoreEntry(entry);
      if (!r?.ok) return false;
      const now_ = await readCodexEntry(codex.livePath());
      return Boolean(now_) && now_.access === entry.access;
    } catch {
      return false;
    }
  }

  /** The previous login could not be put back, so the NEW one stays live: make
   *  sure the previous one is its own seat (it usually already is — it was seat 1
   *  — but a login opencode held that the store never saw must not be lost). */
  async function preservePrevious(prev) {
    const store = await accounts.getStore();
    if (findSeat(store.providers.codex, (s) => s.accountUuid === (prev.accountId ?? null))) return;
    const seatId = nextId("seat", [...(await accounts.takenSeatIds("codex")), ...pending.keys()]);
    const dir = accounts.seatDir("codex", seatId);
    await writeSeatAuth(dir, prev);
    const identity = { accountUuid: prev.accountId ?? null, email: null, orgId: null, orgName: null, plan: null };
    await accounts.mutate("codex", (state) =>
      addSeatToState(state, {
        provider: "codex",
        seat: {
          id: seatId,
          label: defaultSeatLabel(seatId, allSeats(state).length + 1),
          email: null,
          accountUuid: identity.accountUuid,
          credentialDir: dir,
          status: "ok",
        },
        identity,
        defaultAccountLabel: "ChatGPT",
      }),
    );
  }

  /** opencode stored a new login while a Codex add-seat was waiting. */
  async function processCodexLanding(rec) {
    if (rec.state !== "pending" || rec.processing) return;
    rec.processing = true;
    try {
      const entry = await readCodexEntry(codex.livePath());
      const isNew = Boolean(entry) && (!rec.prev || entry.access !== rec.prev.access || entry.refresh !== rec.prev.refresh);
      if (!isNew) {
        await failFlow(rec, "login-failed");
        return;
      }
      const identity = {
        accountUuid: typeof entry.accountId === "string" && entry.accountId ? entry.accountId : null,
        email: null,
        orgId: null,
        orgName: null,
        plan: null,
      };
      // 1. The new login is kept in its seat directory BEFORE anything else.
      await writeSeatAuth(rec.dir, entry);
      // 2. The previous live login goes back — unless the "new" login is the
      //    SAME account (a duplicate): then the fresh entry is the better one to
      //    keep live, and the old tokens may even have been rotated out.
      const sameAccount = Boolean(identity.accountUuid) && rec.prev?.accountId === identity.accountUuid;
      if (rec.prev && !sameAccount) {
        const prev = await freshestPrevious(rec.prev);
        if (!(await restoreLive(prev))) {
          log.warn?.("[accounts] could not restore the previous Codex login; the new one stays live and the old one becomes its own seat");
          await preservePrevious(prev);
        }
      }
      // 3. The new login becomes a seat (or is refused as a duplicate).
      await placeFlow(rec, identity);
    } catch (e) {
      log.warn?.("[accounts] finishing a Codex sign-in failed:", e?.message ?? e);
      await failFlow(rec, "login-failed");
    } finally {
      rec.processing = false;
    }
  }

  function rememberCodexGuard(rec) {
    if (rec.provider !== "codex" || !rec.prev) return;
    guards.push({ prev: rec.prev, epoch: rec.epoch, until: now() + t.guardTtlMs });
  }

  /** An ABANDONED wait landed after all: put the live login back if it changed hands. */
  async function processGuard(g) {
    const entry = await readCodexEntry(codex.livePath());
    if (!entry || entry.accountId === g.prev.accountId) return;
    const prev = await freshestPrevious(g.prev);
    if (!(await restoreLive(prev))) log.warn?.("[accounts] an abandoned Codex sign-in replaced the live login and it could not be restored");
  }

  /**
   * opencode stored a login for `id` (from rpc.mjs). Only the Codex provider
   * ("openai") matters here.
   * @param {{id: string, epoch?: number}} evt
   */
  async function onProviderLoginLanded({ id, epoch }) {
    if (id !== "openai") return;
    const rec = [...pending.values()].find(
      (r) => r.provider === "codex" && r.state === "pending" && (epoch === undefined || r.epoch === undefined || r.epoch === epoch),
    );
    if (rec) {
      await processCodexLanding(rec);
      return;
    }
    const at = now();
    const g = guards.find((x) => x.until > at && (epoch === undefined || x.epoch === undefined || x.epoch === epoch));
    if (g) {
      guards.splice(guards.indexOf(g), 1);
      await processGuard(g);
    }
  }

  // -------------------------------------------------------------------------
  // channels
  // -------------------------------------------------------------------------

  async function list() {
    const providers = [];
    for (const provider of ACCOUNT_PROVIDERS) {
      const view = await providerView(provider);
      if (view) providers.push(view);
    }
    return { providers };
  }

  async function setMode({ provider, mode } = {}) {
    requireProvider(provider);
    if (mode !== "auto" && mode !== "manual") throw new AccountsError("unknown-provider");
    const res = await accounts.mutate(provider, (state) => (allSeats(state).length === 0 ? null : { ...state, mode }));
    if (!res.ok) throw new AccountsError("unknown-provider");
    return requireView(provider);
  }

  async function setActive({ provider, seatId } = {}) {
    requireProvider(provider);
    const res = await accounts.mutate(provider, (state) =>
      findSeat(state, (s) => s.id === seatId) ? { ...state, activeSeatId: seatId } : null,
    );
    if (!res.ok) throw new AccountsError("unknown-seat");
    // The stored assignments are not touched: in manual mode the resolver
    // ignores them, and in auto mode the active seat is only a tie-break.
    return requireView(provider);
  }

  async function rename({ provider, kind, id, label } = {}) {
    requireProvider(provider);
    const clean = cleanLabel(label);
    if (!clean) throw new AccountsError("invalid-label");
    if (kind !== "account" && kind !== "seat") throw new AccountsError("unknown-seat");
    const res = await accounts.mutate(provider, (state) => renameInState(state, { kind, id, label: clean }));
    if (!res.ok) throw new AccountsError("unknown-seat");
    return requireView(provider);
  }

  /**
   * The seat that takes over as the box's live login when the live one goes: the
   * provider's active seat if it is another usable seat, else the least-loaded
   * usable one (same ranking as seat assignment). Needs its own directory — only
   * a directory seat has a login to promote. Null when there is none.
   */
  function pickReplacement(provider, states, seatId) {
    const candidates = states.seats.filter((s) => s.seatId !== seatId && !s.live && s.usable && s.dir);
    if (candidates.length === 0) return null;
    if (candidates.some((s) => s.seatId === states.activeSeatId)) return states.activeSeatId;
    const snaps = listSeatSnapshots().filter((x) => x?.provider === provider);
    const bySeat = new Map(snaps.filter((x) => x?.seatId).map((x) => [x.seatId, x]));
    const ranked = candidates.map((s) => bySeat.get(s.seatId) ?? { seatId: s.seatId });
    return leastLoadedSeat(ranked, { activeSeatId: states.activeSeatId })?.seatId ?? candidates[0].seatId;
  }

  async function removeSeat({ provider, seatId } = {}) {
    requireProvider(provider);
    const states = await accounts.seatStates(provider);
    const entry = states?.seats.find((s) => s.seatId === seatId);
    if (!entry) throw new AccountsError("unknown-seat");
    let liveSeatId = states.seats.find((s) => s.live)?.seatId ?? null;
    // The only login of a provider is never removed here (the provider would be
    // left with no seat and no live login) — Disconnect is the way to drop it.
    if (states.seats.length < 2) throw new AccountsError("last-seat");
    if (entry.live) {
      // The live login is about to disappear: make another seat the live one
      // FIRST (otherwise discovery would re-adopt whatever the live slot still
      // holds, straight after the removal). Any failure aborts with nothing
      // changed — the live slot is only overwritten once the replacement's
      // credentials were read successfully.
      const replacement = pickReplacement(provider, states, seatId);
      if (!replacement) throw new AccountsError("no-replacement");
      const made = await accounts.makeSeatLive(provider, replacement, {
        writeCodexEntry: provider === "codex" ? (e) => codex.restoreEntry(e) : undefined,
      });
      if (!made?.ok) throw new Error("promoting a replacement login failed");
      liveSeatId = replacement;
    }
    let removed = null;
    const res = await accounts.mutate(provider, (state) => {
      const out = removeSeatInState(state, seatId, liveSeatId);
      removed = out.seat;
      return out.seat ? out.state : null;
    });
    if (!res.ok || !removed) throw new AccountsError("unknown-seat");
    // The store no longer lists it; now its credentials and its conversations.
    if (removed.credentialDir) await dropDir(removed.credentialDir);
    await seatAssigner.forgetSeat(provider, seatId);
    return requireView(provider);
  }

  async function addSeat({ provider, accountId, label } = {}) {
    requireProvider(provider);
    await sweep();
    let cleanedLabel = null;
    if (label !== undefined && label !== null && label !== "") {
      cleanedLabel = cleanLabel(label);
      if (!cleanedLabel) throw new AccountsError("invalid-label");
    }
    const store = await accounts.getStore();
    if (accountId !== undefined && accountId !== null) {
      if (!store.providers[provider].accounts.some((a) => a.id === accountId)) throw new AccountsError("unknown-seat");
    }
    return provider === "claude"
      ? addClaudeSeat({ accountId: accountId ?? null, label: cleanedLabel })
      : addCodexSeat({ accountId: accountId ?? null, label: cleanedLabel });
  }

  async function addClaudeSeat({ accountId, label }) {
    const seatId = nextId("seat", [...(await accounts.takenSeatIds("claude")), ...pending.keys()]);
    const dir = accounts.seatDir("claude", seatId);
    accounts.reserveSeat("claude", seatId);
    let connect;
    try {
      await makeSeatDir(dir);
      connect = await claudeLogin.start(dir, seatId);
    } catch (e) {
      log.warn?.("[accounts] starting a Claude seat sign-in failed:", e?.message ?? e);
      accounts.releaseSeat("claude", seatId);
      await dropDir(dir);
      throw new AccountsError("login-failed");
    }
    pending.set(seatId, {
      seatId,
      provider: "claude",
      dir,
      accountId,
      label,
      startedAt: now(),
      state: "pending",
      sessionKey: connect?.sessionKey,
    });
    return { seatId, connect };
  }

  async function addCodexSeat({ accountId, label }) {
    // Make sure the live login's own seat copy is fresh BEFORE we borrow the slot.
    await accounts.seatStates("codex");
    const prev = await readCodexEntry(codex.livePath());
    // One OAuth wait per provider: a new add supersedes an older pending one.
    for (const old of pending.values()) {
      if (old.provider === "codex" && old.state === "pending") {
        rememberCodexGuard(old);
        await failFlow(old, "login-failed");
      }
    }
    const seatId = nextId("seat", [...(await accounts.takenSeatIds("codex")), ...pending.keys()]);
    const dir = accounts.seatDir("codex", seatId);
    accounts.reserveSeat("codex", seatId);
    let connect;
    try {
      connect = await codex.startConnect();
    } catch (e) {
      log.warn?.("[accounts] starting a Codex seat sign-in failed:", e?.message ?? e);
    }
    if (!isObj(connect) || connect.shape === "api-key" || !connect.shape) {
      accounts.releaseSeat("codex", seatId);
      throw new AccountsError("login-failed");
    }
    pending.set(seatId, {
      seatId,
      provider: "codex",
      dir,
      accountId,
      label,
      startedAt: now(),
      state: "pending",
      prev,
      epoch: connect.shape === "oauth-auto" ? codex.oauthEpoch() : undefined,
    });
    return { seatId, connect };
  }

  async function seatStatus({ seatId } = {}) {
    if (!isNonEmptyString(seatId)) throw new AccountsError("unknown-seat");
    await sweep();
    const rec = pending.get(seatId);
    if (!rec) {
      // Not a flow we know — but a seat that already exists is an answer.
      for (const provider of ACCOUNT_PROVIDERS) {
        const view = await providerView(provider);
        const seat = findSeatView(view, seatId);
        if (seat) return { state: "ok", seat };
      }
      return { state: "failed", error: "login-failed" };
    }
    await resolveFlow(rec);
    if (rec.state === "pending") return { state: "pending" };
    if (rec.state === "ok") {
      const seat = findSeatView(await providerView(rec.provider), seatId);
      return seat ? { state: "ok", seat } : { state: "failed", error: "login-failed" };
    }
    const out = { state: "failed", error: rec.error ?? "login-failed" };
    if (rec.error === "different-org" && rec.orgName) out.orgName = rec.orgName;
    return out;
  }

  async function confirmSeat({ seatId, newAccount } = {}) {
    const rec = isNonEmptyString(seatId) ? pending.get(seatId) : null;
    if (!rec || !rec.parked || rec.state !== "failed" || !rec.identity) throw new AccountsError("unknown-seat");
    rec.parked = false;
    rec.state = "pending";
    try {
      // "new account": the seat goes where its own org says (a new account, or
      // an existing one for that org). "no": into the account the user chose,
      // org mismatch notwithstanding — they said it belongs there.
      await placeFlow(rec, rec.identity, newAccount === true ? { accountId: null } : { skipOrgCheck: true });
    } catch (e) {
      log.warn?.("[accounts] confirming a seat failed:", e?.message ?? e);
      await failFlow(rec, "login-failed");
      throw new AccountsError("login-failed");
    }
    if (rec.state !== "ok") throw new AccountsError("login-failed");
    return requireView(rec.provider);
  }

  async function cancelSeat({ seatId } = {}) {
    const rec = isNonEmptyString(seatId) ? pending.get(seatId) : null;
    if (!rec) return { ok: true }; // nothing in flight: already as cancelled as it gets
    if (rec.state === "ok") {
      pending.delete(seatId); // a finished seat is a real seat — leave it be
      return { ok: true };
    }
    // A login that already finished (its credentials are on disk) is placed
    // before anything is dropped: closing the panel must not throw one away.
    if (rec.state === "pending" && rec.provider === "claude") await resolveFlow(rec);
    if (rec.state === "ok") {
      pending.delete(seatId);
      return { ok: true };
    }
    if (rec.state === "pending" && rec.provider === "codex") rememberCodexGuard(rec);
    rec.parked = false;
    await failFlow(rec, "login-failed");
    pending.delete(seatId);
    return { ok: true };
  }

  async function sessionSeat({ sessionId } = {}) {
    if (!isNonEmptyString(sessionId)) return null;
    const found = seatAssigner.sessionAssignment(sessionId);
    if (!found) return null;
    const provider = found.provider;
    const states = await accounts.seatStates(provider);
    if (!states) return null;
    const store = await accounts.getStore();
    return buildSessionSeat({
      found,
      state: store.providers[provider],
      states,
      seatSnapshots: listSeatSnapshots().filter((x) => x?.provider === provider),
    });
  }

  // -------------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------------

  /** Wrap a channel: contract refusals are results, anything else is one safe literal. */
  function channel(name, fn) {
    return async (input) => {
      try {
        return await fn(isObj(input) ? input : {});
      } catch (e) {
        if (e instanceof AccountsError) return { error: e.code };
        log.warn?.(`[accounts] ${name} failed:`, e?.message ?? e);
        throw new Error(ACCOUNTS_SAFE_ERROR_MESSAGE);
      }
    };
  }

  const channels = {
    "accounts:list": channel("accounts:list", list),
    "accounts:set-mode": channel("accounts:set-mode", setMode),
    "accounts:set-active": channel("accounts:set-active", setActive),
    "accounts:rename": channel("accounts:rename", rename),
    "accounts:add-seat": channel("accounts:add-seat", addSeat),
    "accounts:seat-status": channel("accounts:seat-status", seatStatus),
    "accounts:add-seat-confirm": channel("accounts:add-seat-confirm", confirmSeat),
    "accounts:cancel-seat": channel("accounts:cancel-seat", cancelSeat),
    "accounts:remove-seat": channel("accounts:remove-seat", removeSeat),
    "accounts:session-seat": channel("accounts:session-seat", sessionSeat),
  };

  return {
    channels,
    onProviderLoginLanded,
    /** One background pass over the in-flight sign-ins (see `sweep`). */
    tick: sweep,
    // exposed for tests and the wiring in index.mjs
    list,
    setMode,
    setActive,
    rename,
    removeSeat,
    addSeat,
    seatStatus,
    confirmSeat,
    cancelSeat,
    sessionSeat,
    _pending: () => pending,
    _guards: () => guards,
  };
}
