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
