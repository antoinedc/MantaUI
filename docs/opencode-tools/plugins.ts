// MantaUI plugin tools — global opencode custom tools for authoring,
// listing, running, and inspecting YAML-defined plugins on the connected
// machine.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/plugins.ts ~/.config/opencode/tools/plugins.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// (COPY, never symlink — the `@opencode-ai/plugin` import-resolution gotcha in
// docs/bui-tools-scheduler.md §"DO NOT symlink".)
//
// These tools are THIN registrars. They validate inputs and POST to
// manta-server (127.0.0.1:8787, same box — no SSH hop), which owns the durable
// job queue (src/server/capabilities.mjs) and the plugin registry
// (src/server/plugins.mjs). The tools do NOT block on plugin runs:
// plugin_run returns immediately with the job id, and a completion turn is
// injected back into this session when the Mac executor finishes.
//
// A "plugin" is a YAML manifest at ~/.manta/plugins/<name>.yaml on the
// machine the user wants to drive (today: only host:"mac" — the connected
// Mac). The user (or the AI, via plugin_save) authors manifests; the Mac
// executor scans the folder on startup + on every fs.watch burst and runs
// matching capabilities. See docs/plugins-authoring.md for the full schema
// and the eight-section authoring guide reachable via plugin_docs().
//
// Replaces docs/opencode-tools/ios-build.ts (BET-189/BET-190/BET-191): the
// queue speaks the GENERIC {capability, input, host} envelope; the ONLY
// plugin-specific bits here are the names "plugin.*" and host:"mac". The
// old `ios_build` tool is gone — install `plugin_run("ios-<app>", ...)`
// against an authored ios-capacitor manifest instead.

import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one
// tiny local file) so a token rotation never requires an opencode-serve
// restart. MANTA_BOX_TOKEN env overrides for tests/dev.
function boxToken(): string | null {
  const fromEnv = process.env.MANTA_BOX_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8");
    const tok = JSON.parse(raw)?.box_token;
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null;
  } catch {
    return null; // no store yet (auth disabled / first run) → send no header
  }
}

function authHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  const tok = boxToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  return headers;
}

const z = tool.schema;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${MANTA_SERVER}${path}`, {
    method,
    headers: authHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || `manta-server ${res.status}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type RegistryRow = {
  name: string;
  description: string;
  inputs: Array<{
    id: string;
    description?: string;
    type: "string" | "number" | "boolean" | "enum";
    default?: unknown;
    values?: unknown[];
    required?: boolean;
  }>;
  valid: boolean;
  error?: string;
  yaml: string;
  stepCount: number;
  timeoutMs: number | null;
};

function fetchRegistry(): Promise<RegistryRow[]> {
  return call("GET", "/api/plugins/registry").then((r) => r.rows ?? []);
}

function summarizeInputs(inputs: RegistryRow["inputs"]): string {
  if (!inputs || inputs.length === 0) return "(no inputs)";
  return inputs
    .map((i) => {
      const req = i.required ? " (required)" : "";
      const def = i.default !== undefined && i.default !== null ? ` [default: ${JSON.stringify(i.default)}]` : "";
      const vals = i.type === "enum" && Array.isArray(i.values) ? ` one of [${i.values.map((v) => JSON.stringify(v)).join(", ")}]` : "";
      return `${i.id}${req}: ${i.description || ""}${vals}${def}`.trim();
    })
    .join("; ");
}

function formatRow(row: RegistryRow): string {
  if (!row.valid) {
    return `• ${row.name} — INVALID: ${row.error ?? "unknown error"}`;
  }
  const timeout = row.timeoutMs ? `timeout ${Math.round(row.timeoutMs / 60_000)}m` : "no timeout";
  return `• ${row.name} — ${row.description || "(no description)"}\n    inputs: ${summarizeInputs(row.inputs)}\n    ${row.stepCount} step(s), ${timeout}`;
}

function knownNames(rows: RegistryRow[]): string {
  return rows.length === 0 ? "(none installed)" : rows.map((r) => r.name).sort().join(", ");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const plugin_list = tool({
  description: [
    "List the YAML plugins installed on the connected machine (from",
    "~/.manta/plugins/). Each entry shows the plugin name, description,",
    "inputs, and validity — INVALID plugins are listed too so you can see",
    "why they didn't load. Reach for this before plugin_run when you aren't",
    "sure which plugins exist; an empty registry usually means the machine",
    "is offline or has no plugins yet (call plugin_docs for the authoring",
    "guide).",
  ].join(" "),
  args: {},
  async execute() {
    const rows = await fetchRegistry();
    if (rows.length === 0) {
      return [
        "No plugins installed on the machine.",
        "The machine may be offline (no manifest scan has arrived) or may have no plugins under ~/.manta/plugins/.",
        "Call plugin_docs() for the full authoring guide — users can author a plugin by simply asking.",
      ].join("\n");
    }
    return ["Installed plugins:", ...rows.map(formatRow)].join("\n");
  },
});

export const plugin_get = tool({
  description: [
    "Return the current YAML source of a single installed plugin (looked up in",
    "the machine's plugin registry). Use to inspect a manifest before editing",
    "it or to share the current shape with the user. Unknown name → error",
    "listing every known plugin name so the model can self-correct.",
  ].join(" "),
  args: {
    name: z.string().describe("The plugin name (matches the filename without .yaml)."),
  },
  async execute(args) {
    const rows = await fetchRegistry();
    const row = rows.find((r) => r.name === args.name);
    if (!row) {
      throw new Error(`unknown plugin "${args.name}"; installed: ${knownNames(rows)}`);
    }
    const banner = row.valid
      ? `Plugin "${row.name}" — valid, ${row.stepCount} step(s).`
      : `Plugin "${row.name}" — INVALID: ${row.error ?? "unknown error"}.`;
    return `${banner}\n\n${row.yaml}`;
  },
});

export const plugin_save = tool({
  description: [
    "Write a plugin YAML manifest to ~/.manta/plugins/<name>.yaml on the",
    "machine. Returns the validation outcome synchronously when the executor",
    "is online (a bounded ≤15s poll catches the write — plugin.write is",
    "sub-second when the machine is awake). If validation fails, the verbatim",
    "errors come back so you can fix them; if the manifest is still queued",
    "after 15s the machine is offline and will apply when it reconnects. After",
    "a successful save the executor hot-reloads — no restart, no polling.",
  ].join(" "),
  args: {
    name: z
      .string()
      .describe(
        "Plugin name. Must match ^[a-z0-9][a-z0-9-]{0,63}$ and equal the YAML's top-level `name:` (which must equal the filename). The `plugin.` namespace is reserved for built-in capabilities and is impossible by the regex (no dots).",
      ),
    yaml: z
      .string()
      .describe(
        "Full plugin YAML source. See plugin_docs() for the schema and worked examples. The manifest is validated by the executor before it is written to disk — invalid manifests are rejected and the file is not touched.",
      ),
  },
  async execute(args, context) {
    const r = await call("POST", "/api/cap", {
      capability: "plugin.write",
      host: "mac",
      input: { name: args.name, yaml: args.yaml },
      sessionID: context.sessionID,
      directory: context.directory,
    });
    const id: string | undefined = r?.id;
    if (!id) {
      throw new Error("plugin.write: server did not return a job id");
    }
    // Bounded poll — plugin.write is sub-second when the machine is online.
    // Cap at 15s so an offline machine fails fast and we hand back a clear
    // "queued, will apply on reconnect" message instead of hanging.
    const started = Date.now();
    const TIMEOUT_MS = 15_000;
    const POLL_MS = 500;
    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const job = await call("GET", `/api/cap/${encodeURIComponent(id)}`);
      if (job.status === "done") {
        return `Plugin "${args.name}" saved and valid.`;
      }
      if (job.status === "failed") {
        const errors = (job.error ?? "unknown error").toString();
        throw new Error(`Plugin "${args.name}" rejected:\n${errors}`);
      }
    }
    return `Plugin "${args.name}" queued (job ${id}); the machine appears offline — it will apply when it reconnects.`;
  },
});

export const plugin_run = tool({
  description: [
    "Run an installed plugin by name on the connected machine. Inputs are",
    "validated against the manifest's `inputs:` schema before any step runs",
    "(unknown id, type mismatch, or enum value not in `values:` is rejected",
    "with a clear error). Returns a job id immediately. Do NOT poll in a",
    "loop: when the run finishes (or fails/times out), a completion message",
    "is injected into this session automatically as a new turn. Use",
    "plugin_status(id) only if the user asks for mid-run progress.",
  ].join(" "),
  args: {
    name: z
      .string()
      .describe("The plugin name to run. Must be installed and valid — see plugin_list."),
    inputs: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "Optional input object matching the plugin's `inputs:` schema. Each key is an input id; values are typed per the manifest (string/number/boolean/enum). Inputs with defaults can be omitted; required inputs without a default must be supplied.",
      ),
  },
  async execute(args, context) {
    // Fast client-side fail: unknown name OR invalid manifest → error
    // listing known names, without paying a queue round-trip. The queue
    // stays generic and is NOT taught about plugins.
    const rows = await fetchRegistry();
    const row = rows.find((r) => r.name === args.name);
    if (!row) {
      throw new Error(`unknown plugin "${args.name}"; installed: ${knownNames(rows)}`);
    }
    if (!row.valid) {
      throw new Error(`plugin "${args.name}" is invalid: ${row.error ?? "unknown error"}`);
    }
    const r = await call("POST", "/api/cap", {
      capability: args.name,
      host: "mac",
      input: args.inputs ?? {},
      sessionID: context.sessionID,
      directory: context.directory,
    });
    return `Plugin "${args.name}" queued on the machine (job ${r.id}). The completion turn will arrive automatically — do not poll.`;
  },
});

export const plugin_status = tool({
  description: [
    "Check a plugin job: status (queued/running/done/failed) + the tail of",
    "the run log. Use the job id returned by plugin_run or plugin_save.",
    "Prefer waiting for the automatic completion message; use this only for",
    "mid-run progress or after completion to inspect the log tail.",
  ].join(" "),
  args: { id: z.string().describe("The job id from plugin_run or plugin_save.") },
  async execute(args) {
    const j = await call("GET", `/api/cap/${encodeURIComponent(args.id)}`);
    const tail = (j.log?.join("") ?? "").split("\n").slice(-50).join("\n");
    const head =
      `Job ${j.id} (${j.capability}) — ${j.status}` +
      (j.error ? ` — ${j.error}` : "");
    return tail ? `${head}\n\n--- log tail ---\n${tail}` : head;
  },
});

export const plugin_docs = tool({
  description: [
    "Return the full MantaUI plugin authoring guide — schema reference, the",
    "three `if:` grammar forms, three worked examples (ios-capacitor,",
    "plain-xcode, generic script), the validator error catalogue, and the",
    "author/test loop. Reach for this whenever you are authoring or editing a",
    "plugin manifest, especially the first time.",
  ].join(" "),
  args: {},
  async execute() {
    const r = await call("GET", "/api/plugins/docs");
    return r.docs ?? "";
  },
});
