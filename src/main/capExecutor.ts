// capExecutor.ts — the Mac-side executor for MantaUI capability jobs.
//
// Subscribes to bui-server's SSE bus, picks up `{kind:"capJob"}` envelopes
// targeting `host:"mac"`, and runs the matching capability's handler. The
// only iOS-specific code lives in src/main/handlers/iosBuild.ts — adding
// capability #2 = new file under handlers/ + new HANDLERS entry, no change
// here.
//
// Lifecycle invariants (per docs/mantuani-plugins.md §"src/main/capExecutor.ts"):
//   • enabled-gate at start: `capExecutorEnabled !== true` → no-op stop.
//     Toggling takes effect on next app launch (Settings UI says so).
//   • SSE catch-up: on every onConnect (initial + reconnect), GET
//     /api/cap?host=mac&status=queued and enqueue. SSE has no replay, so
//     an offline/asleep Mac must claim what it missed.
//   • Serial + dedup: FIFO + Set<string> of ever-enqueued ids. Same job
//     WILL arrive via both SSE and catch-up; the Set drops duplicates.
//   • One job at a time: a single promise chain. Two parallel xcodebuilds
//     would corrupt the shared derived-data dir.
//   • Batched logs: ctx.log appends to a buffer; a per-job setInterval
//     (unref'd) flushes as ONE POST. Never one POST per line — xcodebuild
//     emits thousands.
//   • Done retry: failed /done POST is retried once after 5s; on second
//     failure log + drop (the server sweep times out the job anyway).

import { spawn } from "node:child_process";
import { createBusConsumer, type BusConsumer } from "./busConsumer.js";
import {
  iosBuildHandler,
  type CapCtx,
  type CapHandler,
} from "./handlers/iosBuild.js";
import type { AppConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants (single source of truth — see docs/mantuani-plugins.md §Constants)
// ---------------------------------------------------------------------------

// Mac-side per-job abort. < the server's 30 min so the Mac fails first and
// reports properly instead of leaving a stale `running` for the server sweep.
const EXECUTOR_JOB_TIMEOUT_MS = 25 * 60_000;
// Executor log-batch flush cadence.
const LOG_FLUSH_MS = 1_000;
// Cap on captured stdout returned by ctx.exec.
const EXEC_STDOUT_CAP_BYTES = 2 * 1024 * 1024;
// SIGTERM → SIGKILL grace on abort.
const KILL_GRACE_MS = 5_000;

// GUI-launched Electron apps don't inherit the user's shell PATH; prepend
// Homebrew paths so npm/npx/pod are visible (otherwise spawn fails ENOENT).
const PATH_PREFIX = "/opt/homebrew/bin:/usr/local/bin:";

// ---------------------------------------------------------------------------
// THE PLUGIN SEAM. v1 = one entry. Later = built from a plugin registry.
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, CapHandler> = {
  "ios.build": iosBuildHandler,
};

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

let activeConsumer: BusConsumer | null = null;

export function startCapExecutor(
  configGetter: () => AppConfig,
): { stop(): void } {
  // Toggle takes effect on next app launch — no live start/stop. The
  // Settings UI says so.
  if (configGetter()?.capExecutorEnabled !== true) {
    return { stop() {} };
  }

  const everEnqueued = new Set<string>();
  const queue: Array<{ id: string; capability: string }> = [];
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  function enqueue(id: string, capability: string): void {
    if (stopped) return;
    if (everEnqueued.has(id)) return;
    everEnqueued.add(id);
    queue.push({ id, capability });
    chain = chain.then(() => runOne(configGetter, { id, capability })).catch(() => {});
  }

  function cfgOrNull(): { serverUrl: string; boxToken: string; config: AppConfig } | null {
    const cfg = configGetter();
    if (!cfg?.serverUrl) return null;
    return { serverUrl: cfg.serverUrl, boxToken: cfg.boxToken ?? "", config: cfg };
  }

  async function catchUpJobs(): Promise<void> {
    const c = cfgOrNull();
    if (!c) return;
    try {
      const res = await fetch(
        `${c.serverUrl.replace(/\/+$/, "")}/api/cap?host=mac&status=queued`,
        {
          headers: c.boxToken
            ? { authorization: `Bearer ${c.boxToken}` }
            : undefined,
        },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { jobs?: Array<{ id: string; capability: string }> };
      for (const j of body.jobs ?? []) {
        enqueue(j.id, j.capability);
      }
    } catch {
      // Catch-up is best-effort; the SSE path will deliver what catch-up
      // misses (modulo the dedup Set) once the stream is live.
    }
  }

  function onConnect(): void {
    void catchUpJobs();
  }

  function onEnvelope(env: { kind?: string; payload?: unknown }): void {
    if (env.kind !== "capJob") return;
    const p = env.payload as
      | { id?: unknown; capability?: unknown; host?: unknown }
      | undefined;
    if (!p || p.host !== "mac") return;
    if (typeof p.id !== "string" || typeof p.capability !== "string") return;
    enqueue(p.id, p.capability);
  }

  const consumer: BusConsumer = createBusConsumer(
    configGetter,
    onEnvelope,
    onConnect,
  );
  activeConsumer = consumer;

  return {
    stop() {
      stopped = true;
      consumer.stop();
      if (activeConsumer === consumer) activeConsumer = null;
    },
  };
}

export function stopCapExecutor(): void {
  activeConsumer?.stop();
  activeConsumer = null;
}

// ---------------------------------------------------------------------------
// Per-job plumbing
// ---------------------------------------------------------------------------

async function runOne(
  configGetter: () => AppConfig,
  job: { id: string; capability: string },
): Promise<void> {
  const cfg = configGetter();
  if (!cfg?.serverUrl) return;
  const c: Cfg = { serverUrl: cfg.serverUrl, boxToken: cfg.boxToken ?? "", config: cfg };
  const { id, capability } = job;

  // Step 1 — claim the job. Non-2xx (409 = already claimed / stale) is the
  // cross-delivery dedup: just log and skip.
  const claim = await postApi(c, `/api/cap/${id}/start`, "POST", null);
  if (!claim.ok) {
    console.warn(`[cap] start ${id}: ${claim.error} — skipping`);
    return;
  }

  // Step 2 — handler lookup. Unknown → fail the job, NEVER shell out.
  const handler = HANDLERS[capability];
  if (!handler) {
    await postApi(c, `/api/cap/${id}/done`, "POST", {
      status: "failed",
      error: `unknown capability "${capability}"`,
    });
    return;
  }

  // Step 3 — context. Buffer + flush timer are job-scoped (one per job).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTOR_JOB_TIMEOUT_MS);
  timeout.unref?.();

  let logBuffer = "";
  let logTimer: NodeJS.Timeout | null = null;

  function flushLog(): void {
    if (!logBuffer) return;
    const chunk = logBuffer;
    logBuffer = "";
    void postApi(c, `/api/cap/${id}/log`, "POST", { chunk });
  }

  logTimer = setInterval(flushLog, LOG_FLUSH_MS);
  logTimer.unref?.();

  const ctx: CapCtx = {
    input: null, // set after we fetch the job below
    config: c.config,
    log(line: string) {
      logBuffer += line;
      if (!line.endsWith("\n")) logBuffer += "\n";
    },
    exec: makeExec(controller.signal, (line) => {
      logBuffer += line;
    }),
    signal: controller.signal,
  };

  // Pull the full job (input + config snapshot) BEFORE running so the
  // handler sees the same input the AI posted.
  const fetched = await getJobFull(c, id);
  if (!fetched.ok) {
    clearTimeout(timeout);
    if (logTimer) clearInterval(logTimer);
    flushLog();
    await postDone(c, id, { status: "failed", error: fetched.error });
    return;
  }
  ctx.input = fetched.job.input;

  try {
    const { result } = await handler(ctx);
    clearTimeout(timeout);
    if (logTimer) clearInterval(logTimer);
    flushLog();
    await postDone(c, id, { status: "done", result: result ?? null });
  } catch (e) {
    clearTimeout(timeout);
    if (logTimer) clearInterval(logTimer);
    flushLog();
    const aborted = controller.signal.aborted;
    const error = aborted
      ? "job timed out"
      : (e instanceof Error ? e.message : String(e));
    await postDone(c, id, { status: "failed", error });
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type Cfg = {
  serverUrl: string;
  boxToken: string;
  config: AppConfig;
};

async function postApi(
  cfg: Cfg,
  path: string,
  method: "POST" | "GET",
  body: unknown,
): Promise<{ ok: boolean; status: number; error?: string; data?: unknown }> {
  const url = `${cfg.serverUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {};
  if (cfg.boxToken) headers["authorization"] = `Bearer ${cfg.boxToken}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body !== null ? { "content-type": "application/json" } : {}),
      },
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          (data as { error?: string } | null)?.error ??
          `${method} ${path}: HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function getJobFull(
  cfg: Cfg,
  id: string,
): Promise<{ ok: true; job: { input: unknown } } | { ok: false; error: string }> {
  const r = await postApi(cfg, `/api/cap/${id}`, "GET", null);
  if (!r.ok) return { ok: false, error: r.error ?? "fetch failed" };
  const data = r.data as { id?: string; input?: unknown } | null;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "malformed job payload" };
  }
  return { ok: true, job: { input: data.input ?? {} } };
}

async function postDone(
  cfg: Cfg,
  id: string,
  body: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  // Failed /done is retried once after 5s; second failure → log + drop (the
  // server sweep will time out the job).
  const r = await postApi(cfg, `/api/cap/${id}/done`, "POST", body);
  if (r.ok) return;
  console.warn(
    `[cap] done ${id} first attempt failed: ${r.error} — retrying in 5s`,
  );
  await new Promise((r) => setTimeout(r, 5_000));
  const r2 = await postApi(cfg, `/api/cap/${id}/done`, "POST", body);
  if (!r2.ok) {
    console.warn(
      `[cap] done ${id} retry failed (${r2.error}) — dropping; server sweep will time out`,
    );
  }
}

// ---------------------------------------------------------------------------
// ctx.exec — argv spawn with PATH patch + capture + abort handling.
// ---------------------------------------------------------------------------

function makeExec(
  signal: AbortSignal,
  logLine: (line: string) => void,
): CapCtx["exec"] {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      const cwd = opts?.cwd;
      const quiet = opts?.quiet === true;
      let stdout = "";
      let stdoutTruncated = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, {
          cwd,
          env: {
            ...process.env,
            PATH: PATH_PREFIX + (process.env.PATH ?? ""),
          },
          signal,
        });
      } catch (e) {
        reject(
          new Error(
            `${cmd} not found on PATH — install it via Homebrew ` +
              `(nvm-only node installs are not visible to GUI apps): ` +
              (e instanceof Error ? e.message : String(e)),
          ),
        );
        return;
      }

      child.on("error", (e) => {
        reject(
          new Error(
            `${cmd} not found on PATH — install it via Homebrew ` +
              `(nvm-only node installs are not visible to GUI apps): ${e.message}`,
          ),
        );
      });

      const onAbort = () => {
        if (child.exitCode !== null) return;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        const killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already dead */
            }
          }
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > EXEC_STDOUT_CAP_BYTES) {
          stdout = stdout.slice(-EXEC_STDOUT_CAP_BYTES);
          stdoutTruncated = true;
        }
        if (!quiet) logLine(`[stdout] ${chunk}`);
      });
      child.stderr?.on("data", (chunk: string) => {
        if (!quiet) logLine(`[stderr] ${chunk}`);
      });

      child.on("close", (code) => {
        signal.removeEventListener?.("abort", onAbort);
        if (stdoutTruncated) {
          stdout = `[truncated to last ${EXEC_STDOUT_CAP_BYTES} bytes]\n${stdout}`;
        }
        resolve({ code: code ?? 0, stdout });
      });
    });
}
