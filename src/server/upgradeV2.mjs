// upgradeV2.mjs — the V1 → V2 OpenCode upgrade as a durable, resumable state
// machine (slice C3). Serves K3 (`GET /api/upgrade`, retry, rollback) and puts
// the box in UPGRADE MODE while it runs.
//
// Steps (K3 ids), each idempotent and persisted to `~/.manta/v2-migration.json`
// so a manta-server restart (or a crash, or kill -9) resumes where it stopped:
//
//   preflight  free disk vs the V1 DB size → copy mode / in-place mode / fail
//   stop       wait ≤60s for running turns, stop opencode, retire V1 assets
//   copy       (copy mode) sqlite-backup the V1 DB next to itself as opencode-v2.db
//   migrate    start V2 on that DB; V2 migrates on startup; poll its progress 1/s
//   verify     plugins loaded, session counts agree, one tiny turn (if a Claude login exists)
//   cutover    restart opencode normally on V2, leave upgrade mode, resume background work
//
// ROLLBACK (only from `failed`): stop V2 → drop the V2 copy → restore V1's tools,
// plugins and config from the backup → start the preserved V1 binary on the untouched
// V1 DB → re-install the previous release (`self-update.sh --to <sha>`). The V1 DB is
// never written in copy mode; in place, V2 only ADDS tables next to V1's, so the same
// path works.
//
// All I/O is injected (`deps`), so the machine is unit-tested end to end with fakes;
// `createDefaultDeps` is the real thing. NOTHING here talks to the opencode API of a
// V1 service except the single running-turns probe.

import { copyFile, lstat, realpath, rename, rm, stat, statfs, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { STATE_DIRNAME, stateHome } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import {
  migrationStatePath,
  prepareOpencodeV2,
  resolveV1DbPath,
  restoreV1Assets,
  retireV1Assets,
  opencodeConfigDir,
  V2_PLUGIN_IDS,
} from "./upgradeV2Prepare.mjs";
import { respondSafe500 } from "./safeApiError.mjs";
import {
  createOpencodeService,
  opencodeBinPath,
  readOpencodeMainPid,
  readOpencodePassword,
  readOpenFiles,
} from "./upgradeV2Service.mjs";

export const STEP_IDS = Object.freeze(["preflight", "stop", "copy", "migrate", "verify", "cutover"]);
export const STEP_LABELS = Object.freeze({
  preflight: "Checking disk space",
  stop: "Stopping the chat backend",
  copy: "Copying conversation history",
  migrate: "Migrating conversations",
  verify: "Verifying the upgrade",
  cutover: "Switching over",
});
// How much of the overall bar each step is worth (copy's share moves to migrate in in-place mode).
const WEIGHTS = { preflight: 0.02, stop: 0.03, copy: 0.2, migrate: 0.65, verify: 0.05, cutover: 0.05 };

/**
 * Free space needed, as a multiple of the V1 DB size. MEASURED in the C3 rehearsal (pinned 2.0.30,
 * 300-session synthetic DB): migrating a COPY took 13.9 MB → 32.5 MB (the copy itself plus V2's
 * rows, 2.34×); migrating IN PLACE grows the one file 1.34× (V1 tables stay, V2 tables are added).
 * The thresholds sit just above those: a box that passes preflight can finish. (The first spec draft
 * said 1.0× / 0.8×, which would let a box pass and then die mid-migration on ENOSPC.)
 */
export const COPY_MODE_FACTOR = 2.4;
export const IN_PLACE_FACTOR = 1.4;

export const OPENCODE_V2_URL = "http://127.0.0.1:4096";
export const STOP_WAIT_MS = 60_000;

// ---------------------------------------------------------------- pure helpers

/**
 * Routes that keep answering while the box is upgrading. Everything else is
 * `503 {"error":"box upgrading","upgrade":true}` (K3).
 */
export function isUpgradeExemptPath(path) {
  const p = String(path ?? "");
  return (
    p === "/auth" || p.startsWith("/auth/") ||
    p === "/api/version" ||
    p === "/api/upgrade" || p.startsWith("/api/upgrade/") ||
    p === "/events" ||
    p === "/push" || p.startsWith("/push/")
  );
}

/** copy vs in-place vs refuse, from the DB size and the free space on its filesystem. */
export function decideMode({ dbBytes, freeBytes }) {
  if (freeBytes >= dbBytes * COPY_MODE_FACTOR) return { mode: "copy", needBytes: Math.ceil(dbBytes * COPY_MODE_FACTOR) };
  if (freeBytes >= dbBytes * IN_PLACE_FACTOR) return { mode: "in-place", needBytes: Math.ceil(dbBytes * IN_PLACE_FACTOR) };
  return { mode: null, needBytes: Math.ceil(dbBytes * IN_PLACE_FACTOR) };
}

function stepFraction(step) {
  if (step.status === "done") return 1;
  const p = step.progress;
  if (step.status === "running" && p && Number.isFinite(p.numerator) && Number.isFinite(p.denominator) && p.denominator > 0) {
    return Math.min(1, Math.max(0, p.numerator / p.denominator));
  }
  return 0;
}

/** 0..1 over the steps that apply (copy is skipped in place). */
export function computeOverall(steps, mode) {
  let total = 0;
  let got = 0;
  for (const id of STEP_IDS) {
    if (id === "copy" && mode === "in-place") continue;
    total += WEIGHTS[id];
    got += WEIGHTS[id] * stepFraction(steps[id]);
  }
  return total > 0 ? Math.min(1, got / total) : 0;
}

export class UpgradeError extends Error {
  constructor(message, { retryable = true, needBytes, haveBytes } = {}) {
    super(message);
    this.name = "UpgradeError";
    this.retryable = retryable;
    if (needBytes !== undefined) this.needBytes = needBytes;
    if (haveBytes !== undefined) this.haveBytes = haveBytes;
  }
}

function emptySteps() {
  const steps = {};
  for (const id of STEP_IDS) steps[id] = { status: "pending", progress: null };
  return steps;
}

function freshState() {
  return { version: 1, state: "idle", mode: null, v1Db: null, targetDb: null, v1Sessions: null, steps: emptySteps(), error: null };
}

/** Normalise whatever is on disk into a state object (tolerates old/partial files). */
function normaliseState(raw) {
  const s = { ...freshState(), ...(raw && typeof raw === "object" ? raw : {}) };
  s.steps = { ...emptySteps(), ...(raw?.steps ?? {}) };
  return s;
}

// ------------------------------------------------------------- reclaim (K7, spec §6)
//
// After a COPY-mode migration the untouched V1 history and the kept V1 binary exist only for
// rollback. Deleting them is a one-way, user-initiated choice. The state file supplies the
// deletion targets, so it is NOT trusted to also prove they are safe to delete: every target must
// pass an allowlist checked against the live DB identity read from the RUNNING opencode process,
// and every uncertainty fails closed.

export const RECLAIM_REASONS = Object.freeze({
  unfinished: "Only available after the upgrade finishes",
  inPlace: "This box migrated in place; reclaiming space isn't supported yet",
  done: "Already reclaimed",
  nothing: "Nothing to reclaim",
  live: "Couldn't confirm which database is in use",
  busy: "Another upgrade operation is still running",
  running: "Reclaiming space is already in progress",
  damaged: "The record of what to delete is damaged, so nothing more will be deleted",
  unexpected: "The old history isn't where the upgrade record says, so nothing will be deleted",
  checkFailed: "Couldn't check the old history files",
});
export const ROLLBACK_REFUSED_AFTER_RECLAIM = "Rollback is no longer possible: the old history was deleted to free space.";
const RETRY_REFUSED_AFTER_RECLAIM = "Retry is no longer possible: the old history was deleted to free space.";

const DB_NAMES = new Set(["opencode.db", "opencode.db-wal", "opencode.db-shm"]);
const BIN_NAME = "opencode-v1";
const LIVE_DB_RE = /^opencode.*\.db$/;
const DELETED_SUFFIX = " (deleted)";

const idOf = (st) => `${st.dev}:${st.ino}`;

/** User-facing words for an fs error — never the raw errno text or a full path (HTTP 500-body contract). */
function describeFsError(e) {
  switch (e?.code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EBUSY":
      return "the file is busy";
    case "EROFS":
      return "the disk is read-only";
    case "EIO":
      return "a disk error occurred";
    default:
      return "an unexpected error occurred";
  }
}

/** lstat, or null when the path (or a parent) simply doesn't exist. Anything else throws. */
async function lstatOrNull(fsOps, p) {
  try {
    return await fsOps.lstat(p);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
}

/** The real filesystem the reclaim reads and deletes through. Stats are bigint so inode numbers stay exact. */
export function createReclaimFs() {
  return {
    lstat: (p) => lstat(p, { bigint: true }),
    stat: (p) => stat(p, { bigint: true }),
    realpath: (p) => realpath(p),
    unlink: (p) => unlink(p),
  };
}

// -------------------------------------------------------------------- machine

export function createUpgradeV2(deps) {
  const {
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs = 1000,
    turnPollMs = 2000,
    stopWaitMs = STOP_WAIT_MS,
    startTimeoutMs = 120_000,
    requiredStallMs = 60_000,
    pluginWaitMs = 30_000,
    publish = () => {},
    log = () => {},
  } = deps;

  let state = normaliseState(null);
  let inFlight = null;
  let reclaiming = false;
  const rc = deps.reclaim ?? null;
  let lastPublished = "";
  const eta = { firstNum: null, firstAt: null, seconds: null };

  async function load() {
    state = normaliseState(await deps.loadState());
    // A reclaim recorded as "running" by a process that is gone was interrupted: report it as
    // failed so the user sees Retry (the manifest is what a retry resumes from).
    if (state.reclaim && typeof state.reclaim === "object" && state.reclaim.state === "running") {
      state.reclaim.state = "failed";
      state.reclaim.error = "Interrupted before it finished";
      await commit();
    }
  }

  function status() {
    const steps = STEP_IDS.map((id) => {
      const s = state.steps[id];
      const row = { id, label: STEP_LABELS[id], status: s.status, progress: s.progress ?? null };
      if (s.error) row.error = s.error;
      return row;
    });
    let error = null;
    if (state.error) {
      error = { step: state.error.step, message: state.error.message, retryable: state.error.retryable === true };
      if (state.error.needBytes !== undefined) error.needBytes = state.error.needBytes;
      if (state.error.haveBytes !== undefined) error.haveBytes = state.error.haveBytes;
    }
    return {
      state: state.state,
      steps,
      overall: state.state === "completed" ? 1 : computeOverall(state.steps, state.mode),
      etaSeconds: state.state === "running" && state.steps.migrate.status === "running" ? eta.seconds : null,
      error,
    };
  }

  async function commit() {
    state.updatedAt = now();
    await deps.saveState(state).catch((e) => log(`[upgrade] could not persist state: ${e?.message ?? e}`));
    const payload = status();
    const sig = JSON.stringify(payload);
    if (sig !== lastPublished) {
      lastPublished = sig;
      try {
        publish({ kind: "upgrade", payload });
      } catch (e) {
        log(`[upgrade] publish failed: ${e?.message ?? e}`);
      }
    }
  }

  async function setProgress(id, progress) {
    state.steps[id].progress = progress;
    await commit();
  }

  // ------------------------------------------------------------------ steps

  const handlers = {
    async preflight() {
      const v1Db = state.v1Db ?? deps.v1DbPath();
      state.v1Db = v1Db;
      const dbBytes = await deps.dbSizeBytes(v1Db);
      const freeBytes = await deps.freeBytes(dirname(v1Db));
      const d = decideMode({ dbBytes, freeBytes });
      if (!d.mode) {
        throw new UpgradeError(
          `Not enough free disk space to migrate your conversations: need at least ${d.needBytes} bytes, have ${freeBytes}.`,
          { retryable: true, needBytes: d.needBytes, haveBytes: freeBytes },
        );
      }
      state.mode = d.mode;
      state.targetDb = d.mode === "copy" ? join(dirname(v1Db), "opencode-v2.db") : v1Db;
      log(`[upgrade] preflight: db=${dbBytes}B free=${freeBytes}B → ${d.mode}`);
    },

    async stop() {
      await deps.services.pauseBackground();
      const deadline = now() + stopWaitMs;
      for (;;) {
        const n = await deps.services.runningTurns();
        if (n === 0) break;
        await setProgress("stop", { label: `Waiting for ${n} running turn${n === 1 ? "" : "s"} to finish` });
        if (now() >= deadline) break; // turns still running after the grace period end with the stop
        await sleep(turnPollMs);
      }
      await setProgress("stop", { label: "Stopping opencode" });
      await deps.opencode.stop();
      // V1 is down: its tools, plugins and claude-auth config entry can go now.
      await deps.retireV1();
      state.v1Sessions = await deps.countSessions(state.v1Db, "v1");
    },

    async copy() {
      if (state.mode !== "copy") {
        await setProgress("copy", null);
        return;
      }
      const partial = `${state.targetDb}.partial`;
      if (state.copyDone && (await deps.fileExists(state.targetDb))) return;
      await deps.removeDb(partial);
      await deps.removeDb(state.targetDb);
      await deps.copyDb({
        src: state.v1Db,
        dest: partial,
        onProgress: (numerator, denominator) => {
          state.steps.copy.progress = { label: "Copying conversation history", numerator, denominator };
          void commit();
        },
      });
      await deps.renameFile(partial, state.targetDb);
      state.copyDone = true;
      await commit();
    },

    async migrate({ resuming = false } = {}) {
      const db = state.mode === "copy" ? state.targetDb : null;
      // A previous run of THIS step already published progress: opencode may be mid-migration.
      const hadProgress = state.steps.migrate.progress != null;
      const serviceChanged = await deps.opencode.configure("v2", { db });
      // start() means RESTART everywhere, and restarting opencode discards an
      // in-flight v1 migration (its progress lives only in the WAL until it
      // commits). So when RESUMING an interrupted migrate (the step was running
      // and had progress when this process started) with the definition
      // unchanged and the service already up, skip the restart. A fresh run or a
      // retry after a failure always restarts: the service may be wedged.
      const alreadyUp = (await deps.opencode.isRunning?.()) === true;
      const keepRunning = resuming && hadProgress && !serviceChanged && alreadyUp;
      if (!keepRunning) await deps.opencode.start();
      eta.firstNum = null;
      eta.firstAt = null;
      eta.seconds = null;
      let startedAt = now(); // start-deadline reference, reset when OpenCode proves alive
      const migrateStartedAt = startedAt; // wall-clock anchor for the elapsed label, never reset
      let requiredSince = null;
      await setProgress("migrate", { label: "Starting OpenCode" });
      // OpenCode 2.0.30 blocks /api/experimental/migration/v1 until its lazy v1 migration finishes
      // (measured on a 34G archive: every request spans the whole migration), so per-item counts are
      // unavailable while we wait. Each poll is capped at 60 s (see migrationStatus): the cap turns every
      // long hold into a failed request — which is the "alive and busy" signal — and lets the loop
      // publish elapsed-time labels and session counts between holds. NO side timer runs, so a
      // step abandoned mid-poll leaves nothing spinning. A
      // delayed fetch failure (>=2s) resets the start deadline; only an instant failure
      // (connection refused) means it never came up.
      const elapsedLabel = (mins) =>
        "Migrating conversation history (OpenCode V2) - " + mins + " min elapsed; very large archives take tens of minutes";
      for (;;) {
        // Elapsed-time liveness label, published only while the blocked endpoint has surfaced no
        // counts of its own (once counts exist they are the better display — numerator/denominator
        // — and the status poll owns publishing them; nothing here may race it).
        let cur = state.steps.migrate.progress ?? {};
        const mins = Math.floor((now() - migrateStartedAt) / 60_000);
        const label = elapsedLabel(mins);
        if (!Number.isFinite(cur.numerator) && cur.label !== label) {
          await setProgress("migrate", { label });
        }
        let r;
        const fetchStartedAt = now();
        try {
          r = await deps.v2.migrationStatus();
        } catch {
          r = null;
        }
        if (r === null) {
          // A request that failed after a long hold means the endpoint was blocked behind the
          // migration: OpenCode is up and busy — widen the start grace and surface real count
          // progress from the read-only row counts (never below what is already surfaced).
          if (now() - fetchStartedAt >= 2_000) {
            startedAt = now();
            try {
              const v2Sessions = await deps.countSessions(state.targetDb, "v2");
              const denom = Number.isFinite(state.v1Sessions) ? state.v1Sessions : null;
              const curNum = Number.isFinite(cur.numerator) ? cur.numerator : -1;
              if (v2Sessions !== null && denom > 0 && v2Sessions > curNum) {
                await setProgress("migrate", { label, numerator: Math.min(v2Sessions, denom), denominator: denom });
              }
            } catch {
              // counts are best-effort
            }
          }
          if (now() - startedAt > startTimeoutMs) {
            throw new UpgradeError("OpenCode did not come up after the upgrade started. Retry, or roll back.", { retryable: true });
          }
        } else if (r.status === "completed") {
          const prev = state.steps.migrate.progress;
          // Keep the real count V2 last reported (300/300) rather than inventing a 1/1.
          await setProgress(
            "migrate",
            Number.isFinite(prev?.denominator) && prev.denominator > 0
              ? { label: prev.label, numerator: prev.denominator, denominator: prev.denominator }
              : { label: "Migrated" },
          );
          return;
        } else if (r.status === "error") {
          throw new UpgradeError(`Conversation migration failed: ${r.error?.message ?? r.error ?? "unknown error"}`, { retryable: true });
        } else if (r.status === "running") {
          requiredSince = null;
          const p = r.progress ?? {};
          const progress = { label: p.label ?? "Migrating" };
          if (Number.isFinite(p.numerator)) progress.numerator = p.numerator;
          if (Number.isFinite(p.denominator)) progress.denominator = p.denominator;
          if (progress.numerator !== undefined && progress.denominator > 0) {
            if (eta.firstNum === null) {
              eta.firstNum = progress.numerator;
              eta.firstAt = now();
            } else if (progress.numerator > eta.firstNum) {
              const rate = (progress.numerator - eta.firstNum) / ((now() - eta.firstAt) / 1000);
              eta.seconds = rate > 0 ? Math.max(0, Math.round((progress.denominator - progress.numerator) / rate)) : null;
            }
          }
          await setProgress("migrate", progress);
        } else if (r.status === "required") {
          // V2 sees V1 tables but has not begun; serve normally auto-runs the migration.
          requiredSince ??= now();
          if (now() - requiredSince > requiredStallMs) {
            throw new UpgradeError("OpenCode did not start migrating. Retry, or roll back.", { retryable: true });
          }
          await setProgress("migrate", { label: "Preparing migration" });
        }
        await sleep(pollMs);
      }
    },

    async verify() {
      await setProgress("verify", { label: "Checking plugins" });
      // OpenCode loads plugins LAZILY, per location, on the first request that needs them — the
      // first listing is empty, a later one is not. Poll until they are all active (or give up).
      const pluginDeadline = now() + pluginWaitMs;
      let missing = [...V2_PLUGIN_IDS];
      for (;;) {
        const ids = await deps.v2.pluginIds().catch(() => []);
        missing = V2_PLUGIN_IDS.filter((id) => !ids.includes(id));
        if (missing.length === 0 || now() >= pluginDeadline) break;
        await sleep(pollMs);
      }
      if (missing.length > 0) {
        throw new UpgradeError(`Manta plugins did not load in OpenCode: ${missing.join(", ")}.`, { retryable: true });
      }
      await setProgress("verify", { label: "Checking conversations" });
      if (state.v1Sessions !== null && state.v1Sessions !== undefined) {
        const v2 = await deps.countSessions(state.targetDb, "v2");
        if (v2 !== null && v2 < state.v1Sessions) {
          throw new UpgradeError(
            `Conversation count mismatch after migration: ${state.v1Sessions} before, ${v2} after. Nothing was lost on disk — roll back to keep the old version.`,
            { retryable: false },
          );
        }
      }
      if (await deps.hasClaudeLogin()) {
        await setProgress("verify", { label: "Running a test turn" });
        const t = await deps.v2.tinyTurn();
        if (!t.ok) throw new UpgradeError(`The test turn failed: ${t.error ?? "no reply"}`, { retryable: true });
      }
    },

    async cutover() {
      const db = state.mode === "copy" ? state.targetDb : null;
      await setProgress("cutover", { label: "Restarting OpenCode" });
      await deps.opencode.configure("v2", { db });
      await deps.opencode.start();
      const deadline = now() + startTimeoutMs;
      for (;;) {
        const r = await deps.v2.migrationStatus().catch(() => null);
        if (r?.status === "completed") break;
        if (now() > deadline) throw new UpgradeError("OpenCode did not come back after the switch-over. Retry, or roll back.", { retryable: true });
        await sleep(pollMs);
      }
      // One-shot config cutover: V1 `whitelist` entries are inert in V2 (the whole catalog would
      // show), so rewrite them now that V2 is up. Idempotent. A failure is logged, NEVER fails the
      // step — the upgrade itself is complete and the user can still fix a provider by hand.
      await migrateWhitelists();
    },
  };

  async function migrateWhitelists() {
    if (typeof deps.migrateLegacyWhitelists !== "function") return;
    try {
      const r = await deps.migrateLegacyWhitelists();
      if (r?.ok === false) log(`[upgrade] legacy whitelist migration failed (ignored): ${r.error ?? "unknown error"}`);
      else if (r?.migrated?.length) log(`[upgrade] migrated legacy whitelists: ${r.migrated.join(", ")}`);
    } catch (e) {
      log(`[upgrade] legacy whitelist migration threw (ignored): ${e?.message ?? e}`);
    }
  }

  // ---------------------------------------------------------------- the loop

  async function runFromFirstPending() {
    state.state = "running";
    state.error = null;
    await commit();
    for (const id of STEP_IDS) {
      if (state.steps[id].status === "done") continue;
      const step = state.steps[id];
      // "running" here means a previous process died mid-step (resume); a retry resets failed steps
      // to pending first.
      const resuming = step.status === "running";
      step.status = "running";
      step.error = undefined;
      step.startedAt = now();
      await commit();
      try {
        await handlers[id]({ resuming });
      } catch (e) {
        const err = e instanceof UpgradeError ? e : new UpgradeError(String(e?.message ?? e), { retryable: true });
        step.status = "failed";
        step.error = err.message;
        state.state = "failed";
        state.error = { step: id, message: err.message, retryable: err.retryable };
        if (err.needBytes !== undefined) state.error.needBytes = err.needBytes;
        if (err.haveBytes !== undefined) state.error.haveBytes = err.haveBytes;
        log(`[upgrade] step ${id} failed: ${err.message}`);
        await commit();
        // A failure that happened after the stop leaves background work paused; resume it so the
        // box is not silently half-dead — the gate (K3 failed) tells the user what to do.
        await deps.services.resumeBackground().catch(() => {});
        return;
      }
      step.status = "done";
      step.doneAt = now();
      // A finished step keeps a full bar only when it was a counted one.
      if (!(Number.isFinite(step.progress?.denominator) && step.progress.denominator > 0)) step.progress = null;
      else step.progress = { ...step.progress, numerator: step.progress.denominator };
      await commit();
    }
    state.state = "completed";
    state.completedAt = now();
    await commit();
    await deps.services.resumeBackground().catch(() => {});
  }

  function launch(fn) {
    inFlight = fn()
      .catch((e) => log(`[upgrade] unexpected: ${e?.stack ?? e}`))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  // ----------------------------------------------------------------- reclaim

  const hasReclaim = () => state.reclaim !== undefined && state.reclaim !== null;

  function reclaimState() {
    const r = state.reclaim;
    if (!hasReclaim()) return "none";
    if (typeof r !== "object") return "failed";
    if (r.state === "done") return "done";
    if (r.state === "running" && reclaiming) return "running";
    return "failed"; // a crashed "running", a recorded failure, or anything unrecognised
  }

  async function persistReclaim({ strict = false } = {}) {
    state.updatedAt = now();
    const p = deps.saveState(state);
    if (strict) await p;
    else await p.catch((e) => log(`[upgrade] could not persist reclaim progress: ${e?.message ?? e}`));
  }

  /**
   * The live DB, from the RUNNING opencode process: its PID (supervisor), then the files that PID
   * holds open. Null on any failure or ambiguity — the caller then refuses.
   */
  async function identifyLive() {
    if (!rc) return null;
    const f = rc.fs;
    try {
      const pid = await rc.runningPid();
      if (!Number.isInteger(pid) || pid <= 1) return null;
      const files = await rc.openFiles(pid);
      if (!Array.isArray(files)) return null;
      const openIds = new Set();
      const openPaths = new Set();
      const dbs = new Set();
      for (const file of files) {
        const path = String(file?.path ?? "");
        if (!path) continue;
        const deleted = path.endsWith(DELETED_SUFFIX);
        openPaths.add(path);
        let id = file.dev !== undefined && file.ino !== undefined ? `${file.dev}:${file.ino}` : null;
        if (!id && !deleted) {
          const st = await f.stat(path).catch(() => null);
          if (st) id = idOf(st);
        }
        if (id) openIds.add(id);
        if (deleted || !isAbsolute(path)) continue;
        const real = await f.realpath(path).catch(() => null);
        if (real) openPaths.add(real);
        if (real && LIVE_DB_RE.test(basename(real))) dbs.add(real);
      }
      if (dbs.size !== 1) return null;
      const [db] = [...dbs];
      const paths = new Set([db, `${db}-wal`, `${db}-shm`]);
      const ids = new Set();
      for (const p of paths) {
        const st = await f.stat(p).catch(() => null);
        if (st) ids.add(idOf(st));
      }
      return { db, dir: dirname(db), paths, ids, openIds, openPaths };
    } catch (e) {
      log(`[upgrade] reclaim: could not read the running opencode: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * One target through the FULL allowlist (spec §6.2) against `live`. `expected` (a manifest entry)
   * adds the inode pin. Returns {missing:true} | {ok:false,message} | {ok:true,entry}.
   */
  async function validateTarget(path, live, expected) {
    const f = rc.fs;
    const name = basename(path);
    const refuse = (why) => ({ ok: false, message: `${name} ${why}, so it won't be deleted` });
    if (!isAbsolute(path)) return refuse("has an unexpected location");
    const isDb = DB_NAMES.has(name);
    if (!isDb && name !== BIN_NAME) return refuse("is not on the list of files that can be deleted");
    const st = await lstatOrNull(f, path);
    if (!st) return { missing: true };
    if (st.isSymbolicLink() || !st.isFile()) return refuse("is not a regular file");
    if ((await f.realpath(path)) !== path) return refuse("is not at its canonical location");
    if (isDb) {
      if (dirname(path) !== live.dir) return refuse("is not in the folder of the database in use");
    } else if (path !== (await f.realpath(rc.binPath()).catch(() => null))) {
      return refuse("is not the preserved old OpenCode program");
    }
    if (live.paths.has(path) || live.ids.has(idOf(st))) return refuse("is the database in use");
    if (live.openPaths.has(path) || live.openIds.has(idOf(st))) return refuse("is open by OpenCode");
    if (expected && (String(expected.dev) !== String(st.dev) || String(expected.ino) !== String(st.ino))) {
      return refuse("was replaced by a different file");
    }
    return { ok: true, entry: { path, dev: String(st.dev), ino: String(st.ino), size: Number(st.size), removed: false } };
  }

  /** Step 1+2 on a fresh reclaim: pick the candidate files, then allowlist every one. */
  async function deriveTargets() {
    const fail = (reason) => ({ ok: false, reason });
    if (!rc) return fail(RECLAIM_REASONS.live);
    try {
      const f = rc.fs;
      const paths = [];
      const v1Db = state.v1Db;
      if (typeof v1Db !== "string" || !isAbsolute(v1Db)) return fail(RECLAIM_REASONS.unexpected);
      const vL = await lstatOrNull(f, v1Db);
      if (vL) {
        if (vL.isSymbolicLink() || !vL.isFile()) return fail(`${basename(v1Db)} is not a regular file, so it won't be deleted`);
        const V = await f.realpath(v1Db);
        for (const suffix of ["", "-wal", "-shm"]) {
          if (await lstatOrNull(f, V + suffix)) paths.push(V + suffix);
        }
      }
      const binL = await lstatOrNull(f, rc.binPath());
      if (binL) {
        if (binL.isSymbolicLink() || !binL.isFile()) return fail(`${BIN_NAME} is not a regular file, so it won't be deleted`);
        paths.push(await f.realpath(rc.binPath()));
      }
      if (paths.length === 0) return fail(RECLAIM_REASONS.nothing);
      const live = await identifyLive();
      if (!live) return fail(RECLAIM_REASONS.live);
      const targets = [];
      for (const p of paths) {
        const v = await validateTarget(p, live, null);
        if (v.missing) continue;
        if (!v.ok) return fail(v.message);
        targets.push(v.entry);
      }
      if (targets.length === 0) return fail(RECLAIM_REASONS.nothing);
      return { ok: true, targets, bytes: targets.reduce((n, t) => n + t.size, 0) };
    } catch (e) {
      log(`[upgrade] reclaim: check failed: ${e?.message ?? e}`);
      return fail(RECLAIM_REASONS.checkFailed);
    }
  }

  /** Why reclaim can't run at all right now (independent of what's on disk), or null. */
  function reclaimGate() {
    if (state.state !== "completed") return RECLAIM_REASONS.unfinished;
    if (state.mode === "in-place") return RECLAIM_REASONS.inPlace;
    if (state.mode !== "copy") return RECLAIM_REASONS.nothing;
    if (reclaimState() === "done") return RECLAIM_REASONS.done;
    return null;
  }

  async function reclaimStatus() {
    const mk = (available, reason, mode = null, bytes = null) => ({ available, reason, mode, bytes, state: reclaimState() });
    if (state.state !== "completed") return mk(false, RECLAIM_REASONS.unfinished);
    const mode = state.mode === "copy" || state.mode === "in-place" ? state.mode : null;
    const gate = reclaimGate();
    if (gate) return mk(false, gate, mode);
    if (reclaiming) return mk(false, RECLAIM_REASONS.running, mode);
    if (inFlight) return mk(false, RECLAIM_REASONS.busy, mode);
    if (hasReclaim()) {
      const entries = manifestEntries();
      if (!entries) return mk(false, RECLAIM_REASONS.damaged, mode);
      const bytes = entries.reduce((n, t) => n + (t?.removed === true || !Number.isFinite(t?.size) ? 0 : t.size), 0);
      return mk(true, null, mode, bytes);
    }
    const d = await deriveTargets();
    return d.ok ? mk(true, null, mode, d.bytes) : mk(false, d.reason, mode);
  }

  function manifestEntries() {
    const r = state.reclaim;
    return r && typeof r === "object" && Array.isArray(r.targets) ? r.targets : null;
  }

  /** Delete (or resume deleting) the manifest's targets. Never throws. */
  async function runReclaim() {
    const r = state.reclaim;
    const fail = async (message) => {
      r.state = "failed";
      r.error = message;
      log(`[upgrade] reclaim failed: ${message}`);
      await persistReclaim();
      return { ok: false, error: message };
    };
    const f = rc.fs;
    try {
      for (const t of r.targets) {
        if (t?.removed === true) continue;
        if (!t || typeof t.path !== "string" || !isAbsolute(t.path)) return await fail(RECLAIM_REASONS.damaged);
        if (!(await lstatOrNull(f, t.path))) {
          t.removed = true; // already gone (deleted just before a crash)
          await persistReclaim();
          continue;
        }
        const live = await identifyLive();
        if (!live) return await fail(RECLAIM_REASONS.live);
        const v = await validateTarget(t.path, live, t);
        if (v.missing) {
          t.removed = true;
          await persistReclaim();
          continue;
        }
        if (!v.ok) return await fail(v.message);
        try {
          await f.unlink(t.path);
        } catch (e) {
          if (e?.code !== "ENOENT") {
            log(`[upgrade] reclaim: could not delete ${t.path}: ${e?.message ?? e}`);
            return await fail(`Couldn't delete ${basename(t.path)}: ${describeFsError(e)}`);
          }
        }
        t.removed = true;
        await persistReclaim();
      }
      r.state = "done";
      r.doneAt = now();
      delete r.error;
      r.freedBytes = r.targets.reduce((n, t) => n + (Number.isFinite(t.size) ? t.size : 0), 0);
      await persistReclaim();
      return { ok: true, freedBytes: r.freedBytes };
    } catch (e) {
      return await fail(`Couldn't finish reclaiming space: ${describeFsError(e)}`);
    }
  }

  async function reclaim() {
    if (inFlight) return { ok: false, error: reclaiming ? RECLAIM_REASONS.running : RECLAIM_REASONS.busy };
    const gate = reclaimGate();
    if (gate) return { ok: false, error: gate };
    if (!rc) return { ok: false, error: RECLAIM_REASONS.live };
    reclaiming = true;
    const task = (async () => {
      try {
        if (!hasReclaim()) {
          const d = await deriveTargets();
          if (!d.ok) return { ok: false, error: d.reason };
          state.reclaim = { state: "running", startedAt: now(), targets: d.targets };
          // The manifest must be durable BEFORE the first deletion: a crash then resumes from it.
          try {
            await persistReclaim({ strict: true });
          } catch (e) {
            state.reclaim = undefined;
            log(`[upgrade] reclaim: could not persist the manifest: ${e?.message ?? e}`);
            return { ok: false, error: "Couldn't record what will be deleted, so nothing was deleted" };
          }
        } else if (!manifestEntries()) {
          return { ok: false, error: RECLAIM_REASONS.damaged };
        } else {
          state.reclaim.state = "running";
          delete state.reclaim.error;
          await persistReclaim();
        }
        return await runReclaim();
      } finally {
        reclaiming = false;
      }
    })();
    inFlight = task.catch(() => {}).finally(() => {
      inFlight = null;
    });
    return task;
  }

  // -------------------------------------------------------------------- API

  return {
    status,
    reclaimStatus,
    reclaim,
    isUpgradeMode: () => state.state === "running",
    whenIdle: () => inFlight ?? Promise.resolve(),
    _state: () => state, // tests

    /** Boot hook: make sure V2 is prepared; resume or auto-start the migration. */
    async boot() {
      await load();
      if (state.state === "completed") return { action: "none" };
      if (state.state === "running") {
        log("[upgrade] resuming an interrupted upgrade");
        // This process just started its pollers; the interrupted run had paused them.
        await deps.services.pauseBackground().catch(() => {});
        launch(runFromFirstPending);
        return { action: "resume" };
      }
      if (state.state === "failed" || state.state === "rolled_back") return { action: "none" };
      const prep = await deps.prepare();
      // The password may have just been created by prepare; nothing in manta-server caches it
      // (readOpencodePassword reads the file on every use), so no restart is owed.
      // Remember the release to roll back to NOW: a later self-update overwrites previous-release.json.
      state.previousRelease = (await deps.readPreviousRelease().catch(() => null)) ?? null;
      if (!prep.migrationNeeded) return { action: "none" };
      if (!state.v1Db) state.v1Db = deps.v1DbPath();
      launch(runFromFirstPending);
      return { action: "start" };
    },

    async retry() {
      if (hasReclaim()) return { ok: false, error: RETRY_REFUSED_AFTER_RECLAIM };
      if (inFlight) return { ok: false, error: reclaiming ? RECLAIM_REASONS.running : "The upgrade is already running." };
      if (state.state !== "failed") return { ok: false, error: "There is no failed upgrade to retry." };
      for (const id of STEP_IDS) {
        if (state.steps[id].status === "failed") {
          state.steps[id].status = "pending";
          state.steps[id].error = undefined;
        }
      }
      launch(runFromFirstPending); // flips to "running" synchronously, so the very next GET shows it
      return { ok: true };
    },

    async rollback() {
      // From the first destructive reclaim step on, the V1 history is (partly) gone: nothing to roll back to.
      if (hasReclaim()) return { ok: false, error: ROLLBACK_REFUSED_AFTER_RECLAIM };
      if (inFlight) return { ok: false, error: reclaiming ? RECLAIM_REASONS.running : "The upgrade is still running." };
      if (state.state !== "failed") return { ok: false, error: "There is nothing to roll back — the upgrade is not in a failed state." };
      const task = (async () => {
        let note = null;
        // A failure BEFORE the stop step (the disk preflight) never touched V1: leave the running
        // opencode alone and only put the previous release back.
        if (state.steps.stop.status !== "pending") {
          await deps.opencode.stop().catch((e) => log(`[upgrade] rollback: stop failed: ${e?.message ?? e}`));
          if (state.mode === "copy" && state.targetDb) {
            await deps.removeDb(`${state.targetDb}.partial`);
            await deps.removeDb(state.targetDb); // the V1 DB was never written to
          }
          await deps.restoreV1();
          await deps.opencode.configure("v1");
          await deps.opencode.start();
        }
        await deps.services.resumeBackground().catch(() => {});
        state.state = "rolled_back";
        state.error = null;
        state.rolledBackAt = now();
        for (const id of STEP_IDS) state.steps[id] = { status: "pending", progress: null };
        state.copyDone = false;
        await commit();
        // Last, because it restarts manta-server (and with it this process).
        try {
          const prev = state.previousRelease ?? (await deps.readPreviousRelease().catch(() => null));
          if (!prev?.git_sha) {
            note =
              "previous-release.json is missing (the update that installed this version predates rollback support), " +
              "so the earlier Manta release was not re-installed";
          } else {
            const r = await deps.reinstallPreviousRelease(prev);
            if (r?.skipped) note = r.skipped;
          }
        } catch (e) {
          note = String(e?.message ?? e);
        }
        if (note) {
          state.error = { step: "rollback", message: `OpenCode is back on V1, but the previous Manta release could not be re-installed automatically: ${note}`, retryable: false };
          await commit();
        }
      })();
      inFlight = task.catch(() => {}).finally(() => {
        inFlight = null;
      });
      try {
        await task;
      } catch (e) {
        log(`[upgrade] rollback failed: ${e?.stack ?? e}`);
        return { ok: false, error: `Rollback failed: ${String(e?.message ?? e)}` };
      }
      return { ok: true };
    },
  };
}

// ------------------------------------------------------------ rollback: re-install

/**
 * Run `self-update.sh --to <sha> [--version <v>]` and report how it went. The script ends by
 * restarting manta-server (which is THIS process), so success means "still running after
 * `watchMs`" — it got past every check that can fail (host lacks the build, commit unavailable,
 * download/verify error) and reached the restart. An early non-zero exit is a failure and its last
 * log line is returned as the reason. Never throws.
 */
export function runSelfUpdateTo({ script, sha, version, spawnFn = spawn, logPath, watchMs = 120_000, exists = existsSync, readLog = (p) => readFileSync(p, "utf8") }) {
  return new Promise((resolve) => {
    if (!exists(script)) return resolve({ skipped: `self-update.sh is missing (${script})` });
    const args = [script, "--to", sha, ...(version ? ["--version", version] : [])];
    let child;
    try {
      child = spawnFn("bash", args, { detached: true, stdio: "ignore" });
    } catch (e) {
      return resolve({ skipped: `could not start self-update.sh: ${e?.message ?? e}` });
    }
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({}), watchMs);
    child.on?.("error", (e) => finish({ skipped: `could not start self-update.sh: ${e?.message ?? e}` }));
    child.on?.("exit", (code) => {
      if (code === 0) return finish({});
      let last = "";
      try {
        last = readLog(logPath).split(/\r?\n/).filter((l) => l.trim()).pop() ?? "";
      } catch { /* no log */ }
      finish({ skipped: `self-update.sh --to ${sha} failed (exit ${code})${last ? `: ${last.replace(/\x1b\[[0-9;]*m/g, "")}` : ""}` });
    });
    child.unref?.();
  });
}

// ------------------------------------------------------------------- HTTP surface

const RECLAIM_SAFE_500_MESSAGE = "Couldn't check the old conversation history on the box.";

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
};

/**
 * The upgrade-mode gate + the K3 routes, as one handler so the real HTTP behaviour is testable
 * without importing index.mjs. Call it AFTER the auth gate. Returns true when it answered.
 *   * upgrade mode, non-exempt path → 503 {"error":"box upgrading","upgrade":true}
 *   * GET  /api/upgrade          → K3 status
 *   * POST /api/upgrade/retry    → {ok:true} | {ok:false,error}
 *   * POST /api/upgrade/rollback → {ok:true} | {ok:false,error}
 *   * GET  /api/upgrade/reclaim  → K7 ReclaimStatus
 *   * POST /api/upgrade/reclaim  → K7 ReclaimResult
 */
export function createUpgradeRoutes(engine) {
  return {
    /**
     * WebSocket twin of the 503 gate (call it from the `upgrade` handler, after auth). In upgrade mode
     * a non-exempt path (/pty, /call, anything else) is refused with the SAME HTTP 503 + body BEFORE
     * the handshake completes, then the socket is closed. Returns true when it refused.
     */
    refuseWebSocket(socket, path) {
      if (!engine.isUpgradeMode() || isUpgradeExemptPath(path)) return false;
      const body = JSON.stringify({ error: "box upgrading", upgrade: true });
      socket.write(
        `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nRetry-After: 5\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      socket.destroy();
      return true;
    },

    async handle(req, res, path) {
      if (engine.isUpgradeMode() && !isUpgradeExemptPath(path)) {
        json(res, 503, { error: "box upgrading", upgrade: true }, { "retry-after": "5" });
        return true;
      }
      if (req.method === "GET" && path === "/api/upgrade") {
        json(res, 200, engine.status());
        return true;
      }
      if (path === "/api/upgrade/reclaim" && (req.method === "GET" || req.method === "POST")) {
        try {
          json(res, 200, req.method === "GET" ? await engine.reclaimStatus() : await engine.reclaim());
        } catch (e) {
          // class-1 (BET-1460): the Settings row shows this to the user — safe literal, raw error to the log.
          respondSafe500(res, "upgrade/reclaim", RECLAIM_SAFE_500_MESSAGE, e);
        }
        return true;
      }
      if (req.method === "POST" && (path === "/api/upgrade/retry" || path === "/api/upgrade/rollback")) {
        json(res, 200, path.endsWith("/retry") ? await engine.retry() : await engine.rollback());
        return true;
      }
      return false;
    },
  };
}

// ----------------------------------------------------------- real dependencies

async function sqliteModule() {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

/**
 * The real I/O. `services` carries the bits only index.mjs knows
 * (pause/resume of the background pollers).
 */
export function createDefaultDeps({
  mantaHome,
  publish,
  services,
  env = process.env,
  home = homedir(),
  fetchImpl = globalThis.fetch,
  opencodeUrl = OPENCODE_V2_URL, // overridable ONLY for rehearsals/tests; production is always :4096
  opencodeService = null,
  spawnFn = spawn,
  // Overridable ONLY for tests, so the reclaim can be pointed at fixture files: any of
  // { binPath, runningPid, openFiles, fs }.
  reclaimIo = {},
  log = (m) => console.log(m),
} = {}) {
  const statePathFile = migrationStatePath();
  const opencode = opencodeService ?? createOpencodeService({
    home,
    log,
    spawnDetached: (bin, args, childEnv) => {
      const c = spawn(bin, args, { detached: true, stdio: "ignore", env: { ...process.env, ...childEnv } });
      c.unref();
    },
    killNohup: () =>
      new Promise((resolve) => {
        const c = spawn("pkill", ["-f", "opencode.* serve --port 4096"], { stdio: "ignore" });
        c.on("close", () => resolve());
        c.on("error", () => resolve());
      }),
  });
  const configDir = opencodeConfigDir(home);
  const password = () => readOpencodePassword({ env });
  const v2Fetch = async (path, init = {}) => {
    const res = await fetchImpl(`${opencodeUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${await password()}`).toString("base64")}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };

  return {
    loadState: async () => readJsonSync(statePathFile, null),
    saveState: (s) => writeJsonAtomic(statePathFile, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 }),
    publish,
    log,
    v1DbPath: () => resolveV1DbPath({ env, home }),
    prepare: () => prepareOpencodeV2({ mantaHome, home, env, log, service: opencode }),
    // C2's one-shot provider-config cutover; lazy so the upgrade module does not pull in the
    // whole providers graph at import.
    migrateLegacyWhitelists: async () => (await import("./providers.mjs")).migrateLegacyWhitelists(),
    retireV1: () => retireV1Assets({ configDir }),
    restoreV1: () => restoreV1Assets({ configDir }),
    opencode,
    services: {
      ...services,
      // V1's own status endpoint — the only thing here that talks to a V1 service.
      runningTurns: async () => {
        try {
          const res = await fetchImpl(`${opencodeUrl}/session/status`, { signal: AbortSignal.timeout(3000) });
          if (!res.ok) return 0;
          const body = await res.json();
          return Object.values(body ?? {}).filter((s) => s && s.type && s.type !== "idle").length;
        } catch {
          return 0;
        }
      },
    },

    dbSizeBytes: async (db) => {
      let total = 0;
      for (const f of [db, `${db}-wal`]) total += await stat(f).then((s) => s.size, () => 0);
      return total;
    },
    freeBytes: async (dir) => {
      const s = await statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    },
    fileExists: async (p) => existsSync(p),
    removeDb: async (p) => {
      for (const f of [p, `${p}-wal`, `${p}-shm`]) await rm(f, { force: true });
    },
    renameFile: (a, b) => rename(a, b),
    copyDb: async ({ src, dest, onProgress }) => {
      const sqlite = await sqliteModule();
      if (sqlite?.backup && sqlite?.DatabaseSync) {
        const db = new sqlite.DatabaseSync(src, { readOnly: true });
        try {
          const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
          await sqlite.backup(db, dest, {
            rate: 4096,
            progress: ({ totalPages, remainingPages }) => onProgress((totalPages - remainingPages) * pageSize, totalPages * pageSize),
          });
        } finally {
          db.close();
        }
        return;
      }
      // Runtimes without node:sqlite's backup: opencode is stopped, so a file copy is consistent.
      const total = await stat(src).then((s) => s.size);
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(src + suffix)) await copyFile(src + suffix, dest + suffix);
      }
      onProgress(total, total);
    },
    // Read-only and best-effort: null on ANY problem (no sqlite, no file, locked, table missing).
    // Called repeatedly while V2 is migrating the same file, so it waits at most 2 s on a lock.
    countSessions: async (db, which) => {
      let conn = null;
      try {
        const sqlite = await sqliteModule();
        if (!sqlite?.DatabaseSync || !db || !existsSync(db)) return null;
        conn = new sqlite.DatabaseSync(db, { readOnly: true });
        conn.exec("PRAGMA busy_timeout = 2000");
        const table = which === "v1" ? "session" : "session_v2";
        return Number(conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
      } catch {
        return null;
      } finally {
        try {
          conn?.close();
        } catch {
          /* already closed */
        }
      }
    },
    hasClaudeLogin: async () => existsSync(join(home, ".claude", ".credentials.json")),

    v2: {
      // 30 min: V2's lazy v1 migration runs inside this request, so on a huge DB each poll must
      // hold until it completes instead of aborting at the 10 s default.
      // Capped at 60 s, not a long hold: V2's lazy v1 migration runs inside this request on huge
      // DBs, so a hold can span the whole migration. Aborting at the cap turns each hold into the
      // loop's "alive and busy" delayed failure and lets elapsed/count progress publish between
      // holds; a dead opencode is noticed within a minute. The migration itself is boot-triggered
      // server-side and unaffected by the abort.
      migrationStatus: () => v2Fetch("/api/experimental/migration/v1", { timeoutMs: 60_000 }),
      // Only ACTIVE plugins count: a plugin that failed to load still appears in the list.
      pluginIds: async () => {
        const r = await v2Fetch(`/api/plugin?location[directory]=${encodeURIComponent(home)}`);
        return (r?.data ?? [])
          .filter((p) => typeof p === "string" || !p?.state?.status || p.state.status === "active")
          .map((p) => (typeof p === "string" ? p : p?.id))
          .filter(Boolean);
      },
      // One tiny real turn through the Claude login proves auth + plugins + model routing end to end.
      tinyTurn: async () => {
        let id = null;
        try {
          const created = await v2Fetch("/api/session", {
            method: "POST",
            body: JSON.stringify({ location: { directory: home }, model: { providerID: "anthropic", id: "claude-haiku-4-5" } }),
          });
          id = created.data.id;
          await v2Fetch(`/api/session/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "Reply with the single word: ok" }) });
          await v2Fetch(`/api/experimental/session/${id}/wait`, { method: "POST", timeoutMs: 90_000 });
          const msgs = await v2Fetch(`/api/session/${id}/message?limit=20`);
          const list = msgs?.data ?? msgs ?? [];
          const reply = list.some(
            (m) => m?.type === "assistant" && Array.isArray(m.content) && m.content.some((c) => c?.type === "text" && c.text),
          );
          return reply ? { ok: true } : { ok: false, error: "the model returned no text" };
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) };
        } finally {
          if (id) await v2Fetch(`/api/session/${id}`, { method: "DELETE" }).catch(() => {});
        }
      },
    },

    // Reclaim disk space (K7). The live DB identity comes from the RUNNING opencode process.
    reclaim: {
      binPath: () => opencodeBinPath("v1", home),
      runningPid: () => readOpencodeMainPid({ supervisor: opencode.supervisor ?? "nohup" }),
      openFiles: (pid) => readOpenFiles(pid),
      fs: createReclaimFs(),
      ...reclaimIo,
    },

    readPreviousRelease: async () => readJsonSync(statePath("previous-release.json"), null),

    /** Re-install the previous release with the self-update.sh that is on disk now (`--to <sha>`). */
    reinstallPreviousRelease: (prev) =>
      runSelfUpdateTo({ script: join(mantaHome, "scripts", "self-update.sh"), sha: prev.git_sha, version: prev.version, spawnFn, logPath: statePath("self-update.log") }),
  };
}

function statePath(...parts) {
  return join(stateHome(), STATE_DIRNAME, ...parts);
}
