// boxTimeZone.mjs — the box follows the desktop's timezone.
//
// The desktop reports its OS timezone on every presence heartbeat. This module
//   (a) sets process.env.TZ in manta-server (immediate, no restart), so cron
//       schedules evaluate in the user's local time, and
//   (b) writes TZ=<zone> into the opencode service definition and restarts
//       opencode — but only when NOTHING is running, because a restart ends every
//       in-flight turn box-wide. Until then the write is inert and a restart is
//       "owed"; the owed restart is retried on a timer and whenever a session goes
//       idle, however long that takes.
//
// Spec: docs/superpowers/specs/2026-10-29-desktop-timezone.md.
//
// Pure logic + injected I/O (same shape as delegate.mjs / upgradeV2Service.mjs).
// `setProcessTz` is the ONLY place the env var is touched, and tests always
// inject a recorder: the suite runs on a live box and TZ is process-wide.

import { readFile } from "node:fs/promises";
import { readOpencodeMainPid } from "./upgradeV2Service.mjs";

const TZ_SHAPE = /^[A-Za-z0-9_+\-/]+$/;

/**
 * An IANA zone that is safe to write into a systemd unit / PlistBuddy command and that the
 * runtime recognises. The shape check comes first: no spaces, quotes, `=` or newlines.
 */
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || tz.length < 1 || tz.length > 64 || !TZ_SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The TZ the RUNNING opencode was started with: its string value ("" when it has none), or null
 * when that can't be read. Only systemd can answer (via /proc/<MainPID>/environ); on launchd /
 * nohup there is no reliable source, so the caller falls back to "owed only if this process
 * wrote the definition".
 */
export async function readRunningOpencodeTz({ supervisor, readPid = readOpencodeMainPid, read = (p) => readFile(p, "utf8") } = {}) {
  if (supervisor !== "systemd") return null;
  try {
    const pid = await readPid({ supervisor });
    if (!pid) return null;
    for (const entry of String(await read(`/proc/${pid}/environ`)).split("\0")) {
      if (entry.startsWith("TZ=")) return entry.slice(3);
    }
    return "";
  } catch {
    return null;
  }
}

/**
 * Restart opencode so its definition is re-read. launchd uses bootout+bootstrap via the service
 * (never `kickstart -k`, which restarts from launchd's stale in-memory definition); systemd goes
 * through the shared restartOpencode(), which already opens the provider-cache grace window.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function restartOpencodeService({ service, restartSystemd, invalidate }) {
  if (service.supervisor === "systemd") return restartSystemd();
  if (service.supervisor === "launchd") {
    try {
      await service.start();
      invalidate({ restarted: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, error: `cannot restart opencode under ${service.supervisor}` };
}

/**
 * @param {object} deps  all injectable.
 * @param {() => Promise<string|null|undefined>} deps.loadStored   the persisted desired zone
 * @param {(tz: string) => Promise<void>} deps.saveStored
 * @param {(tz: string) => void} [deps.setProcessTz]
 * @param {{ supervisor: string, readEnv: (k: string) => Promise<string|null>, setEnv: (e: object) => Promise<boolean> }} deps.service
 * @param {() => Promise<string|null>} [deps.readRunningTz]
 * @param {() => Promise<string[]>} deps.listActiveSessionIds  must THROW when the state is unknown
 * @param {() => Promise<{ ok: boolean, error?: string }>} deps.restart
 */
export function createBoxTimeZone({
  loadStored,
  saveStored,
  setProcessTz = (tz) => {
    process.env.TZ = tz;
  },
  service,
  readRunningTz = async () => null,
  listActiveSessionIds,
  restart,
  now = () => Date.now(),
  log = (line) => console.log(line),
  restartMinGapMs = 10 * 60_000,
  writeMinGapMs = 60_000,
  checkEveryMs = 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let desired = null;
  let appliedProcessTz = null;
  let loadPromise = null;
  // null = not yet derived (boot), true = the definition is ahead of the running opencode.
  let restartOwed = null;
  let lastWriteAt = null;
  let lastRestartAttemptAt = null;
  // True once a reconcile found definition == desired and no restart owed, so the cheap
  // "a session went idle" poke can skip the work. The timer always runs a full pass (it is what
  // notices a re-install that re-rendered the unit without TZ).
  let settled = false;
  let nohupLogged = false;
  let lastDeferReason = null;
  const invalidSeen = new Set();
  let timer = null;
  let inflight = null;
  let again = false;

  const say = (msg) => log(`[timezone] ${msg}`);

  function ensureLoaded() {
    loadPromise ??= (async () => {
      try {
        const stored = await loadStored();
        if (isValidTimeZone(stored)) desired = stored;
      } catch (e) {
        say(`couldn't read the stored timezone: ${e?.message ?? e}`);
      }
    })();
    return loadPromise;
  }

  function applyProcessTz() {
    if (desired && appliedProcessTz !== desired) {
      setProcessTz(desired);
      appliedProcessTz = desired;
    }
  }

  function defer(reason) {
    if (reason !== lastDeferReason) {
      lastDeferReason = reason;
      say(`opencode restart deferred: ${reason}`);
    }
  }

  async function isIdle() {
    try {
      const ids = await listActiveSessionIds();
      if (!Array.isArray(ids)) return { idle: false, reason: "active-session read returned no list" };
      return ids.length === 0 ? { idle: true } : { idle: false, reason: `${ids.length} session(s) running` };
    } catch (e) {
      // Unknown is never "idle": opencode may be down, booting or mid-turn.
      return { idle: false, reason: `active-session read failed (${e?.message ?? e})` };
    }
  }

  async function step() {
    await ensureLoaded();
    if (!desired) return;
    applyProcessTz();

    if (service.supervisor !== "systemd" && service.supervisor !== "launchd") {
      if (!nohupLogged) {
        nohupLogged = true;
        say(`opencode runs under ${service.supervisor}, which has no service definition to carry TZ — opencode stays on its current timezone`);
      }
      settled = true;
      return;
    }

    let have;
    try {
      have = await service.readEnv("TZ");
    } catch (e) {
      say(`couldn't read the opencode service definition: ${e?.message ?? e}`);
      return;
    }
    if (have !== desired) {
      const t = now();
      if (lastWriteAt !== null && t - lastWriteAt < writeMinGapMs) return; // the timer retries with the latest value
      try {
        await service.setEnv({ TZ: desired });
      } catch (e) {
        say(`writing TZ=${desired} into the opencode service definition failed (restart still owed): ${e?.message ?? e}`);
        restartOwed = true;
        return;
      }
      lastWriteAt = t;
      restartOwed = true;
      say(`wrote TZ=${desired} into the opencode ${service.supervisor} definition`);
    }

    if (restartOwed !== false) {
      let running = null;
      try {
        running = await readRunningTz();
      } catch {
        /* unknown */
      }
      if (typeof running === "string") restartOwed = running !== desired;
      else if (restartOwed === null) restartOwed = false; // can't tell, and this process didn't write it
    }
    if (!restartOwed) {
      lastDeferReason = null;
      settled = true;
      return;
    }

    if (lastRestartAttemptAt !== null && now() - lastRestartAttemptAt < restartMinGapMs) {
      defer("a timezone restart already ran in the last 10 minutes");
      return;
    }
    // Last thing before the restart, nothing awaited in between: work may have started while the
    // reads above were in flight.
    const idle = await isIdle();
    if (!idle.idle) {
      defer(idle.reason);
      return;
    }
    lastRestartAttemptAt = now();
    let result;
    try {
      result = await restart();
    } catch (e) {
      result = { ok: false, error: e?.message ?? String(e) };
    }
    if (result?.ok) {
      restartOwed = false;
      lastDeferReason = null;
      settled = true;
      say(`restarted opencode with TZ=${desired}`);
    } else {
      say(`opencode restart failed (will retry): ${result?.error ?? "unknown error"}`);
    }
  }

  function reconcile() {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          await step();
        } while (again);
      } catch (e) {
        say(`reconcile failed: ${e?.message ?? e}`);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  async function adopt(tz) {
    await ensureLoaded();
    if (tz === desired) return;
    say(`desired timezone ${desired ?? "(none)"} → ${tz}`);
    desired = tz;
    settled = false;
    applyProcessTz();
    try {
      await saveStored(tz);
    } catch (e) {
      say(`couldn't persist the timezone: ${e?.message ?? e}`);
    }
    await reconcile();
  }

  return {
    /**
     * Called from the presence heartbeat with whatever the client sent. Fire-and-forget: validates
     * and records, and never awaits a unit write / restart on the request path.
     */
    noteReported(raw) {
      if (raw === undefined || raw === null || raw === "") return;
      if (!isValidTimeZone(raw)) {
        const key = typeof raw === "string" ? raw.slice(0, 64) : `<${typeof raw}>`;
        if (!invalidSeen.has(key) && invalidSeen.size < 20) {
          invalidSeen.add(key);
          say(`ignoring invalid reported timezone ${JSON.stringify(key)}`);
        }
        return;
      }
      if (loadPromise && raw === desired) return; // the every-30s common case
      adopt(raw).catch((e) => say(`couldn't adopt ${raw}: ${e?.message ?? e}`));
    },

    /** A session went idle: if a restart is owed this is the moment to check. Cheap otherwise. */
    poke() {
      if (!settled) void reconcile();
    },

    reconcile,

    /**
     * Load the stored zone and apply it to this process (awaited — fast, so the schedule poller
     * sees the right zone from its first tick), then reconcile the opencode definition in the
     * background and keep checking on a timer.
     */
    async start() {
      await ensureLoaded();
      applyProcessTz();
      void reconcile();
      if (timer) clearIntervalFn(timer);
      timer = setIntervalFn(() => void reconcile(), checkEveryMs);
      timer?.unref?.();
      return { stop };
    },

    stop,

    /** Test/diagnostic view. */
    snapshot: () => ({ desired, restartOwed, settled }),
  };
}
