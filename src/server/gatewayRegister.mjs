// gatewayRegister.mjs — box-side startup handshake with the hosted gateway.
//
// PROBLEM (BET-198): manta-server used to dial OUT to relay.mantaui.com at
// startup so the phone could reach the box through a tunnel. That whole
// transport is gone (direct HTTPS is the only mode). What stays hosted is the
// APNs gateway (gateway.mantaui.com) — which exists solely to hold the Apple
// push key. Every box must register with it on boot so the gateway knows the
// box's public IP (for the per-box DNS A record, <box_id>.boxes.mantaui.com)
// and can authenticate the box's subsequent POST /push calls.
//
// SHAPE:
//   • On FIRST boot, auth.json has no gateway_token → POST /register with no
//     Authorization header → gateway mints a token, returns
//     { host, gateway_token } → we persist both into ~/.manta/auth.json
//     alongside box_id / box_token (atomic temp-rename, 0600).
//   • On EVERY subsequent boot, auth.json has gateway_token → POST /register
//     WITH `Authorization: Bearer <gateway_token>` → gateway refreshes the A
//     record if the box's IP changed → returns { host }. The response has no
//     new token; we only rewrite auth.json when something actually changed,
//     so an idempotent refresh is a no-op on disk.
//
// NON-FATAL: any failure (DNS, network, 5xx) → console.warn + return. Push
// is best-effort, the box server must keep serving even if the gateway is
// unreachable. The next boot retries.
//
// OFF-SWITCH: `process.env.MANTA_GATEWAY_BASE === "off"` short-circuits the
// whole flow with zero network I/O. Dev boxes and CI set this to skip the
// external call without special-casing the call site.
//
// I/O INJECTION: authPath + fetchImpl + env + gatewayBase are all injectable
// so unit tests never touch the real filesystem or hit a live gateway.

import { writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIRNAME } from "../shared/paths.mjs";

const DEFAULT_GATEWAY_BASE = "https://gateway.mantaui.com";
// Same path auth.mjs uses (STORE_PATH). Mirror here so this module has no
// import dependency on auth.mjs — a fresh boot may register the gateway
// before ensureAuth() has run, and we don't want a circular import on a
// module that's already past its first use.
export const DEFAULT_AUTH_PATH = join(homedir(), STATE_DIRNAME, "auth.json");

async function atomicWrite(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
}

// Pure helper (tested). Read the persisted auth.json. Returns null on a
// missing file or a corrupt payload — the caller decides what to do next
// (treats "no auth at all" as "not registered yet").
export function loadAuthFile(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Register this box with the hosted gateway at startup. Idempotent: safe to
 * call on every boot. Never throws — best-effort by design (push fanout
 * falls back to a warn-and-skip if registration hasn't happened yet).
 *
 * @param {object} [opts]
 * @param {string} [opts.authPath]     - path to ~/.manta/auth.json
 * @param {typeof globalThis.fetch} [opts.fetchImpl] - injected for tests
 * @param {NodeJS.ProcessEnv} [opts.env] - injected for tests
 * @param {string} [opts.gatewayBase]  - explicit base override (tests); wins over env
 * @param {{warn?:Function,info?:Function,log?:Function}} [opts.logger] - default console
 * @returns {Promise<{ok:boolean,skipped?:string,status?:number,host?:string|null,registered?:boolean}>}
 */
export async function registerWithGateway({
  authPath = DEFAULT_AUTH_PATH,
  fetchImpl,
  env = process.env,
  gatewayBase,
  logger = console,
} = {}) {
  const base = gatewayBase ?? env.MANTA_GATEWAY_BASE ?? DEFAULT_GATEWAY_BASE;

  if (base === "off") {
    return { ok: true, skipped: "off" };
  }

  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== "function") {
    logger.warn?.("[gateway-register] no fetch implementation available — skipping");
    return { ok: false, skipped: "no_fetch" };
  }

  const existing = loadAuthFile(authPath);
  const box_id = typeof existing?.box_id === "string" ? existing.box_id : null;
  if (!box_id) {
    // No box_id yet → auth.mjs hasn't run ensureAuth(); caller probably
    // forgot the order. Log and bail; the next boot (after auth runs) will
    // re-register.
    logger.warn?.("[gateway-register] no box_id in auth.json — skipping (ensure auth first)");
    return { ok: false, skipped: "no_box_id" };
  }
  const prior_token =
    typeof existing?.gateway_token === "string" ? existing.gateway_token : null;

  const url = `${base.replace(/\/+$/, "")}/register`;
  const headers = { "content-type": "application/json" };
  if (prior_token) {
    headers.authorization = `Bearer ${prior_token}`;
  }

  let resp;
  try {
    resp = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ box_id }),
    });
  } catch (e) {
    logger.warn?.(`[gateway-register] fetch failed: ${String(e?.message ?? e)}`);
    return { ok: false, skipped: "fetch_failed" };
  }

  if (!resp || typeof resp.status !== "number") {
    logger.warn?.("[gateway-register] fetch returned no response");
    return { ok: false, skipped: "no_response" };
  }

  if (resp.status !== 200) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    logger.warn?.(
      `[gateway-register] gateway returned ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
    return { ok: false, status: resp.status };
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    logger.warn?.(`[gateway-register] response JSON parse failed: ${String(e?.message ?? e)}`);
    return { ok: false, skipped: "bad_json" };
  }

  const returned_token = typeof body?.gateway_token === "string" ? body.gateway_token : null;
  const returned_host = typeof body?.host === "string" ? body.host : null;

  // First-boot path: response carries a new gateway_token → persist it (and
  // host, if present) into auth.json. Re-register path: no token in response;
  // we only rewrite auth.json when something actually changed (host updates
  // are worth persisting so the box always knows its published FQDN).
  let next = existing ?? {};
  let changed = false;
  if (returned_token && returned_token !== prior_token) {
    next = { ...next, gateway_token: returned_token };
    changed = true;
  }
  if (returned_host && returned_host !== next.gateway_host) {
    next = { ...next, gateway_host: returned_host };
    changed = true;
  }
  if (changed) {
    try {
      await mkdir(dirname(authPath), { recursive: true });
      await atomicWrite(authPath, JSON.stringify(next, null, 2), 0o600);
    } catch (e) {
      logger.warn?.(`[gateway-register] failed to persist auth.json: ${String(e?.message ?? e)}`);
      return { ok: false, skipped: "persist_failed" };
    }
  }

  logger.log?.(
    returned_token
      ? `[gateway-register] registered (host=${returned_host ?? "n/a"})`
      : `[gateway-register] refreshed (host=${returned_host ?? "n/a"})`,
  );
  return { ok: true, host: returned_host ?? null, registered: !!returned_token };
}
