// Agent → device artifact mailbox (mobile + desktop).
//
// The box (server IS the box) keeps a durable, workspace-linked mailbox of
// files the remote AI sends the user. The AI drops a file under
// ~/.manta-outbox/<sessionID>/ (its opencode session id — the workspace) via
// the `send_file` tool; a local scanner surfaces it to connected devices as an
// `agentFile` bus event (the "AI sent you a file" toast). Detection is a plain
// local `readdir`.
//
// Durability semantics (reconciled with the old one-shot mailbox):
//   - WORKSPACE-LINKED: files live in a subdir named by the opencode session
//     id, so the Artifacts panel shows each conversation only its own files.
//   - TTL: a file expires `DEFAULT_TTL_MS` (7 days) after it appears and is
//     swept by `expireArtifacts`. It is NOT deleted on download, so it can be
//     retrieved any number of times until then — both the artifacts panel's
//     download (/api/peek) and /api/download leave the source in place.
//   - The arrival toast (`agentFile`) still fires on new files.

import { readdir, stat, copyFile, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { outboxRoot as defaultOutboxRoot } from "../shared/paths.mjs";

const POLL_MS = 3000;
// Default tenure of a pushed artifact (7 days). Overridable per push via
// `send_file` ttlHours; `ttlHours === 0` means "never expires".
export const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
export const SWEEP_MS = 5 * 60 * 1000;

function resolveExpiry(ttlHours, mtime) {
  if (ttlHours === 0) return null;
  const ttl =
    typeof ttlHours === "number" && Number.isFinite(ttlHours) && ttlHours > 0
      ? ttlHours * 3600 * 1000
      : DEFAULT_TTL_MS;
  return mtime + ttl;
}

// List the artifact mailbox. Each row is { path, name, size, sessionID, mtime,
// expiresAt }. `sessionID` is the subdir name — the workspace the file belongs
// to — or null for a loose root file (the old bare `cp` flow). When `sessionID`
// is passed, only that workspace's files are returned (loose root files are
// not workspace-linked and are omitted).
export async function listOutbox(root = defaultOutboxRoot(), { sessionID } = {}) {
  const out = [];
  let topEntries;
  try {
    topEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return out; // ENOENT etc. — mailbox not created yet.
  }
  const now = Date.now();
  for (const ent of topEntries) {
    const full = join(root, ent.name);
    if (ent.isFile()) {
      if (sessionID != null && sessionID !== "") continue;
      out.push(await statRow(full, ent.name, null, now));
    } else if (ent.isDirectory()) {
      if (sessionID != null && ent.name !== sessionID) continue;
      let subEntries;
      try {
        subEntries = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isFile()) continue;
        out.push(await statRow(join(full, sub.name), sub.name, ent.name, now));
      }
    }
  }
  return out;
}

async function statRow(path, name, sessionID, now) {
  try {
    const st = await stat(path);
    return {
      path,
      name,
      size: st.size,
      sessionID,
      mtime: st.mtimeMs,
      expiresAt: resolveExpiry(null, st.mtimeMs, now),
    };
  } catch {
    return { path, name, size: 0, sessionID, mtime: 0, expiresAt: null };
  }
}

// Copy a local file into the workspace-linked mailbox and return its row. The
// source is NOT removed (the push is a copy; the AI keeps its working copy).
// Used by the `send_file` tool via POST /api/outbox/push.
export async function pushArtifact(
  filePath,
  sessionID,
  { root = defaultOutboxRoot(), ttlHours } = {},
) {
  if (!sessionID || typeof sessionID !== "string" || !sessionID.trim()) {
    return { ok: false, error: "sessionID is required" };
  }
  let src;
  try {
    src = await stat(filePath);
    if (!src.isFile()) return { ok: false, error: `"${filePath}" is not a regular file` };
  } catch {
    return { ok: false, error: `Source file "${filePath}" not found or not readable` };
  }
  const safe = basename(filePath).replace(/["\\/]/g, "_");
  const destDir = join(root, sessionID);
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, safe);
  await copyFile(filePath, dest);
  const row = await statRow(dest, safe, sessionID, Date.now());
  if (ttlHours != null) row.expiresAt = resolveExpiry(ttlHours, row.mtime);
  return { ok: true, row };
}

// Remove expired artifacts (TTL past) and prune now-empty session dirs.
// Injectable now/ttlMs so tests need no timers.
export async function expireArtifacts(
  root = defaultOutboxRoot(),
  { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {},
) {
  let topEntries;
  try {
    topEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const ent of topEntries) {
    if (!ent.isDirectory()) continue;
    const full = join(root, ent.name);
    try {
      const subs = await readdir(full, { withFileTypes: true });
      for (const sub of subs) {
        if (!sub.isFile()) continue;
        const subFull = join(full, sub.name);
        let st;
        try {
          st = await stat(subFull);
        } catch {
          continue;
        }
        if (now - st.mtimeMs > ttlMs) {
          await rm(subFull, { force: true });
          removed++;
        }
      }
      if ((await readdir(full, { withFileTypes: true })).length === 0) {
        await rm(full, { recursive: true, force: true });
      }
    } catch {
      /* per-dir best effort */
    }
  }
  return removed;
}

// Thin poller wiring for the box (mirrors servePage's cleanup sweep).
export function createArtifactSweep({
  root = defaultOutboxRoot(),
  intervalMs = SWEEP_MS,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  let timer = null;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await expireArtifacts(root, { ttlMs });
    } finally {
      running = false;
    }
  };
  return {
    start() {
      void sweep();
      timer = setInterval(() => void sweep(), intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    sweep,
  };
}

/**
 * Build a single outbox scan step (testable without timers). Returns an async
 * `tick()` that scans the mailbox once, publishes one `agentFile` event per
 * newly-seen file, and reconciles its internal seen-set against the live
 * listing (so a removed/expired file drops out and a future same-named push is
 * announced again). Re-entrancy guarded.
 *
 * @param {object} bus  - event bus with .publish({ kind, payload })
 * @param {string} root - mailbox dir
 * @returns {{ tick: () => Promise<void> }}
 */
export function createOutboxScanner(bus, root) {
  // Paths already announced this run, so the same file isn't re-toasted every
  // tick while it waits for the user to tap Save.
  const seen = new Set();
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const entries = await listOutbox(root);
      const present = new Set(entries.map((e) => e.path));
      for (const p of [...seen]) {
        if (!present.has(p)) seen.delete(p);
      }
      for (const entry of entries) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        bus.publish({
          kind: "agentFile",
          payload: {
            remotePath: entry.path,
            name: entry.name || basename(entry.path),
            size: entry.size,
            sessionName: entry.sessionID,
            // Always a confirm toast — no silent disk write to a device.
            autoPulled: false,
          },
        });
      }
    } catch (e) {
      console.warn("[outbox] tick failed:", e?.message ?? e);
    } finally {
      inFlight = false;
    }
  }

  return { tick };
}

/**
 * Start the outbox poller. Returns a stop() function.
 *
 * @param {object} bus  - event bus with .publish({ kind, payload })
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=3000]
 * @param {string} [opts.root]  - outbox dir override (tests)
 * @returns {{ stop: () => void }}
 */
export function startOutboxPoller(bus, { intervalMs = POLL_MS, root } = {}) {
  const outboxRoot = root ?? defaultOutboxRoot();
  const { tick } = createOutboxScanner(bus, outboxRoot);

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
