#!/usr/bin/env node
// LIVE end-to-end proof of `manta-claude-max` + `manta-optimizer` on the pinned
// OpenCode V2 binary, with REAL Claude Max subscription turns.
//
//   npm run test:opencode-v2:max        (opt-in — spends a few cents of subscription quota)
//
// SAFETY (the user's real Claude login must never break):
//   * the sandbox gets an ACCESS-TOKEN-ONLY copy (accessToken + expiresAt +
//     subscriptionType + scopes — never the refresh token), mode 0600, inside the
//     sandbox temp dir; the run aborts if the token expires in < 20 min
//   * every copy is deleted on every exit path (finally, exit, SIGINT, SIGTERM)
//   * the fake manta-server answers /api/accounts/refresh with an ERROR, so the
//     plugin can never rotate a real token; the sandbox could not anyway
//   * the live opencode (:4096) and manta-server (:8787) are never contacted; token
//     values are never printed (sha12 at most)

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startFakeMantaServer } from "./fake-manta-server.mjs";
import { createCleanupGuard, liveCredentialsPath, readAccessOnly, seatCredentialsPath, sha12 } from "./live-creds.mjs";
import { OPENCODE_V2_VERSION } from "./version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CLAUDE_MAX = join(ROOT, "docs", "opencode-plugins-v2", "manta-claude-max");
const OPTIMIZER = join(ROOT, "docs", "opencode-plugins-v2", "manta-optimizer");
const CAPTURE = join(HERE, "harness-capture-plugin.ts");
const HAIKU = "claude-haiku-5-5";
const OPUS = "claude-opus-5-5";
const TOKEN = "ab12".repeat(8); // fake manta-server bearer (not a secret)
const CLI_VERSION = "2.1.280";
const STALE_VERSION = "2.1.100";
const SPEND_CAP_USD = 1.5;
const BUSY_UTILIZATION = 90; // % of the 5 h window above which an account is not used

if (!process.env.MANTA_E2E_FORCE && !existsOrNull(liveCredentialsPath())) {
  console.log("SKIP test:opencode-v2:max — no ~/.claude/.credentials.json on this box.");
  process.exit(0);
}
function existsOrNull(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- reporting
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${String(detail).slice(0, 600)}` : ""}`);
}
const j = (v) => JSON.stringify(v) ?? "undefined";

// ------------------------------------------------------- credential choosing
/** 5 h utilization of an access token (read-only usage call), or null. */
async function utilization(accessToken) {
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": `claude-cli/${CLI_VERSION} (external, sdk-cli)`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const u = (await r.json())?.five_hour?.utilization;
    return typeof u === "number" ? u : null;
  } catch {
    return null;
  }
}

/** Access-token-only candidates: the live login + every seat (never refresh tokens). */
async function candidates() {
  const out = [];
  const add = async (label, path) => {
    try {
      const creds = readAccessOnly(path); // throws when < 20 min left
      out.push({ label, creds, util: await utilization(creds.claudeAiOauth.accessToken) });
    } catch (e) {
      out.push({ label, creds: null, why: String(e.message ?? e) });
    }
  };
  await add("live login", liveCredentialsPath());
  let seats = [];
  try {
    seats = readdirSync(join(homedir(), ".manta-secrets", "accounts", "claude")).filter((s) => s.startsWith("seat-"));
  } catch {
    /* no seats on this box */
  }
  for (const s of seats) await add(s, seatCredentialsPath(s));
  return out;
}

// ----------------------------------------------------------------- the run
const guard = createCleanupGuard();
const scratch = mkdtempSync(join(tmpdir(), "manta-v2-max-e2e-"));
guard.add(scratch);
let sb;
let sb2;
let fake;
const costs = [];
let tracked = [];

try {
  console.log(`opencode V2 ${OPENCODE_V2_VERSION} — manta-claude-max + manta-optimizer live e2e`);
  const binary = await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) });

  // ---- choose credentials (no token value is ever printed)
  const all = await candidates();
  for (const c of all) console.log(`[creds] ${c.label}: ${c.creds ? `usable, 5h util ${c.util ?? "?"}%` : `unusable (${c.why})`}`);
  const usable = all.filter((c) => c.creds && (c.util ?? 0) < BUSY_UTILIZATION);
  const liveCand = all.find((c) => c.label === "live login");
  let login = liveCand?.creds && (liveCand.util ?? 0) < BUSY_UTILIZATION ? liveCand : null;
  let loginNote = "the live login";
  if (!login) {
    login = [...usable].sort((a, b) => (a.util ?? 0) - (b.util ?? 0))[0];
    loginNote = login ? `${login.label} (stand-in: the live login's 5h window is exhausted/unreadable)` : "";
  }
  if (!login) throw new Error("no Claude credential with quota left and >= 20 min of token life — refusing to run");
  console.log(`[creds] single-login source: ${loginNote}`);
  const pool = usable.filter((c) => c.label !== login.label).sort((a, b) => (a.util ?? 0) - (b.util ?? 0));
  const seatA = pool[0] ?? login;
  const seatB = pool[1] ?? login;
  const distinctSeats = seatA.creds.claudeAiOauth.accessToken !== seatB.creds.claudeAiOauth.accessToken;
  console.log(`[creds] seats for the per-session proof: ${seatA.label} / ${seatB.label} (${distinctSeats ? "two DISTINCT real tokens" : "SAME token under two seat files"})`);

  const tokOf = (c) => c.creds.claudeAiOauth.accessToken;
  const credFile = (c) => ({ content: JSON.stringify(c.creds) });
  const loginSha = sha12(tokOf(login));
  const seatASha = sha12(tokOf(seatA));
  const seatBSha = sha12(tokOf(seatB));

  // ---- fake manta-server: seat map controlled by the test; refresh ALWAYS errors
  const seatMap = new Map(); // sessionID -> seat name
  const policy = { value: { enabled: false } };
  const seatDir = (name) => join(sbRoot(), "home", ".manta-secrets", "accounts", "claude", name, ".credentials.json");
  let rootRef = "";
  const sbRoot = () => rootRef;
  fake = await startFakeMantaServer({
    token: TOKEN,
    handle: (r) => {
      if (r.pathname === "/api/accounts/resolve") {
        const seat = seatMap.get(r.query.get("sessionID"));
        return seat
          ? { status: 200, body: { seatId: seat, live: false, credentialFile: seatDir(seat) } }
          : { status: 200, body: { seatId: null, live: true } };
      }
      if (r.pathname === "/api/optimizer/policy") return { status: 200, body: policy.value };
      return undefined;
    },
  });

  const files = [
    { path: "home/.claude/.credentials.json", ...credFile(login) },
    { path: "home/.manta-secrets/accounts/claude/seat-a/.credentials.json", ...credFile(seatA) },
    { path: "home/.manta-secrets/accounts/claude/seat-b/.credentials.json", ...credFile(seatB) },
  ];
  const plugins = [
    { src: CLAUDE_MAX, name: "manta-claude-max" },
    { src: OPTIMIZER, name: "manta-optimizer" },
    { src: CAPTURE, name: "zz-harness-capture.ts" },
  ];
  const capture = join(scratch, "capture.jsonl");
  const env = (version) => ({
    MANTA_CAPTURE_FILE: capture,
    MANTA_SERVER_URL: fake.url,
    MANTA_ACCOUNTS_SERVER: fake.url,
    MANTA_BOX_TOKEN: TOKEN,
    ANTHROPIC_CLI_VERSION: version,
    MANTA_CLAUDE_MAX_DEBUG: "1",
  });
  sb = await startSandbox({ binary, plugins, files, env: env(CLI_VERSION), onRoot: (r) => (rootRef = r, guard.add(r)) });
  console.log(`[sandbox] ${sb.url} (root ${sb.root})`);

  // ---- API helpers
  const api = (box) => async (method, path, body) => {
    const res = await fetch(box.url + path, {
      method,
      headers: { authorization: box.auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return data;
  };
  const call = api(sb);
  const newSession = async (box, model) => (await api(box)("POST", "/api/session", { location: { directory: box.projectDir }, model })).data.id;
  async function turn(box, sessionID, text) {
    const c = api(box);
    await c("POST", `/api/session/${sessionID}/prompt`, { text });
    await Promise.race([
      c("POST", `/api/experimental/session/${sessionID}/wait`),
      new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out after 120s")), 120_000)),
    ]);
    return (await c("GET", `/api/session/${sessionID}/message?limit=60`)).data;
  }
  const assistantText = (msgs) =>
    msgs
      .filter((m) => m.type === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  const idleOf = (msgs) => msgs.find((m) => m.type === "idle");
  const records = () =>
    readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const requestsFor = (sid) => records().filter((r) => r.t === "request" && r.sessionID === sid);
  const cost = async (box, id) => {
    const c = (await api(box)("GET", `/api/session/${id}`)).data.cost ?? 0;
    costs.push(c);
    return c;
  };

  // ================================================================ 1. loads
  console.log("\n[1] plugins load; provider usable with NO API key");
  const models = (await call("GET", "/api/model")).data ?? [];
  const anth = models.filter((m) => m.providerID === "anthropic");
  check(
    "anthropic models are selectable with no ANTHROPIC_API_KEY (ctx.provider.transform, no config apiKey sentinel)",
    anth.length > 0 && !process.env.ANTHROPIC_API_KEY && anth.some((m) => m.id === HAIKU) && anth.some((m) => m.id === OPUS),
    `${anth.length} anthropic models`,
  );

  // ================================================================ 2. Haiku
  console.log("\n[2] Haiku turn on the subscription");
  const sHaiku = await newSession(sb, { providerID: "anthropic", id: HAIKU });
  // plugin instances load per location, lazily — list once a session exists there
  const plugs = (await call("GET", `/api/plugin?location[directory]=${encodeURIComponent(sb.projectDir)}`)).data ?? [];
  const byId = (id) => plugs.find((p) => p.id === id);
  check("manta.claude-max is loaded and active", byId("manta.claude-max")?.state?.status === "active", j(plugs.filter((p) => !String(p.id).startsWith("opencode."))));
  check("manta.optimizer is loaded and active", byId("manta.optimizer")?.state?.status === "active", j(plugs.filter((p) => !String(p.id).startsWith("opencode."))));
  const mHaiku = await turn(sb, sHaiku, "Reply with exactly the single word: HAIKU_OK");
  check("Haiku turn succeeded and replied", idleOf(mHaiku)?.outcome === "succeeded" && /HAIKU_OK/.test(assistantText(mHaiku)), j(mHaiku.slice(0, 3)));
  const rq = requestsFor(sHaiku).find((r) => r.kind === "primary");
  check("request carried the login's Bearer (sha12 match), no x-api-key", rq?.authSha12 === loginSha && rq.hasApiKey === false, j({ got: rq?.authSha12, want: loginSha }));
  check("request claims Claude Code (UA + x-app + ?beta=true)", rq?.headers["user-agent"] === `claude-cli/${CLI_VERSION} (external, sdk-cli)` && rq.headers["x-app"] === "cli" && rq.url.endsWith("/v1/messages?beta=true"), j(rq?.headers));
  check(
    "body: billing header is system[0] and Claude Code identity is its own system entry",
    /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3};/.test(rq?.body?.system?.[0]?.text ?? "") &&
      rq.body.system[1]?.text === "You are Claude Code, Anthropic's official CLI for Claude.",
    j(rq?.body?.system?.map((s) => (s.text ?? "").slice(0, 60))),
  );
  check("tool names went out PascalCase mcp_-prefixed", (rq?.body?.tools ?? []).length > 0 && rq.body.tools.every((t) => /^mcp_[A-Z]/.test(t.name)), j(rq?.body?.tools?.map((t) => t.name)));
  check("haiku request has no effort (stripped)", rq?.body?.output_config?.effort === undefined);
  check("no manta-server /refresh call was ever made", !fake.requests.some((r) => r.pathname === "/api/accounts/refresh"));
  await cost(sb, sHaiku);

  // ================================================================ 3. Opus
  console.log("\n[3] Opus turn (version-gated model) on the subscription");
  const sOpus = await newSession(sb, { providerID: "anthropic", id: OPUS });
  const mOpus = await turn(sb, sOpus, "Reply with exactly the single word: OPUS_OK");
  check("Opus turn succeeded and replied", idleOf(mOpus)?.outcome === "succeeded" && /OPUS_OK/.test(assistantText(mOpus)), j(mOpus.slice(0, 2)));
  await cost(sb, sOpus);

  // ================================================================ 4. tools
  console.log("\n[4] tool round-trip through prefix / un-prefix (R1)");
  const sTool = await newSession(sb, { providerID: "anthropic", id: HAIKU });
  const mTool = await turn(sb, sTool, "Use the shell tool to run exactly: echo MANTA_ROUNDTRIP_7731. After it returns, reply with the word DONE.");
  const toolParts = mTool.filter((m) => m.type === "assistant").flatMap((m) => m.content ?? []).filter((p) => p.type === "tool");
  const shell = toolParts.find((p) => p.name === "shell");
  check(
    "the model's mcp_Shell call reached OpenCode as `shell` and ran",
    shell?.state?.status === "completed" && (shell.state.content ?? []).some((c) => /MANTA_ROUNDTRIP_7731/.test(c.text ?? "")),
    j(toolParts.map((p) => ({ n: p.name, s: p.state?.status }))),
  );
  check("no unresolved mcp_ tool name leaked to the transcript", !toolParts.some((p) => /^mcp_/.test(p.name)), j(toolParts.map((p) => p.name)));
  check("turn finished after the tool result", idleOf(mTool)?.outcome === "succeeded" && /DONE/.test(assistantText(mTool)), j(mTool.slice(0, 2)));
  const toolReqs = requestsFor(sTool).filter((r) => r.kind === "primary");
  const replayed = toolReqs.at(-1)?.body?.messages?.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_use");
  check("the replayed tool_use is re-prefixed on the follow-up request", replayed?.name === "mcp_Shell", j(replayed));
  await cost(sb, sTool);

  // ================================================================ 5. seats
  console.log(`\n[5] two sessions → two seats (${distinctSeats ? "two distinct real tokens" : "same token under two seat files — only one other real seat has quota"})`);
  const sA = await newSession(sb, { providerID: "anthropic", id: HAIKU });
  const sB = await newSession(sb, { providerID: "anthropic", id: HAIKU });
  seatMap.set(sA, "seat-a");
  seatMap.set(sB, "seat-b");
  const mA = await turn(sb, sA, "Reply with exactly the single word: SEAT_A_OK");
  const mB = await turn(sb, sB, "Reply with exactly the single word: SEAT_B_OK");
  check("session A succeeded", idleOf(mA)?.outcome === "succeeded" && /SEAT_A_OK/.test(assistantText(mA)), j(mA.slice(0, 2)));
  check("session B succeeded", idleOf(mB)?.outcome === "succeeded" && /SEAT_B_OK/.test(assistantText(mB)), j(mB.slice(0, 2)));
  const authA = new Set(requestsFor(sA).filter((r) => r.kind === "primary").map((r) => r.authSha12));
  const authB = new Set(requestsFor(sB).filter((r) => r.kind === "primary").map((r) => r.authSha12));
  check("A's request was signed with seat-a's token", authA.size === 1 && authA.has(seatASha), j([...authA]));
  check("B's request was signed with seat-b's token", authB.size === 1 && authB.has(seatBSha), j([...authB]));
  if (distinctSeats) check("the two sessions used DIFFERENT tokens", seatASha !== seatBSha);
  const resolves = fake.requests.filter((r) => r.pathname === "/api/accounts/resolve");
  check("resolve was asked per session with provider+sessionID+model and the box bearer", resolves.some((r) => r.query.sessionID === sA && r.query.provider === "claude" && r.query.model === HAIKU && r.authorization === `Bearer ${TOKEN}`), j(resolves.slice(0, 2)));
  await cost(sb, sA);
  await cost(sb, sB);

  // ================================================================ 6. optimizer
  console.log("\n[6] optimizer: policy enabled → masked tool output in the request + counterfactual report");
  policy.value = { enabled: true, maskAfterUses: 0, protectTailTokens: 0, batchTokens: 1 };
  const sOpt = await newSession(sb, { providerID: "anthropic", id: HAIKU });
  fake.reset();
  const mOpt = await turn(sb, sOpt, "Use the shell tool to run exactly: seq 1 60. Then, after it returns, reply with the word FINISHED.");
  check("optimizer turn finished", idleOf(mOpt)?.outcome === "succeeded", j(mOpt.slice(0, 2)));
  const optReqs = requestsFor(sOpt).filter((r) => r.kind === "primary");
  const toolResults = optReqs.flatMap((r) => (r.body?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))).filter((b) => b.type === "tool_result");
  const masked = toolResults.find((b) => JSON.stringify(b.content).includes("[manta: trimmed"));
  check("a tool_result in the outgoing request body is the masked placeholder", !!masked, j(toolResults.map((b) => JSON.stringify(b.content).slice(0, 80))));
  check("the placeholder names the tool and its arguments", String(masked?.content ?? "").includes('re-run `shell` with {"command":"seq 1 60"}'), j(masked));
  const cfs = fake.requests.filter((r) => r.pathname === "/api/optimizer/counterfactual");
  const applied = cfs.find((r) => r.body?.applied === true);
  check(
    "a counterfactual report reached manta-server (act mode, applied, model attributed, bearer)",
    !!applied && applied.body.sessionID === sOpt && applied.body.mode === "act" && applied.body.providerID === "anthropic" && applied.body.modelID === HAIKU && applied.body.maskedTokens > 0 && applied.authorization === `Bearer ${TOKEN}`,
    j(cfs.map((r) => r.body)),
  );
  await cost(sb, sOpt);
  policy.value = { enabled: false };

  // ============================================== 7. stale CLI version gating
  console.log(`\n[7] stale ANTHROPIC_CLI_VERSION=${STALE_VERSION} is rejected by Anthropic (version gate)`);
  sb2 = await startSandbox({
    binary,
    plugins: [{ src: CLAUDE_MAX, name: "manta-claude-max" }],
    files: [{ path: "home/.claude/.credentials.json", ...credFile(login) }],
    env: env(STALE_VERSION),
    onRoot: (r) => guard.add(r),
  });
  const sStale = await newSession(sb2, { providerID: "anthropic", id: OPUS });
  const mStale = await turn(sb2, sStale, "Reply with exactly the single word: STALE_OK");
  const idle = idleOf(mStale);
  const errText = j(idle?.error ?? "");
  check("the stale-version turn FAILED", idle?.outcome === "failed", j(mStale.slice(0, 2)));
  check(`the failure is Anthropic's version gate naming ${STALE_VERSION}`, new RegExp(`${STALE_VERSION.replaceAll(".", "\\.")}.*does not support this model|does not support this model.*${STALE_VERSION.replaceAll(".", "\\.")}`, "s").test(errText), errText);
  await sb2.stop().catch(() => {});
  sb2 = undefined;

  // ---- spend
  const total = costs.reduce((a, b) => a + b, 0);
  console.log(`\n[spend] session costs (subscription-equivalent API list price): ${costs.map((c) => `$${c.toFixed(4)}`).join(" + ")} = $${total.toFixed(4)}`);
  check(`total spend < $${SPEND_CAP_USD}`, total < SPEND_CAP_USD);
} catch (e) {
  check("e2e ran to completion", false, e?.stack ?? String(e));
} finally {
  for (const box of [sb, sb2]) await box?.stop().catch(() => {});
  if (fake) await fake.stop().catch(() => {});
  tracked = guard.paths();
  guard.run(); // sandbox credential copies + scratch: gone, whatever happened above
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
// belt and braces for the safety claim: nothing we created may still exist
const leftover = tracked.filter((p) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
});
console.log(leftover.length === 0 ? "credential cleanup: all sandbox copies removed" : `CREDENTIAL CLEANUP INCOMPLETE: ${leftover.join(", ")}`);
process.exit(failed.length || leftover.length ? 1 : 0);
