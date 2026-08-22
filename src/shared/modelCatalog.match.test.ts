// modelCatalog.match.test.ts — the generalisation gate for the layered matcher
// (BET-1303 §6). PURE + OFFLINE: it builds a synthesised corpus FROM the
// shipped catalogue and requires the matcher to resolve every variant back to
// its source entry (100% precision, ≥90% coverage), to reject a negative corpus
// entirely, to satisfy a table of real observed ids, and never to leak a
// vendor/model name into the matcher source.
//
// The test-only generator below is NOT a list the matcher may consult — it is
// how we red-team the mechanism with reseller-style aliases a future box will
// actually see.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createModelIndex, type ModelCatalogEntry } from "./modelCatalog.mjs";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../server/fixtures/modelCatalog.fixture.json", import.meta.url), "utf-8"),
) as ModelCatalogEntry[];

type Entry = ModelCatalogEntry & { id: string };

// Decorative suffixes — deliberately including inventions (`-xyz`, `-priority`)
// to prove that NOTHING is hardcoded: a new reseller's suffix must work with no
// code change. A vendor/model name never appears here because these are not
// names — they are the noise class the token classifier must structurally strip.
const DECORATIONS = ["tee", "fast", "free", "turbo", "hd", "priority", "xyz"];

// Date-like tails — bare digits of length 4 / 6 / 8 that the classifier
// discards entirely.
const DATES = ["2507", "0731", "20251101"];

// A size token is a trailing `-<digits>[bmk]` (e.g. `-27b`). The generator uses
// this only to decide when "drop the size" is a legal transform; the matcher
// itself never sees this regex.
const SIZE_RE = /-a?\d+(?:\.\d+)?[bmk]$/i;

// The count of fixture entries per family — used to refuse to emit a "drop the
// size" variant for a family with several siblings (dropping the size there
// would yield a bare family name, which must stay honestly ambiguous).
function familyCounts(entries: Entry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    const f = typeof e.family === "string" && e.family !== "" ? e.family : "?";
    m.set(f, (m.get(f) ?? 0) + 1);
  }
  return m;
}

// A digit token (version or size), per the matcher's classification scope. The
// generator needs to know whether an entry carries any digit identity — layer
// 4 is digit-anchored, so a reseller-style alias can only be pinned
// structurally when the entry has a version or size token to anchor on. An
// entry with no digits (e.g. a plain chat model) has no such anchor and only
// resolves through its layer-2 handle; we still generate some variants for it,
// but only handle-resolvable ones.
export function hasDigitIdentity(bare: string): boolean {
  return /[0-9]/.test(bare);
}

// Build the synthesised corpus. Each generated id is labelled with the entry it
// came from, and every one is expected to resolve EXACTLY to that entry.
function generateCorpus(entries: Entry[]): Array<{ variant: string; source: Entry }> {
  const counts = familyCounts(entries);
  const out: Array<{ variant: string; source: Entry }> = [];
  const otherVendors = ["acme", "reseller"];

  for (const e of entries) {
    const id = e.id;
    const owner = id.includes("/") ? id.split("/")[0] : id;
    const bare = id.includes("/") ? id.split("/").pop() as string : id;
    const sizeMatch = SIZE_RE.exec(bare);
    const sizeSuffix = sizeMatch ? sizeMatch[0] : "";
    const bareNoSize = sizeSuffix ? bare.slice(0, -sizeSuffix.length) : bare;

    if (!hasDigitIdentity(bare)) {
      // A digit-less entry (e.g. a plain chat model) cannot be pinned by the
      // digit-anchored layer 4; generate only the variants that resolve through
      // its layer-2 handle (the bare id, its full id, and case/separator
      // renderings of them).
      out.push({ variant: `${owner}/${bare}`, source: e });
      out.push({ variant: bare, source: e });
      out.push({ variant: mixedCase(bare), source: e });
      out.push({ variant: `${bare.toUpperCase()}`, source: e });
      continue;
    }

    // A vendor segment that disagrees with the entry's own (the interesting
    // case — no alias table exists to reconcile it).
    for (const ov of otherVendors) {
      out.push({ variant: `${ov}/${bare}`, source: e });
      out.push({ variant: `${ov}/${bare}-${DECORATIONS[0]}`, source: e });
      out.push({ variant: `${ov}/${bare}-${DECORATIONS[3]}`, source: e });
    }

    // The entry's own vendor prefix + a decorative suffix.
    out.push({ variant: `${owner}/${bare}-${DECORATIONS[1]}`, source: e });

    // Single decorative suffix (each of a few).
    for (const d of [DECORATIONS[0], DECORATIONS[2], DECORATIONS[6]]) {
      out.push({ variant: `${bare}-${d}`, source: e });
    }

    // Two decorative suffixes.
    out.push({ variant: `${bare}-${DECORATIONS[0]}-${DECORATIONS[1]}`, source: e });
    out.push({ variant: `${bare}-${DECORATIONS[4]}-${DECORATIONS[5]}`, source: e });

    // A date-like tail, alone and combined with a decoration.
    out.push({ variant: `${bare}-${DATES[0]}`, source: e });
    out.push({ variant: `${bare}-${DECORATIONS[0]}-${DATES[2]}`, source: e });

    // Upper and mixed case renderings.
    out.push({ variant: `${bare.toUpperCase()}-${DECORATIONS[4].toUpperCase()}`, source: e });
    out.push({ variant: mixedCase(`${bare}-${DECORATIONS[0]}`), source: e });

    // Drop the size token — only where that still leaves a unique identifier
    // (a family of one). For a multi-member family a size-less bare name is a
    // bare family name and must remain ambiguous, not be forced to one sibling.
    if (sizeSuffix && (counts.get(e.family ?? "?") ?? 0) === 1) {
      for (const d of [DECORATIONS[0], DECORATIONS[1]]) {
        out.push({ variant: `${bareNoSize}-${d}`, source: e });
      }
    }
  }
  return out;
}

function mixedCase(s: string): string {
  return s
    .split("")
    .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
    .join("");
}

describe("BET-1303 matcher — synthesised corpus (6.1)", () => {
  const entries = FIXTURE as Entry[];
  const matcher = createModelIndex(entries);
  const corpus = generateCorpus(entries);

  it("composes a non-trivial corpus from the shipped catalogue", () => {
    expect(corpus.length).toBeGreaterThan(10);
    expect(entries.length).toBeGreaterThan(3);
  });

  it("100% precision and ≥90% coverage over the generated reseller aliases", () => {
    let exact = 0;
    let resolved = 0;
    let resolvedWrong = 0;
    const failures: string[] = [];

    for (const { variant, source } of corpus) {
      const res = matcher.matchModel(variant);
      if (res.kind === "none") {
        failures.push(`${variant} → none (expected exact ${source.id})`);
        continue;
      }
      resolved += 1;
      if (res.kind === "exact" && res.candidates[0]?.id === source.id) {
        exact += 1;
      } else {
        resolvedWrong += 1;
        failures.push(`${variant} → ${res.kind} ${res.candidates.map((c) => c.id).join(",")} (source ${source.id})`);
      }
    }

    const precision = resolved === 0 ? 0 : (resolved - resolvedWrong) / resolved;
    const coverage = exact / corpus.length;

    // Surface the gate numbers for the PR body even when the assertion passes.
    // eslint-disable-next-line no-console
    console.log(
      `[BET-1303] corpus: total=${corpus.length} exact=${exact} precision=${(precision * 100).toFixed(1)}% coverage=${(coverage * 100).toFixed(1)}%`,
    );

    expect(precision, `precision ${precision} — failures:\n${failures.join("\n")}`).toBe(1);
    expect(coverage, `coverage ${coverage}`).toBeGreaterThanOrEqual(0.9);
  });
});

describe("BET-1303 matcher — negative corpus (6.2)", () => {
  const matcher = createModelIndex(FIXTURE);

  // Opaque aliases with no content, plus ids absent from the catalogue.
  const opaque = ["default", "standard", "chat", "base", "big-pickle", "zzzz", "xq9f", "abc1234"];
  // Cross-family shuffles: one entry's soft tokens combined with another
  // entry's version/size. These look plausible and must NOT match.
  const crossFamily = [
    "ornith-3.6-27b", // ornith soft + qwen version/size
    "qwen-9b",        // qwen soft + ornith size
    "minimax-9b",     // minimax soft + ornith size
    "deepseek-3.6",   // deepseek soft + qwen version
    "ornith-m3",      // ornith soft + minimax version
    "qwen-397b-31b",  // qwen soft + ornith sizes
  ];

  it("returns none for every negative id (zero matches)", () => {
    for (const id of [...opaque, ...crossFamily]) {
      const res = matcher.matchModel(id);
      expect(res.kind, `${id} must not match, got ${res.kind} ${res.candidates.map((c) => c.id).join(",")}`).toBe("none");
    }
  });
});

describe("BET-1303 matcher — regression ids from real boxes (6.3)", () => {
  const matcher = createModelIndex(FIXTURE);

  // Rows whose target entry is absent from the shipped catalogue are skipped
  // (a catalogue refresh must not turn this suite red) — see the note in the
  // issue body. Only the rows whose targets exist (or the pure-negative rows)
  // run here.
  const rows: Array<{ local: string; target?: string; negate?: string; none?: boolean; ambiguous?: boolean }> = [
    { local: "Qwen/Qwen3-32B-TEE", target: "alibaba/qwen3-32b" },
    { local: "zai-org/GLM-5.2-TEE", target: "zhipuai/glm-5.2" },
    { local: "moonshotai/Kimi-K3-TEE", target: "moonshotai/kimi-k3" },
    { local: "gpt-5.5-fast", target: "gpt-5.5" },
    { local: "claude-opus-5-fast", target: "claude-opus-5" },
    { local: "nemotron-3-ultra-free", target: "nvidia/nemotron-3-ultra-550b-a55b" },
    { local: "muse-spark-1.2-contributor-free", target: "meta/muse-spark-1.2" },
    { local: "mistral-nemo-instruct-2407-tee", target: "mistral/mistral-nemo" },
    { local: "qwen3-32b", negate: "qwen3-30b-a3b" },
    { local: "glm-5.1", negate: "glm-5.2" },
    { local: "big-pickle", none: true },
    { local: "default", none: true },
    { local: "ornith", ambiguous: true },
  ];

  it("satisfies every row whose target exists in the shipped catalogue", () => {
    let ran = 0;
    for (const row of rows) {
      const res = matcher.matchModel(row.local);
      if (row.none) {
        expect(res.kind, `${row.local}`).toBe("none");
        ran += 1;
        continue;
      }
      if (row.ambiguous) {
        expect(res.kind, `${row.local}`).toBe("ambiguous");
        runnableOrnithSizes(res.candidates);
        ran += 1;
        continue;
      }
      if (row.negate) {
        // A "must never resolve to <wrong>" row always runs: the target may be
        // absent, but the id must still never confuse a wrong sibling.
        const ids = res.candidates.map((c) => c.id);
        expect(ids, `${row.local} must not resolve to ${row.negate}`).not.toContain(row.negate);
        ran += 1;
        continue;
      }
      // Positive row: skip when its target entry is absent from the catalogue.
      const target = row.target ? matcher.lookupModel(row.target) : null;
      if (!target) continue;
      expect(res.kind, `${row.local}`).toBe("exact");
      expect(res.candidates[0]?.id, `${row.local}`).toBe(target.id);
      ran += 1;
    }
    // In this repo's trimmed fixture only the negatives + ornith ambiguity exist
    // (the real ids need a full catalogue), but the harness must still have run.
    expect(ran).toBeGreaterThan(0);
  });
});

// Assert an ambiguous result surfaces every sibling size of the family.
function runnableOrnithSizes(candidates: ModelCatalogEntry[]): void {
  const ids = candidates.map((c) => c.id).sort();
  const ornith = FIXTURE.filter((e) => e.family === "ornith").map((e) => e.id).sort();
  expect(ids).toEqual(ornith);
}

describe("BET-1303 matcher — source gate (6.4)", () => {
  it("the matcher source contains none of the vendor/model-name vocabulary", () => {
    const src = readFileSync(new URL("./modelCatalog.mjs", import.meta.url), "utf-8").toLowerCase();
    const banned = [
      "anthropic", "openai", "qwen", "alibaba", "glm", "zhipuai", "zai",
      "deepseek", "moonshotai", "kimi", "mistral", "nemotron", "gemma",
      "claude", "gpt", "tee", "fast", "free", "turbo",
    ];
    const leaked = banned.filter((t) => src.includes(t));
    expect(leaked, `matcher source mentions forbidden vocabulary: ${leaked.join(", ")}`).toEqual([]);
  });
});
