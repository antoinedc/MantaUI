// secretScan.mjs — the secret scanner every knowledge write passes through (spec §9.1).
//
// secretlint's recommended preset (shipped inside @secretlint/core 14 as
// `@secretlint/core/builtin` → `presetRecommend`) PLUS an exact-match check
// against the values in Manta's own secrets store. A hit redacts (notes) or
// drops the decision (store commits, managed blocks, PR text, commit messages).
//
// Fails CLOSED: when the scanner library cannot be loaded, `scan` reports
// `unavailable: true` and callers refuse to write.

import { loadSecrets } from "../secrets.mjs";

export const REDACTED = "[REDACTED]";
// Values shorter than this are never treated as secrets (a 4-char "true"
// password would redact half the language).
export const MIN_SECRET_LENGTH = 8;

async function defaultLoadLint() {
  const core = await import("@secretlint/core");
  const builtin = await import("@secretlint/core/builtin");
  return { lintSource: core.lintSource, preset: builtin.presetRecommend };
}

/** Default Manta secrets-store values (strings ≥ MIN_SECRET_LENGTH). */
export function defaultSecretValues() {
  try {
    return loadSecrets()
      .map((s) => s?.value)
      .filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH);
  } catch {
    return [];
  }
}

function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * deps: loadLint() → {lintSource, preset} (injectable), secretValues() → string[].
 * `scan(text)` → `{ clean, unavailable, hits: [{ source: "secretlint"|"store", ruleId?, range }] }`
 * `redact(text)` → `{ text, redacted, unavailable }`
 */
export function createSecretScanner({ loadLint = defaultLoadLint, secretValues = defaultSecretValues } = {}) {
  let lintP = null;
  const lint = () => {
    lintP ??= loadLint().catch((e) => {
      lintP = null;
      throw e;
    });
    return lintP;
  };

  async function scan(text) {
    const content = String(text ?? "");
    const hits = [];
    for (const v of secretValues()) {
      let from = 0;
      for (;;) {
        const i = content.indexOf(v, from);
        if (i < 0) break;
        hits.push({ source: "store", range: [i, i + v.length] });
        from = i + v.length;
      }
    }
    let unavailable = false;
    try {
      const { lintSource, preset } = await lint();
      const result = await lintSource({
        source: { content, filePath: "knowledge.md", contentType: "text" },
        options: { config: { rules: [{ id: preset.meta.id, rule: preset }] }, maskSecrets: false, noPhysicFilePath: true },
      });
      for (const m of result?.messages ?? []) {
        if (m.type === "message" && Array.isArray(m.range)) hits.push({ source: "secretlint", ruleId: m.ruleId, range: [m.range[0], m.range[1]] });
      }
    } catch (e) {
      console.warn("[knowledge] secret scanner unavailable:", e?.message ?? e);
      unavailable = true;
    }
    return { clean: hits.length === 0 && !unavailable, unavailable, hits };
  }

  async function redact(text) {
    const content = String(text ?? "");
    const r = await scan(content);
    const ranges = mergeRanges(r.hits.map((h) => h.range));
    let out = "";
    let pos = 0;
    for (const [s, e] of ranges) {
      out += content.slice(pos, s) + REDACTED;
      pos = e;
    }
    out += content.slice(pos);
    return { text: out, redacted: ranges.length, unavailable: r.unavailable };
  }

  return { scan, redact };
}
