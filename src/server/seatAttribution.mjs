// seatAttribution.mjs — the per-request seat attribution log (seat-placement spec
// §5.5): which seat and model served which conversation, as
// `~/.manta/seat-attribution/<provider>.jsonl`, one JSON object per line.
//
// A line is written for a request whose (session, seat, model) differs from the
// LAST line written for that session, plus one heartbeat per session per
// HEARTBEAT_MS while unchanged — an A→B→A inside a bucket is kept, and a busy
// conversation costs about six lines an hour. Ids and the model only, never content.
//
// FAIL-OPEN: `record` never throws or rejects. Lines go through a bounded
// in-memory queue (overflow drops the oldest, counts it, resets the dedupe state
// and the next line written for that provider is a `gap` marker); append and
// rotation run one at a time under a mutex; a failing disk is warned about at
// most once a minute and dropped on the floor — a request must never wait on it.
//
// Rotation: at `maxBytes` the file shifts to `.1`, `.1`→`.2`, … keeping `keep`
// files in all (`<provider>.jsonl`, `.1` … `.<keep-1>`). Files 0600, directory 0700.

import { appendFile, chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createMutex } from "./jsonStore.mjs";
import { statePath } from "../shared/paths.mjs";

export const HEARTBEAT_MS = 10 * 60_000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_KEEP = 4;
export const DEFAULT_QUEUE_MAX = 1000;
const WARN_EVERY_MS = 60_000;
/** The per-session dedupe map is bounded: the least recently written sessions are forgotten first. */
const MAX_TRACKED_SESSIONS = 10_000;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const defaultFs = { mkdir, appendFile, stat, rename, rm, chmod };

/**
 * @param {object} [deps]
 * @param {string} [deps.dir]  default `~/.manta/seat-attribution`
 * @param {() => number} [deps.now]
 * @param {{warn?: Function}} [deps.log]
 * @param {number} [deps.maxBytes]
 * @param {number} [deps.keep]
 * @param {number} [deps.queueMax]
 * @param {number} [deps.heartbeatMs]
 * @param {typeof defaultFs} [deps.fs]  injectable file operations (tests)
 */
export function createSeatAttribution({
  dir = statePath("seat-attribution"),
  now = () => Date.now(),
  log = console,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  queueMax = DEFAULT_QUEUE_MAX,
  heartbeatMs = HEARTBEAT_MS,
  fs = defaultFs,
} = {}) {
  const mutex = createMutex();
  /** `${provider}\0${session}` → {seat, model, at}; insertion order = recency of the last write. */
  const last = new Map();
  /** @type {Array<{provider: string, line: object}>} */
  let queue = [];
  const droppedByProvider = new Map();
  let droppedTotal = 0;
  let written = 0;
  let failed = 0;
  let scheduled = false;
  let lastWarnAt = -Infinity;

  function warn(what, e) {
    failed++;
    const t = now();
    if (t - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = t;
    try {
      log?.warn?.(`[seat-attribution] ${what}:`, e?.message ?? e);
    } catch {
      /* a broken logger must not matter either */
    }
  }

  const pathFor = (provider, n = 0) => join(dir, n === 0 ? `${provider}.jsonl` : `${provider}.jsonl.${n}`);

  async function rotate(provider) {
    // keep=4 → .jsonl, .1, .2, .3 : drop the oldest, shift the rest up by one.
    await fs.rm(pathFor(provider, keep - 1), { force: true });
    for (let n = keep - 2; n >= 0; n--) {
      try {
        await fs.rename(pathFor(provider, n), pathFor(provider, n + 1));
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
  }

  async function writeProvider(provider, lines) {
    const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    let size = 0;
    try {
      size = (await fs.stat(pathFor(provider))).size;
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    if (size > 0 && size + Buffer.byteLength(text) > maxBytes) await rotate(provider);
    await fs.appendFile(pathFor(provider), text, { mode: 0o600 });
    written += lines.length;
  }

  /** Writes everything queued right now. Runs only under the mutex. */
  async function drainOnce() {
    const batch = queue;
    queue = [];
    const drops = new Map(droppedByProvider);
    droppedByProvider.clear();
    const byProvider = new Map();
    for (const { provider, line } of batch) {
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(line);
    }
    // A provider that lost lines gets its gap marker ahead of what survived.
    for (const [provider, n] of drops) {
      const lines = byProvider.get(provider) ?? [];
      lines.unshift({ t: lines[0]?.t ?? now(), reason: "gap", dropped: n });
      byProvider.set(provider, lines);
    }
    for (const [provider, lines] of byProvider) {
      try {
        await writeProvider(provider, lines);
      } catch (e) {
        warn(`writing ${provider}.jsonl failed`, e);
      }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      mutex.runExclusive(drainOnce).catch((e) => warn("drain failed", e));
    });
  }

  /**
   * Note one request. Writes nothing when it repeats the last line for the
   * session inside the heartbeat window. Never throws.
   * @param {{provider: string, session: string, root?: string|null, seat: string|null, model?: string|null, reason: string}} evt
   */
  function record(evt) {
    try {
      const { provider, session, root = null, seat = null, model = null, reason } = evt ?? {};
      if (typeof provider !== "string" || !PROVIDER_RE.test(provider) || typeof session !== "string" || session === "") return;
      const t = now();
      const key = `${provider}\0${session}`;
      const prev = last.get(key);
      if (prev && prev.seat === seat && prev.model === model && t - prev.at < heartbeatMs) return;
      last.delete(key);
      last.set(key, { seat, model, at: t });
      if (last.size > MAX_TRACKED_SESSIONS) last.delete(last.keys().next().value);
      queue.push({ provider, line: { t, session, root, seat, model, reason } });
      if (queue.length > queueMax) {
        const dropped = queue.shift();
        droppedTotal++;
        droppedByProvider.set(dropped.provider, (droppedByProvider.get(dropped.provider) ?? 0) + 1);
        // A line is gone, so "unchanged since the last line" can no longer be trusted.
        last.clear();
      }
      schedule();
    } catch (e) {
      warn("recording failed", e);
    }
  }

  /** Resolves once everything queued so far is on disk (or has failed). Never rejects. */
  async function flush() {
    try {
      while (queue.length > 0 || droppedByProvider.size > 0) await mutex.runExclusive(drainOnce);
      await mutex.runExclusive(async () => {});
    } catch (e) {
      warn("flush failed", e);
    }
  }

  const stats = () => ({ queued: queue.length, dropped: droppedTotal, written, failed });

  return { record, flush, stats };
}

/**
 * Parse attribution lines, skipping blanks and any line that is not a whole JSON
 * object (a torn last line after a crash, a half-rotated file). Pure.
 * @param {string} text
 * @returns {object[]}
 */
export function parseAttributionLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {
      /* torn or foreign line — skipped */
    }
  }
  return out;
}

/**
 * Every readable line of a provider's log, oldest first (`.3` … `.1`, then the
 * live file). A missing file is skipped. Readers must treat the interval before a
 * `gap` line as unattributed.
 * @param {{dir?: string, provider: string, keep?: number}} args
 */
export async function readAttribution({ dir = statePath("seat-attribution"), provider, keep = DEFAULT_KEEP }) {
  const out = [];
  for (let n = keep - 1; n >= 0; n--) {
    const file = join(dir, n === 0 ? `${provider}.jsonl` : `${provider}.jsonl.${n}`);
    let text;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    out.push(...parseAttributionLines(text));
  }
  return out;
}
