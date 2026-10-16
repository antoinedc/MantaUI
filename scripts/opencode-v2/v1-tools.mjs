// Helpers for reading the V1 tool inventory (docs/opencode-tools/*.ts): the
// name set (parsed from source), and the real V1 tool objects (imported through
// the stubbed `@opencode-ai/plugin`).

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const V1_DIR = join(REPO_ROOT, "docs", "opencode-tools");
const STUB_URL = pathToFileURL(join(HERE, "v1-plugin-stub.mjs")).href;

/**
 * V1 tool name for an export in a tool file. opencode registers
 * `<file>_<export>`; the Manta tools are written so the model-facing name is the
 * export itself whenever the export already is the full name (it contains `_`,
 * e.g. `cto_fact`, `media_show`, `manta_compact_session`, or equals the file
 * stem, e.g. `notify`), otherwise `<file>_<export>` (`schedule.ts` `create` →
 * `schedule_create`). File stems drop `-` → `_`.
 */
export function v1ToolName(fileStem, exportName) {
  const stem = fileStem.replace(/-/g, "_");
  if (exportName === stem || exportName.includes("_")) return exportName;
  return `${stem}_${exportName}`;
}

/** Parse `export const X = tool(` from every V1 file → [{file, exportName, name}]. */
export async function parseV1Inventory() {
  const out = [];
  for (const f of (await readdir(V1_DIR)).filter((x) => x.endsWith(".ts")).sort()) {
    if (f === "manta-auth.ts") continue;
    const src = await readFile(join(V1_DIR, f), "utf8");
    const stem = basename(f, ".ts");
    for (const m of src.matchAll(/^export const (\w+) = tool\(/gm)) {
      out.push({ file: f, exportName: m[1], name: v1ToolName(stem, m[1]) });
    }
  }
  return out;
}

/**
 * Import the V1 tools for real. Returns `{ tools: { [name]: v1ToolObject },
 * cleanup }`. `MANTA_SERVER_URL` must be set by the caller BEFORE this runs
 * (V1 reads it at import).
 */
export async function loadV1Tools() {
  const inventory = await parseV1Inventory();
  const { dir, cleanup } = await transpileTree(V1_DIR, {
    rewrite: (code) => code.replace(/from\s+"@opencode-ai\/plugin"/g, `from "${STUB_URL}"`),
  });
  const tools = {};
  const files = [...new Set(inventory.map((i) => i.file))];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f.replace(/\.ts$/, ".mjs"))).href);
    for (const item of inventory.filter((i) => i.file === f)) tools[item.name] = mod[item.exportName];
  }
  return { tools, inventory, cleanup };
}
