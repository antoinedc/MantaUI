// subagentSync.mjs — pure logic backing the "auto-register every model as a
// subagent" feature (BET-123). Two functions:
//
//   deriveSubagentName  — turn a (providerID, modelID) pair into a short,
//                          stable, collision-free agent name.
//   reconcileSubagents  — diff the full model list against the configured
//                          agent blocks + the user's deactivated set, and
//                          return the { upsert, remove } ops to apply.
//
// Pure + framework-free (no fs, no fetch) so it's usable from both the
// server (src/server/providers.mjs, Node ESM) and tests. The I/O wrapper
// that reads/writes opencode.jsonc is syncSubagents() in providers.mjs.

import { describeModel, familyKey } from "./modelGuide.mjs";

// Lowercase, non-alphanumeric → "-", collapse repeats, trim leading/trailing
// "-". Fallback naming for models whose family isn't in the catalog.
function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Derive a short, stable, lowercase subagent name for a model. Prefers the
 * modelGuide catalog family key (e.g. "haiku", "gpt-4o") when it matches;
 * falls back to a slugified modelID (then providerID, then "model") when it
 * doesn't. Collisions against `taken` are resolved with a numeric suffix
 * (-2, -3, ...) so the result never overwrites another name in the set.
 *
 * Deterministic given the same inputs + `taken` contents — callers that want
 * stable output across repeated calls should add each returned name to
 * `taken` before deriving the next one (reconcileSubagents does this).
 *
 * @param {string} providerID
 * @param {string} modelID
 * @param {Set<string> | string[]} taken - already-used names (case-insensitive)
 * @returns {string}
 */
export function deriveSubagentName(providerID, modelID, taken) {
  const takenSet = new Set(
    [...(taken instanceof Set ? taken : (taken ?? []))].map((n) => String(n).toLowerCase()),
  );
  const base =
    familyKey(modelID) || slugify(modelID) || slugify(providerID) || "model";
  let name = base;
  let n = 2;
  while (takenSet.has(name.toLowerCase())) {
    name = `${base}-${n}`;
    n += 1;
  }
  return name;
}

// "providerID/modelID" — the identity string used across the deactivated
// set, config agent blocks (`model` field), and this module.
function modelKey(providerID, modelID) {
  return `${providerID}/${modelID}`;
}

/**
 * Diff the live model list against the currently configured subagent blocks
 * and the user's deactivated set. Pure — takes plain data, returns plain
 * data; the caller (providers.mjs:syncSubagents) does the actual config I/O.
 *
 * Rules (BET-123):
 *  - Every model NOT in `deactivated` gets an agent block. If one already
 *    exists for that model (matched by the `model` field), it is left
 *    untouched (preserves a user-edited name/description) — no upsert
 *    entry is produced for it.
 *  - Every model IN `deactivated` that currently HAS an agent block gets
 *    that block's name added to `remove`.
 *  - Blocks whose `model` doesn't match any known model are NEVER touched
 *    (a user's hand-made agent) — they're simply not iterated.
 *
 * @param {object} input
 * @param {Array<{providerID: string, id: string}>} [input.models]
 * @param {Array<{name: string, model: string, description: string}>} [input.existingAgents]
 * @param {string[]} [input.deactivated] - "providerID/modelID" strings
 * @returns {{
 *   upsert: Array<{name: string, model: string, description: string}>,
 *   remove: string[],
 * }}
 */
export function reconcileSubagents({ models = [], existingAgents = [], deactivated = [] } = {}) {
  const deactivatedSet = new Set(deactivated);
  const existingByModel = new Map();
  for (const agent of existingAgents) {
    if (!existingByModel.has(agent.model)) existingByModel.set(agent.model, agent);
  }
  const takenNames = new Set(existingAgents.map((a) => a.name.toLowerCase()));

  const upsert = [];
  for (const m of models) {
    const key = modelKey(m.providerID, m.id);
    if (deactivatedSet.has(key)) continue;
    if (existingByModel.has(key)) continue; // already registered — preserve as-is
    const name = deriveSubagentName(m.providerID, m.id, takenNames);
    takenNames.add(name.toLowerCase());
    const info = describeModel(m.providerID, m.id);
    const description = info ? `${info.blurb} Good for: ${info.goodFor.join(", ")}` : "";
    upsert.push({ name, model: key, description });
  }

  const remove = [];
  for (const key of deactivatedSet) {
    const existing = existingByModel.get(key);
    if (existing) remove.push(existing.name);
  }

  return { upsert, remove };
}
