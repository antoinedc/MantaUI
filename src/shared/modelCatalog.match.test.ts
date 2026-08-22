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
    // Dated aliases of an existing model and over-collapse guard siblings are
    // not independent model identities — skip them as alias sources (their
    // behaviour is pinned by the targeted 6.3 rows / guard block instead).
    if (e.synthesize === false) continue;
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

    // Drop the size token — only where a SINGLE size token can be dropped
    // (that still leaves a unique identifier for a family of one). A model
    // whose id carries two size tokens (e.g. `-550b-a55b`) is skipped: dropping
    // just one is not a legal "drop the size" and must not masquerade as one.
    // For a multi-member family a size-less bare name is a bare family name and
    // must remain ambiguous, not be forced to one sibling.
    if (sizeSuffix && (counts.get(e.family ?? "?") ?? 0) === 1 && !SIZE_RE.test(bareNoSize)) {
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

// A reseller alias for a model would, in production, carry that model's OWN
// declared facts (context / output / input modalities) on the endpoint — the
// mechanism is fed exactly those by `routingServices` and `modelIdentity`.
// Pass the source entry's own facts when scoring the corpus so layer-4
// corroboration runs as it would against a live provider: this is what lets a
// decorated alias of a multi-candidate family resolve uniquely to its source.
function factsFrom(e: ModelCatalogEntry) {
  return {
    modalities: Array.isArray(e?.modalities?.input) ? e.modalities.input : undefined,
    context: e?.limit?.context,
    output: e?.limit?.output,
  };
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
      // The reseller id would carry the model's own endpoint facts; pass them
      // so corroboration is exercised exactly as on the box.
      const res = matcher.matchModel(variant, factsFrom(source));
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
  // Date-bearing opaque aliases (6.2): a date is a weaker anchor than a
  // version/size, so a generic soft-only id carrying just a date must NOT
  // colour-match a real entry (regression locked for `chat-2407`).
  const datedOpaque = ["chat-2407", "base-2507", "default-20251101", "standard-0731", "big-pickle-2407"];
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
    for (const id of [...opaque, ...datedOpaque, ...crossFamily]) {
      const res = matcher.matchModel(id);
      expect(res.kind, `${id} must not match, got ${res.kind} ${res.candidates.map((c) => c.id).join(",")}`).toBe("none");
    }
  });
});

describe("BET-1303 matcher — regression ids from real boxes (6.3)", () => {
  const matcher = createModelIndex(FIXTURE);

  // The real observed ids from the issue. Positive rows carry the endpoint's
  // own facts (a decorated alias has its model's context/output/modalities in
  // production) so layer-3/4 corroboration runs. `negate` rows assert the id
  // never resolves to the wrong sibling. `none`/`ambiguous` rows check the
  // honest outcomes. Every target below exists in the shipped fixture.
  const rows: Array<{ local: string; target?: string; negate?: string; none?: boolean; ambiguous?: boolean }> = [
    { local: "Qwen/Qwen3-32B-TEE", target: "alibaba/qwen3-32b" },                 // weights repo; vendor names disagree
    { local: "zai-org/GLM-5.2-TEE", target: "zhipuai/glm-5.2" },                  // weights repo; vendor names disagree
    { local: "moonshotai/Kimi-K3-TEE", target: "moonshotai/kimi-k3" },            // weights repo
    { local: "gpt-5.5-fast", target: "openai/gpt-5.5", negate: "openai/gpt-5.5-pro" }, // tier decoration + corroboration
    { local: "claude-opus-5-fast", target: "anthropic/claude-opus-5", negate: "anthropic/claude-opus-4-5" }, // version equality
    { local: "nemotron-3-ultra-free", target: "nvidia/nemotron-3-ultra-550b-a55b" }, // size present on one side only
    { local: "muse-spark-1.2-contributor-free", target: "meta/muse-spark-1.2" },  // multi-token decoration
    { local: "mistral-nemo-instruct-2407-tee", target: "mistral/mistral-nemo" },  // date + decoration; owner mismatch
    { local: "qwen3-32b", target: "alibaba/qwen3-32b", negate: "alibaba/qwen3-30b-a3b" }, // size inequality
    { local: "glm-5.1", target: "zhipuai/glm-5.1", negate: "zhipuai/glm-5.2" },   // version inequality
    { local: "big-pickle", none: true },
    { local: "default", none: true },
    { local: "ornith", ambiguous: true },
    // BET-1307 — a model and its own dated alias must collapse to ONE entry
    // (these rows were silently dropped from §6.3 while the ornith row stayed,
    // so the suite was green while the defect lived).
    { local: "claude-opus-4-5", target: "anthropic/claude-opus-4-5", negate: "anthropic/claude-opus-4-5-20251101" },
    { local: "claude-sonnet-4-5", target: "anthropic/claude-sonnet-4-5", negate: "anthropic/claude-sonnet-4-5-20250929" },
    { local: "claude-haiku-4-5", target: "anthropic/claude-haiku-4-5", negate: "anthropic/claude-haiku-4-5-20251001" },
    // Over-collapse guards — distinct products must NOT merge.
    { local: "glm-5", target: "zhipuai/glm-5", negate: "zhipuai/glm-5-turbo" },
    { local: "glm-5-turbo", target: "zhipuai/glm-5-turbo", negate: "zhipuai/glm-5" },
    { local: "kimi-k2.7-code", target: "moonshotai/kimi-k2.7-code", negate: "moonshotai/kimi-k2.7-code-highspeed" },
    { local: "kimi-k2.7-code-highspeed", target: "moonshotai/kimi-k2.7-code-highspeed", negate: "moonshotai/kimi-k2.7-code" },
  ];

  it("every real-id row resolves exactly as the table demands", () => {
    for (const row of rows) {
      if (row.none) {
        expect(matcher.matchModel(row.local).kind, row.local).toBe("none");
        continue;
      }
      if (row.ambiguous) {
        const res = matcher.matchModel(row.local);
        expect(res.kind, row.local).toBe("ambiguous");
        runnableOrnithSizes(res.candidates);
        continue;
      }
      const target = row.target ? matcher.lookupModel(row.target) : null;
      const res = matcher.matchModel(row.local, target ? factsFrom(target) : undefined);
      if (row.target) {
        // eslint-disable-next-line no-console
        console.log(`[BET-1303] 6.3 ${row.local} → ${res.kind} (${res.evidence ?? ""})`);
        expect(res.kind, `${row.local} → ${res.candidates.map((c) => c.id).join(",")}`).toBe("exact");
        expect(res.candidates[0]?.id, row.local).toBe(row.target);
      }
      if (row.negate) {
        const ids = res.candidates.map((c) => c.id);
        expect(ids, `${row.local} must not resolve to ${row.negate}`).not.toContain(row.negate);
      }
    }
  });
});

// Assert an ambiguous result surfaces every sibling size of the family.
function runnableOrnithSizes(candidates: ModelCatalogEntry[]): void {
  const ids = candidates.map((c) => c.id).sort();
  const ornith = FIXTURE.filter((e) => e.family === "ornith").map((e) => e.id).sort();
  expect(ids).toEqual(ornith);
}

describe("BET-1307 over-collapse guards — distinct products sharing a handle never merge", () => {
  const matcher = createModelIndex(FIXTURE);

  it("collapseAliases never merges distinct family members with different soft tokens", () => {
    // The family handle "glm" addresses ALL glm entries; collapse must keep
    // each structurally-distinct product separate (glm-5-turbo's `turbo` is an
    // extra soft token, so it is its own class, never the base).
    const glmIds = toSortedIds(FIXTURE.filter((e) => e.family === "glm"));
    const glm = matcher.matchModel("glm");
    expect(glm.kind).toBe("ambiguous");
    expect(toSortedIds(glm.candidates)).toEqual(glmIds);

    // Same for kimi — the highspeed sibling is distinct from the base code model.
    const kimiIds = toSortedIds(FIXTURE.filter((e) => e.family === "kimi"));
    const kimi = matcher.matchModel("kimi");
    expect(kimi.kind).toBe("ambiguous");
    expect(toSortedIds(kimi.candidates)).toEqual(kimiIds);
  });
});

// Extract the ids of an entry list as stable sorted ids.
function toSortedIds(entries: ModelCatalogEntry[]): string[] {
  return entries.map((e) => e.id).filter((id): id is string => typeof id === "string").sort();
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
