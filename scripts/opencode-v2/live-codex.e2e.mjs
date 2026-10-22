#!/usr/bin/env node
// Sandbox proof: the LIVE Codex login round-trips through a REAL, pinned OpenCode V2.
//
//   node scripts/opencode-v2/live-codex.e2e.mjs        (no API key, no network beyond the npm registry fetch)
//
// Inside a throwaway sandbox (fresh HOME + XDG dirs, random OPENCODE_PASSWORD, free port — see
// sandbox.mjs; the live opencode on :4096 and manta-server on :8787 are never touched):
//   1. create an OAuth credential for `openai` through the API (fake tokens, an account id)
//   2. read it through the production reader (`readLiveCodexEntry`) — V1-shaped, account id mapped back
//   3. run the production refresher (`createLiveCodexRefresher`) with a fake token endpoint: it reads
//      the active credential, "rotates" it, persists through `setProviderAuthEntry`, reads back
//   4. assert V2 now holds TWO rows with exactly one active — the new one — and that the reader
//      returns it, not the rotated-out row
//
// Tokens are fake, and are never printed: this script only reports booleans and lengths.

import { OPENCODE_V2_VERSION } from "./version.mjs";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { _setApiBase, createLiveCodexRefresher, readLiveCodexEntry } from "../../src/server/opencode.mjs";

const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

const binary = await ensureBinary({});
console.log(`pinned opencode ${OPENCODE_V2_VERSION}`);
const sb = await startSandbox({ binary });
const prevPassword = process.env.MANTA_OPENCODE_PASSWORD;
process.env.MANTA_OPENCODE_PASSWORD = sb.password; // the K1 reader every client call uses
_setApiBase(sb.url);
const H = { authorization: sb.auth, "content-type": "application/json" };
const api = async (method, path, body) => {
  const r = await fetch(sb.url + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text).data : undefined };
};

try {
  // A just-started server answers its first requests before the integration catalogue is loaded
  // (a 404 for `openai`): wait until the ChatGPT OAuth method is listed.
  const deadline = Date.now() + 30_000;
  let oauthMethod;
  while (Date.now() < deadline && !oauthMethod) {
    const r = await api("GET", "/api/integration/openai").catch(() => null);
    oauthMethod = r?.data?.methods?.find((m) => m.type === "oauth");
    if (!oauthMethod) await new Promise((res) => setTimeout(res, 500));
  }
  check("V2 lists a ChatGPT oauth method for openai", oauthMethod);

  const NOW = Date.now();
  // 1. a credential created through the API (what a sign-in leaves behind)
  const made = await api("POST", "/api/credential", {
    integrationID: "openai",
    activate: true,
    value: { type: "oauth", methodID: oauthMethod?.id ?? "oauth", access: "sandbox-access-1", refresh: "sandbox-refresh-1", expires: NOW - 60_000, metadata: { accountID: "sandbox-acct" } },
  });
  check("credential created via POST /api/credential", made.status === 200);

  // 2. the production reader
  const first = await readLiveCodexEntry();
  check("reader returns the active credential as a V1-shaped entry", first?.type === "oauth" && first.access === "sandbox-access-1" && first.refresh === "sandbox-refresh-1");
  check("reader maps metadata.accountID → accountId", first?.accountId === "sandbox-acct");
  check("reader maps expires", first?.expires === NOW - 60_000);

  // 3. rotate through the production refresher (fake token endpoint)
  const quiet = { log() {}, warn() {} };
  let tokenCalls = 0;
  const refresher = createLiveCodexRefresher(null, {
    fetchImpl: async () => {
      tokenCalls++;
      return { ok: true, status: 200, json: async () => ({ access_token: "sandbox-access-2", refresh_token: "sandbox-refresh-2", expires_in: 3600 }) };
    },
    now: () => NOW,
    log: quiet,
    sleep: async () => {},
  });
  const out = await refresher.refresh();
  check("refresher: refreshed, persisted and verified (ok:true)", out.ok === true && !out.skipped);
  check("refresher: exactly one token-endpoint call", tokenCalls === 1);

  // 4. what V2 holds now
  const rows = (await api("GET", "/api/credential")).data.filter((c) => c.integrationID === "openai");
  const active = rows.filter((c) => c.active);
  check("V2 holds two openai credentials (create-only API)", rows.length === 2);
  check("exactly one is active", active.length === 1);
  check("the active one carries the rotated tokens", active[0]?.value?.access === "sandbox-access-2" && active[0]?.value?.refresh === "sandbox-refresh-2");
  check("the account id survived the rotation (metadata.accountID)", active[0]?.value?.metadata?.accountID === "sandbox-acct");
  check("the rotated-out row is inactive", rows.some((c) => !c.active && c.value.access === "sandbox-access-1"));
  const back = await readLiveCodexEntry();
  check("reader now returns the NEW active login, not the rotated-out row", back?.access === "sandbox-access-2" && back?.refresh === "sandbox-refresh-2" && back?.accountId === "sandbox-acct");
} finally {
  _setApiBase(null);
  if (prevPassword === undefined) delete process.env.MANTA_OPENCODE_PASSWORD;
  else process.env.MANTA_OPENCODE_PASSWORD = prevPassword;
  await sb.stop();
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} of ${checks.length} checks FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
