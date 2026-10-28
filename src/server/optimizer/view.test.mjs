import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ttlLabel,
  gaugeBand,
  describePressure,
  describeActivityEntry,
  summaryView,
  seriesView,
  withSummaryView,
  withSeriesView,
} from "./view.mjs";

const win = (over = {}) => ({
  provider: "claude",
  planLabel: "Max 20x",
  windowLabel: "Session (5h)",
  kind: "session",
  pct: 62,
  resetsAt: 1761660000000,
  forecastPct: 88,
  deficit: 6,
  tokensPerPct: 1000,
  ...over,
});
const summary = (over = {}) => ({
  supported: true,
  cacheShare: { output: 0, cacheRead: 0.74, cacheWrite: 0.13, input: 0.13 },
  bySession: [{}, {}, {}],
  ttl: { measuredMs: 300_000, confidence: "measured", observations: 9, configuredMs: null, matched: null },
  windows: [],
  activity: { entries: [] },
  compaction: null,
  metered: [],
  ...over,
});
const point = (over = {}) => ({ t: 0, tokensSent: 100, actualTrimmedTokens: 0, potentialTrimmedTokens: 0, maskedTokens: 0, ...over });
const series = (over = {}) => ({
  supported: true,
  range: "24h",
  bucket: "hour",
  series: [point()],
  totals: { turns: 10, cost: 1.5, tokensSent: 100, actualTrimmedTokens: 0, potentialTrimmedTokens: 0, maskedTokens: 0, rewarmTokens: 0 },
  saved: { usd: 0, potentialUsd: 0, pricedShare: 1, basis: "measured" },
  ...over,
});

describe("small formatters", () => {
  test("gauge bands at 59/60/84/85", () => {
    assert.deepEqual([59, 60, 84, 85].map(gaugeBand), ["ok", "warn", "warn", "danger"]);
  });
  test("ttl labels incl. 10m", () => {
    assert.deepEqual([300_000, 3_600_000, 600_000].map(ttlLabel), ["5m", "1h", "10m"]);
  });
  test("pressure: no signal / on pace / ahead", () => {
    assert.deepEqual(describePressure(0, false), { text: "no pressure signal yet", tone: "neutral" });
    assert.deepEqual(describePressure(-3, true), { text: "on pace", tone: "ok" });
    assert.deepEqual(describePressure(0, true), { text: "on pace", tone: "ok" });
    assert.deepEqual(describePressure(5.6, true), { text: "+6 pts ahead of pace", tone: "warn" });
  });
  test("activity verdict words + unknown verdict + evidence line", () => {
    assert.deepEqual(describeActivityEntry({ verdict: "kept", subject: "eco level 2", evidence: { turns: 62, hit: "74.1%" } }), {
      headline: "Kept — eco level 2",
      detail: "Turns 62 · Hit 74.1%",
    });
    assert.equal(describeActivityEntry({ verdict: "rolled-back", subject: "x" }).headline, "Rolled back — x");
    assert.equal(describeActivityEntry({ verdict: "applied", subject: "x" }).headline, "Applied — x");
    assert.equal(describeActivityEntry({ verdict: "weird" }).headline, "weird — optimizer change");
    assert.equal(describeActivityEntry({ verdict: "kept", subject: "s", evidence: { cacheHit: 1, empty: "", none: null } }).detail, "Cache Hit 1");
  });
});

describe("summaryView", () => {
  test("switch reflects the config flag", () => {
    assert.deepEqual(summaryView(summary(), { optimizerEnabled: false }).switch.label, "Off");
    const on = summaryView(summary(), { optimizerEnabled: true }).switch;
    assert.deepEqual([on.on, on.label], [true, "On"]);
    assert.match(on.body, /^Manta trims, paces and compacts/);
  });

  test("sub-rows exist only with data: cache always; pacing with a pressure signal; compacting with attempts", () => {
    assert.deepEqual(summaryView(summary()).subrows.map((s) => s.id), ["cache"]);
    const v = summaryView(summary({ windows: [win({ deficit: 6 }), win({ windowLabel: "Weekly", kind: "weekly", deficit: 2 })], compaction: { background: 3, total: 5 } }));
    assert.deepEqual(v.subrows.map((s) => s.id), ["pacing", "compacting", "cache"]);
    assert.equal(v.subrows[0].chip, "eco · +6 pts ahead of pace");
    assert.equal(v.subrows[1].chip, "3 of 5 in background");
    assert.equal(v.subrows[2].chip, "74% hit");
    assert.equal(v.subrows[2].text, "Reads billed at 0.1×; TTL 5m measured.");
    // window with no tokensPerPct → no pacing sub-row
    assert.deepEqual(summaryView(summary({ windows: [win({ tokensPerPct: null })] })).subrows.map((s) => s.id), ["cache"]);
    // total 0 → no compacting row
    assert.deepEqual(summaryView(summary({ compaction: { background: 0, total: 0 } })).subrows.map((s) => s.id), ["cache"]);
  });

  test("no ttl falls back to '5m' and a bare '30d' detail", () => {
    const v = summaryView(summary({ ttl: null }));
    assert.equal(v.subrows[0].text, "Reads billed at 0.1×; TTL 5m measured.");
    assert.equal(v.stats[0].detail, "30d");
  });

  test("windows: title, bands, forecast label/warn, pressure chip, 'gathering history…'", () => {
    const [a, b] = summaryView(summary({ windows: [win(), win({ windowLabel: "Weekly", kind: "weekly", pct: 90, forecastPct: null, tokensPerPct: null })] })).windows;
    assert.equal(a.title, "Max 20x — Session (5h)");
    assert.deepEqual([a.pct, a.pctLabel, a.band, a.forecastPct, a.forecastWarn, a.forecastLabel], [62, "62% used", "warn", 88, true, "forecast 88%"]);
    assert.deepEqual(a.pressure, { text: "+6 pts ahead of pace", tone: "warn" });
    assert.equal(a.key, "claude:session");
    assert.deepEqual([b.band, b.forecastLabel, b.forecastWarn, b.pressure.tone], ["danger", "gathering history…", false, "neutral"]);
    assert.equal(b.key, "claude:weekly");
  });

  test("duplicate window keys are disambiguated", () => {
    const keys = summaryView(summary({ windows: [win(), win()] })).windows.map((w) => w.key);
    assert.deepEqual(keys, ["claude:session", "claude:session#2"]);
  });

  test("activity rows, rolled-back flag, captions and empty text", () => {
    const v = summaryView(summary({ activity: { entries: [{ id: "a1", ts: 5, kind: "tune", subject: "eco level 2", verdict: "kept", evidence: { turns: 62 } }, { id: "a2", ts: 4, kind: "eco", subject: "z", verdict: "rolled-back" }] } }));
    assert.deepEqual(v.activity[0], { id: "a1", ts: 5, headline: "Kept — eco level 2", detail: "Turns 62", rolledBack: false });
    assert.equal(v.activity[1].rolledBack, true);
    assert.match(v.activityCaption, /^Every parameter change the optimizer made on its own/);
    assert.match(v.activityEmpty, /^Nothing changed yet\./);
  });

  test("stats: cache hit with ttl detail; sessions with compaction detail", () => {
    const v = summaryView(summary({ compaction: { background: 3, total: 5 } }));
    assert.deepEqual(v.stats.map((s) => [s.id, s.label, s.value, s.detail]), [
      ["cacheHit", "Cache hit", "74%", "TTL 5m measured · 30d"],
      ["sessions", "Sessions", "3", "3 of 5 in background · 30d"],
    ]);
  });

  test("zero cache traffic → 0% hit (no division by zero)", () => {
    const v = summaryView(summary({ cacheShare: { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 } }));
    assert.equal(v.stats[0].value, "0%");
  });

  test("metered rows + caption", () => {
    const v = summaryView(summary({ metered: [{ name: "DeepSeek", role: "overflow", price: "$0.2/Mtok" }] }));
    assert.deepEqual(v.metered, [{ name: "DeepSeek", role: "overflow", price: "$0.2/Mtok" }]);
    assert.match(v.meteredCaption, /^Pay-per-token endpoints/);
  });
});

describe("seriesView", () => {
  test("nothing trimmed: no trimming chip, 24h legend text, empty-window flags", () => {
    const v = seriesView(series({ series: [point({ tokensSent: 0 })], totals: { ...series().totals, tokensSent: 0 } }), { range: "24h" });
    assert.equal(v.trimming, null);
    assert.equal(v.hasCounterfactual, false);
    assert.equal(v.noActivity, true);
    assert.equal(v.emptyText, "No model activity in the last 24h.");
    assert.equal(v.legend.noCounterfactual, "Hourly comparison starts collecting today.");
    assert.equal(seriesView(series({ range: "7d" }), { range: "7d" }).legend.noCounterfactual, "No trimming recorded in this window.");
    assert.equal(v.savingLabel, null);
    assert.equal(v.potentialLine, null);
  });

  test("actual trims: raw = sent + actual only; chip, saving label, counterfactual", () => {
    const s = series({
      series: [point({ tokensSent: 800, actualTrimmedTokens: 200 }), point({ tokensSent: 1200, actualTrimmedTokens: 0 })],
      totals: { ...series().totals, tokensSent: 2000 },
      saved: { usd: 3.4, potentialUsd: 1.1, pricedShare: 1, basis: "measured" },
    });
    const v = seriesView(s, { range: "24h" });
    assert.deepEqual(v.rawValues, [1000, 1200]);
    assert.deepEqual(v.trimming, { name: "Trimming", text: v.trimming.text, chip: "−9% sent" }); // 200 / 2200
    assert.equal(v.hasCounterfactual, true);
    assert.equal(v.legend.noCounterfactual, null);
    assert.deepEqual(v.savingLabel, { text: "−200 tokens · ≈ $3.40 est.", tone: "ok" });
    assert.deepEqual(v.stats[0], { id: "sent", label: "Sent (24h)", value: "2k tokens", detail: "raw 2.2k tokens", tone: "neutral" });
  });

  test("potential falls back to maskedTokens and is NOT folded into raw", () => {
    const s = series({ series: [point({ tokensSent: 1000, potentialTrimmedTokens: undefined, maskedTokens: 400 })], totals: { ...series().totals, tokensSent: 1000 }, saved: { usd: 0, potentialUsd: 1.1, pricedShare: 1, basis: "measured" } });
    const v = seriesView(s, { range: "24h" });
    assert.equal(v.potentialLine, "Potential, not applied: −400 tokens · ≈ $1.10 est.");
    assert.deepEqual(v.rawValues, [1000]);
    assert.equal(v.hasCounterfactual, false);
    assert.equal(v.noActivity, false);
  });

  test("potential line without a price omits the dollar clause", () => {
    const s = series({ series: [point({ potentialTrimmedTokens: 500 })], saved: { usd: null, potentialUsd: null, pricedShare: 0, basis: "unpriced" } });
    assert.equal(seriesView(s, { range: "24h" }).potentialLine, "Potential, not applied: −500 tokens est.");
  });

  test("saved stat: measured / partial / unpriced / negative", () => {
    const stat = (saved) => seriesView(series({ saved }), { range: "7d" }).stats[1];
    assert.deepEqual(stat({ usd: 3.4, potentialUsd: 4.5, pricedShare: 1, basis: "measured" }), { id: "saved", label: "Saved (est.)", value: "≈ $3.40", detail: "≈$4.50 potential", tone: "ok" });
    assert.equal(stat({ usd: 3.4, potentialUsd: 4.5, pricedShare: 0.8, basis: "partial" }).detail, "≈$4.50 potential · 80% priced");
    assert.deepEqual(stat({ usd: null, potentialUsd: null, pricedShare: 0, basis: "unpriced" }), { id: "saved", label: "Saved (est.)", value: "not priced", detail: "these endpoints declare no price", tone: "neutral" });
    assert.deepEqual(stat({ usd: -1.2, potentialUsd: 0, pricedShare: 1, basis: "measured" }), { id: "saved", label: "Saved (est.)", value: "−$1.20", detail: "re-cache cost exceeded savings", tone: "warn" });
    assert.equal(stat({ usd: 0, potentialUsd: null, pricedShare: 1, basis: "measured" }).detail, "≈$0.00 potential");
  });

  test("negative saving tints the saving label warn", () => {
    const s = series({ series: [point({ actualTrimmedTokens: 100 })], saved: { usd: -1.2, potentialUsd: 0, pricedShare: 1, basis: "measured" } });
    assert.deepEqual(seriesView(s, { range: "24h" }).savingLabel, { text: "−100 tokens · −$1.20 est.", tone: "warn" });
  });

  test("cost per turn: average, or an em dash with no turns", () => {
    assert.equal(seriesView(series(), { range: "30d" }).stats[2].value, "$0.15");
    assert.equal(seriesView(series({ totals: { ...series().totals, turns: 0 } }), { range: "30d" }).stats[2].value, "—");
    assert.equal(seriesView(series(), { range: "30d" }).stats[2].detail, "30d average");
  });
});

describe("with*View wrappers", () => {
  test("add view when supported; an unsupported answer is returned untouched", () => {
    assert.ok(withSummaryView(summary(), { optimizerEnabled: true }).view.switch.on);
    assert.equal(withSummaryView(summary(), {}).view.switch.on, false);
    assert.equal(withSeriesView(series({ range: "7d" }), "24h").view.stats[0].label, "Sent (7d)");
    assert.equal(withSeriesView(series({ range: undefined }), undefined).view.stats[0].label, "Sent (24h)");
    const u = { supported: false };
    assert.equal(withSummaryView(u, {}), u);
    assert.equal(withSeriesView(u, "24h"), u);
  });
});
