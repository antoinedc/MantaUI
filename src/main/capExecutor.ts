// capExecutor.ts — the Mac-side executor for MantaUI plugins.
//
// Subscribes to bui-server's SSE bus, picks up `{kind:"capJob"}` envelopes
// targeting `host:"mac"`, and runs the matching plugin's manifest. Plugin
// manifests live as YAML files in ~/.manta/plugins/ (the Mac-side mirror of
// the AI's authoring surface); this module owns the in-memory map of parsed
// manifests and the per-step runner.
//
// Lifecycle invariants (per docs/mantuani-plugins.md §"src/main/capExecutor.ts"):
//   • enabled-gate at start: `pluginsEnabled !== true` → no-op stop.
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
//
// v2 changes (BET-190): the v1 HANDLERS map + handlers/iosBuild.ts is gone.
// A plugin is now a YAML manifest in ~/.manta/plugins/<name>.yaml. The
// executor scans that folder at boot and on every fs.watch change (500ms
// debounce), parses + validates each YAML via the shared pluginManifest
// module, and on every change + every SSE (re)connect publishes the
// registry to the server so the renderer can render the installed-plugins
// list in Settings → Plugins. The runner is the SAME exec() helper the v1
// handler used — just driven by manifest steps + a per-step env built via
// buildEnv().

import { spawn } from "node:child_process";
import { createBusConsumer, type BusConsumer } from "./busConsumer.js";
import {
  parseManifest,
  buildEnv,
  resolveCwd,
  validateSuppliedInputs,
  evalIf,
  type PluginManifest,
} from "../shared/pluginManifest.mjs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  watch as fsWatch,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// Rescan debounce after an fs.watch burst.
const RESCAN_DEBOUNCE_MS = 500;
// Built-in plugin names — `plugin.write` is the only one today; every other
// capability name resolves to a YAML manifest in ~/.manta/plugins/.
const PLUGIN_WRITE = "plugin.write";
// Directory holding plugin manifests. Created best-effort at startup (never
// throws — a read-only filesystem would still allow the executor to come up
// and just report no plugins).
const PLUGINS_DIR = join(homedir(), ".manta", "plugins");

// GUI-launched Electron apps don't inherit the user's shell PATH; prepend
// Homebrew paths so npm/npx/pod are visible (otherwise spawn fails ENOENT).
const PATH_PREFIX = "/opt/homebrew/bin:/usr/local/bin:";

// ---------------------------------------------------------------------------
// Per-job context (mirrors v1's CapCtx shape so the runner reads the same)
// ---------------------------------------------------------------------------

export type ExecResult = { code: number; stdout: string };

export type CapCtx = {
  input: unknown;
  config: AppConfig;
  // The cap-job's id (8-char hex from the server). Threaded to buildEnv
  // so plugins see `MANTA_JOB_ID=<id>` — same env var name the executor
  // itself uses for logging / dedup, so a plugin can correlate its
  // own output with the job envelope on the server.
  jobId: string;
  log(line: string): void;
  // Spawn helper — argv array, never a shell string. PATH is pre-patched by
  // capExecutor so Homebrew/nvm binaries are visible to this GUI app.
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; quiet?: boolean; env?: NodeJS.ProcessEnv },
  ): Promise<ExecResult>;
  signal: AbortSignal;
};

// ---------------------------------------------------------------------------
// In-memory manifest registry (built at boot + on every rescan)
// ---------------------------------------------------------------------------

export type RegistryEntry = {
  manifest: PluginManifest;
  valid: true;
  yaml: string;
  error?: undefined;
};

export type InvalidEntry = {
  name: string;
  manifest: null;
  valid: false;
  yaml: string;
  error: string;
};

export type RegistryRow = RegistryEntry | InvalidEntry;

// Public for tests — the registry is the source of truth for the
// PUT /api/plugins/registry publish below.
export function buildRegistry(entries: Iterable<RegistryRow>): RegistryRow[] {
  return [...entries];
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

let activeConsumer: BusConsumer | null = null;

export function startCapExecutor(
  configGetter: () => AppConfig,
): { stop(): void } {
  // Toggle takes effect on next app launch — no live start/stop. The
  // Settings UI says so.
  if (configGetter()?.pluginsEnabled !== true) {
    return { stop() {} };
  }

  // Best-effort: never throw on a read-only filesystem. The executor will
  // simply find zero manifests and run no jobs.
  try {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  } catch {
    /* ignore — directory creation is a courtesy */
  }

  const everEnqueued = new Set<string>();
  const queue: Array<{ id: string; capability: string }> = [];
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  let manifests: Map<string, RegistryRow> = scanPluginsDir();
  void publishRegistry(configGetter, manifests);

  // Debounced rescan: fs.watch fires many events on a single editor save;
  // collapse them into one scan + publish 500ms after the last event.
  let rescanTimer: NodeJS.Timeout | null = null;
  function scheduleRescan(): void {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      if (stopped) return;
      manifests = scanPluginsDir();
      void publishRegistry(configGetter, manifests);
    }, RESCAN_DEBOUNCE_MS);
    rescanTimer.unref?.();
  }

  let watcher: ReturnType<typeof fsWatch> | null = null;
  try {
    watcher = fsWatch(PLUGINS_DIR, { persistent: false }, () => scheduleRescan());
  } catch {
    /* directory may not exist on a fresh install — scanPluginsDir returned empty */
  }

  function enqueue(id: string, capability: string): void {
    if (stopped) return;
    if (everEnqueued.has(id)) return;
    everEnqueued.add(id);
    queue.push({ id, capability });
    chain = chain
      .then(() => runOne(configGetter, { id, capability }, () => manifests))
      .catch(() => {});
  }

  async function catchUpJobs(): Promise<void> {
    const c = cfgOrNull(configGetter);
    if (!c) return;
    // BET-207: every failure branch now logs — without these, a stranded
    // queued job was indistinguishable from "nothing to claim" and was
    // undiagnosable from logs. SSE has no replay, so this on-connect
    // GET is the ONLY path that can recover jobs the AI queued while
    // the Mac was offline/asleep. Reusing the dedup Set keeps double-
    // delivery (SSE envelope + this list) safe.
    let res: Response;
    try {
      res = await fetch(
        `${c.serverUrl.replace(/\/+$/, "")}/api/cap?host=mac&status=queued`,
        {
          headers: c.boxToken
            ? { authorization: `Bearer ${c.boxToken}` }
            : undefined,
        },
      );
    } catch (err) {
      console.warn("[cap] catch-up threw", err);
      return;
    }
    if (!res.ok) {
      console.warn("[cap] catch-up GET failed", res.status);
      return;
    }
    const body = (await res.json()) as { jobs?: Array<{ id: string; capability: string }> };
    const ids: string[] = [];
    for (const j of body.jobs ?? []) {
      ids.push(j.id);
      enqueue(j.id, j.capability);
    }
    console.log(`[cap] catch-up: ${ids.length} queued jobs`, ids);
  }

  function onConnect(): void {
    void catchUpJobs();
    // Re-publish the registry on (re)connect so the server picks up
    // anything edited while the executor was offline. Reuses the same
    // scanned map — fs.watch keeps it current between reconnect events.
    void publishRegistry(configGetter, manifests);
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
      try { watcher?.close(); } catch { /* already closed */ }
      if (rescanTimer) clearTimeout(rescanTimer);
    },
  };
}

export function stopCapExecutor(): void {
  activeConsumer?.stop();
  activeConsumer = null;
}

// ---------------------------------------------------------------------------
// Plugin folder scan (sync; called at boot + after every fs.watch burst)
// ---------------------------------------------------------------------------

function scanPluginsDir(): Map<string, RegistryRow> {
  const out = new Map<string, RegistryRow>();
  // existsSync is cheap; the dir may legitimately be absent on a fresh
  // install (we just mkdirSync'd it best-effort above).
  if (!existsSync(PLUGINS_DIR)) return out;
  let names: string[];
  try {
    names = readdirSync(PLUGINS_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    // Skip dotfiles, backups, non-yaml. Manifest filenames are user-chosen
    // but the spec says `*.yaml` is canonical; we accept `.yaml` only
    // (not `.yml`) to keep one canonical extension.
    if (name.startsWith(".")) continue;
    if (name.endsWith(".yaml.bak")) continue;
    if (!name.endsWith(".yaml")) continue;
    // The plugin's name is the basename minus the extension. Reject names
    // that wouldn't pass NAME_RE (so a stray `Foo Bar.yaml` is reported
    // as invalid rather than silently mapped to a broken key).
    const stem = name.slice(0, -".yaml".length);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(stem)) {
      out.set(stem || "<invalid>", {
        name: stem || "<invalid>",
        manifest: null,
        valid: false,
        yaml: "",
        error: `filename "${name}": name must match ^[a-z0-9][a-z0-9-]{0,62}$`,
      });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(PLUGINS_DIR, name), "utf-8");
    } catch (e: unknown) {
      out.set(stem, {
        name: stem,
        manifest: null,
        valid: false,
        yaml: "",
        error: `read failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const parsed = parseManifest(text);
    if (!parsed.ok || parsed.errors) {
      const errs = parsed.errors ?? [];
      out.set(stem, {
        name: stem,
        manifest: null,
        valid: false,
        yaml: text,
        error: errs.map((e) => `${e.path}: ${e.message}`).join("\n"),
      });
      continue;
    }
    // name in YAML must match the filename; a mismatch is a config error
    // (the AI saved with a different name from what the user expects).
    if (parsed.manifest.name !== stem) {
      out.set(stem, {
        name: stem,
        manifest: null,
        valid: false,
        yaml: text,
        error: `manifest name "${parsed.manifest.name}" must match filename "${stem}"`,
      });
      continue;
    }
    out.set(stem, { manifest: parsed.manifest, valid: true, yaml: text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Publish the registry to the box server so the renderer can render the
// installed-plugins list in Settings → Plugins. Best-effort — a PUT failure
// just means the renderer's list is stale until the next scan.
// ---------------------------------------------------------------------------

async function publishRegistry(
  configGetter: () => AppConfig,
  manifests: Map<string, RegistryRow>,
): Promise<void> {
  const c = cfgOrNull(configGetter);
  if (!c) return;
  const rows = [...manifests.values()].map((row) => {
    if (row.valid) {
      return {
        name: row.manifest.name,
        description: row.manifest.description,
        inputs: row.manifest.inputs,
        valid: true as const,
        yaml: row.yaml,
        stepCount: row.manifest.steps.length,
        timeoutMs: row.manifest.timeoutMs,
      };
    }
    return {
      name: row.name,
      description: "",
      inputs: [],
      valid: false as const,
      error: row.error,
      yaml: row.yaml,
      stepCount: 0,
      timeoutMs: null,
    };
  });
  try {
    await fetch(
      `${c.serverUrl.replace(/\/+$/, "")}/api/plugins/registry`,
      {
        method: "PUT",
        headers: {
          ...(c.boxToken ? { authorization: `Bearer ${c.boxToken}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(rows),
      },
    );
  } catch {
    /* swallow — best-effort */
  }
}

function cfgOrNull(configGetter: () => AppConfig): { serverUrl: string; boxToken: string; config: AppConfig } | null {
  const cfg = configGetter();
  if (!cfg?.serverUrl) return null;
  return { serverUrl: cfg.serverUrl, boxToken: cfg.boxToken ?? "", config: cfg };
}

// ---------------------------------------------------------------------------
// Per-job plumbing
// ---------------------------------------------------------------------------

async function runOne(
  configGetter: () => AppConfig,
  job: { id: string; capability: string },
  getManifests: () => Map<string, RegistryRow>,
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
  let handler: (ctx: CapCtx, manifests: Map<string, RegistryRow>) => Promise<{ result?: unknown }>;
  if (capability === PLUGIN_WRITE) {
    handler = handlePluginWrite;
  } else {
    const row = getManifests().get(capability);
    if (!row || !row.valid) {
      const installed = [...getManifests().keys()].join(", ") || "(none)";
      await postApi(c, `/api/cap/${id}/done`, "POST", {
        status: "failed",
        error: `unknown plugin "${capability}"; installed: ${installed}`,
      });
      return;
    }
    handler = makeManifestHandler(row.manifest);
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
    jobId: id,
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
    const { result } = await handler(ctx, getManifests());
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
// Handlers
// ---------------------------------------------------------------------------

// `plugin.write`: built-in tool that lets the AI author a new manifest.
// Validates via the shared module first (so an obviously-broken YAML never
// lands on disk), writes the file under ~/.manta/plugins/<name>.yaml,
// re-scans the folder so the executor picks it up immediately, and
// returns the validated entry. The actual authoring prompt happens in
// Phase 2 — this slice only establishes the executor side so the AI
// tools can be wired against it.
async function handlePluginWrite(ctx: CapCtx): Promise<{ result: unknown }> {
  const input = (ctx.input ?? {}) as { name?: unknown; yaml?: unknown };
  if (typeof input.name !== "string" || !input.name) {
    throw new Error("plugin.write: name is required");
  }
  if (typeof input.yaml !== "string" || !input.yaml) {
    throw new Error("plugin.write: yaml is required");
  }
  // The executor must NOT trust caller-supplied YAML — re-parse + validate
  // via the shared module so a malicious or typo'd manifest never lands.
  const parsed = parseManifest(input.yaml);
  if (!parsed.ok || parsed.errors) {
    const errs = parsed.errors ?? [];
    throw new Error(
      "plugin.write: validation failed: " +
        errs.map((er) => `${er.path}: ${er.message}`).join("; "),
    );
  }
  if (parsed.manifest.name !== input.name) {
    throw new Error(
      `plugin.write: manifest name "${parsed.manifest.name}" must match input.name "${input.name}"`,
    );
  }
  // Reuse the existing writeFileSync-style import above. Keep this
  // import-local so the file count at top of module is bounded.
  const { writeFileSync } = await import("node:fs");
  const target = join(PLUGINS_DIR, `${input.name}.yaml`);
  writeFileSync(target, input.yaml, "utf-8");
  // fs.watch will pick this up on the next tick; we don't manually rescan
  // here because the runner doesn't see the closure — the rescan happens
  // via the existing watcher.
  return { result: { name: input.name, valid: true } };
}

// Build a manifest runner closure. The returned function executes steps in
// order, evaluating `if:` against the supplied inputs, and short-circuits
// the first non-zero exit unless `continue_on_error: true`.
function makeManifestHandler(manifest: PluginManifest) {
  return async function runManifest(ctx: CapCtx): Promise<{ result: unknown }> {
    const supplied = (ctx.input ?? {}) as Record<string, unknown>;
    // Pre-validate supplied inputs before any step runs (BET-190 spec:
    // "Before step 1, call validateSuppliedInputs and abort with a clear
    // error if it fails — no steps run.").
    const v = validateSuppliedInputs(manifest, supplied);
    if (v.errors.length > 0) {
      throw new Error(
        "supplied inputs: " +
          v.errors.map((er) => `${er.path}: ${er.message}`).join("; "),
      );
    }
    const stepResults: Array<{ name: string; code: number; skipped: boolean }> = [];
    for (let i = 0; i < manifest.steps.length; i++) {
      const step = manifest.steps[i];
      // Step label for the log header — prefer `name`, else first word of
      // `run` for a stable readable prefix.
      const label = step.name || step.run.trim().split(/\s+/)[0] || `step${i + 1}`;
      // `if:` evaluation. evalIf may return {error} for a malformed expr
      // (which should have been caught at parse time, but defends
      // against a runtime-only edit). Skip on {error} so we never shell
      // out with an undecidable condition.
      if (step.if !== undefined) {
        const cond = evalIf(step.if, supplied);
        if (typeof cond === "object" && "error" in cond) {
          ctx.log(`--- step ${i + 1}: skipped (${step.if}) — ${cond.error} ---\n`);
          stepResults.push({ name: label, code: 0, skipped: true });
          continue;
        }
        if (cond === false) {
          ctx.log(`--- step ${i + 1}: skipped (${step.if}) ---\n`);
          stepResults.push({ name: label, code: 0, skipped: true });
          continue;
        }
      }
      ctx.log(`--- step ${i + 1}: ${label} ---\n`);
      // Per-step env = buildEnv + PATH patch from exec. We compute it once
      // per step (the step's own `env:` overlay isn't applied today — the
      // manifest-level env is the only source per spec — but the runner
      // still works for plugins that don't override per-step).
      // `ctx.jobId` is the cap-job id from the server (populated in
      // runOne when constructing the ctx) — surfaces as MANTA_JOB_ID in
      // the plugin's env so it can correlate its own output with the
      // server's job envelope.
      const env = buildEnv(manifest, supplied, { jobId: ctx.jobId });
      // Resolve cwd (optional). The user may pass `$KEY` substitution via
      // the supplied inputs — we feed the buildEnv result so any
      // MANTA_INPUT_<ID> is available as a substitution source.
      let cwdResolved: string | undefined;
      if (step.cwd) {
        const r = resolveCwd(step.cwd, env);
        if (typeof r !== "string") throw new Error(r.error);
        cwdResolved = r;
      }
      const stepTimeoutMs = parseStepTimeoutMs(step.timeout);
      const stepController = stepTimeoutMs
        ? withStepTimeout(controllerSignalOf(ctx), stepTimeoutMs)
        : null;
      try {
        const res = await ctx.exec("/bin/sh", ["-c", step.run], {
          cwd: cwdResolved,
          quiet: false,
          env,
        });
        if (res.code !== 0 && !step.continue_on_error) {
          throw new Error(`step ${i + 1} (${label}) exited with code ${res.code}`);
        }
        stepResults.push({ name: label, code: res.code, skipped: false });
      } finally {
        stepController?.abort();
      }
    }
    return { result: { steps: stepResults } };
  };
}

function parseStepTimeoutMs(timeout: unknown): number | null {
  if (typeof timeout !== "string" || !timeout) return null;
  const m = /^(\d+)(s|m)$/.exec(timeout);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return m[2] === "m" ? n * 60_000 : n * 1_000;
}

function controllerSignalOf(ctx: CapCtx): AbortSignal {
  return ctx.signal;
}

function withStepTimeout(parent: AbortSignal, ms: number): AbortController {
  // Per-step timeout layered on top of the per-job controller. When the
  // per-step timer fires, abort() the per-step controller; the per-job
  // controller still owns the overall job timeout (25 min). Aborting the
  // child does NOT abort the parent.
  const child = new AbortController();
  const timer = setTimeout(() => child.abort(), ms);
  timer.unref?.();
  // If the parent aborts first, propagate to the child so in-flight steps
  // die with the job.
  parent.addEventListener(
    "abort",
    () => {
      child.abort();
      clearTimeout(timer);
    },
    { once: true },
  );
  return child;
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
  method: "POST" | "GET" | "PUT",
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

// Exported for tests (capExecutor.test.ts) — keeps the env plumbing
// coverable without mocking spawn. Not part of the public API.
export function makeExec(
  signal: AbortSignal,
  logLine: (line: string) => void,
): CapCtx["exec"] {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      const cwd = opts?.cwd;
      const quiet = opts?.quiet === true;
      const baseEnv = opts?.env ?? process.env;
      let stdout = "";
      let stdoutTruncated = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, {
          cwd,
          env: {
            ...baseEnv,
            PATH: PATH_PREFIX + (baseEnv.PATH ?? process.env.PATH ?? ""),
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
