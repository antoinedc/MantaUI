// plugins.mjs — the server-side plugin registry.
//
// The Mac executor (src/main/capExecutor.ts) PUTs every plugin manifest it
// finds under ~/.manta/plugins/ here on (re)connect + on every fs.watch
// burst. The renderer reads the same registry via GET to render the
// installed-plugins list in Settings → Plugins. Lives entirely in-memory
// — a restart loses the registry, but the executor republishes on its
// next SSE (re)connect, which covers the gap (no durable state needed).
//
// Each entry is the row the executor PUTs verbatim — `{name, description,
// inputs, valid, error?, yaml, stepCount, timeoutMs}` — so a renderer
// round-trip doesn't need any extra transformation. Invalid manifests
// (parse errors, bad filename) are accepted and surfaced to the UI so
// users can SEE why their YAML didn't load.

import { randomUUID } from "node:crypto";

// Module-level registry. `Map` keyed by plugin name (matches manifest
// `name`, which the executor enforces == filename stem).
const registry = new Map();

// ---------------------------------------------------------------------------
// Validation — shape only. Full content validation happens on the Mac
// executor side (parseManifest); the server accepts what it's told and
// exposes it verbatim. This is intentional: the executor is the source
// of truth for what's installed.
// ---------------------------------------------------------------------------

function isValidRow(row) {
  if (row == null || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.name !== "string" || !row.name) return false;
  if (typeof row.description !== "string") return false;
  if (!Array.isArray(row.inputs)) return false;
  if (typeof row.valid !== "boolean") return false;
  if (typeof row.yaml !== "string") return false;
  if (typeof row.stepCount !== "number") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replace the entire registry atomically. Returns the new size. Logs
 * invalid entries but accepts the request (per BET-190 spec). The PUT
 * request returns 200 even if some rows are rejected — a one-bad-row
 * publisher would otherwise 500 the whole sync.
 */
export function putRegistry(rows, deps = {}) {
  const log = deps.log ?? console.warn.bind(console);
  const next = new Map();
  let invalid = 0;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!isValidRow(row)) {
        invalid++;
        continue;
      }
      next.set(row.name, row);
    }
  }
  // Atomic swap — readers always see a consistent snapshot.
  registry.clear();
  for (const [k, v] of next) registry.set(k, v);
  if (invalid > 0) {
    log(`[plugins] PUT /api/plugins/registry: dropped ${invalid} invalid row(s)`);
  }
  return registry.size;
}

/**
 * Snapshot the current registry as a plain array (sorted by name for
 * stable UI rendering).
 */
export function getRegistry() {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * For tests / unit hooks — clear the registry.
 */
export function _resetForTests() {
  registry.clear();
}

/**
 * RFC4122-ish id for the occasional log line (kept here so callers don't
 * pull in node:crypto themselves).
 */
export function _requestId() {
  return randomUUID();
}
