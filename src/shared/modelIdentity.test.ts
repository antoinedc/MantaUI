import { describe, it, expect } from "vitest";
import { resolveIdentity } from "./modelIdentity.mjs";
import type { ModelCatalog } from "./modelIdentity.mjs";

// A minimal catalogue matcher mirroring the box-side model catalogue's
// semantics (normalise + family-grouped handles → exact/ambiguous/none). The
// real matching logic is covered by its own suite; here we need a faithful
// injected stand-in for the three real cases the issue drives from.
function normalize(modelsId: string): string {
  return String(modelsId)
    .toLowerCase()
    .replace(/[\s_./]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function index(entries: any[]): ModelCatalog {
  const byHandle = new Map<string, any[]>();
  const add = (keys: Set<string>, v: unknown) => {
    if (typeof v === "string" && v !== "") keys.add(normalize(v));
  };
  const handles = (e: any) => {
    const keys = new Set<string>();
    add(keys, e?.id);
    if (typeof e?.id === "string") add(keys, String(e.id).split("/").pop());
    add(keys, e?.name);
    add(keys, e?.family);
    return keys;
  };
  for (const e of entries) {
    for (const k of handles(e)) {
      if (!byHandle.has(k)) byHandle.set(k, []);
      byHandle.get(k)!.push(e);
    }
  }
  return {
    lookupModel(id: string) {
      const n = normalize(id);
      return entries.find((e) => typeof e?.id === "string" && normalize(e.id) === n) ?? null;
    },
    matchModel(localId: string) {
      const raw = byHandle.get(normalize(localId)) ?? [];
      const candidates = [...new Set(raw)];
      if (candidates.length === 0) return { kind: "none", candidates: [] };
      if (candidates.length === 1) return { kind: "exact", candidates };
      return { kind: "ambiguous", candidates };
    },
  };
}

// Trimmed catalogue fixture — the three real cases from the issue.
const QWEN = {
  id: "qwen/qwen3.6-27b",
  name: "Qwen3.6-27B",
  family: "qwen",
  reasoning: true,
  tool_call: true,
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 131072, output: 8192 },
  benchmarks: [{ name: "SWE-Bench Verified", score: 58.4, metric: "resolved" }],
};

const ORNITH_SIZES = [
  { id: "chutes/Ornith-9B", name: "Ornith 9B", family: "ornith", limit: { context: 32768, output: 4096 } },
  { id: "chutes/Ornith-31B", name: "Ornith 31B", family: "ornith", limit: { context: 65536, output: 8192 } },
  { id: "chutes/Ornith-35B", name: "Ornith 35B", family: "ornith", limit: { context: 65536, output: 8192 } },
  { id: "chutes/Ornith-397B", name: "Ornith 397B", family: "ornith", limit: { context: 262144, output: 32768 } },
];

// A catalogue whose qwen entry reports a 1M context (for the credibility test
// where the provider's smaller-but-plausible 262144 is a real endpoint fact).
const CATALOG = index([
  QWEN,
  { ...QWEN, id: "qwen/qwen-1m", name: "Qwen-1M", family: "qwen", limit: { context: 1048576, output: 8192 } },
  ...ORNITH_SIZES,
]);

describe("resolveIdentity — the three real cases", () => {
  it("qwen3.6-27b resolves exactly; effective context comes from the catalogue", () => {
    // The provider reports a context limit of 0 — a claim, and a false one.
    const model = { providerID: "chutes", id: "qwen3.6-27b", family: "", limit: { context: 0 }, cost: { input: 0, output: 0 } };
    const r = resolveIdentity(model, null, CATALOG);
    expect(r.state).toBe("resolved");
    expect(r.source).toBe("matched");
    expect(r.catalogId).toBe("qwen/qwen3.6-27b");
    expect(r.candidates).toEqual([]);
    // 0 is absent, not zero → the catalogue's real 131072 stands.
    expect(r.effective.limit!.context).toBe(131072);
    expect(r.effective.family).toBe("qwen");
    expect(r.effective.capabilities!.reasoning).toBe(true);
  });

  it("ornith is ambiguous — all four same-family sizes, no guessing", () => {
    const model = { providerID: "chutes", id: "ornith", family: "ornith", limit: { context: 0 } };
    const r = resolveIdentity(model, null, CATALOG);
    expect(r.state).toBe("ambiguous");
    expect(r.catalogId).toBeNull();
    expect(r.candidates.sort()).toEqual(
      ["chutes/Ornith-9B", "chutes/Ornith-31B", "chutes/Ornith-35B", "chutes/Ornith-397B"].sort(),
    );
    expect(r.source).toBeNull();
  });

  it("default is unknown — supported, never chosen automatically", () => {
    const model = { providerID: "chutes", id: "default", family: "", limit: { context: 0 }, cost: { input: 0, output: 0 } };
    const r = resolveIdentity(model, null, CATALOG);
    expect(r.state).toBe("unknown");
    expect(r.catalogId).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.source).toBeNull();
  });
});

describe("resolveIdentity — declared identity", () => {
  it("declared.catalogId overrides an exact match", () => {
    // qwen3.6-27b would otherwise resolve exactly.
    const model = { providerID: "chutes", id: "qwen3.6-27b", family: "" };
    const r = resolveIdentity(model, { catalogId: "some-other-model" }, CATALOG);
    expect(r.state).toBe("resolved");
    expect(r.source).toBe("declared");
    expect(r.catalogId).toBe("some-other-model");
    expect(r.effective.catalogId).toBe("some-other-model");
  });

  it("provider that names a full catalogue id self-identifies (source provider)", () => {
    const model = { providerID: "chutes", id: "qwen/qwen3.6-27b", family: "" };
    const r = resolveIdentity(model, null, CATALOG);
    expect(r.state).toBe("resolved");
    expect(r.source).toBe("provider");
    expect(r.catalogId).toBe("qwen/qwen3.6-27b");
  });
});

describe("resolveIdentity — credibility rule for limit.context", () => {
  it("a provider limit.context of 0 is absent → catalogue value is used", () => {
    const model = { providerID: "chutes", id: "qwen3.6-27b", family: "", limit: { context: 0 } };
    const r = resolveIdentity(model, null, CATALOG);
    expect(r.effective.limit!.context).toBe(131072);
  });

  it("a provider limit.context of 262144 against a catalogue 1048576 → provider wins", () => {
    // id qwen-1m matches the 1M-entry; the provider reports a smaller-but-real
    // endpoint property of 262144, which is a fact about ITS endpoint.
    const model = { providerID: "chutes", id: "qwen-1m", family: "", limit: { context: 262144 } };
    const r = resolveIdentity(model, null, CATALOG);
    expect(r.effective.limit!.context).toBe(262144);
  });
});

describe("resolveIdentity — price is always the endpoint's", () => {
  it("declared.price 'free' yields explicit zero rates, distinguishable from absent", () => {
    const model = { providerID: "chutes", id: "qwen3.6-27b", family: "" };
    const free = resolveIdentity(model, { price: "free" }, CATALOG);
    // Explicit zeros across every rate — a declared free endpoint.
    expect(free.effective.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    // Absent price is silence — no made-up zeroes.
    const silent = resolveIdentity(model, null, CATALOG);
    expect(silent.effective.cost).toEqual({});
  });

  it("the catalogue's own price is never adopted as the endpoint's price", () => {
    // Even though the catalogue entry carries no cost here, a provider price
    // must be able to win outright.
    const model = { providerID: "chutes", id: "qwen3.6-27b", family: "", cost: { input: 3, output: 15, cacheRead: 0.3 } };
    const r = resolveIdentity(model, null, CATALOG);
    expect(r.effective.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3 });
  });
});
