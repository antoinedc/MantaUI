#!/usr/bin/env node
// LIVE proof of the "1 hour cache => HTTP 400 'Found 5'" fix, on the pinned
// OpenCode V2 binary, with a plain ANTHROPIC_API_KEY (NOT Claude Max).
//
//   ANTHROPIC_API_KEY="$(cat ~/.manta-secrets/ANTHROPIC_API_KEY)" \
//     node scripts/opencode-v2/cache-breakpoints.e2e.mjs        (opt-in; a few cents of Haiku)
//
// Two sandboxes, same config (`options.cacheControl` = {ephemeral, 1h} on the model,
// exactly what Manta's "1 hour prompt cache" setting writes), same tool-using turn
// (shell `echo hi`):
//   A. WITHOUT manta-claude-max  → reproduces the 400 (proves the bug is real)
//   B. WITH    manta-claude-max  → the turn succeeds; the outgoing body has <= 4
//                                  breakpoints, all ttl 1h, no top-level cache_control
// The capture plugin loads LAST, so it records the FINAL body each plugin produced.
//
// SAFETY: sandbox only (sandbox.mjs: own HOME/XDG, free port, minimal env); the plugin's
// seat lookups go to a fake manta-server, never :8787; the live opencode (:4096) is never
// contacted. No Claude Max credential is used or copied. The key is passed by env and
// never printed (the capture plugin records an x-api-key PRESENCE flag only).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startFakeMantaServer } from "./fake-manta-server.mjs";
import { createCleanupGuard } from "./live-creds.mjs";
import { OPENCODE_V2_VERSION } from "./version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CLAUDE_MAX = join(ROOT, "docs", "opencode-plugins-v2", "manta-claude-max");
const CAPTURE = join(HERE, "harness-capture-plugin.ts");
const MODEL = process.env.CACHE_E2E_MODEL || "claude-haiku-5-5";
const TOKEN = "cd34".repeat(8); // fake manta-server bearer (not a secret)

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("SKIP cache-breakpoints e2e — ANTHROPIC_API_KEY not set.");
  process.exit(0);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${String(detail).slice(0, 800)}` : ""}`);
}

/** Every block-level breakpoint in a request body (everything but the top-level key). */
function breakpoints(body) {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === "object") {
      if (x.cache_control) out.push(x.cache_control);
      for (const [k, v] of Object.entries(x)) if (k !== "cache_control") walk(v);
    }
  };
  const { cache_control: _top, ...rest } = body ?? {};
  walk(rest);
  return out;
}

const guard = createCleanupGuard();
const scratch = mkdtempSync(join(tmpdir(), "manta-v2-cache-e2e-"));
guard.add(scratch);
let fake;
let sb;

async function runPhase(label, { binary, plugins }) {
  const capture = join(scratch, `${label}.capture.jsonl`);
  const config = { provider: { anthropic: { models: { [MODEL]: { options: { cacheControl: { type: "ephemeral", ttl: "1h" } } } } } } };
  sb = await startSandbox({
    binary,
    plugins,
    config,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      MANTA_CAPTURE_FILE: capture,
      MANTA_SERVER_URL: fake.url,
      MANTA_ACCOUNTS_SERVER: fake.url,
      MANTA_BOX_TOKEN: TOKEN,
      MANTA_CLAUDE_MAX_DEBUG: "1",
    },
    onRoot: (r) => guard.add(r),
  });
  try {
    const api = async (method, path, body) => {
      const res = await fetch(sb.url + path, {
        method,
        headers: { authorization: sb.auth, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      return data;
    };
    const models = (await api("GET", "/api/model")).data ?? [];
    if (!models.some((m) => m.providerID === "anthropic" && m.id === MODEL)) {
      throw new Error(`model ${MODEL} not offered (API key rejected or catalogue changed): ${models.filter((m) => m.providerID === "anthropic").map((m) => m.id).join(", ")}`);
    }
    const sid = (await api("POST", "/api/session", { location: { directory: sb.projectDir }, model: { providerID: "anthropic", id: MODEL } })).data.id;
    if (label === "with-plugin") {
      const plugs = (await api("GET", `/api/plugin?location[directory]=${encodeURIComponent(sb.projectDir)}`)).data ?? [];
      check("manta.claude-max loaded and active (API-key auth mode)", plugs.find((p) => p.id === "manta.claude-max")?.state?.status === "active", JSON.stringify(plugs.map((p) => [p.id, p.state?.status])));
    }
    await api("POST", `/api/session/${sid}/prompt`, { text: "Use your shell tool to run exactly: echo hi\nThen reply with the single word DONE." });
    await Promise.race([
      api("POST", `/api/experimental/session/${sid}/wait`),
      new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out after 120s")), 120_000)),
    ]);
    const msgs = (await api("GET", `/api/session/${sid}/message?limit=60`)).data;
    const session = (await api("GET", `/api/session/${sid}`)).data;
    const records = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { msgs, records, cost: session.cost ?? 0, sid };
  } finally {
    await sb.stop();
    sb = undefined;
  }
}

let spend = 0;
try {
  console.log(`opencode V2 ${OPENCODE_V2_VERSION} - cache_control "Found 5" fix, API key, model ${MODEL}`);
  const binary = await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) });
  fake = await startFakeMantaServer({
    token: TOKEN,
    handle: (r) => (r.pathname === "/api/accounts/resolve" ? { status: 200, body: { seatId: null, live: true } } : undefined),
  });

  // ---------------- A: WITHOUT the plugin -> the bug
  console.log("\n[A] 1h cacheControl, NO plugin: tool turn must hit the 400");
  const a = await runPhase("no-plugin", { binary, plugins: [{ src: CAPTURE, name: "zz-harness-capture.ts" }] });
  spend += a.cost;
  const aReqs = a.records.filter((r) => r.t === "request");
  const aRes = a.records.filter((r) => r.t === "response");
  const aTool = aReqs.find((r) => breakpoints(r.body).length + (r.body?.cache_control ? 1 : 0) > 4);
  check("outgoing request carries a top-level cache_control AND block breakpoints (5 total)", aTool && aTool.body.cache_control && breakpoints(aTool.body).length === 4, JSON.stringify(aReqs.map((r) => [!!r.body?.cache_control, breakpoints(r.body).length])));
  check("Anthropic answered HTTP 400", aRes.some((r) => r.status === 400), JSON.stringify(aRes.map((r) => r.status)));
  const aErr = JSON.stringify(a.msgs);
  console.log(`      turn outcome: ${a.msgs.find((m) => m.type === "idle")?.outcome}; error text mentions "Found 5": ${/Found 5/.test(aErr)}`);
  check('error text reads "Found 5" cache_control blocks', /Found 5/.test(aErr), aErr.slice(0, 500));

  // ---------------- B: WITH the plugin -> fixed
  console.log("\n[B] 1h cacheControl, WITH manta-claude-max: same turn must succeed");
  const b = await runPhase("with-plugin", { binary, plugins: [{ src: CLAUDE_MAX, name: "manta-claude-max" }, { src: CAPTURE, name: "zz-harness-capture.ts" }] });
  spend += b.cost;
  const bReqs = b.records.filter((r) => r.t === "request");
  const bRes = b.records.filter((r) => r.t === "response");
  check("turn succeeded", b.msgs.find((m) => m.type === "idle")?.outcome === "succeeded", JSON.stringify(b.msgs.slice(-3)).slice(0, 500));
  check("every Anthropic response was 200 (incl. the post-tool request)", bRes.length >= 2 && bRes.every((r) => r.status === 200), JSON.stringify(bRes.map((r) => r.status)));
  const sawShell = JSON.stringify(b.msgs).includes("echo hi");
  check("the shell tool actually ran (echo hi)", sawShell);
  // (?beta=true is OpenCode's own; the A run, with no plugin, carries it too - compared below)
  check("API-key auth preserved: x-api-key kept, no Bearer injected, URL identical to the no-plugin run", bReqs.every((r) => r.hasApiKey === true && r.authSha12 === null) && JSON.stringify(bReqs.map((r) => r.url)) === JSON.stringify(aReqs.map((r) => r.url)), JSON.stringify({ with: bReqs.map((r) => [r.hasApiKey, r.authSha12, r.url]), without: aReqs.map((r) => r.url) }));
  check("no top-level cache_control on any outgoing request", bReqs.every((r) => !r.body?.cache_control), JSON.stringify(bReqs.map((r) => r.body?.cache_control)));
  check("<= 4 block breakpoints per request, at least one on the tool-bearing ones", bReqs.every((r) => breakpoints(r.body).length <= 4) && bReqs.some((r) => breakpoints(r.body).length >= 1), JSON.stringify(bReqs.map((r) => breakpoints(r.body).length)));
  check("every breakpoint is ephemeral ttl 1h", bReqs.every((r) => breakpoints(r.body).every((c) => c.type === "ephemeral" && c.ttl === "1h")), JSON.stringify(bReqs.map((r) => breakpoints(r.body))));
  console.log(`      breakpoints per request: ${JSON.stringify(bReqs.map((r) => breakpoints(r.body).length))}`);
} catch (e) {
  check("harness ran to completion", false, e?.stack ?? e);
} finally {
  if (sb) await sb.stop().catch(() => {});
  if (fake) await fake.stop().catch(() => {});
  console.log(`\nspend: $${spend.toFixed(4)} (session cost as reported by opencode)`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
