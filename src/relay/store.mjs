// store.mjs — SQLite persistence for the relay (M2, BET-36 Stage 2).
//
// The relay is the operated backend that maps phones to boxes. It needs a
// durable record of three things:
//
//   1. boxes    — every box that has ever dialed in: its opaque box_id, when we
//                 first saw it, when we last saw it, and whether its tunnel is
//                 currently up. This is the source of truth for "is box X known"
//                 and "when was box X last online", independent of the in-memory
//                 RoutingTable (which only holds LIVE sockets and is lost on a
//                 relay restart).
//   2. bindings — which account owns which box. One account ↔ many boxes (a user
//                 can pair several boxes to one subscription); a box belongs to
//                 exactly one account at a time. This is what the phone-facing
//                 leg (Stage 4) consults to answer "may this account reach this
//                 box" and what IAP receipt validation (Stage 5) writes.
//   3. receipts — Apple IAP receipts, keyed by original_transaction_id, bound to
//                 a box_id. THIS SLICE ONLY provides the table + typed accessors;
//                 the actual receipt VALIDATION (calling Apple, deciding
//                 entitlement) is Stage 5. We store the raw receipt + parsed
//                 fields so Stage 5 has somewhere to put them.
//
// DATASTORE CHOICE — node-sqlite3-wasm (pure WASM, no native binding).
//   This slice went through the full elimination on the CI runner:
//     1. built-in `node:sqlite` (`DatabaseSync`) — only exists on Node 22.5+.
//        CI pins Node 20 (`.github/workflows/ci.yml`, `node-version: 20`), where
//        it throws ERR_UNKNOWN_BUILTIN_MODULE. Rejected.
//     2. `better-sqlite3` — a native addon. It typechecks and `npm ci` succeeds,
//        but the compiled `better_sqlite3.node` fails to `dlopen` on the
//        self-hosted runner (ERR_DLOPEN_FAILED / "Module did not self-register":
//        the prebuilt binary's ABI doesn't match the runner's Node, and there is
//        no reliable node-gyp toolchain there). Rejected — a native binding on
//        this runner is not dependable without a guaranteed compile step, which
//        is out of scope for this slice (`.github/**` is human-tier).
//     3. `node-sqlite3-wasm` — SQLite compiled to WebAssembly, shipped as a
//        pre-built .wasm inside the package. NO `.node` addon, NO compile step,
//        so it loads on whatever Node the runner has (20 or 22) with a plain
//        `npm ci`. Synchronous API (Database / prepare / run / get / all), same
//        shape this store already used. THIS is what we ship.
//
//   node-sqlite3-wasm ships as CommonJS and — unlike better-sqlite3 / node:sqlite
//   — its prepared-statement methods bind parameters as a SINGLE ARRAY rather
//   than variadically. Both of those quirks are hidden inside the `openDatabase`
//   seam below, which returns a thin adapter exposing the exact better-sqlite3
//   surface the rest of this file is written against (`.exec`,
//   `.prepare(...).run/get/all(...variadic)`, `.close`, and EXPLAIN QUERY PLAN
//   rows exposing `.detail`). Every query above the seam is unchanged. If a
//   future runtime standardizes on `node:sqlite`, swap that single function back
//   to `new DatabaseSync(path)`.
//
// TESTABILITY: `openStore({ path })` accepts ":memory:" (default) for an
// in-memory DB that leaves no fs artifacts, or a file path for a persistent
// store. Migrations are idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so
// opening an existing DB is a no-op re-apply, never a destructive one.

import { createHash, timingSafeEqual } from "node:crypto";
import sqliteWasm from "node-sqlite3-wasm";
import { isValidToken } from "../server/webhooks.mjs";

const { Database } = sqliteWasm;

// ---------------------------------------------------------------------------
// Box status enum (mirrors the box lifecycle the RoutingTable drives)
// ---------------------------------------------------------------------------

export const BOX_STATUS = Object.freeze({
  ONLINE: "online", // tunnel socket currently registered
  OFFLINE: "offline", // seen before, tunnel currently down
});

const KNOWN_BOX_STATUS = new Set(Object.values(BOX_STATUS));

// ---------------------------------------------------------------------------
// Schema — applied idempotently on open
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boxes (
  box_id      TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'offline',
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bindings (
  box_id      TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (box_id) REFERENCES boxes(box_id) ON DELETE CASCADE
);
-- One account owns many boxes: look up "all boxes for account X" fast.
CREATE INDEX IF NOT EXISTS idx_bindings_account ON bindings(account_id);

CREATE TABLE IF NOT EXISTS receipts (
  original_transaction_id TEXT PRIMARY KEY,
  box_id                  TEXT NOT NULL,
  product_id              TEXT,
  expires_at              INTEGER,
  raw                     TEXT,
  created_at              INTEGER NOT NULL,
  FOREIGN KEY (box_id) REFERENCES boxes(box_id) ON DELETE CASCADE
);
-- "all receipts for box X" (entitlement check in Stage 5) + "expiring soon".
CREATE INDEX IF NOT EXISTS idx_receipts_box ON receipts(box_id);
CREATE INDEX IF NOT EXISTS idx_receipts_expires ON receipts(expires_at);

-- Stage 5: native push device tokens, keyed by account_id. A phone registers
-- its platform token (APNs on iOS, FCM on Android) so the relay's native push
-- leg (push.mjs) can deliver to it. One account has one current token per
-- platform; re-registering the same platform overwrites (a rotated APNs token).
-- account_id is NOT bound to boxes(box_id), so no FK — an account may register
-- a device token before it has bound any box.
CREATE TABLE IF NOT EXISTS push_tokens (
  account_id  TEXT NOT NULL,
  platform    TEXT NOT NULL,          -- 'apns' | 'fcm'
  token       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, platform)
);
-- "all device tokens for account X" (the push fan-out read path).
CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id);

-- Stage 5: per-box byte metering. One row per box accumulates the total bytes
-- carried in each direction on the proxy path (ingress = phone→box request
-- bytes, egress = box→phone response bytes). This is the COGS signal the relay
-- meters per box_id. A single running-total row per box (not per-request rows)
-- keeps writes O(1) and the "how much has box X used" read a single lookup.
CREATE TABLE IF NOT EXISTS metering (
  box_id       TEXT PRIMARY KEY,
  ingress      INTEGER NOT NULL DEFAULT 0,
  egress       INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (box_id) REFERENCES boxes(box_id) ON DELETE CASCADE
);

-- Box handshake credentials (BET-152 / ADR-4): trust-on-first-use. The relay
-- accepts a box's first dial-out by storing sha256(box_token); subsequent
-- dial-outs must match. box_id is 32-hex random = unguessable, so TOFU
-- squatting requires the id, which only the box owner has. INSERT only — a
-- re-register is rejected by the store layer, so a second box claiming an
-- existing box_id cannot silently rotate the credential.
CREATE TABLE IF NOT EXISTS box_credentials (
  box_id     TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Phone account tokens (BET-152 / ADR-5): each successful POST /pair mints a
-- fresh 32-hex token (the device token), stored here as a sha256 hash. One
-- account owns many tokens (devices); multiple tokens map to the same
-- account_id. The relay never sees plaintext tokens at rest — only the
-- compare path uses hashEquals (constant-time) on lookup.
CREATE TABLE IF NOT EXISTS account_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- "all tokens for account X" (logout-everywhere / revoke sweep).
CREATE INDEX IF NOT EXISTS idx_account_tokens_account ON account_tokens(account_id);
`;

// ---------------------------------------------------------------------------
// Low-level DB open (the one driver-specific seam)
// ---------------------------------------------------------------------------

function openDatabase(path) {
  // ":memory:" is node-sqlite3-wasm's in-memory database sentinel (same as
  // better-sqlite3 / node:sqlite), leaving no fs artifacts.
  const raw = new Database(path);
  // Enforce the FKs we declared (SQLite defaults them OFF per-connection).
  raw.exec("PRAGMA foreign_keys = ON;");

  // Adapter: reconcile two node-sqlite3-wasm quirks so nothing above the seam
  // knows which driver is underneath.
  //   1. BINDING SHAPE: it binds prepared-statement params as a single array;
  //      the rest of this file calls .run/.get/.all variadically (the
  //      better-sqlite3 convention). `undefined` params (no args) → no binding.
  //   2. STATEMENT FINALIZATION: unlike better-sqlite3 (which auto-finalizes on
  //      db.close), node-sqlite3-wasm holds the file lock until every prepared
  //      statement is finalized — reopening the same file otherwise throws
  //      "database is locked". So we track live statements and finalize them all
  //      in close(). Ad-hoc statements (.explain / the _db escape hatch) are
  //      finalized eagerly after their single use so they don't accumulate.
  const toBinding = (params) => (params.length ? params : undefined);
  const live = new Set();
  const wrap = (stmt) => ({
    run: (...params) => stmt.run(toBinding(params)),
    get: (...params) => stmt.get(toBinding(params)),
    all: (...params) => stmt.all(toBinding(params)),
    finalize: () => {
      live.delete(stmt);
      try {
        stmt.finalize();
      } catch {
        /* already finalized */
      }
    },
  });
  return {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const stmt = raw.prepare(sql);
      live.add(stmt);
      return wrap(stmt);
    },
    close() {
      for (const stmt of live) {
        try {
          stmt.finalize();
        } catch {
          /* already finalized */
        }
      }
      live.clear();
      raw.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Store — typed accessors over the three tables
// ---------------------------------------------------------------------------

/**
 * Open (and migrate) a relay store.
 *
 * @param {object} [opts]
 * @param {string} [opts.path=":memory:"]  DB path; ":memory:" for tests.
 * @param {() => number} [opts.now=Date.now]  Injectable clock (ms since epoch).
 * @returns a store handle with the accessors below.
 */
export function openStore({ path = ":memory:", now = () => Date.now() } = {}) {
  const db = openDatabase(path);
  // Idempotent migration. Safe to re-run on an existing DB.
  db.exec(SCHEMA);

  // Prepared statements (compiled once, reused). The openDatabase adapter above
  // gives every driver the same variadic prepare().run/get/all shape.
  const stmts = {
    upsertBox: db.prepare(`
      INSERT INTO boxes (box_id, status, created_at, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(box_id) DO UPDATE SET
        status = excluded.status,
        last_seen = excluded.last_seen
    `),
    getBox: db.prepare(`SELECT * FROM boxes WHERE box_id = ?`),
    setBoxStatus: db.prepare(`
      UPDATE boxes SET status = ?, last_seen = ? WHERE box_id = ?
    `),
    listBoxes: db.prepare(`SELECT * FROM boxes ORDER BY last_seen DESC`),

    upsertBinding: db.prepare(`
      INSERT INTO bindings (box_id, account_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(box_id) DO UPDATE SET
        account_id = excluded.account_id
    `),
    getBinding: db.prepare(`SELECT * FROM bindings WHERE box_id = ?`),
    listBoxesForAccount: db.prepare(`
      SELECT b.*
      FROM boxes b
      JOIN bindings bn ON bn.box_id = b.box_id
      WHERE bn.account_id = ?
      ORDER BY b.last_seen DESC
    `),
    deleteBinding: db.prepare(`DELETE FROM bindings WHERE box_id = ?`),

    upsertReceipt: db.prepare(`
      INSERT INTO receipts
        (original_transaction_id, box_id, product_id, expires_at, raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(original_transaction_id) DO UPDATE SET
        box_id = excluded.box_id,
        product_id = excluded.product_id,
        expires_at = excluded.expires_at,
        raw = excluded.raw
    `),
    getReceipt: db.prepare(
      `SELECT * FROM receipts WHERE original_transaction_id = ?`,
    ),
    listReceiptsForBox: db.prepare(`
      SELECT * FROM receipts WHERE box_id = ? ORDER BY created_at DESC
    `),

    upsertPushToken: db.prepare(`
      INSERT INTO push_tokens (account_id, platform, token, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, platform) DO UPDATE SET
        token = excluded.token,
        updated_at = excluded.updated_at
    `),
    listPushTokensForAccount: db.prepare(`
      SELECT * FROM push_tokens WHERE account_id = ?
    `),
    deletePushToken: db.prepare(`
      DELETE FROM push_tokens WHERE account_id = ? AND platform = ?
    `),

    upsertMetering: db.prepare(`
      INSERT INTO metering (box_id, ingress, egress, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(box_id) DO UPDATE SET
        ingress = metering.ingress + excluded.ingress,
        egress = metering.egress + excluded.egress,
        updated_at = excluded.updated_at
    `),
    getMetering: db.prepare(`SELECT * FROM metering WHERE box_id = ?`),
    listMetering: db.prepare(`SELECT * FROM metering ORDER BY updated_at DESC`),
    resetMetering: db.prepare(`
      UPDATE metering SET ingress = 0, egress = 0, updated_at = ? WHERE box_id = ?
    `),

    // Box handshake credentials (BET-152 / ADR-4 TOFU). INSERT only — a second
    // setBoxCredential() for the same box_id must throw (TOFU never overwrites
    // an existing credential).
    insertBoxCredential: db.prepare(`
      INSERT INTO box_credentials (box_id, token_hash, created_at)
      VALUES (?, ?, ?)
    `),
    getBoxCredential: db.prepare(`SELECT * FROM box_credentials WHERE box_id = ?`),

    // Phone account tokens (BET-152 / ADR-5). token_hash is the sha256 of the
    // device token (32-hex plaintext) handed to the phone at /pair time; the
    // relay only ever stores/looks up the hash.
    insertAccountToken: db.prepare(`
      INSERT INTO account_tokens (token_hash, account_id, created_at)
      VALUES (?, ?, ?)
    `),
    getAccountTokenByHash: db.prepare(`
      SELECT * FROM account_tokens WHERE token_hash = ?
    `),
    listAccountTokensForAccount: db.prepare(`
      SELECT * FROM account_tokens WHERE account_id = ?
    `),
  };

  // -------------------------------------------------------------------------
  // boxes
  // -------------------------------------------------------------------------

  /**
   * Record that a box exists / is currently online. First sight sets
   * created_at == last_seen; subsequent calls only bump status + last_seen
   * (created_at is preserved by the ON CONFLICT clause). Returns the row.
   */
  function upsertBox(boxId, { status = BOX_STATUS.ONLINE, at = now() } = {}) {
    assertBoxId(boxId);
    assertStatus(status);
    stmts.upsertBox.run(boxId, status, at, at);
    return getBox(boxId);
  }

  function getBox(boxId) {
    assertBoxId(boxId);
    return stmts.getBox.get(boxId) ?? null;
  }

  /** Flip a known box's status (e.g. → offline on socket close) + bump last_seen. */
  function setBoxStatus(boxId, status, { at = now() } = {}) {
    assertBoxId(boxId);
    assertStatus(status);
    const res = stmts.setBoxStatus.run(status, at, boxId);
    return res.changes > 0;
  }

  function listBoxes() {
    return stmts.listBoxes.all();
  }

  // -------------------------------------------------------------------------
  // bindings (account ↔ box)
  // -------------------------------------------------------------------------

  /**
   * Bind a box to an account. One account owns many boxes; a box belongs to one
   * account (re-binding moves it). The box row must exist first (FK) — callers
   * upsertBox() on dial-in, so by bind time it does. Returns the binding row.
   */
  function bindBox(boxId, accountId, { at = now() } = {}) {
    assertBoxId(boxId);
    assertAccountId(accountId);
    stmts.upsertBinding.run(boxId, accountId, at);
    return getBinding(boxId);
  }

  function getBinding(boxId) {
    assertBoxId(boxId);
    return stmts.getBinding.get(boxId) ?? null;
  }

  /** All box rows owned by an account (many-boxes-per-account read path). */
  function listBoxesForAccount(accountId) {
    assertAccountId(accountId);
    return stmts.listBoxesForAccount.all(accountId);
  }

  function unbindBox(boxId) {
    assertBoxId(boxId);
    const res = stmts.deleteBinding.run(boxId);
    return res.changes > 0;
  }

  // -------------------------------------------------------------------------
  // receipts (table + accessors ONLY — validation is Stage 5)
  // -------------------------------------------------------------------------

  /**
   * Upsert an IAP receipt keyed by original_transaction_id, bound to a box.
   * `raw` is stored verbatim (the Apple payload) for Stage-5 validation; the
   * parsed fields (product_id, expires_at) are convenience columns/indexes.
   */
  function upsertReceipt(
    { originalTransactionId, boxId, productId = null, expiresAt = null, raw = null },
    { at = now() } = {},
  ) {
    if (typeof originalTransactionId !== "string" || !originalTransactionId) {
      throw new Error("upsertReceipt: originalTransactionId required");
    }
    assertBoxId(boxId);
    const rawStr =
      raw == null
        ? null
        : typeof raw === "string"
          ? raw
          : JSON.stringify(raw);
    stmts.upsertReceipt.run(
      originalTransactionId,
      boxId,
      productId,
      expiresAt,
      rawStr,
      at,
    );
    return getReceipt(originalTransactionId);
  }

  function getReceipt(originalTransactionId) {
    return stmts.getReceipt.get(originalTransactionId) ?? null;
  }

  function listReceiptsForBox(boxId) {
    assertBoxId(boxId);
    return stmts.listReceiptsForBox.all(boxId);
  }

  // -------------------------------------------------------------------------
  // push_tokens (native device tokens, keyed by account_id)
  // -------------------------------------------------------------------------

  /**
   * Register (or replace) a native device token for an account. One current
   * token per (account, platform); re-registering the same platform overwrites
   * (e.g. an APNs token rotation). Returns the stored row.
   *
   * @param {object} args
   * @param {string} args.accountId
   * @param {"apns"|"fcm"} args.platform
   * @param {string} args.token  the platform device token (opaque, not a 32-hex).
   */
  function registerPushToken({ accountId, platform, token }, { at = now() } = {}) {
    assertAccountId(accountId);
    assertPlatform(platform);
    if (typeof token !== "string" || !token) {
      throw new Error("registerPushToken: token required (non-empty string)");
    }
    stmts.upsertPushToken.run(accountId, platform, token, at);
    return stmts.listPushTokensForAccount
      .all(accountId)
      .find((r) => r.platform === platform) ?? null;
  }

  /** All device-token rows registered for an account (the push fan-out read). */
  function listPushTokensForAccount(accountId) {
    assertAccountId(accountId);
    return stmts.listPushTokensForAccount.all(accountId);
  }

  /** Remove one platform's device token for an account (token went dead). */
  function unregisterPushToken(accountId, platform) {
    assertAccountId(accountId);
    assertPlatform(platform);
    const res = stmts.deletePushToken.run(accountId, platform);
    return res.changes > 0;
  }

  // -------------------------------------------------------------------------
  // metering (per-box byte counters)
  // -------------------------------------------------------------------------

  /**
   * Add ingress/egress byte counts to a box's running total (creating the row
   * on first sight). Both default to 0 so a caller can bump one direction only.
   * The box row must exist first (FK) — the proxy path upserts the box on
   * dial-in, so by metering time it does. Returns the updated row.
   */
  function addUsage(boxId, { ingress = 0, egress = 0 } = {}, { at = now() } = {}) {
    assertBoxId(boxId);
    assertByteCount(ingress, "ingress");
    assertByteCount(egress, "egress");
    stmts.upsertMetering.run(boxId, ingress, egress, at);
    return getUsage(boxId);
  }

  function getUsage(boxId) {
    assertBoxId(boxId);
    return stmts.getMetering.get(boxId) ?? null;
  }

  function listUsage() {
    return stmts.listMetering.all();
  }

  /** Zero a box's counters (e.g. at a billing-period boundary). */
  function resetUsage(boxId, { at = now() } = {}) {
    assertBoxId(boxId);
    const res = stmts.resetMetering.run(at, boxId);
    return res.changes > 0;
  }

  // -------------------------------------------------------------------------
  // box_credentials (BET-152 / ADR-4 TOFU)
  // -------------------------------------------------------------------------

  /**
   * Record the sha256 of a box's box_token on its first dial-out. INSERT only:
   * a second call for the same box_id throws (TOFU never overwrites). The
   * caller (createDefaultVerifier) shape-gates the token first; this layer's
   * guarantee is "if you call it twice, you get an error" so a relay bug can't
   * silently rotate a credential.
   *
   * Returns the inserted row.
   */
  function setBoxCredential(boxId, tokenHash, { at = now() } = {}) {
    assertBoxId(boxId);
    if (typeof tokenHash !== "string" || !tokenHash) {
      throw new Error("setBoxCredential: token_hash required (non-empty string)");
    }
    // INSERT only — let the UNIQUE constraint turn a second-insert collision
    // into a programmatic error the verifier can surface as a hard reject.
    stmts.insertBoxCredential.run(boxId, tokenHash, at);
    return getBoxCredential(boxId);
  }

  function getBoxCredential(boxId) {
    assertBoxId(boxId);
    return stmts.getBoxCredential.get(boxId) ?? null;
  }

  // -------------------------------------------------------------------------
  // account_tokens (BET-152 / ADR-5)
  // -------------------------------------------------------------------------

  /**
   * Mint a device token for an account. `tokenHash` is sha256(account_token)
   * — the plaintext is handed back to the phone at /pair time and is never
   * stored. Returns the stored row.
   */
  function addAccountToken(tokenHash, accountId, { at = now() } = {}) {
    if (typeof tokenHash !== "string" || !tokenHash) {
      throw new Error("addAccountToken: token_hash required (non-empty string)");
    }
    assertAccountId(accountId);
    stmts.insertAccountToken.run(tokenHash, accountId, at);
    return stmts.getAccountTokenByHash.get(tokenHash) ?? null;
  }

  /** Look up an account_id by the sha256 of a presented device token. */
  function getAccountByTokenHash(tokenHash) {
    if (typeof tokenHash !== "string" || !tokenHash) return null;
    const row = stmts.getAccountTokenByHash.get(tokenHash);
    return row ? row.account_id : null;
  }

  /** All stored token hashes for an account (logout-everywhere / revoke sweep). */
  function listAccountTokensForAccount(accountId) {
    assertAccountId(accountId);
    return stmts.listAccountTokensForAccount.all(accountId);
  }

  // -------------------------------------------------------------------------
  // lifecycle / introspection
  // -------------------------------------------------------------------------

  function close() {
    db.close();
  }

  /**
   * Report whether a query uses an index (smoke test for the indexed reads).
   * Returns the EXPLAIN QUERY PLAN detail strings so a test can assert
   * "SEARCH ... USING INDEX" rather than a full "SCAN".
   */
  function explain(sql, ...params) {
    // Ad-hoc statement: finalize eagerly so it doesn't linger until close().
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    try {
      return stmt.all(...params).map((r) => r.detail);
    } finally {
      stmt.finalize();
    }
  }

  return {
    // boxes
    upsertBox,
    getBox,
    setBoxStatus,
    listBoxes,
    // bindings
    bindBox,
    getBinding,
    listBoxesForAccount,
    unbindBox,
    // receipts
    upsertReceipt,
    getReceipt,
    listReceiptsForBox,
    // push tokens
    registerPushToken,
    listPushTokensForAccount,
    unregisterPushToken,
    // metering
    addUsage,
    getUsage,
    listUsage,
    resetUsage,
    // box_credentials (BET-152 / ADR-4)
    setBoxCredential,
    getBoxCredential,
    // account_tokens (BET-152 / ADR-5)
    addAccountToken,
    getAccountByTokenHash,
    listAccountTokensForAccount,
    // lifecycle
    close,
    explain,
    // escape hatch for advanced/one-off queries + Stage-4/5 extension
    _db: db,
  };
}

// ---------------------------------------------------------------------------
// Validators — keep bad shapes out of the DB (defense in depth)
// ---------------------------------------------------------------------------

function assertBoxId(boxId) {
  if (!isValidToken(boxId)) {
    throw new Error("store: invalid box_id (want 32 lowercase hex chars)");
  }
}

function assertAccountId(accountId) {
  // account_id is an opaque relay-side identifier (from IAP binding in Stage 5).
  // We don't fix its exact shape here — just reject empty/non-string so a NULL
  // can't slip into the NOT NULL column and to keep the index keys sane.
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("store: invalid account_id (want non-empty string)");
  }
}

function assertStatus(status) {
  if (!KNOWN_BOX_STATUS.has(status)) {
    throw new Error(`store: invalid box status ${JSON.stringify(status)}`);
  }
}

const KNOWN_PLATFORMS = new Set(["apns", "fcm"]);

function assertPlatform(platform) {
  if (!KNOWN_PLATFORMS.has(platform)) {
    throw new Error(
      `store: invalid push platform ${JSON.stringify(platform)} (want 'apns' | 'fcm')`,
    );
  }
}

function assertByteCount(n, field) {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`store: invalid ${field} byte count (want non-negative integer)`);
  }
}

// ---------------------------------------------------------------------------
// Token hashing (BET-152 / ADR-1, ADR-4, ADR-5)
//
// The relay never stores or compares plaintext device tokens / box_tokens at
// rest: every row carries a sha256 hex digest, and the compare path uses
// constant-time Buffer equality so a network attacker cannot binary-search a
// secret byte-by-byte from response latency. `hashToken` + `hashEquals` are
// exported (rather than inlined at call sites) so every caller uses the same
// primitives and the timing-safe compare cannot accidentally degrade into a
// short-circuit `===` somewhere.
// ---------------------------------------------------------------------------

/** sha256(token) as lowercase hex. Token coerced to string first. */
export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/**
 * Constant-time equality of two lowercase hex digests. Returns false on any
 * shape mismatch (length, non-hex) — the compare only runs when both inputs
 * are equal-length Buffers, the precondition timingSafeEqual demands.
 */
export function hashEquals(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string") return false;
  if (aHex.length !== bHex.length) return false;
  let a;
  let b;
  try {
    a = Buffer.from(aHex, "hex");
    b = Buffer.from(bHex, "hex");
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
