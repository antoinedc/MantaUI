// V2 twin of docs/opencode-tools/plugins.ts → plugin_list / plugin_get /
// plugin_save / plugin_run / plugin_status / plugin_docs. (These are MantaUI
// YAML "plugins" on the connected desktop — unrelated to this V2 plugin.)
// Thin registrars over manta-server's job queue (/api/cap) and registry.

import { call } from "../lib/server.ts";
import { input, noInput, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

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
      const def =
        i.default !== undefined && i.default !== null
          ? ` [default: ${JSON.stringify(i.default)}]`
          : "";
      const vals =
        i.type === "enum" && Array.isArray(i.values)
          ? ` one of [${i.values.map((v) => JSON.stringify(v)).join(", ")}]`
          : "";
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

export const tools: ToolDef[] = [
  {
    name: "plugin_list",
    description: [
      "List the YAML plugins installed on the connected machine (from",
      "~/.manta/plugins/). Each entry shows the plugin name, description,",
      "inputs, and validity — INVALID plugins are listed too so you can see",
      "why they didn't load. Reach for this before plugin_run when you aren't",
      "sure which plugins exist; an empty registry usually means the machine",
      "is offline or has no plugins yet (call plugin_docs for the authoring",
      "guide).",
    ].join(" "),
    input: noInput(),
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
  },
  {
    name: "plugin_get",
    description: [
      "Return the current YAML source of a single installed plugin (looked up in",
      "the machine's plugin registry). Use to inspect a manifest before editing",
      "it or to share the current shape with the user. Unknown name → error",
      "listing every known plugin name so the model can self-correct.",
    ].join(" "),
    input: input({ name: str("The plugin name (matches the filename without .yaml).") }),
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
  },
  {
    name: "plugin_save",
    description: [
      "Write a plugin YAML manifest to ~/.manta/plugins/<name>.yaml on the",
      "machine. Returns the validation outcome synchronously when the executor",
      "is online (a bounded ≤15s poll catches the write — plugin.write is",
      "sub-second when the machine is awake). If validation fails, the verbatim",
      "errors come back so you can fix them; if the manifest is still queued",
      "after 15s the machine is offline and will apply when it reconnects. After",
      "a successful save the executor hot-reloads — no restart, no polling.",
    ].join(" "),
    input: input({
      name: str(
        "Plugin name. Must match ^[a-z0-9][a-z0-9-]{0,63}$ and equal the YAML's top-level `name:` (which must equal the filename). The `plugin.` namespace is reserved for built-in capabilities and is impossible by the regex (no dots).",
      ),
      yaml: str(
        "Full plugin YAML source. See plugin_docs() for the schema and worked examples. The manifest is validated by the executor before it is written to disk — invalid manifests are rejected and the file is not touched.",
      ),
    }),
    async execute(args, context) {
      const r = await call("POST", "/api/cap", {
        capability: "plugin.write",
        host: "desktop",
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
  },
  {
    name: "plugin_run",
    description: [
      "Run an installed plugin by name on the connected machine. Inputs are",
      "validated against the manifest's `inputs:` schema before any step runs",
      "(unknown id, type mismatch, or enum value not in `values:` is rejected",
      "with a clear error). Returns a job id immediately. Do NOT poll in a",
      "loop: when the run finishes (or fails/times out), a completion message",
      "is injected into this session automatically as a new turn. Use",
      "plugin_status(id) only if the user asks for mid-run progress.",
    ].join(" "),
    input: input(
      {
        name: str("The plugin name to run. Must be installed and valid — see plugin_list."),
        inputs: {
          // z.record(z.string(), z.any()) — a free-form object.
          type: "object",
          additionalProperties: {},
          description:
            "Optional input object matching the plugin's `inputs:` schema. Each key is an input id; values are typed per the manifest (string/number/boolean/enum). Inputs with defaults can be omitted; required inputs without a default must be supplied.",
        },
      },
      ["inputs"],
    ),
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
        host: "desktop",
        input: args.inputs ?? {},
        sessionID: context.sessionID,
        directory: context.directory,
      });
      return `Plugin "${args.name}" queued on the machine (job ${r.id}). The completion turn will arrive automatically — do not poll.`;
    },
  },
  {
    name: "plugin_status",
    description: [
      "Check a plugin job: status (queued/running/done/failed) + the tail of",
      "the run log. Use the job id returned by plugin_run or plugin_save.",
      "Prefer waiting for the automatic completion message; use this only for",
      "mid-run progress or after completion to inspect the log tail.",
    ].join(" "),
    input: input({ id: str("The job id from plugin_run or plugin_save.") }),
    async execute(args) {
      const j = await call("GET", `/api/cap/${encodeURIComponent(args.id)}`);
      const tail = (j.log?.join("") ?? "").split("\n").slice(-50).join("\n");
      const head = `Job ${j.id} (${j.capability}) — ${j.status}` + (j.error ? ` — ${j.error}` : "");
      return tail ? `${head}\n\n--- log tail ---\n${tail}` : head;
    },
  },
  {
    name: "plugin_docs",
    description: [
      "Return the full MantaUI plugin authoring guide — schema reference, the",
      "three `if:` grammar forms, three worked examples (ios-capacitor,",
      "plain-xcode, generic script), the validator error catalogue, and the",
      "author/test loop. Reach for this whenever you are authoring or editing a",
      "plugin manifest, especially the first time.",
    ].join(" "),
    input: noInput(),
    async execute() {
      const r = await call("GET", "/api/plugins/docs");
      return r.docs ?? "";
    },
  },
];
