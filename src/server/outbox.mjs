// Agent → device outbox poller for the mobile server.
//
// The mobile mirror of the desktop outbox poller (src/main/index.ts). The
// remote AI drops a file into ~/.manta-outbox/ (optionally a session subdir) and
// we surface it to connected devices as an `agentFile` bus event. Because the
// server IS the box (no SSH hop), detection is a plain local `readdir` rather
// than a `find` over the ControlMaster.
//
// IMPORTANT divergence from desktop: on a phone/browser there is no silent
// "save straight to the user's disk" path — the device must trigger a browser
// download (httpApi.agentPullFile → GET /api/download). So every detection
// publishes a CONFIRM toast (autoPulled:false) regardless of allowAgentPush.
// The actual delete of the remote source happens server-side in
// /api/download's handler when the device fetches the file (one-shot mailbox),
// not here — so a file the user never taps stays available across ticks.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { OUTBOX_DIRNAME } from "../shared/paths.mjs";

const POLL_MS = 3000;

// List every file in the outbox: loose files at the root plus one level of
// session subdirs (matches the desktop `find -maxdepth 2 -type f`). Returns []
// when the outbox doesn't exist yet (the steady state until the AI writes).
export async function listOutbox(root = join(homedir(), OUTBOX_DIRNAME)) {
  const out = [];
  let topEntries;
  try {
    topEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return out; // ENOENT etc. — outbox not created yet.
  }
  for (const ent of topEntries) {
    const full = join(root, ent.name);
    if (ent.isFile()) {
      const size = await statSize(full);
      out.push({ path: full, name: ent.name, size, session: null });
    } else if (ent.isDirectory()) {
      let subEntries;
      try {
        subEntries = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isFile()) continue;
        const subFull = join(full, sub.name);
        const size = await statSize(subFull);
        out.push({ path: subFull, name: sub.name, size, session: ent.name });
      }
    }
  }
  return out;
}

async function statSize(path) {
  try {
    const st = await stat(path);
    return st.size;
  } catch {
    return 0;
  }
}

/**
 * Build a single outbox scan step (testable without timers). Returns an async
 * `tick()` that scans the outbox once, publishes one `agentFile` event per
 * newly-seen file, and reconciles its internal seen-set against the live
 * listing (so a removed/downloaded file drops out and a future same-named push
 * is announced again). Re-entrancy guarded.
 *
 * @param {object} bus  - event bus with .publish({ kind, payload })
 * @param {string} root - outbox dir
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
            sessionName: entry.session,
            // Always a confirm toast on mobile — no silent disk write to a device.
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
  const outboxRoot = root ?? join(homedir(), OUTBOX_DIRNAME);
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
