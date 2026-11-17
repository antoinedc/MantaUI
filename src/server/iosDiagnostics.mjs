// iosDiagnostics.mjs — POST /api/diagnostics/ios (iOS stability spec, C3).
//
// The native app forwards what iOS tells it about the app being killed or misbehaving (MetricKit crash / hang / CPU /
// disk-write / memory / launch diagnostics). Crashlytics never sees an OS kill, so the raw JSON is stored here, on the
// box, where an agent can read it: `~/.manta/ios-diagnostics/<UTC yyyymmddTHHMMSSZ>-<kind>-<6 hex>.json`.
//
// Contract:
//   - 200 { ok: true, id: <file name> }
//   - 400 { error }              invalid JSON, not an object, or no `kind`
//   - 413 { error: "too large" } body over 2 MiB
//   - 500 { error }              class-2 (BET-1460): consumed only by the app's upload loop, never shown to a user.
// The directory is 0700, files 0600, writes atomic. Retention (on every write and hourly): at most 500 files,
// 50 MiB and 30 days, oldest first.

import { mkdir, chmod, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { statePath } from "../shared/paths.mjs";
import { writeJsonAtomic } from "./jsonStore.mjs";

export const DIAGNOSTIC_KINDS = Object.freeze(["crash", "hang", "cpuException", "diskWriteException", "memoryException", "appLaunch", "other"]);
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const RETENTION = Object.freeze({ maxFiles: 500, maxBytes: 50 * 1024 * 1024, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
const STALE_TMP_MS = 60 * 60 * 1000;

/** `20261117T093045Z` */
export function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The kind as it appears in a file name: a known kind, anything else is `other` (the stored body keeps what was sent). */
export function fileKind(kind) {
  return DIAGNOSTIC_KINDS.includes(kind) ? kind : "other";
}

/** @returns {{ ok: true, body: object } | { ok: false, error: string }} */
export function validateDiagnostic(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.kind !== "string" || body.kind.trim() === "") return { ok: false, error: "missing kind" };
  return { ok: true, body };
}

/**
 * Delete expired files, then the oldest beyond the file-count and size caps. Only `*.json` diagnostics count; a stale
 * temp file left by a crash mid-write is removed too. Never throws.
 */
export async function sweepDiagnostics({ dir, now = Date.now, retention = RETENTION } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { removed: 0 };
  }
  const files = [];
  let removed = 0;
  const drop = async (f) => {
    try {
      await unlink(join(dir, f.name));
      removed++;
    } catch { /* already gone */ }
  };
  for (const name of names) {
    let s;
    try {
      s = await stat(join(dir, name));
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    if (name.endsWith(".json")) files.push({ name, size: s.size, mtimeMs: s.mtimeMs });
    else if (name.includes(".json.tmp-") && now() - s.mtimeMs > STALE_TMP_MS) await drop({ name });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1)); // oldest first
  const keep = [];
  for (const f of files) {
    if (now() - f.mtimeMs > retention.maxAgeMs) await drop(f);
    else keep.push(f);
  }
  let total = keep.reduce((n, f) => n + f.size, 0);
  while (keep.length > 0 && (keep.length > retention.maxFiles || total > retention.maxBytes)) {
    const oldest = keep.shift();
    total -= oldest.size;
    await drop(oldest);
  }
  return { removed };
}

function readCapped(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        resolve({ tooLarge: true });
        req.resume(); // drain the rest; the response closes the connection
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) resolve({ buf: Buffer.concat(chunks) });
    });
    req.on("error", reject);
  });
}

/**
 * @param {{ dir?: string, now?: () => number, randomHex?: () => string, retention?: typeof RETENTION }} [deps]
 */
export function createIosDiagnosticsHandler({
  dir = statePath("ios-diagnostics"),
  now = Date.now,
  randomHex = () => randomBytes(3).toString("hex"),
  retention = RETENTION,
} = {}) {
  const sweep = () => sweepDiagnostics({ dir, now, retention });
  const send = (res, status, obj, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify(obj));
  };

  async function handle(req, res) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      send(res, 413, { error: "too large" }, { connection: "close" });
      return;
    }
    try {
      const read = await readCapped(req, MAX_BODY_BYTES);
      if (read.tooLarge) {
        send(res, 413, { error: "too large" }, { connection: "close" });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(read.buf.toString("utf-8"));
      } catch {
        send(res, 400, { error: "invalid JSON" });
        return;
      }
      const v = validateDiagnostic(parsed);
      if (!v.ok) {
        send(res, 400, { error: v.error });
        return;
      }
      const id = `${utcStamp(new Date(now()))}-${fileKind(v.body.kind)}-${randomHex()}.json`;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      await writeJsonAtomic(join(dir, id), JSON.stringify(v.body), { mode: 0o600 });
      await sweep().catch(() => {});
      send(res, 200, { ok: true, id });
    } catch (e) {
      // class-2 (BET-1460): the iOS app's upload loop only — it keeps the diagnostic and retries; a user never sees it.
      send(res, 500, { error: String(e?.message ?? e) });
    }
  }

  return { handle, sweep };
}
