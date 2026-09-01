// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// ctoProbes.test.mjs — BET-1396 (§7.5 probe runner, §7.3 vitality, §7.6
// relevance, §10.6-7 escalation). Pure over injected fakes: no live network,
// no secrets vault, no registry store (AGENTS.md server rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  AUTHORING_FAILURE_RETRY_MS,
  AUTHOR_MAX_PROBES,
  AUTH_FAIL_ESCALATE,
  CADENCE_DAILY_MS,
  CADENCE_FLOOR_MS,
  CADENCE_WEEKLY_MS,
  RESPONSE_CAP_BYTES,
  classifyError,
  classifyOutcome,
  consumeResponse,
  cadenceMs,
  createProbes,
  defaultHttpRequest,
  effectiveCadenceMs,
  evidenceHost,
  extractFields,
  hostAllowed,
  isPrivateAddress,
  parseProbeUrl,
  parseProposedProbes,
  publicAddresses,
  stepFailureState,
  validateProbeSpec,
  vitalityOf,
} from "./ctoProbes.mjs";
import { PROBE_SOURCE_KIND, createCtoCards, probeBlockerCopy, stableCardId } from "./ctoCards.mjs";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function memProbesStore(initial = {}) {
  const files = { ...initial };
  return {
    list: async () => Object.keys(files),
    load: async (tool) => {
      const v = files[tool];
      if (v === undefined) throw new Error(`missing ${tool}`);
      return JSON.parse(JSON.stringify(v));
    },
    save: async (tool, spec) => {
      files[tool] = JSON.parse(JSON.stringify(spec));
    },
    _files: files,
  };
}

function memStateStore(initial = {}) {
  const files = { ...initial };
  return {
    list: async () => Object.keys(files),
    load: async (tool) => {
      const v = files[tool];
      return v === undefined ? {} : JSON.parse(JSON.stringify(v));
    },
    save: async (tool, payload) => {
      files[tool] = JSON.parse(JSON.stringify(payload));
    },
    _files: files,
  };
}

function fakeRegistry(rows = []) {
  const byTool = new Map(rows.map((r) => [r.tool, r]));
  return {
    consentFor: async (tool, ring = "metadata") => byTool.get(tool)?.consent?.[ring] ?? null,
    toolRow: async (tool) => byTool.get(tool) ?? null,
    async applyProbeResult(tool, input) {
      const t = byTool.get(tool);
      if (!t) return { ok: false };
      (t._probeCalls = t._probeCalls ?? []).push(input);
      // minimal mirror of the registry's real vitality fold (the registry's
      // own math is exercised in its dedicated tests below)
      t.vitality = { ...(t.vitality ?? {}), last_probed: input.probedAt };
      return { ok: true };
    },
    async applyRelevance(tool, project, score) {
      const t = byTool.get(tool);
      if (!t) return { ok: false };
      t.relevance = { ...(t.relevance ?? {}), [project]: score };
      return { ok: true };
    },
    async appendEvidence(tool, entry) {
      const t = byTool.get(tool);
      if (!t) return { ok: false };
      t.evidence = [...(t.evidence ?? []), entry];
      return { ok: true };
    },
    _rows: byTool,
  };
}

// BET-1463 (defect 3): the real production bug was a fake `cards` double that
// implemented a method (`upsertBlocker`) production's `createCtoCards()`
// didn't actually export — the escalation guard's `typeof
// cards.upsertBlocker === "function"` was true in every test and false on
// the live box. Guard against that recurring: every method this fake defines
// must be a real key of `createCtoCards()`'s return shape, or this throws at
// module-load time instead of silently drifting from production again.
const REAL_CARDS_KEYS = new Set(Object.keys(createCtoCards()));

function fakeCards() {
  const upserts = [];
  const resolved = [];
  const open = [];
  const obj = {
    open,
    upserts,
    resolved,
    async upsertBlocker(input) {
      upserts.push(input);
      open.push({ id: stableCardId(input.sourceKind, input.sourceId), ...input, variant: "blocker", state: "open" });
      return { changed: true, isNew: true };
    },
    async listOpen() {
      return [...open];
    },
    async resolveById(id, opts = {}) {
      const idx = open.findIndex((c) => c.id === id);
      if (idx < 0) return { changed: false };
      open.splice(idx, 1);
      resolved.push({ id, reason: opts.reason });
      return { changed: true };
    },
  };
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "function" && !REAL_CARDS_KEYS.has(key)) {
      throw new Error(
        `fakeCards() defines "${key}" which createCtoCards() does not export — this is exactly the ` +
          `BET-1463 defect 3 shape (a test double hiding a production gap). Fix createCtoCards()'s ` +
          `return object, not this fake.`,
      );
    }
  }
  return obj;
}

function fakeLedger() {
  const rows = [];
  return {
    rows,
    async append(entry) {
      rows.push(entry);
    },
  };
}

// A valid consented tool row with evidenced hosts + a secret.
function consentedTool(tool = "github", hosts = ["api.github.com"]) {
  return {
    tool,
    status: "candidate",
    consent: { metadata: "yes", deep_read: null, write: null },
    evidence: [
      ...hosts.map((h) => ({ channel: "config", detail: `git:${h}`, ts: 1 })),
      { channel: "secret", detail: "secret:GITHUB_TOKEN", ts: 1 },
    ],
  };
}

function githubSpec(overrides = {}) {
  return {
    tool: "github",
    auth: { secret: "GITHUB_TOKEN", header: "Authorization: Bearer {secret}" },
    probes: [
      {
        name: "repo_events",
        method: "GET",
        url: "https://api.github.com/users/octocat/events",
        extract: { last_event: "0.created_at", inflow_rate: "length" },
        cadence: "30m",
        ring: "metadata",
      },
    ],
    ...overrides,
  };
}

function build({ rows, specs, state, cards, ledger, http, now, thrifty, runEphemeral, projects, getTopFacts, getRollups, resolveSegment } = {}) {
  return createProbes({
    registry: fakeRegistry(rows ?? [consentedTool()]),
    probes: memProbesStore(specs ?? { github: githubSpec() }),
    stateStore: memStateStore(state),
    cards: cards ?? fakeCards(),
    ledger: ledger ?? fakeLedger(),
    now: now ?? (() => 1_700_000_000_000),
    httpRequest: http ?? (async () => ({ status: 200, bodyText: JSON.stringify([{ created_at: "2026-08-20T00:00:00Z" }]) })),
    getSecretPath: async () => "/tmp/secret-file",
    readSecret: async () => "sekrit-value",
    isThrifty: thrifty ?? (() => false),
    listProjects: async () => projects ?? ["proj"],
    getTopFacts: getTopFacts ?? (async () => [{ statement: "ships the parser" }]),
    getRollups: getRollups ?? (async () => []),
    resolveSegment: resolveSegment ?? null,
    runEphemeral: runEphemeral ?? null,
  });
}

// ---------------------------------------------------------------------------
// §7.5 validator — every violation fails BY NAME
// ---------------------------------------------------------------------------

test("validateProbeSpec: valid spec passes", () => {
  const r = validateProbeSpec(githubSpec(), {
    tool: "github",
    allowedHosts: ["api.github.com"],
    consentedRing: "metadata",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateProbeSpec: unknown top-level key fails by name", () => {
  const r = validateProbeSpec({ ...githubSpec(), extras: 1 }, { tool: "github" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "extras" && e.message.includes('"extras"')));
});

test("validateProbeSpec: non-GET method fails by name", () => {
  const spec = githubSpec();
  spec.probes[0].method = "POST";
  const r = validateProbeSpec(spec, { tool: "github" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "probes[0].method" && e.message.includes("POST")));
});

test("validateProbeSpec: off-allowlist host fails by name", () => {
  const spec = githubSpec();
  spec.probes[0].url = "https://evil.example.com/x";
  const r = validateProbeSpec(spec, { tool: "github", allowedHosts: ["api.github.com"] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "probes[0].url" && e.message.includes("evil.example.com")));
});

test("validateProbeSpec: ring escalation fails by name; write ring is not even a legal value", () => {
  const spec = githubSpec();
  spec.probes[0].ring = "deep_read";
  let r = validateProbeSpec(spec, { tool: "github", consentedRing: "metadata" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "probes[0].ring"));
  spec.probes[0].ring = "write";
  r = validateProbeSpec(spec, { tool: "github", consentedRing: "deep_read" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "probes[0].ring" && e.message.includes("deep_read")));
});

test("validateProbeSpec: deep_read consent admits a deep_read probe", () => {
  const spec = githubSpec();
  spec.probes[0].ring = "deep_read";
  const r = validateProbeSpec(spec, { tool: "github", allowedHosts: ["api.github.com"], consentedRing: "deep_read" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateProbeSpec: sub-5m cadence fails by name", () => {
  const spec = githubSpec();
  spec.probes[0].cadence = "4m";
  const r = validateProbeSpec(spec, { tool: "github", allowedHosts: ["api.github.com"], consentedRing: "metadata" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "probes[0].cadence" && e.message.includes("5m floor")));
});

test("validateProbeSpec: auth template must hold exactly one {secret}; secret must be a KEY NAME; header must be Name: value", () => {
  const spec = githubSpec();
  spec.auth = { secret: "GITHUB_TOKEN", header: "Authorization: Bearer" };
  let r = validateProbeSpec(spec, { tool: "github" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "auth.header"));
  spec.auth = { secret: "hunter2", header: "Authorization: Bearer {secret}" };
  r = validateProbeSpec(spec, { tool: "github" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "auth.secret"));
});

test("validateProbeSpec: colon-less auth.header fails at authoring time (nit: mangled header name)", () => {
  const spec = githubSpec();
  spec.auth = { secret: "GITHUB_TOKEN", header: "Bearer {secret}" };
  const r = validateProbeSpec(spec, { tool: "github", allowedHosts: ["api.github.com"], consentedRing: "metadata" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "auth.header" && e.message.includes('missing ":"')));
});

test("validateProbeSpec: tool mismatch fails by name", () => {
  const r = validateProbeSpec(githubSpec({ tool: "gitlab" }), { tool: "github" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "tool"));
});

// ---------------------------------------------------------------------------
// Pure predicates — SSRF catalogue
// ---------------------------------------------------------------------------

test("parseProbeUrl: https only, no userinfo, bounded length", () => {
  assert.equal(parseProbeUrl("http://api.github.com/x"), null);
  assert.equal(parseProbeUrl("https://user:pass@api.github.com/"), null);
  assert.equal(parseProbeUrl(`https://a.com/${"x".repeat(2100)}`), null);
  const ok = parseProbeUrl("https://api.github.com/x?y=1");
  assert.equal(ok.host, "api.github.com");
});

test("hostAllowed: exact host, case-insensitive, no subdomain forgiveness", () => {
  assert.equal(hostAllowed("api.github.com", ["api.github.com"]), true);
  assert.equal(hostAllowed("API.GitHub.com", ["api.github.com"]), true);
  assert.equal(hostAllowed("evil-api.github.com", ["api.github.com"]), false);
  assert.equal(hostAllowed("api.github.com.evil.com", ["api.github.com"]), false);
  assert.equal(hostAllowed("github.com", ["api.github.com"]), false);
});

test("isPrivateAddress: the whole catalogue is rejected", () => {
  for (const a of [
    "127.0.0.1", "127.255.1.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "0.0.0.0", "169.254.169.254", "100.64.0.1", "224.0.0.1",
    "240.0.0.1", "255.255.255.255", "::1", "::", "::ffff:127.0.0.1",
    "::ffff:10.0.0.1", "::ffff:169.254.169.254", "fc00::1", "fd12::1",
    "fe80::1", "ff02::1", "garbage", "", null,
  ]) {
    assert.equal(isPrivateAddress(a), true, `${a} must be private`);
  }
  for (const a of ["93.184.216.34", "2606:4700::6810:85e5", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(a), false, `${a} must be public`);
  }
});

test("publicAddresses: keeps only connectable results", () => {
  const kept = publicAddresses([
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
    { address: "2606:4700::1111", family: 6 },
  ]);
  assert.deepEqual(kept.map((k) => k.address), ["93.184.216.34", "2606:4700::1111"]);
  assert.deepEqual(publicAddresses(null), []);
});

test("defaultHttpRequest: rejects non-https and private-only DNS before any socket", async () => {
  await assert.rejects(
    defaultHttpRequest({ url: "http://api.github.com/x" }),
    (e) => e.code === "bad_url",
  );
  await assert.rejects(
    defaultHttpRequest({ url: "https://internal.corp/x", dnsLookup: (h, o, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]) }),
    (e) => e.code === "dns_private",
  );
  await assert.rejects(
    defaultHttpRequest({ url: "https://dead.dns/x", dnsLookup: (h, o, cb) => cb(new Error("nx")) }),
    (e) => e.code === "dns_failed",
  );
});

// ---------------------------------------------------------------------------
// consumeResponse — 256 KB cap + 10 s timeout on a real stream
// ---------------------------------------------------------------------------

test("consumeResponse: caps oversized bodies (too_large)", async () => {
  const s = new PassThrough();
  const p = consumeResponse(s, { maxBytes: 1024, timeoutMs: 5_000 });
  const big = Buffer.alloc(2048, 0x61);
  s.write(big);
  await assert.rejects(p, (e) => e.code === "too_large");
});

test("consumeResponse: times out a stalled stream", async () => {
  const s = new PassThrough();
  const p = consumeResponse(s, { maxBytes: RESPONSE_CAP_BYTES, timeoutMs: 50 });
  await assert.rejects(p, (e) => e.code === "timeout");
});

test("consumeResponse: resolves a normal body", async () => {
  const s = new PassThrough();
  const p = consumeResponse(s, { maxBytes: RESPONSE_CAP_BYTES, timeoutMs: 5_000 });
  s.end('{"ok":true}');
  const r = await p;
  assert.equal(r.bodyText, '{"ok":true}');
});

test("consumeResponse: a slow-but-under-timeout body survives a 250ms stall", async () => {
  const s = new PassThrough();
  const p = consumeResponse(s, { maxBytes: RESPONSE_CAP_BYTES, timeoutMs: 2_000 });
  await delay(250);
  s.end("late");
  assert.equal((await p).bodyText, "late");
});

// ---------------------------------------------------------------------------
// Extraction + vitality helpers
// ---------------------------------------------------------------------------

test("extractFields: dot paths, indexes, length; non-JSON body reports ok:false", () => {
  const body = JSON.stringify({ items: [{ created_at: "2026-08-20T00:00:00Z" }, { created_at: "x" }], meta: { total: 7 } });
  const r = extractFields(body, { last_event: "items.0.created_at", inflow_rate: "items.length", total: "meta.total", missing: "nope.deep" });
  assert.deepEqual(r.fields, { last_event: "2026-08-20T00:00:00Z", inflow_rate: 2, total: 7, missing: null });
  assert.equal(extractFields("not json", { a: "b" }).ok, false);
  assert.deepEqual(extractFields(body, null).fields, {});
});

test("vitalityOf: only the §7.2 well-known pair survives, only well-typed", () => {
  assert.deepEqual(vitalityOf({ last_event: "2026-08-20T00:00:00Z", inflow_rate: 3, junk: "x" }), {
    last_event: "2026-08-20T00:00:00Z",
    inflow_rate: 3,
  });
  assert.deepEqual(vitalityOf({ inflow_rate: "3" }), {});
  assert.deepEqual(vitalityOf({}), {});
});

// ---------------------------------------------------------------------------
// Adaptive cadence (§7.3 daily ↔ weekly)
// ---------------------------------------------------------------------------

test("effectiveCadenceMs: spec cadence unclamped until a vitality sample exists", () => {
  const spec = 6 * 3_600_000; // 6h
  assert.equal(effectiveCadenceMs(spec, null), spec);
  assert.equal(effectiveCadenceMs(spec, {}), spec);
  assert.equal(effectiveCadenceMs(spec, { ewma: null }), spec);
});

test("effectiveCadenceMs: observed inflow accelerates slow specs toward daily; silence stretches toward weekly", () => {
  // a slower-than-daily spec accelerates to daily on inflow
  assert.equal(effectiveCadenceMs(7 * 24 * 3_600_000, { ewma: 0.5 }), CADENCE_DAILY_MS);
  // a spec already faster than daily is HONORED (§7.5: the runner honors the
  // declared cadence exactly — the band only accelerates, never slows)
  assert.equal(effectiveCadenceMs(6 * 3_600_000, { ewma: 0.5 }), 6 * 3_600_000);
  assert.equal(effectiveCadenceMs(30 * 60_000, { ewma: 2 }), 30 * 60_000);
  // observed silence stretches to weekly, even past a slower spec
  assert.equal(effectiveCadenceMs(6 * 3_600_000, { ewma: 0 }), CADENCE_WEEKLY_MS);
  assert.equal(effectiveCadenceMs(14 * CADENCE_DAILY_MS, { ewma: 0 }), 14 * CADENCE_DAILY_MS);
  // the 5m floor always holds
  assert.equal(effectiveCadenceMs(null, null), CADENCE_FLOOR_MS);
});

test("cadenceMs: parses the grammar", () => {
  assert.equal(cadenceMs("30m"), 30 * 60_000);
  assert.equal(cadenceMs("1h"), 3_600_000);
  assert.equal(cadenceMs("7d"), CADENCE_WEEKLY_MS);
  assert.equal(cadenceMs("nope"), null);
});

// ---------------------------------------------------------------------------
// Escalation state machine (§10.6-7)
// ---------------------------------------------------------------------------

test("stepFailureState: 3 consecutive auth failures escalate exactly once; success resolves", () => {
  let st = null;
  let actions = [];
  for (let i = 0; i < AUTH_FAIL_ESCALATE; i++) {
    const r = stepFailureState(st, "auth");
    st = r.state;
    actions.push(r.action);
  }
  assert.deepEqual(actions, [null, null, "escalate"]);
  // a 4th auth failure with the card already open does NOT re-escalate
  assert.equal(stepFailureState(st, "auth").action, null);
  // success resolves
  const ok = stepFailureState(st, "success");
  assert.equal(ok.action, "resolve");
  assert.equal(ok.state.fails, 0);
  assert.equal(ok.state.authFails, 0);
  // a clean success with no card resolves nothing
  assert.equal(stepFailureState(ok.state, "success").action, null);
});

test("stepFailureState: non-auth failure resets the auth streak but keeps the fail streak", () => {
  let r = stepFailureState(null, "auth");
  r = stepFailureState(r.state, "auth");
  r = stepFailureState(r.state, "fail");
  assert.equal(r.state.fails, 3);
  assert.equal(r.state.authFails, 0);
  // two more auth failures do NOT escalate (streak restarted at the 500)
  r = stepFailureState(r.state, "auth");
  r = stepFailureState(r.state, "auth");
  assert.equal(r.action, null);
  r = stepFailureState(r.state, "auth");
  assert.equal(r.action, "escalate");
});

test("classifyOutcome/classifyError: 401/403 + secret_missing are auth-shaped", () => {
  assert.equal(classifyOutcome(401), "auth");
  assert.equal(classifyOutcome(403), "auth");
  assert.equal(classifyOutcome(200), "fail");
  assert.equal(classifyOutcome(500), "fail");
  assert.deepEqual(classifyError({ code: "secret_missing" }), { outcome: "auth", error: "secret_missing" });
  assert.deepEqual(classifyError({ code: "timeout" }).outcome, "fail");
});

// ---------------------------------------------------------------------------
// Evidence hosts (§7.5 allowlist source)
// ---------------------------------------------------------------------------

test("evidenceHost: reads the BET-1395 channel shapes; secrets/webhooks never widen the list", () => {
  assert.equal(evidenceHost("domain:api.github.com"), "api.github.com");
  assert.equal(evidenceHost("git:github.com/antoinedc/MantaUI.git"), "github.com");
  assert.equal(evidenceHost("mcp:github:api.github.com"), "api.github.com");
  assert.equal(evidenceHost("forge:github.com/a/b.yaml"), "github.com");
  assert.equal(evidenceHost("secret:GITHUB_TOKEN"), null);
  assert.equal(evidenceHost("webhook:my hook"), null);
  assert.equal(evidenceHost("schedule:nightly"), null);
  assert.equal(evidenceHost("cli:some-token"), null);
});

// ---------------------------------------------------------------------------
// The runner end-to-end (injected fakes)
// ---------------------------------------------------------------------------

test("runDue: executes a due probe, ledger row is evidence-shaped, vitality + status flip happen", async () => {
  const rows = [consentedTool()];
  const reg = fakeRegistry(rows);
  const ledger = fakeLedger();
  const eng = createProbes({
    registry: reg,
    probes: memProbesStore({ github: githubSpec() }),
    stateStore: memStateStore(),
    ledger,
    now: () => 1_700_000_000_000,
    httpRequest: async ({ url, headers }) => {
      assert.equal(url, "https://api.github.com/users/octocat/events");
      assert.equal(headers.Authorization, "Bearer sekrit-value");
      return { status: 200, bodyText: JSON.stringify([{ created_at: "2026-08-20T00:00:00Z" }, {}, {}, {}]) };
    },
    getSecretPath: async () => "/tmp/secret-file",
    readSecret: async () => "sekrit-value",
  });
  const results = await eng.runDue();
  assert.equal(results.length, 1);
  const row = results[0];
  assert.equal(row.ok, true);
  assert.equal(row.status, 200);
  assert.equal(row.probe, "github/repo_events");
  assert.equal(row.fields.inflow_rate, 4);
  assert.equal(row.fields.last_event, "2026-08-20T00:00:00Z");
  assert.ok(!("bodyText" in row));
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].actor, "cto");
  assert.equal(ledger.rows[0].kind, "cto.probe.result");
  assert.equal(rows[0]._probeCalls.length, 1);
  // next run scheduled at spec cadence (no vitality sample yet on the row)
  const st = await eng.loadToolState("github");
  assert.equal(st.probes.repo_events.nextRunAt, 1_700_000_000_000 + 30 * 60_000);
  assert.equal(st.probes.repo_events.lastOk, true);
});

test("runDue: no second run before the cadence elapses; a forced tool runs immediately", async () => {
  const eng = build({ state: { github: { probes: { repo_events: { nextRunAt: 1_700_000_000_000 + 60_000 } } } } });
  assert.equal((await eng.runDue()).length, 0);
  const forced = await eng.runDue({ forceTool: "github" });
  assert.equal(forced.length, 1);
});

test("runDue: nothing runs without consent (§7.5 'nothing for tools without consent')", async () => {
  const eng = build({
    rows: [{ tool: "github", consent: { metadata: null, deep_read: null, write: null }, evidence: [{ channel: "config", detail: "git:api.github.com", ts: 1 }] }],
  });
  assert.equal((await eng.runDue()).length, 0);
  const ledgerRows = eng.loadToolState; // no throw
  assert.ok(ledgerRows);
});

test("runDue: an off-allowlist or escalated-ring spec is re-validated at run time and skipped", async () => {
  const eng = build({
    rows: [consentedTool("github", ["api.github.com"])],
    specs: {
      github: (() => {
        const s = githubSpec();
        s.probes[0].url = "https://evil.example.com/x";
        return s;
      })(),
    },
  });
  assert.equal((await eng.runDue()).length, 0);
});

test("runDue: thrifty sheds due probes; a probe backing an open blocker card is exempt", async () => {
  const cards = fakeCards();
  cards.open.push({ id: "x", sourceKind: PROBE_SOURCE_KIND, sourceId: "github/repo_events", state: "open" });
  const eng = build({ cards, thrifty: () => true });
  const exempt = await eng.runDue();
  assert.equal(exempt.length, 1, "blocker-backed probe runs even while thrifty");
  const cards2 = fakeCards();
  const eng2 = build({ cards: cards2, thrifty: () => true });
  assert.equal((await eng2.runDue()).length, 0, "no blocker → shed entirely");
});

test("auth-shaped failure path: 401×3 escalates ONE card with the key name; recovery resolves it", async () => {
  const cards = fakeCards();
  const ledger = fakeLedger();
  let status = 401;
  const eng = build({
    cards,
    ledger,
    http: async () => ({ status, bodyText: "" }),
  });
  await eng.runDue({ forceTool: "github" });
  await eng.runDue({ forceTool: "github" });
  assert.equal(cards.upserts.length, 0, "no card before the 3rd consecutive auth failure");
  await eng.runDue({ forceTool: "github" });
  assert.equal(cards.upserts.length, 1);
  assert.equal(cards.upserts[0].sourceKind, "probe");
  assert.equal(cards.upserts[0].sourceId, "github/repo_events");
  assert.match(cards.upserts[0].title, /rotated/);
  assert.match(cards.upserts[0].body, /GITHUB_TOKEN/);
  assert.match(cards.upserts[0].body, /secrets surface/);
  const st = await eng.loadToolState("github");
  assert.equal(st.probes.repo_events.cardOpen, true);
  // recovery
  status = 200;
  await eng.runDue({ forceTool: "github" });
  assert.equal(cards.resolved.length, 1);
  assert.equal(cards.resolved[0].id, stableCardId(PROBE_SOURCE_KIND, "github/repo_events"));
  const st2 = await eng.loadToolState("github");
  assert.equal(st2.probes.repo_events.cardOpen, false);
  assert.equal(st2.probes.repo_events.authFails, 0);
});

test("a missing secret is auth-shaped (same rotated-key failure mode) and escalates", async () => {
  const cards = fakeCards();
  const eng = build({
    cards,
    http: async () => {
      throw Object.assign(new Error("no vault"), { code: "secret_missing" });
    },
  });
  for (let i = 0; i < 3; i++) await eng.runDue({ forceTool: "github" });
  assert.equal(cards.upserts.length, 1);
  assert.match(cards.upserts[0].body, /GITHUB_TOKEN/);
});

test("BET-1463 defect 3: cardOpen is NOT latched when the card write is skipped (cards missing the method)", async () => {
  // A `cards` double with no upsertBlocker at all — the exact shape of the
  // pre-fix production bug (createCtoCards() didn't export it).
  const skipCards = { async resolveById() { return { changed: false }; } };
  const eng = build({ cards: skipCards, http: async () => ({ status: 401, bodyText: "" }) });
  for (let i = 0; i < 3; i++) await eng.runDue({ forceTool: "github" });
  const st = await eng.loadToolState("github");
  assert.equal(st.probes.repo_events.cardOpen, false, "no write was attempted -> must not latch");
});

test("BET-1463 defect 3: cardOpen is NOT latched when the card write throws", async () => {
  const throwCards = fakeCards();
  throwCards.upsertBlocker = async () => {
    throw new Error("store unavailable");
  };
  const eng = build({ cards: throwCards, http: async () => ({ status: 401, bodyText: "" }) });
  for (let i = 0; i < 3; i++) await eng.runDue({ forceTool: "github" });
  const st = await eng.loadToolState("github");
  assert.equal(st.probes.repo_events.cardOpen, false, "a failed write must not latch cardOpen");
});

test("BET-1463 defect 3: a card write that failed before is retried on the next auth failure, not stuck forever", async () => {
  const recoverCards = fakeCards();
  // Seed state as if a prior run crossed the escalate threshold but the
  // write failed (cardOpen correctly left false by the fix above).
  const state = {
    github: { probes: { repo_events: { fails: 3, authFails: 3, cardOpen: false, lastAt: 1, lastOk: false } } },
  };
  const eng = build({ cards: recoverCards, state, http: async () => ({ status: 401, bodyText: "" }) });
  await eng.runDue({ forceTool: "github" });
  assert.equal(recoverCards.upserts.length, 1, "escalation retries because it was never actually latched open");
  const st = await eng.loadToolState("github");
  assert.equal(st.probes.repo_events.cardOpen, true, "this time the write succeeded, so it latches");
});

test("non-auth failures (500s / timeouts) never escalate — health rows only", async () => {
  const cards = fakeCards();
  const eng = build({ cards, http: async () => ({ status: 500, bodyText: "" }) });
  for (let i = 0; i < 6; i++) await eng.runDue({ forceTool: "github" });
  assert.equal(cards.upserts.length, 0);
  const st = await eng.loadToolState("github");
  assert.equal(st.probes.repo_events.fails, 6);
  assert.equal(st.probes.repo_events.authFails, 0);
});

test("failure evidence lands on the registry row via appendEvidence", async () => {
  const rows = [consentedTool()];
  const eng = createProbes({
    registry: fakeRegistry(rows),
    probes: memProbesStore({ github: githubSpec() }),
    stateStore: memStateStore(),
    now: () => 1_700_000_000_000,
    httpRequest: async () => ({ status: 500, bodyText: "" }),
    getSecretPath: async () => "/tmp/x",
    readSecret: async () => "v",
  });
  await eng.runDue({ forceTool: "github" });
  const ev = rows[0].evidence.find((e) => e.channel === "probe");
  assert.ok(ev);
  assert.equal(ev.detail, "repo_events:http_500");
});

// ---------------------------------------------------------------------------
// Spec authoring — engine-written, validated
// ---------------------------------------------------------------------------

test("scaffoldSpec writes the §7.5 template with the evidenced key; never overwrites", async () => {
  const specs = memProbesStore();
  const eng = createProbes({
    registry: fakeRegistry([consentedTool()]),
    probes: specs,
    stateStore: memStateStore(),
    now: () => 1_700_000_000_000,
  });
  const r = await eng.scaffoldSpec("github", { secret: "GITHUB_TOKEN" });
  assert.equal(r.changed, true);
  const spec = specs._files.github;
  assert.equal(spec.tool, "github");
  assert.deepEqual(spec.probes, []);
  assert.equal(spec.auth.secret, "GITHUB_TOKEN");
  assert.equal(spec.auth.header.includes("{secret}"), true);
  // second call is a no-op
  specs._files.github.probes.push({ name: "x" });
  const r2 = await eng.scaffoldSpec("github", { secret: "OTHER" });
  assert.equal(r2.changed, false);
});

test("writeSpec: valid content lands; invalid content is refused with the catalogue", async () => {
  const specs = memProbesStore({ github: githubSpec({ probes: [] }) });
  const eng = createProbes({
    registry: fakeRegistry([consentedTool()]),
    probes: specs,
    stateStore: memStateStore(),
    now: () => 1_700_000_000_000,
  });
  const good = await eng.writeSpec("github", githubSpec());
  assert.equal(good.ok, true);
  assert.equal(specs._files.github.probes.length, 1);
  const bad = githubSpec();
  bad.probes[0].method = "DELETE";
  const refused = await eng.writeSpec("github", bad);
  assert.equal(refused.ok, false);
  assert.ok(refused.errors.some((e) => e.key === "probes[0].method"));
  assert.equal(specs._files.github.probes.length, 1, "invalid content never touches disk");
});

// ---------------------------------------------------------------------------
// §7.6 relevance — weekly, paced, only through the gated ephemeral seam
// ---------------------------------------------------------------------------

test("relevanceScan: one call per (tool, project) per week, clamped to [0,1], written to the registry", async () => {
  const rows = [consentedTool()];
  let calls = 0;
  const eng = build({
    rows,
    runEphemeral: async () => {
      calls += 1;
      return { text: "0.8" };
    },
  });
  const r1 = await eng.relevanceScan({ ts: 1_700_000_000_000 });
  assert.equal(r1.ran, 1);
  assert.equal(calls, 1);
  assert.equal(rows[0].relevance.proj, 0.8);
  // same week → no second call
  const r2 = await eng.relevanceScan({ ts: 1_700_000_000_000 + 60_000 });
  assert.equal(r2.ran, 0);
  assert.equal(calls, 1);
  // next week → runs again
  const r3 = await eng.relevanceScan({ ts: 1_700_000_000_000 + 8 * 24 * 3_600_000 });
  assert.equal(r3.ran, 1);
  assert.equal(calls, 2);
});

test("relevanceScan: out-of-range model output is clamped, parse failure retries later", async () => {
  const rows = [consentedTool()];
  const outputs = ["1.7", "garbage", "0.25"];
  let i = 0;
  const eng = build({
    rows,
    runEphemeral: async () => ({ text: outputs[i++] ?? "" }),
  });
  await eng.relevanceScan({ ts: 1_700_000_000_000 });
  assert.equal(rows[0].relevance.proj, 1, "1.7 clamps to 1");
  await eng.relevanceScan({ ts: 1_700_000_000_000 + 8 * 24 * 3_600_000 });
  assert.equal(rows[0].relevance.proj, 1, "garbage → null → value unchanged");
  await eng.relevanceScan({ ts: 1_700_000_000_000 + 9 * 24 * 3_600_000 });
  assert.equal(rows[0].relevance.proj, 0.25);
});

test("relevanceScan: failed attempts consume the day budget AND rest on a short failure watermark (no per-minute spin)", async () => {
  const rows = [consentedTool()];
  let calls = 0;
  const eng = build({
    rows,
    projects: ["p1", "p2", "p3", "p4"],
    runEphemeral: async () => {
      calls += 1;
      throw new Error("provider down");
    },
  });
  const t0 = 1_700_000_000_000;
  const MIN = 60_000;
  let r = await eng.relevanceScan({ ts: t0 });
  assert.equal(r.attempts, 4, "first scan attempts all four pairs");
  r = await eng.relevanceScan({ ts: t0 + 1 * MIN });
  assert.equal(r.attempts, 0, "failure watermark suppresses the next minute-tick");
  r = await eng.relevanceScan({ ts: t0 + 2 * MIN });
  assert.equal(r.attempts, 0, "still suppressed");
  r = await eng.relevanceScan({ ts: t0 + 61 * MIN });
  assert.equal(r.attempts, 2, "after the 1h watermark the remaining day budget (6-4) bounds retries to 2");
  r = await eng.relevanceScan({ ts: t0 + 62 * MIN });
  assert.equal(r.attempts, 0, "day budget exhausted");
  assert.equal(calls, 6, "a persistently failing model makes exactly 6 attempts per day, not one per tick");
  r = await eng.relevanceScan({ ts: t0 + 24 * 3_600_000 });
  assert.equal(r.attempts, 4, "a fresh day gets a fresh attempt budget (4 pairs exist)");
});

test("relevanceScan: projects with nothing on the blackboard are watermarked, not retried", async () => {
  const rows = [consentedTool()];
  let calls = 0;
  const eng = build({
    rows,
    projects: ["empty"],
    getTopFacts: async () => [],
    getRollups: async () => [],
    runEphemeral: async () => {
      calls += 1;
      return { text: "0.5" };
    },
  });
  await eng.relevanceScan({ ts: 1_700_000_000_000 });
  assert.equal(calls, 0);
  await eng.relevanceScan({ ts: 1_700_000_000_000 + 60_000 });
  assert.equal(calls, 0);
});

test("relevanceScan: paces at 6 calls/day across tools and pairs", async () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g", "h"].map((t) => consentedTool(t));
  const specs = {};
  for (const t of rows) specs[t.tool] = githubSpec({ tool: t.tool });
  let calls = 0;
  const eng = build({
    rows,
    specs,
    projects: ["p1", "p2", "p3", "p4"],
    runEphemeral: async () => {
      calls += 1;
      return { text: "0.5" };
    },
  });
  const day0 = 1_700_000_000_000;
  await eng.relevanceScan({ ts: day0 });
  assert.equal(calls, 6, "daily budget caps the first scan");
  await eng.relevanceScan({ ts: day0 + 60_000 });
  assert.equal(calls, 6, "the same UTC day gets no further calls");
  await eng.relevanceScan({ ts: day0 + 24 * 3_600_000 });
  assert.equal(calls, 12, "the next day gets a fresh budget");
});

test("relevanceScan: rollup context is the PROJECT'S OWN rollups, not the box-wide slice", async () => {
  const rows = [consentedTool()];
  const prompts = [];
  const t = 1_700_000_000_000;
  const eng = build({
    rows,
    projects: ["projA", "projB"],
    getRollups: async () => [
      {
        level: "day",
        window: [t - 86_400_000, t],
        bullets: [
          { text: "alpha work item", refs: ["seg-alpha"] },
          { text: "beta work item", refs: ["seg-beta"] },
        ],
      },
    ],
    resolveSegment: async (id) =>
      id === "seg-alpha" ? { project: "projA" } : id === "seg-beta" ? { project: "projB" } : null,
    runEphemeral: async ({ context }) => {
      prompts.push(context.map((c) => c.text).join("\n"));
      return { text: "0.5" };
    },
  });
  await eng.relevanceScan({ ts: t });
  assert.equal(prompts.length, 2);
  const a = prompts.find((p) => p.includes('"projA"'));
  const b = prompts.find((p) => p.includes('"projB"'));
  assert.ok(a, "projA prompt captured");
  assert.ok(b, "projB prompt captured");
  assert.ok(a.includes("alpha work item"), "projA sees its own rollup line");
  assert.ok(!a.includes("beta work item"), "projA does not see projB's rollup line");
  assert.ok(b.includes("beta work item"), "projB sees its own rollup line");
  assert.ok(!b.includes("alpha work item"), "projB does not see projA's rollup line");
});

test("relevanceScan: no project-attributable rollups → facts-only fallback (no cross-project rollup block)", async () => {
  const rows = [consentedTool()];
  const prompts = [];
  const t = 1_700_000_000_000;
  const eng = build({
    rows,
    getRollups: async () => [
      {
        level: "day",
        window: [t - 86_400_000, t],
        bullets: [{ text: "someone else's work", refs: ["seg-other"] }],
      },
    ],
    resolveSegment: async () => ({ project: "unrelated" }),
    runEphemeral: async ({ context }) => {
      prompts.push(context.map((c) => c.text).join("\n"));
      return { text: "0.5" };
    },
  });
  await eng.relevanceScan({ ts: t });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("ships the parser"), "the project's top facts still carried");
  assert.ok(!prompts[0].includes("Recent rollups"), "no cross-project rollup block leaks into the prompt");
});

// ---------------------------------------------------------------------------
// §10.5 A12 probe-health snapshot
// ---------------------------------------------------------------------------

test("healthSnapshot: counts configured vs healthy vs auth-failed probes", async () => {
  const eng = build({ http: async () => ({ status: 401, bodyText: "" }) });
  await eng.runDue({ forceTool: "github" });
  const snap = await eng.healthSnapshot();
  assert.equal(snap.tools, 1);
  assert.equal(snap.probes, 1);
  assert.equal(snap.healthy, 0);
  assert.equal(snap.authFailed, 1);
  assert.ok(snap.lastRunAt > 0);
});

test("healthSnapshot: an unconsented tool's spec never counts", async () => {
  const eng = build({
    rows: [{ tool: "github", consent: { metadata: null, deep_read: null, write: null }, evidence: [] }],
  });
  const snap = await eng.healthSnapshot();
  assert.equal(snap.tools, 0);
  assert.equal(snap.probes, 0);
});

// ---------------------------------------------------------------------------
// ctoHealth row composition
// ---------------------------------------------------------------------------

test("computeHealthStats: the probe-health row renders healthy/auth counts, collects before the first run", async () => {
  const { computeHealthStats } = await import("./ctoHealth.mjs");
  const ran = await computeHealthStats({ probesRead: async () => ({ tools: 1, probes: 2, healthy: 1, authFailed: 1, lastRunAt: 1 }) });
  const rowRan = ran.stats.find((s) => s.id === "probeHealth");
  assert.equal(rowRan.n, 2);
  assert.equal(rowRan.value, "1/2 probes healthy · 1 auth-failed");
  const fresh = await computeHealthStats({ probesRead: async () => ({ tools: 1, probes: 1, healthy: 0, authFailed: 0, lastRunAt: null }) });
  const rowFresh = fresh.stats.find((s) => s.id === "probeHealth");
  assert.equal(rowFresh.value, null);
  assert.equal(rowFresh.collectingText, "configured — waiting for first run");
  const none = await computeHealthStats({ probesRead: async () => null });
  const rowNone = none.stats.find((s) => s.id === "probeHealth");
  assert.equal(rowNone.n, 0);
});

// ---------------------------------------------------------------------------
// §10.6-7 card copy
// ---------------------------------------------------------------------------

test("probeBlockerCopy names the key + the secrets surface; titles name the rotation", () => {
  const withKey = probeBlockerCopy("github", "repo_events", "GITHUB_TOKEN");
  assert.match(withKey.title, /github/);
  assert.match(withKey.title, /rotated/);
  assert.match(withKey.body, /GITHUB_TOKEN/);
  assert.match(withKey.body, /secrets surface/);
  const noKey = probeBlockerCopy("gitlab", "issues");
  assert.match(noKey.body, /secrets surface/);
  assert.ok(!noKey.body.includes("GITHUB_TOKEN"), "no cross-tool key leakage");
});

test("probeBlockerCopy names the REAL secrets surface (the chat SecretsCard), never Settings → Secrets (BET-1443)", () => {
  const withKey = probeBlockerCopy("github", "repo_events", "GITHUB_TOKEN");
  const noKey = probeBlockerCopy("gitlab", "issues");
  for (const copy of [withKey, noKey]) {
    // The real surface: the 🔑 secrets card in the chat session (the
    // BET-1437 deep-link target — probeSecretKey still parses the key name
    // from the "on the secrets surface" phrase).
    assert.match(copy.body, /secrets card/);
    assert.match(copy.body, /chat session/);
    assert.ok(!copy.body.includes("Settings"), "no phantom Settings → Secrets section");
  }
});

// ---------------------------------------------------------------------------
// Registry vitality fold (§7.3 math) — through the real registry
// ---------------------------------------------------------------------------

test("registry applyProbeResult: folds inflow into an EWMA, adapts the cadence memory, flips candidate→integrated", async () => {
  const { createToolRegistry } = await import("./ctoToolRegistry.mjs");
  const reg = createToolRegistry({
    registryStore: memStore({
      v: 1,
      tools: [
        {
          tool: "github",
          status: "candidate",
          consent: { metadata: "yes", deep_read: null, write: null },
          evidence: [{ channel: "config", detail: "git:api.github.com", ts: 1 }],
        },
      ],
    }),
    now: () => 1_700_000_000_000,
  });
  const t0 = 1_700_000_000_000;
  const cadence = 30 * 60_000;
  // first sample: 4 new items in the spec cadence → per-week rate
  const r1 = await reg.applyProbeResult("github", { fields: { inflow_rate: 4, last_event: "2026-08-20T00:00:00Z" }, probedAt: t0, cadenceMs: cadence });
  assert.equal(r1.ok, true);
  assert.equal(r1.flipped, true, "candidate → integrated on first success");
  const v1 = r1.vitality;
  const rate1 = (4 * 7 * 24 * 3_600_000) / cadence;
  assert.ok(Math.abs(v1.ewma - rate1) < 1e-9, `ewma starts at the first rate (${v1.ewma} vs ${rate1})`);
  assert.equal(v1.last_event, "2026-08-20T00:00:00Z");
  // second sample 1h later: 0 new items → decayed EWMA, silence trend
  const r2 = await reg.applyProbeResult("github", { fields: { inflow_rate: 0 }, probedAt: t0 + 3_600_000, cadenceMs: cadence });
  assert.ok(r2.vitality.ewma < v1.ewma, "EWMA decays toward 0 on silence");
  assert.ok(r2.vitality.ewma > 0, "EWMA never jumps to zero in one sample");
  assert.equal(r2.flipped, false);
  // the row is integrated now
  const row = await reg.toolRow("github");
  assert.equal(row.status, "integrated");
  assert.equal(row.vitality.inflow_rate, 0);
});

test("registry applyProbeResult: unknown tool is rejected; relevance + evidence writers behave", async () => {
  const { createToolRegistry } = await import("./ctoToolRegistry.mjs");
  const reg = createToolRegistry({
    registryStore: memStore({
      v: 1,
      tools: [{ tool: "github", status: "observed", consent: { metadata: "yes", deep_read: null, write: null }, evidence: [] }],
    }),
  });
  assert.equal((await reg.applyProbeResult("nope", { fields: {}, probedAt: 1 })).ok, false);
  assert.equal((await reg.applyRelevance("github", "proj", 0.9)).ok, true);
  assert.equal((await reg.toolRow("github")).relevance.proj, 0.9);
  assert.equal((await reg.applyRelevance("github", "proj", 42)).ok, true, "out-of-range scores clamp, not refuse");
  assert.equal((await reg.toolRow("github")).relevance.proj, 1);
  assert.equal((await reg.applyRelevance("github", "proj", Number.NaN)).ok, false, "non-finite scores refused");
  const ev = await reg.appendEvidence("github", { channel: "probe", detail: "repo_events:http_500", ts: 5 });
  assert.equal(ev.ok, true);
  const dedup = await reg.appendEvidence("github", { channel: "probe", detail: "repo_events:http_500", ts: 6 });
  assert.equal(dedup.changed, false, "same (channel, detail) is deduped");
});

// ---------------------------------------------------------------------------
// defaultHttpRequest connect path — pinned lookup reaches the validated host
// ---------------------------------------------------------------------------

test("defaultHttpRequest: the pinned lookup is consulted (spy) and connect failures are socket/timeout — never a private-DNS miss", async () => {
  const looked = [];
  await assert.rejects(
    defaultHttpRequest({
      url: "https://93.184.216.34.nip.io/x",
      dnsLookup: (h, o, cb) => {
        looked.push(h);
        cb(null, [{ address: "93.184.216.34", family: 4 }]);
      },
    }),
    (e) => ["socket", "timeout"].includes(e.code),
  );
  assert.deepEqual(looked, ["93.184.216.34.nip.io"], "the pinned custom lookup was consulted exactly once");
});

// ---------------------------------------------------------------------------
// helpers shared with the registry tests
// ---------------------------------------------------------------------------

function memStore(initial = {}) {
  let state = { ...initial };
  return {
    load: async () => ({ ...state }),
    save: async (next) => {
      state = { ...next };
    },
    _state: () => state,
  };
}

// ---------------------------------------------------------------------------
// BET-1404 — deep-ring probes for deep-consented tools (characterization) +
// the §7.6 decay chain's weekly probing cap
// ---------------------------------------------------------------------------

test("runDue: a deep-ring probe runs for a deep-consented tool; a metadata-only tool never runs it", async () => {
  const deepSpec = () => {
    const s = githubSpec();
    s.probes[0].ring = "deep_read";
    return s;
  };
  // deep-consented → the probe runs
  const deep = build({
    rows: [{ ...consentedTool(), consent: { metadata: "yes", deep_read: "yes", write: null } }],
    specs: { github: deepSpec() },
  });
  const results = await deep.runDue();
  assert.equal(results.length, 1, "deep-consented tool runs its deep-ring probe");
  assert.equal(results[0].ok, true);
  // metadata-only consent → the runner re-checks the live source of truth and skips
  const meta = build({
    rows: [consentedTool()],
    specs: { github: deepSpec() },
  });
  assert.equal((await meta.runDue()).length, 0, "no deep probe without deep consent");
});

test("runDue: revoking deep consent stops the deep probe but the metadata probe still runs", async () => {
  const s = githubSpec();
  s.probes = [
    { name: "meta_probe", method: "GET", url: "https://api.github.com/users/octocat/events", extract: { inflow_rate: "length" }, cadence: "30m", ring: "metadata" },
    { name: "deep_probe", method: "GET", url: "https://api.github.com/users/octocat/events/full", extract: { inflow_rate: "length" }, cadence: "30m", ring: "deep_read" },
  ];
  const eng = build({
    rows: [{ ...consentedTool(), consent: { metadata: "yes", deep_read: "no", write: null } }],
    specs: { github: s },
  });
  const results = await eng.runDue();
  assert.equal(results.length, 1);
  assert.equal(results[0].probe, "github/meta_probe", "only the metadata probe ran");
});

test("runOne: a chain-tripped tool's probing cadence is capped at weekly (registry is the chain's source of truth)", async () => {
  const base = fakeRegistry([{ ...consentedTool(), asSourceDecayed: true }]);
  const eng = createProbes({
    registry: {
      ...base,
      probeCadenceCapMs: async (tool) => (tool === "github" ? CADENCE_WEEKLY_MS : null),
    },
    probes: memProbesStore({ github: githubSpec() }),
    stateStore: memStateStore(),
    cards: fakeCards(),
    ledger: fakeLedger(),
    now: () => 1_700_000_000_000,
    httpRequest: async () => ({ status: 200, bodyText: JSON.stringify([{ created_at: "2026-08-20T00:00:00Z" }]) }),
    getSecretPath: async () => "/tmp/secret-file",
    readSecret: async () => "sekrit-value",
    isThrifty: () => false,
    listProjects: async () => ["proj"],
    getTopFacts: async () => [],
    getRollups: async () => [],
    runEphemeral: null,
  });
  const results = await eng.runDue();
  assert.equal(results.length, 1);
  const st = await eng.loadToolState("github");
  assert.equal(st.probes.repo_events.nextRunAt, 1_700_000_000_000 + CADENCE_WEEKLY_MS, "30m spec capped at weekly while decayed");
});

// ---------------------------------------------------------------------------
// BET-1438 — the §7.5 authoring pass: parseProposedProbes + authorSpecs
// ---------------------------------------------------------------------------

// A standalone harness for the authoring pass: keeps the raw store/state/
// ledger/registry references so the tests can assert what landed on disk.
function authoringHarness({ rows = [consentedTool()], specs, runEphemeral = null, nowTs = 1_700_000_000_000 } = {}) {
  const scaffold = (tool) => ({ tool, probes: [] });
  const store = memProbesStore(specs ?? { github: { ...scaffold("github"), auth: githubSpec().auth } });
  const state = memStateStore();
  const ledger = fakeLedger();
  const registry = fakeRegistry(rows);
  const calls = [];
  const eng = createProbes({
    registry,
    probes: store,
    stateStore: state,
    cards: fakeCards(),
    ledger,
    now: () => nowTs,
    httpRequest: async () => ({ status: 200, bodyText: "[]" }),
    getSecretPath: async () => "/tmp/secret-file",
    readSecret: async () => "v",
    isThrifty: () => false,
    listProjects: async () => ["proj"],
    getTopFacts: async () => [],
    getRollups: async () => [],
    runEphemeral: runEphemeral
      ? async (opts) => {
          calls.push(opts);
          return runEphemeral(opts);
        }
      : null,
  });
  return { eng, store, state, ledger, registry, calls };
}

test("parseProposedProbes: fences + prose tolerated, unknown keys stripped, GET forced, ring defaults down, cap 5", () => {
  const reply = [
    "Here is my proposal:",
    "```json",
    JSON.stringify([
      { name: "repo_events", url: "https://api.github.com/x", cadence: "30m", ring: "metadata", extract: { a: "0.b" }, surprise: true },
      { name: "bad", url: "https://api.github.com/y", cadence: "10m", ring: "deep_read", method: "DELETE" },
      { url: "https://api.github.com/z", cadence: "1h" },
    ]),
    "```",
    "Hope that helps!",
  ].join("\n");
  const out = parseProposedProbes(reply);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { name: "repo_events", url: "https://api.github.com/x", cadence: "30m", ring: "metadata", extract: { a: "0.b" }, method: "GET" });
  assert.equal(out[1].method, "GET", "a model-proposed method is never trusted");
  assert.equal(out[1].ring, "deep_read");
  assert.ok(!("surprise" in out[0]), "unknown keys are stripped before the validator ever sees them");
  assert.equal(parseProposedProbes(JSON.stringify([{ name: "b", url: "https://api.github.com/x", cadence: "1h" }]))[0].ring, "metadata", "omitted ring defaults DOWN to metadata");
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, url: "https://api.github.com/x", cadence: "1h" }));
  assert.equal(parseProposedProbes(JSON.stringify(many)).length, AUTHOR_MAX_PROBES);
  assert.deepEqual(parseProposedProbes("[]"), [], "an empty array is a valid 'nothing derivable' answer");
  assert.equal(parseProposedProbes("I cannot help with that."), null);
  assert.equal(parseProposedProbes(null), null);
});

test("authorSpecs: fills an empty scaffold through writeSpec — probe lands, auth preserved, prompt carries hosts + key name, ledger row, state ok", async () => {
  let sawPrompt = "";
  const h = authoringHarness({
    runEphemeral: async ({ context }) => {
      sawPrompt = context[0].text;
      return { text: JSON.stringify([{ name: "repo_events", url: "https://api.github.com/users/octocat/events", cadence: "30m", ring: "metadata", extract: { inflow_rate: "length" } }]) };
    },
  });
  const r = await h.eng.authorSpecs({ ts: 1_700_000_000_000 });
  assert.deepEqual(r, { ran: 1, attempts: 1 });
  const spec = h.store._files.github;
  assert.equal(spec.probes.length, 1);
  assert.equal(spec.probes[0].method, "GET");
  assert.equal(spec.probes[0].url, "https://api.github.com/users/octocat/events");
  assert.deepEqual(spec.auth, githubSpec().auth, "the engine-written auth section is preserved verbatim");
  assert.ok(sawPrompt.includes("api.github.com"), "the prompt carries the evidenced hosts");
  assert.ok(sawPrompt.includes("GITHUB_TOKEN"), "the prompt names the evidenced vault key (a KEY NAME, never a value)");
  assert.ok(sawPrompt.includes('ring "metadata"'));
  assert.ok(h.ledger.rows.some((row) => row.kind === "cto.probe.author" && row.tool === "github" && row.ok === true && row.probes === 1));
  const st = await h.state.load("_authoring");
  assert.equal(st.relAt.github.ok, true);
  assert.equal(st.todayCount, 1);
});

test("authorSpecs: refused proposal (off-allowlist host) surfaces as evidence on the tool row; template left empty", async () => {
  const h = authoringHarness({
    runEphemeral: async () => ({ text: JSON.stringify([{ name: "exfil", url: "https://evil.example.com/x", cadence: "30m", ring: "metadata" }]) }),
  });
  const r = await h.eng.authorSpecs({ ts: 1_700_000_000_000 });
  assert.deepEqual(r, { ran: 0, attempts: 1 });
  assert.equal(h.store._files.github.probes.length, 0, "the refused candidate never lands");
  const row = h.registry._rows.get("github");
  const refusal = (row.evidence ?? []).find((e) => e.channel === "probe");
  assert.ok(refusal, "the refusal is on the tool's evidence trail");
  assert.equal(refusal.detail, "spec-refused:probes[0].url");
  assert.ok(h.ledger.rows.some((x) => x.kind === "cto.probe.author" && x.ok === false && x.refused === "probes[0].url"));
  const st = await h.state.load("_authoring");
  assert.equal(st.relAt.github.ok, false, "a refused fill retries on the failure watermark");
});

test("authorSpecs: unparseable reply → evidence row + failure watermark; no write, no re-attempt until the watermark elapses", async () => {
  const h = authoringHarness({ runEphemeral: async () => ({ text: "I could not derive any probes." }) });
  let r = await h.eng.authorSpecs({ ts: 1_700_000_000_000 });
  assert.deepEqual(r, { ran: 0, attempts: 1 });
  const row = h.registry._rows.get("github");
  assert.ok((row.evidence ?? []).some((e) => e.detail === "spec-refused:unparseable-reply"));
  assert.equal(h.store._files.github.probes.length, 0);
  // failure watermark: a minute later nothing is re-attempted…
  r = await h.eng.authorSpecs({ ts: 1_700_000_000_000 + 60_000 });
  assert.deepEqual(r, { ran: 0, attempts: 0 });
  assert.equal(h.calls.length, 1);
  // …but after the watermark elapses the pass runs again
  r = await h.eng.authorSpecs({ ts: 1_700_000_000_000 + AUTHORING_FAILURE_RETRY_MS });
  assert.deepEqual(r, { ran: 0, attempts: 1 });
  assert.equal(h.calls.length, 2);
});

test("authorSpecs: empty model array rests for the week with no write and no evidence noise", async () => {
  const h = authoringHarness({ runEphemeral: async () => ({ text: "[]" }) });
  const r = await h.eng.authorSpecs({ ts: 1_700_000_000_000 });
  assert.deepEqual(r, { ran: 0, attempts: 1 });
  assert.equal(h.store._files.github.probes.length, 0);
  const row = h.registry._rows.get("github");
  assert.equal((row.evidence ?? []).filter((e) => e.channel === "probe").length, 0, "no refusal row — an ok-but-empty pass stays silent on the trail");
  assert.ok(h.ledger.rows.some((x) => x.kind === "cto.probe.author" && x.ok === true && x.probes === 0));
  const r2 = await h.eng.authorSpecs({ ts: 1_700_000_000_000 + 3_600_000 });
  assert.deepEqual(r2, { ran: 0, attempts: 0 }, "an ok-but-empty pass rests for the week");
});

test("authorSpecs: one-shot — a filled spec is never rewritten; unconsented tools are skipped; no seam → skipped", async () => {
  const filled = authoringHarness({ specs: { github: githubSpec() }, runEphemeral: async () => ({ text: "[]" }) });
  assert.deepEqual(await filled.eng.authorSpecs({ ts: 1_700_000_000_000 }), { ran: 0, attempts: 0 });
  assert.equal(filled.calls.length, 0, "a spec that already carries probes is never touched");
  const unconsented = authoringHarness({
    rows: [{ ...consentedTool(), consent: { metadata: "no", deep_read: null, write: null } }],
    runEphemeral: async () => ({ text: "[]" }),
  });
  assert.deepEqual(await unconsented.eng.authorSpecs({ ts: 1_700_000_000_000 }), { ran: 0, attempts: 0 });
  assert.equal(unconsented.calls.length, 0);
  const noSeam = authoringHarness({});
  assert.deepEqual(await noSeam.eng.authorSpecs({ ts: 1_700_000_000_000 }), { ran: 0, attempts: 0, skipped: "no-ephemeral" });
});

test("authorSpecs: the daily attempt budget bounds the calls box-wide, not per tool", async () => {
  const tools = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const h = authoringHarness({
    rows: tools.map((tool) => consentedTool(tool, ["api.github.com"])),
    specs: Object.fromEntries(tools.map((tool) => [tool, { tool, probes: [] }])),
    runEphemeral: async () => ({ text: JSON.stringify([{ name: "p", url: "https://api.github.com/x", cadence: "1h", ring: "metadata" }]) }),
  });
  const r = await h.eng.authorSpecs({ ts: 1_700_000_000_000 });
  assert.equal(r.attempts, 4, "only AUTHORING_PER_DAY attempts are made");
  assert.equal(h.calls.length, 4);
  const r2 = await h.eng.authorSpecs({ ts: 1_700_000_000_000 + 60_000 });
  assert.deepEqual(r2, { ran: 0, attempts: 0 }, "the budget is spent for the day");
  const r3 = await h.eng.authorSpecs({ ts: 1_700_000_000_000 + 24 * 3_600_000 });
  assert.equal(r3.attempts, 2, "the next day fills the remaining templates");
  assert.deepEqual(r3, { ran: 2, attempts: 2 });
});
