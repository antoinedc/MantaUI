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
// DATASTORE CHOICE — node:sqlite (built in).
//   The runner is Node 22 (see `node --version` == v22.x), whose `node:sqlite`
//   ships `DatabaseSync`. We prefer it over a `better-sqlite3` native dependency
//   because it needs no compile step, no postinstall rebuild, and no addition to
//   package.json — a smaller surface for an OSS relay that self-hosters build.
//   `node:sqlite` is still flagged experimental (it prints an Experimental
//   warning), which is acceptable for the relay process (not the desktop app).
//   If a future runtime lacks `node:sqlite`, swap the `openDatabase` helper below
//   to `better-sqlite3` — every query in this file uses the tiny shared subset
//   (`.exec`, `.prepare(...).run/get/all`) both libraries implement, so the
//   swap is localized to one function.
//
// TESTABILITY: `openStore({ path })` accepts ":memory:" (default) for an
// in-memory DB that leaves no fs artifacts, or a file path for a persistent
// store. Migrations are idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so
// opening an existing DB is a no-op re-apply, never a destructive one.

import { DatabaseSync } from "node:sqlite";
import { isValidToken } from "../server/webhooks.mjs";

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
`;

// ---------------------------------------------------------------------------
// Low-level DB open (the one node:sqlite-specific seam)
// ---------------------------------------------------------------------------

function openDatabase(path) {
  // ":memory:" is node:sqlite's in-memory database sentinel.
  const db = new DatabaseSync(path);
  // Enforce the FKs we declared (SQLite defaults them OFF per-connection).
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
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

  // Prepared statements (compiled once, reused). node:sqlite + better-sqlite3
  // share the prepare().run/get/all shape.
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
    return db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((r) => r.detail);
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
    throw new Error("store: invalid box_id (want 32 hex chars)");
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
