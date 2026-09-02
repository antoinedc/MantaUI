// ctoCards.mjs — the durable needs-you card machinery (BET-1382 / spec §10.3,
// §9.2-blockers, D20) and its first population: blocker cards.
//
// One code path / no dead copy: `cards.json` carries all four variants
// (blocker | decision | veto | connect) so later issues add writers without a
// migration (§13.1), but ONLY `blocker` is written here — the decision/veto/
// connect writers and all rendering are later issues, explicitly out of scope.
//
// Two timers by design (spec §10.3, D20): the blocking-tier NOTIFICATION fires
// IMMEDIATELY through the EXISTING router (push.mjs firePush) and is NOT
// re-fired or duplicated here; the CARD appears only once the ask stays
// pending > 10 min (BLOCKER_AFTER_MS). This module is the card half only — it
// deliberately has NO notification code path, and its tests assert that.
//
// Stable ids: id = hash(sourceKind, sourceId); re-detection upserts the
// existing card in place, never duplicates (spec §9.1: a regeneration updates
// the existing card — age, counts, carried-forward open state — never
// re-creates it).
//
// Liveness (spec §10.3): every card holds a resolution predicate re-checked on
// the relevant bus events — question replied/rejected, permission replied,
// session aborted, health recovered. Predicate false → `state:"resolved"` plus
// a `card.resolved` ACTIVITY-LEDGER entry — explicitly NOT a verdict, so
// self-resolution never pollutes acceptance stats. Resolved/dismissed cards
// move OUT of cards.json (which holds open cards only) into the ledger.
//
// Sources (P1): (1) worker question/permission pending — registered from the
// existing ask events, promoted at > 10 min by the engine's card timer;
// (2) health escalations — the watchdog's blocker-card requests that A2
// (ctoEngine) already writes to `engine-state.json` `pendingBlockers`.
//
// BET-1407: the worker-ask registry is persisted (engine-state.json
// `pendingAsks`, via the engine's bound patchEngineState — same single write
// path as `pendingBlockers`) and seeded back on start, so a restart mid-ask
// cannot drop an ask that had already crossed the 10-min card threshold.
// Entries past the existing blocker retention window (INBOX_TTL_MS.blocker)
// are dropped at seed; promoted asks are consumed from the registry.
//
// Determinism + testability: pure helpers are exported (stableCardId, ask
// event classification, blocker copy); the stateful card manager is
// `createCtoCards` with injected store/ledger/clock exactly like the other
// server engines. No live tmux/opencode; every durable path resolves under
// ctoPath() (test-sandbox rule).

import { createHash } from "node:crypto";
import { cardHasContent } from "../shared/ctoCard.mjs";
import {
  INBOX_TTL_MS,
  cardsStore,
  engineStateStore,
  isExpired,
  ledgerStore,
  patchStore,
} from "./ctoStores.mjs";

export const ACTOR = "cto";

// The card appears when an ask stays pending >= this long (spec §10.3: card at
// > 10 min). The blocking-tier notification already fired immediately via the
// router (D20) — this is the *second* timer, the card.
export const BLOCKER_AFTER_MS = 10 * 60_000;

export const VARIANTS = Object.freeze(["blocker", "decision", "veto", "connect"]);
export const CARD_STATES = Object.freeze(["open", "resolved", "dismissed"]);

// ACTIVITY-ledger row kinds for the card lifecycle. Resolution/dismissal write
// these to the A1 activity ledger — a resolved row is explicitly NOT a verdict
// (spec §10.3), so these never reach the verdicts store and cannot pollute
// acceptance stats.
export const CARD_CREATED = "card.created";
export const CARD_RESOLVED = "card.resolved";
export const CARD_DISMISSED = "card.dismissed";

// Blocker source discriminator for health/watchdog escalations (distinct from
// the question|permission worker-ask source kinds).
export const HEALTH_SOURCE_KIND = "health";
// Source (3): an inbox note of kind `blocker` sent via send_to_cto (BET-1397 /
// spec §4.4). It becomes an A8 blocker-card source — the blocking-tier
// notification fires IMMEDIATELY through the existing router (the same one
// source 1 relies on), and the card appears at > 10 min via promoteDue.
export const INBOX_SOURCE_KIND = "inbox";
// Connect-ask cards (BET-1395 / §7.4): one §7.2 tool identity per card, keyed
// by the tool id.
export const CONNECT_SOURCE_KIND = "tool";
// Probe-failure blocker cards (BET-1396 / §10.6-7): an auth-shaped probe
// failure that degraded the digest. Keyed by `<tool>/<probe>`; the body
// deep-links (in copy) to the secrets surface — the fix is a rotated key.
export const PROBE_SOURCE_KIND = "probe";

// BET-1498: engine-state.json marker key for the one-time prune of the
// pre-BET-1469 contentless open cards. Same idempotency contract as the
// watchers migration (ctoWatchers.mjs migrateLegacy): the stamp lands only
// after the prune's save succeeded, so a failed write retries next boot and
// a re-deploy is a no-op.
export const CONTENTLESS_CARD_PRUNE_KEY = "contentlessCardPrune";

// Pure split for the BET-1498 one-time prune: drop ONLY open rows that fail
// the shared cardHasContent predicate — the §10.3-invisible residue BET-1469
// stopped writing (no coerced title AND no coerced body renders in no pane
// section and, since BET-1476, no longer counts toward the badge, so nothing
// could ever resolve or dismiss it). Rows that are not open — and malformed
// rows — are left exactly where they are; this retires dead rows, it does
// not relitigate the store's schema.
export function splitContentlessOpenCards(cards) {
  const rows = Array.isArray(cards) ? cards : [];
  const keep = [];
  const dropped = [];
  for (const c of rows) {
    if (c && c.state === "open" && !cardHasContent(c)) dropped.push(c);
    else keep.push(c);
  }
  return { keep, dropped };
}

// BET-1516: engine-state.json marker key for the one-time prune of the
// orphaned `concurrentEphemeral` health card. BET-1513 made the concurrency
// limit trips shed (pause:false) — they no longer call recordBlocker — so a
// `pendingBlockers` entry or an open health card carrying one of these
// reasons predates that change and is pure residue: re-upserted by every
// tick forever, never closable by hand without folding the whole rate_limit
// group. Same idempotency contract as CONTENTLESS_CARD_PRUNE_KEY.
export const SHED_CARD_PRUNE_KEY = "shedCardPrune";
export const SHED_RATE_LIMIT_REASONS = Object.freeze([
  "concurrentEphemeral",
  "concurrentDelegate",
]);

// Pure split for the BET-1516 one-time prune: drop ONLY open HEALTH cards
// whose sourceId is the rate_limit group and whose body is one of the shed
// reasons (BET-1513: shed trips never recordBlocker again, so any such card
// today is residue, not a live signal). Non-open / malformed / other cards
// are left exactly where they are.
export function splitOrphanedShedCards(cards) {
  const rows = Array.isArray(cards) ? cards : [];
  const keep = [];
  const dropped = [];
  for (const c of rows) {
    const isOrphan =
      c &&
      c.state === "open" &&
      c.variant === "blocker" &&
      c.sourceKind === HEALTH_SOURCE_KIND &&
      c.sourceId === "rate_limit" &&
      SHED_RATE_LIMIT_REASONS.includes(c.body);
    if (isOrphan) dropped.push(c);
    else keep.push(c);
  }
  return { keep, dropped };
}

// ----- Pending-findings queue rows (BET-1516 / §9.1) -----
//
// A blocker enters the pipeline on the next engine tick via the findings.json
// queue (the §9.2-v2 bypass removed: the note used to ride into evidence only
// at a rollup-close breakpoint). Two producers, one row shape:
//   - an inbox blocker note, queued at note arrival (source "inbox")
//   - a worker ask promoted past the 10-min threshold (source "ask")
// The ENGINE's drain turns each row into a high-salience evidence row on the
// A1 ledger — for inbox notes the exact row shape drainInbox writes — and
// marks the source note read so the breakpoint drain never double-folds it.
// Pure builders; these shapes are the producer↔consumer contract.

export function findingFromInboxNote(entry, { ts = Date.now() } = {}) {
  if (!entry || typeof entry !== "object") return null;
  return {
    source: "inbox",
    ts,
    // The inbox entry id — the drain's dedupe marker against drainInbox (it
    // marks this note read after the ledger row fires).
    noteId: typeof entry.id === "string" ? entry.id : undefined,
    noteKind: "blocker",
    message: entry.message,
    title: entry.title,
    tag: entry.tag ?? undefined,
    refs: Array.isArray(entry.refs) ? entry.refs : [],
    sender: entry.sender && typeof entry.sender === "object" ? entry.sender : undefined,
    // A note may NAME a checkable condition (§10.3 predicate 2 — "when the
    // plan or note names one"). Carried to the ask/card for the liveness pass.
    condition: typeof entry.condition === "string" && entry.condition ? entry.condition : undefined,
  };
}

export function findingFromPromotedAsk(ask, { ts = Date.now() } = {}) {
  if (!ask || typeof ask !== "object") return null;
  return {
    source: "ask",
    ts,
    sourceKind: ask.sourceKind,
    sourceId: ask.sourceId,
    sessionID: ask.sessionID ?? ask.noteSessionID ?? undefined,
    message: ask.body,
    title: blockerTitle(ask.sourceKind, ask.title),
    refs: Array.isArray(ask.refs) ? ask.refs : [],
  };
}

// §10.3 predicate 2 classifier (pure): a §6.7 surface verify result against
// the condition the note named. GONE when the verify definitively shows the
// named state no longer holds. "no surface"/"unavailable" mean "no opinion"
// — a probe that cannot see the surface must never resolve the card. Caller
// passes the match from matchCheckable (null → no opinion).
export function isConditionGoneResult(match, verifyResult) {
  if (!match) return null;
  if (!verifyResult || typeof verifyResult !== "object") return null;
  if (verifyResult.ok !== false) return false;
  const result = String(verifyResult.result ?? "");
  return result !== "no surface" && result !== "unavailable";
}

// §10.3 inbox-card liveness (BET-1516, pure): evaluate the three predicates
// against one open inbox-sourced blocker card. Returns `null` (all predicates
// hold / no opinion — the card stays) or `{reason}` naming the one that went
// false. Evaluation order is deterministic: the TTL stamp (sync, cheapest),
// then the named condition, then the sender session. When the exact TTL stamp
// is absent (a pre-1516 card), the blocker retention window counted from the
// card's carried-forward first report is the bound — stricter than the note's
// real expiry, never a card outliving its note.
export async function inboxCardLivenessGone(card, { nowMs, hasSession = null, conditionGone = null } = {}) {
  if (!card || card.state !== "open" || card.variant !== "blocker") return null;
  const ttlBound = Number.isFinite(card.noteExpires)
    ? card.noteExpires
    : Number.isFinite(card.pendingSince)
      ? card.pendingSince + INBOX_TTL_MS.blocker
      : null;
  if (ttlBound != null && nowMs > ttlBound) {
    return { reason: "inbox note expired" };
  }
  if (typeof conditionGone === "function" && typeof card.noteCondition === "string" && card.noteCondition) {
    let gone = null;
    try {
      gone = await conditionGone(card.noteCondition);
    } catch {
      gone = null;
    }
    if (gone === true) return { reason: "condition gone" };
  }
  if (typeof hasSession === "function" && typeof card.noteSessionID === "string" && card.noteSessionID) {
    let exists = null;
    try {
      exists = await hasSession(card.noteSessionID);
    } catch {
      exists = null;
    }
    if (exists === false) return { reason: "sender session gone" };
  }
  return null;
}

// §10.6-7 probe-auth-failure card copy (3 consecutive auth failures — the
// runner's AUTH_FAIL_ESCALATE). `secretKey` is the vault KEY NAME (not a
// value) when the spec declared one — naming the exact key the user should
// update is the deep-link to the secrets surface in words. The body keeps the
// literal phrase "on the secrets surface" — the renderer's probeSecretKey
// parse anchor (ctoView.ts) — and names the REAL surface after the dash: the
// 🔑 SecretsCard in the chat session (BET-1437 deep-link target), never
// "Settings → Secrets" (that Settings section does not exist).
export function probeBlockerCopy(tool, probeName, secretKey = null) {
  const secret = secretKey
    ? ` If the key was rotated, update "${secretKey}" on the secrets surface — the 🔑 secrets card in your chat session.`
    : " Check the tool's credential on the secrets surface — the 🔑 secrets card in your chat session.";
  return {
    title: `Probe failing — ${tool} key may have been rotated`,
    body: `The "${probeName}" probe for ${tool} failed auth 3 times in a row (HTTP 401/403 or the credential is gone), so the digest's view of ${tool} is degraded.${secret}`,
  };
}

// Stable, collision-resistant card id. Re-detection of the same (sourceKind,
// sourceId) yields the same id → upsert in place, never a duplicate.
export function stableCardId(sourceKind, sourceId) {
  return createHash("sha256")
    .update(`${sourceKind}\u0000${String(sourceId)}`)
    .digest("hex")
    .slice(0, 24);
}

// ----- Ask-event classification (pure) -----

export const ASK_START_TYPES = Object.freeze(["question.asked", "permission.asked"]);
export const ASK_RESOLVE_TYPES = Object.freeze([
  "question.replied",
  "question.rejected",
  "permission.replied",
  "permission.rejected",
]);

// The blocker-card source kind for a worker-ask event type.
export function askSourceKind(type) {
  return type === "permission.asked" ? "permission" : "question";
}

export function isAskStartEvent(evt) {
  return !!evt && ASK_START_TYPES.includes(evt.type);
}

export function isAskResolveEvent(evt) {
  return !!evt && ASK_RESOLVE_TYPES.includes(evt.type);
}

// Reduce a `question.asked` / `permission.asked` event to the pending-ask
// identity `{sourceKind, sourceId, sessionID}` used to key the card. The ask's
// request id (`properties.id`) is the stable sourceId; a session is blocked on
// at most one ask, so it also keys the in-flight registry.
export function askStartInfo(evt) {
  if (!isAskStartEvent(evt)) return null;
  const props = evt?.properties ?? {};
  const sessionID = typeof props.sessionID === "string" ? props.sessionID : null;
  const sourceId = typeof props.id === "string" && props.id ? props.id : sessionID;
  return { sourceKind: askSourceKind(evt.type), sourceId, sessionID };
}

// Reduce a reply/reject event to the session whose ask just cleared.
export function askResolveInfo(evt) {
  if (!isAskResolveEvent(evt)) return null;
  const props = evt?.properties ?? {};
  return { sessionID: typeof props.sessionID === "string" ? props.sessionID : null };
}

// ----- Inbox-note grouping (pure) -----
//
// The §10.3 never-duplicate rule applied to inbox blocker notes. Health
// escalations already fold by CONDITION (healthGroupKey); inbox notes used to
// key on `tag || message`, so a watchdog reporting the SAME condition every
// tick — with the percentage, free-GB and tick timestamp moving each time —
// minted a brand-new card per tick. That is the literal 2026-09-01 incident:
// five "Blocker flagged for CTO" cards, one root-disk condition.
//
// The key is layered, first hit wins:
//   1. `tag`      — the sender's own dedupe key (§4.4). Authoritative.
//   2. `project`  — the sender session's resolved workspace, when the session
//                   is tmux-stamped. Sessionless / subagent senders (which is
//                   most watchdogs) resolve to nothing, hence layer 3.
//   3. sender slug — the agent's self-identifying prefix, the way these notes
//                   actually open ("tenanture-ops watchdog: …", "🤖 tenanture-ops
//                   tick …"). One recurring reporter → one card.
//   4. message    — the old whole-text hash, kept as the last resort so a note
//                   that identifies itself in no way at all still gets a card.

// Leading decoration a note may open with before its slug: emoji/pictographs,
// zero-width joiners, variation selectors, and surrounding whitespace.
const NOTE_DECORATION_RE = /^[\s\u200d\ufe0f\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]+/u;

// The sender's self-identifying slug: the leading `word` (letters/digits with
// internal - or _) of a note, lowercased. Returns null when the note does not
// open with one, or when the leading token is a bare number/date (never an
// identity). Deliberately NOT a general text normalizer — it reads only the
// prefix agents use to name themselves, which is stable while the rest of the
// sentence (percentages, sizes, timestamps) moves every tick.
export function senderSlug(text) {
  if (typeof text !== "string") return null;
  const stripped = text.replace(NOTE_DECORATION_RE, "");
  const m = stripped.match(/^([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)/);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  // A single letter is noise ("A note that…"); two characters is already a
  // real identity in practice (work-unit names like "U6").
  return slug.length >= 2 ? slug : null;
}

// The grouping identity for one inbox blocker note. Pure; `project` is the
// caller-resolved workspace (may be undefined). Always returns a non-empty
// string so a card is never dropped for want of a key.
export function inboxGroupKey({ tag, title, message, project } = {}) {
  if (typeof tag === "string" && tag) return `tag:${tag}`;
  if (typeof project === "string" && project) return `project:${project}`;
  const slug = senderSlug(title) ?? senderSlug(message);
  if (slug) return `sender:${slug}`;
  return `text:${typeof message === "string" ? message : ""}`;
}

// Human blocker copy for a worker-ask event (title/body). Pure.
// `noteTitle` (inbox only) is the SENDER's own headline — every one of these
// notes carries a good one ("Root fs 95% on runtime host — needs human cleanup
// decision") and the card used to throw it away for a constant, which is a
// large part of why several distinct cards read as one thing repeated.
export function blockerTitle(kind, noteTitle) {
  if (kind === "permission") return "Permission needed";
  if (kind === "question") return "Question waiting";
  if (kind === "inbox") {
    const t = typeof noteTitle === "string" ? noteTitle.trim() : "";
    return t || "Blocker flagged for CTO";
  }
  return "Health check";
}

export function blockerBody(kind, text) {
  if (kind === "permission") return text || "Claude needs permission to run a tool.";
  if (kind === "question") return text || "Claude is waiting on an answer.";
  if (kind === "inbox") return text || "A session flagged a blocker for the CTO.";
  return text || "The CTO paused itself — review the health state.";
}

// Extract the human question text from a `question.asked` payload.
export function askQuestionText(evt) {
  const props = evt?.properties ?? {};
  if (isAskStartEvent(evt) && askSourceKind(evt.type) === "question") {
    const q = Array.isArray(props.questions) && props.questions[0];
    return (q && (q.question || q.header)) || "";
  }
  return "";
}

// BET-1407: the in-flight ask registry's key, shared by BOTH halves (the
// in-memory map and the persisted `pendingAsks` array): the session when the
// ask came from one, else the stable source id (sessionless inbox notes).
// One derivation — memory and store can never disagree on identity.
function askKeyOf(a) {
  return (a && (a.sessionID || a.sourceId)) ?? null;
}

// BET-1463: the health-card grouping identity for one `pendingBlockers`
// entry — every entry from the same underlying trip source (`recordBlocker`'s
// `source` param, e.g. "watchdog" | "rate_limit") is the SAME ongoing
// condition and folds into ONE card, never one card per entry.
function healthGroupKey(b) {
  return typeof b?.source === "string" && b.source ? b.source : "unknown";
}

// BET-1463 (defect 2): compare a freshly-built card against the existing open
// card, ignoring `updatedAt` (which always moves — it is the "when did we
// last check" stamp, not content). A content-identical rebuild is not a
// change: no save, no CARD_CREATED ledger row. Arrays are compared by value.
// `repeatCount` is excluded for the same reason as `updatedAt`: it is
// bookkeeping ABOUT the change, not content. Including it would make every
// rebuild differ from itself and defeat the no-op rule entirely.
function cardContentEqual(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("updatedAt");
  keys.delete("repeatCount");
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av ?? []) !== JSON.stringify(bv ?? [])) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The card manager — injected store/ledger/clock.
// ---------------------------------------------------------------------------

export function createCtoCards(deps = {}) {
  const {
    cardStore = cardsStore,
    engineState = engineStateStore,
    ledger = ledgerStore,
    // Source (3) router (BET-1397): the existing blocking-tier notification
    // router (push.mjs fireNotify). Only `onInboxBlocker` uses it — worker-ask
    // and health cards keep the "no notification path" invariant.
    fireNotify = async () => {},
    // Resolves a session id to its workspace (`{project}`) — the engine's own
    // getSessionInfo. Used ONLY as grouping layer 2 for inbox notes; a
    // sessionless/subagent sender (most watchdogs) resolves to nothing and
    // falls through to the sender-slug layer. Best-effort by contract.
    getSessionInfo = null,
    now = () => Date.now(),
    // BET-1463: the writer for consuming/dropping a `pendingBlockers` entry in
    // engine-state.json once its health card has been upserted or its card
    // has closed. This MUST route through the engine's own `patchEngineState`
    // (ctoStores.mjs) so it shares the same process-wide mutex as every other
    // engine-state writer (e.g. `recordBlocker`) — ctoCards.mjs deliberately
    // does NOT import patchEngineState itself; the engine injects its own
    // bound instance here, the same way it injects getSessionInfo /
    // getDesktopPresence into sibling modules. `mutation` is the same
    // shape patchEngineState accepts: a static patch object, or a
    // `(fresh) => patch` function. Defaults to null (a no-op) so standalone/
    // test usage that doesn't care about pendingBlockers lifecycle keeps
    // working without wiring it.
    // BET-1407: the SAME bound instance now also carries the worker-ask
    // registry's persisted half (engine-state.json `pendingAsks`) — one
    // writer, one mutex, one consume-and-prune shape for both queues.
    patchEngineState: patchEngineStatePatch = null,
    // BET-1516 (§9.1): the pending-findings queue writer — the engine injects
    // a bound append into findings.json. Both blocker entry points route
    // through it (inbox notes at arrival, worker asks at promotion), and the
    // engine's card tick drains the queue into the A1 ledger. Default null
    // (a no-op) so standalone/test usage without the engine keeps working.
    queueFinding = null,
    // BET-1516 (§10.3 predicate 1): does an opencode session exist? The
    // engine injects the box's sessionExists (404 → false, transient → true).
    // Default null — the predicate is skipped when no checker is wired.
    hasSession = null,
    // BET-1516 (§10.3 predicate 2): is the condition a note named now GONE?
    // Returns true (gone) / false (holds) / null (no opinion). The engine
    // injects the §6.7 matcher + surface verify. Default null — skipped.
    conditionGone = null,
  } = deps;

  // In-flight worker asks: key (sessionID, or sourceId for sessionless inbox
  // notes) -> { sourceKind, sourceId, sessionID, body, askedAt, refs? }.
  // BET-1407: no longer memory-only — every registration mirrors into
  // engine-state.json `pendingAsks` (see registerAsk) and start() seeds this
  // map back from it, so an ask that crossed the 10-min card threshold while
  // the box was down still promotes instead of being lost. Once promoted, the
  // card itself is durable in cards.json and the registry entry is consumed.
  const pendingAsks = new Map();

  // Source (3): a `blocker` inbox note (BET-1397 / spec §4.4). This is the ONE
  // notification path for inbox notes: fires the blocking-tier notify through
  // the injected router exactly once, and registers a pending blocker so the
  // card timer (promoteDue) promotes it at > 10 min like any ask. Read-only on
  // the inbox itself — the inbound funnel already persisted the entry.
  // Grouping layer 2: the sender session's workspace, when it is tmux-stamped.
  // Never throws and never blocks the card path — an unresolvable sender just
  // falls through to the slug layer.
  async function resolveNoteProject(sessionID) {
    if (typeof getSessionInfo !== "function" || typeof sessionID !== "string" || !sessionID) {
      return undefined;
    }
    try {
      const info = await getSessionInfo(sessionID);
      return typeof info?.project === "string" && info.project ? info.project : undefined;
    } catch {
      return undefined;
    }
  }

  async function queueInboxFinding(row) {
    if (typeof queueFinding !== "function") return;
    try {
      await queueFinding(row);
    } catch (e) {
      console.warn("[cto] finding queue append failed:", e?.message ?? e);
    }
  }

  // Source (3): a `blocker` inbox note (BET-1397 / spec §4.4). This is the ONE
  // notification path for inbox notes: fires the blocking-tier notify through
  // the injected router exactly once, and registers a pending blocker so the
  // card timer (promoteDue) promotes it at > 10 min like any ask. Read-only on
  // the inbox itself — the inbound funnel already persisted the entry.
  // Grouping layer 2: the sender session's workspace, when it is tmux-stamped.
  // Never throws and never blocks the card path — an unresolvable sender just
  // falls through to the slug layer.
  //
  // BET-1516 (§9.1): the note ALSO enters the pipeline — the finding row is
  // queued (findings.json) and the engine's card tick turns it into evidence
  // within a minute; the notification itself is untouched (its own timer).
  // The sender session id is now threaded through (`sender.sessionID` is what
  // the funnel sends; a top-level sessionID stays accepted for tests) — it
  // routes the notification, keys the ask row, and feeds the card's
  // sender-session liveness predicate.
  async function onInboxBlocker({ message, title, refs = [], tag, sender, sessionID, ts = now(), id, expires, condition } = {}) {
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) return { changed: false, notified: false };
    const noteSessionID =
      (sender && typeof sender.sessionID === "string" && sender.sessionID) ||
      (typeof sessionID === "string" && sessionID ? sessionID : undefined) ||
      undefined;
    // Blocking-tier notification — exactly one, via the shared router.
    try {
      await fireNotify({
        message: text,
        title: typeof title === "string" && title ? title : undefined,
        urgent: true,
        sessionID: noteSessionID,
      });
    } catch (e) {
      console.warn("[cto] inbox blocker notify failed:", e?.message ?? e);
    }
    // Register a pending blocker so the card appears at > 10 min. The card id
    // is keyed by the note's CONDITION (inboxGroupKey), not its prose, so a
    // watchdog restating the same condition every tick upserts one card
    // instead of minting a new one per tick.
    const project = await resolveNoteProject(noteSessionID);
    const groupKey = inboxGroupKey({ tag, title, message: text, project });
    const sourceId = stableCardId(INBOX_SOURCE_KIND, groupKey);
    // §10.3 predicate inputs ride the ask row: the note's identity, its TTL
    // stamp (refreshed by every restatement — a card can never outlive the
    // note that raised it), the sender session, and any named condition.
    const noteExpires = Number.isFinite(expires) ? expires : undefined;
    const noteCondition =
      typeof condition === "string" && condition ? condition : undefined;
    await registerAsk({
      sourceKind: INBOX_SOURCE_KIND,
      sourceId,
      // Deliberately NOT keyed by sessionID: a recurring reporter opens a new
      // session per tick, so keying the registry by session would re-open the
      // per-tick duplication the group key just closed. `askKeyOf` falls back
      // to sourceId, which IS the condition.
      sessionID: undefined,
      noteSessionID,
      noteId: typeof id === "string" ? id : undefined,
      noteExpires,
      noteCondition,
      title: typeof title === "string" ? title : undefined,
      body: text,
      refs: Array.isArray(refs) ? refs : [],
      askedAt: ts,
    });
    // §9.1: the blocker enters the pipeline on the next engine tick — queue
    // the finding AFTER the notify (the notification is the immediate timer,
    // the pipeline entry rides the queue). Best-effort by contract.
    await queueInboxFinding(
      findingFromInboxNote(
        { id, kind: "blocker", message: text, title, tag, refs, sender: { ...sender, sessionID: noteSessionID }, condition: noteCondition },
        { ts },
      ),
    );
    return { changed: true, notified: true, groupKey };
  }

  // BET-1407: best-effort persist of one registry change through the engine's
  // bound patchEngineState — the SAME sanctioned read-modify-write path
  // recordBlocker and the pendingBlockers writers use (one process-wide
  // mutex, no second write path, no bare save). A null writer (standalone/
  // test usage without the engine) is a memory-only registry.
  async function persistPendingAsks(mutation) {
    if (typeof patchEngineStatePatch !== "function") return;
    try {
      await patchEngineStatePatch(mutation);
    } catch {
      /* best-effort — a registry write failure never takes the card path down */
    }
  }

  // BET-1407: ONE registration idiom for BOTH ask sources (worker asks via
  // onAskStart, inbox blocker notes via onInboxBlocker) — set the in-memory
  // row, then mirror it into engine-state.json `pendingAsks` under the same
  // key. Replace-in-place, never duplicate: re-registration is a no-op upsert
  // in both halves.
  async function registerAsk(ask) {
    const key = askKeyOf(ask);
    if (key == null) return;
    pendingAsks.set(key, ask);
    await persistPendingAsks((fresh) => {
      const rows = Array.isArray(fresh?.pendingAsks) ? [...fresh.pendingAsks] : [];
      const idx = rows.findIndex((r) => askKeyOf(r) === key);
      if (idx >= 0) rows[idx] = ask;
      else rows.push(ask);
      return { pendingAsks: rows };
    });
  }

  // BET-1407: remove registry rows by key from BOTH halves (the in-memory map
  // and the persisted array). Best-effort; a pure no-op patch (no save) when
  // no row matches. Malformed rows (unkeyable) are never matched.
  async function removePendingAskRows(keys) {
    const keySet = new Set((keys ?? []).filter((k) => k != null));
    if (!keySet.size) return;
    for (const k of keySet) pendingAsks.delete(k);
    await persistPendingAsks((fresh) => {
      const rows = Array.isArray(fresh?.pendingAsks) ? fresh.pendingAsks : [];
      const next = rows.filter((r) => !keySet.has(askKeyOf(r)));
      return next.length === rows.length ? {} : { pendingAsks: next };
    });
  }

  async function ledgerAppend(entry) {
    try {
      await ledger.append({ actor: ACTOR, ts: now(), ...entry });
    } catch {
      /* best-effort — a ledger failure never takes the card machinery down */
    }
  }

  async function openCards() {
    let payload;
    try {
      payload = await cardStore.load();
    } catch {
      payload = {};
    }
    return {
      payload,
      cards: Array.isArray(payload?.cards) ? payload.cards : [],
    };
  }

  function buildBlockerCard({ id, sourceKind, sourceId, sessionID, title, body, refs, pendingSince, created, noteId, noteExpires, noteSessionID, noteCondition }) {
    // §10.3 liveness inputs (BET-1516): set ONLY when present so a card that
    // lacks them (worker-ask sourced, or a pre-1516 legacy rebuild) converges
    // byte-identically instead of churning on undefined keys.
    const noteFields = {};
    if (noteId != null) noteFields.noteId = noteId;
    if (Number.isFinite(noteExpires)) noteFields.noteExpires = noteExpires;
    if (noteSessionID != null) noteFields.noteSessionID = noteSessionID;
    if (noteCondition != null) noteFields.noteCondition = noteCondition;
    return {
      id,
      variant: "blocker",
      title,
      body,
      refs: Array.isArray(refs) ? refs : [],
      sourceKind,
      sourceId,
      // blocker-variant fields
      sessionID,
      pendingSince,
      created,
      updatedAt: created,
      state: "open",
      ...noteFields,
    };
  }

  // Upsert one blocker card by its stable id. Idempotent on re-detection: the
  // existing open card is updated in place (title/body/refs/age preserved),
  // never duplicated. Returns `{ ok, changed, isNew }` — `ok` is true when
  // the write path ran without exception (including the byte-identical
  // no-op, where the card is already current — BET-1477's "card path
  // worked" test), false when nothing was written (invalid args).
  //
  // BET-1464 defect 3: the read-fresh-merge-save runs under the cards store's
  // patchStore mutex, so a writer derived from a stale snapshot can no longer
  // erase a concurrent writer's card (reached from fire-and-forget call
  // sites — promoteDue timers, bus handlers — which used to race).
  async function upsertBlocker({ sourceKind, sourceId, sessionID, title, body, refs, ts = now(), pendingSince = ts, noteId, noteExpires, noteSessionID, noteCondition }) {
    const id = stableCardId(sourceKind, sourceId);
    let changed = false;
    let isNew = false;
    let cardRefs = [];
    await patchStore(cardStore, (fresh) => {
      const cards = Array.isArray(fresh?.cards) ? fresh.cards : [];
      const existing = cards.find((c) => c?.id === id && c?.state === "open");
      const created = existing?.created ?? ts;
      // A regeneration keeps the EARLIEST outstanding age (§9.1 carried-forward
      // open state): a recurring condition has been waiting since its first
      // report, not since its latest restatement.
      const since = Number.isFinite(existing?.pendingSince)
        ? Math.min(existing.pendingSince, pendingSince)
        : pendingSince;
      const card = buildBlockerCard({
        id,
        sourceKind,
        sourceId,
        sessionID,
        title,
        body,
        refs,
        pendingSince: since,
        created,
        noteId,
        noteExpires,
        noteSessionID,
        noteCondition,
      });
      cardRefs = card.refs;
      // BET-1463 (defect 2): a byte-identical rebuild is not a change — an
      // empty patch is a pure no-op (no save, no ledger row). This is what
      // stops an unanswered ask from being "re-created" every minute forever
      // by promoteDue.
      if (existing && cardContentEqual(existing, { ...card, updatedAt: ts })) return {};
      changed = true;
      isNew = !existing;
      // A genuine restatement of an existing condition — the count is the
      // escalation signal ("this has now fired 7 times"), which was previously
      // expressed as seven separate cards.
      const repeatCount = existing ? (existing.repeatCount ?? 1) + 1 : 1;
      const nextCards = existing
        ? cards.map((c) =>
            c === existing ? { ...existing, ...card, created, repeatCount, updatedAt: ts } : c,
          )
        : [...cards, { ...card, repeatCount }];
      return { cards: nextCards };
    });
    if (changed) {
      await ledgerAppend({
        kind: CARD_CREATED,
        cardId: id,
        variant: "blocker",
        sourceKind,
        sourceId,
        sessionID,
        refs: cardRefs,
      });
    }
    // BET-1477: the no-op still reports ok:true — the card is already on the
    // board and current, which is a successful outcome for a caller branching
    // on "did the card path work" (`res.ok !== false` in ctoSuggest).
    return { ok: true, changed, isNew };
  }

  // Shared close-path for resolve/dismiss: remove one open card by id (under
  // the cards patchStore mutex — BET-1464 defect 3), save, and write the
  // ledger row with the close kind (resolved vs dismissed). Two concurrent
  // closes of the same id now compose: the second re-reads fresh, finds the
  // card gone, and returns `{ changed: false }` instead of double-ledgering.
  async function closeOpenCard(id, kind, reason, ts = now()) {
    let closed = null;
    await patchStore(cardStore, (fresh) => {
      const cards = Array.isArray(fresh?.cards) ? fresh.cards : [];
      const idx = cards.findIndex((c) => c?.id === id && c?.state === "open");
      if (idx < 0) return {};
      closed = cards[idx];
      return { cards: cards.filter((_, i) => i !== idx) };
    });
    if (!closed) return { changed: false };
    await ledgerAppend({
      kind,
      cardId: id,
      variant: closed.variant,
      sourceKind: closed.sourceKind,
      refs: closed.refs,
      sessionID: closed.sessionID,
      reason,
    });
    // BET-1463 (defect 1): every pendingBlockers entry that fed the closed
    // health card must not survive in engine-state.json, or the next card
    // tick resurrects it (this is the "Resume doesn't work" bug). Covers
    // resolveById AND dismissById since both call this helper. `sourceId` for
    // a health card is the trip's GROUP KEY (see `healthGroupKey` below), not
    // one entry's id — multiple pendingBlockers entries fold into one card.
    if (closed.sourceKind === HEALTH_SOURCE_KIND) {
      await dropPendingBlockersByGroup(closed.sourceId);
    }
    return { changed: true, card: closed };
  }

  // Remove every `pendingBlockers` entry belonging to one health group (used
  // when its health card closes — resolved or dismissed). Best-effort, and a
  // pure no-op patch (no save) when nothing in the group is left.
  async function dropPendingBlockersByGroup(group) {
    if (!group || typeof patchEngineStatePatch !== "function") return;
    try {
      await patchEngineStatePatch((fresh) => {
        const pending = Array.isArray(fresh?.pendingBlockers) ? fresh.pendingBlockers : [];
        const next = pending.filter((b) => healthGroupKey(b) !== group);
        return next.length === pending.length ? {} : { pendingBlockers: next };
      });
    } catch {
      /* best-effort */
    }
  }

  // Stamp every ingested `pendingBlockers` entry `resolved: true` in one
  // batched patch (used right after ingestHealthEscalations processes them).
  // Best-effort; a missed stamp just means the same entry (harmlessly)
  // upserts the same card again next tick — the upsert itself is idempotent.
  async function markPendingBlockersConsumed(ids) {
    if (!ids.length || typeof patchEngineStatePatch !== "function") return;
    try {
      await patchEngineStatePatch((fresh) => {
        const pending = Array.isArray(fresh?.pendingBlockers) ? fresh.pendingBlockers : [];
        const idSet = new Set(ids);
        let touched = false;
        const next = pending.map((b) => {
          if (b && idSet.has(b.id) && b.resolved !== true) {
            touched = true;
            return { ...b, resolved: true };
          }
          return b;
        });
        return touched ? { pendingBlockers: next } : {};
      });
    } catch {
      /* best-effort */
    }
  }

  // Resolve one open card by id → `resolved` state + a card.resolved ACTIVITY
  // entry (never a verdict), and move it out of cards.json into the ledger.
  async function resolveById(id, { reason, ts = now() } = {}) {
    const r = await closeOpenCard(id, CARD_RESOLVED, reason, ts);
    if (!r.changed) return r;
    return { changed: true, card: { ...r.card, state: "resolved", resolvedAt: ts, resolvedReason: reason } };
  }

  // Register a worker is now blocked on an ask. No card yet — the card appears
  // only once promoteDue sees the ask past BLOCKER_AFTER_MS (or via a health
  // escalation). Re-registration (global + scoped duplicate) is a no-op upsert.
  // BET-1407: the ask also lands in engine-state.json `pendingAsks` so a
  // restart mid-ask can seed it back.
  async function onAskStart({ sourceKind, sourceId, sessionID, body, ts = now() }) {
    if (!sessionID) return;
    await registerAsk({ sourceKind, sourceId, sessionID, body, askedAt: ts });
  }

  // The ask was answered/rejected, or the owning session aborted → liveness
  // predicate false: resolve any open blocker card for that session, and
  // (BET-1407) prune the ask from both registry halves.
  async function onAskResolved({ sessionID, ts = now() } = {}) {
    if (!sessionID) return { changed: false };
    await removePendingAskRows([sessionID]);
    return resolveForSession(sessionID, "ask answered", ts);
  }

  async function resolveForSession(sessionID, reason, ts) {
    const { cards } = await openCards();
    const open = cards.filter((c) => c?.state === "open" && c?.variant === "blocker" && c?.sessionID === sessionID);
    let changed = false;
    for (const card of open) {
      changed = (await resolveById(card.id, { reason, ts })).changed || changed;
    }
    return { changed };
  }

  // The 10-min card timer: promote every in-flight ask past BLOCKER_AFTER_MS
  // into its blocker card. `{changed, promoted}` for diagnostics/tests.
  // BET-1407: each promoted ask is CONSUMED — removed from both registry
  // halves — because the card is now the durable surface (cards.json survives
  // restarts; the entry's job ends when the card machinery owns it). Removed
  // AFTER the upsert so a crash in between can only re-add the entry, which
  // converges on the next tick's byte-identical no-op upsert.
  async function promoteDue({ nowMs = now() } = {}) {
    let changed = false;
    let promoted = 0;
    const consumedKeys = [];
    for (const ask of pendingAsks.values()) {
      if (nowMs - ask.askedAt < BLOCKER_AFTER_MS) continue;
      const fallbackRef = ask.sessionID ?? ask.noteSessionID;
      const r = await upsertBlocker({
        sourceKind: ask.sourceKind,
        sourceId: ask.sourceId,
        sessionID: ask.sessionID,
        title: blockerTitle(ask.sourceKind, ask.title),
        body: blockerBody(ask.sourceKind, ask.body),
        refs: Array.isArray(ask.refs) && ask.refs.length ? ask.refs : fallbackRef ? [fallbackRef] : [],
        ts: nowMs,
        pendingSince: ask.askedAt,
        noteId: ask.noteId,
        noteExpires: ask.noteExpires,
        noteSessionID: ask.noteSessionID,
        noteCondition: ask.noteCondition,
      });
      changed = changed || r.changed;
      if (r.isNew) promoted += 1;
      // BET-1516 (§9.1): an ask past the §10.3 threshold enters the pipeline
      // too — the finding is queued at promotion, and the engine's card tick
      // turns it into evidence within a minute. Best-effort by contract.
      await queueInboxFinding(findingFromPromotedAsk(ask, { ts: nowMs }));
      consumedKeys.push(askKeyOf(ask));
    }
    if (consumedKeys.length) await removePendingAskRows(consumedKeys);
    return { changed, promoted };
  }

  // BET-1407: restart resilience — rebuild the in-memory registry from its
  // persisted half on engine start. An ask that crossed the 10-min card
  // threshold while the box was down still promotes on the next card tick
  // instead of being lost (the memory-only registry's "Resume doesn't work"
  // gap — the same class of bug BET-1463 fixed for pendingBlockers).
  //
  // Bound: entries past the EXISTING blocker retention window
  // (INBOX_TTL_MS.blocker — the week every blocker-class entry keeps, §4.4)
  // are dropped from BOTH halves — the registry must not accumulate forever,
  // and engine-state.json is not covered by the ctoStores retention sweeper.
  // Boundary-exact via the shared isExpired helper (an entry exactly at the
  // cutoff is kept). Rows that cannot be keyed or aged (no sessionID/sourceId,
  // no numeric askedAt) are unreconstructable and dropped with the stale ones
  // — a row with no askedAt would otherwise promote instantly on every
  // restart (nowMs - undefined is NaN, which skips the threshold check).
  // Pure no-op write when nothing is dropped. `{seeded, dropped}` for
  // diagnostics/tests.
  async function seedPendingAsks({ nowMs = now() } = {}) {
    let payload;
    try {
      payload = await engineState.load();
    } catch {
      return { seeded: 0, dropped: 0 };
    }
    const rows = Array.isArray(payload?.pendingAsks) ? payload.pendingAsks : [];
    const keep = [];
    let dropped = 0;
    for (const row of rows) {
      const key = askKeyOf(row);
      if (
        key != null &&
        typeof row?.askedAt === "number" &&
        !isExpired(row.askedAt, { nowMs, retentionMs: INBOX_TTL_MS.blocker })
      ) {
        keep.push(row);
        pendingAsks.set(key, row);
      } else {
        dropped += 1;
      }
    }
    if (dropped) await persistPendingAsks(() => ({ pendingAsks: keep }));
    return { seeded: keep.length, dropped };
  }

  // BET-1498: one-time retirement of the pre-BET-1469 residue — open cards in
  // cards.json with neither a title nor a body. BET-1476 already stopped the
  // badge counting them, so they render nowhere and nothing can ever resolve
  // or dismiss them: dead rows that only a load-time prune can retire.
  // Marker-guarded in engine-state.json with the same contract as the
  // watchers migration (ctoWatchers migrateLegacy): the stamp lands only
  // AFTER the prune's save succeeded, so a failed write retries next boot and
  // a re-deploy is a no-op. The prune itself is a patchStore read-fresh-write
  // under the cards mutex (BET-1464 defect 3) — an already-clean store is a
  // pure no-op (no save). `{pruned, marked}` for diagnostics/tests; a missing
  // engine-state writer (standalone/test usage) skips only the stamp.
  async function pruneLegacyOpenCards() {
    let meta = {};
    try {
      meta = (await engineState.load()) ?? {};
    } catch {
      meta = {};
    }
    if (meta?.[CONTENTLESS_CARD_PRUNE_KEY]?.pruned === true) {
      return { pruned: 0, marked: false };
    }
    let pruned = 0;
    await patchStore(cardStore, (fresh) => {
      const cards = Array.isArray(fresh?.cards) ? fresh.cards : [];
      const { keep, dropped } = splitContentlessOpenCards(cards);
      pruned = dropped.length;
      return dropped.length ? { cards: keep } : {};
    });
    let marked = false;
    if (typeof patchEngineStatePatch === "function") {
      try {
        await patchEngineStatePatch((fresh) => ({
          [CONTENTLESS_CARD_PRUNE_KEY]: {
            ...(fresh?.[CONTENTLESS_CARD_PRUNE_KEY] || {}),
            pruned: true,
            at: now(),
          },
        }));
        marked = true;
      } catch {
        /* best-effort — an unstamped marker just re-prunes a clean store next boot */
      }
    }
    return { pruned, marked };
  }

  // BET-1516: the orphaned `concurrentEphemeral` health card. BET-1513 made
  // the concurrency-limit trips shed (pause:false) — they stopped calling
  // recordBlocker, but an entry predating that change could still sit in
  // engine-state.json `pendingBlockers` and re-upsert its "Health check" card
  // on every tick, forever and unresolvable (closeOpenCard drops the WHOLE
  // rate_limit group, taking legit sessionCreationsPerHour entries with it —
  // which is why resolution-by-hand was never the fix). One-time, marker-
  // guarded prune with the same contract as pruneLegacyOpenCards: drop the
  // orphaned open cards, drop + stamp the shed pendingBlockers entries, write
  // one card.resolved ledger row per dropped card, stamp the marker only
  // after the writes succeeded. `{pruned, droppedEntries, marked}` for tests.
  async function pruneOrphanedShedCards({ ts = now() } = {}) {
    let meta = {};
    try {
      meta = (await engineState.load()) ?? {};
    } catch {
      meta = {};
    }
    if (meta?.[SHED_CARD_PRUNE_KEY]?.pruned === true) {
      return { pruned: 0, droppedEntries: 0, marked: false };
    }
    let pruned = 0;
    const droppedCards = [];
    await patchStore(cardStore, (fresh) => {
      const cards = Array.isArray(fresh?.cards) ? fresh.cards : [];
      const { keep, dropped } = splitOrphanedShedCards(cards);
      pruned = dropped.length;
      droppedCards.push(...dropped);
      return dropped.length ? { cards: keep } : {};
    });
    let droppedEntries = 0;
    if (typeof patchEngineStatePatch === "function") {
      try {
        await patchEngineStatePatch((fresh) => {
          const pending = Array.isArray(fresh?.pendingBlockers) ? fresh.pendingBlockers : [];
          const next = pending.filter(
            (b) =>
              !(
                b &&
                b.resolved !== true &&
                b.source === "rate_limit" &&
                SHED_RATE_LIMIT_REASONS.includes(b.reason)
              ),
          );
          droppedEntries = pending.length - next.length;
          return droppedEntries ? { pendingBlockers: next } : {};
        });
      } catch {
        /* best-effort — the card prune above already made the board clean */
      }
    }
    for (const card of droppedCards) {
      await ledgerAppend({
        kind: CARD_RESOLVED,
        cardId: card.id,
        variant: card.variant,
        sourceKind: card.sourceKind,
        refs: card.refs,
        reason: "orphaned shed card — concurrency trips stopped carding (BET-1513)",
        ts,
      });
    }
    let marked = false;
    if (typeof patchEngineStatePatch === "function") {
      try {
        await patchEngineStatePatch((fresh) => ({
          [SHED_CARD_PRUNE_KEY]: {
            ...(fresh?.[SHED_CARD_PRUNE_KEY] || {}),
            pruned: true,
            at: ts,
          },
        }));
        marked = true;
      } catch {
        /* best-effort — an unstamped marker just re-prunes a clean store next boot */
      }
    }
    return { pruned, droppedEntries, marked };
  }

  // BET-1516 (§10.3): the card-tick liveness pass for inbox-sourced blocker
  // cards. Three predicates — sender session gone, a named condition that
  // went gone, the inbox note's own TTL — auto-retract the card as `resolved`
  // (CARD_RESOLVED, never a verdict). POST /api/cto/verdict remains an
  // independent third path; a predicate resolution is additive. Skipped
  // entirely when no seam is wired (standalone/test usage): an unevaluatable
  // predicate is a no-op, never a false resolution.
  async function checkInboxLiveness({ nowMs = now() } = {}) {
    const { cards } = await openCards();
    const open = cards.filter(
      (c) => c?.state === "open" && c?.variant === "blocker" && c?.sourceKind === INBOX_SOURCE_KIND,
    );
    let changed = false;
    for (const card of open) {
      const gone = await inboxCardLivenessGone(card, { nowMs, hasSession, conditionGone });
      if (gone) {
        changed = (await resolveById(card.id, { reason: gone.reason, ts: nowMs })).changed || changed;
      }
    }
    return { changed };
  }

  // Source (2): read the watchdog's blocker-card requests that A2 already
  // writes to engine-state.json `pendingBlockers` and turn the unresolved ones
  // into health blocker cards. `{changed}` for tests/diagnostics.
  //
  // BET-1463: one health CARD per underlying CONDITION (`healthGroupKey`),
  // not one card per pendingBlockers ENTRY. This is the literal shape of the
  // 2026-08-31 incident — a watchdog that (before BET-1462) re-tripped every
  // tick wrote one new uniquely-id'd entry per trip, and keying the card by
  // that per-entry id turned 82 trips into 82 "identical" cards. Repeat
  // trips of the SAME condition upsert the one ongoing card in place
  // (pendingSince = the EARLIEST trip still outstanding, body = the most
  // recent reason) exactly like re-detecting the same worker ask never dups.
  async function ingestHealthEscalations({ ts = now() } = {}) {
    let payload;
    try {
      payload = await engineState.load();
    } catch {
      return { changed: false };
    }
    const pending = Array.isArray(payload?.pendingBlockers) ? payload.pendingBlockers : [];
    const unresolved = pending.filter((b) => b?.resolved !== true);
    let changed = false;
    const consumedIds = [];
    if (unresolved.length) {
      const groups = new Map();
      for (const b of unresolved) {
        const key = healthGroupKey(b);
        const bts = typeof b?.ts === "number" ? b.ts : ts;
        const group = groups.get(key) ?? { minTs: bts, latest: b, latestTs: bts, ids: [] };
        if (bts < group.minTs) group.minTs = bts;
        if (bts >= group.latestTs) {
          group.latest = b;
          group.latestTs = bts;
        }
        if (b?.id !== undefined) group.ids.push(b.id);
        groups.set(key, group);
      }
      for (const [key, group] of groups) {
        const r = await upsertBlocker({
          sourceKind: HEALTH_SOURCE_KIND,
          sourceId: key,
          sessionID: undefined,
          title: blockerTitle(HEALTH_SOURCE_KIND),
          body: blockerBody(HEALTH_SOURCE_KIND, group.latest?.reason),
          refs: [],
          ts,
          pendingSince: group.minTs,
        });
        changed = changed || r.changed;
        consumedIds.push(...group.ids);
      }
    }
    // BET-1463 (defect 1): every entry ingested above gets stamped `resolved:
    // true` here (once) so it is never reprocessed — this is what makes the
    // `resolved !== true` filter above live instead of dead code.
    await markPendingBlockersConsumed(consumedIds);
    return { changed };
  }

  // Health recovered (e.g. the user resumed the engine) → resolve every open
  // health card. `{changed}` for diagnostics/tests.
  async function onHealthRecovered({ ts = now() } = {}) {
    const { cards } = await openCards();
    const open = cards.filter((c) => c?.state === "open" && c?.sourceKind === HEALTH_SOURCE_KIND);
    let changed = false;
    for (const card of open) {
      changed = (await resolveById(card.id, { reason: "health recovered", ts })).changed || changed;
    }
    return { changed };
  }

  // Explicit user dismissal → same ledger discipline as resolution, but the
  // state is `dismissed` (a user choice, distinct from self-resolution).
  async function dismissById(id, { reason, ts = now() } = {}) {
    const r = await closeOpenCard(id, CARD_DISMISSED, reason, ts);
    if (!r.changed) return r;
    return { changed: true, card: { ...r.card, state: "dismissed", dismissedAt: ts, dismissedReason: reason } };
  }

  // Decision-card writer (BET-1392 / §9.1 decision cards, §10.3). Upserts by
  // the candidate's stable id (hash(findingId, class)) — a regeneration
  // updates the existing open card in place (title/why/options/evidence
  // refresh; created + carried-forward open-verdict count preserved), never
  // duplicates. Option `action` types use the closed ACTION_TYPES enum; RPC is
  // deliberately out of scope for the server — option execution is the
  // renderer's job (§9.1 "option buttons execute a bound action").
  async function upsertDecision({ id, title, why, options = [], refs = [], evidence = [], sourceKind, cls, score, capped = false, ts = now() } = {}) {
    if (!id || typeof id !== "string") return { ok: false, changed: false, isNew: false };
    return upsertOpenCard({
      id,
      variant: "decision",
      sourceKind,
      ts,
      ledger: { cls, score: typeof score === "number" ? score : undefined },
      build: ({ existing }) => ({
        title: typeof title === "string" && title ? title : "CTO suggestion",
        why: typeof why === "string" && why ? why : title ?? "",
        refs: Array.isArray(refs) ? refs : [],
        evidence: Array.isArray(evidence) && evidence.length ? evidence : Array.isArray(refs) ? refs : [],
        options: Array.isArray(options) ? options : [],
        cls,
        score: typeof score === "number" ? score : undefined,
        capped: capped === true,
        // openness count carried forward on regeneration (§9.1 never-dup).
        openCount: existing?.openCount ?? 0,
      }),
    });
  }

  // Shared card-writer core: ONE read-fresh-merge-save path for every
  // variant writer (decision/veto/connect), under the cards store's
  // patchStore mutex (BET-1464 defect 3 — a stale-derived writer can no
  // longer erase a concurrent writer's card). `build` returns the
  // variant-specific fields given { existing, created, ts }; the helper adds
  // the identity/lifecycle envelope, upserts by stable id (regeneration
  // updates in place, never dups), saves, and writes the CARD_CREATED row.
  // Returns `{ ok, changed, isNew }` per the BET-1477 contract: ok:true on
  // the byte-identical no-op too, ok:false only from the variant wrappers'
  // invalid-args guards.
  async function upsertOpenCard({ id, variant, sourceKind = null, sourceId = null, ts = now(), ledger = {}, build }) {
    let changed = false;
    let isNew = false;
    let cardRefs = [];
    await patchStore(cardStore, (fresh) => {
      const list = Array.isArray(fresh?.cards) ? fresh.cards : [];
      const existing = list.find((c) => c?.id === id && c?.state === "open");
      const created = existing?.created ?? ts;
      const card = {
        ...build({ existing, created, ts }),
        id,
        variant,
        sourceKind,
        sourceId,
        created,
        updatedAt: ts,
        state: "open",
      };
      cardRefs = card.refs;
      // BET-1463 (defect 2): same no-op rule as upsertBlocker — a byte-identical
      // regeneration (e.g. a decision card re-derived unchanged, or an unarmed
      // veto countdown) is an empty patch: no save, no ledger row. BET-1477:
      // the no-op still reports ok:true — the card is already on the board and
      // current, which is a successful outcome for a caller branching on "did
      // the card path work".
      if (existing && cardContentEqual(existing, card)) return {};
      changed = true;
      isNew = !existing;
      const nextList = existing
        ? list.map((c) => (c === existing ? { ...existing, ...card, created, updatedAt: ts } : c))
        : [...list, card];
      return { cards: nextList };
    });
    if (changed) {
      await ledgerAppend({
        kind: CARD_CREATED,
        cardId: id,
        variant,
        sourceKind,
        sourceId,
        refs: cardRefs,
        ...ledger,
      });
    }
    return { ok: true, changed, isNew };
  }

  // BET-1419 (§9.2/§10.3): the veto-window card — announce tonight's run 30
  // min ahead with a live countdown. One open veto card at a time (the
  // overnight countdown is unique per window): re-arming upserts by id so the
  // countdown updates in place, never dups. `dueMs` is the open the countdown
  // points at; the engine resolves the card when the window opens (fulfilled),
  // cancels it (veto verdict) or abandons it (missed, §11.6).
  async function upsertVeto({ id, title, body, dueMs, options = [], refs = [], ts = now() } = {}) {
    if (!id || typeof id !== "string") return { ok: false, changed: false, isNew: false };
    return upsertOpenCard({
      id,
      variant: "veto",
      sourceKind: "overnight",
      sourceId: null,
      ts,
      ledger: { dueMs: Number.isFinite(dueMs) ? dueMs : null },
      build: ({ existing }) => ({
        title: typeof title === "string" && title ? title : "Overnight run planned",
        body: typeof body === "string" && body ? body : "",
        dueMs: Number.isFinite(dueMs) ? dueMs : null,
        options: Array.isArray(options) ? options : [],
        sessionID: null,
        pendingSince: existing?.pendingSince ?? ts,
        refs: Array.isArray(refs) ? refs : [],
      }),
    });
  }

  // Connect-ask card writer (BET-1395 / §7.4 one connect ask, §10.3
  // connect-ask variant). Upserts by the tool's stable id — re-raising the
  // same tool's ask (re-arm path) updates the card in place, never dups.
  // The three-way answer is bound at generation time to the tool identity;
  // resolution runs through the registry (POST /api/cto/tools/connect),
  // which writes the consent ring + the §9.5 verdict and calls
  // resolveConnectCards. No notification path — like decision cards, this is
  // a resting needs-you surface.
  async function upsertConnect({ toolId, title, body, evidence = [], refs = [], ring = "metadata", ts = now() } = {}) {
    if (!toolId || typeof toolId !== "string") return { ok: false, changed: false, isNew: false };
    const deep = ring === "deep_read";
    const sourceId = deep ? `${toolId}:deep` : toolId;
    return upsertOpenCard({
      id: stableCardId(CONNECT_SOURCE_KIND, sourceId),
      variant: "connect",
      sourceKind: CONNECT_SOURCE_KIND,
      sourceId,
      ts,
      build: () => ({
        title: typeof title === "string" && title ? title : `Connect ${toolId} (read-only)?`,
        body: typeof body === "string" ? body : "",
        evidence: Array.isArray(evidence) ? evidence : [],
        options: [
          { label: "Connect read-only", answer: "connect" },
          { label: "Not now", answer: "not-now" },
          { label: "Never for this tool", answer: "never" },
        ].map((o) => ({
          ...o,
          action: { type: "tool-connect", payload: { tool: toolId, answer: o.answer, ring } },
        })),
        refs: Array.isArray(refs) && refs.length ? refs : [toolId],
        sessionID: null,
      }),
    });
  }

  // Resolve every open connect-ask card for one tool (the registry's
  // three-way answer is the resolution predicate's only false-path). Returns
  // `{changed}` for tests/diagnostics. Under the cards patchStore mutex
  // (BET-1464 defect 3) the matched set derives from the FRESH list, so a
  // concurrent card writer's card can never be reverted by this close.
  async function resolveConnectCards(toolId, reason, ts = now()) {
    const closed = [];
    await patchStore(cardStore, (fresh) => {
      const list = Array.isArray(fresh?.cards) ? fresh.cards : [];
      const open = list.filter(
        (c) => c?.state === "open" && c?.variant === "connect" && (c?.sourceId === toolId || c?.refs?.includes(toolId)),
      );
      if (open.length === 0) return {};
      closed.push(...open);
      const openSet = new Set(open);
      return { cards: list.filter((c) => !openSet.has(c)) };
    });
    for (const card of closed) {
      await ledgerAppend({
        kind: CARD_RESOLVED,
        cardId: card.id,
        variant: card.variant,
        sourceKind: card.sourceKind,
        sourceId: card.sourceId,
        refs: card.refs,
        reason,
      });
    }
    return { changed: closed.length > 0 };
  }

  async function listOpen() {
    const { cards } = await openCards();
    return cards.filter((c) => c && c.state === "open");
  }

  return {
    onAskStart,
    onAskResolved,
    onInboxBlocker,
    seedPendingAsks,
    pruneLegacyOpenCards,
    pruneOrphanedShedCards,
    promoteDue,
    ingestHealthEscalations,
    onHealthRecovered,
    checkInboxLiveness,
    upsertBlocker,
    resolveById,
    dismissById,
    upsertDecision,
    upsertVeto,
    upsertConnect,
    resolveConnectCards,
    listOpen,
  };
}
