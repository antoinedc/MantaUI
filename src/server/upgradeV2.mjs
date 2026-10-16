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

import { copyFile, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { createOpencodeService, passwordFilePath } from "./upgradeV2Service.mjs";

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

/** Free space needed, as a multiple of the V1 DB size (spec: copy ≥ 1.0×, in place ≥ 0.8×). */
export const COPY_MODE_FACTOR = 1.0;
export const IN_PLACE_FACTOR = 0.8;

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
    publish = () => {},
    log = () => {},
  } = deps;

  let state = normaliseState(null);
  let inFlight = null;
  let lastPublished = "";
  const eta = { firstNum: null, firstAt: null, seconds: null };

  async function load() {
    state = normaliseState(await deps.loadState());
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

    async migrate() {
      const db = state.mode === "copy" ? state.targetDb : null;
      await deps.opencode.configure("v2", { db });
      await deps.opencode.start();
      eta.firstNum = null;
      eta.firstAt = null;
      eta.seconds = null;
      const startedAt = now();
      let requiredSince = null;
      await setProgress("migrate", { label: "Starting OpenCode" });
      for (;;) {
        let r;
        try {
          r = await deps.v2.migrationStatus();
        } catch {
          r = null;
        }
        if (r === null) {
          if (now() - startedAt > startTimeoutMs) {
            throw new UpgradeError("OpenCode did not come up after the upgrade started. Retry, or roll back.", { retryable: true });
          }
        } else if (r.status === "completed") {
          await setProgress("migrate", { label: "Migrated", numerator: 1, denominator: 1 });
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
      const ids = await deps.v2.pluginIds();
      const missing = V2_PLUGIN_IDS.filter((id) => !ids.includes(id));
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
    },
  };

  // ---------------------------------------------------------------- the loop

  async function runFromFirstPending() {
    state.state = "running";
    state.error = null;
    await commit();
    for (const id of STEP_IDS) {
      if (state.steps[id].status === "done") continue;
      const step = state.steps[id];
      step.status = "running";
      step.error = undefined;
      step.startedAt = now();
      await commit();
      try {
        await handlers[id]();
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
    if (state.serverRestartNeeded) {
      // manta-server cached an empty password before the first-boot prepare created it.
      await deps.services.restartServer().catch((e) => log(`[upgrade] server restart failed: ${e?.message ?? e}`));
    }
  }

  function launch(fn) {
    inFlight = fn()
      .catch((e) => log(`[upgrade] unexpected: ${e?.stack ?? e}`))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  // -------------------------------------------------------------------- API

  return {
    status,
    isUpgradeMode: () => state.state === "running",
    whenIdle: () => inFlight ?? Promise.resolve(),
    _state: () => state, // tests

    /** Boot hook: make sure V2 is prepared; resume or auto-start the migration. */
    async boot() {
      await load();
      if (state.state === "completed") return { action: "none" };
      if (state.state === "running") {
        log("[upgrade] resuming an interrupted upgrade");
        launch(runFromFirstPending);
        return { action: "resume" };
      }
      if (state.state === "failed" || state.state === "rolled_back") return { action: "none" };
      const prep = await deps.prepare();
      if (prep.passwordCreated) state.serverRestartNeeded = true;
      if (!prep.migrationNeeded) return { action: "none" };
      if (!state.v1Db) state.v1Db = deps.v1DbPath();
      launch(runFromFirstPending);
      return { action: "start" };
    },

    async retry() {
      if (inFlight) return { ok: false, error: "The upgrade is already running." };
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
      if (inFlight) return { ok: false, error: "The upgrade is still running." };
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
          const r = await deps.reinstallPreviousRelease();
          if (r?.skipped) note = r.skipped;
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

// ------------------------------------------------------------------- HTTP surface

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
 */
export function createUpgradeRoutes(engine) {
  return {
    async handle(req, res, path) {
      if (engine.isUpgradeMode() && !isUpgradeExemptPath(path)) {
        json(res, 503, { error: "box upgrading", upgrade: true }, { "retry-after": "5" });
        return true;
      }
      if (req.method === "GET" && path === "/api/upgrade") {
        json(res, 200, engine.status());
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
  log = (m) => console.log(m),
} = {}) {
  const statePathFile = migrationStatePath();
  const opencode = createOpencodeService({
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
  const password = async () => (await readFile(passwordFilePath(), "utf8")).trim();
  const v2Fetch = async (path, init = {}) => {
    const res = await fetchImpl(`${OPENCODE_V2_URL}${path}`, {
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
    prepare: () => prepareOpencodeV2({ mantaHome, home, env, log }),
    retireV1: () => retireV1Assets({ configDir }),
    restoreV1: () => restoreV1Assets({ configDir }),
    opencode,
    services: {
      ...services,
      restartServer: () => opencode.restartServer(),
      // V1's own status endpoint — the only thing here that talks to a V1 service.
      runningTurns: async () => {
        try {
          const res = await fetchImpl(`${OPENCODE_V2_URL}/session/status`, { signal: AbortSignal.timeout(3000) });
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
    countSessions: async (db, which) => {
      const sqlite = await sqliteModule();
      if (!sqlite?.DatabaseSync || !existsSync(db)) return null;
      const conn = new sqlite.DatabaseSync(db, { readOnly: true });
      try {
        const table = which === "v1" ? "session" : "session_v2";
        return Number(conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
      } catch {
        return null;
      } finally {
        conn.close();
      }
    },
    hasClaudeLogin: async () => existsSync(join(home, ".claude", ".credentials.json")),

    v2: {
      migrationStatus: () => v2Fetch("/api/experimental/migration/v1"),
      pluginIds: async () => {
        const r = await v2Fetch("/api/plugin");
        return (r?.data ?? []).map((p) => (typeof p === "string" ? p : p?.id)).filter(Boolean);
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

    /** Re-install the previous release with the script that is on disk now. */
    reinstallPreviousRelease: async () => {
      const prev = readJsonSync(statePath("previous-release.json"), null);
      if (!prev?.git_sha) return { skipped: "no record of the previous release (first update to this version)" };
      const script = join(mantaHome, "scripts", "self-update.sh");
      if (!existsSync(script)) return { skipped: "self-update.sh is missing" };
      const c = spawn("bash", [script, "--to", prev.git_sha], { detached: true, stdio: "ignore" });
      c.unref();
      return {};
    },
  };
}

function statePath(...parts) {
  return join(stateHome(), STATE_DIRNAME, ...parts);
}
