// ctoStores.mjs — the durable storage layer for the Adaptive CTO (BET-1375).
//
// Everything nests under `~/.manta/cto/` and resolves through `statePath()`,
// so the test-sandbox rule (AGENTS.md / paths.mjs) covers every store — a
// forgotten injection writes into the throwaway MANTA_STATE_HOME, never the
// live box. Spec: docs/adaptive-cto-spec.md §13.1 (stores), §13.2 (schema
// versioning), §6.3 (archive cap), §3.2 (journal store lives in this layer).
//
// One accessor per store, all sharing three conventions:
//   - JSON stores write atomically via the shared jsonStore pattern (temp
//     file + rename), mode 0600.
//   - Every JSON payload carries `v` (current = CURRENT_VERSION); loads run
//     the store's payload through migrateStore() (§13.2). A payload with a
//     `v` NEWER than the supported version throws loudly naming the store —
//     never silently truncates. A payload with no `v` is treated as v1.
//   - Retention is a set of PURE functions (tested boundary-exact) wired to
//     I/O by `createCtoStoreSweep` / `startCtoStoreSweeper`, which copy the
//     inFlight-guard + timer.unref() shape from servePage.mjs.
//
// DELIBERATELY NOT in scope: engine timers, any consumer of these stores,
// probe YAML validation, any UI, and wiring into index.mjs. Leaf payload
// shapes (what lives inside inbox/facts/cards/...) are refined by the engine
// issues that consume them; this layer only fixes the durability contract.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir, rm, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { startPoller } from "./startPoller.mjs";

const MODE = 0o600;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Path root — every store hangs off `~/.manta/cto/` via statePath().
// ---------------------------------------------------------------------------

export function ctoPath(...parts) {
  return statePath("cto", ...parts);
}

// ---------------------------------------------------------------------------
// Schema versioning (§13.2)
// ---------------------------------------------------------------------------

export const CURRENT_VERSION = 1;

// Forward-migration table: `{ [fromVersion]: (payload) => payload }`. Migrates
// a payload one version at a time from its stored `v` up to CURRENT_VERSION.
// Empty today (v1 is the first schema); later schema bumps register a step
// here plus a unit test. The harness is what this issue ships.
export const MIGRATIONS = Object.freeze({});

/**
 * Validate + forward-migrate a store payload. Returns the (possibly migrated)
 * payload. Throws naming the store (per §13.2) when:
 *   - `v` is newer than CURRENT_VERSION (never silently truncate), or
 *   - `v` is present but not a positive integer, or
 *   - a migration step is missing for a stored version.
 * A payload with no `v` is treated as v1.
 */
export function migrateStore(name, data) {
  if (data === null || data === undefined) return data;
  const rawV = data && typeof data === "object" && "v" in data ? data.v : 1;
  if (typeof rawV !== "number" || !Number.isInteger(rawV) || rawV < 1) {
    throw new Error(
      `store "${name}" has invalid schema version ${JSON.stringify(data.v)} (expected a positive integer)`,
    );
  }
  if (rawV > CURRENT_VERSION) {
    throw new Error(
      `store "${name}" has schema version ${rawV}, which is newer than the supported version ` +
        `${CURRENT_VERSION} — refusing to read (never silently truncate)`,
    );
  }
  let migrated = data;
  for (let v = rawV; v < CURRENT_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new Error(`store "${name}": no migration path from schema version ${v}`);
    }
    migrated = step(migrated);
  }
  return migrated;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function defaultPayload() {
  return { v: CURRENT_VERSION };
}

// Blocks path traversal through user-supplied store ids (project, tool,
// rollup/digest id). Rollups validate `level` separately against the closed set.
function assertSafeName(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/[/\\]/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} "${value}" is not allowed in a store path`);
  }
}

// ---------------------------------------------------------------------------
// Single-file JSON stores (atomic jsonStore writes, mode 0600)
// ---------------------------------------------------------------------------

function createCtoJsonStore(name, path) {
  return {
    name,
    path,
    migrate: (data) => migrateStore(name, data),
    loadSync: () => {
      const raw = readJsonSync(path, null);
      return raw === null ? defaultPayload() : migrateStore(name, raw);
    },
    load: async () => {
      const raw = await readJson(path, null);
      return raw === null ? defaultPayload() : migrateStore(name, raw);
    },
    save: async (data) => {
      await writeJsonAtomic(path, JSON.stringify({ ...data, v: CURRENT_VERSION }, null, 2), {
        mode: MODE,
      });
    },
  };
}

export const inboxStore = createCtoJsonStore("inbox", ctoPath("inbox.json"));
export const cardsStore = createCtoJsonStore("cards", ctoPath("cards.json"));
export const profileStore = createCtoJsonStore("profile", ctoPath("profile.json"));
export const journalStore = createCtoJsonStore("journal", ctoPath("journal.json"));
export const toolRegistryStore = createCtoJsonStore("tool-registry", ctoPath("tool-registry.json"));
export const toolUsageStore = createCtoJsonStore("tool-usage", ctoPath("tool-usage.json"));
export const verdictsStore = createCtoJsonStore("verdicts", ctoPath("verdicts.json"));
export const budgetStore = createCtoJsonStore("budget", ctoPath("budget.json"));
// BET-1398 standing-query watchers (supersedes the cto.json watcher poller).
// Payload shape: `{ watchers: [{ id, patternSignature, predicate, source,
// created, lastHit, hits, retired? }] }`. Owned by ctoWatchers.mjs.
export const watchersStore = createCtoJsonStore("watchers", ctoPath("watchers.json"));
export const engineStateStore = createCtoJsonStore("engine-state", ctoPath("engine-state.json"));

// ---------------------------------------------------------------------------
// Single-level directory JSON stores: one file per id, e.g. `facts/<project>.json`
// ---------------------------------------------------------------------------

function createDirJsonStore(name, dirPart) {
  const filePath = (id) => ctoPath(dirPart, `${id}.json`);
  return {
    name,
    dir: ctoPath(dirPart),
    pathFor: (id) => {
      assertSafeName(id, name);
      return filePath(id);
    },
    migrate: (data) => migrateStore(name, data),
    loadSync: (id) => {
      assertSafeName(id, name);
      const raw = readJsonSync(filePath(id), null);
      return raw === null ? defaultPayload() : migrateStore(name, raw);
    },
    load: async (id) => {
      assertSafeName(id, name);
      const raw = await readJson(filePath(id), null);
      return raw === null ? defaultPayload() : migrateStore(name, raw);
    },
    save: async (id, data) => {
      assertSafeName(id, name);
      await writeJsonAtomic(filePath(id), JSON.stringify({ ...data, v: CURRENT_VERSION }, null, 2), {
        mode: MODE,
      });
    },
  };
}

export const factsStore = createDirJsonStore("facts", "facts");
export const factsArchiveStore = createDirJsonStore("facts-archive", "facts-archive");
export const digestsStore = createDirJsonStore("digests", "digests");
// Segments store — the read-layer work episodes (spec §5.1), one JSON file per
// segment, swept 30d by sweepSegments(). Owned by the segmentation issue (A6).
export const segmentsStore = createDirJsonStore("segments", "segments");

// ---------------------------------------------------------------------------
// Rollups: `rollups/<hour|day|week>/<id>.json` — one JSON file per rollup.
// ---------------------------------------------------------------------------

export const ROLLUP_LEVELS = Object.freeze(["hour", "day", "week"]);

export const rollupsStore = {
  name: "rollups",
  dir: ctoPath("rollups"),
  dirFor: (level) => {
    assertRollupLevel(level);
    return ctoPath("rollups", level);
  },
  pathFor: (level, id) => {
    assertRollupLevel(level);
    assertSafeName(id, "rollups");
    return ctoPath("rollups", level, `${id}.json`);
  },
  migrate: (data) => migrateStore("rollups", data),
  load: async (level, id) => {
    assertRollupLevel(level);
    assertSafeName(id, "rollups");
    const raw = await readJson(ctoPath("rollups", level, `${id}.json`), null);
    return raw === null ? defaultPayload() : migrateStore("rollups", raw);
  },
  save: async (level, id, data) => {
    assertRollupLevel(level);
    assertSafeName(id, "rollups");
    await writeJsonAtomic(
      ctoPath("rollups", level, `${id}.json`),
      JSON.stringify({ ...data, v: CURRENT_VERSION }, null, 2),
      { mode: MODE },
    );
  },
};

function assertRollupLevel(level) {
  if (!ROLLUP_LEVELS.includes(level)) {
    throw new Error(`rollups level must be one of ${ROLLUP_LEVELS.join(", ")} (got ${JSON.stringify(level)})`);
  }
}

// ---------------------------------------------------------------------------
// Ledger: `ledger.jsonl` — append-only, one JSON object per line, fsync not
// required. Each row carries a `ts` (epoch ms, stamped at append if absent);
// the reader parses rows and returns those within a time range.
// ---------------------------------------------------------------------------

export function createLedgerStore({ path = ctoPath("ledger.jsonl"), now = () => Date.now() } = {}) {
  async function append(entry) {
    if (entry === null || typeof entry !== "object") {
      throw new Error("ledger entries must be objects");
    }
    const row = { ...entry, ts: entry.ts != null ? entry.ts : now() };
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(row) + "\n", { mode: MODE });
  }

  async function read({ from, to, timeField = "ts" } = {}) {
    let text;
    try {
      text = await readFile(path, "utf-8");
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (from !== undefined || to !== undefined) {
          const t = row?.[timeField];
          if (from !== undefined && (typeof t !== "number" || t < from)) continue;
          if (to !== undefined && (typeof t !== "number" || t > to)) continue;
        }
        rows.push(row);
      } catch {
        // Skip malformed lines — the ledger is best-effort.
      }
    }
    return rows;
  }

  // Rewrites the whole file (used by the retention sweep to drop expired rows).
  async function rewrite(rows) {
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode: MODE });
  }

  return { name: "ledger", path, append, read, rewrite };
}

export const ledgerStore = createLedgerStore();

// ---------------------------------------------------------------------------
// Probes: `probes/<tool>.yaml` — YAML helpers (parse/stringify only; probe
// validation is a later issue). Reuses the `yaml` package parsing like
// src/shared/pluginManifest.mjs.
// ---------------------------------------------------------------------------

export const probesStore = {
  name: "probes",
  dir: ctoPath("probes"),
  pathFor: (tool) => {
    assertSafeName(tool, "probes");
    return ctoPath("probes", `${tool}.yaml`);
  },
  loadSync: (tool) => {
    assertSafeName(tool, "probes");
    try {
      const parsed = parseYaml(readFileSync(ctoPath("probes", `${tool}.yaml`), "utf-8"));
      return parsed ?? {};
    } catch {
      return {};
    }
  },
  load: async (tool) => {
    assertSafeName(tool, "probes");
    try {
      const parsed = parseYaml(await readFile(ctoPath("probes", `${tool}.yaml`), "utf-8"));
      return parsed ?? {};
    } catch {
      return {};
    }
  },
  save: async (tool, data) => {
    assertSafeName(tool, "probes");
    await mkdir(ctoPath("probes"), { recursive: true });
    await writeFile(ctoPath("probes", `${tool}.yaml`), stringifyYaml(data ?? {}), { mode: MODE });
  },
};

// ---------------------------------------------------------------------------
// Retention (spec §13.1)
// ---------------------------------------------------------------------------

export const RETENTION_MS = Object.freeze({
  ledger: 180 * DAY_MS,
  verdicts: 180 * DAY_MS,
  "rollups/hour": 14 * DAY_MS,
  "rollups/day": 120 * DAY_MS,
  "rollups/week": 2 * 365 * DAY_MS,
  segments: 30 * DAY_MS,
});

// facts-archive caps at 10× the 50-fact active cap, oldest dropped (§6.3).
export const ARCHIVE_CAP = 10 * 50;
// digests keeps the last 30 generated digests (spec §5.5).
export const DIGESTS_KEEP = 30;

// True when `ts` (epoch ms) falls outside the [nowMs - retentionMs, nowMs]
// window — i.e. the entry/file is due for removal. Boundary-exact: an entry
// exactly at the cutoff is kept.
export function isExpired(ts, { nowMs, retentionMs }) {
  return typeof ts === "number" && ts < nowMs - retentionMs;
}

// Pure filter: split `rows` into `keep` (within retention) and `dropped`.
export function expireRows(rows, { nowMs, retentionMs, timeField = "ts" } = {}) {
  const keep = [];
  const dropped = [];
  for (const row of rows) {
    if (isExpired(row?.[timeField], { nowMs, retentionMs })) dropped.push(row);
    else keep.push(row);
  }
  return { keep, dropped };
}

// Archive cap: keep the `cap` most recent entries (by `timeField`), dropping
// the oldest. Order-preserving within the kept set (stable).
export function capArchive(entries, { cap = ARCHIVE_CAP, timeField = "ts" } = {}) {
  if (entries.length <= cap) return entries;
  const indexed = entries.map((entry, i) => ({ entry, i }));
  indexed.sort(
    (a, b) => (a.entry?.[timeField] ?? 0) - (b.entry?.[timeField] ?? 0) || a.i - b.i,
  );
  return indexed
    .slice(entries.length - cap)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.entry);
}

// ---------------------------------------------------------------------------
// CTO inbox TTL (BET-1397 / spec §4.4). The `inbox.json` store carries one
// entry per inbound note; unread entries expire SILENTLY once past their TTL
// (never surfaced to the user — the inbox is a queue, not a notification
// system). `fyi` notes are ephemeral (48h); every other kind (and the bare
// `blocker` default) keeps a week.
// ---------------------------------------------------------------------------

export const INBOX_KINDS = Object.freeze(["fyi", "finding", "blocker", "handoff", "anomaly"]);
export const INBOX_TTL_MS = Object.freeze({
  fyi: 2 * DAY_MS,
  blocker: 7 * DAY_MS,
  finding: 7 * DAY_MS,
  handoff: 7 * DAY_MS,
  anomaly: 7 * DAY_MS,
});

// The TTL for an inbox kind (defaults to the 7d general case for unknown).
export function inboxExpiresAt(kind, ts, { now = () => Date.now() } = {}) {
  const t = typeof ts === "number" && Number.isFinite(ts) ? ts : now();
  return t + (INBOX_TTL_MS[kind] ?? INBOX_TTL_MS.blocker);
}

// Pure filter: drop inbox entries whose `expires` (epoch ms) is past `nowMs`.
// Silent by design (§4.4) — expiry produces nothing, no notification.
export function purgeExpiredInbox(entries, { nowMs = Date.now(), expiresField = "expires" } = {}) {
  const keep = [];
  const dropped = [];
  for (const e of entries) {
    const expires = e?.[expiresField];
    if (typeof expires === "number" && expires <= nowMs) dropped.push(e);
    else keep.push(e);
  }
  return { keep, dropped };
}

export async function sweepInbox(nowMs = Date.now()) {
  const payload = await inboxStore.load();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (entries.length === 0) return;
  const { keep } = purgeExpiredInbox(entries, { nowMs });
  if (keep.length !== entries.length) await inboxStore.save({ ...payload, entries: keep });
}

// ---------------------------------------------------------------------------
// Sweep wiring (copies the createCleanupSweep shape from servePage.mjs).
// I/O is the real fs but every path resolves under ctoPath() → the sandbox in
// tests, so running the sweep in a test never touches a live box.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function listJsonFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name);
}

async function fileTimestamp(filePath) {
  const raw = await readJson(filePath, null);
  return raw && typeof raw.ts === "number" ? raw.ts : undefined;
}

async function sweepLedger(nowMs) {
  const rows = await ledgerStore.read();
  if (rows.length === 0) return;
  const { keep } = expireRows(rows, { nowMs, retentionMs: RETENTION_MS.ledger });
  if (keep.length !== rows.length) await ledgerStore.rewrite(keep);
}

async function sweepVerdicts(nowMs) {
  const payload = await verdictsStore.load();
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (entries.length === 0) return;
  const { keep } = expireRows(entries, { nowMs, retentionMs: RETENTION_MS.verdicts });
  if (keep.length !== entries.length) await verdictsStore.save({ ...payload, entries: keep });
}

async function sweepDirByFileTime(dir, nowMs, retentionMs) {
  const files = await listJsonFiles(dir);
  for (const name of files) {
    const filePath = join(dir, name);
    const ts = await fileTimestamp(filePath);
    if (ts !== undefined && isExpired(ts, { nowMs, retentionMs })) {
      await rm(filePath, { force: true });
    }
  }
}

async function sweepRollups(nowMs) {
  for (const level of ROLLUP_LEVELS) {
    await sweepDirByFileTime(
      ctoPath("rollups", level),
      nowMs,
      RETENTION_MS[`rollups/${level}`],
    );
  }
}

// The segments store is owned by the segmentation issue (A6); the sweep rule
// ships here per §13.1 ("segments 30d"). No directory yet → no-op.
async function sweepSegments(nowMs) {
  await sweepDirByFileTime(ctoPath("segments"), nowMs, RETENTION_MS.segments);
}

async function sweepDigests() {
  const dir = ctoPath("digests");
  const files = await listJsonFiles(dir);
  if (files.length <= DIGESTS_KEEP) return;
  const timed = [];
  for (const name of files) {
    timed.push({ name, ts: (await fileTimestamp(join(dir, name))) ?? 0 });
  }
  timed.sort((a, b) => b.ts - a.ts || a.name.localeCompare(b.name));
  for (const { name } of timed.slice(DIGESTS_KEEP)) {
    await rm(join(dir, name), { force: true });
  }
}

async function sweepArchiveCaps() {
  const dir = ctoPath("facts-archive");
  const files = await listJsonFiles(dir);
  for (const name of files) {
    const filePath = join(dir, name);
    const payload = await readJson(filePath, null);
    if (!payload) continue;
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    if (entries.length <= ARCHIVE_CAP) continue;
    await writeJsonAtomic(
      filePath,
      JSON.stringify({ ...payload, entries: capArchive(entries, { cap: ARCHIVE_CAP }) }, null, 2),
      { mode: MODE },
    );
  }
}

/** Run every retention rule once. Pure-ish: resolves real paths (sandboxed in
 * tests). Exported for direct invocation in tests. */
export async function sweepAllStores({ nowMs = Date.now() } = {}) {
  await Promise.all([
    sweepLedger(nowMs),
    sweepVerdicts(nowMs),
    sweepRollups(nowMs),
    sweepSegments(nowMs),
    sweepDigests(),
    sweepArchiveCaps(),
    sweepInbox(nowMs),
  ]);
}

export function createCtoStoreSweep({ now = () => Date.now() } = {}) {
  let inFlight = false;

  async function sweep() {
    if (inFlight) return;
    inFlight = true;
    try {
      await sweepAllStores({ nowMs: now() });
    } finally {
      inFlight = false;
    }
  }

  return { sweep };
}

export function startCtoStoreSweeper({ intervalMs = SWEEP_INTERVAL_MS, ...opts } = {}) {
  const { sweep } = createCtoStoreSweep(opts);
  return startPoller(sweep, { intervalMs, label: "cto-stores" });
}
