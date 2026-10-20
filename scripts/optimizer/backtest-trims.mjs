#!/usr/bin/env node
// backtest-trims.mjs — the REQUIRED pre-merge backtest of "sticky trims, priced per
// model" (spec docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md §9).
//
//   node scripts/optimizer/backtest-trims.mjs [--db <opencode.db>] [--prices <file>]
//        [--from 2026-10-17T09:00:00Z] [--to 2026-10-17T13:00:00Z] [--ttl-ms 300000]
//
// Reads opencode's SQLite store READ-ONLY (`message` + `part` tables, via
// node:sqlite — Node >= 22.5), replays each session that had a request in the
// window from its start (warm-up), and prints, per session and in total, the cost
// at LIST prices of: no trimming / recorded (the ledger's actual cache tokens) /
// sticky trimming (simulated by the real planner). Exit 0 on PASS, 1 on FAIL,
// 2 when unsupported / unusable input. It never writes to the DB or to ~/.manta.
//
// DB: $OPENCODE_DB, else ~/.local/share/opencode/opencode.db.
// Prices, first that exists: --prices <file>, Manta's price cache
// (statePath("model-prices.json"), written by the server's catalog refresh), else
// opencode's own models.dev copy (~/.cache/opencode/models.json). All three are
// provider-keyed cost tables; lookup is exact on (providerID, modelID).
//
// Pass criteria: simulated total < no-trimming total, and no session grows more
// than 3 times inside the window.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "../../src/shared/optimizerPolicy.mjs";
import { statePath } from "../../src/shared/paths.mjs";
import {
  DEFAULT_WINDOW,
  buildHistory,
  formatReport,
  hasMissingParts,
  parseTime,
  priceLookup,
  simulateSession,
  summarize,
} from "./backtest-lib.mjs";

function parseArgs(argv) {
  const a = { db: process.env.OPENCODE_DB || join(homedir(), ".local", "share", "opencode", "opencode.db"), prices: null, from: DEFAULT_WINDOW.from, to: DEFAULT_WINDOW.to, ttlMs: 300_000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === "--db") a.db = v();
    else if (k === "--prices") a.prices = v();
    else if (k === "--from") a.from = parseTime(v());
    else if (k === "--to") a.to = parseTime(v());
    else if (k === "--ttl-ms") a.ttlMs = Number(v());
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

function loadPriceTable(explicit) {
  const candidates = [
    explicit && { path: explicit, kind: "file" },
    { path: statePath("model-prices.json"), kind: "manta" },
    { path: join(homedir(), ".cache", "opencode", "models.json"), kind: "opencode" },
  ].filter(Boolean);
  for (const c of candidates) {
    if (!existsSync(c.path)) {
      if (c.kind === "file") throw new Error(`--prices file not found: ${c.path}`);
      continue;
    }
    const raw = JSON.parse(readFileSync(c.path, "utf8"));
    // Manta's cache wraps the table: {version, fetchedAt, providers}
    const table = raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object" ? raw.providers : raw;
    return { table, source: c.path };
  }
  throw new Error("no price table found (pass --prices <file>)");
}

async function openDb(path) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    console.error("unsupported: node:sqlite is not available (needs Node >= 22.5)");
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`opencode database not found: ${path}`);
    process.exit(2);
  }
  return new DatabaseSync(path, { readOnly: true });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
  if (args.help) {
    console.log("usage: backtest-trims.mjs [--db file] [--prices file] [--from ISO] [--to ISO] [--ttl-ms N]");
    return;
  }
  const db = await openDb(args.db);
  let prices;
  try {
    prices = loadPriceTable(args.prices);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
  console.error(`db: ${args.db}\nprices: ${prices.source}`);
  const lookupPrice = priceLookup(prices.table);
  const policy = { ...DEFAULT_POLICY, enabled: true };

  // Bounded to the window's sessions: ids first, then each session's own rows.
  const sessionIds = db
    .prepare("SELECT DISTINCT session_id FROM message WHERE time_created >= ? AND time_created < ?")
    .all(args.from, args.to)
    .map((r) => r.session_id);
  const msgStmt = db.prepare("SELECT id, session_id, time_created, data FROM message WHERE session_id = ? AND time_created < ?");
  const idStmt = db.prepare("SELECT id FROM message WHERE session_id = ?");
  const partStmt = db.prepare("SELECT id, message_id, data FROM part WHERE session_id = ?");

  const results = [];
  let skipped = 0;
  for (const sid of sessionIds) {
    const msgRows = msgStmt.all(sid, args.to);
    const known = new Set(idStmt.all(sid).map((r) => r.id)); // incl. messages after the window
    const loaded = new Set(msgRows.map((r) => r.id));
    // parts of messages created after the window are simply out of scope, not "missing"
    const partRows = partStmt.all(sid).filter((p) => loaded.has(p.message_id) || !known.has(p.message_id));
    const history = buildHistory(msgRows, partRows);
    const inWindow = history.messages.some((m) => m.info.role === "assistant" && m.info.time?.created >= args.from && m.info.time?.created < args.to);
    if (!inWindow) continue; // user-only rows in the window
    if (hasMissingParts(history)) {
      skipped++;
      continue;
    }
    const r = simulateSession({ history, lookupPrice, policy, window: { from: args.from, to: args.to }, ttlMs: args.ttlMs });
    results.push({ id: sid, ...r });
  }
  results.sort((a, b) => b.none.usd - a.none.usd);
  const summary = summarize(results);
  console.log(formatReport({ sessions: results, summary, window: { from: args.from, to: args.to }, skipped, ttlMs: args.ttlMs }));
  process.exit(summary.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(2);
});
